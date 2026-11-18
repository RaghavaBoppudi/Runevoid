# RUNE

Watches [nvoids.com](https://nvoids.com) every minute for new AI/ML requirements. For each one it
picks the best resume from the Word files in your resume folder and drafts an email to the recruiter
with that resume attached. **Nothing is sent until you approve it.** Approved emails then go out
one at a time, paced like a person, after vendor rules are re-checked. Everything is logged.

## How it works

```
every 60s ─► nvoids listing ─► new job ids only ─► open each posting (recruiter email + full JD)
                                                     │
                     filters: skip W2/C2H-only, citizens/GC-only, no-H1B, clearance,
                     consultant hotlists & "resume of my consultant" posts, non-engineering
                     titles (BA/PM/QA/SAP/Salesforce…); keep only AI/ML roles (an AI/ML term
                     in the title, or MIN_AI_JD_TERMS AI/ML technologies in the JD); flag doubtful ones
                                                     │
              score every resume in Resumes AI\1, \2, … against the JD (local AI model +
              skill keywords; no data leaves your PC). Below MIN_MATCH_SCORE → no draft.
              A vendor LOCK overrides the pick.
                                                     │
                                                     ▼
                       Review tab: PRIORITY (posted < 10 min ago) · Standard · Held
                       you can change the resume, To, subject or text → Approve → queue
                                                     │
                                                     ▼
       MAILER, one email at a time: re-check rules (lock → repost → same-day → weekly cap)
       → send via Gmail → log + Sent_History.md → wait 60–120 s (10–20 s for priority) → next
```

## Setup (one time)

1. **Gmail App Password.** In your Google Account, turn on 2-Step Verification, then open
   *Security → App passwords*, create one called "nvoids bot", and copy the 16-character code.
2. Copy `.env.example` to `.env`. Fill in `GMAIL_USER`, `GMAIL_APP_PASSWORD` and `SENDER_NAME`.
   For your first day, set `DRY_RUN=true` so the bot does everything except send.
3. Check **`templates/email.txt`** (the email format) and set `SENDER_PHONE`, `SENDER_EMAIL` and
   `SENDER_YEARS` in `.env` for the signature and the "I bring 10+ years…" line. Placeholders:
   `{title}` (the role as the JD names it, with any location cut off),
   `{greeting}`, `{client_part}` (" supporting Amex initiatives" when the JD names a client),
   `{experience_line}` and `{background_line}` (only skills/topics found in both the JD and the
   attached resume), `{closing}`, `{signature_block}`. Any email mentioning "nvoids", a job ID or the job's location is blocked,
   and only C2C and H1B are ever bold.
4. Run it:

   ```bash
   cd "C:\path\to\nvoids-bot"
   npm install
   npm start
   ```

5. Open **http://127.0.0.1:7892**, click **Test email to me**, and check your inbox. Then turn
   `DRY_RUN` off and restart.

The first check reads the newest page (about 100 postings), which takes about 3 minutes. After
that, each check only opens postings newer than the last one it saw.

## Dashboard

| Tab | What's there |
|---|---|
| **Review** | **Priority** drafts (posted in the last 10 min) at the top, then emails **Held** by a vendor rule (with the reason and the buttons to resolve them), then **Standard** drafts, then the **queue** of approved emails waiting to send (with **Pull back**). Each draft shows a resume dropdown with every folder's match %, the JD skills the resume covers and misses, warnings, the editable email, and the full JD. |
| **Applied** | Everything sent, skipped or failed: sent time, approved time, resume folder, match %, lock, location and recruiter. CSV download, plus `Sent_History.md` (each email's exact text and the full JD). |
| **Vendors** | Add, edit or remove **permanent locks**. Shows every vendor you've emailed (sends, this week, last sent, folders sent, today's folder, lock) and the change history. |
| **All scraped** | Every posting the bot saw, with its status and why it was kept or dropped. |
| **Log** | Every check, draft, approval, hold, send and error. |
| **Health** | App status and a **CC recipients** field. Save one or more comma-separated email addresses here; the setting applies immediately and persists across restarts. |

Header controls: **Pause sending** (the queue waits), **Pause watcher** (stops checking nvoids),
**Check now**, **Test email to me**, a countdown to the next send, sent today / daily cap, and a
**DRY RUN** badge when it's on. The pause switches survive restarts.

The CC list can also be set in `.env` as `CC_EMAILS`. Once you save a list in the dashboard's Health
tab, that saved list takes precedence over `.env`; clear the field and save to remove all CC recipients.

## Vendor rules

A vendor is the exact address: `abc@cdf.com` and `abc@cvb.com` are different vendors. The rules
are checked right before each send, one email at a time, so a backlog is always judged against
what has really gone out.

| Rule | What happens | Your options when held |
|---|---|---|
| **Permanent lock** (Vendors tab) | The vendor only ever gets the locked resume folder. Drafts use it from the start. If you lock after a draft exists, the text is rewritten for the locked resume (or held if you edited it). If the locked file is missing, or fits the job below `MIN_MATCH_SCORE`, the email is held and no other resume is substituted. | Switch to locked resume · Retry · Skip |
| **Repost** | Held if the same vendor already got the same job title within 30 days, or a ≥70%-identical JD within 3 hours. | Not a repost, send anyway · Skip |
| **Same-day** | A vendor never gets two **different** resumes on the same day. The same resume twice is fine. | Use today's resume · Send tomorrow · Skip |
| **Weekly cap** | At most 3 emails per address per calendar week (resets Monday). | Send next week · Skip |
| **Daily cap** | At most 200 scraped nvoids emails per day by default (`DAILY_SEND_CAP`); manual entries bypass and do not count toward this cap. Other vendor rules still apply. | — |

Draft-only warnings (nothing is blocked): the posting has a nvoids "hotlist" tag, a bench-sales
signature, words nvoids scrubbed such as "(No )", a work-authorization status in the title,
"local only", or a W2 mention; the JD is thin; someone else at the same company got a different
resume; or the same JD already went out through another vendor (double-submission risk).

The bot can't tell when a vendor submits you (it doesn't read your inbox). Add the lock yourself
when that happens.

## Resumes

The bot reads `.docx` files placed directly in `RESUMES_DIR` and also supports the older
`RESUMES_DIR/<number>/Resume.docx` layout. To add a resume, copy its Word `.docx` file into
`RESUMES_DIR`; its filename (without `.docx`) is its name in the dashboard and in vendor locks.
For example, `AI Resume.docx` appears as **AI Resume**. You can also keep numbered subfolders;
those appear as **Folder 1**, **Folder 2**, and so on. Edited resumes are re-read automatically.

**Match %** = the share of the JD's *weighted* skills that the resume also has (`src/matcher.js`, using the
~300-skill list in `src/vocab.js` ported from the Python mailer). A skill counts more when it's in the job
title (×2.5) or a "Required/Skills" section (×1.5); common ones (Python, SQL, "AI", "machine learning") count
half, and skills only under "Preferred" count a quarter. Related tools earn partial credit (PyTorch toward
TensorFlow), and "AWS or Azure" is satisfied by either. Terms missing from the vocabulary are also scored
when found in explicit skill/technology lists or clauses such as "experience with X"; those terms are
matched literally against each resume. nvoids' auto-generated `Keywords:` line and the recruiter's
signature are ignored. Low-fit scraped postings retain their ranking and missing-keyword details in
"All scraped"; older low-fit postings can be re-scored there with the current matcher.

The Review list keeps priority postings separate from standard ones; each group is sorted by the best
match across your resumes, with the selected resume shown alongside it.

**Which resume is attached** is set in **`resume-lanes.json`** (edits apply without a restart). Among the
resumes within `margin` (8) points of the best score, one whose *lane* matches the job title wins; otherwise
your `default` folder (1) is kept; otherwise the top scorer, with near-ties going to the local AI model's
similarity. Each draft shows *why* its resume was picked.

## Files

All in `data/` (gitignored): `nvoids-bot.db` (SQLite: jobs, applications, locks, audit, log),
`Sent_History.md` (human-readable record of every email sent), `models/` (the local AI
model, about 90 MB), and `resume-cache/` (local extracted resume text and matching vectors,
reused until a resume file changes). The resume cache stays on your computer. CSV downloads:
`/export/applications.csv`, `/export/jobs.csv`, `/export/events.csv`, `/export/locks.csv`.

## Safety

- The dashboard listens on 127.0.0.1 only. It refuses requests that don't come from the page
  itself, so other websites in your browser can't approve emails.
- If the bot crashes mid-send, that email is marked *failed* with a note. Check Gmail's Sent
  folder before retrying.
- Keep `POLL_SECONDS` at 60 or more, and keep `DAILY_SEND_CAP` modest on a new Gmail account.
- To change what counts as AI/ML, what gets skipped, or what gets flagged, edit the lists at the
  top of `src/filters.js`.
