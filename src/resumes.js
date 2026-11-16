// Resume library + matcher.
//
// Library: Word files directly in RESUMES_DIR (identified by filename), plus legacy
// <RESUMES_DIR>/<N>/<RESUME_FILE_NAME> numbered folders.
// Matching is fully local (no API):
//   score = weighted keyword coverage (matcher.js: the share of the JD's skill weight the resume has)
//   near-ties (within resume-lanes.json `tie_gap`) → the job title's lane, then the on-device embedding
//   model (all-MiniLM-L6-v2) as a second opinion on meaning
//   your default folder is kept unless another beats it by `margin` points or the title clearly fits
//   another folder's lane.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { config, ROOT } from './config.js';
import { logEvent } from './db.js';
import { jdWeights, extraSkillWeights, altGroups, matchOne, countTerms, countLiteralTerm, cleanJd, display, EMAIL_OMIT } from './matcher.js';

// ── Library ───────────────────────────────────────────────────────────────────

const cache = new Map(); // path → parsed resume data for this process
const inFlight = new Map(); // path → shared promise, so concurrent jobs load a resume only once
const RESUME_CACHE_VERSION = 1;
const RESUME_CACHE_DIR = join(config.dataDir, 'resume-cache');

export function listResumeFiles() {
  if (!existsSync(config.resumesDir)) return [];
  const entries = readdirSync(config.resumesDir, { withFileTypes: true });
  const direct = entries
    .filter(d => d.isFile() && !d.name.startsWith('~$') && extname(d.name).toLowerCase() === '.docx')
    .map(d => ({ folder: basename(d.name, extname(d.name)), name: basename(d.name, extname(d.name)), path: join(config.resumesDir, d.name) }));
  const numbered = entries
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => ({ folder: d.name, name: `Folder ${d.name}`, path: join(config.resumesDir, d.name, config.resumeFileName) }))
    .filter(r => existsSync(r.path));
  return [...direct, ...numbered].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

export function resumeLabel(folder) {
  return listResumeFiles().find(r => r.folder === String(folder))?.name ?? ( /^\d+$/.test(String(folder)) ? `Folder ${folder}` : String(folder ?? ''));
}

async function loadResume(info) {
  const { path } = info;
  const stat = statSync(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
  if (inFlight.has(path)) return inFlight.get(path);
  const pending = loadResumeData(info, stat);
  inFlight.set(path, pending);
  try { return await pending; }
  finally { if (inFlight.get(path) === pending) inFlight.delete(path); }
}

function diskCachePath(path) {
  const key = createHash('sha256').update(resolvePath(path)).digest('hex');
  return join(RESUME_CACHE_DIR, `${key}.json`);
}

function makeResumeEntry({ folder, name, path }, stat, saved) {
  const text = saved.text;
  return {
    folder, name: name ?? folder, path, mtimeMs: stat.mtimeMs, size: stat.size,
    text, chunks: saved.chunks, vecs: saved.vecs ?? null,
    skills: skillsIn(text), terms: countTerms(text),
  };
}

async function loadResumeData(info, stat) {
  const { folder, path } = info;
  const cachedPath = diskCachePath(path);
  try {
    if (existsSync(cachedPath)) {
      const saved = JSON.parse(readFileSync(cachedPath, 'utf8'));
      if (saved.version === RESUME_CACHE_VERSION && saved.mtimeMs === stat.mtimeMs && saved.size === stat.size && Array.isArray(saved.chunks) && typeof saved.text === 'string') {
        const entry = makeResumeEntry(info, stat, saved);
        cache.set(path, entry);
        logEvent('info', 'resume_cache_hit', null, `Reused cached resume ${info.name ?? folder}`, { path });
        return entry;
      }
    }
  } catch (e) {
    logEvent('warn', 'resume_cache_read_failed', null, `Could not reuse saved data for ${info.name ?? folder}; rebuilding it: ${e.message}`, { path: cachedPath });
  }

  const { value } = await mammoth.extractRawText({ path });
  const text = value.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = chunk(text);
  const vecs = await embed(chunks);
  const entry = makeResumeEntry(info, stat, { text, chunks, vecs });
  cache.set(path, entry);
  logEvent('info', 'resume_loaded', null, `Loaded resume ${folder} (${text.split(/\s+/).length} words)`, { path });
  try {
    mkdirSync(RESUME_CACHE_DIR, { recursive: true });
    const tempPath = `${cachedPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify({ version: RESUME_CACHE_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, text, chunks, vecs }));
    renameSync(tempPath, cachedPath);
  } catch (e) {
    logEvent('warn', 'resume_cache_write_failed', null, `Could not save cached data for ${info.name ?? folder}: ${e.message}`, { path: cachedPath });
  }
  return entry;
}

export async function loadLibrary() {
  const files = listResumeFiles();
  const out = [];
  for (const f of files) {
    try { out.push(await loadResume(f)); }
    catch (e) { logEvent('error', 'resume_load_failed', null, `Could not read resume ${f.name}: ${e.message}`, { path: f.path }); }
  }
  return out;
}

// ── Embeddings (local) ────────────────────────────────────────────────────────

let extractorPromise = null;
let embedDisabled = false;

async function getExtractor() {
  if (embedDisabled) return null;
  extractorPromise ??= (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = join(config.dataDir, 'models');
    return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'fp32' });
  })().catch(e => {
    embedDisabled = true;
    logEvent('warn', 'embedder_unavailable', null, `Local embedding model unavailable, using keyword-only matching: ${e.message}`);
    return null;
  });
  return extractorPromise;
}

async function embed(texts) {
  const ex = await getExtractor();
  if (!ex || !texts.length) return null;
  const out = await ex(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

// MiniLM reads ~256 tokens, so split long text into overlapping ~120-word windows.
function chunk(text, size = 120, overlap = 30) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= size) return [words.join(' ')];
  const out = [];
  for (let i = 0; i < words.length; i += size - overlap) {
    out.push(words.slice(i, i + size).join(' '));
    if (i + size >= words.length) break;
  }
  return out.slice(0, 40);
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// For each JD chunk, how well does the resume's best chunk cover it? Average that.
function semanticScore(jdVecs, resumeVecs) {
  if (!jdVecs || !resumeVecs) return null;
  const best = jdVecs.map(j => Math.max(...resumeVecs.map(r => dot(j, r))));
  const mean = best.reduce((s, v) => s + v, 0) / best.length;
  // MiniLM cosine for related tech text sits ~0.2–0.8; stretch to 0..1.
  return Math.min(1, Math.max(0, (mean - 0.2) / 0.6));
}

// ── Skill keywords ────────────────────────────────────────────────────────────

const SKILLS = {
  'Python': /\bpython\b/i, 'Java': /\bjava\b(?!script)/i, 'Scala': /\bscala\b/i, 'SQL': /\bsql\b/i, 'R': /\bR\b(?= |,|\/)/,
  'Go': /\bgolang\b/i, 'TypeScript': /\btypescript\b/i, 'C++': /c\+\+/i,
  'LLM': /\bllms?\b|large language model/i, 'Generative AI': /generative ai|\bgen ?ai\b/i, 'RAG': /\brag\b|retrieval[- ]augmented/i,
  'Agents': /\bagentic\b|ai agents?|multi-agent/i, 'Prompt engineering': /prompt engineering/i, 'Fine-tuning': /fine[- ]?tun|lora|qlora|peft/i,
  'LangChain': /langchain/i, 'LangGraph': /langgraph/i, 'LlamaIndex': /llama ?index/i, 'CrewAI': /crewai/i, 'AutoGen': /autogen/i,
  'OpenAI': /openai|gpt-?[345]/i, 'Claude': /\bclaude\b|anthropic/i, 'Gemini': /\bgemini\b/i, 'Llama': /\bllama\b/i, 'Hugging Face': /hugging ?face/i,
  'Vector DB': /vector (?:db|database|store|search)/i, 'Pinecone': /pinecone/i, 'FAISS': /\bfaiss\b/i, 'Chroma': /chroma(?:db)?\b/i, 'Weaviate': /weaviate/i, 'pgvector': /pgvector/i,
  'Elasticsearch/OpenSearch': /elasticsearch|opensearch/i,
  'Machine learning': /machine learning/i, 'Deep learning': /deep learning|neural network/i, 'NLP': /\bnlp\b|natural language/i, 'Computer vision': /computer vision|\bopencv\b|yolo/i,
  'PyTorch': /pytorch/i, 'TensorFlow': /tensorflow|keras/i, 'scikit-learn': /scikit|sklearn/i, 'XGBoost': /xgboost|lightgbm/i, 'Transformers': /\btransformers?\b|\bbert\b/i,
  'MLOps': /\bmlops\b/i, 'LLMOps': /\bllmops\b/i, 'MLflow': /mlflow/i, 'Kubeflow': /kubeflow/i, 'Airflow': /airflow/i,
  'SageMaker': /sagemaker/i, 'Bedrock': /\bbedrock\b/i, 'Vertex AI': /vertex ai/i, 'Azure ML': /azure (?:ml|machine learning)/i, 'Azure OpenAI': /azure openai/i, 'Databricks': /databricks/i, 'Azure Data Factory': /data factory|\badf\b/i,
  'AWS': /\baws\b|amazon web services/i, 'Azure': /\bazure\b/i, 'GCP': /\bgcp\b|google cloud/i,
  'Docker': /docker/i, 'Kubernetes': /kubernetes|\bk8s\b|\beks\b|\baks\b|\bgke\b/i, 'Terraform': /terraform/i, 'CI/CD': /ci\/cd|github actions|jenkins|gitlab ci/i,
  'ETL': /\betl\b|\belt\b pipelines?|data integration/i,
  'Spark': /\bspark\b|pyspark/i, 'Kafka': /kafka/i, 'Snowflake': /snowflake/i, 'FastAPI': /fastapi/i, 'Flask': /\bflask\b/i, 'REST APIs': /rest(?:ful)? api/i,
  'Model serving': /model serving|triton|vllm|torchserve|bentoml|ray serve/i, 'Evaluation': /\bevals?\b|evaluation framework|ragas|llm-as-a-judge/i,
  'Responsible AI': /responsible ai|ai governance|guardrails/i, 'Power BI': /power ?bi/i, 'Tableau': /tableau/i,
};

function skillsIn(text) {
  return new Set(Object.entries(SKILLS).filter(([, re]) => re.test(text)).map(([k]) => k));
}

// Where a skill first shows up in the JD — earlier = more central to the posting.
function firstPos(text, skill) {
  const m = SKILLS[skill].exec(text);
  return m ? m.index : Infinity;
}

// ── Background themes for the email ("My background includes …") ────────────
// A phrase is used only when its topic is in the JD AND in the resume being attached (every `cv` pattern
// must be found), so the email never claims experience the resume doesn't show.
// Picked: production work first, then at most one industry (`domain`), then whatever the JD stresses most.
// Mentions in a "Preferred / Nice to have" section count for little, so a preferred skill never beats a required one.
const FINANCE_JD = /fraud|payments?|cards?\b|transactions?|banking|\bbank\b|financial|fintech|amex|american express|credit/gi;
const THEMES = [
  { jd: /\b(?:lead|mentor|team leadership|technical lead)\b/gi,
    need: [/\bjava\b/i],
    cv: [/\bjava\b/i, /lead|mentor|team/i],
    say: 'leading Java full-stack delivery, mentoring engineers, and building secure, scalable microservices' },
  { jd: /\b(?:production|deploy\w*)\b[\s\S]{0,80}\bmodels?\b|\bmodels?\b[\s\S]{0,80}\b(?:production|deploy\w*)\b|predictive|classification/gi,
    cv: [/\bproduction\b/i, /\bmodels?\b/i], say: 'building production ML models', first: true },
  { jd: FINANCE_JD, cv: [/fraud/i, /payment/i], say: 'financial fraud and payment transaction pipelines', domain: true },
  { jd: FINANCE_JD, cv: [/fraud/i], say: 'fraud detection models', domain: true },
  { jd: /\bhealth\w*|clinical|patients?|medical/gi, cv: [/health|clinical|patient|medical/i], say: 'healthcare and clinical data platforms', domain: true },
  { jd: /insurance|underwrit\w*|\bclaims\b/gi, cv: [/insurance|underwrit/i], say: 'insurance claims and underwriting workflows', domain: true },
  { jd: /retail|e-?commerce|catalog\w*/gi, cv: [/retail|e-?commerce|catalog/i], say: 'retail and e-commerce data products', domain: true },
  { jd: /governance|metadata|lineage|data quality|data stewards?|master data|data catalog\w*/gi,
    cv: [/governance/i, /lineage|metadata|data quality|purview|unity catalog|collibra|data catalog/i],
    say: 'establishing data governance, metadata lineage, data quality frameworks' },
  // Two phrasings of collaboration; backgroundFor keeps only the first that applies.
  { jd: /\bpartner\w*|collaborat\w*|stakeholders?|cross-functional\w*/gi, need: [/power ?bi/i, /architect/i],
    cv: [/power ?bi/i, /architect/i], say: 'collaborating cross-functionally across architecture and Power BI reporting teams', collab: true },
  { jd: /\bpartner\w*|collaborat\w*|stakeholders?|cross-functional\w*/gi,
    cv: [/stakeholder|cross-functional|collaborat|partner/i], say: 'collaborating cross-functionally with business and engineering stakeholders', collab: true },
  { jd: /\bcloud\b|mlops|ci\/cd|kubernetes|\bdeploy\w*/gi, cv: [/mlops|kubernetes|docker|sagemaker|azure ml|vertex|mlflow|kubeflow|ci\/cd/i],
    say: 'deploying cloud-native architectures with MLOps' },
  { jd: /\betl\b|data pipelines?|ingestion|data integration/gi, cv: [/\betl\b|data pipelines?|ingestion/i], say: 'building scalable ETL and data pipelines' },
  { jd: /generative|gen ?ai\b|\bllms?\b|\brag\b|large language/gi, cv: [/\bllms?\b|\brag\b|generative|langchain/i], say: 'LLM and RAG applications' },
  { jd: /agentic|ai agents?|multi-agent/gi, cv: [/agentic|ai agents?|multi-agent|langgraph|crewai|autogen/i], say: 'agentic AI workflows' },
  { jd: /recommend\w*/gi, cv: [/recommend/i], say: 'recommendation systems' },
  { jd: /\bnlp\b|natural language/gi, cv: [/\bnlp\b|natural language/i], say: 'NLP solutions' },
  { jd: /computer vision|\bimages?\b|\bvideo\b/gi, cv: [/computer vision|image|video|opencv|yolo/i], say: 'computer vision models' },
  { jd: /forecast\w*|time[- ]series/gi, cv: [/forecast|time[- ]series/i], say: 'forecasting models' },
];

// Split the JD into what it requires and what it only prefers.
function jdSections(jd) {
  const lines = jd.split('\n');
  // Stop at the recruiter's sign-off: "Senior Technical Recruiter - HealthTech" is not about the job.
  const sign = lines.findIndex((l, i) => i > 3 && /^\s*(?:thanks?(?:\s*(?:&|and)\s*regards?)?|(?:best|warm|kind)\s+regards|regards|thank\s+you|sincerely)\b[\s,.!:-]*$/i.test(l));
  if (sign > 0) lines.length = sign;
  let pref = false;
  const req = [], prefd = [];
  for (const l of lines) {
    if (/^\s*(?:preferred|nice[- ]to[- ]have|good[- ]to[- ]have|desired|bonus|plus)\b/i.test(l)) pref = true;
    else if (/^\s*(?:must[- ]have|required|requirements|responsibilities|qualifications|skills|job description|keywords)\b/i.test(l)) pref = false;
    if (/^\s*keywords\s*:/i.test(l)) continue;   // nvoids' auto-generated keyword line is noise
    (pref ? prefd : req).push(l);
  }
  return { req: req.join('\n'), pref: prefd.join('\n') };
}

const count = (re, text) => (text.match(re) || []).length;

function backgroundFor(jd, resumeText) {
  const { req, pref } = jdSections(jd);
  const all = `${req}\n${pref}`;
  const hits = THEMES
    .map((t, i) => ({ ...t, i, weight: count(t.jd, req) + 0.25 * count(t.jd, pref) }))
    .filter(t => t.weight > 0 && (t.need ?? []).every(re => re.test(all)) && t.cv.every(re => re.test(resumeText)));
  const firstCollab = hits.find(t => t.collab);
  const usable = hits.filter(t => !t.collab || t === firstCollab);
  const first = usable.filter(t => t.first);
  const domain = usable.filter(t => t.domain).slice(0, 1);   // list order = most specific first
  const rest = usable.filter(t => !t.first && !t.domain).sort((a, b) => b.weight - a.weight || a.i - b.i);
  // A third topic only when the JD really stresses it, so the sentence stays focused.
  return [...first, ...domain, ...rest].filter((t, k) => k < 2 || (k === 2 && t.weight >= 2)).map(t => t.say);
}

// Skills from the resume itself, used to top up the skills line when the JD names few ("…, Python, and SQL").
// Only universal ones, so the line never drifts to tools the JD has nothing to do with.
const CORE_SKILLS = ['Java', 'Spring Boot', 'Microservices', 'REST APIs', 'SQL'];

// ── Match ─────────────────────────────────────────────────────────────────────

// resume-lanes.json: your default folder, the margin to beat it, and title words per folder. Re-read
// whenever it changes, so edits apply without a restart.
let lanesCache = { mtimeMs: -1, value: null };
function lanes() {
  const path = join(ROOT, 'resume-lanes.json');
  const fallback = { default: '', margin: 8, tie_gap: 3, lanes: {} };
  try {
    const { mtimeMs } = statSync(path);
    if (mtimeMs !== lanesCache.mtimeMs) lanesCache = { mtimeMs, value: { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) } };
    return lanesCache.value;
  } catch { return fallback; }
}

// How many of a folder's lane phrases appear in the job title (whole words).
const words = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim()} `;   // "AI/ML Engineer/AZ" → " ai ml engineer az "
function laneHits(folder, title, cfg) {
  const t = words(title);
  return (cfg.lanes[folder] ?? []).filter(p => t.includes(words(p))).length;
}

// Returns every resume, the chosen one first, each with its score, the skills behind it and why it was chosen.
export async function rankResumes(jdText, title = '') {
  const library = await loadLibrary();
  if (!library.length) return { ranked: [], method: 'none', jdSkills: [] };

  const cfg = lanes();
  const weights = jdWeights(title, jdText);
  const extraSkills = extraSkillWeights(jdText);
  for (const [key, skill] of extraSkills) weights.set(key, skill.weight);
  const groups = altGroups(title, jdText, extraSkills);
  const jdVecs = await embed(chunk(cleanJd(jdText)));
  const method = jdVecs ? 'weighted keywords + JD skill lists + AI tie-break' : 'weighted keywords + JD skill lists';
  const skillName = key => extraSkills.get(key)?.label ?? display(key);
  const shown = (pairs) => pairs.map(([k]) => k).filter(k => !EMAIL_OMIT.has(k)).map(skillName);

  const jobFams = jobFamilies(title, cfg);
  const jobFam = jobFams.join('+');
  const jdClusters = clustersIn(weights, cfg);

  const ignored = new Set((cfg.ignore ?? []).map(String));   // e.g. a duplicate folder
  const scored = library.filter(r => !ignored.has(r.folder)).map(r => {
    const resumeTerms = new Map(r.terms);
    for (const [key, skill] of extraSkills) {
      const count = countLiteralTerm(r.text, skill.label);
      if (count) resumeTerms.set(key, count);
    }
    const m = matchOne(weights, resumeTerms, groups);
    const sem = semanticScore(jdVecs, r.vecs);
    const lane = laneHits(r.folder, title, cfg);
    const f = damage({ base: m.score, folder: r.folder, lane, jobFams, jdClusters, resumeTerms: r.terms, resumeText: r.text, title, cfg });
    return {
      folder: r.folder, name: r.name, path: r.path,
      score: Math.min(100, Math.round(f.final)), final: f.final, keyword: Math.round(m.score),
      semantic: sem === null ? null : Math.round(sem * 100), depth: m.depth, lane, formula: f.parts,
      matched: shown(m.matched), missing: shown(m.missing),
      related: m.related.map(([k, via]) => `${display(k)} (via ${display(via)})`),
      background: backgroundFor(jdText, r.text),
      core: CORE_SKILLS.filter(k => r.terms.has(k.toLowerCase())),
      why: '',
    };
  }).sort((a, b) => b.final - a.final || b.depth - a.depth || a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: 'base' }));

  // Pick: your default folder unless another beats it by `margin` on the final score; otherwise the top
  // scorer, with near-ties (within `tie_gap`) going to the higher AI similarity.
  const top = scored[0];
  const def = scored.find(r => r.folder === String(cfg.default));
  let chosen;
  if (def && top.final - def.final < cfg.margin) {
    chosen = def;
    chosen.why = def === top ? 'your default, and the best fit' : `your default; folder ${top.folder} led by only ${Math.round(top.final - def.final)} pts (needs ${cfg.margin})`;
  } else {
    const close = scored.filter(r => top.final - r.final <= cfg.tie_gap);
    chosen = close.sort((a, b) => (b.semantic ?? 0) - (a.semantic ?? 0) || b.final - a.final)[0];
    chosen.why = close.length > 1 ? `near-tie with ${close.length - 1} other resume(s); decided by AI similarity` : 'best fit';
  }
  if (jobFam) chosen.why += ` · ${jobFam.toUpperCase()} job`;

  const ranked = [chosen, ...scored.filter(r => r !== chosen)];
  return { ranked, method: `damage formula (${method})`, jdSkills: [...weights.keys()].map(skillName), jobFamily: jobFam };
}

// ── Damage formula ───────────────────────────────────────────────────────────
//   final = Base × DmgType × Crit × Res × Def × RoleFit
//   Base    weighted JD skill coverage (0–100); remains the score's anchor.
//   DmgType stack evidence adjustment (0.90–1.00). Breadth can preserve the score, never inflate it.
//   Crit    small calibration factor (×1.02 for explicitly curated folders when Base ≥ 50).
//   Res     family mismatch penalty. Family is read from configured folders or inferred from resume skills.
//   RoleFit modestly rewards evidence aligned with senior/lead titles; mid-level stays neutral.
//   The former 1.4–1.5 multi-stack multiplier saturated many scores at 100 despite incomplete JD coverage.

function familyOf(folder, cfg, resumeTerms = new Map(), resumeText = '') {
  for (const [fam, folders] of Object.entries(cfg.families ?? {})) if (folders.map(String).includes(String(folder))) return [fam];
  // Most current resumes are named files, not numbered folders. Their curated filenames are much more
  // discriminative than body text, where broad keyword mentions otherwise make every resume look alike.
  const rawName = String(folder ?? '').toLowerCase();
  const name = rawName.replace(/[_-]+/g, ' ');
  const compactName = name.replace(/[^a-z0-9]/g, '');
  const named = [];
  if (/java|j2ee|spring|backend/.test(compactName)) named.push('java');
  if (/ai|ml|llm|genai|agentic|machinelearning/.test(compactName)) named.push('ai');
  if (/aws|azure|gcp|cloud|devops|sre|platform/.test(compactName)) named.push('cloud');
  if (/data|analytics|scientist|snowflake|databricks|spark/.test(compactName)) named.push('ds');
  if (named.length) return named;
  // Fallback for files without a meaningful specialty in their name.
  const has = (...keys) => keys.filter(k => resumeTerms.has(k)).length;
  const out = [];
  if (has('java', 'spring boot', 'j2ee', 'hibernate', 'spring') >= 3) out.push('java');
  if (has('llm', 'rag', 'agentic ai', 'generative ai', 'langchain', 'langgraph', 'pytorch', 'tensorflow', 'machine learning') >= 4) out.push('ai');
  if (has('aws', 'azure', 'gcp', 'kubernetes', 'terraform', 'docker', 'devops') >= 4) out.push('cloud');
  if (has('databricks', 'snowflake', 'spark', 'pyspark', 'airflow', 'data engineering') >= 4) out.push('ds');
  return out;
}

// Every family the title names, in the order of `job_families` ("Java Lead [AI driven]" → java + ai).
export function jobFamilies(title, cfg) {
  const t = words(title);
  const fams = (cfg.job_families ?? []).filter(([, phrases]) => phrases.some(p => t.includes(words(p)))).map(([fam]) => fam);
  // An `exclusive` family wins alone: "AI Governance Consultant" is a governance job, not also an AI one.
  const only = fams.find(f => (cfg.exclusive ?? []).includes(f));
  return only ? [only] : fams;
}
export function jobFamily(title, cfg) { return jobFamilies(title, cfg)[0] ?? ''; }

// Clusters the JD really spans: at least 2 of its skills, or 15% of its keyword weight.
function clustersIn(weights, cfg) {
  const total = [...weights.values()].reduce((s, w) => s + w, 0) || 1;
  const out = [];
  for (const [name, keys] of Object.entries(cfg.clusters ?? {})) {
    const hit = keys.filter(k => weights.has(k));
    const w = hit.reduce((s, k) => s + weights.get(k), 0);
    if (hit.length >= 2 || w / total >= 0.15) out.push({ name, keys: hit, weight: w });
  }
  return out;
}

function damage({ base, folder, lane, jobFams, jdClusters, resumeTerms, resumeText, title, cfg }) {
  const d = 100; // title/resume lane belongs in the explanation and tie-breaks, not a coverage multiplier.
  const covered = jdClusters.filter(c => c.keys.length && c.keys.filter(k => resumeTerms.has(k)).length / c.keys.length >= 0.5);
  const jdClusterSkills = jdClusters.flatMap(c => c.keys);
  const uniqueClusterSkills = [...new Set(jdClusterSkills)];
  const stackCoverage = uniqueClusterSkills.length
    ? uniqueClusterSkills.filter(k => resumeTerms.has(k)).length / uniqueClusterSkills.length
    : 1;
  const dmgType = 0.90 + 0.10 * stackCoverage;
  const crit = (cfg.custom ?? []).map(String).includes(String(folder)) && base >= 50 ? 1.02 : 1.0;
  const families = familyOf(folder, cfg, resumeTerms, resumeText);
  const familyClashes = jobFams.flatMap(j => families.map(f => cfg.resistance?.[j]?.[f] ?? 0));
  const R = familyClashes.length ? Math.min(...familyClashes) : 0;
  const res = R >= 75 ? 100 / (4 * R + 100) : 1 - R / 100;
  const def = Number(cfg.seniority ?? 1) || 1;
  const leadRole = /\b(?:lead|team lead|technical lead)\b/i.test(title);
  const seniorRole = /\b(?:senior|sr\.?)\b/i.test(title);
  const midRole = /\b(?:mid[- ]level|midlevel|mid level)\b/i.test(title);
  const leadershipEvidence = /\b(?:lead|led|mentor|mentoring|technical leadership|team of)\b/i.test(resumeText);
  const years = [...resumeText.matchAll(/\b(\d{1,2})\s*\+?\s*years?\b/gi)].map(m => Number(m[1]));
  const maxYears = Math.max(0, ...years);
  const roleFit = leadRole ? (leadershipEvidence ? 1.03 : 0.98)
    : seniorRole && maxYears >= 8 ? 1.02
    : 1.0;
  const final = Math.min(base, base * dmgType * crit * res * def * roleFit);
  return { final, parts: { d, base: Math.round(base), dmgType: Math.round(dmgType * 100) / 100, stackCoverage: Math.round(stackCoverage * 100), crit, R, res: Math.round(res * 100) / 100, def, roleFit, roleBand: leadRole ? 'lead' : seniorRole ? 'senior' : midRole ? 'mid-level' : 'unspecified', families, clusters: covered.map(c => c.name), jdClusters: jdClusters.map(c => c.name) } };
}

// The job family for a title, using resume-lanes.json (for neutral fallbacks elsewhere).
export function familyForTitle(title) { return jobFamily(title, lanes()); }
