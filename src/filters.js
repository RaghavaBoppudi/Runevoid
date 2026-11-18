// Which postings get a draft. Three tiers, checked in this order:
//   1. SKIP   (EXCLUDE_TITLE, EXCLUDE)  — never drafted; the reason is logged under "All scraped".
//   2. KEEP   AI/ML roles only: an AI/ML term in the title, or (for a generic technical title)
//             at least MIN_AI_JD_TERMS distinct AI/ML technologies in the JD. Everything else is skipped.
//   3. FLAG   (FLAGS) — still drafted, but the draft shows a warning so you read it before approving.
// Patterns ported from the Python nvoids-resume-mailer, which tuned them on ~6,000 real nvoids postings.
// Every entry is a case-insensitive regex; add or delete lines to widen or narrow what you get.

// ── 1a. Skip if the TITLE matches ────────────────────────────────────────────
import { cleanJd } from './matcher.js';
import { db } from './db.js';
import { config } from './config.js';

const EXCLUDE_TITLE = [
  /hot[\s\-_.]*list/i,                                         // consultant hotlists
  /^\W*(?:updated\s+)?(?:resume|profile|cv)s?\s+(?:of|for)\b/i, // "Resume of …" = a consultant being marketed
  /\b(?:looking\s+for|open\s+to|seeking)\s+(?:a\s+)?(?:new\s+)?(?:project(?!\s+(?:manag|coordinat|lead|engineer|analyst|admin|director|owner|control|plan|office|portfolio|scheduler))s?|opportunit(?:y|ies)|assignment)s?\b/i,
  /\bin\s+response\s+(?:of|to)\s+your\b/i,
  /^\W*application\s*:/i,
  /\bbench\b/i, /consultants? available/i, /candidates? available/i, /available (?:consultants?|candidates?)/i,
  // not engineering roles, even when the JD name-drops an AI stack
  /business analyst/i, /product (?:manager|analyst)/i, /(?:project|program) manager/i, /scrum master/i,
  /product owner/i, /\bqa\b/i, /\btester\b/i, /\bsdet\b/i, /\bdesigner\b/i, /\bintern(?:ship)?\b/i, /test manager/i,
  /marketing\s+(?:specialist|manager|coordinator|associate)/i, /enablement coach/i, /\bpayroll\b/i,
  // package-specific roles (title only: a JD that merely integrates with SAP etc. is fine)
  /\bsap\b/i, /\bmainframes?\b/i, /\bcobol\b/i, /\bsalesforce\b/i, /\bpeoplesoft\b/i, /\bworkday\b/i,
  /\bservicenow\b/i, /\bguidewire\b/i, /\baem\b/i,
  // site ads
  /resumes? for just/i, /hrtech offerings/i, /job board software/i,
];

// ── 1b. Skip if the TITLE or JD matches ───────────────────────────────────────
const EXCLUDE = [
  // W2 / no C2C (you are doing C2C)
  /\bw-?2\s*only\b/i, /\bonly\s*w-?2\b/i, /\bw-?2 requirements?\b/i, /\bmust be w-?2\b/i, /\bw-?2 preferred\b/i,
  /\bw-?2 candidates\b/i, /\brequires w-?2\b/i, /\bw-?2\b role/i, /\bw-?2\b contract/i,
  /\bno\s*c-?2-?c\b/i, /\bc-?2-?c (?:is )?not (?:allowed|accepted|open|possible|considered)\b/i,
  /\bnot (?:open|accepting) (?:to|for) c-?2-?c\b/i, /\bno\s*corp[- ]to[- ]corp\b/i, /\bno\s*third[- ]part(?:y|ies)\b/i,
  /\bc2h only\b/i, /\bonly c2h\b/i, /\bcontract-?to-?hire only\b/i,
  // citizenship / visa / clearance
  /\b(?:usc|us citizens?|citizens?|gc)(?: and| or|\/|,)? ?(?:usc|gc|ead)? only\b/i, /\bgreen card only\b/i,
  /\bgc\/?usc only\b/i, /\bonly gc\/?usc\b/i, /\bno h-?1b\b/i, /\bh-?1b (?:is )?not\b/i,
  /\bnot (?:open|accepting) (?:to|for) h-?1b\b/i, /\bts\/sci\b/i, /\bsecret clearance\b/i, /\bclearance required\b/i,
  // consultant-marketing posts (someone advertising a candidate, not a job)
  /\bcandidate hotlist\b/i, /\bhotlist attached\b/i, /\bupdated hotlist\b/i,
  /\b(?:i|we) have an? [^.\n]{0,80}consultants? (?:is |are )?available\b/i,
  /resume\s+of\s+(?:my|our)\s+(?:consultants?|candidates?)\b/i,
  /\b(?:attach\w*|attaching|find|sharing|shared)\b[^.\n]{0,60}\b(?:resume|profile|cv)\b[^.\n]{0,30}\b(?:of|for)\s+(?:my|our|one\s+of\s+my)\s+(?:consultants?|candidates?)\b/i,
  /\bmy\s+(?:consultant|candidate)\s+(?:is|was|has|have|who|having|ready|available|can|would)\b/i,
  /\bmy\s+(?:consultant|candidate)'?s?\s+(?:resume|profile)\b/i,
  /\bdetails\s+of\s+my\s+(?:consultants?|candidates?)\b/i, /\bconsultant\s+submission\s+details\b/i,
  /\bavailable\s+for\s+(?:c2c|w2|contract|new)\s+opportunit/i,
];
// A candidate sheet: a "Name:" line followed later by Relocation / Visa / PP number / DOB lines.
const CANDIDATE_SHEET = /^\W*name\s*[:\-][\s\S]{0,1500}?^\W*(?:relocation|visa(?:\s*status)?|pp\s*(?:number|no)|dob)\s*[:\-]/im;

// ── 2. Keep only AI/ML roles ─────────────────────────────────────────────────
const AI_TITLE = [
  /\bai\b/i, /\ba\.i\./i, /\bai[\s/-]?ml\b/i, /\bml\b/i, /machine[\s-]?learning/i, /deep[\s-]?learning/i, /\bneural\b/i,
  /\bllms?\b/i, /gen(?:erative)?[\s-]?ai/i, /\bgenerative\b/i, /\bagentic\b/i, /\brag\b/i, /prompt engineer/i,
  /foundation model/i, /vector (?:database|search|db)/i, /\bopenai\b/i, /lang(?:chain|graph)/i, /hugging ?face/i,
  /forward[\s-]?deployed/i, /\bfde\b/i,
  /\bmlops\b/i, /\bllmops\b/i, /sagemaker/i, /\bbedrock\b/i, /vertex ai/i, /azure (?:ai|machine learning|openai)/i,
  /tensorflow|pytorch/i, /data[\s-]?scien/i, /applied[\s-]?scientist/i, /research[\s-]?(?:scientist|engineer)/i,
  /\bnlp\b/i, /natural language/i, /computer vision/i, /speech (?:recognition|ai)|voice ai/i, /conversational ai/i,
  /chat ?bots?/i, /recommend(?:ation|er) (?:system|engine)s?/i, /artificial intelligence/i,
];
// Deeper JD check for AI roles whose headline doesn't say so; needs several distinct hits.
const AI_JD_TERMS = [
  /\bLLMs?\b/i, /large language model/i, /generative ai|\bgenai\b|gen ai/i, /\bRAG\b|retrieval[- ]augmented/i,
  /langchain|llamaindex|langgraph/i, /vector (?:db|database|search|store)|pinecone|weaviate|faiss|chroma|pgvector/i,
  /machine learning/i, /deep learning/i, /pytorch|tensorflow|keras|\bjax\b/i, /hugging ?face|\btransformers\b/i,
  /\bmlops\b|mlflow|kubeflow|sagemaker|vertex ai|azure ml|bedrock|databricks ml/i,
  /fine[- ]?tun/i, /prompt engineering/i, /\bnlp\b|natural language processing/i, /computer vision|\bopencv\b/i,
  /\bagents?\b.*\b(?:ai|llm)|agentic|autogen|crewai/i, /openai|anthropic|claude|gpt-?4|gemini|llama/i,
  /scikit-learn|sklearn|xgboost|lightgbm/i, /model (?:training|serving|deployment|evaluation)/i,
  /\bembeddings?\b/i, /re-?rank/i, /(?:semantic|hybrid) search/i, /\bguardrails?\b/i, /multi[- ]agent/i,
  /model context protocol|\bMCP\b/, /\bllmops\b|llm (?:evaluation|orchestration|observability)/i,
  /\bvllm\b|\bkserve\b|\bragas\b|trulens/i, /feature stores?|(?:model|data) drift/i,
  /recommend(?:ation|er) (?:system|engine)s?|contextual bandits?/i, /foundation models?/i,
];

// ── 3. Flags: drafted, but with a warning ────────────────────────────────────
const FLAGS = [
  { where: 'body',  re: /^\s*hotlist\s*$/im, say: "nvoids tagged this post 'hotlist' (that group carries real jobs and consultant profiles): check it's a job" },
  { where: 'body',  re: /\bbench\s+sales\s+(?:recruiter|executive|manager|specialist|team)\b/i, say: 'Signed by a bench-sales recruiter: may be a consultant profile, not a requirement' },
  { where: 'any',   re: /\(\s*(?:no|need|avoid|only)\s*(?:and|or|,)?\s*\)|\bneed\s+or\b|\bonly\s+or\b|\bavoid\s+and\b/i, say: 'nvoids removed words from this post (a visa/work-authorization restriction may be hidden): read the posting before sending' },
  { where: 'title', re: /\b(?:h4\s*-?\s*ead|gc\s*-?\s*ead|opt|cpt|usc)\b/i, say: 'The title names a work-authorization status (H4 EAD / GC EAD / OPT / CPT / USC): check it fits you' },
  { where: 'any',   re: /only\s+local|locals?\s+only|local\s+(?:candidates?|profiles?)\s+only|must be local/i, say: 'Local candidates only: send only if you are local or can be on site' },
  { where: 'any',   re: /\bw-?2\b/i, say: 'Mentions W2 (not "W2 only"): check that C2C is accepted' },
];

const first = (list, text) => list.find(re => re.test(text));

// Face-to-face interviews: skipped (a remote/video interview for an onsite job is fine).
const F2F = [
  /\bf2f\b/i, /\bface[\s-]*to[\s-]*face\b/i, /\bin[\s-]*person\s+(?:final\s+)?interviews?\b/i,
  /\b(?:on[\s-]?site|onsite)\s+(?:final\s+)?interviews?\b/i, /\binterview(?:s)?\s*(?:will be|is|:)?\s*(?:in[\s-]*person|on[\s-]?site|onsite)\b/i,
];

// A title that only uses AI as an adjective ("AI-assisted testing", "AI-enabled analytics", "AI tools")
// is not an AI/ML role by title; such a posting must qualify through its JD instead.
const INCIDENTAL_AI = new RegExp([
  String.raw`\b(?:ai|ml|ai\/ml|aiml|genai|gen ai|llm)[\s-]+(?:assisted|enabled|native|powered|driven|based|augmented|infused|first|tools?|exposure|integration|experience|knowledge|skills?|literacy|awareness|adoption)\b`,
  String.raw`\bwith\s+(?:some\s+)?(?:ai|ml|ai\/ml|aiml|genai|gen ai|llm)\b(?:\s+(?:exposure|experience|knowledge|skills?))?`,
].join('|'), 'gi');

// ── 2b. Off-lane titles: the title is anchored to a non-AI stack, so "AI" in it is a qualifier
// ("Java Full Stack Lead (AI-LLM Integration)", ".NET Developer with AI", "AI Infra DevOps Engineer").
// Skipped even when the title also says AI. Delete a line to let that lane back in.
const OFF_LANE_TITLE = [
  /\bjava\b/i, /\bj2ee\b/i, /\bspring\b/i, /\.net\b|\bdot\s?net\b|\bc#/i,
  /\breact\b/i, /\bangular\b/i, /\bvue\b/i, /\bnode(?:\.?js)?\b/i, /front[\s-]?end/i, /\bui\b/i, /\bandroid\b/i,
  /(?<!\bai[\s-]{0,3})\bfull[\s-]?stack\b(?![\s-]*ai\b)/i,         // "AI Full Stack" / "Full Stack AI" stay in
  /dev[\s-]?ops/i, /\binfra(?:structure)?\b/i, /\bsre\b/i, /site reliability/i, /kubernetes|\bk8s\b/i,
  /platform engineer/i, /cloud\s+(?:engineer|architect|admin|developer|ops)/i, /\bnetwork\b/i,
  /\bsecurity\b/i, /\bsiem\b/i, /log ingestion/i, /\bdba\b/i, /\betl\b/i, /data engineer/i,
  /governance|responsible ai|ai ethics|model risk|\bai risk\b|compliance/i,
  /\banalytics\b/i, /\banalyst\b/i,
];
// A generic title needs to at least name a technical role before the JD is allowed to qualify it.
const TECH_ROLE_TITLE = /\b(?:engineers?|developers?|programmers?|scientists?|researchers?|architects?|modelers?|leads?|specialists?|consultants?|experts?|smes?|mlops|llmops)\b/i;

// Vendor blacklist (Vendors tab). A term matches the recruiter's email domain or address, the company
// name, or appears as a phrase in the JD (e.g. "tanisha systems" in a gmail posting's signature).
export function blacklistTerms() {
  try { return db.prepare(`SELECT term FROM vendor_blacklist`).all().map(r => r.term); } catch { return []; }
}
export function blacklistHit(job) {
  const terms = blacklistTerms();
  if (!terms.length) return '';
  const email = String(job.recruiter_email ?? job.to_email ?? '').toLowerCase();
  const company = String(job.company ?? '').toLowerCase();
  const text = `${job.title ?? ''}\n${job.jd_text ?? ''}`.toLowerCase();
  for (const term of terms) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    if (t.includes('@') ? email === t : email.split('@')[1]?.includes(t.replace(/^@/, ''))) return term;
    const re = new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}(?![a-z0-9])`, 'i');
    if (re.test(company) || re.test(text)) return term;
  }
  return '';
}

export function classify(job) {
  const title = job.title ?? '';
  const jd = cleanJd(job.jd_text ?? '');   // without nvoids' auto "Keywords:" line, which names AI terms on non-AI posts
  const both = `${title}\n${jd}`;

  const bl = blacklistHit(job);
  if (bl) return { keep: false, reason: `blacklisted vendor: ${bl}`, flags: [] };
  const t = first(EXCLUDE_TITLE, title);
  if (t) return { keep: false, reason: `title skip: "${title.match(t)[0].trim()}"`, flags: [] };
  const e = first(EXCLUDE, both);
  if (e) return { keep: false, reason: `skip: "${both.match(e)[0].trim()}"`, flags: [] };
  const f2f = first(F2F, both);
  if (f2f) return { keep: false, reason: `skip: face-to-face interview ("${both.match(f2f)[0].trim()}")`, flags: [] };
  if (CANDIDATE_SHEET.test(jd.slice(0, 4000))) return { keep: false, reason: 'skip: consultant profile sheet, not a job', flags: [] };

  // An AI/ML term in the title is sufficient ("Gen AI Engineer", "ML Engineer II", "AI/ML Lead").
  // A generic technical title must show several distinct AI/ML technologies in the JD, so
  // incidental mentions ("exposure to AI tools") do not pull in unrelated jobs.
  const off = first(OFF_LANE_TITLE, title);
  if (off) return { keep: false, reason: `off-lane title: "${title.match(off)[0].trim()}"`, flags: [] };

  const jdHits = AI_JD_TERMS.filter(re => re.test(jd)).length;
  const aiTitle = title.replace(INCIDENTAL_AI, ' ');
  const titleHit = first(AI_TITLE, aiTitle);
  let reason;
  if (titleHit) reason = `AI/ML title ("${aiTitle.match(titleHit)[0].trim()}")`;
  else if (config.aiJdOnly && TECH_ROLE_TITLE.test(title) && jdHits >= config.minAiJdTerms) reason = `AI/ML JD (${jdHits} AI terms)`;
  else return { keep: false, reason: `not an AI/ML role (${jdHits} AI terms in JD)`, flags: [] };

  const flags = FLAGS.filter(f => {
    const text = f.where === 'title' ? title : f.where === 'body' ? jd : both;
    return f.re.test(text);
  }).map(f => f.say);
  return { keep: true, reason, flags };
}

// Ads on the listing — skip without fetching the detail page.
export function isAdvert(row) {
  return /resumes? for just|hrtech offerings|job board software/i.test(row.title);
}
