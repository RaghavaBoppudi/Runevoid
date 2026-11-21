// Drafting, the Gmail connection, and the human-readable Sent_History.md.
// Nothing here decides WHEN to send — that's the paced queue in mailer.js.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import nodemailer from 'nodemailer';
import { config, emailConfigured, ROOT } from './config.js';
import { now, getState, setState, logEvent } from './db.js';
import { familyForTitle } from './resumes.js';
import { blockedAddress } from './filters.js';

export const HISTORY_PATH = join(config.dataDir, 'Sent_History.md');

function loadTemplate() {
  const raw = readFileSync(join(ROOT, 'templates', 'email.txt'), 'utf8').replace(/\r/g, '');
  const [head, ...rest] = raw.split('\n---\n');
  const subject = /^Subject:\s*(.*)$/m.exec(head)?.[1] ?? '{title}';
  return { subject, body: rest.join('\n---\n') };
}

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
    .replace(/(?:\s+-){2,}/g, ' -')       // "Title -  - Resume" when a field is empty
    .replace(/[ \t]*\(\s*\)/g, '')         // "AI Engineer () – Name" when there's no place or job id
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Only greet by name when it looks like a real name ("Preeti"), not a mailbox handle ("akushwah").
// Falls back to a first.last address ("princy.soni@…" → "Princy").
function firstName(name, email) {
  const w = (name ?? '').trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, '');
  // "Sandhya", "sandhya" or "SANDHYA" → "Sandhya"; never a role word ("Hi Hr,", "Hi Team,").
  if (w && w.length > 1 && /^[A-Za-z]/.test(w) && !/^(?:hr|team|recruiter|recruiters|recruiting|recruitment|admin|info|jobs|careers|hiring|talent|sales|support|staffing|contact|hello|dear|mr|ms|mrs)$/i.test(w))
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  const m = /^([a-z]{3,12})[._]([a-z]{2,})@/i.exec(email ?? '');
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : '';
}

// Posting titles are stuffed with noise: "No - Need TX Locals - ML Ops AI Engineer II // Coppell, TX 75019 | 3-Days/W",
// "URGENT REQUIREMENT : AI APP Engineer-W2-Onsite.-Atlanta, GA", "Only :: Contract :: Senior AI Engineer :: Fort Worth, TX".
// The headline is split into pieces at its separators; pieces that are only noise (urgency, visa, W2/C2C, local-only,
// work mode, cities/states, pay, durations, ticket numbers) are dropped, and the piece that names the role is kept.
const ROLE_WORD = /\b(?:AI|A\.I\.|ML|LLMs?|Gen ?AI|GenAI|NLP|MLOps|Data|Cloud|Engineer|Architect|Developer|Consultant|Scientist|Lead|Manager|Analyst|Specialist|Programmer|Administrator)\b/i;
const ROLE_NOUN = /\b(?:engineers?|engineering|developers?|architects?|scientists?|leads?|consultants?|analysts?|managers?|specialists?|programmers?|administrators?|admins?|fde|sre|devsecops|devops|experts?|sme|directors?|researchers?|designers?|testers?|owners?)\b/gi;
const AI_WORD = /\b(?:AI|A\.I\.|ML|GenAI|Gen AI|LLMs?|NLP|MLOps|LLMOps|RAG|Agentic)\b/;
const STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|Fl|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
// State codes that are also everyday words in titles ("Engineer OR Developer") only count as a place after a comma.
const LOOSE_CODES = STATE_CODES.split('|').filter(c => !['OR', 'IN', 'ME', 'OK', 'HI', 'DE', 'ID'].includes(c)).join('|');
const STATE_NAMES ='Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming';
const STATES = `${STATE_CODES}|${STATE_NAMES}`;
const CITY_STATE = (words) => `[A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+){0,${words - 1}}\\s*,\\s*(?:${STATES})\\b`;

// A piece, a parenthesis, or what trails the role that carries no role — only logistics.
const NOISE = new RegExp([
  String.raw`^(?:no|yes|only|need(?:ed|s)?|urgent(?:ly)?|asap|immediate(?:ly)?|hiring|now hiring|job|jobs|opening|job opening|job opportunity|requirement|urgent requirement|urgent need|urgent hiring|new requirement|title|technology|position|role|contract|long[- ]?term|short[- ]?term|c2c|corp to corp|w-?2|1099|c2h|remote|hybrid|on-?site|onsite|f2f|in[- ]?person|local|locals|direct client|client|genuine)(?:\s+(?:only|needed|required|role|position|opening|requirement|interview|candidates?|profiles?|contract|basis))*$`,
  String.raw`\blocals?\b`, String.raw`\bvisa\b`, String.raw`\bw-?2\b`, String.raw`\bc-?2-?[ch]\b`, String.raw`\bf2f\b`, String.raw`\binterview\b`,
  String.raw`\$\s?\d`, String.raw`\/\s?hr\b`, String.raw`\b\d+\+?\s*(?:years?|yrs?|months?|mos?|days?)\b`, String.raw`\bdays?\s*\/\s*w`, String.raw`^\d{3,}$`,
  String.raw`\b(?:usa|united states|canada)\b`, String.raw`\blocation\b`, String.raw`^(?:remote|hybrid|on-?site|onsite)\b`, String.raw`\bwork from (?:office|home)\b`,
  String.raw`\b(?:gc|usc|h-?1b|h4|ead|opt|cpt)\b`, String.raw`\bwithin\s+\d+\s*miles\b`,
].join('|'), 'i');
const HAS_PLACE = new RegExp(String.raw`(?:^|[\s,/(])(?:${LOOSE_CODES})(?=$|[\s,/)\d])|,\s*(?:${STATE_CODES})\b|\b(?:${STATE_NAMES})\b`);
const isNoise = (p) => NOISE.test(p.trim()) || HAS_PLACE.test(p);
const NAMES_ROLE = (s) => /\b(?:engineers?|engineering|developers?|architects?|scientists?|leads?|consultants?|analysts?|managers?|specialists?|programmers?|administrators?|fde|sre|devsecops|devops|experts?|directors?|researchers?)\b/i.test(s);

function tidyPiece(p) {
  let s = p.trim()
    .replace(/^\s*(?:job\s*title|title|position|role|technology)\s*[:\-]\s*/i, '')
    .replace(/\s*@.*$/, '')                                                                                       // "… @ Location - Louisville"
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => (isNoise(inner) || /[|,]/.test(inner) || inner.length > 40 || !inner.trim()) ? '' : m)   // "(Hybrid)", "(GenAI | RAG | …)"
    .replace(new RegExp(String.raw`\s*(?:,|\bin\b|\bat\b)\s*${CITY_STATE(3)}.*$`), '')                              // " in Fort Worth, TX …"
    .replace(new RegExp(String.raw`\s*,?\s*${CITY_STATE(1)}.*$`), '')                                              // "AI Columbus, Ohio" → "AI"
    .replace(new RegExp(String.raw`\s+(?:in|at)\s+(?:[A-Z][a-z]+\s+){0,2}(?:${LOOSE_CODES})\b.*$`), '')           // " at NJ MA", " in St Louis MO …"
    .replace(new RegExp(String.raw`\s+[A-Z][a-z]+\s+(?:${LOOSE_CODES})\b.*$`), '')                                 // " Charlotte NC"
    .replace(new RegExp(String.raw`\s*/\s*(?:${STATE_CODES})\s*$`), '');                                          // "AI/ML Engineer/AZ"
  s = s.replace(/["“”]/g, '');
  for (let i = 0; i < 5; i++) {   // leading filler: "Hiring for", "We are looking for a", "Job opening for", "Contract role of"
    const next = s.replace(/^\s*(?:we\s+are|we're|i\s+am|urgent(?:ly)?|immediate(?:ly)?|hiring|need(?:ed)?|looking|requirement|job\s+openings?|openings?|only|for|of|an?|the|contract|role|position)\b[\s:,-]*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/^[\s\-–:;,.|/_]+|[\s\-–:;,|/_]+$/g, '').trim();
}

// In the piece that names the role, drop logistics after the last role word: "Engineer-W2-Onsite.",
// "Engineer, Holmdel or Jersey City", "Engineer Genuine Visa Only".
function trimAfterRole(s) {
  const all = [...s.matchAll(ROLE_NOUN)];
  if (!all.length) return s;
  const last = all.at(-1);
  let cut = last.index + last[0].length;
  const keep = /^\s*(?:I{1,3}|IV|V|\d)\b|^\s*\([^()]{1,25}\)/.exec(s.slice(cut));   // "Engineer II", "Engineer (FDE)"
  if (keep) cut += keep[0].length;
  const rest = s.slice(cut);
  if (!rest.trim()) return s;
  if (isNoise(rest) || /^\s*[-–,]/.test(rest) || /[,.]\s*$/.test(rest) || rest.trim().split(/\s+/).length > 4) return s.slice(0, cut).trim();
  return s;
}

// "AI SOFTWARE ENGINEER" → "AI Software Engineer" (short acronyms stay upper case).
function fixShouting(s) {
  const long = s.match(/[A-Za-z]{5,}/g) ?? [];   // shouting = every 5+ letter word is upper case
  if (!long.length || long.some(w => w !== w.toUpperCase())) return s;
  return s.replace(/[A-Za-z][A-Za-z.]*/g, w => /^[A-Z]{2,4}$/.test(w) || /^(?:[A-Z]\.)+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function cleanTitle(t) {
  let base = String(t ?? '').replace(/\s*\(\s*/g, ' (').replace(/\s*\)\s*/g, ') ')   // "Intelligence(AI)consultant"
    .replace(/artificial intelligence\s*(?:\(\s*AI\s*\)|,\s*AI\b)\s*/i, 'AI ')          // "Artificial Intelligence (AI) Consultant" → "AI Consultant"
    .replace(/\bAI_ML\b/gi, 'AI/ML')
    .replace(/\s+/g, ' ').trim();
  // "Engineer, Machine Learning" / "Senior Scientist, Applied AI" → "Machine Learning Engineer" / "Senior Applied AI Scientist"
  base = base.replace(/^((?:(?:senior|sr\.?|staff|lead|principal|junior|jr\.?)\s+)*)(engineer|scientist|developer|architect)\s*,\s*([^,|()]{2,40}?)(?=\s*(?:$|[|(–—-]))/i,
    (m, lvl, noun, area) => area.split(/\s+/).length <= 4 && (AI_WORD.test(area) || /machine learning|deep learning|data science|computer vision|\bnlp\b|artificial intelligence/i.test(area)) ? `${lvl}${area.trim()} ${noun}` : m);
  base = base.replace(/\b([a-z])([a-z]+)\b/g, (w, a, b) => /^(?:consultant|engineer|architect|developer|scientist|lead|manager|analyst|specialist)$/.test(w) ? a.toUpperCase() + b : w);

  // Keep separators inside parentheses ("(GenAI | RAG)") out of the split; tidyPiece drops long parentheses anyway.
  const masked = base.replace(/\([^()]*\)/g, m => m.replace(/[|:]/g, '\u0001'));
  const pieces = masked
    .split(/\s*(?:\|\|?|::+;?|:;|\/\/|–|—|-{2,})\s*|\s+-+\s+|\s*_\s+|\s+:\s*|:\s+|-(?=(?:W2|C2C|Onsite|Remote|Hybrid|ONSITE|REMOTE|HYBRID)\b)/)
    .map(p => tidyPiece(p.replace(/\u0001/g, '|'))).filter(Boolean);

  const hasRole = (p) => (p.match(ROLE_NOUN) ?? []).length > 0;
  const i = pieces.findIndex(hasRole);
  let out;
  if (i >= 0) {
    out = trimAfterRole(pieces[i]);
    const next = pieces[i + 1];   // "Senior Architect - AI": a short AI qualifier right after the role stays
    if (next && !hasRole(next) && AI_WORD.test(next) && next.split(/\s+/).length <= 3 && !isNoise(next)) out = `${out} - ${next}`;
  } else {
    out = pieces.filter(p => !isNoise(p)).sort((a, b) => b.length - a.length)[0] ?? pieces[0] ?? base;
  }
  out = fixShouting(out).replace(/\s*,\s*/g, ', ').replace(/\s{2,}/g, ' ').replace(/[\s,.;:\-–]+$/, '').trim();
  return (out.length >= 3 ? out : base).slice(0, 90);
}

// How skill names read in "I bring 10+ years of engineering experience across …".
const SPOKEN = {
  'LLM': 'LLMs', 'Agents': 'AI agents', 'Vector DB': 'vector databases', 'Generative AI': 'Generative AI',
  'Machine learning': 'AI/ML', 'Deep learning': 'deep learning', 'Computer vision': 'computer vision',
  'Fine-tuning': 'fine-tuning', 'Prompt engineering': 'prompt engineering', 'Model serving': 'model serving',
  'Evaluation': 'model evaluation', 'Responsible AI': 'responsible AI', 'ETL': 'scalable ETL pipelines',
};
// "A and B" / "A, B, and C"; an item that itself holds a comma gets the Oxford comma too ("…, data quality frameworks, and collaborating …").
const joinAnd = (xs) => xs.length < 2 ? xs.join('') : xs.length === 2 && !xs[0].includes(',') ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')}, and ${xs.at(-1)}`;

// How the experience is described, by the kind of role.
function experienceKind(title, jd) {
  const t = `${title}`;
  if (/data scien|applied scien|research scien|machine learning scien/i.test(t)) return { what: 'enterprise data science and engineering experience', prep: 'with' };
  if (/data engineer|etl|data architect|analytics engineer|data platform/i.test(t)) return { what: 'enterprise data engineering experience', prep: 'with' };
  if (/data analyst|bi\b|business intelligence|reporting/i.test(t)) return { what: 'data analytics and engineering experience', prep: 'with' };
  if (/governance|responsible ai|model risk|ai risk|ai review|ai ethics|compliance/i.test(t)) return { what: 'AI engineering and governance experience', prep: 'across' };
  if (/product owner/i.test(t)) return { what: 'technical product and engineering experience', prep: 'across' };
  return { what: 'engineering experience', prep: 'across' };
}

// A greeting or chatter line is never a job title: "Hi, folks", "Hello", "Dear Partner", "Hope you are doing well".
const GREETING = /^\W*(?:hi+|hello|hey|hii+|dear|greetings|good\s+(?:morning|afternoon|evening|day)|hope|i\s+hope|we\s+are|we're|please|kindly|thanks?|thank\s+you|namaste|folks|team|all|partners?|recruiters?|vendors?|my\s+name|this\s+is|i\s+am|i'm|urgent\s+requirement\s*$)\b/i;
export const isGreeting = (s) => {
  const t = String(s ?? '').trim();
  return !t || GREETING.test(t) || (/[,!]$/.test(t) && t.split(/\s+/).length <= 4);
};
// The fallback when nothing in the posting names a role: a neutral name for the kind of job.
const FAMILY_TITLE = { ai: 'AI/ML Engineer', ds: 'Data Scientist', java: 'Java Developer', cloud: 'Cloud Engineer', gov: 'AI Governance Consultant', po: 'Technical Product Owner' };

// The role, preferring what the JD itself calls it:
//   1. a labelled line: "Job Title:", "Role:", "Role name:", "Position:", "Title:"
//   2. the short line right above "Location:" ("AI/ML Engineer\nLocation: Phoenix, AZ")
//   3. the cleaned headline, if it names a role (never a greeting)
//   4. the first short line near the top of the JD that names a role
//   5. the cleaned headline if it is at least not a greeting, else a neutral name for the job's family
export function roleTitle(job) {
  const jd = (job.jd_text ?? '').slice(0, 2500);
  const labelled = /^\s*(?:job\s*title|position(?:\s*(?:title|name))?|role(?:\s*(?:name|title))?|title|requirement)\s*[:\-–]+\s*(.{3,80})$/im.exec(jd)?.[1];
  if (labelled && NAMES_ROLE(labelled) && !isGreeting(labelled)) return cleanTitle(labelled.trim());
  const lines = jd.split('\n').map(l => l.trim());
  const li = lines.findIndex(l => /^(?:job\s+)?location\s*[:\-–]/i.test(l));
  if (li > 0) {
    const above = lines.slice(0, li).reverse().find(Boolean) ?? '';
    if (above.length <= 70 && above.split(/\s+/).length <= 8 && NAMES_ROLE(above) && !/[:.?!]$/.test(above) && !isGreeting(above)) return cleanTitle(above);
  }
  // "Hi Team, Urgent need of GenAI Developer" → "Urgent need of GenAI Developer" → cleaned to the role.
  const unGreeted = String(job.title ?? '').replace(/^\W*(?:hi+|hello|hey|dear|greetings|good\s+(?:morning|afternoon|evening|day))\b(?:\s+(?:team|all|folks|everyone|there|partners?|recruiters?|vendors?))?\s*[,!:\-–]+\s*/i, '');
  const head = cleanTitle(unGreeted);
  if (!isGreeting(unGreeted) && !isGreeting(head) && NAMES_ROLE(head)) return head;
  const roleLine = lines.slice(0, 30).find(l => l.length >= 4 && l.length <= 80 && l.split(/\s+/).length <= 10 && NAMES_ROLE(l)
    && !isGreeting(l) && !/@|https?:|[:.?]$/.test(l) && !/\b(?:experience|years|required|responsib|looking|seeking|hiring for)\b/i.test(l));
  if (roleLine) return cleanTitle(roleLine);
  if (!isGreeting(job.title) && !isGreeting(head) && head.length >= 3) return head;
  return FAMILY_TITLE[familyForTitle(`${job.title ?? ''} ${jd.slice(0, 400)}`)] ?? 'AI/ML Engineer';
}

// "(Phoenix, AZ – Job ID: 3778363)" / "(Remote – Job ID: …)" / "(Job ID: …)"
function placeAndId(loc, id) {
  let place = '';
  if (/^\s*(?:100%\s*)?remote\b/i.test(loc ?? '')) place = 'Remote';
  else if (loc) {
    const p = loc.replace(/\s*[(\-–|].*$/, '').replace(/,?\s*(?:USA|United States)$/i, '').trim();
    if (p.length > 2 && p.length < 40) place = p;
  }
  const idPart = id ? `Job ID: ${id}` : '';
  return [place, idPart].filter(Boolean).join(' – ');
}

// The end client when the JD names one: "initiatives at Amex", "Prior Amex (American Express) experience",
// "Client: Acme Bank". Only proper names; "our client", "a Fortune 500" etc. are ignored.
const NOT_CLIENT = /^(?:our|the|a|an|this|that|client|direct|leading|fortune|global|major|top|large|confidential|us|usa|state|federal|company|team|enterprise)$/i;
// One or two capitalised words ("Amex", "Wells Fargo", "AT&T"), never running past a period.
const NAME = String.raw`([A-Z][A-Za-z&]*[A-Za-z&](?:\s(?!The\b|This\b|And\b|Is\b|In\b|To\b)[A-Z][A-Za-z&]*)?)`;
function clientName(jd) {
  // "to support the NCDIT-T / NCDOT's rapid expansion" → "NCDIT-T/NCDOT" (agency-style acronyms, one or two).
  // Needs "the …", an "X / Y" pair or a possessive, so "to support RCM use cases" (a business area) doesn't count.
  const am = /\bsupport(?:ing)?\s+(the\s+)?([A-Z][A-Z0-9&-]{2,}(\s*\/\s*[A-Z][A-Z0-9&-]{2,})?)(['’]s)?\b/.exec(jd ?? '');
  if (am && (am[1] || am[3] || am[4])) return am[2].replace(/\s*\/\s*/g, '/');
  const pats = [
    new RegExp(String.raw`\b(?:initiatives|projects?|programs?)\s+(?:at|for)\s+${NAME}`),
    new RegExp(String.raw`\b[Pp]rior\s+${NAME}\s*(?:\([^)]*\)\s*)?experience`),
    new RegExp(String.raw`\b(?:[Ee]nd\s+)?[Cc]lient\s*[:\-–]\s*${NAME}`),
  ];
  for (const [k, re] of pats.entries()) {
    const c = re.exec(jd ?? '')?.[1]?.trim();
    // "initiatives for RCM" is a business area, not a client: short all-caps words only count when labelled.
    if (k === 0 && c && /^[A-Z]{2,4}$/.test(c)) continue;
    if (c && !NOT_CLIENT.test(c.split(/\s+/)[0]) && c.length <= 30) return c;
  }
  return '';
}


// ── Where the job is, for the subject line ("City, ST") ──────────────────────────
// Order: the JD's own location line → the posting title → the JD text → nvoids' location column (that one is
// often wrong — "Trenton, Utah" — so it is used only when the JD or title also names that city and state).
// Several locations → the first. A remote-first location → "Remote". Nothing found → '' (subject drops the part).
const US_STATES = { alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO', connecticut:'CT', delaware:'DE',
  'district of columbia':'DC', florida:'FL', georgia:'GA', hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS',
  kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO',
  montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY', 'north carolina':'NC',
  'north dakota':'ND', ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD',
  tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY' };
const US_CODES = new Set(Object.values(US_STATES));
const US_STATE_NAMES = Object.keys(US_STATES).sort((a, b) => b.length - a.length).join('|');
const CONNECT = /^(?:of|de|la|du|del|des|on|upon)$/;   // lowercase joiners only ("King of Prussia"); "Los", "San", "St." are city words
const NOT_CITY = /^(?:hybrid|onsite|on-?site|remote|location|locations?|local|locals|need|needs|urgent|position|role|only|job|work|based|out|in|at|for|the|and|or|day|days|candidates?|client|direct|contract|full|time|fte|w2|c2c|engineer|developer|lead|senior|sr\.?|state|office|from|near|with|preferred|must|be|is|a|an|to|interview|hiring|opening|opportunity|requirement|resume|any|visa|us|usa|united|states)$/i;
const titleCase = (w) => /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1);
// The city: the run of words right before the state, after the last separator, without filler words.
function cityBefore(text, loose) {
  const seg = text.split(/\|\||[|/:;()\[\]•–—]|\s-+\s|\s-|-\s|\bat\b|\bin\b|\bfor\b|\bfrom\b|\bnear\b|\bto\b/i).pop() ?? '';
  const words = seg.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = words.length - 1; i >= 0 && out.length < 4; i--) {
    const w = words[i].replace(/[^A-Za-z.'-]/g, '');
    if (!w) break;
    if (CONNECT.test(w) && out.length) { out.unshift(w.toLowerCase()); continue; }
    if (NOT_CITY.test(w) || !(loose || /^[A-Z]/.test(w))) break;
    out.unshift(titleCase(w));
  }
  while (out.length && CONNECT.test(out[0])) out.shift();
  const city = out.join(' ').replace(/\.$/, '');
  return city.length >= 3 ? city : '';
}
// First "City, ST" / "City, State" in a piece of text (loose = a location field, where "louisville KY" counts).
function findCityState(text, loose = false) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const re = new RegExp(String.raw`,\s*(${US_STATE_NAMES})\b|,\s*([A-Z]{2})\b(?![a-z])` + (loose ? String.raw`|\s([A-Z]{2})\b(?![a-z])` : ''), 'gi');
  for (const m of t.matchAll(re)) {
    const code = m[1] ? US_STATES[m[1].toLowerCase()] : (m[2] ?? m[3]);
    if (!US_CODES.has(code) || (!m[1] && code !== (m[2] ?? m[3]))) continue;   // codes must be capitals: "in", "or", "me" are words
    if (!m[1] && !/[A-Z]{2}/.test(m[2] ?? m[3])) continue;
    const city = cityBefore(t.slice(0, m.index), loose);
    const asState = US_STATES[city.toLowerCase()];   // "Virginia, MD" is two states; "New York, NY" / "Washington, DC" are cities
    if (city && (!asState || asState === code || (code === 'DC' && /^washington$/i.test(city)))) return `${city}, ${code}`;
  }
  return '';
}
export function cityState(job) {
  const loc = String(job.location_jd ?? '').trim();
  if (/^\W*(?:100\s*%\s*)?remote\b/i.test(loc)) return 'Remote';
  const jd = String(job.jd_text ?? '');
  const labelled = [...jd.matchAll(/(?:^|\n)\s*(?:job\s+|work\s+)?locations?\s*[:\-–]+\s*([^\n]{2,90})/gi)].map(m => m[1]);
  for (const [text, loose] of [[loc, true], ...labelled.map(l => [l, true]), [job.title, false], [jd.slice(0, 1500), false]]) {
    const hit = findCityState(text, loose);
    if (hit) return hit;
  }
  // nvoids' column ("Phoenix, Arizona, USA"): only if the posting itself names that city and state.
  const listed = /^\s*([^,]+),\s*([^,]+)/.exec(job.location_listed ?? '');
  if (listed) {
    const code = US_STATES[listed[2].trim().toLowerCase()] ?? (US_CODES.has(listed[2].trim()) ? listed[2].trim() : '');
    const city = listed[1].trim();
    const hay = `${job.title ?? ''}\n${jd}`;
    const named = (w) => new RegExp(String.raw`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'i').test(hay);
    if (code && !/^remote$/i.test(city) && named(city) && (new RegExp(String.raw`\b${code}\b`).test(hay) || named(listed[2].trim()))) return `${city}, ${code}`;
  }
  if (/\b(?:100\s*%\s*)?remote\b/i.test(`${loc} ${job.title ?? ''}`)) return 'Remote';
  return '';
}

// The article for a role as it is spoken: vowel sound → "an". Acronyms go by their first letter's name
// (ML = "em-el" → an, FDE = "ef" → an, GenAI = "gen" → a).
function articleFor(title) {
  const w = String(title ?? '').trim().split(/[\s/-]+/)[0] ?? '';
  if (/^[A-Z]{2,}/.test(w)) return /^[AEFHILMNORSX]/.test(w) ? 'an' : 'a';
  if (/^(?:uni|use|usu|eu|one|once)/i.test(w)) return 'a';
  if (/^(?:hour|honest|heir)/i.test(w)) return 'an';
  return /^[aeiou]/i.test(w) ? 'an' : 'a';
}

// `chosen` is one entry of the resume ranking ({ folder, path, matched, background, … }). The skills
// and background lines only name things found in BOTH the JD and that resume, so the email never claims
// what the resume doesn't show.
export function buildDraft(job, chosen, { thin = false } = {}) {
  const tpl = loadTemplate();
  const location = job.location_jd || job.location_listed || '';
  const jdText = job.jd_text ?? '';
  const jdHasAi = /\bA\.?I\.?\b|artificial intelligence/i.test(`${job.title}\n${jdText}`);
  const say = (k) => {
    if (/^machine learning$/i.test(k)) return jdHasAi ? 'AI/ML' : 'machine learning';
    if (k === 'generative AI') return 'Generative AI';
    if (k === 'LLM') return 'LLMs';
    if (k === 'ETL') return 'scalable ETL pipelines';
    if (k === 'agentic AI') return 'agentic AI';
    if (k === 'Databricks' && /azure databricks/i.test(jdText)) return 'Azure Databricks';
    return SPOKEN[k] ?? k;
  };
  const background = chosen.background ?? [];
  const inBackground = (s) => background.some(b => b.toLowerCase().includes(s.toLowerCase()));
  // The skills sentence names tools and fields, not practices ("data quality", "data pipelines" belong in the
  // background line), and nothing the background line already says.
  const CONCEPT = /^(?:data (?:quality|governance|lineage|modeling|architecture|pipelines|migration|mesh|science|warehouse|lake|catalog)|metadata management|big data|batch processing|streaming|reconciliation|performance tuning|dimensional modeling|mdm|cdc|statistics|full-stack|distributed systems|microservices|unstructured data|information retrieval|model training|model deployment|model monitoring)$/i;
  const clean = (list) => {
    let out = [...new Set(list.filter(k => !CONCEPT.test(k)).map(say))].filter(s => !inBackground(s));   // Power BI named in the background line isn't repeated
    if (out.some(s => /^Azure \w/.test(s))) out = out.filter(s => s !== 'Azure'); // "Azure Databricks" already says Azure
    return out;
  };
  // Skills the JD asks for that the resume has (JD order); topped up from the resume's own core skills
  // (Python, SQL, …) when that gives fewer than 4. Every one is on the attached resume either way.
  const raw = [...(chosen.matched ?? [])];
  for (const k of chosen.core ?? []) {
    if (clean(raw).length >= 4) break;
    if (!raw.includes(k)) raw.push(k);
  }
  const skills = clean(raw).slice(0, 5);
  const title = withoutPlace(roleTitle(job), job);
  const kind = experienceKind(title, jdText);
  const client = clientName(job.jd_text);
  const first = firstName(job.recruiter_name, job.recruiter_email);
  const years = config.senderYears;
  const sig = [config.senderName, config.senderPhone && `Phone: ${config.senderPhone}`, config.senderEmail && `Email: ${config.senderEmail}`, config.senderSignature]
    .filter(Boolean).join('\n');
  const vars = {
    title,
    // "an AI Developer", "a Senior AI Engineer", "an ML Engineer", "an FDE": the article said aloud before the role.
    a_title: `${articleFor(title)} ${title}`,
    // Locked: the job ID never appears in a recruiter email, and the location never appears in the body.
    // These stay empty even if a template asks for them.
    location: '', location_part: '', place_id: '', job_id: '',
    // The one exception: "City, ST" in the SUBJECT ("AI Engineer - Dallas, TX - Raghava Boppudi"). Use {subject_place}
    // only on the Subject line; the body check below still blocks the location anywhere in the body.
    subject_place: (() => { const p = cityState(job); return p ? ` - ${p}` : ''; })(),
    greeting: first ? `Hi ${first},` : 'Hi,',
    recruiter_first: first,
    company: job.company ?? '',
    // "supporting Amex initiatives" for a company; "supporting NCDIT-T/NCDOT" for an agency acronym
    client_part: client ? ` supporting ${client}${/^[A-Z0-9&\/-]+$/.test(client) && /[\/-]/.test(client) ? '' : ' initiatives'}` : '',
    experience_line: skills.length ? `I bring ${years} years of ${kind.what} ${kind.prep} ${joinAnd(skills)}.` : `I bring ${years} years of ${kind.what}.`,
    background_line: background.length ? `My background includes ${joinAnd(background)}.` : '',
    // The neutral close is only for a draft with nothing specific to say.
    closing: thin && !skills.length && !background.length ? 'I would welcome the chance to discuss the opportunity. Resume attached.'
                  : 'My experience aligns closely with this role, and I would welcome the chance to discuss it. Resume attached.',
    sender_name: config.senderName,
    signature_block: sig,
    signature: config.senderSignature,
  };
  return { subject: fill(tpl.subject, vars), body: fill(tpl.body, vars), location };
}

// ── Locked email format ──────────────────────────────────────────────────────
// Only C2C and H1B are ever bold. Any other **markdown** in the text is stripped, so neither the
// template nor an edit in the dashboard can bold anything else.
const BOLD = /\b(C-?2-?C|H-?1-?B)\b/gi;
const plainText = (body) => body.replace(/\*\*/g, '');
const escHtml = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function toHtml(body) {
  const html = escHtml(plainText(body)).replace(BOLD, '<b>$1</b>').replace(/\n/g, '<br>\n');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${html}</div>`;
}

// Never let the job board's name reach a recruiter.
export function assertNoSourceMention(...parts) {
  if (parts.some(p => /nvoids/i.test(p ?? ''))) throw new Error('This email mentions "nvoids". Remove it from the subject/body before sending.');
}

// Where the job is, as the pieces we look for: "Louisville KY" → ["Louisville, KY", "Louisville KY"].
function placeStrings(job) {
  const out = new Set();
  for (const raw of [job?.location_jd, job?.location_listed]) {
    const p = String(raw ?? '').replace(/\s*[(|–-].*$/, '').replace(/,?\s*(?:USA|United States)$/i, '').trim();
    if (p.length < 4 || /^(?:remote|hybrid|onsite|on-site)\b/i.test(p)) continue;
    if (NAMES_ROLE(p) || AI_WORD.test(p)) continue;   // a mis-read "location" like "AI Engineer" is not a place
    const m = /^([A-Za-z .'-]{3,}?)\s*,?\s+([A-Za-z][A-Za-z ]+)$/.exec(p);
    out.add(p);
    if (m) { out.add(`${m[1]}, ${m[2]}`); out.add(`${m[1]} ${m[2]}`); }
  }
  return [...out];
}

// Cut the job's own location out of a role title ("AI Engineer Louisville KY" → "AI Engineer").
function withoutPlace(title, job) {
  let t = title;
  for (const p of placeStrings(job)) {
    const re = new RegExp(String.raw`\s*(?:[-–|,:/]|\b(?:in|at|for)\b)?\s*\(?${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\)?`, 'ig');
    const next = t.replace(re, '').trim();
    if (next.length >= 3) t = next;
  }
  return t.replace(/\s*[-–|,:/(]+\s*$/, '').trim();
}

// Locked rule: no job ID anywhere, and no job location in the BODY (the subject may carry "City, ST").
// Checked on approve and again right before sending, so an edit in the dashboard can't put them back.
export function assertNoJobDetails(job, subject, body) {
  const role = String(subject ?? '').split(/\s+[–-]\s+/)[0];
  if (isGreeting(role)) throw new Error(`The subject starts with “${role}”, which is a greeting, not a job title. Put the role in the subject.`);
  const text = `${subject ?? ''}\n${body ?? ''}`;
  if (/\b(?:job|req(?:uisition)?)\s*(?:id|#|no\.?|number)\b/i.test(text)) throw new Error('This email mentions a job ID. Remove it before sending: job IDs never go in your emails.');
  const ids = [job?.id, job?.ref_id].filter(v => v && String(v).length >= 4).map(String);
  const id = ids.find(v => new RegExp(String.raw`(?<![\w-])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\w-])`).test(text));
  if (id) throw new Error(`This email contains the job number ${id}. Remove it before sending.`);
  const place = placeStrings(job).find(p => String(body ?? '').toLowerCase().includes(p.toLowerCase()));
  if (place) throw new Error(`The email body mentions the job location (“${place}”). Remove it before sending: the location only goes in the subject.`);
}

let transporter = null;
function getTransport() {
  transporter ??= nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
  });
  return transporter;
}

export async function verifyEmail() {
  if (!emailConfigured()) return { ok: false, error: 'GMAIL_USER / GMAIL_APP_PASSWORD not set in .env' };
  try { await getTransport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Everyone CC'd on a recruiter email, minus the recipient themself.
export function getCcEmails() {
  const saved = getState('cc_emails');
  const value = saved === null ? config.ccEmails.join(',') : saved;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function setCcEmails(raw) {
  const unique = normalizeCcEmails(raw);
  const blocked = unique.find(c => blockedAddress(c));
  if (blocked) throw new Error(`${blocked} is on your Blocked list, so it can't be CC'd.`);
  setState('cc_emails', unique.join(','));
  logEvent('info', 'cc_updated', null, `Dashboard CC list updated (${unique.length} recipient${unique.length === 1 ? '' : 's'})`);
  return { emails: unique };
}

export function normalizeCcEmails(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) throw new Error('Enter up to 25 email addresses, separated by commas.');
  const addresses = raw.split(/[;,\n]/).map(s => s.trim()).filter(Boolean);
  if (addresses.length > 25) throw new Error('You can add up to 25 CC email addresses.');
  const valid = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
  const invalid = addresses.find(address => !valid.test(address));
  if (invalid) throw new Error(`“${invalid}” doesn’t look like a valid email address.`);
  return [...new Map(addresses.map(address => [address.toLowerCase(), address])).values()];
}

export function ccFor(to) {
  return getCcEmails().filter(c => c.toLowerCase() !== String(to).trim().toLowerCase());
}

// The single place an email leaves the machine. Returns the Gmail message id.
// `cc` defaults to CC_EMAILS; the test email passes [] so it only goes to you.
export async function deliver({ to, subject, body, resumePath, cc = ccFor(to) }) {
  if (!emailConfigured()) throw new Error('Gmail is not configured — set GMAIL_USER and GMAIL_APP_PASSWORD in .env');
  // Last line of defence for the Blocked list (Vendors tab): every email goes through here, so nothing — a held
  // email's Send Anyway, an edited To, a test, a path added later — can reach a blocked address.
  const blockedTo = blockedAddress(to);
  if (blockedTo) throw new Error(`Not sent: ${to} is on your Blocked list (“${blockedTo}”).`);
  const droppedCc = cc.filter(c => blockedAddress(c));
  if (droppedCc.length) { cc = cc.filter(c => !blockedAddress(c)); logEvent('warn', 'blocked_cc', null, `Left blocked address(es) out of CC: ${droppedCc.join(', ')}`); }
  if (!existsSync(resumePath)) throw new Error(`Resume file is missing: ${resumePath}`);
  assertNoSourceMention(subject, body);
  const info = await getTransport().sendMail({
    from: config.senderName ? `"${config.senderName}" <${config.gmailUser}>` : config.gmailUser,
    to,
    ...(cc.length ? { cc } : {}),
    subject: plainText(subject),
    text: plainText(body),
    html: toHtml(body),
    attachments: [{ filename: basename(resumePath), path: resumePath }],
  });
  return info.messageId ?? null;
}

// A complete sample email with a real resume attached, sent only to your own Gmail address.
export async function sendTestToSelf(resumePath) {
  const job = { id: 0, title: 'Senior GenAI Engineer (sample)', location_jd: 'Remote', recruiter_name: config.senderName, company: '' };
  const d = buildDraft(job, { matched: ['Python', 'LLM', 'RAG', 'LangChain'] });
  return deliver({ to: config.gmailUser, subject: `[TEST] ${d.subject}`, body: d.body, resumePath, cc: [] });
}

// Human-readable log, appended right after each real send. Never read back by the program.
export function appendHistory(app, job) {
  const header = existsSync(HISTORY_PATH) ? '' : '# Sent History\n\nEvery email RUNE actually sent, oldest first.\n\n---\n\n';
  const jd = (job.jd_text ?? '').replace(/```/g, "'''");
  const entry = `${header}## ${app.sent_at ?? now()} — ${job.title}

- **To:** ${app.to_email}${job.recruiter_name ? ` (${job.recruiter_name}${job.company ? `, ${job.company}` : ''})` : ''}${(() => { const cc = app.cc_emails === null || app.cc_emails === undefined ? ccFor(app.to_email) : app.cc_emails.split(',').filter(Boolean); return cc.length ? `\n- **CC:** ${cc.join(', ')}` : ''; })()}
- **Resume folder:** ${app.resume_folder} (${app.match_score ?? '?'}% match) — \`${app.resume_path}\`
- **Location:** ${app.location || job.location_listed || 'unknown'}
- **Approved:** ${app.approved_at ?? ''} · **Sent:** ${app.sent_at ?? ''}
- **Posting:** ${job.source === 'manual' ? `MANUAL #${job.id} (pasted by you${job.ref_id ? `, their job ID ${job.ref_id}` : ''})` : `${job.url} (nvoids #${job.id}, posted ${job.posted_raw ?? ''})`}
- **Subject:** ${app.subject}

\`\`\`
${app.body}
\`\`\`

<details><summary>Job description</summary>

\`\`\`
${jd}
\`\`\`

</details>

---

`;
  appendFileSync(HISTORY_PATH, entry, 'utf8');
}
