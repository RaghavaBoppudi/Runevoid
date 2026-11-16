// Vendor rules — which resume a vendor may get, and whether an email may go out NOW.
// Ported from the Python nvoids-resume-mailer. Checked twice:
//   • when you look at a draft  → shown as warnings (draftWarnings)
//   • right before each send    → enforced as HOLDS (resolveForSend), one email at a time, so a backlog
//                                 is always judged against what has really gone out so far.
//
// Vendor identity = the exact address, split into name@domain (case-insensitive). abc@cdf.com and
// abc@cvb.com are different vendors; so are abc@cdf.com and abd@cdf.com. Subdomains are not merged.
//
// Order at send time (first that applies wins):
//   1. PERMANENT LOCK  vendor locked to resume folder N → that folder, always. Missing folder or poor fit → HOLD.
//   2. REPOST          same vendor already got this job (same title within DUPLICATE_WINDOW_DAYS, or a JD
//                      ≥ REPOST_SIMILARITY alike within REPOST_COOLDOWN_HOURS) → HOLD (you can "send anyway").
//   3. SAME-DAY        same vendor already got a DIFFERENT resume today → HOLD (use today's resume / tomorrow).
//   4. WEEKLY CAP      MAX_PER_RECIPIENT_PER_WEEK sends to this address since Monday 00:00 → HOLD (next week).
import { domainToASCII } from 'node:url';
import { config } from './config.js';
import { db, fmtLocal, today } from './db.js';
import { listResumeFiles } from './resumes.js';
import { blacklistHit } from './filters.js';

// ── Vendor identity ──────────────────────────────────────────────────────────

export function parseVendor(raw) {
  const m = /([^\s<>"'():;,]+)@([^\s<>"'():;,]+)/.exec(String(raw ?? '').replace(/^mailto:/i, ''));
  if (!m) return null;
  const local = m[1].toLowerCase();
  const domain = (domainToASCII(m[2].toLowerCase().replace(/\.$/, '')) || m[2].toLowerCase());
  if (!/\./.test(domain)) return null;
  return { local, domain, address: `${local}@${domain}` };
}

// ── Locks ────────────────────────────────────────────────────────────────────

// An address-level lock (abc@cdf.com) beats a domain-wide one (*@cdf.com).
export function lockFor(address) {
  const v = parseVendor(address);
  if (!v) return null;
  return db.prepare(`SELECT * FROM vendor_locks WHERE domain = ? AND local IN (?, '') ORDER BY local DESC LIMIT 1`).get(v.domain, v.local) ?? null;
}

export const lockLabel = (l) => `${l.local || '*'}@${l.domain}`;

// ── Repost similarity (same JD reposted under a new id) ──────────────────────

const NOISE = /https?:\/\/\S+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\d+/gi;
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'will', 'this', 'that', 'from', 'are', 'job', 'role', 'opening',
  'position', 'please', 'send', 'resume', 'email', 'keywords', 'regards', 'thanks']);
function coreWords(text, limit = 400) {
  const words = (String(text ?? '').toLowerCase().replace(NOISE, ' ').match(/[a-z]{3,}/g) ?? []).filter(w => !STOP.has(w));
  return new Set(words.slice(0, limit));
}
export function similarity(a, b) {
  const A = coreWords(a), B = coreWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Title as a repost key: drop location/visa/contract noise so "AI Engineer - Dallas, TX" == "AI Engineer".
export function normTitle(t) {
  return String(t ?? '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:urgent(?:ly)?|immediate|hiring|need(?:ed)?|requirement|opening|for|job opportunity|looking for)\b/g, ' ')
    .replace(/\s*(?:[|:–-]|\bat\b|\bin\b)\s*(?:remote|hybrid|onsite|on-site|location|local|w2|c2c|contract|[a-z .]+,\s*[a-z]{2}\b).*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── History lookups ──────────────────────────────────────────────────────────

const daysAgo = (n) => fmtLocal(new Date(Date.now() - n * 86_400_000));
const hoursAgo = (n) => fmtLocal(new Date(Date.now() - n * 3_600_000));

function startOfWeek() {             // Monday 00:00 local
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
export function nextMonday() { const d = startOfWeek(); d.setDate(d.getDate() + 7); d.setMinutes(5); return fmtLocal(d); }
export function tomorrow() { const d = new Date(); d.setHours(24, 5, 0, 0); return fmtLocal(d); }

function sentTo(address) {
  return db.prepare(`SELECT a.*, j.title, j.jd_text FROM applications a JOIN jobs j ON j.id = a.job_id
                     WHERE a.status = 'sent' AND lower(a.to_email) = ? ORDER BY a.sent_at DESC`).all(address);
}

export function findRepost(app, job) {
  const v = parseVendor(app.to_email); if (!v) return null;
  const nt = normTitle(job.title);
  for (const s of sentTo(v.address)) {
    if (s.job_id === job.id) continue;
    if (nt && normTitle(s.title) === nt && s.sent_at >= daysAgo(config.duplicateWindowDays)) {
      return `${v.address} already got “${s.title}” on ${s.sent_at} (same job title within ${config.duplicateWindowDays} days)`;
    }
    if (s.sent_at >= hoursAgo(config.repostCooldownHours)) {
      const sim = similarity(job.jd_text, s.jd_text);
      if (sim >= config.repostSimilarity) {
        return `${v.address} got a ${Math.round(sim * 100)}% identical job description on ${s.sent_at} (“${s.title}”) — likely the same job reposted`;
      }
    }
  }
  return null;
}

// Free mailboxes are people, not companies: for these only the exact address counts as "the same vendor".
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me', 'zoho.com', 'rediffmail.com', 'gmx.com', 'yandex.com', 'mail.com', 'googlegroups.com']);

// The same JD already went to another recruiter at the same vendor company (same email domain): returns
// what was sent, so this one goes out with the same resume. Same JD = same title, or ≥ REPOST_SIMILARITY
// identical text, within DUPLICATE_WINDOW_DAYS. The same recruiter is handled by findRepost (held).
export function sameJdAtVendor(address, job) {
  const v = parseVendor(address); if (!v || FREE_MAIL.has(v.domain)) return null;
  const nt = normTitle(job.title);
  const rows = db.prepare(`SELECT a.to_email, a.resume_folder, a.sent_at, j.id job_id, j.title, j.jd_text FROM applications a JOIN jobs j ON j.id = a.job_id
                           WHERE a.status = 'sent' AND lower(a.to_email) LIKE ? AND lower(a.to_email) != ? AND a.sent_at >= ? ORDER BY a.sent_at DESC LIMIT 200`)
    .all(`%@${v.domain}`, v.address, daysAgo(config.duplicateWindowDays));
  for (const s of rows) {
    if (s.job_id === job.id) continue;
    const sameTitle = nt && normTitle(s.title) === nt;
    const sim = sameTitle ? 1 : similarity(job.jd_text, s.jd_text);
    if (sameTitle || sim >= config.repostSimilarity)
      return { folder: s.resume_folder, to_email: s.to_email, sent_at: s.sent_at, title: s.title, how: sameTitle ? 'same job title' : `${Math.round(sim * 100)}% identical JD` };
  }
  return null;
}

// An nvoids posting you already applied to through a JD pasted on the Manual tab (#1001+): same title from
// the same vendor company, or ≥ REPOST_SIMILARITY identical text from anyone, within DUPLICATE_WINDOW_DAYS.
export function manualMatch(job) {
  const v = parseVendor(job.recruiter_email);
  const nt = normTitle(job.title);
  const rows = db.prepare(`SELECT a.status, a.to_email, a.resume_folder, a.sent_at, a.queued_at, j.id job_id, j.title, j.jd_text FROM applications a JOIN jobs j ON j.id = a.job_id
                           WHERE j.source = 'manual' AND a.status IN ('sent','queued','sending') AND coalesce(a.sent_at, a.queued_at) >= ?
                           ORDER BY coalesce(a.sent_at, a.queued_at) DESC LIMIT 300`).all(daysAgo(config.duplicateWindowDays));
  for (const m of rows) {
    const mv = parseVendor(m.to_email);
    const sameVendor = v && mv && (mv.address === v.address || (mv.domain === v.domain && !FREE_MAIL.has(v.domain)));
    const sim = similarity(job.jd_text, m.jd_text);
    if ((sameVendor && nt && normTitle(m.title) === nt) || sim >= config.repostSimilarity)
      return { ...m, how: sim >= config.repostSimilarity ? `${Math.round(sim * 100)}% identical JD` : 'same title, same vendor', when: (m.sent_at ?? m.queued_at).slice(0, 10) };
  }
  return null;
}

export function todaysFolder(address) {
  const v = parseVendor(address); if (!v) return null;
  return db.prepare(`SELECT resume_folder FROM applications WHERE status = 'sent' AND lower(to_email) = ? AND sent_at >= ? ORDER BY sent_at LIMIT 1`)
    .get(v.address, today())?.resume_folder ?? null;
}

export function weeklyCount(address) {
  const v = parseVendor(address); if (!v) return 0;
  return db.prepare(`SELECT COUNT(*) n FROM applications WHERE status = 'sent' AND lower(to_email) = ? AND sent_at >= ?`)
    .get(v.address, fmtLocal(startOfWeek())).n;
}

function companyConflict(address, folder) {
  const v = parseVendor(address); if (!v) return null;
  return db.prepare(`SELECT to_email, resume_folder, sent_at FROM applications
                     WHERE status = 'sent' AND lower(to_email) LIKE ? AND lower(to_email) != ? AND resume_folder != ? AND sent_at >= ?
                     ORDER BY sent_at DESC LIMIT 1`).get(`%@${v.domain}`, v.address, folder, daysAgo(config.companyConflictDays)) ?? null;
}

export function sentTodayCount() {
  return db.prepare(`SELECT COUNT(*) n FROM applications WHERE status = 'sent' AND sent_at >= ?`).get(today()).n;
}

export function dailyCapSentTodayCount() {
  return db.prepare(`SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id
                     WHERE a.status = 'sent' AND a.sent_at >= ? AND j.source IS NOT 'manual'`).get(today()).n;
}

// ── Warnings shown on a draft (nothing blocked here) ─────────────────────────

export function draftWarnings(app, job) {
  const w = [];
  const mm = job.source !== 'manual' && manualMatch(job);
  if (mm) w.push(`Already applied via MANUAL #${mm.job_id} on ${mm.when} with folder ${mm.resume_folder} (${mm.status === 'sent' ? 'sent' : 'queued'} to ${mm.to_email}; ${mm.how})`);
  for (const f of JSON.parse(app.flags_json || '[]')) w.push(f);
  if (app.thin) w.push(`Thin posting: the JD names fewer than ${config.minJdSkills} known skills, so the resume pick is a guess`);
  const lock = lockFor(app.to_email);
  if (lock) w.push(`Vendor LOCKED to resume folder ${lock.resume_folder} (${lockLabel(lock)}${lock.reason ? `: ${lock.reason}` : ''})`);
  const rp = findRepost(app, job);
  if (rp) w.push(`Repost: ${rp}. It will be held at send time.`);
  const tf = todaysFolder(app.to_email);
  if (tf && tf !== app.resume_folder) w.push(`This vendor already got resume folder ${tf} today; sending folder ${app.resume_folder} will be held (same-day rule)`);
  const wk = weeklyCount(app.to_email);
  if (wk >= config.maxPerRecipientPerWeek) w.push(`This address already got ${wk} emails this week (limit ${config.maxPerRecipientPerWeek}); it will be held until next week`);
  else if (wk > 0) w.push(`This address got ${wk} email(s) from you this week`);
  const cc = companyConflict(app.to_email, app.resume_folder);
  if (cc) w.push(`Someone else at this company (${cc.to_email}) got resume folder ${cc.resume_folder} on ${cc.sent_at}`);
  if (job.jd_hash) {
    const dup = db.prepare(`SELECT a.sent_at, a.to_email FROM applications a JOIN jobs j ON j.id = a.job_id
                            WHERE j.jd_hash = ? AND a.status = 'sent' AND a.job_id != ? AND lower(a.to_email) != lower(?) ORDER BY a.sent_at DESC LIMIT 1`)
      .get(job.jd_hash, job.id, app.to_email);
    if (dup) w.push(`The same job description was already sent to ${dup.to_email} on ${dup.sent_at}: a second vendor may cause a double submission`);
  }
  return w;
}

// ── Enforcement right before a send ──────────────────────────────────────────
// Returns { action: 'send', folder, path, rebuild } or { action: 'hold', kind, reason, todays_folder? }.

export function resolveForSend(app, job) {
  let folder = app.resume_folder;
  let path = app.resume_path;
  let rebuild = false;

  const bl = blacklistHit({ ...job, recruiter_email: app.to_email });
  if (bl) return { action: 'hold', kind: 'blacklist', reason: `${app.to_email} matches your blacklist (“${bl}”). Not sent.` };

  const lock = lockFor(app.to_email);
  if (lock) {
    const file = listResumeFiles().find(f => f.folder === lock.resume_folder);
    if (!file) return { action: 'hold', kind: 'lock_missing', reason: `Vendor is LOCKED to resume folder ${lock.resume_folder} (${lockLabel(lock)}), but that folder/file is missing. Fix the lock or restore the file. No other resume will be sent.` };
    if (file.folder !== folder) {
      if (app.body !== app.auto_body) return { action: 'hold', kind: 'lock_edited', reason: `Vendor is LOCKED to resume folder ${lock.resume_folder}, but this draft uses folder ${folder} and you edited its text. Switch to the locked resume and re-check the text.` };
      const fit = JSON.parse(app.ranking_json || '[]').find(r => r.folder === file.folder);
      if (fit && (fit.keyword ?? fit.score) < config.minMatchScore) return { action: 'hold', kind: 'lock_low_fit', reason: `Vendor is LOCKED to resume folder ${lock.resume_folder}, which covers this job only ${fit.keyword ?? fit.score}% (minimum ${config.minMatchScore}). Not sent; no other resume is substituted.` };
      folder = file.folder; path = file.path; rebuild = true;
    }
  }

  if (!app.override_repost) {
    const rp = findRepost(app, job);
    if (rp) return { action: 'hold', kind: 'repost', reason: rp };
  }

  // Same JD, same vendor company, new recruiter: send the resume that company already has for this job.
  const prior = !lock && sameJdAtVendor(app.to_email, job);
  if (prior && prior.folder !== folder) {
    const file = listResumeFiles().find(f => f.folder === prior.folder);
    if (file) {
      if (app.body !== app.auto_body) return { action: 'hold', kind: 'same_jd_edited', reason: `${prior.to_email} (same company) got this job (${prior.how}) on ${prior.sent_at} with resume folder ${prior.folder}, but this draft uses folder ${folder} and you edited its text. Switch to folder ${prior.folder} and re-check the text.` };
      folder = file.folder; path = file.path; rebuild = true;
    }
  }

  const tf = todaysFolder(app.to_email);
  if (tf && tf !== folder) {
    return { action: 'hold', kind: 'same_day', todays_folder: tf,
      reason: `${app.to_email} already got resume folder ${tf} today. A vendor never gets two different resumes on the same day.` };
  }

  const wk = weeklyCount(app.to_email);
  if (wk >= config.maxPerRecipientPerWeek) {
    return { action: 'hold', kind: 'weekly_cap', reason: `${app.to_email} already got ${wk} emails this week (limit ${config.maxPerRecipientPerWeek}).` };
  }

  return { action: 'send', folder, path, rebuild };
}
