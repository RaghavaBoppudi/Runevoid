// One poll cycle: new listings → detail → filter → match resume → draft (waits for your approval).
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { fetchNewListings, fetchJobDetail, fetchListingPage } from './scraper.js';
import { classify, isAdvert, blacklistHit } from './filters.js';
import { rankResumes } from './resumes.js';
import { buildDraft } from './email.js';
import { lockFor, lockLabel, sameJdAtVendor } from './rules.js';
import { db, now, logEvent, getState, setState, setJobStatus } from './db.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DETAIL_DELAY_MS = 300;   // short pause between one worker's detail-page requests
const DETAIL_CONCURRENCY = 6;  // detail pages fetched at once

function jdHash(text) {
  const norm = (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 2000);
  return norm ? createHash('sha1').update(norm).digest('hex') : null;
}

function insertListing(row) {
  const t = now();
  const res = db.prepare(`INSERT OR IGNORE INTO jobs (id, uid, url, title, location_listed, posted_raw, posted_at, posted_utc, status, scraped_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`)
    .run(row.id, row.uid, row.url, row.title, row.location_listed, row.posted_raw, row.posted_at, row.posted_utc, t, t);
  return res.changes > 0;
}

async function processJob(id) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);

  if (isAdvert(job)) { setJobStatus(id, 'filtered_out', 'advert, not a requirement'); return; }

  const d = await fetchJobDetail(job.url);
  db.prepare(`UPDATE jobs SET recruiter_email = ?, recruiter_name = ?, company = ?, jd_text = ?, jd_hash = ?, location_jd = ?, updated_at = ? WHERE id = ?`)
    .run(d.recruiter_email, d.recruiter_name, d.company, d.jd_text, jdHash(d.jd_text), d.location_jd, now(), id);
  Object.assign(job, d);

  const verdict = classify(job);
  if (!verdict.keep) { setJobStatus(id, 'filtered_out', verdict.reason); return; }

  if (!job.recruiter_email) { setJobStatus(id, 'no_email', 'no recruiter email on the posting'); logEvent('warn', 'no_email', id, `${job.title}: kept, but the posting has no email`); return; }

  await makeDraft(job, verdict);
}

// Match resumes and write the draft. Shared by nvoids postings and JDs you paste in (manual: true).
// A manual JD is one you chose yourself, so it is never dropped: what would have skipped an nvoids
// posting (W2-only, not AI/ML, low resume fit) becomes a warning on the draft instead.
// force: you chose "Apply anyway" on a low-fit posting, so the minimum match is not applied (shown as a warning instead).
export async function makeDraft(job, verdict, { manual = false, matchResult, force = false } = {}) {
  const id = job.id;
  const { ranked, method, jdSkills } = matchResult ?? await rankResumes(job.jd_text || job.title, job.title);
  if (!ranked.length) { setJobStatus(id, 'no_resume', 'no resumes found in RESUMES_DIR'); logEvent('error', 'no_resume', id, 'No resumes found — check RESUMES_DIR'); return null; }

  const thin = jdSkills.length < config.minJdSkills;
  const lock = lockFor(job.recruiter_email);
  const prior = lock ? null : sameJdAtVendor(job.recruiter_email, job);
  let chosen = ranked[0];
  if (lock) {
    // A permanent lock beats matching: draft with the locked resume from the start.
    chosen = ranked.find(r => r.folder === lock.resume_folder) ?? chosen;
  } else if (prior && ranked.some(r => r.folder === prior.folder)) {
    // The vendor company already has a resume for this job: stay consistent.
    chosen = ranked.find(r => r.folder === prior.folder);
    verdict.flags.push(`Same job already sent to ${prior.to_email} (same company, ${prior.how}) on ${prior.sent_at.slice(0, 10)} with folder ${prior.folder}: using that resume again`);
  } else if (!thin && (chosen.keyword ?? chosen.score) < config.minMatchScore) {
    if (!manual && !force) {
      const keywordScore = chosen.keyword ?? chosen.score;
      const reason = `best resume (folder ${chosen.folder}) scored ${chosen.score}% (${keywordScore}% keyword coverage; minimum ${config.minMatchScore}%)`;
      db.prepare(`UPDATE jobs SET match_score = ?, match_method = ?, ranking_json = ?, updated_at = ? WHERE id = ?`)
        .run(chosen.score, method, JSON.stringify(ranked), now(), id);
      setJobStatus(id, 'low_match', reason);
      logEvent('info', 'low_match', id, `${job.title}: ${reason}; no draft`);
      return null;
    }
    verdict.flags.push(force
      ? `Applied anyway: your best resume (${chosen.folder}) covers ${chosen.keyword ?? chosen.score}% of this JD, below your ${config.minMatchScore}% minimum`
      : `Low fit: your best resume (folder ${chosen.folder}) covers only ${chosen.keyword ?? chosen.score}% of this JD (the bot skips nvoids posts below ${config.minMatchScore}%)`);
  }

  const draft = buildDraft(job, chosen, { thin });
  const t = now();
  db.prepare(`INSERT OR IGNORE INTO applications (job_id, resume_folder, resume_path, match_score, match_method, ranking_json, to_email, subject, body, auto_body,
                                                  location, flags_json, thin, locked, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
    .run(id, chosen.folder, chosen.path, chosen.score, method, JSON.stringify(ranked), job.recruiter_email, draft.subject, draft.body, draft.body,
         draft.location, JSON.stringify(verdict.flags), thin ? 1 : 0, lock ? 1 : 0, t, t);
  const why = lock ? `LOCKED to folder ${chosen.folder} (${lockLabel(lock)})` : `best resume: folder ${chosen.folder} (${chosen.score}%)`;
  setJobStatus(id, 'pending_approval', why);
  logEvent('info', 'drafted', id, `${manual ? `MANUAL #${id} ` : ''}${job.title} — ${verdict.reason}. Draft → ${job.recruiter_email}, ${why}${thin ? ', THIN JD' : ''}${verdict.flags.length ? `, ${verdict.flags.length} warning(s)` : ''}`,
    { ranking: ranked.map(r => ({ folder: r.folder, score: r.score })), flags: verdict.flags, manual });
  return db.prepare(`SELECT * FROM applications WHERE job_id = ?`).get(id);
}

// "Apply anyway" (Activity → Low resume fit): draft a low-fit posting with your best resume, whatever its match.
// It still lands in Review for approval and still goes through every vendor rule at send time.
export async function applyAnyway(id) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(id));
  if (!job || job.status !== 'low_match') throw new Error('This posting is not in the low-fit list');
  if (!job.recruiter_email) throw new Error('This posting has no recruiter email');
  const bl = blacklistHit(job);
  if (bl) throw new Error(`${job.recruiter_email} is on your Blocked list (“${bl}”)`);
  const existing = db.prepare(`SELECT id FROM applications WHERE job_id = ?`).get(job.id);
  if (existing) throw new Error('This posting already has a draft or email');
  const verdict = classify(job);
  if (!verdict.keep) verdict.flags.unshift(`Today's filters would skip this posting: ${verdict.reason}`);
  const matchResult = await rankResumes(job.jd_text || job.title, job.title);
  if (!matchResult.ranked.length) throw new Error('No resumes found in your resume folder');   // nothing changed on the posting
  const app = await makeDraft(job, verdict, { force: true, matchResult });
  if (!app) throw new Error('No draft could be made (see the Log)');
  logEvent('info', 'apply_anyway', job.id, `You chose Apply anyway: ${job.title} (${app.match_score}%)`);
  return { app_id: app.id, score: app.match_score };
}

export async function rematchLowMatch(id) {
  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(id));
  if (!job || job.status !== 'low_match') throw new Error('This posting is not in the low-fit list');
  const verdict = classify(job);
  if (!verdict.keep) {
    setJobStatus(job.id, 'filtered_out', verdict.reason);
    return { status: 'filtered_out' };
  }
  const matchResult = await rankResumes(job.jd_text || job.title, job.title);
  if (!matchResult.ranked.length) {
    setJobStatus(job.id, 'no_resume', 'no resumes found in RESUMES_DIR');
    return { status: 'no_resume' };
  }
  const app = await makeDraft(job, verdict, { matchResult });
  return { status: app ? 'pending_approval' : 'low_match', score: matchResult.ranked[0].score };
}

export { jdHash };

let running = false;

// Circuit breaker: after BREAKER_FAILURES failed checks in a row, stop asking nvoids for BREAKER_MINUTES
// (so a site outage or a block doesn't get hammered), then try again on its own.
const BREAKER_FAILURES = 3;
const BREAKER_MINUTES = 10;
export function breakerState() {
  return { failures: Number(getState('poll_failures', '0')), until: Number(getState('breaker_until', '0')) };
}

export async function pollOnce({ force = false } = {}) {
  if (running) return { skipped: true };
  if (getState('watcher_paused', '0') === '1') return { paused: true };
  const br = breakerState();
  if (!force && br.until > Date.now()) return { breaker: true, retry_in_s: Math.round((br.until - Date.now()) / 1000) };
  running = true;
  const started = Date.now();
  try {
    const sinceId = Number(getState('last_seen_id', 0));
    const rows = await fetchNewListings(sinceId);
    const fresh = rows.filter(insertListing).sort((a, b) => a.id - b.id);

    // Retry recent detail failures (network blips) along with the new rows.
    const retry = db.prepare(`SELECT id FROM jobs WHERE status IN ('error', 'no_resume') AND scraped_at >= datetime('now', 'localtime', '-2 hours') ORDER BY id`).all().map(r => r.id);
    const queue = [...new Set([...retry, ...fresh.map(r => r.id)])];

    // Newest first, DETAIL_CONCURRENCY pages at a time: nvoids takes 3-4s per page, so one-by-one
    // made a check take 3-5 minutes and posts went stale before you saw them.
    queue.sort((x, y) => y - x);
    let drafted = 0, next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const id = queue[next++];
        try {
          await processJob(id);
          if (db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(id).status === 'pending_approval') drafted++;
        } catch (e) {
          setJobStatus(id, 'error', e.message);
          logEvent('error', 'job_failed', id, e.message);
        }
        await sleep(DETAIL_DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, (_, i) => sleep(i * 200).then(worker)));

    const maxId = Math.max(sinceId, ...rows.map(r => r.id));
    setState('last_seen_id', maxId);
    setState('last_poll_at', now());
    setState('last_poll_ok', '1');
    if (br.failures) logEvent('info', 'breaker_reset', null, `nvoids reachable again after ${br.failures} failed check(s)`);
    setState('poll_failures', '0'); setState('breaker_until', '0');
    logEvent('info', 'poll', null, `Checked nvoids: ${fresh.length} new posting(s), ${drafted} new draft(s) awaiting approval (${((Date.now() - started) / 1000).toFixed(1)}s)`,
      { new: fresh.length, retried: retry.length, drafted, last_seen_id: maxId });
    return { new: fresh.length, drafted };
  } catch (e) {
    setState('last_poll_at', now());
    setState('last_poll_ok', '0');
    const failures = breakerState().failures + 1;
    setState('poll_failures', String(failures));
    logEvent('error', 'poll_failed', null, `Could not check nvoids (${failures} in a row): ${e.message}`);
    if (failures >= BREAKER_FAILURES) {
      setState('breaker_until', String(Date.now() + BREAKER_MINUTES * 60_000));
      logEvent('warn', 'breaker_open', null, `${failures} failed checks in a row — pausing nvoids checks for ${BREAKER_MINUTES} min, then trying again automatically`);
    }
    return { error: e.message };
  } finally {
    running = false;
  }
}

// Rescue: read the listing back `hours` (nvoids' own posted time), newest first, and run every posting
// the bot doesn't know yet through the normal path. For after the laptop slept or the bot was off.
let rescuing = false;
export async function rescue(hours = 6, maxPages = 25) {
  if (rescuing || running) throw new Error('A check or rescue is already running — try again in a minute');
  rescuing = true;
  const cutoff = Date.now() - Math.min(48, Math.max(1, Number(hours) || 6)) * 3_600_000;
  let pages = 0, found = 0, drafted = 0;
  try {
    logEvent('info', 'rescue', null, `Rescue started: reading back ${hours} h of postings`);
    for (let p = 0; p < maxPages; p++) {
      const rows = await fetchListingPage(p);
      pages++;
      if (!rows.length) break;
      const inWindow = rows.filter(r => !r.posted_utc || Date.parse(r.posted_utc) >= cutoff);
      const fresh = inWindow.filter(insertListing);
      for (const r of fresh.sort((a, b) => b.id - a.id)) {
        found++;
        try {
          await processJob(r.id);
          if (db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(r.id).status === 'pending_approval') drafted++;
        } catch (e) { setJobStatus(r.id, 'error', e.message); }
        await sleep(DETAIL_DELAY_MS);
      }
      if (inWindow.length < rows.length) break;   // this page already reaches past the window
      await sleep(2_000);
    }
    logEvent('info', 'rescue', null, `Rescue done: ${pages} page(s) read, ${found} missed posting(s) found, ${drafted} new draft(s)`);
    return { pages, found, drafted };
  } finally {
    rescuing = false;
  }
}
