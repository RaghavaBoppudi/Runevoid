// Runevoid dashboard — everything that draws a page. server.js only routes requests here.
//
// Layout (standard app-shell / master-detail dashboard):
//   header  — logo, top tabs, search, controls
//   kpis    — one compact strip: sent today/cap · week/total · new + waiting · queued/held/failed · next send
//   work    — fills the rest of the window; never scrolls as a page. Lists and panes scroll inside.
//     Review / Manual: a list bar on the left (New postings → Needs fixing → Standard), the chosen draft in
//     the work area, JD under the email, Approve/Skip pinned to the bottom. Keyboard: j/k ↑/↓ move,
//     a approve, s skip, r re-match, x select, / filter.
// Theme: a 1-bit desktop window on a night-sky desk (public/runevoid.css). Title bar, an outline sidebar,
// boxed cards with hard shadows, keys that sink when pressed. Sounds (early-Mac UI ticks, mechanical-keyboard typing) come from public/clicks.js.
// Review and Manual push a draft over the list.
import { config, emailConfigured, dailyCap, ROOT } from './config.js';
import { db, getState, DB_PATH } from './db.js';
import { ccFor, getCcEmails, HISTORY_PATH, sentBodyHtml } from './email.js';
import { listResumeFiles, resumeLabel } from './resumes.js';
import { draftWarnings, lockFor, lockLabel, parseVendor } from './rules.js';
import { isPriority, queueStatus, queuedInOrder } from './mailer.js';
import { breakerState } from './pipeline.js';
import { extractPhone } from './scraper.js';
import { VENDOR_STATUSES, rematchStatus } from './actions.js';
import { icon } from './icons.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Theme ─────────────────────────────────────────────────────────────────────
// Styles live in public/runevoid.css; the browser scripts (theme, click sounds, scrollbars) in public/*.js. Their URLs carry a hash of the
// file, so a changed file is fetched fresh even though /static is cached for a week.

const assetUrl = (name) => {
  let v = '';
  try { v = createHash('sha256').update(readFileSync(join(ROOT, 'public', name))).digest('hex').slice(0, 10); }
  catch { /* file missing: serve the plain URL and let the static handler 404 */ }
  return `/static/${name}${v ? `?v=${v}` : ''}`;
};
const ASSETS = { css: assetUrl('runevoid.css'),
  favicon: assetUrl('favicon.svg'), favicon32: assetUrl('favicon-32.png'), touchIcon: assetUrl('apple-touch-icon.png'),
  keyDown: assetUrl('sounds/key-down.wav'), keyUp: assetUrl('sounds/key-up.wav') };

// ── Client script shared by every page ────────────────────────────────────────

const CLIENT_JS = `
// Buttons whose label changes (Scan Now / Scanning…) hold both labels: <span class="bl" data-alt="Scanning…"><span>Scan Now</span></span>
// stacks the other one, invisible, in the same grid cell, so the button is as wide as the longer label from the
// start and never resizes or pushes its neighbours. setLabel swaps the visible one.
function setLabel(b, text){ const s = b.querySelector('.bl > span'); if (s) s.textContent = text; else b.textContent = text }
async function post(url, data){
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Runevoid':'1'},body:JSON.stringify(data||{})});
  return r.json();
}
async function simple(url, data, btn, confirmText){
  if (confirmText && !(await rvConfirm(confirmText))) return;
  if (btn) btn.disabled = true;
  const j = await post(url, data);
  if (j.ok) location.reload(); else { rvAlert(j.error || 'Failed'); if (btn) btn.disabled = false }
}
// Switches: let the knob finish its slide before the reload, and don't grey the switch out mid-slide
// (simple() disables its control, which would flash the switch at half opacity). On failure the knob slides back.
async function flip(input, url, data){
  const t0 = performance.now();
  input.style.pointerEvents = 'none';
  let j; try { j = await post(url, data) } catch (e) { j = { ok: false, error: e.message } }
  if (!j.ok) { input.checked = !input.checked; input.style.pointerEvents = ''; rvAlert(j.error || 'Failed'); return }
  const left = 180 - (performance.now() - t0);
  if (left > 0) await new Promise(r => setTimeout(r, left));
  location.reload();
}
// Scan Now: checks nvoids immediately (skipping the wait after failed checks) and says what happened.
async function pollNow(b){
  const msg = document.getElementById('scan-msg');
  b.disabled = true; b.classList.add('busy'); setLabel(b, 'Scanning…');
  let j; try { j = await post('/api/poll') } catch (e) { j = { ok: false, error: e.message } }
  const err = !j.ok || j.error ? (j.error || 'Scan failed') : j.paused ? 'The watcher is paused. Turn on Watch nvoids first.' : j.skipped ? 'A scan is already running.' : '';
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.title = t; msg.classList.toggle('bad', !!bad) } };
  b.classList.remove('busy');
  if (err) { say(/HTTP 52\\d/.test(err) ? 'nvoids is down (' + err.match(/HTTP 52\\d/)[0] + ')' : /fetch failed|ENOTFOUND|ECONN|timed? ?out|abort/i.test(err) ? 'Can’t reach nvoids' : err, true); if (msg) msg.title = err; setLabel(b, 'Scan Now'); b.disabled = false; return }
  // No page reload: a reload a moment later used to swallow whatever you clicked in between. Review and Manual
  // pull the new drafts into the list in place; every page updates the Review badge.
  say(j.new || j.drafted ? j.new + ' new · ' + j.drafted + ' drafted' : 'No new postings');
  setLabel(b, 'Scan Now'); b.disabled = false;
  if (j.drafted && typeof pullFresh === 'function') pullFresh();
  refreshBadge();
  setTimeout(() => say(''), 6000);
}
// Sidebar Review badge from the server's count (after a scan, or when new drafts arrive).
async function refreshBadge(){
  try {
    const { pending } = await (await fetch('/api/summary')).json();
    const tab = document.querySelector('.sb-item[href="/review"]'); if (!tab) return;
    let b = tab.querySelector('b');
    if (!pending) { if (b) b.remove(); return }
    if (!b) { b = document.createElement('b'); tab.append(b) }
    b.textContent = pending;
  } catch {}
}
// Re-match runs in the background: Stop ends it after the draft in hand, and the numbers update in place
// (no page reloads, so nothing you have open or typed is lost).
async function stopRematch(b){
  b.disabled = true;
  const j = await post('/api/rematch-stop');
  if (!j.ok) { rvAlert(j.error || 'Failed'); b.disabled = false }
}
function rmLabel(p){
  const n = p.done + '/' + p.total;
  if (p.running) return (p.stopping ? 'Stopping… ' : 'Re-matching… ') + n;
  return (p.stopped ? 'Stopped at ' : 'Re-match done ') + n + (p.changed ? ' · ' + p.changed + ' switched' : '');
}
if (document.querySelector('[data-rm-text]')) {
  const rmTimer = setInterval(async () => {
    try {
      const p = await (await fetch('/api/rematch-progress')).json();
      for (const el of document.querySelectorAll('[data-rm-text]')) el.textContent = rmLabel(p);
      if (!p.running) {
        clearInterval(rmTimer);
        for (const el of document.querySelectorAll('[data-rm-stop]')) el.remove();
        for (const el of document.querySelectorAll('[data-rm-done]')) el.style.display = '';
      }
    } catch {}
  }, 1500);
}
async function testSend(b){
  const resumes = ${JSON.stringify(listResumeFiles().map(r => ({ folder: r.folder, name: r.name })))};
  if (!resumes.length) { rvAlert('No resumes found. Add a .docx resume to your resume folder first.'); return; }
  const f = await rvChoose('Send a test email to your own address with which resume?', resumes.map(r => ({ value: r.folder, label: r.folder + ': ' + r.name })), resumes[0].folder, { ok: 'Send Test' });
  if (!f) return;
  b.disabled = true; const j = await post('/api/test-send',{folder:f}); b.disabled = false;
  rvAlert(j.ok ? 'Test email sent to your own address. Check your inbox.' : 'Failed: ' + j.error);
}
// Live countdown to the next send (header strip and Overview).
const NEXT_AT = Number(document.body.dataset.nextAt || 0);
function fmtLeft(ms){ const s = Math.max(0, Math.round(ms/1000)); const m = Math.floor(s/60); return m ? m + 'm ' + String(s%60).padStart(2,'0') + 's' : s + 's' }
function tick(){
  for (const el of document.querySelectorAll('[data-countdown]')) {
    if (!NEXT_AT) { el.textContent = el.dataset.idle || '—'; continue }
    const left = NEXT_AT - Date.now();
    el.textContent = left > 0 ? fmtLeft(left) : 'sending…';
  }
}
if (document.querySelector('[data-countdown]')) { setInterval(tick, 1000); tick(); }
// KPI numbers count up on load.
addEventListener('DOMContentLoaded', () => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const b of document.querySelectorAll('.kpi b[data-n]')) {
    const target = Number(b.dataset.n); if (!(target > 0)) continue;
    const t0 = performance.now(), dur = 650;
    const step = (t) => { const p = Math.min(1, (t - t0) / dur); b.textContent = Math.round(target * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step) };
    b.textContent = '0'; requestAnimationFrame(step);
  }
});
// Filter boxes: <input type="search" data-filter="#list > .row"> hides the rows that don't contain every word typed.
// Row text is lowercased once and cached, and the work runs once per frame however fast you type.
(() => {
  const text = new WeakMap();
  const textOf = (el) => { let t = text.get(el); if (t === undefined) { t = el.textContent.toLowerCase(); text.set(el, t) } return t };
  let frame = 0;
  document.addEventListener('input', (e) => {
    const box = e.target instanceof Element ? e.target.closest('input[data-filter]') : null;
    if (!box) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const words = box.value.toLowerCase().split(/\\s+/).filter(Boolean);
      for (const row of document.querySelectorAll(box.dataset.filter)) row.hidden = !words.every((w) => textOf(row).includes(w));
    });
  });
})();
`;

// Every page's browser code as one file, built once at startup: the scripts in public/ (order matters: dialogs and
// menus before the shared client code that calls them), then CLIENT_JS. One cached request instead of six, and no
// shared code inlined into each page.
const BUNDLE_PARTS = ['theme.js', 'clicks.js', 'scrollbars.js', 'dialogs.js', 'menus.js'];
export const APP_JS = BUNDLE_PARTS.map((f) => `// ── public/${f}\n${readFileSync(join(ROOT, 'public', f), 'utf8')}`).join(';\n') + `;\n// ── shared client code (src/ui.js)\n${CLIENT_JS}`;
const APP_JS_URL = `/static/app.js?v=${createHash('sha256').update(APP_JS).digest('hex').slice(0, 10)}`;

// Review / Manual: list + work area behaviour.
const REVIEW_JS = `
const list = document.getElementById('list'), pane = document.getElementById('pane'), filter = document.getElementById('filter');
let current = null;
// Rows never move under the pointer. New drafts and demotions wait while the pointer is moving over the list or a
// press is held, and are applied once it rests (1.5 s still) or leaves; otherwise a row could slide away between
// press and release, and the click would open the wrong draft or nothing.
let hovering = false, holding = false, lastMove = 0, steadyTimer = 0;
const waiting = new Set();
list.addEventListener('pointerenter', () => { hovering = true });
list.addEventListener('pointerleave', () => { hovering = false; flushSteady() });
list.addEventListener('pointermove', () => { lastMove = performance.now() }, { passive: true });
list.addEventListener('pointerdown', () => { holding = true }, { passive: true });
addEventListener('pointerup', () => { if (holding) { holding = false; flushSteady() } }, { passive: true });
addEventListener('pointercancel', () => { holding = false }, { passive: true });
const aiming = () => holding || (hovering && performance.now() - lastMove < 1500);
function whenSteady(fn){ waiting.add(fn); flushSteady() }
function flushSteady(){
  clearTimeout(steadyTimer);
  if (!waiting.size) return;
  if (aiming()) { steadyTimer = setTimeout(flushSteady, 500); return }
  const fns = [...waiting]; waiting.clear(); for (const fn of fns) fn();
}
const items = () => [...list.querySelectorAll('.item:not(.gone)')].filter(i => i.style.display !== 'none');
async function openItem(el, focusList){
  if (!el) return;
  for (const i of list.querySelectorAll('.item.active')) i.classList.remove('active');
  el.classList.add('active'); current = el;
  el.scrollIntoView({block:'nearest', inline:'nearest'}); list.scrollLeft = 0;
  if (focusList) el.focus();
  history.replaceState(null, '', location.pathname + '?open=' + el.dataset.id);
  document.getElementById('stack').classList.add('detail');
  document.getElementById('tb-title').textContent = el.querySelector('.it-title').textContent;
  pane.innerHTML = '<div class="empty">Loading…</div>';
  let j; try { j = await (await fetch('/api/card/' + el.dataset.id)).json() } catch { j = {html:'<div class="empty">Could not load this draft. Click it again.</div>'} }
  if (current !== el) return;
  pane.innerHTML = j.html || '<div class="empty">Not found.</div>';
  pane.dataset.shownAt = String(performance.now());
}
// A draft's buttons ignore clicks for the first 350 ms after it appears. Approve or Skip opens the next draft in the
// same place within milliseconds, so without this the second click of a double-click (or a quick second a / s)
// would act on the next draft, which you haven't read.
pane.addEventListener('click', e => {
  const b = e.target instanceof Element ? e.target.closest('button') : null;
  if (b && performance.now() - Number(pane.dataset.shownAt || 0) < 350) { e.preventDefault(); e.stopPropagation() }
}, true);
list.addEventListener('click', e => {
  if (e.target.matches('input[type=checkbox]')) { updateBulk(); return }
  const it = e.target.closest('.item'); if (it) { e.preventDefault(); openItem(it) }
});
function move(d){ const all = items(); if (!all.length) return; let i = all.indexOf(current); i = i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + d)); openItem(all[i], true) }
function next(){ const all = items(); const i = all.indexOf(current); return all[i + 1] || all[i - 1] || null }
function showRoot(){
  document.getElementById('stack').classList.remove('detail');
  document.getElementById('tb-title').textContent = list.dataset.manual === '1' ? 'Manual' : 'Review';
  if (current) { current.classList.remove('active'); current.focus({ preventScroll: false }) }
  current = null; history.replaceState(null, '', location.pathname); recount();
}
function markDone(text){
  const el = current; if (!el) return;
  const n = next();
  el.classList.add('gone'); el.classList.remove('active');
  current = null; recount();
  if (n) openItem(n, true); else { pane.innerHTML = '<div class="empty"><h3>' + text + '</h3><p>That was the last one.</p></div>'; setTimeout(showRoot, 900) }
}
async function approveCard(id, btn){
  const c = document.getElementById('app-' + id); const data = {};
  for (const el of c.querySelectorAll('[name]')) { if (el.name === 'body') { if (el.value !== el.defaultValue) data.body = el.value } else data[el.name] = el.value }
  btn.disabled = true;
  const j = await post('/api/approve/' + id, data);
  if (j.ok) markDone('Queued');
  else { c.querySelector('.msg').innerHTML = '<span class="err"></span>'; c.querySelector('.msg .err').textContent = j.error; btn.disabled = false }
}
async function cardAction(url, id, btn, doneText, confirmText){
  if (confirmText && !(await rvConfirm(confirmText))) return;
  if (btn) btn.disabled = true;
  const j = await post(url, {});
  if (!j.ok) { rvAlert(j.error || 'Failed'); if (btn) btn.disabled = false; return }
  if (doneText) markDone(doneText); else openItem(current);
}
async function holdAction(id, decision, btn){
  const sel = btn.closest('.draft')?.querySelector('select[name=resume_folder]');
  btn.disabled = true; const j = await post('/api/hold/' + id, { decision, resume_folder: sel ? sel.value : '' });
  if (!j.ok) { rvAlert(j.error); btn.disabled = false; return }
  if (decision === 'to_draft') openItem(current); else markDone('Back in the queue');
}
document.addEventListener('change', e => {
  if (e.target.name !== 'resume_folder') return;
  const d = e.target.closest('.draft'), kw = d.querySelector('.kw');
  let info = null; try { info = JSON.parse(d.querySelector('.kw-data').textContent)[e.target.value] } catch {}
  if (!kw || !info) return;
  kw.innerHTML = info.html + '<br><i>Unless you edited the message, it is rewritten for this resume when you approve.</i>';
  d.querySelector('.kw-count').textContent = info.found + ' found, ' + info.missing + ' missing';
  d.querySelector('.kw-score').textContent = info.score + '% match';
  kw.closest('details').open = true;
});
// filter
function applyFilter(){
  const q = filter.value.trim().toLowerCase();
  for (const it of list.querySelectorAll('.item')) it.style.display = !q || it.dataset.s.includes(q) ? '' : 'none';
  for (const g of list.querySelectorAll('.group')) {
    let n = 0, el = g.nextElementSibling;
    while (el && !el.classList.contains('group')) { if (el.style.display !== 'none' && !el.classList.contains('gone')) n++; el = el.nextElementSibling }
    g.querySelector('b').textContent = n; g.style.display = n || !q ? '' : 'none';
  }
}
filter.addEventListener('input', applyFilter);
// bulk
function selected(){ return [...list.querySelectorAll('.item input:checked')].map(c => Number(c.closest('.item').dataset.id)) }
function updateBulk(){ const n = selected().length; const b = document.getElementById('bulk'); b.classList.toggle('on', n > 0); document.getElementById('bulk-n').textContent = n }
async function bulk(action, btn){
  const ids = selected(); if (!ids.length) return;
  if (action === 'skip' && !(await rvConfirm('Skip ' + ids.length + ' draft(s)?', { ok: 'Skip' }))) return;
  btn.disabled = true; setLabel(btn, action === 'rematch' ? 'Re-matching…' : 'Skipping…');
  const j = await post('/api/bulk', {action, ids});
  if (!j.ok) await rvAlert(j.error); location.reload();
}
function selectAllShown(on){ for (const it of items()) it.querySelector('input').checked = on; list.classList.toggle('selecting', on); updateBulk() }
function toggleSelect(b){ const on = list.classList.toggle('selecting'); if (!on) selectAllShown(false); setLabel(b, on ? 'Cancel' : 'Select') }
// keyboard
document.addEventListener('keydown', e => {
  const t = e.target; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox';
  if (e.key === 'Escape') { if (typing) t.blur(); else if (document.getElementById('stack').classList.contains('detail')) showRoot(); return }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === '/') { e.preventDefault(); if (document.getElementById('stack').classList.contains('detail')) showRoot(); filter.focus() }
  else if (e.key === 'x' && current) { const c = current.querySelector('input'); c.checked = !c.checked; updateBulk() }
  else if (e.key === 'a' && current) { const b = pane.querySelector('[data-act=approve]'); if (b) b.click() }
  else if (e.key === 's' && current) { const b = pane.querySelector('[data-act=skip]'); if (b) b.click() }
  else if (e.key === 'r' && current) { const b = pane.querySelector('[data-act=rematch]'); if (b) b.click() }
});
// open from URL (?open=id) or nothing
const want = new URLSearchParams(location.search).get('open');
const start = want && list.querySelector('.item[data-id="' + want + '"]');
if (start) openItem(start);
// Live Priority: new drafts drop in at the top every few seconds; after the priority window they slide down to Standard.
const PRIO_MS = Number(list.dataset.prioMs || 600000);
const hotHead = list.querySelector('.group.hot'), stdHead = [...list.querySelectorAll('.group')].pop();
let maxId = Math.max(0, ...[...list.querySelectorAll('.item')].map(i => Number(i.dataset.id)));
// Groups only render the newest few hundred, so keep the server's hidden remainder in the count.
const shown = (g) => { let n = 0, el = g.nextElementSibling; while (el && !el.classList.contains('group')) { if (el.classList.contains('item') && !el.classList.contains('gone')) n++; el = el.nextElementSibling } return n };
for (const g of list.querySelectorAll('.group')) g.dataset.hidden = Number(g.querySelector('b').textContent) - shown(g);
function recount(){ for (const g of list.querySelectorAll('.group')) g.querySelector('b').textContent = shown(g) + Number(g.dataset.hidden || 0) }
function demote(){ whenSteady(demoteNow) }
function demoteNow(){
  if (!hotHead || !stdHead) return; let moved = false;
  for (const it of [...list.querySelectorAll('.item.hot')]) if (Date.now() - Number(it.dataset.posted) >= PRIO_MS) {
    it.classList.remove('hot'); it.classList.add('std'); stdHead.after(it); moved = true }
  if (moved) { sortGroup(stdHead); recount() }
}
function sortGroup(head){
  if (!head) return;
  const items = []; let el = head.nextElementSibling;
  while (el && !el.classList.contains('group')) { if (el.classList.contains('item')) items.push(el); el = el.nextElementSibling }
  items.sort((a,b) => {
    const av = a.dataset.match === '' ? -1 : Number(a.dataset.match);
    const bv = b.dataset.match === '' ? -1 : Number(b.dataset.match);
    return bv - av || Number(b.dataset.id) - Number(a.dataset.id);
  });
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(item);
  list.insertBefore(fragment, el);
}
function pullFresh(){ whenSteady(pullFreshNow) }
async function pullFreshNow(){
  if (!hotHead || document.hidden) return;
  try {
    const r = await (await fetch('/api/fresh?source=' + (list.dataset.manual === '1' ? 'manual' : 'nvoids') + '&after=' + maxId)).json();
    if (!r.ok || !r.items.length) return;
    const tmp = document.createElement('div');
    for (const x of r.items) {            // oldest first, so the newest ends up on top
      maxId = Math.max(maxId, x.id);
      if (list.querySelector('.item[data-id="' + x.id + '"]')) continue;
      tmp.innerHTML = x.html; const el = tmp.firstElementChild;
      el.classList.add('pop');
      if (x.kind === 'hot') hotHead.after(el); else stdHead.after(el);
    }
    sortGroup(hotHead); sortGroup(stdHead);
    applyFilter(); recount(); refreshBadge();
  } catch {}
}
setInterval(pullFresh, 8000); setInterval(demote, 15000); demote();
`;

// ── Shared helpers ────────────────────────────────────────────────────────────

const IS_MANUAL = `j.source = 'manual'`;
const NOT_MANUAL = `j.source IS NOT 'manual'`;
const n = (sql, ...p) => db.prepare(sql).get(...p).n;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function table(cols, rows) {
  return `<table><thead><tr>${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function jobTitle(job) {
  if (job.source === 'manual') return `<span class="tag soft">Manual #${job.id ?? job.job_id}</span> ${esc(job.title)}`;
  return `<a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(job.title)}</a>`;
}

function jobLine(job) {
  const loc = [job.location_jd, job.location_listed].filter(Boolean);
  return `#${job.id} · ${job.source === 'manual' ? 'pasted by you' : `posted ${esc(job.posted_raw)}`} · ${esc(loc[0] ?? 'location unknown')}${loc[1] && loc[1] !== loc[0] ? ` (listed: ${esc(loc[1])})` : ''}
 · ${esc(job.recruiter_name)}${job.company ? `, ${esc(job.company)}` : ''}`;
}

function age(row) {
  const t = row.posted_utc ? Date.parse(row.posted_utc) : Date.parse(String(row.created_at ?? '').replace(' ', 'T'));
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const byMatch = (a, b) => (b.best_match_score ?? b.match_score ?? -1) - (a.best_match_score ?? a.match_score ?? -1) || b.job_id - a.job_id;
const reviewKinds = (rows) => ({
  prio: rows.filter(r => r.status === 'draft' && r.source !== 'manual' && isPriority(r)).sort(byMatch),
  fix: rows.filter(r => r.status === 'held' || r.status === 'failed').sort(byMatch),
  std: rows.filter(r => r.status === 'draft' && !(r.source !== 'manual' && isPriority(r))).sort(byMatch),
});

function reviewRows(manual) {
  const rows = db.prepare(`SELECT a.id, a.job_id, a.status, a.resume_folder, a.match_score, a.ranking_json, a.to_email, a.created_at, a.hold_kind,
                            j.title, j.company, j.recruiter_name, j.posted_utc, j.source
                     FROM applications a JOIN jobs j ON j.id = a.job_id
                     WHERE a.status IN ('draft','held','failed') AND ${manual ? IS_MANUAL : NOT_MANUAL}
                     ORDER BY a.job_id DESC`).all();
  return rows.map(row => {
    const ranking = JSON.parse(row.ranking_json || '[]');
    const best = ranking.reduce((current, candidate) =>
      Number.isFinite(candidate.score) && (!current || candidate.score > current.score) ? candidate : current, null);
    return {
      ...row,
      best_match_score: best?.score ?? row.match_score,
      best_resume_folder: best?.folder ?? row.resume_folder,
    };
  });
}

// Every page and the 30s poller ask for these; cache briefly so the site stays snappy.
let countsCache = null, countsAt = 0;
export function counts() {
  if (countsCache && Date.now() - countsAt < 2_000) return countsCache;
  countsCache = computeCounts(); countsAt = Date.now();
  return countsCache;
}
function computeCounts() {
  const q = queueStatus();
  const cutoff = new Date(Date.now() - config.priorityWindowMinutes * 60_000).toISOString();
  const nv = db.prepare(`SELECT SUM(a.status = 'draft' AND j.posted_utc >= ?) prio, SUM(a.status = 'draft' AND NOT coalesce(j.posted_utc >= ?, 0)) std,
                                SUM(a.status IN ('held','failed')) fix
                         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status IN ('draft','held','failed') AND ${NOT_MANUAL}`).get(cutoff, cutoff);
  const manual = n(`SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.status IN ('draft','held','failed') AND ${IS_MANUAL}`);
  const wk = new Date(); wk.setHours(0, 0, 0, 0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
  return {
    q, newPostings: nv.prio ?? 0, waiting: nv.std ?? 0, fix: nv.fix ?? 0, manual,
    held: n(`SELECT COUNT(*) n FROM applications WHERE status = 'held'`),
    failed: n(`SELECT COUNT(*) n FROM applications WHERE status = 'failed'`),
    week: n(`SELECT COUNT(*) n FROM applications WHERE status = 'sent' AND sent_at >= ?`, ymd(wk)),
    total: n(`SELECT COUNT(*) n FROM applications WHERE status = 'sent'`),
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────

// The recruiter's phone from the posting's signature, as a row: tap to call, or copy.
function phoneRow(job) {
  const p = extractPhone(job.jd_text, job.recruiter_email);
  if (!p) return '';
  const [num, ext] = p.split(' ext. ');
  const tel = `+1${num.replace(/\D/g, '')}${ext ? `,${ext}` : ''}`;
  return `<div class="row"><label>Phone</label><span style="flex:1"></span><a class="val ink" href="tel:${tel}" title="Call">${esc(p)}</a>
   <button type="button" class="small" onclick="navigator.clipboard.writeText('${esc(p)}');setLabel(this,'Copied');setTimeout(()=>setLabel(this,'Copy'),1200)">${twoLabel('Copy', 'Copied')}</button></div>`;
}

// A button label with room reserved for the other label it can switch to (see setLabel in CLIENT_JS).
const twoLabel = (text, alt) => `<span class="bl" data-alt="${esc(alt)}"><span>${esc(text)}</span></span>`;

// Icons live in src/icons.js: 16×16 one-bit bitmaps in the early-Macintosh style.

// Sidebar: an outline of folders, each with its panes underneath.
const NAV = [
  ['Inbox', [['/', 'overview', 'Overview'], ['/review', 'review', 'Review'], ['/manual', 'manual', 'Manual']]],
  ['Outreach', [['/sent', 'sent', 'Sent'], ['/vendors', 'vendors', 'Vendors']]],
  ['System', [['/scraped', 'scraped', 'Postings'], ['/logs', 'logs', 'Log'], ['/health', 'health', 'Status']]],
];
// Desk shortcuts beside the window (shown on wide screens only). They repeat sidebar links, so they are
// hidden from assistive technology and the tab order.
const DESK = {
  left: [['/review', 'review', 'Review'], ['/manual', 'manual', 'Manual'], ['/sent', 'sent', 'Sent']],
  right: [['/scraped', 'scraped', 'Postings'], ['/logs', 'logs', 'Log']],
};
const TITLES = { overview: 'Overview', review: 'Review', manual: 'Manual', sent: 'Sent', vendors: 'Vendors', scraped: 'Postings', logs: 'Log', health: 'Status', search: 'Search' };
// The card at the top of a pane: icon, title, one line of description.
export function hero(key, title, text) {
  return `<div class="hero"><div class="hero-icon${key === 'overview' ? ' accent' : ''}">${icon(key, 'x2')}</div><h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}</div>`;
}

export function layout(active, body, { searchText = '', script = '', split = false } = {}) {
  const c = counts();
  const q = c.q;
  const watcherPaused = getState('watcher_paused', '0') === '1';
  const rm = rematchStatus();
  const key = active || (searchText ? 'search' : '');
  const badge = { review: c.newPostings + c.waiting + c.fix, manual: c.manual };
  const nav = NAV.map(([head, items]) => `<div class="sb-head">${icon('folder')}<span>${head}</span></div>
   <nav class="sb-group" aria-label="${head}">${items.map(([href, k, label]) =>
    `<a class="sb-item${key === k ? ' on' : ''}" href="${href}"${key === k ? ' aria-current="page"' : ''}>${icon(k)}<span>${label}</span>${badge[k] ? `<b>${badge[k]}</b>` : ''}</a>`).join('')}</nav>`).join('\n   ');
  const desk = (side) => `<div class="desk ${side}" aria-hidden="true">${DESK[side].map(([href, k, label]) =>
    `<a class="dicon${key === k ? ' on' : ''}" href="${href}" tabindex="-1">${icon(side === 'left' ? k : 'folder', 'x2')}<span class="name">${label}</span></a>`).join('')}</div>`;
  const status = `${watcherPaused ? 'Watcher paused' : 'Watching nvoids'} · ${q.paused ? 'sending paused' : q.dryRun ? 'dry run' : 'sending on'}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<script>try { if (localStorage.getItem('rv-theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch { /* storage blocked: light */ }</script>
<title>${TITLES[key] ? `${TITLES[key]} · ` : ''}Runevoid</title>
<link rel="preload" href="/static/fonts/archivo-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${ASSETS.css}">
<link rel="icon" type="image/svg+xml" href="${ASSETS.favicon}">
<link rel="icon" type="image/png" sizes="32x32" href="${ASSETS.favicon32}">
<link rel="apple-touch-icon" href="${ASSETS.touchIcon}">
<script type="speculationrules">{"prefetch":[{"where":{"selector_matches":".sb-item, .dicon, .sb-profile, .seg a, .chips a"},"eagerness":"moderate"}]}</script>
</head>
<body data-next-at="${q.paused || q.dryRun ? 0 : (q.nextAt ?? 0)}" data-pending="${c.newPostings + c.waiting + c.fix}">
${desk('left')}
${desk('right')}
<div class="window">
 <header class="wbar">
  <span class="lights" aria-hidden="true"><i></i><i></i><i></i></span>
  <h1>Runevoid</h1>
  <div class="wbar-tools">
   <button type="button" class="tool" data-theme-toggle aria-pressed="false" aria-label="Dark theme" title="Switch to dark theme"><span class="on">${icon('moon')}</span><span class="off">${icon('sun')}</span></button>
   <button type="button" class="tool" data-sound-toggle aria-pressed="true" aria-label="Sounds" title="Turn sounds off"><span class="on">${icon('soundOn')}</span><span class="off">${icon('soundOff')}</span></button>
  </div>
 </header>
 <div class="wbody">
  <aside class="sidebar">
   <form class="sb-search" action="/search" method="get" role="search">${icon('search')}<input type="search" name="q" value="${esc(searchText)}" placeholder="Search" aria-label="Search emails, names, phones, companies, job numbers"><button type="submit" class="sr-only">Search</button></form>
   <div class="sb-scroll">
    <a class="sb-profile" href="/health"><span class="avatar" aria-hidden="true">R</span><span><b>Runevoid</b><small>${esc(status)}</small></span></a>
    ${nav}
   </div>
  </aside>
  <main class="content">
   <div class="toolbar">
    <div class="tb-title" id="tb-title">${TITLES[key] ?? ''}</div>
    <div class="tb-right">
     ${rm.running ? `<span data-rm-text>${rm.stopping ? 'Stopping…' : 'Re-matching…'} ${rm.done}/${rm.total}</span><button type="button" class="small" data-rm-stop onclick="stopRematch(this)">Stop</button>` : ''}
     ${q.dryRun ? '<span class="tag soft" title="DRY_RUN=true in .env: nothing is really sent">Dry run</span>' : ''}
     ${q.queued ? `<span>${q.paused ? 'Sending paused' : 'Next send'} <b data-countdown data-idle="${q.paused ? '' : 'at cap'}">—</b></span>` : ''}
     <span id="scan-msg" class="scan-msg" role="status"></span>
     <button type="button" class="small scan" onclick="pollNow(this)" title="Check nvoids for new postings now">${icon('refresh')}${twoLabel('Scan Now', 'Scanning…')}</button>
    </div>
   </div>
   ${split ? `<div class="stack" id="stack">${body}</div>` : `<div class="scroller"><div class="pagewrap${key === 'scraped' || key === 'logs' || key === 'search' ? ' wide' : ''}">${body}</div></div>`}
  </main>
 </div>
</div>
<script src="${APP_JS_URL}" data-key-down="${ASSETS.keyDown}" data-key-up="${ASSETS.keyUp}"></script>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

export function freshItems(manual, after) {
  const rows = reviewRows(manual).filter(r => r.id > after && r.status === 'draft').reverse().slice(-50);
  return rows.map(r => { const kind = !manual && isPriority(r) ? 'hot' : 'std'; return { id: r.id, kind, html: itemHtml(r, kind) } });
}

function itemHtml(r, kind) {
  const who = r.company || r.recruiter_name || r.to_email;
  const s = `${r.title} ${r.company ?? ''} ${r.recruiter_name ?? ''} ${r.to_email} folder ${r.resume_folder} #${r.job_id}`.toLowerCase();
  const tag = r.status === 'held' ? 'Held' : r.status === 'failed' ? 'Failed' : '';
  const posted = r.posted_utc ? Date.parse(r.posted_utc) || 0 : 0;
  const match = r.best_match_score ?? r.match_score;
  const resumeInfo = r.best_resume_folder && r.best_resume_folder !== r.resume_folder
    ? `Best: ${r.best_resume_folder} · selected: ${r.resume_folder} (${r.match_score ?? '?'}%)` : `Resume: ${r.resume_folder}`;
  return `<div class="item ${kind}" data-id="${r.id}" data-job="${r.job_id}" data-posted="${posted}" data-match="${match ?? ''}" data-s="${esc(s)}" tabindex="0" title="${esc(resumeInfo)}">
<input type="checkbox" aria-label="Select">
<div><div class="it-title">${esc(r.title)}</div><div class="it-sub">${tag ? `<span class="tagline">${tag}</span> · ` : ''}${esc(who)} · ${age(r)}</div></div>
<div class="it-score">${match ?? '–'}%</div></div>`;
}

const LIST_LIMIT = 250;   // drafts rendered per group; 1000+ made the page heavy and slow to scroll
export function reviewPage(manual) {
  const rows = reviewRows(manual);
  const k = reviewKinds(rows);
  const group = (cls, label, list, kind) => `<div class="group ${cls}">${label}<b>${list.length}</b></div>${list.slice(0, LIST_LIMIT).map(r => itemHtml(r, kind)).join('')}${list.length > LIST_LIMIT ? `<div class="foot">Showing the newest ${LIST_LIMIT} of ${list.length}. Search to find older ones.</div>` : ''}`;
  const rm = rematchStatus();
  const total = rows.length;
  const root = `<div class="view-root">
 <div class="pagewrap">
 ${manual ? addJdForm() : hero('review', 'Review', total ? `${total} draft${total === 1 ? '' : 's'} waiting. Open one to check the email, then approve or skip it.` : 'New AI/ML postings appear here as Runevoid finds them.')}
 <div class="listtools"${total ? '' : ' style="display:none"'}>
  <div class="filterbar"><input id="filter" type="search" placeholder="Filter" aria-label="Filter drafts (press /)"><span class="sp"></span>
   <button type="button" class="small" onclick="toggleSelect(this)">${twoLabel('Select', 'Cancel')}</button>
   ${total ? `<button type="button" class="small" ${rm.running ? 'disabled' : ''} onclick="simple('/api/rematch-all',{source:'${manual ? 'manual' : 'nvoids'}'},this,'Re-score all ${total} drafts against your current resumes? Unedited drafts switch to the best resume.')">Re-match All</button>` : ''}</div>
  <div class="bulk" id="bulk"><span><b id="bulk-n">0</b> selected</span><span class="sp"></span><button type="button" class="small" onclick="selectAllShown(true)">Select All</button><button type="button" class="small" onclick="bulk('rematch',this)">${twoLabel('Re-match', 'Re-matching…')}</button><button type="button" class="small" onclick="bulk('skip',this)">${twoLabel('Skip', 'Skipping…')}</button><button type="button" class="small plain" onclick="selectAllShown(false)">Done</button></div>
  ${rm.running ? `<div class="rm-row"><span data-rm-text>${rm.stopping ? 'Stopping…' : 'Re-matching…'} ${rm.done}/${rm.total}</span><button type="button" class="small danger" data-rm-stop onclick="stopRematch(this)">Stop</button><a href="" data-rm-done style="display:none" onclick="location.reload();return false">Refresh</a></div>` : ''}
 </div>
 <div class="list" id="list" data-manual="${manual ? 1 : 0}" data-prio-ms="${config.priorityWindowMinutes * 60_000}">
  ${manual ? '' : group('hot', 'New in the last ' + config.priorityWindowMinutes + ' minutes', k.prio, 'hot')}
  ${group('fix', 'Needs attention', k.fix, 'fix')}
  ${group('', manual ? 'Your drafts' : 'Ready to review', k.std, 'std')}
 </div>
 ${total ? '<p class="foot" style="text-align:center;margin-top:12px"><kbd>j</kbd> <kbd>k</kbd> next and previous · <kbd>a</kbd> approve · <kbd>s</kbd> skip · <kbd>r</kbd> re-match · <kbd>esc</kbd> back</p>' : ''}
 </div>
</div>`;
  return root + `<section class="pane" id="pane"></section>`;
}

export const REVIEW_SCRIPT = REVIEW_JS;

function addJdForm() {
  return `${hero('manual', 'Manual', 'Paste a job description from anywhere. Runevoid reads the recruiter, role and location, picks your best resume and writes the email.')}
<div class="section">Job description</div>
<div class="grp text"><textarea id="m_jd" style="min-height:200px" placeholder="Paste the whole posting, including the recruiter’s signature and email"></textarea></div>
<div class="section">Details <span class="aside">Optional</span></div>
<div class="grp">
 <div class="row"><label for="m_to">Recruiter email</label><input id="m_to" type="email" placeholder="Read from the JD"></div>
 <div class="row"><label for="m_title">Role</label><input type="text" id="m_title" placeholder="Read from the JD"></div>
 <div class="row"><label for="m_loc">Location</label><input type="text" id="m_loc" placeholder="Read from the JD"></div>
</div>
<div class="dupwarn" id="m_dup" role="alert" hidden><div class="dw-head"></div><div class="dw-detail"></div><div class="dw-btns"></div></div>
<div class="btnrow" style="align-items:flex-start"><span class="msg meta" id="m_msg" style="flex:1;min-width:0;white-space:normal"></span><span class="sp"></span><button type="button" class="primary" onclick="addJd(this)">Create Draft</button></div>
<p class="foot">Rules that would skip an nvoids posting (W2-only, low match) show as warnings instead, since you chose this job.</p>
<script>
async function addJd(b, mode, folder){
  const msg = document.getElementById('m_msg'), dup = document.getElementById('m_dup');
  const busy = [b, ...dup.querySelectorAll('button')];
  busy.forEach(x => x.disabled = true); msg.textContent = 'Matching resumes…';
  const j = await post('/api/manual', { jd_text: document.getElementById('m_jd').value, to_email: document.getElementById('m_to').value,
                                        title: document.getElementById('m_title').value, location: document.getElementById('m_loc').value,
                                        replace: mode === 'replace', force: mode === 'force' || mode === 'send' });
  busy.forEach(x => x.disabled = false);
  if (j.ok && !j.duplicate) {
    if (mode !== 'send') { location.href = '/manual?open=' + j.app_id; return }
    msg.textContent = 'Queuing…';
    const a = await post('/api/approve/' + j.app_id, folder ? { resume_folder: folder } : {});
    if (a.ok) { location.href = '/sent'; return }
    await rvAlert('Draft #' + j.id + ' was created but could not be queued: ' + (a.error || 'failed') + '. Opening it so you can fix it.');
    location.href = '/manual?open=' + j.app_id; return;
  }
  dup.hidden = true; msg.textContent = '';
  if (!j.duplicate) { msg.innerHTML = '<span class="err"></span>'; msg.querySelector('.err').textContent = j.error || 'Failed'; return }
  // Duplicate: a loud warning, but every option stays open. You decide.
  dup.querySelector('.dw-head').textContent = j.headline;
  dup.querySelector('.dw-detail').textContent = j.error;
  const btns = dup.querySelector('.dw-btns'); btns.replaceChildren();
  const mk = (label, cls, title, fn) => { const x = document.createElement('button'); x.type = 'button'; x.className = cls; x.textContent = label; x.title = title; x.onclick = fn; btns.append(x); return x };
  mk('Create Draft Anyway', '', 'Add this JD as a new follow-up draft (#' + j.prior_id + ' is kept). You review it before it goes out.', () => addJd(b, 'force'));
  mk('Send Anyway', 'primary', 'Add it and queue the email now, without opening the draft', async (e) => {
    if (await rvConfirm('Email this recruiter again for #' + j.prior_id + ' “' + j.prior_title + '”' + (j.sent_at ? ' (last sent ' + j.sent_at + ')' : '') + '? It is queued right away.', { ok: 'Send' })) addJd(b, 'send');
  });
  if (j.prior_resume) mk('Send Same Resume (' + j.prior_resume + ')', '', 'Queue it now with exactly the resume they already got from you', async () => {
    if (await rvConfirm('Email this recruiter again with the same resume (' + j.prior_resume + ') they got' + (j.sent_at ? ' on ' + j.sent_at : '') + '? It is queued right away.', { ok: 'Send' })) addJd(b, 'send', j.prior_resume);
  });
  if (j.replaceable) mk('Replace and Add', '', 'Cancel #' + j.prior_id + ' and add this JD instead, matched against your current resumes', async () => {
    if (await rvConfirm('Cancel #' + j.prior_id + ' and use this JD instead? It becomes a new draft for you to approve.', { ok: 'Replace' })) addJd(b, 'replace');
  });
  dup.hidden = false; dup.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
document.getElementById('m_jd').addEventListener('input', () => { document.getElementById('m_dup').hidden = true });
</script>`;
}

// "d 110 × Base 72 × multi-stack 1.4 × Res 0.25 (Java resume on an AI job) = 28"
function formulaLine(r) {
  const f = r.formula;
  if (!f) return '';
  const bits = [`d ${f.d}`, `Base ${f.base}`];
  if (f.dmgType !== 1) bits.push(`multi-stack ×${f.dmgType} (${f.clusters.join(' + ')})`);
  if (f.crit !== 1) bits.push(`custom ×${f.crit}`);
  if (f.res !== 1) bits.push(`wrong-lane ×${f.res} (R ${f.R}%${f.family ? `, ${f.family} resume` : ''})`);
  if (f.def !== 1) bits.push(`seniority ×${f.def}`);
  return `<span title="final = (d/100) × Base × DmgType × Crit × Res × Def — settings in resume-lanes.json">Score: ${esc(bits.join(' × '))} = <b>${r.score}</b></span><br>`;
}

// The draft shown in the work area (fetched by the list via /api/card/:id).
export function draftView(app, job) {
  const priority = app.status === 'draft' && job.source !== 'manual' && isPriority({ posted_utc: job.posted_utc });
  const ranked = JSON.parse(app.ranking_json || '[]');
  const chosen = ranked.find(r => r.folder === app.resume_folder) ?? ranked[0] ?? { matched: [], missing: [] };
  const lock = lockFor(app.to_email);
  const held = app.status === 'held';
  const opts = ranked.map(r => `<option value="${esc(r.folder)}" ${r.folder === app.resume_folder ? 'selected' : ''} ${lock && r.folder !== lock.resume_folder ? 'disabled' : ''}>${esc(r.name ?? resumeLabel(r.folder))} (${r.score}%${r === ranked[0] ? ', best' : ''}${lock && r.folder === lock.resume_folder ? ', locked' : ''})</option>`).join('');
  const holdButtons = {
    same_day: [['tomorrow', 'Send Tomorrow'], ['use_today', `Use Same Resume`], ['send_anyway_today', 'Send Anyway']],
    lock_edited: [['use_lock', 'Switch to Locked Resume']], lock_missing: [['retry', 'Retry']], job_details: [['to_draft', 'Edit the Email']],
    lock_low_fit: [['retry', 'Retry']], repost: app.todays_folder ? [['send_same_resume', `Send Same Resume (${app.todays_folder})`], ['send_anyway', `Send Anyway (${app.resume_folder})`]] : [['send_anyway', 'Send Anyway']], weekly_cap: [['next_week', 'Send Next Week']],
    dry_run: [['retry', 'Queue Again']], blacklist: [], same_jd_edited: [['to_draft', 'Back to Draft']],
  }[app.hold_kind] ?? [['retry', 'Retry']];
  const dis = held ? 'disabled' : '';
  const warnings = draftWarnings(app, job);
  const matched = chosen.matched ?? [], missing = chosen.missing ?? [];
  const cc = app.cc_emails ?? ccFor(app.to_email).join(', ');
  const edited = app.body !== app.auto_body;
  // Match details for EVERY resume, so switching the Resume menu updates them instantly (no reload, no request).
  const kwHtml = (r) => `${r.why ? `<i>${esc(r.why)}</i><br>` : ''}${formulaLine(r)}In this resume: ${(r.matched ?? []).map(k => `<span class="m">${esc(k)}</span>`).join('') || '–'}${r.related?.length ? `<br>Partial credit: ${r.related.map(esc).join(', ')}` : ''}<br>
   Not found: ${(r.missing ?? []).map(k => `<span>${esc(k)}</span>`).join('') || '–'}`;
  const kwData = Object.fromEntries(ranked.map(r => [r.folder, { html: kwHtml(r), found: (r.matched ?? []).length, missing: (r.missing ?? []).length, score: r.score }]));
  const skip = `<button type="button" data-act="skip" onclick="cardAction('/api/skip/${app.id}',${app.id},this,'Skipped','Skip this job?')" title="Skip (s)">Skip</button>`;
  const actions = held
    ? [skip, '<span class="msg"></span><span class="sp"></span>', ...holdButtons.map(([d, label], i, all) => `<button type="button" class="${i === all.length - 1 ? 'primary' : ''}" onclick="holdAction(${app.id},'${d}',this)">${esc(label)}</button>`)]
    : [skip, `<button type="button" data-act="rematch" onclick="cardAction('/api/rematch/${app.id}',${app.id},this,'')" title="Re-match (r)">Re-match</button>`,
       '<span class="msg"></span><span class="sp"></span>', `<button type="button" class="primary" data-act="approve" onclick="approveCard(${app.id},this)" title="Approve and queue (a)">Approve</button>`];
  return `<div class="draft" id="app-${app.id}">
<div class="draft-body"><div class="pagewrap">
 <div class="draft-head">
  <div class="kicker">${priority ? '<span class="tag accent">New</span>' : ''}<span class="kw-score">${app.match_score ?? chosen.score ?? '–'}% match</span></div>
  <h3>${jobTitle(job)}</h3>
  <div class="meta">${jobLine(job)}</div>
  ${held ? `<div class="callout"><div><b>Held.</b> ${esc(app.hold_reason)}</div></div>` : ''}
  ${app.status === 'failed' ? `<div class="callout"><div><b>Last send failed.</b> ${esc(app.error)}</div></div>` : ''}
 </div>
 ${warnings.length ? `<div class="section">${warnings.length === 1 ? 'Warning' : `${warnings.length} warnings`}</div><div class="grp">${warnings.map(w => `<div class="row warn-row"><span class="dot"></span><span class="lbl wrap"><span>${esc(w)}</span></span></div>`).join('')}</div>` : ''}
 <div class="section">Email</div>
 <div class="grp">
  <div class="row"><label>Resume</label><span class="sp" style="flex:1"></span><span class="popup"><select name="resume_folder">${opts}</select></span></div>
  <div class="row"><label>To</label><input name="to_email" type="email" value="${esc(app.to_email)}" ${dis}></div>
  ${phoneRow(job)}
  <div class="row"><label>Cc</label><input name="cc_emails" type="email" multiple value="${esc(cc)}" placeholder="None" ${dis}></div>
  <div class="row"><label>Subject</label><input type="text" name="subject" value="${esc(app.subject)}" ${dis}></div>
 </div>
 <div class="section">Message${edited ? '<span class="aside">Edited by you</span>' : ''}</div>
 <div class="grp text"><textarea name="body" ${dis}>${esc(app.body)}</textarea></div>
 <div class="grp" style="margin-top:20px">
  <details class="disc"><summary class="row"><span class="lbl"><span>Match details</span></span><span class="val kw-count">${matched.length} found, ${missing.length} missing</span><span class="chev"></span></summary>
   <div class="disc-body kw">${kwHtml(chosen)}</div></details>
  <script type="application/json" class="kw-data">${JSON.stringify(kwData).replace(/</g, '\\u003c')}</script>
  <details class="disc jd" open><summary class="row"><span class="lbl"><span>Job description</span></span><span class="chev"></span></summary><div class="disc-body"><pre>${esc(job.jd_text)}</pre></div></details>
 </div>
</div></div>
<div class="draft-actions">${actions.join('')}</div></div>`;
}

// Which file an email carried, and how sure we are it is the same bytes:
//   exact   — the copy saved at send time (sends from Nov 24 2026 on)
//   same    — the original, not modified since the send
//   changed — the original, edited after the send: what you open is the newer version
//   pending — not sent yet: this is the file it will attach
//   missing — no file on disk any more
export function attachmentOf(app) {
  if (app.sent_resume && existsSync(app.sent_resume)) return { path: app.sent_resume, state: 'exact' };
  if (!app.resume_path || !existsSync(app.resume_path)) return { path: app.resume_path ?? '', state: 'missing' };
  if (app.status !== 'sent' || !app.sent_at) return { path: app.resume_path, state: 'pending' };
  const sentMs = new Date(app.sent_at.replace(' ', 'T')).getTime();   // sent_at is local wall-clock time
  return { path: app.resume_path, state: statSync(app.resume_path).mtimeMs > sentMs + 1000 ? 'changed' : 'same' };
}

// The attached resume, read in place. mammoth's HTML is from your own file, but links are still limited to web and
// mail addresses so nothing in a document can run script on the dashboard.
export function resumePreview(app, att, html) {
  const safe = String(html).replace(/\s(href|src)="([^"]*)"/gi, (m, k, v) => (k.toLowerCase() === 'src' ? /^data:image\//i.test(v) : /^(https?:|mailto:)/i.test(v)) ? m : '');
  const name = att.path.split('/').pop();
  const note = { exact: 'The exact file attached to this email.', same: 'Unchanged since this email was sent.',
    changed: 'This file was edited after the email was sent, so this is the newer version, not the one the recruiter got.',
    pending: 'The file this email will attach.' }[att.state] ?? '';
  return `<div class="filterbar"><a class="quiet" href="/app/${app.id}">‹ Back to the email</a><span class="sp"></span><a class="small btnlink" href="/app/${app.id}/attachment/file" download>Download</a></div>
<div class="draft-head"><div class="kicker"><span class="tag${att.state === 'changed' ? ' accent' : ''}">Attachment</span><span>${esc(name)}</span></div>
 <div class="meta">${esc(note)}</div></div>
<div class="grp"><div class="resume-doc">${safe}</div></div>`;
}

// Read-only view of a sent / queued / skipped email: exactly what went out (search results open these).
export function emailView(app, job, { q = '' } = {}) {
  const when = [app.sent_at && `Sent ${esc(app.sent_at)}`, app.approved_at && `approved ${esc(app.approved_at)}`].filter(Boolean).join(' · ');
  const st = app.status[0].toUpperCase() + app.status.slice(1);
  const sent = app.status === 'sent';
  const from = config.senderName ? `${config.senderName} <${config.gmailUser}>` : config.gmailUser;
  // CC: what really went out if recorded; otherwise what this email is set to use.
  let cc, ccNote = '';
  // (A per-email CC list is exactly what a send used, so it stands in when sent_cc wasn't recorded.)
  if (app.sent_cc !== null && app.sent_cc !== undefined) cc = app.sent_cc.split(',').filter(Boolean);
  else if (app.cc_emails !== null && app.cc_emails !== undefined) cc = app.cc_emails.split(',').filter(Boolean);
  else if (sent) { cc = null; ccNote = 'Not recorded for this send'; }
  else { cc = ccFor(app.to_email); ccNote = cc.length ? 'your CC list' : ''; }
  const ccVal = cc === null ? `<span class="val">${ccNote}</span>`
    : `<span class="val">${cc.length ? esc(cc.join(', ')) : 'None'}${ccNote && cc.length ? ` <span class="meta">(${ccNote})</span>` : ''}</span>`;
  const att = attachmentOf(app);
  const name = att.path ? att.path.split('/').pop() : '';
  const attNote = {
    exact: 'the exact file that was attached',
    same: 'unchanged since it was sent',
    changed: `edited after this was sent: opening it shows the newer version`,
    pending: 'will be attached',
    missing: 'file no longer on disk',
  }[att.state];
  const attLinks = att.state === 'missing' ? '' : `<a class="small btnlink" href="/app/${app.id}/attachment">Open</a><a class="small btnlink" href="/app/${app.id}/attachment/file" download>Download</a>`;
  const back = `/sent${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  return `<div class="filterbar"><a class="quiet" href="${esc(back)}">‹ ${q ? `Results for “${esc(q)}”` : 'Sent'}</a></div>
<div class="draft-head">
 <div class="kicker"><span class="tag ${app.status === 'failed' ? 'accent' : ''}">${esc(st)}</span>${when ? `<span>${when}</span>` : ''}</div>
 <h3>${jobTitle(job)}</h3>
 <div class="meta">${jobLine(job)}</div>
 ${app.error ? `<div class="callout"><div>${esc(app.error)}</div></div>` : ''}
</div>
<div class="section">Email</div>
<div class="grp">
 <div class="row"><span class="lbl"><span>From</span></span><span class="val">${esc(from)}</span></div>
 <div class="row"><span class="lbl"><span>To</span></span><span class="val">${esc(job.recruiter_name ? `${job.recruiter_name} <${app.to_email}>` : app.to_email)}</span></div>
 ${phoneRow(job)}
 <div class="row"><span class="lbl"><span>Cc</span></span>${ccVal}</div>
 <div class="row"><span class="lbl"><span>Subject</span></span><span class="val ink" style="white-space:normal;text-align:right;max-width:70%">${esc(app.subject.replace(/\*\*/g, ''))}</span></div>
 <div class="row tall"><span class="lbl"><span>Attachment</span><span class="sub one${att.state === 'changed' || att.state === 'missing' ? ' bad' : ''}">${esc(name || '—')} · ${attNote}</span></span>${attLinks}</div>
 <div class="row"><span class="lbl"><span>Resume</span></span><span class="val">${esc(resumeLabel(app.resume_folder))} · ${app.match_score ?? '?'}%${app.locked ? ' · locked' : ''}</span></div>
</div>
<div class="section">Message</div>
<div class="grp text"><pre>${sentBodyHtml(app.body)}</pre></div>
${app.auto_body && app.auto_body !== app.body ? `<p class="foot">You edited this message before it was sent.</p>` : ''}
<div class="grp" style="margin-top:20px"><details class="disc"><summary class="row"><span class="lbl"><span>Job description</span></span><span class="chev"></span></summary><div class="disc-body"><pre>${esc(job.jd_text)}</pre></div></details></div>
${app.message_id ? `<p class="foot">Message-ID ${esc(app.message_id)}</p>` : ''}
${app.status === 'queued' ? `<div class="btnrow"><button type="button" onclick="simple('/api/cancel/${app.id}',{},this)">Pull Back from Queue</button></div>` : ''}`;
}

// ── Overview ──────────────────────────────────────────────────────────────────

export function overviewPage() {
  const c = counts();
  const queue = queuedInOrder();
  const jobs = new Map(db.prepare(`SELECT id, title, company, recruiter_name, source, url FROM jobs WHERE id IN (${queue.map(r => r.job_id).join(',') || 0})`).all().map(j => [j.id, j]));
  const nextApp = queue[0];
  const t0 = ymd(new Date());
  const today = {
    scraped: n(`SELECT COUNT(*) n FROM jobs WHERE scraped_at >= ? AND source IS NOT 'manual'`, t0),
    drafted: n(`SELECT COUNT(*) n FROM applications WHERE created_at >= ?`, t0),
    expired: n(`SELECT COUNT(*) n FROM applications WHERE status = 'expired' AND updated_at >= ?`, t0),
    skipped: n(`SELECT COUNT(*) n FROM applications WHERE status = 'skipped' AND updated_at >= ?`, t0),
  };
  const capTomorrow = dailyCap(new Date(Date.now() + 86_400_000));
  const lastPoll = getState('last_poll_at', 'never'), pollOk = getState('last_poll_ok', '1') === '1';
  const watcherPaused = getState('watcher_paused', '0') === '1';
  const toReview = c.newPostings + c.waiting + c.fix;
  const editor = nextApp ? `<div id="q-editor">
 <div class="section">Before it sends <span class="aside" id="q-title">${esc(jobs.get(nextApp.job_id)?.title ?? '')}</span></div>
 <div class="grp">
  <div class="row"><label>To</label><input id="q-to" type="email" value="${esc(nextApp.to_email)}"></div>
  <div class="row"><label>Cc</label><input id="q-cc" type="email" multiple value="${esc(nextApp.cc_emails ?? ccFor(nextApp.to_email).join(', '))}" placeholder="None"></div>
  <div class="row"><label>Subject</label><input type="text" id="q-subject" value="${esc(nextApp.subject)}"></div>
 </div>
 <div class="grp text"><textarea id="q-body" style="min-height:200px">${esc(nextApp.body)}</textarea></div>
 <div class="btnrow"><button type="button" onclick="simple('/api/cancel/'+QID,{},this,'Pull this email back to drafts?')">Pull Back</button><span class="meta" id="q-msg"></span><span class="sp"></span><button type="button" class="primary" onclick="saveQueued(this)">Save</button></div>
 <input type="hidden" id="q-id" value="${nextApp.id}"></div>` : '';
  const upNext = queue.slice(0, 40).map((r, i) => {
    const j = jobs.get(r.job_id) ?? {};
    return `<div class="row click" onclick="loadQueued(${r.id})"><span class="val" style="width:18px;text-align:right">${i + 1}</span><span class="lbl"><span>${r.priority ? '<span class="tag accent" style="margin-right:6px">New</span>' : ''}${esc(j.title ?? '')}</span><span class="sub one">${esc(r.to_email)} · ${esc(resumeLabel(r.resume_folder))}</span></span><span class="chev"></span></div>`;
  }).join('');
  const alerts = [
    c.failed ? ['/review', '', `${c.failed} failed send${c.failed > 1 ? 's' : ''}`] : null,
    c.held ? ['/review', 'ring', `${c.held} held by a vendor rule`] : null,
    c.newPostings ? ['/review', '', `${c.newPostings} new posting${c.newPostings > 1 ? 's' : ''} to review`] : null,
    !emailConfigured() ? ['/health', '', 'Gmail isn’t connected'] : null,
    !pollOk ? ['/logs', '', 'The last nvoids check failed'] : null,
    c.q.dryRun ? ['/health', 'ring', 'Dry run is on, so nothing is really sent'] : null,
  ].filter(Boolean);
  const page = `${hero('overview', 'Runevoid', 'Watches nvoids for AI/ML roles, drafts an email with your best resume, and sends only what you approve.')}
${alerts.length ? `<div class="grp">${alerts.map(([href, cls, t]) => `<a class="row" href="${href}"><span class="dot ${cls}"></span><span class="lbl"><span>${t}</span></span><span class="chev"></span></a>`).join('')}</div>` : ''}
<div class="section">Controls</div>
<div class="grp">
 <div class="row"><span class="lbl"><span>Send approved emails</span><span class="sub">${c.q.paused ? 'Paused. Approved emails wait in the queue.' : 'One at a time, paced like a person.'}</span></span>
  <label class="switch"><input type="checkbox" ${c.q.paused ? '' : 'checked'} onchange="flip(this,'/api/pause-sending',{on:!this.checked})" aria-label="Send approved emails"><span></span></label></div>
 <div class="row"><span class="lbl"><span>Watch nvoids</span><span class="sub">${watcherPaused ? 'Paused. No new postings are read.' : `Checks every ${config.pollSeconds} seconds.`}</span></span>
  <label class="switch"><input type="checkbox" ${watcherPaused ? '' : 'checked'} onchange="flip(this,'/api/pause-watcher',{on:!this.checked})" aria-label="Watch nvoids"><span></span></label></div>
 <div class="row"><span class="lbl"><span>Scan for new postings</span><span class="sub">Last scan ${esc(String(lastPoll).slice(11, 16) || '–')}${pollOk ? '' : ', failed'}</span></span><button type="button" onclick="pollNow(this)"><span>Scan Now</span></button></div>
 <div class="row"><span class="lbl"><span>Test email</span><span class="sub">Sends a sample to your own address.</span></span><button type="button" onclick="testSend(this)">Send Test…</button></div>
</div>
<div class="section">Today</div>
<div class="grp">
 <div class="row"><span class="lbl"><span>Next send</span></span><span class="val ink" data-countdown data-idle="${c.q.queued ? (c.q.paused ? 'Paused' : 'Waiting') : 'Nothing queued'}">–</span></div>
 <a class="row" href="/sent"><span class="lbl"><span>Sent today</span></span><span class="val">${c.q.dailyCapSentToday} of ${c.q.cap}</span><span class="chev"></span></a>
 <a class="row" href="/sent"><span class="lbl"><span>This week</span></span><span class="val">${c.week} · ${c.total} all time</span><span class="chev"></span></a>
 <a class="row" href="/review"><span class="lbl"><span>Waiting for review</span></span><span class="val">${toReview}</span><span class="chev"></span></a>
 <a class="row" href="/scraped"><span class="lbl"><span>Postings read</span></span><span class="val">${today.scraped} read · ${today.drafted} drafted · ${today.skipped} skipped</span><span class="chev"></span></a>
</div>
<div class="section">Up next <span class="aside">${queue.length} queued</span></div>
<div class="grp">${upNext || '<div class="empty-row">Nothing queued. Approved drafts wait here before they go out.</div>'}</div>
${editor}
<p class="foot">Emails still queued at midnight expire unsent. Tomorrow’s cap is ${capTomorrow}.</p>
<script>
let QID = Number(document.getElementById('q-id')?.value || 0);
async function loadQueued(id){
  const r = await (await fetch('/api/queued/' + id)).json(); if (!r.ok) { rvAlert(r.error); return }
  QID = id; document.getElementById('q-title').textContent = r.title + ' · ' + r.resume_folder;
  document.getElementById('q-to').value = r.to_email; document.getElementById('q-cc').value = r.cc_emails; document.getElementById('q-subject').value = r.subject; document.getElementById('q-body').value = r.body; document.getElementById('q-body').dispatchEvent(new Event('input'));
  document.getElementById('q-msg').textContent = '';
}
async function saveQueued(b){
  b.disabled = true;
  const j = await post('/api/edit-queued/' + QID, { to_email: document.getElementById('q-to').value, cc_emails: document.getElementById('q-cc').value, subject: document.getElementById('q-subject').value, body: document.getElementById('q-body').value });
  b.disabled = false; const m = document.getElementById('q-msg');
  m.textContent = j.ok ? 'Saved — still in line.' : j.error; m.className = j.ok ? 'meta ok' : 'meta err';
}
</script>`;
  return page;
}

// ── Sent history ──────────────────────────────────────────────────────────────

// Sent: every email that left (or was dropped), searchable by anything in it — recruiter, address, CC, company,
// title, subject, the message you wrote, location and the JD. All words must match. Typing refreshes the list
// in place; the query stays in the address bar, so Back from an opened email returns to the same results.
const SENT_FIELDS = `lower(coalesce(j.title,'') || ' ' || coalesce(j.recruiter_name,'') || ' ' || coalesce(j.recruiter_email,'') || ' ' ||
  coalesce(j.company,'') || ' ' || coalesce(j.location_jd,'') || ' ' || coalesce(j.location_listed,'') || ' ' || coalesce(j.ref_id,'') || ' ' ||
  coalesce(a.to_email,'') || ' ' || coalesce(a.sent_cc, a.cc_emails, '') || ' ' || coalesce(a.subject,'') || ' ' || coalesce(a.body,'') || ' ' ||
  coalesce(a.resume_path,'') || ' ' || coalesce(j.jd_text,''))`;
const likeTerm = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

// "…words around the first hit…" with every typed word in bold. Body first (that is what you wrote), then the JD.
function sentSnippet(r, terms) {
  for (const [where, text] of [['', r.subject], ['', r.body], ['JD: ', r.jd_text], ['', r.company]]) {
    const t = String(text ?? '').replace(/\*\*/g, '').replace(/\s+/g, ' ');
    const low = t.toLowerCase();
    const hit = terms.find(w => low.includes(w));
    if (!hit) continue;
    const at = low.indexOf(hit), from = Math.max(0, at - 50), to = Math.min(t.length, at + hit.length + 90);
    const piece = t.slice(from, to);
    const re = new RegExp(terms.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
    let out = '', last = 0;
    for (const m of piece.matchAll(re)) { out += esc(piece.slice(last, m.index)) + `<b>${esc(m[0])}</b>`; last = m.index + m[0].length; }
    return `${where}${from ? '…' : ''}${out}${esc(piece.slice(last))}${to < t.length ? '…' : ''}`;
  }
  return '';
}

export function sentPage({ q = '', rowsOnly = false } = {}) {
  q = String(q).trim().slice(0, 200);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const where = `a.status IN ('sent','failed','skipped','sending','expired')${terms.map(() => ` AND ${SENT_FIELDS} LIKE ? ESCAPE '\\'`).join('')}`;
  // Body and JD only when searching (for the snippet); the plain list stays light.
  const rows = db.prepare(`SELECT a.id, a.to_email, a.resume_folder, a.match_score, a.locked, a.error, a.status, a.sent_at, a.updated_at,
                                  j.title, j.recruiter_name, j.company${terms.length ? ', a.subject, a.body, j.jd_text' : ''}
                           FROM applications a JOIN jobs j ON j.id = a.job_id
                           WHERE ${where} ORDER BY COALESCE(a.sent_at, a.updated_at) DESC LIMIT 2000`).all(...terms.map(likeTerm));
  const total = terms.length ? db.prepare(`SELECT COUNT(*) n FROM applications WHERE status IN ('sent','failed','skipped','sending','expired')`).get().n : rows.length;
  const cap = (x) => x ? x[0].toUpperCase() + x.slice(1) : '';
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const list = rows.map(r => { const snip = terms.length ? sentSnippet(r, terms) : '';
    return `<a class="row tall" href="/app/${r.id}${qs}"><span class="lbl"><span>${esc(r.title ?? '')}</span>
  <span class="sub one">${esc(r.recruiter_name ? `${r.recruiter_name} · ` : '')}${esc(r.to_email)}${r.company ? ` · ${esc(r.company)}` : ''} · ${esc(resumeLabel(r.resume_folder))} ${r.match_score ?? '?'}%${r.locked ? ' · locked' : ''}</span>${snip ? `<span class="sub clamp">${snip}</span>` : ''}${r.error ? `<span class="sub bad">${esc(r.error)}</span>` : ''}</span>
  <span class="val end">${r.status === 'failed' ? `<span class="bad">${cap(r.status)}</span>` : cap(r.status)}<span class="sub">${esc(String(r.sent_at ?? r.updated_at ?? '').slice(0, 16))}</span></span><span class="chev"></span></a>`; }).join('')
    || `<div class="empty-row">${terms.length ? `No email matches “${esc(q)}”.` : 'Nothing has been sent yet.'}</div>`;
  const count = terms.length ? `${rows.length}${rows.length >= 2000 ? '+' : ''} of ${total}` : `${total}`;
  if (rowsOnly) return JSON.stringify({ list, count });
  return `${hero('sent', 'Sent', 'Every email that went out, failed, expired or was skipped. Search anything in it, then open one to see exactly what you sent.')}
<div class="filterbar"><form method="get" action="/sent" style="margin:0" id="st-form"><input type="search" name="q" id="st-q" value="${esc(q)}" placeholder="Search recruiter, company, subject, message, JD…" aria-label="Search sent emails" autocomplete="off"><button type="submit" class="sr-only">Search</button></form>
 <span class="meta" id="st-count">${count}</span><span class="sp"></span><a class="quiet" href="/history">Sent_History.md</a><a class="quiet" href="/export/applications.csv">Export CSV</a></div>
<div class="grp long" id="st">${list}</div>
<script>
(() => {
  const box = document.getElementById('st-q'), list = document.getElementById('st'), count = document.getElementById('st-count');
  let timer = 0, ctl = null;
  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = box.value.trim();
      ctl?.abort(); ctl = new AbortController();
      try {
        const r = await fetch('/sent/rows?q=' + encodeURIComponent(q), { signal: ctl.signal });
        const j = await r.json();
        list.innerHTML = j.list; count.textContent = j.count;
        history.replaceState(null, '', q ? '/sent?q=' + encodeURIComponent(q) : '/sent');
      } catch (e) { if (e.name !== 'AbortError') count.textContent = 'Search failed'; }
    }, 180);
  });
  if (box.value) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
})();
</script>`;
}

// ── Vendors & locks ───────────────────────────────────────────────────────────

export function vendorsPage() {
  const folders = listResumeFiles();
  const locks = db.prepare(`SELECT * FROM vendor_locks ORDER BY domain, local`).all();
  const statuses = new Map(db.prepare(`SELECT * FROM vendor_status`).all().map(s => [s.address, s]));
  const vendors = db.prepare(`SELECT lower(to_email) addr, COUNT(*) sends, MAX(sent_at) last_sent, GROUP_CONCAT(DISTINCT resume_folder) folders
                              FROM applications WHERE status = 'sent' GROUP BY lower(to_email) ORDER BY last_sent DESC LIMIT 1000`).all();
  for (const a of statuses.keys()) if (!vendors.some(v => v.addr === a)) vendors.unshift({ addr: a, sends: 0, last_sent: '', folders: '' });
  vendors.sort((a, b) => Number(statuses.has(b.addr)) - Number(statuses.has(a.addr)));   // vendors with a status first
  const audit = db.prepare(`SELECT * FROM audit ORDER BY id DESC LIMIT 100`).all();
  // One query each instead of one per vendor row (that made this page take seconds).
  const weekly = new Map(db.prepare(`SELECT lower(to_email) addr, COUNT(*) n FROM applications WHERE status = 'sent' AND sent_at >= ? GROUP BY 1`)
    .all(ymd((() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d })())).map(r => [r.addr, r.n]));
  const lockOf = (addr) => { const v = parseVendor(addr); return v ? (locks.find(l => l.domain === v.domain && l.local === v.local) ?? locks.find(l => l.domain === v.domain && l.local === '')) : null };
  const black = db.prepare(`SELECT * FROM vendor_blacklist ORDER BY term`).all();
  const opts = (sel) => `<option value="">— none —</option>` + Object.entries(VENDOR_STATUSES).map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${v}</option>`).join('');
  const withStatus = [...statuses.values()];
  const tally = Object.entries(VENDOR_STATUSES).map(([k, v]) => [v, withStatus.filter(s => s.status === k).length]).filter(([, c]) => c);
  return `${hero('vendors', 'Vendors', 'Recruiters you have emailed, where things stand with each one, and which resume they always get.')}
<div class="section">Recruiters <span class="aside">${tally.length ? tally.map(([v, c]) => `${v} ${c}`).join(' · ') : `${vendors.length} emailed`}</span></div>
${vendors.length > 6 ? `<div class="filterbar"><input type="search" placeholder="Filter recruiters" aria-label="Filter recruiters" data-filter="#vt > details"></div>` : ''}
<div class="grp long" id="vt">${vendors.map(v => { const s = statuses.get(v.addr); const l = lockOf(v.addr);
  // The editor for a row is built from #vt-body only when the row is opened (see VENDOR_JS): a thousand hidden
  // copies of it were most of this page's weight.
  return `<details class="disc" data-addr="${esc(v.addr)}" data-status="${esc(s?.status ?? '')}" data-date="${esc(s?.on_date ?? '')}" data-note="${esc(s?.note ?? '')}"${l ? ' data-locked' : ` data-domain="${esc(parseVendor(v.addr)?.domain ?? '')}"`}><summary class="row tall"><span class="lbl"><span>${esc(v.addr)}</span><span class="sub one">${v.sends} sent${v.last_sent ? ` · last ${esc(v.last_sent.slice(0, 10))}` : ''} · ${weekly.get(v.addr) ?? 0} this week${l ? ` · locked to ${esc(resumeLabel(l.resume_folder))}` : ''}</span></span>
   ${s ? `<span class="pill ${s.status}">${esc(VENDOR_STATUSES[s.status])}</span>` : ''}<span class="chev"></span></summary></details>`; }).join('') || '<div class="empty-row">No recruiters yet. They appear after your first send.</div>'}</div>
<template id="vt-body"><div class="disc-body">
 <div class="row"><label>Status</label><span class="sp"></span><span class="popup"><select>${opts('')}</select></span>
  <input type="text" class="vt-date" placeholder="YYYY-MM-DD" inputmode="numeric" maxlength="10" autocomplete="off" aria-label="Date"><input type="text" class="vt-note" placeholder="Note" aria-label="Note"><button type="button" class="small" data-act="save">Save</button></div>
 <div class="row" data-unlocked><span class="lbl"><span>Resume lock</span><span class="sub">Always send this recruiter the same resume.</span></span><button type="button" class="small" data-act="lock">Lock…</button></div>
 <div class="row"><span class="lbl"><span>Block</span><span class="sub">Never email this address again. Its postings and unsent emails are skipped.</span></span><button type="button" class="small danger" data-act="block">Block…</button></div>
</div></template>
<div class="section">Resume locks <span class="aside">${locks.length}</span></div>
<div class="grp">
 ${locks.map(l => `<div class="row"><span class="ico">${icon('lock')}</span><span class="lbl"><span>${esc(lockLabel(l))}</span><span class="sub one">${esc(resumeLabel(l.resume_folder))}${l.reason ? ` · ${esc(l.reason)}` : ''}</span></span><button type="button" class="small" onclick="simple('/api/locks/${l.id}/delete',{},this,'Remove this lock?')">Remove</button></div>`).join('')}
 <details class="disc" id="lock-fold"><summary class="row"><span class="lbl"><span style="color:var(--accent-text)">Add a lock…</span></span><span class="chev"></span></summary><div class="disc-body" id="lockform">
  <div class="row"><label>Domain</label><input type="text" name="domain" placeholder="company.com"></div>
  <div class="row"><label>Recruiter</label><input type="text" name="local" placeholder="Optional, part before @"></div>
  <div class="row"><label>Resume</label><span style="flex:1"></span><span class="popup"><select name="resume_folder">${folders.map(f => `<option value="${esc(f.folder)}">${esc(f.name)}</option>`).join('')}</select></span></div>
  <div class="row"><label>Reason</label><input type="text" name="reason" placeholder="Submitted me to Acme"></div>
  <div class="btnrow" style="margin-top:6px"><span class="meta">A lock beats matching. If the locked resume fits under ${config.minMatchScore}%, the email is held.</span><span class="sp"></span><button type="button" class="primary" onclick="simple('/api/locks', lockFields(), this)">Add Lock</button></div>
 </div></details>
</div>
<div class="section">Blocked <span class="aside">${black.length}</span></div>
<div class="grp">
 ${black.map(b => `<div class="row"><span class="ico">${icon('block')}</span><span class="lbl"><span>${esc(b.term)}</span></span><button type="button" class="small" onclick="blrm(${b.id},this)">Remove</button></div>`).join('')}
 <div class="row"><input type="text" id="bl-term" placeholder="Domain, address or company name" style="text-align:left"><button type="button" class="small" onclick="bladd(this)">Block</button></div>
</div>
<p class="foot">An address blocks that one person; a domain (acme.com) blocks everyone there. Blocked recruiters are never emailed or CC'd, by any route: their postings, drafts and queued emails are skipped, and the final send refuses them.</p>
<div class="grp" style="margin-top:20px"><details class="disc"><summary class="row"><span class="lbl"><span>Change history</span></span><span class="val">${audit.length}</span><span class="chev"></span></summary><div class="disc-body">
 ${audit.map(r => `<div class="meta audit">${esc(r.ts)} · ${esc(r.action)} · ${esc(String(r.detail).slice(0, 140))}</div>`).join('') || '<p class="meta">None.</p>'}</div></details></div>
<script>
async function blockAddr(addr, b){ if (!(await rvConfirm('Block ' + addr + '? Runevoid will never send them anything, and their unsent emails are skipped.', { ok: 'Block' }))) return;
  b.disabled = true; const j = await post('/api/blacklist', { term: addr }); if (j.ok) location.reload(); else { b.disabled = false; rvAlert(j.error) } }
async function bladd(b){ const t = document.getElementById('bl-term').value; if (!t.trim()) return; b.disabled = true;
  const j = await post('/api/blacklist', { term: t }); if (j.ok) { if (j.skipped) await rvAlert(j.skipped + ' open draft(s) from them were skipped.'); location.reload() } else { rvAlert(j.error); b.disabled = false } }
async function blrm(id, a){ if (!(await rvConfirm('Unblock this recruiter?', { ok: 'Unblock' }))) return; const j = await post('/api/blacklist/' + id + '/delete'); if (j.ok) location.reload(); else rvAlert(j.error) }
function lockFields(){ const o = {}; document.querySelectorAll('#lockform [name]').forEach(e => o[e.name] = e.value); return o }
function lockPrefill(d){ const f = document.getElementById('lock-fold'); if (f) f.open = true; document.querySelector('#lockform [name=domain]').value = d; document.querySelector('#lockform [name=domain]').focus() }
// Recruiter rows: build the editor on first open, and handle its buttons by delegation.
const vt = document.getElementById('vt'), vtBody = document.getElementById('vt-body');
if (vt) {
  vt.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.open || d.querySelector('.disc-body')) return;
    const body = vtBody.content.firstElementChild.cloneNode(true);
    const [sel, date, note] = body.querySelectorAll('select, input');
    sel.value = d.dataset.status; date.value = d.dataset.date; note.value = d.dataset.note;
    if ('locked' in d.dataset) body.querySelector('[data-unlocked]').remove();
    d.append(body);
  }, true);   // toggle doesn't bubble; capture sees it on the way down
  vt.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const d = b.closest('details');
    if (b.dataset.act === 'save') vsave(b);
    else if (b.dataset.act === 'lock') lockPrefill(d.dataset.domain);
    else if (b.dataset.act === 'block') blockAddr(d.dataset.addr, b);
  });
}
async function vsave(b){
  const box = b.closest('details'); const [sel, date, note] = box.querySelectorAll('.disc-body select, .disc-body input');
  const d = date.value.trim();
  const t = new Date(d + 'T00:00:00Z');   // invalid dates (2026-13-45) give NaN, and toISOString() would throw
  const valid = /^\\d{4}-\\d{2}-\\d{2}$/.test(d) && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  if (d && !valid) { await rvAlert('Enter the date as YYYY‑MM‑DD, for example 2026‑11‑21. Leave it empty for today.'); date.focus(); return }
  b.disabled = true; const j = await post('/api/vendor-status', { address: box.dataset.addr, status: sel.value || 'clear', on_date: d, note: note.value });
  if (j.ok) location.reload(); else { rvAlert(j.error); b.disabled = false }
}
</script>`;
}

// ── Logs ──────────────────────────────────────────────────────────────────────

export function logsPage(view) {
  if (view === 'scraped') return scrapedPage({ show: '', day: 'all' });
  const rows = db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT 1500`).all();
  return `<div class="filterbar"><input type="search" placeholder="Filter the log" aria-label="Filter the log" data-filter="#lg > .row">
 <span class="sp"></span><a class="quiet" href="/export/events.csv">Export Log</a><a class="quiet" href="/export/jobs.csv">Export Postings</a></div>
<div class="grp long" id="lg">${rows.map(r => `<div class="row">${r.level === 'error' ? '<span class="dot"></span>' : r.level === 'warn' ? '<span class="dot ring"></span>' : '<span class="dot grey"></span>'}
  <span class="lbl wrap"><span>${esc(r.message)}</span><span class="sub one">${esc(r.ts)} · ${esc(r.type)}${r.job_id ? ` · #${r.job_id}` : ''}</span></span></div>`).join('') || '<div class="empty-row">Nothing logged yet.</div>'}</div>`;
}

// ── Scraped: every posting the bot has read, with what it decided ─────────────

const SCRAPE_GROUPS = {
  drafted:  ['Drafted / applied', `status IN ('pending_approval','queued','sent','held','sending','failed','expired','approved')`],
  filtered: ['Filtered out', `status = 'filtered_out'`],
  low:      ['Low resume fit', `status = 'low_match'`],
  noemail:  ['No email', `status = 'no_email'`],
  skipped:  ['Skipped by you', `status = 'skipped'`],
  error:    ['Errors', `status IN ('error','no_resume')`],
  waiting:  ['Not read yet', `status = 'new'`],
};
// The statuses in each group, for counting in JS (SCRAPE_GROUPS holds the same sets as SQL for the list query).
const SCRAPE_STATUSES = {
  drafted: ['pending_approval', 'queued', 'sent', 'held', 'sending', 'failed', 'expired', 'approved'],
  filtered: ['filtered_out'], low: ['low_match'], noemail: ['no_email'], skipped: ['skipped'], error: ['error', 'no_resume'], waiting: ['new'],
};
export function scrapedPage({ show = '', day = 'today', q = '' } = {}) {
  const dayWhere = day === 'all' ? '1' : day === 'hour' ? `scraped_at >= datetime('now','localtime','-1 hour')` : `scraped_at >= date('now','localtime')`;
  const base = `source IS NOT 'manual' AND ${dayWhere}`;
  const manualBase = `source = 'manual' AND ${dayWhere}`;   // JDs you pasted on the Manual tab (#1001+)
  // One pass over the day's postings for every tab count (eight separate COUNTs took ~50 ms each).
  const byStatus = db.prepare(`SELECT source = 'manual' manual, status, COUNT(*) n FROM jobs WHERE ${dayWhere} GROUP BY 1, 2`).all();
  const manualCount = byStatus.filter(r => r.manual).reduce((a, r) => a + r.n, 0);
  const total = byStatus.filter(r => !r.manual).reduce((a, r) => a + r.n, 0);
  const tally = Object.entries(SCRAPE_GROUPS).map(([k, [label]]) =>
    [k, label, byStatus.filter(r => !r.manual && SCRAPE_STATUSES[k].includes(r.status)).reduce((a, r) => a + r.n, 0)]);
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  const where = [show === 'manual' ? manualBase : base, SCRAPE_GROUPS[show]?.[1] ?? '1',
    ...terms.map(() => `lower(coalesce(title,'') || ' ' || coalesce(company,'') || ' ' || coalesce(recruiter_email,'') || ' ' || coalesce(recruiter_name,'') || ' ' || coalesce(location_jd, location_listed, '') || ' ' || coalesce(status_reason,'') || ' ' || id) LIKE ? ESCAPE '\\'`)].join(' AND ');
  // Only the columns the list shows; the job description text is most of each row's size.
  const rows = db.prepare(`SELECT j.*, a.id app_id, a.status app_status, a.resume_folder,
                                  a.match_score app_match_score, a.ranking_json app_ranking_json
                           FROM (SELECT id, source, url, title, company, posted_raw, location_jd, location_listed, recruiter_email,
                                        status, status_reason, match_score, ranking_json
                                 FROM jobs WHERE ${where} ORDER BY id DESC LIMIT 1000) j LEFT JOIN applications a ON a.job_id = j.id
                           ORDER BY j.id DESC`).all(...terms.map(like));
  const matchInfo = (r) => {
    const ranking = JSON.parse(r.app_ranking_json ?? r.ranking_json ?? '[]');
    const selected = ranking.find(x => x.folder === r.resume_folder) ?? ranking[0];
    return {
      score: r.app_match_score ?? r.match_score,
      folder: r.resume_folder ?? selected?.folder,
      missing: selected?.missing ?? [],
    };
  };
  const url = (o) => '/scraped?' + new URLSearchParams({ show, day, q, ...o }).toString();
  const chip = (on, href, label) => `<a href="${esc(href)}"${on ? ' class="on" aria-current="true"' : ''}>${label}</a>`;
  const open = (r) => !r.app_id ? '' : ['draft', 'held', 'failed'].includes(r.app_status) ? `<a href="/${r.source === 'manual' ? 'manual' : 'review'}?open=${r.app_id}">Open Draft</a>` : `<a href="/app/${r.app_id}">View Email</a>`;
  const actionScript = rows.some(r => r.status === 'low_match') ? `<script>
async function applyAnyway(id, button) {
  button.disabled = true; setLabel(button, 'Drafting…');
  try {
    const result = await post('/api/apply-anyway/' + id);
    if (!result.ok) throw new Error(result.error || 'Could not draft this posting');
    // Stay on this page so you can add several; the row shows it's done, with a link to the draft.
    const done = document.createElement('a');
    done.href = '/review?open=' + result.app_id; done.className = 'swap'; done.textContent = 'In Review · ' + result.score + '%';
    done.style.minWidth = button.offsetWidth + 'px';   // takes the button's place without moving the row
    button.replaceWith(done);
    const tr = done.closest('tr'); if (tr) tr.style.opacity = '.55';
    const tab = document.querySelector('.sb-item[href="/review"]');
    if (tab) { let b = tab.querySelector('b'); if (!b) { b = document.createElement('b'); b.textContent = '0'; tab.append(b) } b.textContent = Number(b.textContent) + 1 }
  } catch (error) {
    button.disabled = false; setLabel(button, 'Apply Anyway'); rvAlert(error.message);
  }
}</script>` : '';
  return `<div class="filterbar"><div class="seg">${chip(day === 'hour', url({ day: 'hour' }), 'Last Hour')}${chip(day === 'today', url({ day: 'today' }), 'Today')}${chip(day === 'all', url({ day: 'all' }), 'All Time')}</div>
  <span class="sp"></span>
  <form method="get" action="/scraped" style="margin:0"><input type="hidden" name="show" value="${esc(show)}"><input type="hidden" name="day" value="${esc(day)}"><input type="search" name="q" value="${esc(q)}" placeholder="Filter postings" aria-label="Filter postings"><button type="submit" class="sr-only">Filter</button></form>
  <a class="quiet" href="/export/jobs.csv">Export CSV</a></div>
 <div class="filterbar"><div class="chips" role="group" aria-label="Show">${chip(!show, url({ show: '' }), `All <b>${total}</b>`)}${tally.map(([k, label, c]) => chip(show === k, url({ show: k }), `${label} <b>${c}</b>`)).join('')}${chip(show === 'manual', url({ show: 'manual' }), `Manual <b>${manualCount}</b>`)}</div></div>
 <div class="grp long">${rows.map(r => {
    const info = matchInfo(r);
    const missing = r.status !== 'low_match' || !info.missing.length ? '' : `<span class="sub one">Missing: ${info.missing.slice(0, 12).map(esc).join(', ')}${info.missing.length > 12 ? '…' : ''}</span>`;
    const action = `${open(r)}${r.status === 'low_match' ? ` <button type="button" class="small" onclick="applyAnyway(${r.id},this)" title="Draft it with your best resume, whatever the match. It still waits in Review for your approval.">${twoLabel('Apply Anyway', 'Drafting…')}</button>` : ''}`;
    return `<div class="row tall"><span class="lbl wrap"><span>${jobTitle(r)}</span>
     <span class="sub one">#${r.id} · ${esc((r.posted_raw || '').replace(/\s+/g, ' ').trim())}${r.company ? ' · ' + esc(r.company) : ''}${(r.location_jd || r.location_listed) ? ' · ' + esc(r.location_jd || r.location_listed) : ''}${r.recruiter_email ? ' · ' + esc(r.recruiter_email) : ''}</span>
     <span class="sub clamp">${esc(r.status.replace(/_/g, ' '))}${r.status_reason ? ` · ${esc(r.status_reason)}` : ''}</span>${missing}</span>
     ${info.score != null ? `<span class="val">${info.score}%</span>` : ''}${action ? `<span class="nw">${action}</span>` : ''}</div>`;
  }).join('') || '<div class="empty-row">Nothing here for this filter.</div>'}</div>
 ${rows.length >= 1000 ? '<p class="foot">Showing the newest 1000. Narrow it with the filter.</p>' : ''}${actionScript}`;
}

// ── Health ────────────────────────────────────────────────────────────────────

export function healthPage() {
  const c = counts();
  const lastPoll = getState('last_poll_at', '');
  const pollAgeMin = lastPoll ? Math.round((Date.now() - Date.parse(lastPoll.replace(' ', 'T'))) / 60000) : null;
  const resumes = listResumeFiles();
  const errors24 = n(`SELECT COUNT(*) n FROM events WHERE level = 'error' AND ts >= datetime('now','localtime','-1 day')`);
  const stuck = n(`SELECT COUNT(*) n FROM applications WHERE status = 'sending'`);
  let dbSize = '';
  try { dbSize = `${(statSync(DB_PATH).size / 1e6).toFixed(1)} MB` } catch { /* size unknown: leave blank */ }
  const ramp = [0, 2, 4, 6, 8].map(d => { const x = new Date(Date.now() + d * 86_400_000); return `${ymd(x).slice(5)}: ${dailyCap(x)}` }).join(' · ');
  const check = (ok, title, detail, right = '') => `<div class="row tall"><span class="st ${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}"></span><span class="lbl wrap"><span>${title}</span><span class="sub">${detail}</span></span>${right}</div>`;
  const watcherPaused = getState('watcher_paused', '0') === '1';
  return `${hero('health', 'Status', 'Connections, the watcher, and your data.')}
<div class="section">Sending</div>
<div class="grp">
 ${check(emailConfigured(), 'Gmail', emailConfigured() ? `${esc(config.gmailUser)} <span id="vmsg"></span>` : 'GMAIL_USER / GMAIL_APP_PASSWORD missing in .env', emailConfigured() ? '<button type="button" class="small" onclick="verify(this)">Test Login</button>' : '')}
 ${check(!c.q.paused, 'Sending', c.q.paused ? 'Paused' : 'On', `<label class="switch"><input type="checkbox" ${c.q.paused ? '' : 'checked'} onchange="flip(this,'/api/pause-sending',{on:!this.checked})" aria-label="Sending"><span></span></label>`)}
 ${check(c.q.dryRun ? null : true, 'Dry run', c.q.dryRun ? 'On, so nothing is really sent (DRY_RUN=true in .env)' : 'Off, so emails really go out')}
 ${check(stuck ? false : true, 'Stuck sends', stuck ? `${stuck} email(s) stuck in “sending”` : 'None')}
 ${check(true, 'Daily cap', `${c.q.dailyCapSentToday} of ${c.q.cap} today · ${c.q.sentToday} sent in total · next days ${ramp}`)}
</div>
<div class="section">Cc on every email</div>
<div class="grp"><div class="row"><input id="cc-emails" type="text" value="${esc(getCcEmails().join(', '))}" placeholder="name@example.com, another@example.com" style="text-align:left"><button type="button" class="small" onclick="saveCc(this)">Save</button></div></div>
<p class="foot"><span id="cc-msg">Comma-separated. Overrides CC_EMAILS in .env.</span></p>
<div class="section">Watcher and data</div>
<div class="grp">
 ${check(watcherPaused ? null : pollAgeMin !== null && pollAgeMin < 10 && getState('last_poll_ok', '1') === '1', 'nvoids watcher', watcherPaused ? 'Paused' : lastPoll ? `Last check ${esc(lastPoll)} (${pollAgeMin} min ago)${getState('last_poll_ok', '1') === '1' ? '' : ', failed'}` : 'Never checked', `<label class="switch"><input type="checkbox" ${watcherPaused ? '' : 'checked'} onchange="flip(this,'/api/pause-watcher',{on:!this.checked})" aria-label="Watcher"><span></span></label>`)}
 ${(() => { const b = breakerState(); return check(b.until > Date.now() ? false : b.failures ? null : true, 'Circuit breaker', b.until > Date.now() ? `Open after ${b.failures} failed checks; retrying at ${new Date(b.until).toLocaleTimeString()}` : b.failures ? `${b.failures} failed check(s) in a row` : 'Closed, nvoids is reachable') })()}
 ${check(true, 'nvoids layout', getState('nvoids_layout', '') === 'old' ? 'Old site (job_details.jsp), handled' : getState('nvoids_layout', '') ? 'New site (j_details.jsp)' : 'Not checked yet')}
 ${check(true, 'Rescue missed postings', `Read back the listing after the Mac slept. <span id="rmsg"></span>`, `<input id="rh" type="number" min="1" max="48" value="6" style="flex:none;width:44px" aria-label="Hours"><span class="meta">hours</span><button type="button" class="small" onclick="doRescue(this)">Rescue</button>`)}
 ${check(resumes.length > 0, 'Resumes', resumes.length ? `${resumes.length} found: ${resumes.map(r => esc(r.name)).join(', ')}` : `None found in ${esc(config.resumesDir)}`)}
 ${check(existsSync(join(ROOT, 'resume-lanes.json')) ? true : null, 'Resume lanes', 'resume-lanes.json')}
 ${check(errors24 ? null : true, 'Errors in the last 24 hours', `${errors24}`, errors24 ? '<a class="quiet" href="/logs">Show Log</a>' : '')}
 ${check(true, 'Database', `${dbSize} · ${n('SELECT COUNT(*) n FROM jobs')} postings · ${n('SELECT COUNT(*) n FROM applications')} drafts and emails`)}
 ${check(existsSync(HISTORY_PATH), 'Sent_History.md', existsSync(HISTORY_PATH) ? esc(HISTORY_PATH) : 'Not created yet')}
</div>
<script>async function doRescue(b){ b.disabled = true; const m = document.getElementById('rmsg'); m.textContent = 'reading nvoids… (can take a few minutes)';
  const j = await post('/api/rescue', { hours: Number(document.getElementById('rh').value) }); b.disabled = false;
  m.textContent = j.ok ? j.found + ' missed posting(s), ' + j.drafted + ' new draft(s).' : j.error; m.className = j.ok ? '' : 'bad' }
async function saveCc(b){ const input = document.getElementById('cc-emails'), msg = document.getElementById('cc-msg'); b.disabled = true;
  const j = await post('/api/cc', { emails: input.value }); b.disabled = false;
  if (j.ok) { input.value = j.emails.join(', '); msg.textContent = 'Saved. Applies immediately to queued and future recruiter emails.'; msg.className = 'meta ok' }
  else { msg.textContent = j.error || 'Could not save CC recipients.'; msg.className = 'meta bad' }
}
async function verify(b){ b.disabled = true; const j = await post('/api/verify-email'); b.disabled = false; const m = document.getElementById('vmsg'); m.textContent = j.ok ? 'login OK' : j.error; m.className = j.ok ? 'ok' : 'bad' }</script>`;
}

export { CLIENT_JS };
