// Everything you can do to a draft from the dashboard. Approving only QUEUES the email — the paced
// mailer (mailer.js) sends it, after re-checking the vendor rules.
import { db, now, logEvent, audit, setJobStatus, getApp, updateApp, getState, setState } from './db.js';
import { listResumeFiles, rankResumes } from './resumes.js';
import { config } from './config.js';
import { buildDraft, assertNoSourceMention, assertNoJobDetails, normalizeCcEmails, ccFor } from './email.js';
import { lockFor, lockLabel, parseVendor, tomorrow, nextMonday } from './rules.js';
import { blacklistHit, blockedAddress, classify } from './filters.js';

const jobOf = (app) => db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(app.job_id);

function mustGet(id) {
  const app = getApp(Number(id));
  if (!app) throw new Error('Draft not found');
  return app;
}

// Switch a draft to another resume folder. Rewrites the text unless you've edited it.
// CC for one email. If it is just your saved CC list (Status → Cc on every email), store null: the list is then
// read at send time, so changing it later reaches emails already in the queue. Only a CC you changed on this
// email is kept as its own.
function ccToStore(raw, to) {
  if (raw === null || raw === undefined) return null;
  const mine = normalizeCcEmails(String(raw)).filter(c => c.toLowerCase() !== to.toLowerCase());
  const def = ccFor(to);
  const same = mine.length === def.length && mine.every(c => def.some(d => d.toLowerCase() === c.toLowerCase()));
  return same ? null : mine.join(',');
}

function switchResume(app, folder) {
  const file = listResumeFiles().find(f => f.folder === String(folder));
  if (!file) throw new Error(`Resume folder ${folder} not found`);
  if (file.folder === app.resume_folder) return app;
  const ranked = JSON.parse(app.ranking_json || '[]');
  const entry = ranked.find(r => r.folder === file.folder) ?? { folder: file.folder, matched: [] };
  const fields = { resume_folder: file.folder, resume_path: file.path, match_score: entry.score ?? null };
  if (app.body === app.auto_body) {
    const d = buildDraft(jobOf(app), entry, { thin: Boolean(app.thin) });
    fields.body = d.body; fields.auto_body = d.body;
  }
  updateApp(app.id, fields);
  return getApp(app.id);
}

// edits: { subject, to_email, resume_folder, body } — the dashboard sends `body` only when you edited it,
// so switching resumes on an unedited draft gets text rewritten for the new resume.
export function approve(id, edits = {}) {
  let app = mustGet(id);
  if (!['draft', 'failed', 'held'].includes(app.status)) throw new Error(`Can't approve: it is ${app.status}`);
  const to = String(edits.to_email ?? app.to_email).trim();
  if (!parseVendor(to)) throw new Error(`Bad recipient address: ${to}`);
  const bl = blacklistHit({ ...jobOf(app), recruiter_email: to });
  if (bl) throw new Error(`${to} is on your Blocked list (“${bl}”). It can't be approved; skip it instead.`);

  const lock = lockFor(to);
  const wanted = String(edits.resume_folder ?? app.resume_folder);
  if (lock && wanted !== lock.resume_folder) {
    throw new Error(`${lockLabel(lock)} is locked to resume folder ${lock.resume_folder}. Change the lock on the Vendors tab first.`);
  }
  if (wanted !== app.resume_folder) app = switchResume(app, wanted);

  const fields = { to_email: to, status: 'queued', queued_at: now(), approved_at: now(), hold_kind: null, hold_reason: null, todays_folder: null, error: null };
  if (edits.subject !== undefined) fields.subject = String(edits.subject);
  fields.cc_emails = ccToStore(edits.cc_emails !== undefined ? String(edits.cc_emails) : app.cc_emails, to);
  if (edits.body !== undefined) fields.body = String(edits.body);
  assertNoSourceMention(fields.subject ?? app.subject, fields.body ?? app.body);
  assertNoJobDetails(jobOf(app), fields.subject ?? app.subject, fields.body ?? app.body);
  updateApp(app.id, fields);
  setJobStatus(app.job_id, 'queued', `resume folder ${getApp(app.id).resume_folder}`);
  logEvent('info', 'approved', app.job_id, `Approved and queued: ${to} with resume folder ${getApp(app.id).resume_folder}`);
  return getApp(app.id);
}

// Edit an email that is already approved and waiting in the queue, keeping its place in line.
// The same checks as approval apply (no nvoids, no job ID or location, valid recipient, vendor lock).
export function editQueued(id, edits = {}) {
  const app = mustGet(id);
  if (app.status !== 'queued') throw new Error(`It is ${app.status}, not queued — it may have just been sent`);
  const to = String(edits.to_email ?? app.to_email).trim();
  if (!parseVendor(to)) throw new Error(`Bad recipient address: ${to}`);
  if (blockedAddress(to)) throw new Error(`${to} is on your Blocked list.`);
  const fields = { to_email: to };
  if (edits.subject !== undefined) fields.subject = String(edits.subject);
  if (edits.cc_emails !== undefined) fields.cc_emails = ccToStore(String(edits.cc_emails), to);
  if (edits.body !== undefined) fields.body = String(edits.body);
  assertNoSourceMention(fields.subject ?? app.subject, fields.body ?? app.body);
  assertNoJobDetails(jobOf(app), fields.subject ?? app.subject, fields.body ?? app.body);
  const lock = lockFor(to);
  if (lock && lock.resume_folder !== app.resume_folder) throw new Error(`${lockLabel(lock)} is locked to resume folder ${lock.resume_folder}; pull this email back to change its resume.`);
  updateApp(app.id, fields);
  logEvent('info', 'edited_queued', app.job_id, `Edited a queued email (still in line) → ${to}`);
}

// Your status with a vendor: RTR given, submitted, interview, offer, placed, not interested.
export const VENDOR_STATUSES = { rtr: 'RTR given', submitted: 'Submitted', interview: 'Interview', offer: 'Offer', placed: 'Placed', not_interested: 'Not interested' };
export function setVendorStatus({ address, status, on_date = '', note = '' }) {
  const v = parseVendor(address);
  if (!v) throw new Error(`"${address}" is not an email address`);
  if (status === '' || status === 'clear') {
    db.prepare(`DELETE FROM vendor_status WHERE address = ?`).run(v.address);
    audit('vendor_status_cleared', { address: v.address });
    logEvent('info', 'vendor_status', null, `Cleared status for ${v.address}`);
    return;
  }
  if (!VENDOR_STATUSES[status]) throw new Error(`Unknown status: ${status}`);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(on_date) ? on_date : now().slice(0, 10);
  db.prepare(`INSERT INTO vendor_status (address, status, on_date, note, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(address) DO UPDATE SET status = excluded.status, on_date = excluded.on_date, note = excluded.note, updated_at = excluded.updated_at`)
    .run(v.address, status, d, String(note).slice(0, 500), now());
  audit('vendor_status', { address: v.address, status, on_date: d, note });
  logEvent('info', 'vendor_status', null, `${v.address}: ${VENDOR_STATUSES[status]} (${d})${note ? ` — ${note}` : ''}`);
}

// Blacklist: a domain, an address or a company name. Matching postings are skipped when scraped, and any
// draft/queued email to them is held at send time. Existing drafts from them are skipped now.
export function addBlacklist({ term, note = '' }) {
  const t = String(term ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (t.length < 3) throw new Error('Type a domain (cdf.com), an address or a company name (3+ characters)');
  db.prepare(`INSERT INTO vendor_blacklist (term, note, created_at) VALUES (?, ?, ?) ON CONFLICT(term) DO UPDATE SET note = excluded.note`).run(t, String(note).slice(0, 300), now());
  audit('blacklist_added', { term: t, note });
  let skipped = 0;
  const open = db.prepare(`SELECT a.id, a.job_id, a.to_email, j.title, j.jd_text, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status IN ('draft','held','failed','queued')`).all();
  for (const a of open) {
    if (blacklistHit({ ...a, recruiter_email: a.to_email })) {
      updateApp(a.id, { status: 'skipped', error: `blacklisted vendor: ${t}` });
      setJobStatus(a.job_id, 'skipped', `blacklisted vendor: ${t}`);
      skipped++;
    }
  }
  logEvent('info', 'blacklist', null, `Blacklisted “${t}”${skipped ? `; skipped ${skipped} open draft(s) from them` : ''}`);
  return { skipped };
}
export function removeBlacklist(id) {
  const row = db.prepare(`SELECT * FROM vendor_blacklist WHERE id = ?`).get(Number(id));
  if (!row) throw new Error('Not found');
  db.prepare(`DELETE FROM vendor_blacklist WHERE id = ?`).run(row.id);
  audit('blacklist_removed', { term: row.term });
  logEvent('info', 'blacklist', null, `Removed “${row.term}” from the blacklist`);
}

export function cancelQueued(id) {
  const app = mustGet(id);
  if (app.status !== 'queued') throw new Error(`It is ${app.status}, not queued`);
  updateApp(app.id, { status: 'draft', queued_at: null, send_after: null });
  setJobStatus(app.job_id, 'pending_approval', 'pulled back from the queue');
  logEvent('info', 'unqueued', app.job_id, 'You pulled this email back from the queue');
}

export function skip(id) {
  const app = mustGet(id);
  if (['sent', 'sending'].includes(app.status)) throw new Error(`Can't skip: it is ${app.status}`);
  updateApp(app.id, { status: 'skipped' });
  setJobStatus(app.job_id, 'skipped', 'skipped by you');
  logEvent('info', 'skipped', app.job_id, 'You skipped this draft');
}

// Decisions on a HELD email.
// folder: the resume you picked in the held email's Resume menu (applied first, so the decision uses it).
export function resolveHold(id, decision, folder) {
  let app = mustGet(id);
  if (app.status !== 'held') throw new Error(`It is ${app.status}, not held`);
  if (folder && folder !== app.resume_folder && !['use_today', 'use_lock', 'send_same_resume'].includes(decision)) {
    const lock = lockFor(app.to_email);
    if (lock && lock.resume_folder !== folder) throw new Error(`This vendor is locked to ${lock.resume_folder}`);
    app = switchResume(app, folder);
    logEvent('info', 'resume_switched', app.job_id, `Held email: resume changed to ${folder}`);
  }
  const requeue = (extra = {}, why) => {
    updateApp(app.id, { status: 'queued', queued_at: now(), hold_kind: null, hold_reason: null, todays_folder: null, ...extra });
    setJobStatus(app.job_id, 'queued', why);
    audit('hold_resolved', { job_id: app.job_id, kind: app.hold_kind, decision });
    logEvent('info', 'hold_resolved', app.job_id, `Held email (${app.hold_kind}): ${why}`);
  };
  switch (decision) {
    case 'use_today': {
      if (!app.todays_folder) throw new Error('No resume was sent to this vendor today');
      switchResume(app, app.todays_folder);
      return requeue({}, `use today's resume (folder ${app.todays_folder})`);
    }
    case 'use_lock': {
      const lock = lockFor(app.to_email);
      if (!lock) throw new Error('This vendor is not locked any more');
      const a = getApp(app.id);
      updateApp(a.id, { body: a.auto_body });      // drop your edits: they were written for the other resume
      switchResume(getApp(a.id), lock.resume_folder);
      return requeue({}, `switched to locked resume folder ${lock.resume_folder}`);
    }
    case 'tomorrow':     return requeue({ send_after: tomorrow() }, `send tomorrow (${tomorrow()})`);
    case 'next_week':    return requeue({ send_after: nextMonday() }, `send next week (${nextMonday()})`);
    case 'send_same_resume': {   // repost hold: resend exactly the resume this recruiter already has
      if (!app.todays_folder) throw new Error('No earlier resume is recorded for this recruiter');
      const lock = lockFor(app.to_email);
      if (lock && lock.resume_folder !== app.todays_folder) throw new Error(`This vendor is locked to ${lock.resume_folder}`);
      const prev = app.todays_folder;
      switchResume(app, prev);
      return requeue({ override_repost: 1 }, `send anyway with the same resume they already got (folder ${prev})`);
    }
    case 'send_anyway':  return requeue({ override_repost: 1 }, 'send anyway (you confirmed it is not a repost)');
    case 'send_anyway_today': return requeue({ override_same_day: 1 }, `send anyway: a second resume (${app.resume_folder}) to this vendor today`);
    case 'retry':        return requeue({}, 'retry');
    case 'to_draft': {   // back to an editable draft (e.g. to remove a job ID/location you typed in)
      updateApp(app.id, { status: 'draft', queued_at: null, hold_kind: null, hold_reason: null, todays_folder: null });
      setJobStatus(app.job_id, 'pending_approval', 'back to draft for editing');
      logEvent('info', 'hold_resolved', app.job_id, `Held email (${app.hold_kind}): back to draft for editing`);
      return;
    }
    default: throw new Error(`Unknown decision: ${decision}`);
  }
}

// ── Re-match ─────────────────────────────────────────────────────────────────
// Score a draft again against every resume currently in the folders (new resumes, the current matcher).
// Unedited text: switch to the best resume and rewrite the text for it. Edited text: keep your text and
// your resume, only refresh the scores in the dropdown. A vendor lock still decides the resume.
export async function rematch(id) {
  const app = mustGet(id);
  if (!['draft', 'failed'].includes(app.status)) throw new Error(`Can't re-match: it is ${app.status}`);
  const job = jobOf(app);
  const { ranked, method, jdSkills } = await rankResumes(job.jd_text || job.title, job.title);
  if (!ranked.length) throw new Error('No resumes found in the resumes folder');
  const lock = lockFor(app.to_email);
  const best = (lock && ranked.find(r => r.folder === lock.resume_folder)) || ranked[0];
  if (lock && best !== ranked[0]) best.why = `vendor locked to folder ${lock.resume_folder}`;
  const ordered = [best, ...ranked.filter(r => r !== best)];
  const edited = app.body !== app.auto_body;
  const fields = { ranking_json: JSON.stringify(ordered), match_method: method, thin: jdSkills.length < config.minJdSkills ? 1 : 0 };
  if (!edited) {
    const d = buildDraft(job, best, { thin: Boolean(fields.thin) });
    Object.assign(fields, { resume_folder: best.folder, resume_path: best.path, match_score: best.score, subject: d.subject, body: d.body, auto_body: d.body });
  } else {
    fields.match_score = ordered.find(r => r.folder === app.resume_folder)?.score ?? app.match_score;
  }
  updateApp(app.id, fields);
  const changed = !edited && best.folder !== app.resume_folder;
  logEvent('info', 'rematched', app.job_id, edited
    ? `Re-matched scores; kept your edited text and resume folder ${app.resume_folder} (best now: folder ${best.folder}, ${best.score}%)`
    : `Re-matched: resume folder ${app.resume_folder} → ${best.folder} (${best.score}%, ${best.why})`);
  return { changed, folder: edited ? app.resume_folder : best.folder, edited };
}

// Re-match drafts one at a time in the background (all of them, or the ones you ticked). Progress is kept
// in state so the dashboard can show it, and Stop ends the run after the draft in hand. "Running" is
// answered from memory, never from the saved progress, so a restart in the middle of a run cannot leave
// the dashboard re-matching forever.
let rematchRunning = false;
let rematchStopRequested = false;
const saveProgress = (p) => setState('rematch_progress', JSON.stringify(p));

export function rematchStatus() {
  const saved = JSON.parse(getState('rematch_progress', '{}') || '{}');
  return { done: 0, total: 0, changed: 0, ...saved, running: rematchRunning, stopping: rematchRunning && rematchStopRequested };
}

function startRematch(ids) {
  if (rematchRunning) throw new Error('A re-match is already running');
  rematchRunning = true;
  rematchStopRequested = false;
  saveProgress({ done: 0, total: ids.length, changed: 0, running: true });
  (async () => {
    let done = 0, changed = 0, stopped = false;
    try {
      for (const id of ids) {
        if (rematchStopRequested) { stopped = true; break; }
        try { if ((await rematch(id)).changed) changed++; } catch (e) { logEvent('warn', 'rematch_failed', null, `Draft ${id}: ${e.message}`); }
        done++;
        saveProgress({ done, total: ids.length, changed, running: true });
        await new Promise(r => setTimeout(r, 40));   // a turn for the dashboard between drafts
      }
    } finally {
      rematchRunning = false;
      saveProgress({ done, total: ids.length, changed, running: false, stopped, finished_at: now() });
      logEvent('info', stopped ? 'rematch_stopped' : 'rematched_all', null, stopped
        ? `Re-match stopped by you after ${done} of ${ids.length} draft(s); ${changed} switched to a better resume`
        : `Re-matched ${done} draft(s); ${changed} switched to a better resume`);
    }
  })();
  return { total: ids.length };
}

// Every unapproved draft, optionally only nvoids or only manual ones.
export function rematchAll(source = '') {
  const where = source === 'manual' ? `AND j.source = 'manual'` : source === 'nvoids' ? `AND j.source IS NOT 'manual'` : '';
  const ids = db.prepare(`SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status IN ('draft','failed') ${where} ORDER BY a.job_id DESC`).all().map(r => r.id);
  return startRematch(ids);
}

export function rematchSome(ids) {
  return startRematch(ids);
}

export function stopRematch() {
  if (!rematchRunning) throw new Error('No re-match is running');
  rematchStopRequested = true;
}

// A restart in the middle of a run leaves "running" in the saved progress; clear it at startup.
export function clearStaleRematch() {
  const saved = JSON.parse(getState('rematch_progress', '{}') || '{}');
  if (saved.running) saveProgress({ ...saved, running: false, stopped: true });
}

// Drafts you haven't approved yet carry no edits (edits are saved on approve), so after the template
// changes they are simply rebuilt with the current wording. Called at startup.
export function refreshDrafts() {
  let n = 0;
  // Approved-but-unsent emails keep your edits; only the old "(City – Job ID: …)" subject tag is fixed.
  for (const app of db.prepare(`SELECT * FROM applications WHERE status IN ('queued','held','failed') AND (subject LIKE '%Job ID%' OR subject LIKE 'Application:%')`).all()) {
    const ranked = JSON.parse(app.ranking_json || '[]');
    const entry = ranked.find(r => r.folder === app.resume_folder) ?? { folder: app.resume_folder, matched: [] };
    updateApp(app.id, { subject: buildDraft(jobOf(app), entry, { thin: Boolean(app.thin) }).subject });
    n++;
  }
  for (const app of db.prepare(`SELECT * FROM applications WHERE status = 'draft'`).all()) {
    const ranked = JSON.parse(app.ranking_json || '[]');
    const entry = ranked.find(r => r.folder === app.resume_folder) ?? { folder: app.resume_folder, matched: [] };
    const d = buildDraft(jobOf(app), entry, { thin: Boolean(app.thin) });
    if (d.body === app.body && d.subject === app.subject) continue;
    updateApp(app.id, { subject: d.subject, body: d.body, auto_body: d.body });
    n++;
  }
  if (n) logEvent('info', 'drafts_refreshed', null, `Rewrote ${n} unapproved draft(s) with the current email template`);
  return n;
}

// Unapproved nvoids drafts made under older filters: re-run today's filters and skip the ones that no
// longer qualify (e.g. Java/DevOps drafts left over from before the AI/ML-only filter). Called at startup.
// Approved, held and pasted-by-you emails are left alone.
export function purgeOffTargetDrafts() {
  let n = 0;
  for (const app of db.prepare(`SELECT a.id, a.job_id FROM applications a JOIN jobs j ON j.id = a.job_id
                                WHERE a.status = 'draft' AND j.id >= 1000000`).all()) {
    const v = classify(jobOf(app));
    if (v.keep) continue;
    updateApp(app.id, { status: 'skipped', error: `filters changed: ${v.reason}` });
    setJobStatus(app.job_id, 'filtered_out', v.reason);
    logEvent('info', 'skipped', app.job_id, `Draft skipped: no longer passes the filters (${v.reason})`);
    n++;
  }
  if (n) logEvent('info', 'drafts_purged', null, `Skipped ${n} unapproved draft(s) that no longer pass the AI/ML filters`);
  return n;
}

// ── Locks ────────────────────────────────────────────────────────────────────

export function setLock({ domain, local = '', resume_folder, reason = '' }) {
  const d = String(domain ?? '').trim().toLowerCase().replace(/^\*?@/, '');
  const l = String(local ?? '').trim().toLowerCase().replace(/@.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`"${domain}" is not a domain like cdf.com`);
  if (!listResumeFiles().some(f => f.folder === String(resume_folder))) throw new Error(`Resume folder ${resume_folder} not found`);
  const before = db.prepare(`SELECT * FROM vendor_locks WHERE domain = ? AND local = ?`).get(d, l);
  db.prepare(`INSERT INTO vendor_locks (domain, local, resume_folder, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(domain, local) DO UPDATE SET resume_folder = excluded.resume_folder, reason = excluded.reason, updated_at = excluded.updated_at`)
    .run(d, l, String(resume_folder), reason, now(), now());
  audit(before ? 'lock_changed' : 'lock_added', { lock: `${l || '*'}@${d}`, before: before ? { folder: before.resume_folder, reason: before.reason } : null, after: { folder: String(resume_folder), reason } });
  logEvent('info', 'lock', null, `${before ? 'Changed' : 'Added'} lock ${l || '*'}@${d} → resume folder ${resume_folder}`);
}

export function removeLock(id) {
  const before = db.prepare(`SELECT * FROM vendor_locks WHERE id = ?`).get(Number(id));
  if (!before) throw new Error('Lock not found');
  db.prepare(`DELETE FROM vendor_locks WHERE id = ?`).run(before.id);
  audit('lock_removed', { lock: `${before.local || '*'}@${before.domain}`, before: { folder: before.resume_folder, reason: before.reason } });
  logEvent('info', 'lock', null, `Removed lock ${before.local || '*'}@${before.domain}`);
}
