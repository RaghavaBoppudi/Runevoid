// nvoids.com scraper.
//
// Listing:  https://nvoids.com/index.jsp?p=N  (N=0 newest, ~100 rows/page)
//           rows: <a href="j_details.jsp?id=<int>&uid=<hex>">title</a> | location | "06:03 AM 22-Oct-26"
// Detail:   https://nvoids.com/j_details.jsp?id=..&uid=..
//           "<title> at <location>", "Email: <recruiter>", From:/Reply to: block, then
//           "Job Description -" followed by the JD. Emails are Cloudflare-obfuscated
//           (data-cfemail / #hex), decoded below.
//
// Job ids are increasing integers, so "new" = id greater than the highest id we've seen.
//
// Two site layouts are supported, so a revert doesn't break the bot:
//   NEW  listing links to j_details.jsp     OLD  listing links to job_details.jsp (any case)
// The job page itself is the same table in both: title row "<title> at <location>", an "Email:" row, the
// post (ending in "Keywords: …" + a job_details.jsp permalink), a "View All" job_email.jsp?email= link and
// the posted time. Some posts add "From:" / "Reply to:" blocks and a "Job Description -" heading; both
// shapes are read. A job page whose name no longer exists is retried under the other name. Which listing
// layout is live is remembered, and a switch is logged once (Logs tab).
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { getState, setState, logEvent } from './db.js';

// Both detail-page names, any case ("Job_details.jsp" too).
const DETAIL_LINK = /(?:^|\/)(j|job)_details\.jsp\?/i;
const TIME_RE = /\d{1,2}:\d{2}\s*(?:AM|PM)\s+\d{1,2}-[A-Za-z]{3}-\d{2}/i;
// Addresses that belong to nvoids itself (footer, "contact us"), never a recruiter.
const SITE_EMAIL = /@(?:[a-z0-9-]+\.)*nvoids\.com$/i;

function noteLayout(kind) {
  if (getState('nvoids_layout', '') === kind) return;
  const before = getState('nvoids_layout', '');
  setState('nvoids_layout', kind);
  if (before) logEvent('warn', 'layout_change', null, `nvoids switched from the ${before} layout to the ${kind} layout (${kind === 'old' ? 'job_details.jsp' : 'j_details.jsp'}); the scraper handles both`);
}

// j_details.jsp ↔ job_details.jsp, for when a stored link points at the page name the site no longer uses.
export function otherDetailUrl(url) {
  return DETAIL_LINK.test(url) ? url.replace(/(j|job)_details\.jsp/i, (_, p) => (p.toLowerCase() === 'j' ? 'job_details.jsp' : 'j_details.jsp')) : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, attempt = 1) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 3) throw new Error(`HTTP ${res.status} for ${url}`);
    await sleep(5_000 * attempt);
    return fetchText(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Cloudflare email protection: first byte is the XOR key for the rest.
export function decodeCfEmail(hex) {
  if (!hex || hex.length < 4) return '';
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

// Turns every obfuscated email in the fragment back into plain text, in place.
function deobfuscate($) {
  $('[data-cfemail]').each((_, el) => { $(el).replaceWith(decodeCfEmail($(el).attr('data-cfemail'))); });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const hex = ($(el).attr('href') ?? '').split('#')[1];
    $(el).replaceWith(decodeCfEmail(hex) || $(el).text());
  });
}

// "06:03 AM 22-Oct-26" is nvoids' own clock (India time, IST, no zone in the string).
// Returns { text: "2026-10-22 06:03" (IST), utc: ISO string } or nulls.
function parsePosted(s) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})-([A-Za-z]{3})-(\d{2})/.exec(s ?? '');
  if (!m) return { text: null, utc: null };
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  let h = Number(m[1]) % 12; if (m[3] === 'PM') h += 12;
  const mon = months[m[5]] ?? 1, day = Number(m[4]), yr = 2000 + Number(m[6]), min = Number(m[2]);
  const pad = (n) => String(n).padStart(2, '0');
  const utcMs = Date.UTC(yr, mon - 1, day, h, min) - config.nvoidsUtcOffsetMinutes * 60_000;
  return { text: `${yr}-${pad(mon)}-${pad(day)} ${pad(h)}:${pad(min)}`, utc: new Date(utcMs).toISOString() };
}

export async function fetchListingPage(page = 0) {
  const html = await fetchText(`${config.baseUrl}/index.jsp?p=${page}`);
  const $ = cheerio.load(html);
  const jobs = [];
  const seen = new Set();
  const isDetail = (_, a) => DETAIL_LINK.test($(a).attr('href') ?? '');
  let kinds = { old: 0, new: 0 };
  // Only rows that directly hold the link — the page nests tables, so outer rows would repeat every job.
  $('tr').filter((_, tr) => $(tr).children('td').find('a').filter(isDetail).length && !$(tr).find('tr').length).each((_, tr) => {
    const a = $(tr).find('a').filter(isDetail).first();
    const href = a.attr('href');
    kinds[DETAIL_LINK.exec(href)[1].toLowerCase() === 'j' ? 'new' : 'old']++;
    const url = new URL(href, config.baseUrl + '/');
    const id = Number(url.searchParams.get('id'));
    if (!id || seen.has(id)) return;
    seen.add(id);
    const tds = $(tr).find('td').toArray().map(td => $(td).text().replace(/\s+/g, ' ').trim());
    // The time is usually the 3rd column; look in every column after the title in case the order changes.
    const rawTime = tds.slice(1).find(t => TIME_RE.test(t))?.match(TIME_RE)[0] ?? tds[2] ?? '';
    const posted = parsePosted(rawTime);
    jobs.push({
      id,
      uid: url.searchParams.get('uid') ?? '',
      url: url.toString(),
      title: a.text().replace(/\s+/g, ' ').trim(),
      location_listed: (tds[1] && !TIME_RE.test(tds[1]) ? tds[1] : ''),
      posted_raw: rawTime,
      posted_at: posted.text,
      posted_utc: posted.utc,
    });
  });
  if (jobs.length) noteLayout(kinds.old > kinds.new ? 'old' : 'new');
  else if (html.length > 2000) logEvent('warn', 'layout_unknown', null, `nvoids listing page ${page} loaded but no job links were found (neither j_details.jsp nor job_details.jsp). The site layout may have changed.`);
  return jobs;
}

// Fetches a job page. If the link's page name is gone (the site switched layouts since it was listed),
// tries the other name once.
export async function fetchJobDetail(url) {
  let html;
  try { html = await fetchText(url); }
  catch (e) {
    const alt = otherDetailUrl(url);
    if (!alt || !/HTTP (404|410|500)/.test(e.message)) throw e;
    html = await fetchText(alt);
  }
  return parseJobDetail(html);
}

export function parseJobDetail(html) {
  const $ = cheerio.load(html);
  // "View All" links carry the poster's address in plain text (old layout): read them before decoding.
  const linkEmails = $('a[href*="job_email.jsp?email="]').toArray().map(a => decodeURIComponent(($(a).attr('href') ?? '').split('email=')[1] ?? '').trim());
  deobfuscate($);
  const scope = $('#outer table').length ? $('#outer table') : $('table').length ? $('table') : $('body');
  const cells = scope.find('td').toArray().map(td => {
    $(td).find('br').replaceWith('\n');
    return $(td).text().replace(/ /g, ' ');
  });
  const all = cells.join('\n');

  const ok = (e) => e && EMAIL_RE.test(e) && !SITE_EMAIL.test(e);
  const emailCell = cells.find(c => /^\s*Email:/i.test(c)) ?? '';
  const replyTo = /Reply to:\s*([^\s]+@[^\s]+)/i.exec(all)?.[1];
  const recruiterEmail = ([replyTo, emailCell.match(EMAIL_RE)?.[0], ...linkEmails, ...(all.match(new RegExp(EMAIL_RE.source, 'gi')) ?? [])]
    .find(ok) ?? '').trim().toLowerCase();

  // Posts with a From:/Job Description header (new layout's richer posts) → the text after the heading.
  // Plain posts (every post in the old layout, and some today) → all cells, as the bot has always read them.
  const fromBlock = /From:\s*([\s\S]*?)(?:Reply to:|Job Description)/i.exec(all)?.[1] ?? '';
  const fromLines = fromBlock.split('\n').map(l => l.trim().replace(/,$/, '')).filter(l => l && !EMAIL_RE.test(l));
  const jdIdx = all.search(/Job Description\s*-?/i);
  const jd = (jdIdx >= 0 ? all.slice(jdIdx).replace(/^Job Description\s*-?\s*/i, '') : all)
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    recruiter_email: recruiterEmail,
    recruiter_name: fromLines[0] || signatureName(jd),
    company: fromLines[1] ?? '',
    jd_text: jd,
    location_jd: extractLocation(jd),
  };
}

// Posts without a "From:" block are signed at the bottom: "Thanks & Regards\nPrincy Soni\nTechnical Recruiter".
export function signatureName(jd) {
  const lines = jd.split('\n').map(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^(?:thanks?(?:\s*(?:&|and)\s*regards?)?|(?:best|warm|kind)\s+regards|regards|thank\s+you|sincerely)\s*[,.!:-]*$/i.test(lines[i])) continue;
    const next = lines.slice(i + 1).find(Boolean) ?? '';
    if (/^[A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+){0,2}$/.test(next)) return next;
  }
  return '';
}

// nvoids' own location column is often wrong ("Rockville, Utah" for Rockville MD), so we also
// pull a location from the JD text and log both.
export function extractLocation(jd) {
  const labelled = /(?:^|\n)\s*(?:Location|Job Location|Work Location)\s*[:\-–]\s*([^\n]{2,80})/i.exec(jd)?.[1];
  if (labelled) return labelled.trim();
  const cityState = /(?:^|\n)\s*([A-Z][A-Za-z .'-]{2,30},\s*(?:[A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?))\s*(?:\(|\n|$)/.exec(jd.slice(0, 600))?.[1];
  if (cityState) return cityState.trim();
  if (/\b(100%\s*)?remote\b/i.test(jd.slice(0, 800))) return 'Remote';
  return '';
}

// Returns listing rows with id > sinceId, newest first. Walks back extra pages only when
// everything on the current page is new (i.e. after downtime), up to maxCatchupPages.
export async function fetchNewListings(sinceId) {
  const fresh = [];
  for (let p = 0; p < config.maxCatchupPages; p++) {
    const rows = await fetchListingPage(p);
    if (!rows.length) break;
    const newer = rows.filter(r => r.id > sinceId);
    fresh.push(...newer);
    if (newer.length < rows.length || sinceId === 0) break; // reached known ground (or first run: one page only)
    await sleep(2_000);
  }
  return fresh;
}
