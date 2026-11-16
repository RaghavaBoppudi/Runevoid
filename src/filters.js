// Which postings get a draft. Three tiers, checked in this order:
//   1. SKIP   (EXCLUDE_TITLE, EXCLUDE)  — never drafted; the reason is logged under "All scraped".
//   2. KEEP   AI/ML roles (AI_TITLE in the title / first 400 chars, or 4+ AI terms), plus Java and Cloud/DevOps titles.
//   3. FLAG   (FLAGS) — still drafted, but the draft shows a warning so you read it before approving.
// Patterns ported from the Python nvoids-resume-mailer, which tuned them on ~6,000 real nvoids postings.
// Every entry is a case-insensitive regex; add or delete lines to widen or narrow what you get.

// ── 1a. Skip if the TITLE matches ────────────────────────────────────────────
import { cleanJd } from './matcher.js';
import { db } from './db.js';

const EXCLUDE_TITLE = [
  /hot[\s\-_.]*list/i,                                         // consultant hotlists
  /^\W*(?:updated\s+)?(?:resume|profile|cv)s?\s+(?:of|for)\b/i, // "Resume of …" = a consultant being marketed
  /\b(?:looking\s+for|open\s+to|seeking)\s+(?:a\s+)?(?:new\s+)?(?:project(?!\s+(?:manag|coordinat|lead|engineer|analyst|admin|director|owner|control|plan|office|portfolio|scheduler))s?|opportunit(?:y|ies)|assignment)s?\b/i,
  /\bin\s+response\s+(?:of|to)\s+your\b/i,
  /^\W*application\s*:/i,
  /\bbench\b/i, /consultants? available/i, /candidates? available/i, /available (?:consultants?|candidates?)/i,
  // not engineering roles, even when the JD name-drops an AI stack
  /business analyst/i, /product (?:manager|analyst)/i, /(?:project|program) manager/i, /scrum master/i,
  /\bqa\b/i, /\btester\b/i, /\bsdet\b/i, /\bdesigner\b/i, /\bintern(?:ship)?\b/i, /test manager/i,
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
  /foundation model/i, /vector (?:database|search|db)/i, /\bcopilot\b/i, /\bopenai\b/i, /lang(?:chain|graph)/i, /hugging ?face/i,
  /\bmlops\b/i, /\bllmops\b/i, /\baiops\b/i, /sagemaker/i, /\bbedrock\b/i, /vertex ai/i, /azure (?:ai|machine learning|openai)/i,
  /cognitive services/i, /tensorflow|pytorch/i, /data[\s-]?scien/i, /applied[\s-]?scientist/i, /research[\s-]?(?:scientist|engineer)/i,
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

// Java and Cloud/DevOps titles, for your Java (5, 7) and Cloud (6) resumes.
// AI governance (folders 10/11) and AI/IAM product owner (folder 13) roles.
const GOV_TITLE = /\b(?:ai|model|algorithmic)\s+(?:governance|risk|review|ethics|assurance|compliance)\b|responsible\s+ai|model\s+risk|governance\s+architect/i;
const PO_TECH = /\b(?:ai|ml|llm|genai|agentic|machine learning|iam|identity(?:\s+and|\s+&)?\s+access|entra|azure ad|okta|sailpoint|zero trust|sso|oauth)\b/i;
const JAVA_TITLE = [/\bjava\b/i, /\bj2ee\b/i, /\bspring(?:\s*boot)?\b/i, /\bfull[\s-]?stack\b/i, /\bback[\s-]?end\b/i, /\bmicroservices?\b/i];
const JAVA_JD = [
  /\bjava\b/i, /\bj2ee\b|\bjakarta\s+ee\b/i,
  /\bspring\s*(?:boot|framework|mvc|security|cloud|data|webflux)\b/i,
  /\bhibernate\b|\b(?:jpa|jdbc|jvm)\b/i,
  /\b(?:servlet|jsp|tomcat|jboss|wildfly)\b/i,
];
const CLOUD_TITLE = [/\bcloud\b/i, /\bdev\s?ops\b/i, /\bdevsecops\b/i, /\bsre\b/i, /site reliability/i, /\bplatform engineer/i,
  /\binfrastructure engineer/i, /\bkubernetes\b/i, /\bterraform\b/i, /\b(?:aws|azure|gcp)\s+(?:architect|engineer)\b/i, /\bsolutions?\s+architect\b/i];

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

  // An AI word in the title is enough. One only in the JD's opening lines ("AI-assisted engineering")
  // also needs 2+ real AI/ML terms in the JD, so a network engineer who "uses AI tools" doesn't pass.
  // Java and Cloud/DevOps roles are kept too (your folders 5, 7 and 6); the damage formula sends them the
  // right resume.
  const jdHits = AI_JD_TERMS.filter(re => re.test(jd)).length;
  const titleHit = first(AI_TITLE, title);
  const headHit = first(AI_TITLE, jd.slice(0, 400));
  const javaHit = first(JAVA_TITLE, title);
  const javaJdHit = first(JAVA_JD, jd);
  const cloudHit = first(CLOUD_TITLE, title);
  let reason;
  if (titleHit) reason = `AI/ML title ("${title.match(titleHit)[0].trim()}")`;
  else if (headHit && jdHits >= 2) reason = `AI/ML role in JD ("${jd.slice(0, 400).match(headHit)[0].trim()}", ${jdHits} AI terms)`;
  else if (jdHits >= 4) reason = `AI/ML JD (${jdHits} AI terms)`;
  else if (javaHit) reason = `Java role ("${title.match(javaHit)[0].trim()}")`;
  else if (javaJdHit) reason = `Java-related JD ("${jd.match(javaJdHit)[0].trim()}")`;
  else if (cloudHit) reason = `Cloud/DevOps role ("${title.match(cloudHit)[0].trim()}")`;
  else if (GOV_TITLE.test(title)) reason = `AI governance role ("${title.match(GOV_TITLE)[0].trim()}")`;
  else if (/product owner/i.test(title) && PO_TECH.test(jd)) reason = `Technical product owner (AI/IAM: "${jd.match(PO_TECH)[0].trim()}")`;
  else return { keep: false, reason: `not AI/ML, Java or Cloud (${jdHits} AI terms in JD)`, flags: [] };

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
