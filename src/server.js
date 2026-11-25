// Local dashboard (http://127.0.0.1:PORT). Pages are drawn by ui.js; this file routes requests and holds
// the JSON API the pages call.
//
// Security (this page can send email): listens on 127.0.0.1 only; rejects any Host header that isn't
// localhost (DNS rebinding); every POST must carry the X-Runevoid header (a custom header other websites
// cannot send without a CORS preflight, which we never answer) and, if present, a same-origin Origin.
// Job text comes from the internet and is always HTML-escaped.
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import mammoth from 'mammoth';
import { config, ROOT } from './config.js';
import { db, getState, setState, logEvent } from './db.js';
import { sendTestToSelf, verifyEmail, HISTORY_PATH, setCcEmails, getCcEmails } from './email.js';
import { listResumeFiles } from './resumes.js';
import { pollOnce, rescue, rematchLowMatch, applyAnyway } from './pipeline.js';
import { queueStatus, setSendingPaused } from './mailer.js';
import { approve, cancelQueued, skip, resolveHold, setLock, removeLock, rematch, rematchAll, rematchSome, rematchStatus, stopRematch, editQueued, setVendorStatus, addBlacklist, removeBlacklist } from './actions.js';
import { addManualJob } from './manual.js';
import {
  esc, table, layout, counts, reviewPage, REVIEW_SCRIPT, draftView, emailView, attachmentOf, resumePreview,
  overviewPage, sentPage, vendorsPage, logsPage, healthPage,
  freshItems, scrapedPage, APP_JS,
} from './ui.js';

// ── Search ───────────────────────────────────────────────────────────────────
// One box, everything: job/manual numbers, titles, recruiter names and emails, companies, phone numbers
// (digits only, so "609-459-0206" = "(609) 459 0206"), the JD text, email subjects and bodies, resume
// folders, vendor locks and the log. Exact phrase first, then every word anywhere.
const STATUS_LABEL = { draft: 'draft', queued: 'queued', sending: 'sending', sent: 'sent', held: 'held', failed: 'failed', skipped: 'skipped', expired: 'expired (not sent)' };

function openLink(j) {
  if (!j.app_id) return j.source === 'manual' ? '' : `<a href="${esc(j.url)}" target="_blank" rel="noopener">posting</a>`;
  if (['draft', 'held', 'failed'].includes(j.app_status)) return `<a href="/${j.source === 'manual' ? 'manual' : 'review'}?open=${j.app_id}">open</a>`;
  return `<a href="/app/${j.app_id}">open</a>`;
}

function searchPage(qRaw) {
  const q = String(qRaw ?? '').trim().slice(0, 200);
  if (!q) return `<div class="panel">Type an email, name, phone number, company, job title or job number in the search box above.</div>`;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const digits = q.replace(/\D/g, '');
  const isPhone = digits.length >= 6 && /^[\d\s()+.-]+$/.test(q);
  const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  const fields = `lower(coalesce(j.title,'') || ' ' || coalesce(j.recruiter_email,'') || ' ' || coalesce(j.recruiter_name,'') || ' ' ||
                  coalesce(j.company,'') || ' ' || coalesce(j.location_jd,'') || ' ' || coalesce(j.location_listed,'') || ' ' ||
                  coalesce(j.ref_id,'') || ' ' || coalesce(a.to_email,'') || ' ' || coalesce(a.subject,'') || ' ' || coalesce(a.body,'') || ' ' ||
                  coalesce(j.jd_text,''))`;
  const SELECT = `SELECT j.*, a.id app_id, a.status app_status, a.resume_folder, a.match_score, a.sent_at, a.to_email FROM jobs j LEFT JOIN applications a ON a.job_id = j.id`;
  let jobRows, matchMode = '';
  if (/^\d+$/.test(q) && !isPhone) {
    jobRows = db.prepare(`${SELECT} WHERE j.id = ? OR j.ref_id = ? LIMIT 1`).all(Number(q), q);
  } else if (isPhone) {
    jobRows = db.prepare(`${SELECT} WHERE j.jd_text LIKE ? ESCAPE '\\' ORDER BY j.id DESC LIMIT 2000`).all(like(digits.slice(-4)))
      .filter(j => String(j.jd_text ?? '').replace(/\D/g, '').includes(digits.slice(-10)));
  } else {
    const find = (list) => db.prepare(`${SELECT} WHERE ${list.map(() => `${fields} LIKE ? ESCAPE '\\'`).join(' AND ')} ORDER BY j.id DESC LIMIT 300`).all(...list.map(like));
    jobRows = terms.length > 1 ? find([q.toLowerCase().replace(/\s+/g, ' ')]) : [];
    if (jobRows.length) matchMode = 'exact phrase'; else jobRows = find(terms);
  }
  const locks = isPhone ? [] : db.prepare(`SELECT * FROM vendor_locks WHERE ${terms.map(() => `lower(domain || ' ' || local || ' ' || coalesce(reason,'')) LIKE ? ESCAPE '\\'`).join(' AND ')}`).all(...terms.map(like));
  const events = db.prepare(`SELECT * FROM events WHERE ${(isPhone ? [digits] : terms).map(() => `lower(message) LIKE ? ESCAPE '\\'`).join(' AND ')} ORDER BY id DESC LIMIT 50`)
    .all(...(isPhone ? [digits] : terms).map(like));
  const snippet = (j) => {
    const text = String(j.jd_text ?? ''); const needle = isPhone ? null : terms.find(t => text.toLowerCase().includes(t));
    if (!needle) return '';
    const at = text.toLowerCase().indexOf(needle);
    return `<div class="meta">…${esc(text.slice(Math.max(0, at - 60), at + needle.length + 60).replace(/\s+/g, ' '))}…</div>`;
  };
  const head = `<div class="meta" style="margin-bottom:10px">Results for <b>${esc(q)}</b>${isPhone ? ' (phone number, any format)' : matchMode ? ` (${matchMode})` : terms.length > 1 ? ' (all words)' : ''}</div>`;
  const jobsTable = jobRows.length ? `<div class="panel"><h3>Jobs and emails (${jobRows.length}${jobRows.length >= 300 ? '+' : ''})</h3>` + table([
    ['#', j => `<b>${j.id}</b>${j.source === 'manual' ? '<div class="meta">manual</div>' : ''}`], ['Job', j => `${esc(j.title)}${snippet(j)}`],
    ['Recruiter', j => `${esc(j.recruiter_name ?? '')}<br>${esc(j.to_email || j.recruiter_email || '')}${j.company ? `<div class="meta">${esc(j.company)}</div>` : ''}`],
    ['Status', j => `<b>${esc(STATUS_LABEL[j.app_status] ?? j.status)}</b>${j.sent_at ? `<div class="meta">sent ${esc(j.sent_at)}</div>` : ''}${j.resume_folder ? `<div class="meta">folder ${esc(j.resume_folder)} (${j.match_score ?? '?'}%)</div>` : ''}`],
    ['Scraped', j => esc(j.scraped_at)], ['', openLink]], jobRows) + `</div>` : '';
  const locksTable = locks.length ? `<div class="panel"><h3>Vendor locks (${locks.length})</h3>` + table([
    ['Vendor', l => esc(`${l.local || '*'}@${l.domain}`)], ['Folder', l => esc(l.resume_folder)], ['Reason', l => esc(l.reason ?? '')], ['', () => `<a href="/vendors">manage</a>`]], locks) + `</div>` : '';
  const eventsTable = events.length ? `<div class="panel"><h3>Log entries (${events.length}${events.length >= 50 ? '+' : ''})</h3>` + table([
    ['Time', e => esc(e.ts)], ['Event', e => esc(e.type)], ['Job', e => e.job_id ? `#${e.job_id}` : ''], ['Message', e => esc(e.message)]], events) + `</div>` : '';
  const none = !jobRows.length && !locks.length && !events.length ? `<div class="panel">Nothing found for “${esc(q)}”.</div>` : '';
  return head + jobsTable + locksTable + eventsTable + none;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
}

// ── Request guards ───────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
function guard(req, res, next) {
  if (!LOCAL_HOSTS.has(String(req.headers.host ?? '').toLowerCase())) return res.status(403).send('Forbidden host');
  if (req.method === 'POST') {
    if (req.headers['x-runevoid'] !== '1') return res.status(403).json({ ok: false, error: 'Missing dashboard header' });
    const origin = req.headers.origin;
    if (origin && !LOCAL_HOSTS.has(origin.replace(/^https?:\/\//, '').toLowerCase())) return res.status(403).json({ ok: false, error: 'Cross-site request refused' });
  }
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

const ok = (fn) => async (req, res) => {
  try { const r = await fn(req); res.json({ ok: true, ...(r && typeof r === 'object' ? r : {}) }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
};

const notFound = (text) => `<div class="empty"><h3>Not found</h3><p>${text}</p><p><a href="/">Go to Overview</a></p></div>`;
const appById = (id) => db.prepare(`SELECT * FROM applications WHERE id = ?`).get(Number(id));
const jobById = (id) => db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(Number(id));

export function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(guard);
  app.use(express.json({ limit: '300kb' }));
  // The page scripts, bundled in memory at startup (see APP_JS in src/ui.js). The URL carries the bundle's hash,
  // so it can be cached for good.
  app.get('/static/app.js', (_req, res) => res.type('text/javascript').set('Cache-Control', 'public, max-age=31536000, immutable').send(APP_JS));
  app.use('/static', express.static(join(ROOT, 'public'), { maxAge: '7d', index: false }));
  app.get('/favicon.ico', (_req, res) => res.sendFile(join(ROOT, 'public', 'favicon-32.png')));

  // Pages
  app.get('/', (_req, res) => res.send(layout('overview', overviewPage())));
  app.get('/review', (_req, res) => res.send(layout('review', reviewPage(false), { split: true, script: REVIEW_SCRIPT })));
  app.get('/manual', (_req, res) => res.send(layout('manual', reviewPage(true), { split: true, script: REVIEW_SCRIPT })));
  app.get('/sent', (req, res) => res.send(layout('sent', sentPage({ q: String(req.query.q ?? '') }))));
  app.get('/sent/rows', (req, res) => res.type('application/json').send(sentPage({ q: String(req.query.q ?? ''), rowsOnly: true })));
  app.get('/scraped', (req, res) => res.send(layout('scraped', scrapedPage({ show: String(req.query.show ?? ''), day: String(req.query.day ?? 'today'), q: String(req.query.q ?? '').slice(0, 200) }))));
  app.get('/vendors', (_req, res) => res.send(layout('vendors', vendorsPage())));
  app.get('/logs', (req, res) => res.send(layout('logs', logsPage(String(req.query.view ?? '')))));
  app.get('/health', (_req, res) => res.send(layout('health', healthPage())));
  app.get('/search', (req, res) => res.send(layout('', searchPage(req.query.q), { searchText: String(req.query.q ?? '') })));
  app.get('/app/:id', (req, res) => {
    const a = appById(req.params.id);
    if (!a) return res.status(404).send(layout('', notFound(`There is no email #${esc(req.params.id)}.`)));
    const j = jobById(a.job_id);
    if (['draft', 'held', 'failed'].includes(a.status)) return res.redirect(`/${j.source === 'manual' ? 'manual' : 'review'}?open=${a.id}`);
    res.send(layout('sent', emailView(a, j, { q: String(req.query.q ?? '').slice(0, 200) })));
  });
  // The resume an email carried: the saved copy when there is one (see attachmentOf in ui.js).
  app.get('/app/:id/attachment/file', (req, res) => {
    const a = appById(req.params.id);
    const att = a && attachmentOf(a);
    if (!att || att.state === 'missing') return res.status(404).send(layout('sent', notFound('That resume file is no longer on disk.')));
    res.download(att.path, basename(att.path));
  });
  // Read it in the dashboard: .docx through mammoth (already used for matching), PDF straight in the browser.
  app.get('/app/:id/attachment', async (req, res) => {
    const a = appById(req.params.id);
    const att = a && attachmentOf(a);
    if (!att || att.state === 'missing') return res.status(404).send(layout('sent', notFound('That resume file is no longer on disk.')));
    if (/\.pdf$/i.test(att.path)) return res.type('application/pdf').set('Content-Disposition', `inline; filename="${basename(att.path).replace(/"/g, '')}"`).sendFile(att.path);
    if (!/\.docx$/i.test(att.path)) return res.redirect(`/app/${a.id}/attachment/file`);
    let html;
    try { html = (await mammoth.convertToHtml({ path: att.path })).value; }
    catch (e) { return res.send(layout('sent', notFound(`Could not read ${esc(basename(att.path))}: ${esc(e.message)}`))); }
    res.send(layout('sent', resumePreview(a, att, html)));
  });
  app.get('/history', (_req, res) => {
    const text = existsSync(HISTORY_PATH) ? readFileSync(HISTORY_PATH, 'utf8') : 'Nothing sent yet.';
    res.send(layout('sent', `<div class="panel"><h3>Sent_History.md</h3><div class="meta">${esc(HISTORY_PATH)}</div><pre>${esc(text)}</pre></div>`));
  });
  // Old addresses → new tabs
  for (const [from, to] of [['/drafts', '/review'], ['/add', '/manual'], ['/applied', '/sent'], ['/log', '/logs'], ['/jobs', '/scraped']]) app.get(from, (_req, res) => res.redirect(to));

  // Draft loaded into the work area
  app.get('/api/card/:id', (req, res) => {
    const a = appById(req.params.id);
    if (!a) return res.json({ ok: false, html: '' });
    const j = jobById(a.job_id);
    res.json({ ok: true, html: ['draft', 'held', 'failed'].includes(a.status) ? draftView(a, j) : emailView(a, j) });
  });
  // Queued email, for the Overview editor
  app.get('/api/queued/:id', (req, res) => {
    const a = appById(req.params.id);
    if (!a || a.status !== 'queued') return res.json({ ok: false, error: 'Not in the queue any more (it may have just been sent)' });
    res.json({ ok: true, to_email: a.to_email, cc_emails: a.cc_emails ?? getCcEmails().join(', '), subject: a.subject, body: a.body, resume_folder: a.resume_folder, title: jobById(a.job_id)?.title ?? '' });
  });

  const exportsSql = {
    'jobs.csv': `SELECT id, source, ref_id, title, location_listed, location_jd, posted_raw, recruiter_name, recruiter_email, company, status, status_reason, scraped_at, url FROM jobs ORDER BY id DESC`,
    'applications.csv': `SELECT a.id, a.job_id, j.source, j.title, a.location, a.to_email, j.recruiter_name, j.company, a.resume_folder, a.resume_path, a.match_score, a.match_method,
                                a.locked, a.status, a.hold_kind, a.hold_reason, a.created_at AS drafted_at, a.approved_at, a.queued_at, a.sent_at, a.error, a.subject, j.url
                         FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.id DESC`,
    'events.csv': `SELECT id, ts, level, type, job_id, message, data FROM events ORDER BY id DESC`,
    'locks.csv': `SELECT domain, local, resume_folder, reason, created_at, updated_at FROM vendor_locks ORDER BY domain, local`,
    'vendors.csv': `SELECT address, status, on_date, note, updated_at FROM vendor_status ORDER BY updated_at DESC`,
  };
  app.get('/export/:name', (req, res) => {
    const sql = exportsSql[req.params.name];
    if (!sql) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="runevoid-${req.params.name}"`);
    res.send('﻿' + toCsv(db.prepare(sql).all()));
  });

  app.get('/api/fresh', (req, res) => res.json({ ok: true, items: freshItems(req.query.source === 'manual', Number(req.query.after) || 0) }));
  app.get('/api/summary', (_req, res) => { const c = counts(); res.json({ pending: c.newPostings + c.waiting + c.fix, last_poll_at: getState('last_poll_at'), queue: queueStatus() }); });

  // Actions
  app.post('/api/poll', ok(() => pollOnce({ force: true })));
  app.post('/api/rescue', ok(req => rescue(Number(req.body?.hours ?? 6))));
  app.post('/api/rematch-low/:id', ok(req => rematchLowMatch(req.params.id)));
  app.post('/api/apply-anyway/:id', ok(req => applyAnyway(req.params.id)));
  app.post('/api/manual', ok(req => addManualJob(req.body ?? {})));
  app.post('/api/approve/:id', ok(req => { approve(req.params.id, req.body ?? {}); }));
  app.post('/api/skip/:id', ok(req => { skip(req.params.id); }));
  app.post('/api/rematch/:id', ok(req => rematch(req.params.id)));
  app.post('/api/rematch-all', ok(req => rematchAll(String(req.body?.source ?? ''))));
  app.post('/api/rematch-stop', ok(() => { stopRematch(); }));
  app.get('/api/rematch-progress', (_req, res) => res.json(rematchStatus()));
  app.post('/api/bulk', ok(async req => {
    const ids = (req.body?.ids ?? []).map(Number).filter(Boolean).slice(0, 500);
    const action = String(req.body?.action ?? '');
    if (action === 'rematch') return rematchSome(ids);   // runs in the background, so Stop works and the page stays usable
    let done = 0; const errors = [];
    for (const id of ids) {
      try { if (action === 'skip') skip(id); else throw new Error('Unknown action'); done++; }
      catch (e) { errors.push(`${id}: ${e.message}`); }
    }
    logEvent('info', 'bulk', null, `Bulk ${action}: ${done} of ${ids.length} done${errors.length ? `, ${errors.length} failed` : ''}`);
    return { done, errors };
  }));
  app.post('/api/cancel/:id', ok(req => { cancelQueued(req.params.id); }));
  app.post('/api/edit-queued/:id', ok(req => { editQueued(req.params.id, req.body ?? {}); }));
  app.post('/api/hold/:id', ok(req => { resolveHold(req.params.id, String(req.body?.decision ?? ''), req.body?.resume_folder ? String(req.body.resume_folder) : undefined); }));
  app.post('/api/locks', ok(req => { setLock(req.body ?? {}); }));
  app.post('/api/locks/:id/delete', ok(req => { removeLock(req.params.id); }));
  app.post('/api/vendor-status', ok(req => { setVendorStatus(req.body ?? {}); }));
  app.post('/api/blacklist', ok(req => addBlacklist(req.body ?? {})));
  app.post('/api/blacklist/:id/delete', ok(req => { removeBlacklist(req.params.id); }));
  app.post('/api/pause-sending', ok(req => { setSendingPaused(Boolean(req.body?.on)); }));
  app.post('/api/pause-watcher', ok(req => {
    setState('watcher_paused', req.body?.on ? '1' : '0');
    logEvent('info', req.body?.on ? 'watcher_paused' : 'watcher_resumed', null, req.body?.on ? 'Watcher paused by you' : 'Watcher resumed');
  }));
  app.post('/api/cc', ok(req => setCcEmails(String(req.body?.emails ?? ''))));
  app.post('/api/verify-email', ok(async () => { const r = await verifyEmail(); if (!r.ok) throw new Error(r.error); }));
  app.post('/api/test-send', ok(async req => {
    const resumes = listResumeFiles();
    const requested = String(req.body?.folder ?? resumes[0]?.folder ?? '');
    const file = resumes.find(f => f.folder === requested || f.name === requested);
    if (!file) throw new Error(`Resume “${requested}” not found`);
    await sendTestToSelf(file.path);
    logEvent('info', 'test_send', null, `Test email sent to ${config.gmailUser} with resume ${file.name}`);
  }));

  // Anything else: the themed "not found" page; plain 404s for API calls and static files.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'Not found' });
    if (req.path.startsWith('/static/')) return res.status(404).end();
    res.status(404).send(layout('', notFound(`There is no page at ${esc(req.path)}.`)));
  });

  return new Promise(resolve => {
    const server = app.listen(config.port, '127.0.0.1', () => {
      logEvent('info', 'dashboard', null, `Dashboard on http://127.0.0.1:${config.port}`);
      resolve(server);
    });
  });
}
