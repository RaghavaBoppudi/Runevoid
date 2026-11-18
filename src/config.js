// Loads .env (if present) and exposes typed settings. Uses Node's built-in env-file loader.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  gmailUser:        process.env.GMAIL_USER ?? '',
  gmailAppPassword: (process.env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, ''),
  senderName:       process.env.SENDER_NAME ?? '',
  senderSignature:  process.env.SENDER_SIGNATURE ?? '',
  senderPhone:      process.env.SENDER_PHONE ?? '',
  senderEmail:      process.env.SENDER_EMAIL ?? process.env.GMAIL_USER ?? '',
  senderYears:      process.env.SENDER_YEARS ?? '10+',
  // CC'd on every recruiter email (comma-separated). Not on "Test email to me".
  ccEmails:         (process.env.CC_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean),

  resumesDir:     process.env.RESUMES_DIR ?? 'C:\\Resumes',
  resumeFileName: process.env.RESUME_FILE_NAME ?? 'Resume.docx',

  pollSeconds:     Math.max(60, num(process.env.POLL_SECONDS, 60)),
  maxCatchupPages: num(process.env.MAX_CATCHUP_PAGES, 3),
  // nvoids stamps posting times in India time (IST, UTC+5:30) with no zone in the string.
  nvoidsUtcOffsetMinutes: num(process.env.NVOIDS_UTC_OFFSET_MINUTES, 330),

  // Matching gates
  minMatchScore: num(process.env.MIN_MATCH_SCORE, 40),   // best resume below this → no draft (logged as low_match)
  minAiJdTerms:  Math.max(1, num(process.env.MIN_AI_JD_TERMS, 4)),
  aiJdOnly:      bool(process.env.AI_JD_ONLY, false),  // let a generic title ("Senior Engineer") in on JD terms alone; off = AI must be in the title   // title has no AI/ML term → the JD needs this many distinct AI/ML technologies
  minJdSkills:   num(process.env.MIN_JD_SKILLS, 4),      // fewer known skills in the JD → draft marked "thin"

  // Sending: queue + pacing
  dryRun:                 bool(process.env.DRY_RUN, false),
  // Daily cap ramps up: DAILY_SEND_CAP on DAILY_CAP_RAMP_START, then +DAILY_CAP_RAMP_STEP every
  // DAILY_CAP_RAMP_EVERY_DAYS days, never above DAILY_CAP_MAX. Set the step to 0 for a fixed cap.
  dailySendCap:           num(process.env.DAILY_SEND_CAP, 200),
  dailyCapRampStart:      process.env.DAILY_CAP_RAMP_START ?? '',
  dailyCapRampStep:       num(process.env.DAILY_CAP_RAMP_STEP, 0),
  dailyCapRampEveryDays:  Math.max(1, num(process.env.DAILY_CAP_RAMP_EVERY_DAYS, 2)),
  dailyCapMax:            num(process.env.DAILY_CAP_MAX, 200),
  paceMinSeconds:         num(process.env.PACE_MIN_SECONDS, 60),
  paceMaxSeconds:         num(process.env.PACE_MAX_SECONDS, 120),
  priorityWindowMinutes:  num(process.env.PRIORITY_WINDOW_MINUTES, 10),
  freshBufferMin:         num(process.env.FRESH_BUFFER_MIN, 20),
  freshBufferMax:         num(process.env.FRESH_BUFFER_MAX, 30),
  priorityPaceMinSeconds: num(process.env.PRIORITY_PACE_MIN_SECONDS, 10),
  priorityPaceMaxSeconds: num(process.env.PRIORITY_PACE_MAX_SECONDS, 20),

  // Vendor rules
  maxPerRecipientPerWeek: num(process.env.MAX_PER_RECIPIENT_PER_WEEK, 3),
  duplicateWindowDays:    num(process.env.DUPLICATE_WINDOW_DAYS, 30),
  repostCooldownHours:    num(process.env.REPOST_COOLDOWN_HOURS, 3),
  repostSimilarity:       num(process.env.REPOST_SIMILARITY, 0.70),
  companyConflictDays:    num(process.env.COMPANY_CONFLICT_DAYS, 30),
  recruiterCooldownDays:  num(process.env.RECRUITER_COOLDOWN_DAYS, 3),

  port: num(process.env.PORT, 7892),

  dataDir: process.env.DATA_DIR || join(ROOT, 'data'),
  baseUrl: 'https://nvoids.com',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) nvoids-personal-bot/0.2 (single user, 1 req/min)',
};

mkdirSync(config.dataDir, { recursive: true });

// Today's send cap, following the ramp (local calendar days since the ramp start).
export function dailyCap(onDate = new Date()) {
  const base = config.dailySendCap;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(config.dailyCapRampStart);
  if (!config.dailyCapRampStep || !m) return base;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const day = new Date(onDate.getFullYear(), onDate.getMonth(), onDate.getDate());
  const days = Math.max(0, Math.round((day - start) / 86_400_000));
  return Math.min(config.dailyCapMax, base + config.dailyCapRampStep * Math.floor(days / config.dailyCapRampEveryDays));
}

export function emailConfigured() {
  return Boolean(config.gmailUser && config.gmailAppPassword);
}
