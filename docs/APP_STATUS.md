# Codestead — what it is, what works, what's next

Checked on 2026-09-23 by booting the app locally (`npm run dev`, port 3100) and clicking through it, plus reading the code and `docs/release-audit.md`.

## 1. The idea in one paragraph

Codestead is a private, invite-only coding school for a small group of learners. A learner signs up, says what they already know, what they want to learn and what they enjoy (cooking, cricket, music...). The app builds them a personal roadmap through real courses, teaches each skill with short lessons, lets them run code, gives them practice and games, and only calls a skill "mastered" when there is real evidence (independent practice, tests, a delayed review). An AI tutor, using the learner's own API key (NVIDIA NIM by default), explains things and uses the learner's hobbies for examples, but it is never allowed to grade, give answers to exams or change mastery. A mentor/admin console lets you watch learners, adjust plans and approve things.

## 2. What's in it

| Area | What exists |
|---|---|
| Courses | 12 tracks, 476 lessons: Programming foundations, Python, HTML, CSS, JavaScript, React, DSA (in C/C++/Java/Python), Git, C, C++, Java, AI. "Coming soon" roadmap entries for Qt, NumPy, pandas, Spring, Spring Boot. No SQL/databases course yet. |
| Lesson page | Tabs: Lesson, Practice, Code, Visualize, Quest (logic game). Predict-then-reveal questions, worked examples, traces, misconceptions, practice. |
| Assessment | 1,385 auto-graded questions (MCQ, fill-in, code, trace), hints ladder, formal timed exams with re-checks and appeals. |
| Adaptive learning | Diagnostic placement, mastery evidence engine, remediation, spaced review ("Skill refresh"). |
| AI tutor | `/tutor` + "Ask Codestead" button in lessons. Providers: NVIDIA NIM, OpenRouter, Gemini, OpenAI, Anthropic, DeepSeek, custom. Keys stored encrypted per learner. Hobby-based analogies already coded (`src/lib/ai/context.ts`). |
| Code execution | Own runner service (`services/runner`) for C, C++, Java, Python, JavaScript in locked-down Docker containers. |
| Other pages | Roadmap, Code lab (playground), Projects, Career trails, Certificates, Public portfolio, Community, Request a topic, Settings, Admin console (learners, access requests, curriculum, appeals, certificates...). |
| Accounts & security | Invite-only, email/password + Google, mandatory 2FA (TOTP), one active device, lost-device recovery. |
| Ops | Email outbox (console adapter now, Gmail later), encrypted backups, Cloudflare Tunnel + Docker deployment files. |

## 3. What I saw working (local, demo mode)

- App boots in ~8 s. Home/marketing page loads.
- Learner demo (`/learn`) shows a demo learner "Aarav Rao" with next step, review queue, streak.
- Courses list and course pages load; lesson pages render all 476 rewritten lessons with tabs.
- Tutor page loads with an opening prompt.

## 4. What is broken or blocked right now

| # | Problem | Why | Priority |
|---|---|---|---|
| 1 | **Run code fails** ("Authentication required") | Demo mode is read-only; runs need a signed-in account. Also the runner service (port 4100) isn't running. | High |
| 2 | **Tutor chat fails** ("Authentication required") | Same: needs signed-in account + a saved provider key. | High |
| 3 | **Code tab draft save** shows "Server draft sync unavailable" | Same auth cause. | Medium |
| 4 | **Lesson summary shows raw markdown** (`**items**`, backticks) in the top summary box | That block renders plain text, not markdown. | Medium, easy |
| 5 | **Lessons are all flagged "Draft preview · AI-assisted"** and 0 questions are exam-eligible | A publication gate requires a human reviewer on every lesson before real learners see them as published and before exams can use them. | High (decide: review, or relax the gate for the MVP) |
| 6 | **Tutor model** is `meta/llama-3.1-8b-instruct` in `.env` | You want gpt-oss-20b on NIM. One-line config change. | Easy |
| 7 | Nothing committed | 490 changed files from the lesson rewrite. | Easy |
| 8 | Full `npm run check` not run since rewrite | Takes ~9 min. | Easy |
| 9 | C/C++ lesson samples not compiled by me | No compiler on this machine; the repo's own runner images can do it (`npm run c-cpp:executable:check`). | Medium |

## 5. What's deliberately left for later (your call: not MVP)

- Real Gmail sending (console adapter prints emails for now).
- Cloudflare, NUC deployment, backups to Google Drive, power-cut/reboot drills, real-device accessibility checks.
- The heavy release-audit items (43 done / 70 partial / 2 missing out of 115) — most are "prove it in production" evidence, not missing features.
- Old database-permission tightening (P3-2).

## 6. Improvement ideas

- **Interest-driven examples everywhere:** tutor already uses hobbies; extend to lesson examples generated per learner (with the canonical lesson kept as the source of truth).
- **Book-style content:** you pick a book whose voice you like; lessons get rewritten in that style.
- **SQL / databases course** (not in the 12 tracks yet).
- **Run every lesson sample in CI** through the runner so examples are always proven.
- **Simpler MVP mode:** optional 2FA and a single "dev admin" login for local use, so everything can be tried quickly.

## 7. Suggested order of work (small steps)

1. Commit the lesson rewrite; run `npm run check`.
2. Get a real signed-in session working locally (create your own account — you enter the password yourself), start the runner, and confirm **Run code** works.
3. Save a NIM key in Settings, switch the model to gpt-oss-20b, confirm **tutor chat** works with hobby analogies.
4. Fix the raw-markdown summary bug.
5. Decide on the "draft/unreviewed" gate for the MVP.
6. Walk every sidebar page one by one, fixing what breaks.
7. Then content improvements (book style, SQL course), then email/deploy.

## 8. Simple review flow (planned)

The per-artifact seven-dimension checklist in the admin console is **disabled, not deleted**
(`DETAILED_REVIEW_CHECKLIST_ENABLED` in `src/components/admin/admin-curriculum-publication.tsx`,
with the full rationale in the comment above it). Reasons: one reviewer, 964 artifacts, and the
server blocks approving AI-assisted artifacts unless the authored file itself names a human reviewer.

How a one-click owner approval should work:

1. **Approve** (per lesson) / **Approve course** (all lessons + banks of a course) stamps the
   authored JSON files: `publication.stage = "approved"`, `publication.reviewer = { kind: "human", … }`,
   `reviewedAt`, and marks bank items exam-eligible only where the runner has proven them.
2. Bump the course `version` (e.g. 0.1.0 → 0.1.1) and restage: staged drafts are immutable, so each
   approval round becomes a new course version. Previous versions stay in history.
3. Record the review event automatically with the checklist filled from the approval
   (all dimensions passed, evidence = "owner approval <date>"), so the server's existing rules pass
   without the form.
4. Publish beta or verified from the same screen; the gate then passes without the local-dev waiver.

Until then, local testing uses `ALLOW_UNREVIEWED_CURRICULUM=true` (development only) to publish drafts
as beta.
