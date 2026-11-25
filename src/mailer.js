// The mailer: takes APPROVED emails from the queue and sends them ONE AT A TIME, paced like a person.
//
//   queue → re-check vendor rules (rules.js) → send → record → Sent_History.md → wait → next
//
// After each REAL send it waits a random PACE_MIN..PACE_MAX seconds (60–120 by default). A posting still
// within PRIORITY_WINDOW_MINUTES of its nvoids posting time is "priority": it goes first and only waits
// PRIORITY_PACE_MIN..MAX (10–20 s), because a fresh C2C posting is worth answering fast. There is no wait
// after a held or failed email, and none before the first send after idle.
import { existsSync } from 'node:fs';
import { config, dailyCap } from './config.js';
import { db, now, logEvent, audit, getState, setState, setJobStatus, getApp, updateApp } from './db.js';
import { resolveForSend, sentTodayCount, dailyCapSentTodayCount } from './rules.js';
import { buildDraft, deliver, appendHistory, assertNoJobDetails, snapshotResume } from './email.js';

const rand = (min, max) => Math.round((min + Math.random() * Math.max(0, max - min)) * 1000);

export function isPriority(job) {
  if (!job?.posted_utc) return false;
  return Date.now() - Date.parse(job.posted_utc) < config.priorityWindowMinutes * 60_000;
}

export const sendingPaused = () => getState('send_paused', '0') === '1';
export function setSendingPaused(on) {
  setState('send_paused', on ? '1' : '0');
  logEvent('info', on ? 'sending_paused' : 'sending_resumed', null, on ? 'Sending paused by you' : 'Sending resumed');
}

// Approved emails that didn't go out on the day you approved them (daily cap, bot off) are old postings by
// the next day, so they expire instead of crowding out fresh ones. "Send tomorrow" / "Send next week"
// choices (send_after set) are kept: you picked that day on purpose.
let expiredCheckedAt = 0;
function expireStale() {
  if (Date.now() - expiredCheckedAt < 30_000) return;   // called on every page load; once per 30s is plenty
  expiredCheckedAt = Date.now();
  const startOfToday = `${now().slice(0, 10)} 00:00:00`;
  const stale = db.prepare(`SELECT id, job_id, to_email FROM applications
                            WHERE status = 'queued' AND send_after IS NULL AND queued_at < ?`).all(startOfToday);
  for (const a of stale) {
    updateApp(a.id, { status: 'expired', error: 'Approved on an earlier day but not sent that day (daily cap or bot off); old posting, so not sent' });
    setJobStatus(a.job_id, 'expired', 'approved but not sent the same day');
  }
  if (stale.length) logEvent('info', 'expired', null, `${stale.length} queued email(s) from an earlier day expired unsent; today's queue only has fresh approvals`);
}

export function queuedInOrder() {
  expireStale();
  const rows = db.prepare(`SELECT a.*, j.posted_utc, j.source FROM applications a JOIN jobs j ON j.id = a.job_id
                           WHERE a.status = 'queued' AND (a.send_after IS NULL OR a.send_after <= ?) ORDER BY a.queued_at, a.id`).all(now());
  const manual = r => Number(r.source === 'manual');   // JDs you checked yourself jump the whole queue
  return rows.map(r => ({ ...r, priority: isPriority(r) })).sort((a, b) => manual(b) - manual(a) || Number(b.priority) - Number(a.priority) || (b.priority ? String(b.posted_utc ?? '').localeCompare(String(a.posted_utc ?? '')) : 0));
}

// When may the next email go? (epoch ms; 0 = now)
const gate = (priority) => Number(getState(priority ? 'pace_priority_after' : 'pace_normal_after', '0'));
// Manual JDs: a fixed short gap between them so a batch of approvals doesn't go out as one burst.
const MANUAL_GAP_MS = 20_000;
const manualGate = () => Number(getState('pace_manual_after', '0'));

function nextForCap(queue, sent, cap) {
  const first = queue[0];
  if (sent < cap || first?.source === 'manual') return first;
  return queue.find(row => row.source === 'manual') ?? first;
}

export function queueStatus() {
  const q = queuedInOrder();
  const waitingLater = db.prepare(`SELECT COUNT(*) n FROM applications WHERE status = 'queued' AND send_after > ?`).get(now()).n;
  const sent = dailyCapSentTodayCount();
  const cap = dailyCap();
  const next = nextForCap(q, sent, cap);
  const nextAt = next ? (next.source === 'manual' ? Math.max(Date.now(), manualGate()) : Math.max(Date.now(), gate(next.priority))) : null;
  return { paused: sendingPaused(), queued: q.length, waitingLater, nextAt, nextIsPriority: Boolean(next?.priority),
    sentToday: sentTodayCount(), dailyCapSentToday: sent, cap, dryRun: config.dryRun };
}

let capLoggedFor = '';

async function sendNext() {
  if (sendingPaused()) return;
  const queue = queuedInOrder();
  const sent = dailyCapSentTodayCount();
  const cap = dailyCap();
  const next = nextForCap(queue, sent, cap);
  if (!next) return;

  // The daily cap applies to scraped nvoids jobs, not JDs you added yourself.
  const day = now().slice(0, 10);
  const buffer = config.freshBufferMin + (Number(day.replace(/-/g, '')) % (config.freshBufferMax - config.freshBufferMin + 1));
  if (sent >= cap && next.source !== 'manual' && !(next.priority && sent < cap + buffer)) {
    if (capLoggedFor !== day) {
      capLoggedFor = day;
      logEvent('warn', 'daily_cap', null, `Daily cap of ${cap} scraped-job sends reached; manual entries are exempt`);
    }
    return;
  }
  // Manual JDs skip the nvoids pacing gap; they only wait 20 s after the previous manual send.
  if (Date.now() < (next.source === 'manual' ? manualGate() : gate(next.priority))) return;   // still inside the pacing gap

  const app = getApp(next.id);
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(app.job_id);
  const res = resolveForSend(app, job);

  if (res.action === 'hold') {
    updateApp(app.id, { status: 'held', hold_kind: res.kind, hold_reason: res.reason, todays_folder: res.todays_folder ?? null });
    setJobStatus(app.job_id, 'held', res.reason);
    audit('hold', { job_id: app.job_id, kind: res.kind, reason: res.reason });
    logEvent('warn', 'held', app.job_id, `Held (${res.kind}): ${res.reason}`);
    return;
  }

  if (res.rebuild) {       // a vendor lock switched the resume: rewrite the text for that resume
    const ranked = JSON.parse(app.ranking_json || '[]');
    const entry = ranked.find(r => r.folder === res.folder) ?? { folder: res.folder, matched: [] };
    const d = buildDraft(job, entry, { thin: Boolean(app.thin) });
    updateApp(app.id, { resume_folder: res.folder, resume_path: res.path, body: d.body, auto_body: d.body, match_score: entry.score ?? null, locked: 1 });
    logEvent('info', 'lock_applied', app.job_id, `Vendor lock: switched to resume folder ${res.folder} and rebuilt the email text`);
  }

  const a = getApp(app.id);
  if (config.dryRun) {
    updateApp(a.id, { status: 'held', hold_kind: 'dry_run', hold_reason: `DRY RUN: would have sent now to ${a.to_email} with resume folder ${a.resume_folder}. Set DRY_RUN=false to send for real.` });
    setJobStatus(a.job_id, 'held', 'dry run');
    logEvent('info', 'dry_run', a.job_id, `DRY RUN: would send to ${a.to_email} with resume folder ${a.resume_folder}`);
    return;
  }

  try { assertNoJobDetails(job, a.subject, a.body); }
  catch (e) {
    updateApp(a.id, { status: 'held', hold_kind: 'job_details', hold_reason: e.message });
    setJobStatus(a.job_id, 'held', e.message);
    logEvent('warn', 'held', a.job_id, `Held: ${e.message}`);
    return;
  }

  updateApp(a.id, { status: 'sending' });
  try {
    // Attach the saved copy, so what the Sent view opens later is byte-for-byte what the recruiter got.
    const sentResume = existsSync(a.resume_path) ? snapshotResume(a.resume_path) : a.resume_path;
    const { messageId, cc } = await deliver({ to: a.to_email, subject: a.subject, body: a.body, resumePath: sentResume, cc: a.cc_emails === null ? undefined : a.cc_emails.split(',').filter(Boolean) });
    const t = now();
    updateApp(a.id, { status: 'sent', sent_at: t, message_id: messageId, sent_cc: cc.join(','), sent_resume: sentResume, error: null, hold_kind: null, hold_reason: null });
    setJobStatus(a.job_id, 'sent', `resume folder ${a.resume_folder}`);
    logEvent('info', 'sent', a.job_id, `Sent to ${a.to_email} with resume folder ${a.resume_folder}${next.priority ? ' (priority)' : ''}`, { messageId });
    try { appendHistory(getApp(a.id), job); }
    catch (e) { logEvent('error', 'history_failed', a.job_id, `Sent, but could not write Sent_History.md: ${e.message}`); }

    // Pick the next gaps now, so the dashboard can count down. Manual sends don't touch the nvoids pacing.
    if (next.source === 'manual') setState('pace_manual_after', Date.now() + MANUAL_GAP_MS);
    else {
      setState('pace_normal_after', Date.now() + rand(config.paceMinSeconds, config.paceMaxSeconds));
      setState('pace_priority_after', Date.now() + rand(config.priorityPaceMinSeconds, config.priorityPaceMaxSeconds));
    }
  } catch (e) {
    updateApp(a.id, { status: 'failed', error: e.message });
    setJobStatus(a.job_id, 'failed', e.message);
    logEvent('error', 'send_failed', a.job_id, `Send to ${a.to_email} failed: ${e.message}`);
  }
}

let busy = false;
export function startMailer() {
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sendNext(); }
    catch (e) { logEvent('error', 'mailer_error', null, e.message); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 2_000);
  logEvent('info', 'mailer', null, `Mailer started${config.dryRun ? ' in DRY RUN mode (nothing will be sent)' : ''}${sendingPaused() ? ' — sending is PAUSED' : ''}`);
  return () => clearInterval(timer);
}
