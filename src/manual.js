// JDs you paste in yourself (from LinkedIn, WhatsApp, an email…). They take the same path as an nvoids
// posting — resume match, email in your format, Review, vendor rules, paced send — and are numbered
// 1001, 1002, … so you can always tell them apart (nvoids numbers are in the millions).
import { config } from './config.js';
import { db, now, logEvent, setJobStatus } from './db.js';
import { classify, blacklistHit } from './filters.js';
import { extractLocation, signatureName } from './scraper.js';
import { makeDraft, jdHash } from './pipeline.js';
import { roleTitle, isGreeting, stripHiring, FIELD_LABEL } from './email.js';
import { parseVendor, similarity } from './rules.js';

export const MANUAL_START = 1001;
export const isManual = (job) => job?.source === 'manual' || (Number(job?.id) > 0 && Number(job?.id) < 1_000_000);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// The recruiter's address in pasted text: prefer one next to "Email:"/"Reply to:"/"Contact:", and never
// yours or a CC address. Handles "princy\n.soni@x.com" (a line break inside the address).
function findRecruiterEmail(text) {
  return pickRecruiterEmail(glueLines(text));
}
// Rejoin an address split across lines: "princy\n.soni@x.com" (next line starts with . or @), or
// "princy.\nsoni@x.com" only when that line is nothing but the address fragment, so a sentence ending
// "…share resumes via Email." is never glued onto the address below it ("email.sourav@…").
function glueLines(text) {
  return text.replace(/([A-Za-z0-9._%+-])[ \t]*\n\s*([.@])/g, '$1$2')
    .replace(/(^|\n)[ \t]*([A-Za-z0-9._%+-]+[.@])[ \t]*\n\s*(?=[A-Za-z0-9])/g, '$1$2');
}
function pickRecruiterEmail(joined) {
  const mine = new Set([config.gmailUser, config.senderEmail, ...config.ccEmails].map(s => String(s).toLowerCase()));
  const all = [...joined.matchAll(EMAIL_RE)].map(m => ({ addr: m[0].toLowerCase().replace(/\.$/, ''), at: m.index }))
    .filter(e => !mine.has(e.addr) && !/nvoids/i.test(e.addr));
  const labelled = all.find(e => /(?:e-?mail(?:\s*id)?|reply\s*to|contact|send (?:your )?resume to)\s*[:\-]?\s*$/i.test(joined.slice(Math.max(0, e.at - 40), e.at)));
  return (labelled ?? all[0])?.addr ?? '';
}

// Their own job/requisition number, if the JD gives one ("Job ID: 12345", "Req #A-778").
function findRefId(text) {
  return /\b(?:job|req(?:uisition)?|position)\s*(?:id|#|no\.?|number|code)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-_]{2,19})\b/i.exec(text)?.[1] ?? '';
}

// "Replace and Add": cancel the earlier, unsent email for the same job so this pasted JD goes out instead,
// re-matched against your current resumes. An email that already went out is never replaced (that would
// email the same recruiter twice for one job).
const APP_STATE = { draft: 'a draft in Review', held: 'held', failed: 'a failed send', queued: 'approved and queued to send', expired: 'expired unsent', skipped: 'skipped' };
function priorApp(jobId) {
  return db.prepare(`SELECT id, status, sent_at, resume_folder, resume_path FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(jobId);
}
// A duplicate is a warning, never a dead end: you can always add it anyway (force) as a follow-up.
function duplicate(kind, job, to) {
  const a = priorApp(job.id);
  const wasSent = a && (a.status === 'sent' || a.status === 'sending');
  const sentAt = wasSent ? String(a.sent_at ?? '').slice(0, 16) : '';
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() };   // calendar days, not 24 h blocks
  const days = sentAt ? Math.round((midnight(Date.now()) - midnight(sentAt.slice(0, 10) + 'T00:00')) / 86_400_000) : null;
  const ago = days == null ? '' : days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  const file = a?.resume_path ? ` (${String(a.resume_path).split(/[\\/]/).pop()})` : '';
  // No email exists for it: say why (e.g. the scraper skipped it as a low match), so it's clear nothing was sent.
  const jrow = a ? null : db.prepare(`SELECT status, status_reason FROM jobs WHERE id = ?`).get(job.id);
  const JOB_STATE = { low_match: 'skipped as a low match', filtered_out: 'filtered out', skipped: 'skipped by you', no_resume: 'skipped (no resume found)', new: 'not processed yet' };
  const state = a ? (wasSent ? `sent ${sentAt} with resume folder ${a.resume_folder}${file}` : APP_STATE[a.status] ?? a.status)
                  : `never drafted or sent: ${JOB_STATE[jrow?.status] ?? jrow?.status ?? 'no email made'}${jrow?.status_reason ? ` (${jrow.status_reason})` : ''}`;
  const what = kind === 'same' ? `You already have this JD: #${job.id} “${job.title}”` : `${to} already has a near-identical JD on file: #${job.id} “${job.title}”`;
  to = to || db.prepare(`SELECT recruiter_email FROM jobs WHERE id = ?`).get(job.id)?.recruiter_email || '';
  const headline = wasSent ? `ALREADY EMAILED${to ? ` ${to}` : ''} — ${ago.toUpperCase()}` : a ? `DUPLICATE JD — #${job.id} IS ${String(state).toUpperCase()}, NOT SENT` : `DUPLICATE JD — #${job.id} WAS NEVER SENT (${String(JOB_STATE[jrow?.status] ?? jrow?.status ?? 'no email made').toUpperCase()})`;
  return { duplicate: true, forceable: true, replaceable: !wasSent, prior_id: job.id, prior_title: job.title, prior_state: state,
           sent_at: sentAt || null, days_ago: days, headline, prior_resume: wasSent ? a.resume_folder : null,
           error: `${what} (${state}). Nothing has been added yet: you decide.` };
}
// Of several matches, the one you actually emailed is the one worth warning about.
const pickDup = (list) => list.find(j => ['sent', 'sending'].includes(priorApp(j.id)?.status)) ?? list[0];
function followUpFlag(job) {
  const a = priorApp(job.id);
  const when = a && (a.status === 'sent' || a.status === 'sending') ? `already emailed on ${String(a.sent_at ?? '').slice(0, 16)} with resume folder ${a.resume_folder}` : `already on file (${APP_STATE[a?.status] ?? a?.status ?? 'not drafted'})`;
  return `FOLLOW-UP: this JD matches #${job.id} “${job.title}”, ${when}. You chose to send it again.`;
}
function retire(jobId, newId) {
  const a = priorApp(jobId);
  if (a && (a.status === 'sent' || a.status === 'sending')) throw new Error(`#${jobId} was already sent, so it can't be replaced.`);
  if (a && ['draft', 'held', 'failed', 'queued'].includes(a.status)) {
    db.prepare(`UPDATE applications SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?`).run(`Replaced by manual #${newId}`, now(), a.id);
  }
  setJobStatus(jobId, 'filtered_out', `replaced by manual #${newId} (pasted by you)`);
  logEvent('info', 'replaced', jobId, `#${jobId}${a ? ` (${APP_STATE[a.status] ?? a.status})` : ''} replaced by your pasted JD #${newId}`);
}

function nextManualId() {
  const max = db.prepare(`SELECT MAX(id) m FROM jobs WHERE id < 1000000`).get().m ?? 0;
  return Math.max(MANUAL_START, max + 1);
}

// fields: { jd_text (required), to_email?, title?, location? } — anything left blank is read from the JD.
export async function addManualJob(fields) {
  const jd = String(fields.jd_text ?? '').replace(/\r/g, '').replace(/ /g, ' ').trim();
  if (jd.length < 80) throw new Error('Paste the full job description (it looks too short).');

  const replace = fields.replace === true || fields.replace === 'true';
  const force = !replace && (fields.force === true || fields.force === 'true');   // add anyway, as a follow-up
  const hash = jdHash(jd);
  const same = db.prepare(`SELECT id, title FROM jobs WHERE jd_hash = ? AND status != 'filtered_out' ORDER BY id DESC`).all(hash);
  if (same.length && !replace && !force) return duplicate('same', pickDup(same));

  const to = String(fields.to_email ?? '').trim().toLowerCase() || findRecruiterEmail(jd);
  if (!parseVendor(to)) throw new Error(to ? `“${to}” is not a valid email address.` : 'No recruiter email found in the JD. Type it in the “Recruiter email” box.');
  const bl = blacklistHit({ recruiter_email: to, title: fields.title ?? '', jd_text: jd });
  if (bl) throw new Error(`${to} is on your Blocked list (“${bl}”). Nothing was added.`);

  // Same recruiter, near-identical JD already on file → probably the same requirement.
  const prior = db.prepare(`SELECT id, title, jd_text FROM jobs WHERE lower(recruiter_email) = ? ORDER BY id DESC LIMIT 50`).all(to);
  const twins = prior.filter(p => !same.some(x => x.id === p.id) && similarity(p.jd_text, jd) >= config.repostSimilarity);
  if (twins.length && !replace && !force) return duplicate('twin', pickDup(twins), to);
  const dupOf = force && (twins.length || same.length) ? pickDup([...twins, ...same]) : null;
  const replaced = replace ? [...same, ...twins] : [];
  for (const j of replaced) { const a = priorApp(j.id); if (a && (a.status === 'sent' || a.status === 'sending')) return duplicate('twin', j, to) }

  const id = nextManualId();
  const firstLine = jd.split('\n').map(l => stripHiring(l.trim())).find(l => l.length >= 3 && l.length <= 90 && !isGreeting(l) && !FIELD_LABEL.test(l)) ?? '';
  const draftJob = { id, title: String(fields.title ?? '').trim(), jd_text: jd };
  const title = draftJob.title || roleTitle({ ...draftJob, title: firstLine });
  const location = String(fields.location ?? '').trim() || extractLocation(jd);
  const t = now();
  db.prepare(`INSERT INTO jobs (id, uid, url, title, location_listed, location_jd, posted_raw, posted_at, posted_utc, recruiter_email, recruiter_name,
                                company, jd_text, jd_hash, status, status_reason, source, ref_id, scraped_at, updated_at)
              VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, NULL, ?, ?, '', ?, ?, 'new', 'pasted by you', 'manual', ?, ?, ?)`)
    .run(id, `manual:${id}`, title, location, location, `added ${t}`, t.slice(0, 16), to, signatureName(jd), jd, hash, findRefId(jd), t, t);
  logEvent('info', 'manual_added', id, `MANUAL #${id}: “${title}” → ${to} (pasted by you)`);
  for (const j of replaced) retire(j.id, id);

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  const verdict = classify(job);
  if (!verdict.keep) verdict.flags.unshift(`Would have been skipped if it came from nvoids: ${verdict.reason}`);
  if (dupOf) verdict.flags.unshift(followUpFlag(dupOf));
  const app = await makeDraft(job, verdict, { manual: true });
  if (!app) throw new Error(`#${id} was saved but no draft could be made (see the Log tab).`);
  if (dupOf) {   // you already saw the warning and chose to send again, so the send-time repost hold is skipped
    db.prepare(`UPDATE applications SET override_repost = 1, updated_at = ? WHERE id = ?`).run(now(), app.id);
    logEvent('info', 'follow_up', id, `MANUAL #${id} added as a follow-up to #${dupOf.id} (you chose to email ${to} again)`);
  }
  return { id, app_id: app.id, title, to_email: to, resume_folder: app.resume_folder, score: app.match_score, replaced: replaced.map(j => j.id), follow_up_of: dupOf?.id ?? null };
}
