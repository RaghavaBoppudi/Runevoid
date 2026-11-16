// Entry point: dashboard + watcher (polls nvoids every POLL_SECONDS, with jitter) + paced mailer.
//   node src/index.js          run everything
//   node src/index.js --once   one poll, no dashboard, no sending (handy for testing)
import { config, emailConfigured } from './config.js';
import { db, logEvent, now } from './db.js';
import { pollOnce } from './pipeline.js';
import { listResumeFiles } from './resumes.js';
import { startServer } from './server.js';
import { startMailer } from './mailer.js';
import { refreshDrafts, clearStaleRematch } from './actions.js';

const once = process.argv.includes('--once');

// A crash mid-send leaves a row in 'sending'; we can't know if Gmail accepted it.
const stuck = db.prepare(`UPDATE applications SET status = 'failed', error = 'Interrupted while sending — check your Gmail Sent folder before retrying', updated_at = ? WHERE status = 'sending'`).run(now());
if (stuck.changes) logEvent('warn', 'recovered', null, `${stuck.changes} send(s) were interrupted; marked failed for you to check`);

refreshDrafts();
clearStaleRematch();

const resumes = listResumeFiles();
logEvent('info', 'startup', null, `Starting. Resumes found: ${resumes.map(r => r.folder).join(', ') || 'NONE'} in ${config.resumesDir}. Gmail ${emailConfigured() ? 'configured' : 'NOT configured'}${config.dryRun ? '. DRY RUN: nothing will be sent' : ''}.`);

if (once) {
  const r = await pollOnce();
  console.log(r);
  process.exit(r.error ? 1 : 0);
}

await startServer();
const stopMailer = startMailer();

let timer;
const loop = async () => {
  await pollOnce();
  const jitter = Math.floor(Math.random() * 3_000);
  timer = setTimeout(loop, config.pollSeconds * 1000 + jitter);
};
loop();

const stop = () => { clearTimeout(timer); stopMailer(); logEvent('info', 'shutdown', null, 'Stopped'); db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
