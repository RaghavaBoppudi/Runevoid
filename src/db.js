// Local SQLite (Node's built-in node:sqlite) — the bot's log of everything.
//   jobs          every posting scraped, with why it was kept/dropped
//   applications  one row per drafted email: resume folder, recipient, queue/hold state, approve/send times
//   vendor_locks  permanent "this vendor only ever gets resume folder N" rules
//   audit         who/when for every lock change and every hold decision
//   events        the full automation log (polls, errors, matches, sends)
//   state         small key/value store (last seen nvoids id, pause switches, pacing clock)
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { config } from './config.js';

export const DB_PATH = join(config.dataDir, 'runevoid.db');

// One-time move from the old file name (nvoids-bot.db) so all history carries over. WAL side files go with it.
const OLD_DB = join(config.dataDir, 'nvoids-bot.db');
if (!existsSync(DB_PATH) && existsSync(OLD_DB)) {
  for (const ext of ['', '-wal', '-shm']) if (existsSync(OLD_DB + ext)) renameSync(OLD_DB + ext, DB_PATH + ext);
}

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY,         -- nvoids job id
  uid              TEXT,
  url              TEXT NOT NULL,
  title            TEXT NOT NULL,
  location_listed  TEXT,                        -- nvoids' location column
  location_jd      TEXT,                        -- location found in the JD text (often more accurate)
  posted_raw       TEXT,
  posted_at        TEXT,                        -- nvoids' clock (IST), as text
  posted_utc       TEXT,                        -- the same moment in UTC (ISO), for "is it fresh?"
  recruiter_email  TEXT,
  recruiter_name   TEXT,
  company          TEXT,
  jd_text          TEXT,
  jd_hash          TEXT,
  match_score      INTEGER,
  match_method     TEXT,
  ranking_json     TEXT,
  status           TEXT NOT NULL DEFAULT 'new',  -- new | filtered_out | low_match | no_email | no_resume | pending_approval | queued | held | sent | skipped | failed | error
  status_reason    TEXT,
  scraped_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_hash   ON jobs(jd_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped ON jobs(scraped_at);

CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  resume_folder   TEXT NOT NULL,                -- "1", "2", …
  resume_path     TEXT NOT NULL,
  match_score     INTEGER,
  match_method    TEXT,
  ranking_json    TEXT,                         -- every resume's score, for the dashboard
  to_email        TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  auto_body       TEXT,                         -- the body as generated; differs from body once you edit it
  location        TEXT,
  flags_json      TEXT,                         -- warnings from the filters (hotlist tag, scrubbed words…)
  thin            INTEGER NOT NULL DEFAULT 0,   -- JD named too few skills to rank resumes reliably
  locked          INTEGER NOT NULL DEFAULT 0,   -- resume chosen by a vendor lock, not by matching
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | queued | sending | sent | held | failed | skipped
  hold_kind       TEXT,                         -- same_day | lock_missing | lock_low_fit | lock_edited | repost | weekly_cap
  hold_reason     TEXT,
  todays_folder   TEXT,                         -- same-day hold: the folder this vendor already got today
  override_repost INTEGER NOT NULL DEFAULT 0,   -- you chose "send anyway" on a repost hold
  queued_at       TEXT,
  send_after      TEXT,                         -- not before this local time ("send tomorrow" / "next week")
  approved_at     TEXT,
  sent_at         TEXT,
  message_id      TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_apps_to     ON applications(to_email);
CREATE INDEX IF NOT EXISTS idx_apps_sent   ON applications(status, sent_at);
CREATE INDEX IF NOT EXISTS idx_apps_upd    ON applications(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_apps_made   ON applications(created_at);

CREATE TABLE IF NOT EXISTS vendor_locks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  domain         TEXT NOT NULL,                 -- cdf.com
  local          TEXT NOT NULL DEFAULT '',      -- '' = everyone at the domain; 'abc' = only abc@cdf.com
  resume_folder  TEXT NOT NULL,
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE(domain, local)
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  level    TEXT NOT NULL,                       -- info | warn | error
  type     TEXT NOT NULL,
  job_id   INTEGER,
  message  TEXT NOT NULL,
  data     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);

-- Vendors you never want to email: a domain (cdf.com), an address (abc@cdf.com) or a company name.
CREATE TABLE IF NOT EXISTS vendor_blacklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  term        TEXT NOT NULL UNIQUE,
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- Where you stand with each vendor (you set this; the bot can't read your inbox):
-- rtr | submitted | interview | offer | placed | not_interested
CREATE TABLE IF NOT EXISTS vendor_status (
  address     TEXT PRIMARY KEY,                 -- recruiter address, lowercase
  status      TEXT NOT NULL,
  on_date     TEXT,                             -- the date it happened (YYYY-MM-DD)
  note        TEXT,
  updated_at  TEXT NOT NULL
);
`);

// Older databases from the first version: add any column that is missing.
function ensureColumns(table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, def] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
ensureColumns('jobs', {
  posted_utc: 'TEXT', source: "TEXT NOT NULL DEFAULT 'nvoids'", ref_id: 'TEXT',
  match_score: 'INTEGER', match_method: 'TEXT', ranking_json: 'TEXT',
});   // source: nvoids | manual
ensureColumns('applications', {
  auto_body: 'TEXT', flags_json: 'TEXT', thin: 'INTEGER NOT NULL DEFAULT 0', locked: 'INTEGER NOT NULL DEFAULT 0', cc_emails: 'TEXT',
  hold_kind: 'TEXT', hold_reason: 'TEXT', todays_folder: 'TEXT', override_repost: 'INTEGER NOT NULL DEFAULT 0',
  override_same_day: 'INTEGER NOT NULL DEFAULT 0',   // you chose "Send Anyway": a second, different resume to this vendor today
  queued_at: 'TEXT', send_after: 'TEXT',
  sent_cc: 'TEXT',        // the CC list that actually went out ('' = none; NULL = not recorded)
  sent_resume: 'TEXT',    // copy of the exact file attached, under data/sent-resumes/ (NULL for sends before Nov 24 2026)
});

const p = (n) => String(n).padStart(2, '0');
// Local wall-clock time, sortable: "2026-10-21 14:05:09"
export function fmtLocal(d) {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function now() { return fmtLocal(new Date()); }
export function today() { return now().slice(0, 10); }

export function logEvent(level, type, jobId, message, data) {
  db.prepare(`INSERT INTO events (ts, level, type, job_id, message, data) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(now(), level, type, jobId ?? null, message, data === undefined ? null : JSON.stringify(data));
  const line = `[${now()}] ${level.toUpperCase().padEnd(5)} ${type}${jobId ? ` #${jobId}` : ''}: ${message}`;
  (level === 'error' ? console.error : console.log)(line);
}

export function audit(action, detail) {
  db.prepare(`INSERT INTO audit (ts, action, detail) VALUES (?, ?, ?)`).run(now(), action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

export function getState(key, fallback = null) {
  return db.prepare(`SELECT value FROM state WHERE key = ?`).get(key)?.value ?? fallback;
}

export function setState(key, value) {
  db.prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

export function setJobStatus(id, status, reason = null) {
  db.prepare(`UPDATE jobs SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?`).run(status, reason, now(), id);
}

export function getApp(id) {
  return db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id);
}

export function updateApp(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE applications SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => fields[k]), now(), id);
}

// One-time fix (Nov 2026): emails approved with a blank CC copied "no CC" into themselves, so a CC list saved
// later never reached them. Unsent ones now follow the saved list (Status → Cc on every email) at send time.
if (getState('cc_blank_migrated', '0') !== '1') {
  db.prepare(`UPDATE applications SET cc_emails = NULL WHERE cc_emails = '' AND status IN ('draft','queued','held','failed')`).run();
  setState('cc_blank_migrated', '1');
}
