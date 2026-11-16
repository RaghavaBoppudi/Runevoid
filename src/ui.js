// RUNE dashboard — everything that draws a page. server.js only routes requests here.
//
// Layout (standard app-shell / master-detail dashboard):
//   header  — logo, top tabs, search, controls
//   kpis    — one compact strip: sent today/cap · week/total · new + waiting · queued/held/failed · next send
//   work    — fills the rest of the window; never scrolls as a page. Lists and panes scroll inside.
//     Review / Manual: a list bar on the left (New postings → Needs fixing → Standard), the chosen draft in
//     the work area, JD under the email, Approve/Skip pinned to the bottom. Keyboard: j/k ↑/↓ move,
//     a approve, s skip, r re-match, x select, / filter.
// Theme: teal, hot pink, ink black, and coral.
import { config, emailConfigured, dailyCap, ROOT } from './config.js';
import { db, getState } from './db.js';
import { ccFor, getCcEmails, HISTORY_PATH } from './email.js';
import { listResumeFiles, resumeLabel } from './resumes.js';
import { draftWarnings, lockFor, lockLabel, parseVendor, todaysFolder, weeklyCount } from './rules.js';
import { isPriority, queueStatus, queuedInOrder } from './mailer.js';
import { breakerState } from './pipeline.js';
import { VENDOR_STATUSES, rematchStatus } from './actions.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Theme ─────────────────────────────────────────────────────────────────────

const CSS = `
:root{--bg:#07110f;--card:rgba(8,20,18,.86);--card-solid:#0a1715;--ink:#eafaf5;--muted:#8fb8ad;--line:#1f3d37;
  --accent:#ff3d7f;--accent2:#2ec4a0;--coral:#ff7b6b;--ok:#2ee6a8;--warn:#ff9f6b;--bad:#ff4d6d;
  --glow:0 0 0 1px rgba(255,61,127,.55),0 6px 22px rgba(255,61,127,.28);--glow2:0 0 0 1px rgba(46,196,160,.55),0 6px 20px rgba(46,196,160,.22);
  --field:rgba(3,10,9,.85);
  --head:'Orbitron','Segoe UI',sans-serif;--body:'Inter','Segoe UI',system-ui,sans-serif}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:13.5px/1.5 var(--body);color:var(--ink);background:var(--bg);display:flex;flex-direction:column;overflow:hidden}
h1,h2,h3,.logo,.tabs a,.kpi span,.group,th,label,.badge{font-family:var(--head)}
a{color:var(--accent2);transition:color .15s}a:hover{color:var(--accent)}

/* header */
header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 16px;background:rgba(5,13,12,.94);border-bottom:2px solid var(--accent);backdrop-filter:blur(8px);animation:drop .45s cubic-bezier(.2,1.4,.4,1) both}
.logo{font-size:19px;font-weight:700;letter-spacing:.18em;color:var(--accent);display:inline-block;animation:glitch-idle 6s steps(1) infinite}
.logo:hover{animation:boom .5s cubic-bezier(.2,1.6,.4,1),glitch .35s steps(2) 2}
/* tabs never shrink into the search box: when the row is full, the header wraps instead */
.tabs{display:flex;gap:0;flex:none;max-width:100%;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tabs a{position:relative;padding:6px 8px;font-size:10.5px;white-space:nowrap;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;color:var(--accent2);border-radius:6px;transition:color .15s,background .15s}
.tabs a::after{content:"";position:absolute;left:10px;right:10px;bottom:2px;height:2px;background:var(--accent);transform:scaleX(0);transform-origin:left;transition:transform .22s cubic-bezier(.2,1.4,.4,1)}
.tabs a:hover{color:var(--ink);background:rgba(46,196,160,.08)}.tabs a:hover::after,.tabs a.on::after{transform:scaleX(1)}.tabs a.on{color:var(--ink)}
.tabs a b{font-family:var(--body);font-size:10px;margin-left:4px;padding:0 5px;border-radius:8px;background:var(--accent);color:#fff}
/* search + controls travel together: beside the tabs when there is room, otherwise a full-width row of their own */
.hright{display:flex;align-items:center;gap:12px;flex:1 1 560px;min-width:0}
.search{display:flex;gap:6px;flex:1 1 200px;min-width:160px;max-width:420px}
.ctrl{display:flex;gap:6px;flex:none;align-items:center;margin-left:auto}
/* KPI strip */
.kpis{flex:none;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:10px 16px;background:rgba(5,13,12,.6);border-bottom:1px solid var(--line)}
.kpi{position:relative;overflow:hidden;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);text-decoration:none;color:var(--ink);
  transition:transform .18s cubic-bezier(.2,1.5,.4,1),box-shadow .18s,border-color .18s;animation:pop .4s cubic-bezier(.2,1.35,.4,1) both}
.kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent2)}
.kpi:hover{transform:translateY(-2px);border-color:var(--accent);box-shadow:var(--glow)}
.kpi::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;pointer-events:none;background:linear-gradient(100deg,transparent,rgba(255,255,255,.14),transparent);transform:skewX(-18deg)}
.kpi:hover::after{animation:sweep .6s ease-out}
.kpi span{display:block;font-size:9px;color:var(--muted);letter-spacing:.13em;text-transform:uppercase}
.kpi b{font-family:var(--head);font-size:19px;font-variant-numeric:tabular-nums}.kpi small{color:var(--muted);font-size:12px;margin:0 3px}
.kpi.bad::before{background:var(--bad)}.kpi.hot::before{background:var(--accent)}
.kpi:nth-child(2){animation-delay:.04s}.kpi:nth-child(3){animation-delay:.08s}.kpi:nth-child(4){animation-delay:.12s}.kpi:nth-child(5){animation-delay:.16s}

/* work area */
main{flex:1;min-height:0;display:flex}
.page{flex:1;overflow:auto;padding:16px 18px 30px}
@media (min-width:1280px){.page.narrow{max-width:min(1150px,calc(100vw - 56.25vh - 40px))}}
.split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(300px,380px) 1fr}
@media (min-width:1500px){.split{grid-template-columns:400px minmax(0,calc(100vw - 400px - 56.25vh + 60px)) 1fr}}
.listbar{min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--line);background:rgba(5,13,12,.88);}
.listtools{flex:none;padding:10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px}
.listtools .rowx{display:flex;gap:6px;align-items:center}
.list{flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 0 20px}
.group{position:sticky;top:0;z-index:1;padding:8px 12px 6px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent2);background:rgba(5,13,12,.97);display:flex;justify-content:space-between}
.group.hot{color:var(--accent)}.item.pop{animation:popin .6s ease-out}@keyframes popin{from{opacity:0;transform:translateX(-14px);background:rgba(255,62,165,.25)}to{opacity:1;transform:none}}.group.fix{color:var(--warn)}
.item{display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:8px 12px;border-left:3px solid transparent;cursor:pointer;outline:none;
  transition:background .12s,border-color .12s,transform .12s;animation:slide .3s both}
.item:hover{background:rgba(46,196,160,.07)}.item.active{background:rgba(255,61,127,.12);border-left-color:var(--accent)}
.item:focus-visible{box-shadow:inset 0 0 0 1px var(--accent2)}
.item.hot{border-left-color:rgba(255,61,127,.55)}.item.fix{border-left-color:rgba(255,159,107,.6)}
.item.gone{opacity:.35;pointer-events:none}
.it-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it-sub{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.it-score{text-align:right;font-family:var(--head);font-size:13px;color:var(--accent2)}.it-score small{display:block;font-family:var(--body);font-size:10.5px;color:var(--muted)}
.item input{accent-color:var(--accent);margin:0}
.bulk{display:none;gap:6px;align-items:center;font-size:12px;color:var(--muted)}.bulk.on{display:flex}
.pane{min-height:0;overflow:hidden;display:flex;flex-direction:column;background:rgba(7,17,15,.86)}
.empty{margin:auto;text-align:center;color:var(--muted);max-width:420px;padding:30px}.empty h3{color:var(--ink);letter-spacing:.06em}
.pane.idle{cursor:default}
.pane.idle .empty{padding:14px 18px;border:1px solid var(--line);border-radius:12px;background:rgba(5,13,12,.82);max-width:360px}
kbd{font:11px ui-monospace,Consolas,monospace;padding:1px 6px;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;color:var(--ink)}

/* draft view */
.draft{flex:1;min-height:0;display:flex;flex-direction:column;animation:pop .3s cubic-bezier(.2,1.35,.4,1) both}
.draft-head{flex:none;padding:14px 18px 10px;border-bottom:1px solid var(--line)}
.draft-head h3{margin:0 0 4px;font-size:15px;letter-spacing:.03em}.draft-head h3 a{color:var(--ink);text-decoration:none}.draft-head h3 a:hover{color:var(--accent)}
.draft-body{flex:1;min-height:0;overflow:auto;padding:12px 18px}
.draft-actions{flex:none;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 18px;border-top:1px solid var(--line);background:rgba(5,13,12,.95)}
.draft-actions .msg{margin-left:auto;font-size:12.5px}
.meta{color:var(--muted);font-size:12.5px}
.warn{color:var(--warn);margin:3px 0;font-size:12.5px}.err{color:var(--bad);font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}
label{display:block;font-size:10px;color:var(--muted);margin:10px 0 3px;text-transform:uppercase;letter-spacing:.1em}
input,select,textarea{width:100%;font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--field);color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
input[type=checkbox]{width:auto}
input:hover,select:hover,textarea:hover{border-color:var(--accent2)}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:var(--glow)}
textarea{min-height:210px;resize:vertical}
pre{white-space:pre-wrap;font:12.5px/1.45 ui-monospace,'Cascadia Code',Consolas,monospace;background:var(--field);border:1px solid var(--line);padding:10px;border-radius:8px;margin:0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.kw{font-size:12px;color:var(--muted);margin-top:4px}.kw span{display:inline-block;padding:1px 8px;margin:2px;border-radius:4px;border:1px solid var(--line);animation:chip .35s cubic-bezier(.2,1.6,.4,1) both}
.kw .m{border-color:var(--accent2);color:var(--accent2)}
.badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:9.5px;font-weight:700;letter-spacing:.1em;border:1px solid currentColor;vertical-align:middle}
.badge.hot{background:var(--accent);border-color:var(--accent);color:#fff;animation:pulse 1.8s ease-in-out infinite}
.jd{margin-top:14px}.jd h4{margin:0 0 6px;font:600 10px var(--head);letter-spacing:.14em;color:var(--accent2);text-transform:uppercase}

/* buttons */
button{font:inherit;font-size:12.5px;font-weight:600;padding:6px 13px;border-radius:8px;border:1.5px solid var(--accent2);background:transparent;color:var(--accent2);cursor:pointer;position:relative;
  transition:transform .14s cubic-bezier(.2,1.6,.4,1),box-shadow .15s,background .15s,color .15s;white-space:nowrap}
button:hover{transform:translateY(-2px);box-shadow:var(--glow2);background:var(--accent2);color:#04110e}button:active{transform:scale(.94)}
button.primary{border-color:var(--accent);background:var(--accent);color:#fff}button.primary:hover{background:#ff5a93;border-color:#ff5a93;box-shadow:var(--glow);color:#fff}
button.primary::after{content:"";position:absolute;inset:-3px;border-radius:10px;border:2px solid var(--accent);opacity:0;pointer-events:none}button.primary:hover::after{animation:ring .55s ease-out}
button.small{font-size:11.5px;padding:4px 9px}button:disabled{opacity:.5;cursor:wait;transform:none}
button.danger{border-color:var(--bad);color:var(--bad)}button.danger:hover{background:var(--bad);border-color:var(--bad);color:#fff;box-shadow:0 6px 20px rgba(255,77,109,.3)}
.rm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* panels / tables (Overview, Sent, Vendors, Logs, Health) */
.grid{display:grid;gap:14px}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-height:0;display:flex;flex-direction:column;
  transition:border-color .18s,box-shadow .18s;animation:pop .42s cubic-bezier(.2,1.35,.4,1) both}
.panel:hover{border-color:rgba(46,196,160,.5)}
.panel h3{margin:0 0 10px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent2);display:flex;align-items:center;gap:8px}
.panel h3::before{content:"";width:14px;height:3px;background:var(--accent);border-radius:2px}
.panel .scroll{overflow:auto;min-height:0}
.panel:nth-child(2){animation-delay:.05s}.panel:nth-child(3){animation-delay:.1s}.panel:nth-child(4){animation-delay:.15s}.panel:nth-child(5){animation-delay:.2s}.panel:nth-child(6){animation-delay:.25s}
.fill{height:100%;min-height:0}
.big{font-family:var(--head);font-size:38px;color:var(--accent);letter-spacing:.04em;line-height:1.1}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
th{position:sticky;top:0;z-index:1;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent2);background:var(--card-solid);text-align:left}
th,td{border-bottom:1px solid var(--line);padding:7px 9px;vertical-align:top}tr td{transition:background .12s}tr:hover td{background:rgba(255,61,127,.06)}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;border:1px solid currentColor}
.pill.rtr{color:var(--accent2)}.pill.submitted{color:#9fd3ff}.pill.interview{color:var(--accent)}.pill.offer,.pill.placed{color:var(--ok)}.pill.not_interested{color:var(--muted)}
.subtabs{display:flex;gap:6px;margin-bottom:12px}.subtabs a{padding:5px 12px;border:1px solid var(--line);border-radius:16px;text-decoration:none;font-size:12px}.subtabs a.on{border-color:var(--accent);color:var(--ink)}
.check{display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line)}.check:last-child{border:0}
.check i{font-style:normal;width:20px;text-align:center}.check b{display:block}

/* motion */
@keyframes pop{0%{opacity:0;transform:translateY(12px) scale(.97)}60%{opacity:1;transform:translateY(-2px) scale(1.005)}100%{opacity:1;transform:none}}
@keyframes slide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}
@keyframes drop{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:none}}
@keyframes boom{0%{transform:scale(1)}35%{transform:scale(1.16) rotate(-3deg)}65%{transform:scale(.96) rotate(1deg)}100%{transform:scale(1)}}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,61,127,.45)}50%{box-shadow:0 0 0 6px rgba(255,61,127,0)}}
@keyframes glitch{0%{text-shadow:2px 0 var(--accent2),-2px 0 var(--accent);transform:translate(0)}50%{text-shadow:-3px 0 var(--accent2),3px 0 var(--accent);transform:translate(1px,-1px)}100%{text-shadow:none;transform:translate(0)}}
@keyframes glitch-idle{0%,96%,100%{text-shadow:none;transform:none}97%{text-shadow:3px 0 var(--accent2),-3px 0 var(--accent);transform:translateX(2px)}98%{text-shadow:-2px 0 var(--accent2),2px 0 var(--accent);transform:translateX(-2px)}}
@keyframes sweep{from{left:-60%}to{left:130%}}
@keyframes ring{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.25)}}
@keyframes chip{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@media (max-width:1100px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.g3{grid-template-columns:1fr 1fr}.search{flex-basis:220px}}
@media (max-width:820px){.split{grid-template-columns:1fr}.listbar{max-height:40vh}.g3,.g2,.cols{grid-template-columns:1fr}body{overflow:auto}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// ── Client script shared by every page ────────────────────────────────────────

const CLIENT_JS = `
async function post(url, data){
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Nvoids-Bot':'1'},body:JSON.stringify(data||{})});
  return r.json();
}
async function simple(url, data, btn, confirmText){
  if (confirmText && !confirm(confirmText)) return;
  if (btn) btn.disabled = true;
  const j = await post(url, data);
  if (j.ok) location.reload(); else { alert(j.error || 'Failed'); if (btn) btn.disabled = false }
}
async function pollNow(b){ b.disabled = true; b.textContent = 'Checking…'; await post('/api/poll'); location.reload() }
// Re-match runs in the background: Stop ends it after the draft in hand, and the numbers update in place
// (no page reloads, so nothing you have open or typed is lost).
async function stopRematch(b){
  b.disabled = true;
  const j = await post('/api/rematch-stop');
  if (!j.ok) { alert(j.error || 'Failed'); b.disabled = false }
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
  if (!resumes.length) { alert('No resumes found. Add a .docx resume to your resume folder first.'); return; }
  const choices = resumes.map(r => r.folder + ': ' + r.name).join('\\n');
  const f = prompt('Send a test email to YOUR OWN address. Enter a resume number/name from this list:\\n' + choices, resumes[0].folder); if (!f) return;
  b.disabled = true; const j = await post('/api/test-send',{folder:f}); b.disabled = false;
  alert(j.ok ? 'Test email sent to your own address. Check your inbox.' : 'Failed: ' + j.error);
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
setInterval(tick, 1000); tick();
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
`;

// Review / Manual: list + work area behaviour.
const REVIEW_JS = `
const list = document.getElementById('list'), pane = document.getElementById('pane'), filter = document.getElementById('filter');
let current = null;
const items = () => [...list.querySelectorAll('.item:not(.gone)')].filter(i => i.style.display !== 'none');
async function openItem(el, focusList){
  if (!el) return;
  for (const i of list.querySelectorAll('.item.active')) i.classList.remove('active');
  el.classList.add('active'); current = el;
  el.scrollIntoView({block:'nearest', inline:'nearest'}); list.scrollLeft = 0;
  if (focusList) el.focus();
  history.replaceState(null, '', location.pathname + '?open=' + el.dataset.id);
  pane.classList.remove('idle');
  pane.innerHTML = '<div class="empty">Loading…</div>';
  let j; try { j = await (await fetch('/api/card/' + el.dataset.id)).json() } catch { j = {html:'<div class="empty">Could not load this draft. Click it again.</div>'} }
  if (current !== el) return;
  pane.innerHTML = j.html || '<div class="empty">Not found.</div>';
}
list.addEventListener('click', e => {
  if (e.target.matches('input[type=checkbox]')) { updateBulk(); return }
  const it = e.target.closest('.item'); if (it) { e.preventDefault(); openItem(it) }
});
function move(d){ const all = items(); if (!all.length) return; let i = all.indexOf(current); i = i < 0 ? 0 : Math.max(0, Math.min(all.length - 1, i + d)); openItem(all[i], true) }
function next(){ const all = items(); const i = all.indexOf(current); return all[i + 1] || all[i - 1] || null }
function markDone(text){
  const el = current; if (!el) return;
  const n = next();
  el.classList.add('gone'); el.classList.remove('active');
  pane.classList.add('idle');
  pane.innerHTML = '<div class="empty"><h3>' + text + '</h3><p>' + (n ? 'Press <kbd>j</kbd> or click the next post on the left.' : 'That was the last one here.') + '</p></div>';
  current = null; history.replaceState(null, '', location.pathname);
  if (n) openItem(n, true);
}
async function approveCard(id, btn){
  const c = document.getElementById('app-' + id); const data = {};
  for (const el of c.querySelectorAll('[name]')) { if (el.name === 'body') { if (el.value !== el.defaultValue) data.body = el.value } else data[el.name] = el.value }
  btn.disabled = true;
  const j = await post('/api/approve/' + id, data);
  if (j.ok) markDone('✓ Queued — it goes out in turn after the vendor rules are re-checked');
  else { c.querySelector('.msg').innerHTML = '<span class="err"></span>'; c.querySelector('.msg .err').textContent = j.error; btn.disabled = false }
}
async function cardAction(url, id, btn, doneText, confirmText){
  if (confirmText && !confirm(confirmText)) return;
  if (btn) btn.disabled = true;
  const j = await post(url, {});
  if (!j.ok) { alert(j.error || 'Failed'); if (btn) btn.disabled = false; return }
  if (doneText) markDone(doneText); else openItem(current);
}
async function holdAction(id, decision, btn){
  btn.disabled = true; const j = await post('/api/hold/' + id, {decision});
  if (!j.ok) { alert(j.error); btn.disabled = false; return }
  if (decision === 'to_draft') openItem(current); else markDone('✓ Done — back in the queue');
}
document.addEventListener('change', e => {
  if (e.target.name !== 'resume_folder') return;
  const kw = e.target.closest('.draft').querySelector('.kw');
  if (kw) kw.innerHTML = '<i>Resume changed. If you have not edited the text, it is rewritten for this resume when you approve.</i>';
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
  if (action === 'skip' && !confirm('Skip ' + ids.length + ' draft(s)?')) return;
  btn.disabled = true; btn.textContent = action === 'rematch' ? 'Re-matching…' : 'Skipping…';
  const j = await post('/api/bulk', {action, ids});
  if (!j.ok) alert(j.error); location.reload();
}
function selectAllShown(on){ for (const it of items()) it.querySelector('input').checked = on; updateBulk() }
// keyboard
document.addEventListener('keydown', e => {
  const t = e.target; const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox';
  if (e.key === 'Escape') { if (typing) t.blur(); return }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1) }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
  else if (e.key === '/') { e.preventDefault(); filter.focus() }
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
function demote(){
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
async function pullFresh(){
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
    applyFilter(); recount();
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
  if (job.source === 'manual') return `<span class="badge" style="color:var(--accent)">MANUAL #${job.id ?? job.job_id}</span> ${esc(job.title)}`;
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

const TABS = [['/', 'overview', 'Overview'], ['/review', 'review', 'Review'], ['/manual', 'manual', 'Manual'], ['/sent', 'sent', 'Sent history'], ['/scraped', 'scraped', 'Scraped'],
  ['/vendors', 'vendors', 'Vendors & locks'], ['/logs', 'logs', 'Logs'], ['/health', 'health', 'Health']];

export function layout(active, body, { searchText = '', script = '', split = false } = {}) {
  const c = counts();
  const q = c.q;
  const watcherPaused = getState('watcher_paused', '0') === '1';
  const rm = rematchStatus();
  const badge ={ review: c.newPostings + c.waiting + c.fix, manual: c.manual };
  const tabs = TABS.map(([href, key, label]) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}${badge[key] ? `<b>${badge[key]}</b>` : ''}</a>`).join('');
  const kpi = (label, inner, href, cls = '') => `<a class="kpi ${cls}" href="${href}"><span>${label}</span>${inner}</a>`;
  const num = (v) => `<b data-n="${v}">${v}</b>`;
  const kpis = [
    kpi('Nvoids sends / cap', `${num(q.dailyCapSentToday)}<small>/</small><b>${q.cap}</b>`, '/sent'),
    kpi('This week · total', `${num(c.week)}<small>·</small>${num(c.total)}`, '/sent'),
    kpi('New postings · waiting', `${num(c.newPostings)}<small>·</small>${num(c.waiting)}`, '/review', c.newPostings ? 'hot' : ''),
    kpi('Queued · held · failed', `${num(q.queued)}<small>·</small>${num(c.held)}<small>·</small>${num(c.failed)}`, '/', c.failed ? 'bad' : ''),
    kpi(q.paused ? 'Sending paused' : q.dryRun ? 'Dry run — next' : 'Next send in', `<b data-countdown data-idle="${q.queued ? (q.paused ? 'paused' : 'cap reached') : 'queue empty'}">—</b>`, '/', q.paused ? 'bad' : ''),
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUNE</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Inter:wght@400;600&display=swap">
<style>${CSS}</style></head>
<body data-next-at="${q.paused || q.dryRun ? 0 : (q.nextAt ?? 0)}" data-pending="${c.newPostings + c.waiting + c.fix}">
<header>
 <span class="logo">RUNE</span>
 <nav class="tabs">${tabs}</nav>
 <div class="hright">
 <form class="search" action="/search" method="get"><input type="search" name="q" value="${esc(searchText)}" placeholder="Search email, name, phone, company, job #…" aria-label="Search"><button type="submit">Search</button></form>
 <span class="ctrl">
  ${q.dryRun ? '<span class="badge bad" title="DRY_RUN=true in .env">DRY RUN</span>' : ''}
  ${rm.running ? `<button class="small danger" data-rm-stop onclick="stopRematch(this)" title="Stop re-matching drafts"><span data-rm-text>${rm.stopping ? 'Stopping…' : 'Re-matching…'} ${rm.done}/${rm.total}</span> · ■ Stop</button>` : ''}
  <button class="small" onclick="simple('/api/pause-sending',{on:${!q.paused}},this)" title="Pause or resume sending">${q.paused ? '▶ Sending' : '⏸ Sending'}</button>
  <button class="small" onclick="simple('/api/pause-watcher',{on:${!watcherPaused}},this)" title="Pause or resume checking nvoids">${watcherPaused ? '▶ Watcher' : '⏸ Watcher'}</button>
  <button class="small" onclick="pollNow(this)" title="Check nvoids now">↻ Check</button>
  <button class="small" onclick="testSend(this)" title="Send a test email to your own address">✉ Test</button>
 </span></div>
</header>
<div class="kpis">${kpis}</div>
<div id="fresh" style="display:none;text-align:center;padding:6px;background:var(--accent);color:#fff;cursor:pointer;font-family:var(--head);letter-spacing:.08em" onclick="location.reload()">New drafts arrived — click to refresh</div>
<main>${split ? `<div class="split">${body}</div>` : `<div class="page narrow">${body}</div>`}</main>
<script>${CLIENT_JS}${script}</script></body></html>`;
}

// ── Review / Manual ───────────────────────────────────────────────────────────

// Drafts created after id `after`, for the live Priority list (oldest first).
export function freshItems(manual, after) {
  const rows = reviewRows(manual).filter(r => r.id > after && r.status === 'draft').reverse().slice(-50);
  return rows.map(r => { const kind = !manual && isPriority(r) ? 'hot' : 'std'; return { id: r.id, kind, html: itemHtml(r, kind) } });
}

function itemHtml(r, kind) {
  const who = r.company || r.recruiter_name || r.to_email;
  const s = `${r.title} ${r.company ?? ''} ${r.recruiter_name ?? ''} ${r.to_email} folder ${r.resume_folder} #${r.job_id}`.toLowerCase();
  const tag = r.status === 'held' ? 'held' : r.status === 'failed' ? 'failed' : '';
  const posted = r.posted_utc ? Date.parse(r.posted_utc) || 0 : 0;
  const match = r.best_match_score ?? r.match_score;
  const resumeInfo = r.best_resume_folder && r.best_resume_folder !== r.resume_folder
    ? `best f${r.best_resume_folder} · selected f${r.resume_folder} (${r.match_score ?? '?'}%)`
    : `f${r.resume_folder}`;
  return `<div class="item ${kind}" data-id="${r.id}" data-job="${r.job_id}" data-posted="${posted}" data-match="${match ?? ''}" data-s="${esc(s)}" tabindex="0">
<input type="checkbox" aria-label="Select">
<div style="min-width:0"><div class="it-title">${esc(r.title)}</div><div class="it-sub">${tag ? `<span class="${tag === 'failed' ? 'bad' : 'warn'}">${tag}</span> · ` : ''}${esc(who)} · ${age(r)}</div></div>
<div class="it-score">${match ?? '?'}%<small>${esc(resumeInfo)}</small></div></div>`;
}

const LIST_LIMIT = 250;   // drafts rendered per group; 1000+ made the page heavy and slow to scroll
export function reviewPage(manual) {
  const rows = reviewRows(manual);
  const k = reviewKinds(rows);
  const group = (cls, label, list, kind) => list.length || kind === 'std' || (kind === 'hot' && !manual)
    ? `<div class="group ${cls}">${label}<b>${list.length}</b></div>${list.slice(0, LIST_LIMIT).map(r => itemHtml(r, kind)).join('')}${list.length > LIST_LIMIT ? `<div class="meta" style="padding:10px 14px">Showing the newest ${LIST_LIMIT} of ${list.length}. Use the search box at the top to find older ones.</div>` : ''}` : '';
  const rm = rematchStatus();
  const total = rows.length;
  const listbar = `<aside class="listbar">
 <div class="listtools">
  ${manual ? `<button class="primary" onclick="location.href='/manual'">＋ Add a JD</button>` : ''}
  <input id="filter" type="search" placeholder="Filter by title, company, email, folder…  ( / )">
  <div class="rowx"><label style="margin:0;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0;font:12px var(--body)"><input type="checkbox" onchange="selectAllShown(this.checked)"> select all shown</label>
   <span style="margin-left:auto"></span>
   ${total ? `<button class="small" title="${rm.running ? 'A re-match is already running' : 'Re-score every draft here against your current resumes'}"${rm.running ? ' disabled' : ''} onclick="simple('/api/rematch-all',{source:'${manual ? 'manual' : 'nvoids'}'},this,'Re-score all ${total} drafts against your current resumes? Unedited drafts switch to the best resume.')">Re-match all</button>` : ''}</div>
  <div class="bulk" id="bulk"><b id="bulk-n">0</b> selected <button class="small" onclick="bulk('rematch',this)">Re-match</button><button class="small" onclick="bulk('skip',this)">Skip</button></div>
  ${rm.running ? `<div class="meta rm-row"><span data-rm-text>${rm.stopping ? 'Stopping…' : 'Re-matching…'} ${rm.done}/${rm.total}</span><button class="small danger" data-rm-stop onclick="stopRematch(this)">■ Stop</button><a href="" data-rm-done style="display:none" onclick="location.reload();return false">↻ Refresh list</a></div>` : ''}
 </div>
 <div class="list" id="list" data-manual="${manual ? 1 : 0}" data-prio-ms="${config.priorityWindowMinutes * 60_000}">
  ${group('hot', 'Priority · under ' + config.priorityWindowMinutes + ' min', k.prio, 'hot')}
  ${group('fix', 'Needs fixing', k.fix, 'fix')}
  ${group('', manual ? 'Manual drafts' : 'Standard', k.std, 'std')}
 </div>
</aside>`;
  const emptyPane = manual ? addJdForm() : `<div class="empty"><h3>Pick a post on the left</h3>
<p>Priority postings are kept in their own group and sorted by best resume match, then newest. Standard postings follow, also sorted by match; needs-fixing items stay separate.</p>
<p><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>a</kbd> approve · <kbd>s</kbd> skip · <kbd>r</kbd> re-match · <kbd>x</kbd> select · <kbd>/</kbd> filter</p></div>`;
  return listbar + `<section class="pane${manual ? '' : ' idle'}" id="pane">${emptyPane}</section>`;
}
export const REVIEW_SCRIPT = REVIEW_JS;

function addJdForm() {
  return `<div class="draft"><div class="draft-head"><h3>Add a job description</h3>
<div class="meta">Paste a JD from anywhere (LinkedIn, WhatsApp, an email). RUNE reads the recruiter, role and location, picks your best resume, writes the email, and adds it to this list as #1001, #1002, …</div></div>
<div class="draft-body" style="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(240px,1fr);gap:16px">
 <div style="display:flex;flex-direction:column;min-height:0"><label>Job description (required)</label>
  <textarea id="m_jd" style="flex:1;min-height:260px" placeholder="Paste the whole JD here, including the recruiter's signature / email"></textarea></div>
 <div><label>Recruiter email</label><input id="m_to" placeholder="read from the JD">
  <label>Job title</label><input id="m_title" placeholder="read from the JD">
  <label>Location</label><input id="m_loc" placeholder="read from the JD">
  <p class="meta" style="margin-top:14px">Leave these empty and RUNE fills them from the JD. Things that would skip an nvoids post (W2-only, low match) show as warnings instead, since you chose this job.</p></div>
</div>
<div class="draft-actions"><button class="primary" onclick="addJd(this)">Create draft</button><span class="msg" id="m_msg"></span></div></div>
<script>
async function addJd(b){
  const msg = document.getElementById('m_msg');
  b.disabled = true; msg.textContent = 'Matching resumes…';
  const j = await post('/api/manual', { jd_text: document.getElementById('m_jd').value, to_email: document.getElementById('m_to').value,
                                        title: document.getElementById('m_title').value, location: document.getElementById('m_loc').value });
  b.disabled = false;
  if (j.ok) location.href = '/manual?open=' + j.app_id;
  else { msg.innerHTML = '<span class="err"></span>'; msg.querySelector('.err').textContent = j.error }
}
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
  return `<span title="final = (d/100) × Base × DmgType × Crit × Res × Def — settings in resume-lanes.json">Formula: ${esc(bits.join(' × '))} = <b>${r.score}</b></span><br>`;
}

// The draft shown in the work area (fetched by the list via /api/card/:id).
export function draftView(app, job) {
  const priority = app.status === 'draft' && job.source !== 'manual' && isPriority({ posted_utc: job.posted_utc });
  const ranked = JSON.parse(app.ranking_json || '[]');
  const chosen = ranked.find(r => r.folder === app.resume_folder) ?? ranked[0] ?? { matched: [], missing: [] };
  const lock = lockFor(app.to_email);
  const held = app.status === 'held';
  const opts = ranked.map(r => `<option value="${esc(r.folder)}" ${r.folder === app.resume_folder ? 'selected' : ''} ${lock && r.folder !== lock.resume_folder ? 'disabled' : ''}>${esc(r.name ?? resumeLabel(r.folder))} — ${r.score}% match${r === ranked[0] ? ' (best)' : ''}${lock && r.folder === lock.resume_folder ? ' (LOCKED)' : ''}</option>`).join('');
  const holdButtons = {
    same_day: [['use_today', `Use today's resume (folder ${app.todays_folder})`], ['tomorrow', 'Send tomorrow']],
    lock_edited: [['use_lock', 'Switch to locked resume']], lock_missing: [['retry', 'Retry']], job_details: [['to_draft', 'Edit the email']],
    lock_low_fit: [['retry', 'Retry']], repost: [['send_anyway', 'Not a repost — send anyway']], weekly_cap: [['next_week', 'Send next week']],
    dry_run: [['retry', 'Queue again']], blacklist: [], same_jd_edited: [['to_draft', 'Back to draft (switch the resume)']],
  }[app.hold_kind] ?? [['retry', 'Retry']];
  const dis = held ? 'disabled' : '';
  return `<div class="draft" id="app-${app.id}">
<div class="draft-head">
 <h3>${priority ? '<span class="badge hot">NEW POSTING</span> ' : ''}${jobTitle(job)}</h3>
 <div class="meta">${jobLine(job)}</div>
 ${held ? `<div class="err">HELD: ${esc(app.hold_reason)}</div>` : ''}
 ${app.status === 'failed' ? `<div class="err">Last send failed: ${esc(app.error)}</div>` : ''}
 ${draftWarnings(app, job).map(w => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
</div>
<div class="draft-body">
 <div class="cols">
  <div><label>Resume to attach</label><select name="resume_folder" ${dis}>${opts}</select>
   <div class="kw">${chosen.why ? `<i>Why: ${esc(chosen.why)}</i><br>` : ''}${formulaLine(chosen)}In this resume: ${(chosen.matched ?? []).map(k => `<span class="m">${esc(k)}</span>`).join('') || '—'}${chosen.related?.length ? `<br>Partial credit: ${chosen.related.map(esc).join(', ')}` : ''}<br>
   Not found: ${(chosen.missing ?? []).map(k => `<span>${esc(k)}</span>`).join('') || '—'}</div></div>
  <div><label>To</label><input name="to_email" value="${esc(app.to_email)}" ${dis}>
   <label>CC</label><input name="cc_emails" value="${esc(app.cc_emails ?? ccFor(app.to_email).join(', '))}" placeholder="name@example.com, another@example.com" ${dis}>
   <label>Subject</label><input name="subject" value="${esc(app.subject)}" ${dis}></div>
 </div>
 <label>Email body${app.body !== app.auto_body ? ' (edited by you)' : ''}</label><textarea name="body" ${dis}>${esc(app.body)}</textarea>
 <div class="jd"><h4>Job description</h4><pre>${esc(job.jd_text)}</pre></div>
</div>
<div class="draft-actions">
 ${held
    ? holdButtons.map(([d, label], i) => `<button class="${i === 0 ? 'primary' : ''}" onclick="holdAction(${app.id},'${d}',this)">${esc(label)}</button>`).join('')
    : `<button class="primary" data-act="approve" onclick="approveCard(${app.id},this)">Approve → queue <kbd>a</kbd></button>
       <button data-act="rematch" onclick="cardAction('/api/rematch/${app.id}',${app.id},this,'')">Re-match <kbd>r</kbd></button>`}
 <button data-act="skip" onclick="cardAction('/api/skip/${app.id}',${app.id},this,'Skipped','Skip this job?')">Skip <kbd>s</kbd></button>
 <span class="msg"></span>
</div></div>`;
}

// Read-only view of a sent / queued / skipped email (search results open these).
export function emailView(app, job) {
  return `<div class="panel"><h3>${esc(app.status)}</h3><div style="font-size:15px;margin-bottom:6px">${jobTitle(job)}</div><div class="meta">${jobLine(job)}</div>
<p>${app.sent_at ? `Sent ${esc(app.sent_at)} · ` : ''}${app.approved_at ? `approved ${esc(app.approved_at)} · ` : ''}to ${esc(app.to_email)} · resume ${esc(resumeLabel(app.resume_folder))} (${app.match_score ?? '?'}%)</p>
${app.error ? `<div class="err">${esc(app.error)}</div>` : ''}
${app.cc_emails ? `<label>CC</label><pre>${esc(app.cc_emails.split(',').join(', '))}</pre>` : ''}<label>Subject</label><pre>${esc(app.subject)}</pre><label>Email body</label><pre>${esc(app.body)}</pre>
<div class="jd"><h4>Job description</h4><pre>${esc(job.jd_text)}</pre></div>
${app.status === 'queued' ? `<div style="margin-top:12px"><button onclick="simple('/api/cancel/${app.id}',{},this)">Pull back from the queue</button></div>` : ''}</div>`;
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
  const editor = nextApp ? `<div id="q-editor">
   <div class="meta" id="q-title">${esc(jobs.get(nextApp.job_id)?.title ?? '')} · ${esc(resumeLabel(nextApp.resume_folder))}</div>
   <label>To</label><input id="q-to" value="${esc(nextApp.to_email)}">
   <label>CC</label><input id="q-cc" value="${esc(nextApp.cc_emails ?? ccFor(nextApp.to_email).join(', '))}" placeholder="name@example.com, another@example.com">
   <label>Subject</label><input id="q-subject" value="${esc(nextApp.subject)}">
   <label>Body</label><textarea id="q-body" style="min-height:170px">${esc(nextApp.body)}</textarea>
   <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="primary" onclick="saveQueued(this)">Save changes</button>
    <button onclick="simple('/api/cancel/'+QID,{},this,'Pull this email back to drafts?')">Pull back</button><span class="meta" id="q-msg"></span></div>
   <input type="hidden" id="q-id" value="${nextApp.id}"></div>` : `<p class="meta">Nothing queued. Approve drafts on the <a href="/review">Review</a> tab.</p>`;
  const upNext = queue.slice(0, 40).map((r, i) => {
    const j = jobs.get(r.job_id) ?? {};
    return `<tr><td>${i + 1}</td><td>${r.priority ? '<span class="badge hot">NEW</span> ' : ''}${esc(j.title ?? '')}<div class="meta">${esc(r.to_email)} · ${esc(resumeLabel(r.resume_folder))}</div></td>
     <td><button class="small" onclick="loadQueued(${r.id})">Edit</button></td></tr>`;
  }).join('');
  const alerts = [
    c.failed ? `<a href="/review" class="bad">✗ ${c.failed} failed send(s) — open Review → Needs fixing</a>` : '',
    c.held ? `<a href="/review" class="warn">⚠ ${c.held} held by a vendor rule</a>` : '',
    c.newPostings ? `<a href="/review">★ ${c.newPostings} new posting(s) waiting</a>` : '',
    !emailConfigured() ? `<a href="/health" class="bad">✗ Gmail not configured</a>` : '',
    !pollOk ? `<a href="/logs" class="bad">✗ Last nvoids check failed</a>` : '',
    c.q.paused ? `<span class="warn">⏸ Sending is paused</span>` : '',
    c.q.dryRun ? `<span class="warn">DRY RUN is on — nothing is really sent</span>` : '',
  ].filter(Boolean);
  const page = `<div class="grid g3 fill" style="grid-template-rows:auto minmax(0,1fr)">
 <div class="panel"><h3>Next send</h3><div class="big" data-countdown data-idle="${c.q.queued ? (c.q.paused ? 'paused' : 'waiting') : '—'}">—</div>
  <div class="meta">${c.q.queued} in the queue · total sent today ${c.q.sentToday} · nvoids cap ${c.q.dailyCapSentToday}/${c.q.cap} · tomorrow's cap ${capTomorrow}</div>
  <div class="meta">Emails still queued at midnight expire unsent (old postings).</div></div>
 <div class="panel"><h3>Needs you</h3>${alerts.length ? alerts.map(a => `<div style="padding:3px 0">${a}</div>`).join('') : '<p class="meta">All clear.</p>'}</div>
 <div class="panel"><h3>Today</h3>
  <div class="cols" style="gap:6px 14px"><div>Scraped <b>${today.scraped}</b></div><div>Drafted <b>${today.drafted}</b></div>
  <div>Sent <b>${c.q.sentToday}</b></div><div>Skipped <b>${today.skipped}</b></div><div>Expired <b>${today.expired}</b></div>
  <div>Last check <b class="${pollOk ? 'ok' : 'bad'}">${esc(String(lastPoll).slice(11, 16) || '—')}</b></div></div></div>
 <div class="panel" style="grid-column:span 2;min-height:0"><h3>Edit before it sends</h3><div class="scroll">${editor}</div></div>
 <div class="panel" style="min-height:0"><h3>Up next (${queue.length})</h3><div class="scroll"><table><tbody>${upNext || '<tr><td class="meta">Queue is empty.</td></tr>'}</tbody></table></div></div>
</div>
<script>
let QID = Number(document.getElementById('q-id')?.value || 0);
async function loadQueued(id){
  const r = await (await fetch('/api/queued/' + id)).json(); if (!r.ok) { alert(r.error); return }
  QID = id; document.getElementById('q-title').textContent = r.title + ' · ' + r.resume_folder;
  document.getElementById('q-to').value = r.to_email; document.getElementById('q-cc').value = r.cc_emails; document.getElementById('q-subject').value = r.subject; document.getElementById('q-body').value = r.body;
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

export function sentPage() {
  const rows = db.prepare(`SELECT a.*, j.title, j.url, j.recruiter_name, j.company, j.source FROM applications a JOIN jobs j ON j.id = a.job_id
                           WHERE a.status IN ('sent','failed','skipped','sending','expired') ORDER BY COALESCE(a.sent_at, a.updated_at) DESC LIMIT 2000`).all();
  return `<div class="panel fill"><h3>Sent history (${rows.length})</h3>
<div style="display:flex;gap:10px;margin-bottom:10px;align-items:center"><input id="sf" type="search" placeholder="Filter…" style="max-width:320px" oninput="for(const tr of document.querySelectorAll('#st tbody tr'))tr.style.display=tr.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'">
 <a href="/export/applications.csv">Download CSV</a><a href="/history">Sent_History.md</a></div>
<div class="scroll" id="st">${table([
    ['When', r => esc(r.sent_at ?? r.updated_at ?? '')], ['Status', r => `<b class="${r.status === 'sent' ? 'ok' : r.status === 'failed' ? 'bad' : 'meta'}">${esc(r.status)}</b>${r.error ? `<div class="meta">${esc(r.error)}</div>` : ''}`],
    ['Job', r => `${jobTitle(r)}<div class="meta">#${r.job_id}</div>`], ['Recruiter', r => `${esc(r.recruiter_name ?? '')}<br>${esc(r.to_email)}`],
    ['Resume', r => `${esc(resumeLabel(r.resume_folder))} <span class="meta">(${r.match_score ?? '?'}%${r.locked ? ', locked' : ''})</span>`],
    ['', r => `<a href="/app/${r.id}">open</a>`],
  ], rows)}</div></div>`;
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
  return `<div class="grid fill" style="grid-template-columns:minmax(0,1.7fr) minmax(300px,1fr)">
<div class="panel" style="min-height:0"><h3>Vendors (${vendors.length})</h3>
 <div class="meta" style="margin-bottom:8px">${tally.length ? tally.map(([v, c]) => `${v}: <b>${c}</b>`).join(' · ') : 'Mark a vendor as RTR, Submitted, Interview, Offer… — they stay at the top.'}</div>
 <input type="search" placeholder="Filter vendors…" style="max-width:300px;margin-bottom:8px" oninput="for(const tr of document.querySelectorAll('#vt tbody tr'))tr.style.display=tr.textContent.toLowerCase().includes(this.value.toLowerCase())?'':'none'">
 <div class="scroll" id="vt">${table([
    ['Vendor', v => `<b>${esc(v.addr)}</b><div class="meta">${v.sends} sent${v.last_sent ? ` · last ${esc(v.last_sent.slice(0, 10))}` : ''}${v.folders ? ` · folders ${esc(v.folders)}` : ''} · ${weekly.get(v.addr) ?? 0} this week</div>`],
    ['Status', v => { const s = statuses.get(v.addr);
      return `${s ? `<span class="pill ${s.status}">${esc(VENDOR_STATUSES[s.status])}</span> <span class="meta">${esc(s.on_date ?? '')}</span>${s.note ? `<div class="meta">${esc(s.note)}</div>` : ''}` : ''}
       <div style="display:flex;gap:4px;margin-top:4px" data-addr="${esc(v.addr)}"><select style="width:auto;padding:3px 6px">${opts(s?.status)}</select>
       <input type="date" value="${esc(s?.on_date ?? '')}" style="width:auto;padding:3px 6px"><input placeholder="note" value="${esc(s?.note ?? '')}" style="padding:3px 6px">
       <button class="small" onclick="vsave(this)">Save</button></div>` }],
    ['Lock', v => { const l = lockOf(v.addr); return l ? `${esc(resumeLabel(l.resume_folder))}<div class="meta">${esc(lockLabel(l))}</div>` : `<button class="small" onclick="lockPrefill('${esc(parseVendor(v.addr)?.domain ?? '')}')">Lock…</button>` }],
  ], vendors)}</div></div>
<div class="grid" style="grid-template-rows:auto auto minmax(0,1fr);min-height:0">
 <div class="panel"><h3>Blacklist (${black.length})</h3>
  <div class="meta">Never email these. A domain (cdf.com), an address, or a company name as it appears in posts. Their postings are skipped and open drafts are skipped now.</div>
  <div style="display:flex;gap:6px;margin-top:8px"><input id="bl-term" placeholder="tanishasystems.com or Tanisha Systems"><button class="primary" onclick="bladd(this)">Add</button></div>
  <div style="margin-top:8px">${black.map(b => `<span class="pill" style="color:var(--bad);margin:2px">${esc(b.term)} <a href="#" style="color:inherit;text-decoration:none" onclick="blrm(${b.id},this);return false" title="Remove">✕</a></span>`).join('') || '<span class="meta">Empty.</span>'}</div></div>
 <div class="panel"><h3>Permanent lock</h3>
  <div class="meta">When a vendor submits you, lock them to that resume. A lock beats matching; if the locked resume is missing or fits under ${config.minMatchScore}%, the email is held.</div>
  <div id="lockform"><label>Domain</label><input name="domain" placeholder="cdf.com"><label>Only this recruiter (optional)</label><input name="local" placeholder="part before @">
  <div class="cols"><div><label>Resume</label><select name="resume_folder">${folders.map(f => `<option value="${esc(f.folder)}">${esc(f.name)}</option>`).join('')}</select></div>
  <div><label>Reason</label><input name="reason" placeholder="submitted me to Acme"></div></div></div>
  <div style="margin-top:10px"><button class="primary" onclick="simple('/api/locks', lockFields(), this)">Lock</button></div></div>
 <div class="panel" style="min-height:0"><h3>Locks (${locks.length}) &amp; changes</h3><div class="scroll">
  ${locks.length ? table([['Vendor', l => `<b>${esc(lockLabel(l))}</b><div class="meta">${esc(l.reason ?? '')}</div>`], ['Resume', l => esc(resumeLabel(l.resume_folder))],
    ['', l => `<button class="small" onclick="simple('/api/locks/${l.id}/delete',{},this,'Remove this lock?')">Remove</button>`]], locks) : '<p class="meta">No locks yet.</p>'}
  <h4 class="meta" style="margin:14px 0 4px">Change history</h4>
  ${audit.map(r => `<div class="meta" style="font-size:11.5px">${esc(r.ts)} · ${esc(r.action)} · ${esc(String(r.detail).slice(0, 140))}</div>`).join('') || '<p class="meta">None.</p>'}
 </div></div>
</div></div>
<script>
async function bladd(b){ const t = document.getElementById('bl-term').value; if (!t.trim()) return; b.disabled = true;
  const j = await post('/api/blacklist', { term: t }); if (j.ok) { if (j.skipped) alert(j.skipped + ' open draft(s) from them were skipped.'); location.reload() } else { alert(j.error); b.disabled = false } }
async function blrm(id, a){ if (!confirm('Remove from the blacklist?')) return; const j = await post('/api/blacklist/' + id + '/delete'); if (j.ok) location.reload(); else alert(j.error) }
function lockFields(){ const o = {}; document.querySelectorAll('#lockform [name]').forEach(e => o[e.name] = e.value); return o }
function lockPrefill(d){ document.querySelector('#lockform [name=domain]').value = d; document.querySelector('#lockform [name=domain]').focus() }
async function vsave(b){
  const box = b.parentElement; const [sel, date, note] = box.querySelectorAll('select,input');
  b.disabled = true; const j = await post('/api/vendor-status', { address: box.dataset.addr, status: sel.value || 'clear', on_date: date.value, note: note.value });
  if (j.ok) location.reload(); else { alert(j.error); b.disabled = false }
}
</script>`;
}

// ── Logs ──────────────────────────────────────────────────────────────────────

export function logsPage(view, status) {
  const sub = `<div class="subtabs"><a href="/logs" class="${view !== 'scraped' ? 'on' : ''}">Activity log</a><a href="/scraped">All scraped jobs</a>
  <span style="margin-left:auto"></span><a href="/export/events.csv">Log CSV</a><a href="/export/jobs.csv">Jobs CSV</a></div>`;
  if (view === 'scraped') {
    const rows = status === 'manual' ? db.prepare(`SELECT * FROM jobs WHERE source = 'manual' ORDER BY id DESC LIMIT 1500`).all()
      : status ? db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY id DESC LIMIT 1500`).all(status)
      : db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT 1500`).all();
    const cnt = db.prepare(`SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY n DESC`).all();
    const filters = `<a href="/logs?view=scraped">all</a> · <a href="/logs?view=scraped&status=manual">manual</a> · ` + cnt.map(c => `<a href="/logs?view=scraped&status=${esc(c.status)}">${esc(c.status)} (${c.n})</a>`).join(' · ');
    return `<div class="panel fill">${sub}<div class="meta" style="margin-bottom:8px">${filters}</div><div class="scroll">${table([
      ['Scraped', r => esc(r.scraped_at)], ['Job', r => `${jobTitle(r)}<div class="meta">#${r.id}</div>`], ['Recruiter', r => esc(r.recruiter_email ?? '')],
      ['Status', r => `<b>${esc(r.status)}</b><div class="meta">${esc(r.status_reason ?? '')}</div>`]], rows)}</div></div>`;
  }
  const rows = db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT 1500`).all();
  return `<div class="panel fill">${sub}<div class="scroll">${table([
    ['Time', r => esc(r.ts)], ['Level', r => r.level === 'error' ? `<span class="bad">error</span>` : r.level === 'warn' ? `<span class="warn">warn</span>` : esc(r.level)],
    ['Event', r => esc(r.type)], ['Job', r => r.job_id ? `#${r.job_id}` : ''], ['Message', r => esc(r.message)]], rows)}</div></div>`;
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
export function scrapedPage({ show = '', day = 'today', q = '' } = {}) {
  const dayWhere = day === 'all' ? '1' : day === 'hour' ? `scraped_at >= datetime('now','localtime','-1 hour')` : `scraped_at >= date('now','localtime')`;
  const base = `source IS NOT 'manual' AND ${dayWhere}`;
  const manualBase = `source = 'manual' AND ${dayWhere}`;   // JDs you pasted on the Manual tab (#1001+)
  const manualCount = n(`SELECT COUNT(*) n FROM jobs WHERE ${manualBase}`);
  const tally = Object.entries(SCRAPE_GROUPS).map(([k, [label, w]]) => [k, label, n(`SELECT COUNT(*) n FROM jobs WHERE ${base} AND ${w}`)]);
  const total = n(`SELECT COUNT(*) n FROM jobs WHERE ${base}`);
  const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
  const where = [show === 'manual' ? manualBase : base, SCRAPE_GROUPS[show]?.[1] ?? '1',
    ...terms.map(() => `lower(coalesce(title,'') || ' ' || coalesce(company,'') || ' ' || coalesce(recruiter_email,'') || ' ' || coalesce(recruiter_name,'') || ' ' || coalesce(location_jd, location_listed, '') || ' ' || coalesce(status_reason,'') || ' ' || id) LIKE ? ESCAPE '\\'`)].join(' AND ');
  const rows = db.prepare(`SELECT j.*, a.id app_id, a.status app_status, a.resume_folder,
                                  a.match_score app_match_score, a.ranking_json app_ranking_json
                           FROM (SELECT * FROM jobs WHERE ${where} ORDER BY id DESC LIMIT 1000) j LEFT JOIN applications a ON a.job_id = j.id
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
  const chip = (on, href, label) => `<a href="${esc(href)}" class="${on ? 'on' : ''}">${label}</a>`;
  const open = (r) => !r.app_id ? '' : ['draft', 'held', 'failed'].includes(r.app_status) ? `<a href="/${r.source === 'manual' ? 'manual' : 'review'}?open=${r.app_id}">open draft</a>` : `<a href="/app/${r.app_id}">view email</a>`;
  const actionScript = rows.some(r => r.status === 'low_match') ? `<script>
async function rescoreLowMatch(id, button) {
  button.disabled = true; button.textContent = 'Scoring…';
  try {
    const response = await fetch('/api/rematch-low/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nvoids-Bot': '1' }, body: '{}' });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Could not re-score this posting');
    location.reload();
  } catch (error) {
    button.disabled = false; button.textContent = 'Re-score'; alert(error.message);
  }
}</script>` : '';
  return `<div class="panel fill">
 <div class="subtabs">${chip(day === 'hour', url({ day: 'hour' }), 'Last hour')}${chip(day === 'today', url({ day: 'today' }), 'Today')}${chip(day === 'all', url({ day: 'all' }), 'All time')}
  <form method="get" action="/scraped" style="margin-left:auto;display:flex;gap:6px"><input type="hidden" name="show" value="${esc(show)}"><input type="hidden" name="day" value="${esc(day)}">
  <input name="q" value="${esc(q)}" placeholder="Filter title, company, email, reason…" style="width:260px"><button class="small">Filter</button></form>
  <a href="/export/jobs.csv">CSV</a></div>
 <div class="subtabs" style="flex-wrap:wrap">${chip(!show, url({ show: '' }), `All <b>${total}</b>`)}${tally.map(([k, label, c]) => chip(show === k, url({ show: k }), `${label} <b>${c}</b>`)).join('')}${chip(show === 'manual', url({ show: 'manual' }), `Manual JDs <b>${manualCount}</b>`)}</div>
 <div class="scroll">${rows.length ? table([
  ['Posted', r => `${esc((r.posted_raw || '').replace(/\s+/g, ' ').trim())}<div class="meta">read ${esc((r.scraped_at || '').slice(11, 16))}</div>`],
  ['Job', r => `${jobTitle(r)}<div class="meta">#${r.id}${r.company ? ' · ' + esc(r.company) : ''}${(r.location_jd || r.location_listed) ? ' · ' + esc(r.location_jd || r.location_listed) : ''}</div>`],
  ['Recruiter', r => `${esc(r.recruiter_name ?? '')}<div class="meta">${esc(r.recruiter_email ?? '')}</div>`],
  ['Decision', r => {
    const info = matchInfo(r);
    const missing = r.status !== 'low_match' ? '' : `<div class="meta">Not found in best resume: ${info.missing.length ? info.missing.map(esc).join(', ') : r.ranking_json ? 'none among detected skills' : 'details unavailable for this older result'}</div>`;
    return `<b>${esc(r.status)}</b><div class="meta">${esc(r.status_reason ?? '')}</div>${missing}`;
  }],
  ['Resume', r => {
    const info = matchInfo(r);
    return info.folder ? `folder ${esc(info.folder)}<div class="meta">${info.score ?? '?'}%</div>` : '';
  }],
  ['', r => `${open(r)}${r.status === 'low_match' ? ` <button class="small" onclick="rescoreLowMatch(${r.id},this)">Re-score</button>` : ''}`]], rows) : '<p class="meta">Nothing here for this filter.</p>'}
 ${rows.length >= 1000 ? '<p class="meta">Showing the newest 1000. Narrow it with the filter.</p>' : ''}</div></div>${actionScript}`;
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
  try { dbSize = `${(statSync(join(config.dataDir, 'nvoids-bot.db')).size / 1e6).toFixed(1)} MB` } catch {}
  const ramp = [0, 2, 4, 6, 8].map(d => { const x = new Date(Date.now() + d * 86_400_000); return `${ymd(x).slice(5)}: ${dailyCap(x)}` }).join(' · ');
  const check = (ok, title, detail) => `<div class="check"><i class="${ok === true ? 'ok' : ok === false ? 'bad' : 'warn'}">${ok === true ? '✓' : ok === false ? '✗' : '⚠'}</i><div><b>${title}</b><span class="meta">${detail}</span></div></div>`;
  const watcherPaused = getState('watcher_paused', '0') === '1';
  return `<div class="grid g2 fill" style="align-content:start">
<div class="panel"><h3>Sending</h3>
 ${check(emailConfigured(), 'Gmail', emailConfigured() ? `${esc(config.gmailUser)} · <button class="small" onclick="verify(this)">Test login</button> <span id="vmsg"></span>` : 'GMAIL_USER / GMAIL_APP_PASSWORD missing in .env')}
 ${check(!c.q.paused, 'Sending', c.q.paused ? 'paused (header ▶ Sending to resume)' : 'on')}
 ${check(c.q.dryRun ? null : true, 'Dry run', c.q.dryRun ? 'ON — nothing is really sent (DRY_RUN=true)' : 'off — emails really go out')}
 ${check(stuck ? false : true, 'Stuck sends', stuck ? `${stuck} email(s) stuck in “sending”` : 'none')}
 ${check(true, 'Daily cap', `nvoids today ${c.q.dailyCapSentToday}/${c.q.cap} · total sent ${c.q.sentToday} · ramp ${ramp}`)}
 <div class="check"><i class="${getCcEmails().length ? 'ok' : 'warn'}">${getCcEmails().length ? '✓' : '⚠'}</i><div><b>CC recipients</b><span class="meta">Enter email addresses separated by commas. This saved dashboard list overrides CC_EMAILS in .env.</span><div style="display:flex;gap:6px;margin-top:6px"><input id="cc-emails" type="text" value="${esc(getCcEmails().join(', '))}" placeholder="name@example.com, another@example.com" style="flex:1;min-width:180px"><button class="small" onclick="saveCc(this)">Save CC</button></div><span id="cc-msg" class="meta"></span></div></div>
</div>
<div class="panel"><h3>Watcher &amp; data</h3>
 ${check(watcherPaused ? null : pollAgeMin !== null && pollAgeMin < 10 && getState('last_poll_ok', '1') === '1', 'nvoids watcher', watcherPaused ? 'paused' : lastPoll ? `last check ${esc(lastPoll)} (${pollAgeMin} min ago)${getState('last_poll_ok', '1') === '1' ? '' : ' — FAILED'}` : 'never checked')}
 ${(() => { const b = breakerState(); return check(b.until > Date.now() ? false : b.failures ? null : true, 'Circuit breaker', b.until > Date.now() ? `open — ${b.failures} failed checks; retrying at ${new Date(b.until).toLocaleTimeString()}` : b.failures ? `${b.failures} failed check(s) in a row` : 'closed (nvoids reachable)') })()}
 ${check(true, 'nvoids layout', getState('nvoids_layout', '') === 'old' ? 'Old site (job_details.jsp) — handled' : getState('nvoids_layout', '') ? 'New site (j_details.jsp)' : 'Not checked yet')}
 ${check(true, 'Rescue missed postings', `<span style="display:inline-flex;gap:6px;align-items:center">read back <input id="rh" type="number" min="1" max="48" value="6" style="width:64px;padding:3px 6px"> hours <button class="small" onclick="doRescue(this)">Rescue</button> <span id="rmsg"></span></span>`)}
 ${check(resumes.length > 0, 'Resumes', resumes.length ? `${resumes.length} found: ${resumes.map(r => esc(r.name)).join(', ')}` : `none found in ${esc(config.resumesDir)}`)}
 ${check(existsSync(join(ROOT, 'resume-lanes.json')) ? true : null, 'Resume lanes', 'resume-lanes.json (default folder, margin, title lanes)')}
 ${check(errors24 ? null : true, 'Errors (24h)', `${errors24} — see Logs`)}
 ${check(true, 'Database', `${dbSize} · ${n('SELECT COUNT(*) n FROM jobs')} jobs · ${n('SELECT COUNT(*) n FROM applications')} drafts/emails`)}
 ${check(existsSync(HISTORY_PATH), 'Sent_History.md', existsSync(HISTORY_PATH) ? esc(HISTORY_PATH) : 'not created yet')}
</div></div>
<script>async function doRescue(b){ b.disabled = true; const m = document.getElementById('rmsg'); m.textContent = 'reading nvoids… (can take a few minutes)';
  const j = await post('/api/rescue', { hours: Number(document.getElementById('rh').value) }); b.disabled = false;
  m.textContent = j.ok ? j.found + ' missed posting(s), ' + j.drafted + ' new draft(s)' : j.error; m.className = j.ok ? 'ok' : 'bad' }
async function saveCc(b){ const input = document.getElementById('cc-emails'), msg = document.getElementById('cc-msg'); b.disabled = true;
  const j = await post('/api/cc', { emails: input.value }); b.disabled = false;
  if (j.ok) { input.value = j.emails.join(', '); msg.textContent = 'Saved. Applies immediately to queued and future recruiter emails.'; msg.className = 'meta ok' }
  else { msg.textContent = j.error || 'Could not save CC recipients.'; msg.className = 'meta bad' }
}
async function verify(b){ b.disabled = true; const j = await post('/api/verify-email'); b.disabled = false; const m = document.getElementById('vmsg'); m.textContent = j.ok ? 'login OK' : j.error; m.className = j.ok ? 'ok' : 'bad' }</script>`;
}

export { CSS, CLIENT_JS };
