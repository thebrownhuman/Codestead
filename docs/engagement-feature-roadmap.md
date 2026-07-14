# Engagement and learner-experience roadmap

**Status:** Approved product direction\
**Audience:** A small private cohort of adult beginner and intermediate learners\
**Design direction:** A playful "code arcade field guide"—energetic and rewarding without looking childish or making unsupported claims.

## Product rules that apply to every feature

1. Learning evidence is authoritative. Opening a page, replaying a game, or asking the tutor cannot by itself create mastery, XP, a badge, or leaderboard credit.
2. AI-generated questions are practice-only until a human reviewer approves and versions them. Deterministic graders decide objective correctness.
3. A learner is never told that an unseen topic is weak. "Needs review" requires prior evidence; unseen work is labelled "not started."
4. Progress animation celebrates a committed server result, never an optimistic browser-only state.
5. Market-demand and career claims must include a source, geography, and freshness date. If no reviewed source is available, the UI shows learning-path guidance without demand numbers.
6. Motion uses transform and opacity, stays brief, and has full reduced-motion parity. All actions remain keyboard and touch accessible.
7. Community, battles, profiles, projects, and leaderboards are private by default and expose only explicitly opted-in fields.

## Delivery plan

### Phase 1 — joined-up daily learning loop

- Adult, colorful visual tokens; route transitions; button, card, progress, and navigation micro-interactions.
- Authoritative dashboard with long-running streaks, distinct completed lessons, strong topics, and evidenced needs-review topics.
- A durable daily review session containing exactly five distinct reviewed questions when enough eligible content exists.
- Honest unavailable states when reviewed questions or evidence are insufficient.
- Existing opt-in leaderboard and project workspace surfaced from the learner home without fake cohort data.

### Phase 2 — practice and practical learning

- Inline checkpoint below each lesson, followed by the full Practice workspace.
- At least one reviewed MCQ per eligible topic, plus trace, fill-gap, debugging, or code practice where appropriate.
- Major-topic mini-project briefs, milestone evidence, GitHub submission, and deterministic review findings.
- Broader mentor memory: bounded cross-course mastery, active misconceptions, pace trends, and prior interventions.
- AI code-review explanation layered over immutable deterministic findings; no AI-only official score.

### Phase 3 — rewards with integrity

- Append-only, evidence-linked, idempotent XP ledger with daily caps and policy versions.
- Learner levels derived from that ledger, with accessible level-up celebrations.
- Course-completion and module-mastery trophies are implemented as a read-only presentation of verified certificate or exact independent exam evidence; revoked proof remains revoked and project activity cannot mint trophies.
- Weekly/monthly challenge definitions with eligibility, anti-farming rules, and immutable results.
- Portfolio and certificate artifacts with verification URLs and revocation/correction history.

Coins are deferred until they have a clear earning and spending purpose. Decorative balances would be misleading.

### Phase 4 — collaboration and career paths

- Friend challenges and coding battles using equivalent forms, asynchronous fallback, moderation, and privacy controls.
- Discussion spaces and study groups with reporting, moderation, rate limits, and retention rules.
- Mentor-support workflows connecting discussion to the existing admin evidence dashboard.
- Technology-next-step guidance based on prerequisites and learner goals.
- Reviewed career-demand cards with source, region, observation date, and expiry.
- Localized interface/content workflow after English curriculum quality is stable.

## Requested-feature status after Phase 1 starts

| Area | Existing foundation | Phase 1 work | Later work |
|---|---|---|---|
| Visual experience | Responsive light/dark/high-contrast UI and reduced motion | Color/motion system and more game-like progress | Richer quest maps and celebrations |
| Topic practice | Authored practice structures and deterministic attempt grading | Daily five-question journey | Inline checkpoints and full editorial publication |
| Gamification | Mastery badges and privacy-safe leaderboard | Progress path and evidence-based signals | XP ledger, levels, trophies, challenges, coins decision |
| Progress | Mastery, confidence, reviews, activity, course progress | Streak fix, completed lessons, strong/review topics | Bounded active-study time and deeper module map |
| Projects | Durable projects, files, milestones, public GitHub static review | Surface the existing workspace | AI explanation, private GitHub App, portfolio showcase |
| Community | Opt-in profiles and weekly/all-time leaderboard | Honest entry point from home | Battles, forums, groups, moderation |
| Tutor | Skill context, misconceptions, recent bounded chat, adaptive next action | Review-driven daily loop | Broader memory, pace model, daily challenge policy |
| Career | Course prerequisites and extension catalog | No unsupported demand claims | Sourced market data and reviewed pathway recommendations |
| Notifications | Inactivity and security notification infrastructure | No new unsolicited reminders | Learner-configurable goals/revision/challenge reminders |
| Accessibility | Keyboard, themes, font size, high contrast, reduced motion | Verify every new interaction | Localization workflow |

## Phase 1 acceptance checks

- A streak longer than seven days displays correctly from meaningful stored evidence.
- Duplicate completion events do not inflate the completed-lesson count.
- Strong and needs-review lists are cross-user isolated and never infer weakness from missing evidence.
- A learner gets the same daily-review session on retry; another learner cannot read or mutate it.
- A daily review contains five distinct, currently published, human-reviewed questions or clearly explains why it cannot start.
- Route and progress motion disappears under system or in-app reduced-motion settings.
- Dashboard, review, and navigation work at 320 px, tablet, and desktop widths with no horizontal overflow.
- Keyboard focus remains visible and logical; all controls retain at least a 44 px target.
