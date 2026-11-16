// Weighted keyword matching between a JD and a resume — ported from the Python nvoids-resume-mailer.
//
//   score = share (0–100) of the JD's keyword WEIGHT that the resume also has
//
// A JD skill weighs more when it is in the job title (×2.5), in a "Required / Must have / Skills" section
// (×1.5), or repeated; skills everyone lists (Python, SQL, "AI", "machine learning"…) weigh half; a skill
// only in a "Preferred / Nice to have" section weighs a quarter. A resume with a closely related tool
// gets partial credit (PyTorch toward TensorFlow), and "AWS or Azure" in a JD is satisfied by either one.
// It is explainable: every point comes from a named, matched skill.
import { VOCAB, GENERIC, RELATED_PAIRS } from './vocab.js';

const TITLE_BOOST = 2.5;
const REQUIRED_BOOST = 1.5;
const PREFERRED_FACTOR = 0.25;
const GENERIC_WEIGHT = 0.5;
// Counted for scoring but never named in the email ("…experience across AI, …" reads oddly).
export const EMAIL_OMIT = new Set(['ai']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasPattern = (a) => a.split(/\s+/).map(esc).join('[\\s\\-]+');

export const TERMS = new Map();   // key → { key, display, weight, re }
for (const [display, aliases] of VOCAB) {
  const key = display.toLowerCase();
  // A skill can be extended in a later vocabulary group. Merge spellings instead of
  // silently replacing earlier aliases (for example JavaScript / ECMAScript).
  const prior = TERMS.get(key);
  const spellings = [...new Set([key, ...(prior?.spellings ?? []), ...aliases])].sort((a, b) => b.length - a.length);
  TERMS.set(key, {
    key, display, spellings,
    weight: GENERIC.has(key) ? GENERIC_WEIGHT : 1,
    re: new RegExp(`(?<![a-z0-9])(?:${spellings.map(aliasPattern).join('|')})(?![a-z0-9])`, 'g'),
  });
}

const RELATED = new Map();
for (const [a, b, credit] of RELATED_PAIRS) {
  if (!RELATED.has(a)) RELATED.set(a, new Map());
  if (!RELATED.has(b)) RELATED.set(b, new Map());
  RELATED.get(a).set(b, credit);
  RELATED.get(b).set(a, credit);
}

const normalize = (t) => String(t ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/’/g, "'").replace(/ /g, ' ');

// Skill → number of mentions in the text.
export function countTerms(text) {
  const norm = normalize(text);
  const out = new Map();
  for (const t of TERMS.values()) {
    const n = (norm.match(t.re) || []).length;
    if (n) out.set(t.key, n);
  }
  return out;
}

// nvoids adds an auto-generated "Keywords: …" line to almost every posting, and the recruiter's
// signature ("Senior Technical Recruiter - HealthTech") isn't about the job. Neither should score.
const SIGN_OFF = /^\s*(?:thanks?(?:\s*(?:&|and)\s*regards?)?|(?:best|warm|kind)\s+regards|regards|thank\s+you|sincerely)\b[\s,.!:-]*$/i;
export function cleanJd(jd) {
  const lines = String(jd ?? '').replace(/\r/g, '').split('\n');
  const sign = lines.findIndex((l, i) => i > 3 && SIGN_OFF.test(l));
  return (sign > 0 ? lines.slice(0, sign) : lines)
    .filter(l => !/^\s*keywords\s*:/i.test(l))
    .filter(l => !/^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(l))
    .join('\n');
}

// The JD split into what it requires and what it only prefers.
const REQ_START = /^\s*(?:mandatory|required|must[- ]haves?|key|primary|core|technical|minimum)?\s*(?:skills?|requirements?|qualifications?|must[- ]haves?)\b[^\n]{0,60}$/i;
const PREF_START = /^\s*(?:preferred|nice[- ]to[- ]have|good[- ]to[- ]have|desired|desirable|bonus|plus)\b/i;
const OTHER_START = /^\s*(?:responsibilit|duties|about|benefits|job description|role|overview|summary|what you)/i;
function zones(jd) {
  const req = [], pref = [], body = [];
  let zone = 'body';
  for (const l of jd.split('\n')) {
    if (PREF_START.test(l)) zone = 'pref';
    else if (REQ_START.test(l)) zone = 'req';
    else if (OTHER_START.test(l)) zone = 'body';
    (zone === 'req' ? req : zone === 'pref' ? pref : body).push(l);
  }
  return { req: req.join('\n'), pref: pref.join('\n'), body: body.join('\n') };
}

// Skill → weight for every recognised skill in the posting.
export function jdWeights(title, jdText) {
  const jd = cleanJd(jdText);
  const z = zones(jd);
  const inTitle = countTerms(title);
  const inReq = countTerms(z.req), inPref = countTerms(z.pref), inBody = countTerms(z.body);
  const weights = new Map();
  for (const key of new Set([...inTitle.keys(), ...inReq.keys(), ...inPref.keys(), ...inBody.keys()])) {
    const strong = (inTitle.get(key) ?? 0) + (inReq.get(key) ?? 0) + (inBody.get(key) ?? 0);
    const mentions = strong + (inPref.get(key) ?? 0);
    let w = TERMS.get(key).weight * (1 + 0.5 * Math.log(1 + mentions));
    if (inTitle.has(key)) w *= TITLE_BOOST;
    if (inReq.has(key)) w *= REQUIRED_BOOST;
    if (!strong) w *= PREFERRED_FACTOR;   // only ever "preferred"
    weights.set(key, w);
  }
  return weights;
}

const SKILL_HEADER = /^(?:(required|mandatory|must[- ]have|preferred|nice[- ]to[- ]have)\s+)?(?:(technical|technology|tech|programming)\s+)?(skills?|technologies|stack|tooling|tools|frameworks?|platforms?|programming languages?|requirements?|environment)(?:\s*[:\-–]\s*(.*))?$/i;
const REQUIRED_LIST_HEADER = /^(required|mandatory|must[- ]have|preferred|nice[- ]to[- ]have)\s*[:\-–]\s*(.+)$/i;
const SKILL_INTRO = /^(?:(?:strong|solid|hands-on|practical)\s+)*(?:experience|proficiency|knowledge|expertise|familiarity)\s+(?:with|in|of)\s+/i;
const SKILL_STOP = new Set([
  'ability', 'bachelor degree', "bachelor's degree", 'communication', 'collaboration', 'documentation',
  'experience', 'leadership', 'problem solving', 'teamwork', 'years',
]);
const NON_SKILL = /\b(?:\d+\+?\s+(?:years?|months?)\s+(?:of\s+)?experience|communication\s+skills?|authorized\s+to\s+work|work\s+authorization|citizenship|visa\s+sponsorship|security\s+clearance)\b/i;

function literalTermPattern(term, flags = 'g') {
  const phrase = normalize(term).trim().split(/\s+/).map(esc).join('[\\s-]+');
  return new RegExp(`(?<![a-z0-9])${phrase}(?![a-z0-9])`, flags);
}

export function countLiteralTerm(text, term) {
  return (normalize(text).match(literalTermPattern(term)) ?? []).length;
}

// Capture unlisted terms from explicit skill lists and "experience with X" clauses.
export function extraSkillWeights(jdText) {
  const out = new Map();
  let required = false, preferred = false, inSkills = false;
  const addList = (raw) => {
    const pieces = raw.replace(SKILL_INTRO, '')
      .split(/\s*(?:[,;|]|\s+\/\s+)\s*|\s+(?:and|or)\s+/i);
    for (let piece of pieces) {
      piece = piece.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .replace(/^[\s,;:•\-–—]+|[\s,;:•\-–—.]+$/g, '')
        .trim();
      const words = piece.split(/\s+/).filter(Boolean);
      if (!piece || words.length > 6 || NON_SKILL.test(piece) || SKILL_STOP.has(piece.toLowerCase()) || countTerms(piece).size) continue;
      const normalized = normalize(piece).replace(/[^\w+#.]+/g, ' ').trim().replace(/\s+/g, ' ');
      if (!normalized) continue;
      const key = `unknown:${normalized}`;
      const weight = preferred ? PREFERRED_FACTOR : required ? REQUIRED_BOOST : 1;
      const prior = out.get(key);
      out.set(key, { label: prior?.label ?? piece, weight: Math.max(prior?.weight ?? 0, weight) });
    }
  };

  for (const line of cleanJd(jdText).split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (PREF_START.test(text)) { preferred = true; required = false; }
    else if (REQ_START.test(text)) { required = true; preferred = false; }
    if (OTHER_START.test(text)) { inSkills = false; continue; }

    const header = SKILL_HEADER.exec(text);
    const requiredHeader = REQUIRED_LIST_HEADER.exec(text);
    if (header || requiredHeader) {
      const qualifier = (header?.[1] ?? requiredHeader?.[1] ?? '').toLowerCase();
      const label = (header?.[3] ?? '').toLowerCase();
      if (/preferred|nice/.test(qualifier)) { preferred = true; required = false; }
      else if (qualifier || /requirements/.test(label)) { required = true; preferred = false; }
      inSkills = true;
      const inline = header?.[4] ?? requiredHeader?.[2];
      if (inline) addList(inline);
      continue;
    }

    for (const match of text.matchAll(/\b(?:experience|proficiency|knowledge|expertise|familiarity)\s+(?:with|in|of)\s+([^.;!?]+)/gi)) {
      addList(match[1]);
    }
    for (const match of text.matchAll(/\b(?:must have|required|proficient in)\s+([^.;!?]+)/gi)) {
      addList(match[1]);
    }

    if (inSkills) {
      if (/^\s*(?:[-*•]|\d+[.)])/.test(line) || /[,;|]/.test(text) || (text.length <= 80 && !/[.!?]/.test(text))) {
        addList(text);
      } else {
        inSkills = false;
      }
    }
  }

  return out;
}

// "AWS or Azure", "Databricks/Snowflake": either one satisfies the requirement.
export function altGroups(title, jdText, extraSkills = new Map()) {
  const text = normalize(`${title}\n${cleanJd(jdText)}`);
  const spans = [];
  for (const t of TERMS.values()) for (const m of text.matchAll(t.re)) spans.push([m.index, m.index + m[0].length, t.key]);
  for (const [key, skill] of extraSkills) {
    for (const m of text.matchAll(literalTermPattern(skill.label))) spans.push([m.index, m.index + m[0].length, key]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const groups = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    const [, e1, k1] = spans[i], [s2, , k2] = spans[i + 1];
    if (k1 === k2 || s2 < e1) continue;
    if (!/^\s*(?:or|\/)\s*$/i.test(text.slice(e1, s2))) continue;
    const hit = groups.find(g => g.has(k1) || g.has(k2));
    if (hit) { hit.add(k1); hit.add(k2); } else groups.push(new Set([k1, k2]));
  }
  return groups;
}

// resumeTerms: Map skill → mentions in the resume.
export function matchOne(weights, resumeTerms, groups = []) {
  const grouped = new Set(groups.flatMap(g => [...g]));
  let total = 0, got = 0, depth = 0;
  const matched = [], missing = [], related = [];
  for (const [k, w] of weights) {
    if (grouped.has(k)) continue;
    total += w;
    if (resumeTerms.has(k)) { matched.push([k, w]); got += w; depth += w * Math.log(1 + resumeTerms.get(k)); continue; }
    missing.push([k, w]);
    const opts = RELATED.get(k);
    if (!opts) continue;
    let best = null;
    for (const [via, credit] of opts) if (resumeTerms.has(via) && (!best || credit > best[1])) best = [via, credit];
    if (best) { got += w * best[1]; related.push([k, best[0], w * best[1]]); }
  }
  for (const g of groups) {
    const members = [...g].filter(k => weights.has(k));
    if (!members.length) continue;
    const gw = members.reduce((s, k) => s + weights.get(k), 0);
    total += gw;
    const present = members.filter(k => resumeTerms.has(k));
    if (present.length) {
      const best = present.sort((a, b) => weights.get(b) - weights.get(a))[0];
      matched.push([best, gw]); got += gw; depth += gw * Math.log(1 + resumeTerms.get(best));
    } else {
      missing.push([members.sort((a, b) => weights.get(b) - weights.get(a))[0], gw]);
    }
  }
  matched.sort((a, b) => b[1] - a[1]);
  missing.sort((a, b) => b[1] - a[1]);
  return { score: total ? (100 * got) / total : 0, matched, missing, related, depth };
}

export const display = (key) => TERMS.get(key)?.display ?? key;
