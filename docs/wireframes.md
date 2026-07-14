# Responsive experience wireframes

These low-fidelity wireframes record the intended information hierarchy and responsive collapse rules. The implemented React views are the authoritative visual artifact; browser and accessibility tests verify them. All layouts preserve document order, keyboard access, visible focus, text alternatives, reduced motion, and 200% zoom reflow.

## Learner roadmap

Desktop/tablet:

```text
┌ Top bar: brand | search | streak | avatar ──────────────────────────────┐
│ Side nav      │ Today                                                   │
│ Learn         │ ┌ Continue: next skill + deterministic reason ────────┐ │
│ Roadmap       │ │ objective | prerequisite state | Continue           │ │
│ Review        │ └──────────────────────────────────────────────────────┘ │
│ Projects      │ Skill roadmap                                            │
│ Community     │ [module progress]—[locked prerequisite]—[next module]   │
│ Settings      │ Due reviews | recent evidence | mentor plan update      │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Mobile: side navigation becomes a labelled bottom navigation; the next action, due review, and one roadmap module stack vertically. Formal exams show a desktop/tablet requirement instead of a cramped editor.

## Lesson, visualizer, and game

```text
┌ Course / module / skill                 Draft or published status ─────┐
│ Outline          │ [Lesson] [Code] [Visualize] [Quest]  Ask Codestead  │
│ canonical        │                                                     │
│ worked example   │ Canonical explanation                               │
│ trace            │ optional confirmed-interest analogy + limitation    │
│ misconception    │ worked example → faded completion → transfer task   │
│ remediation      │                                                     │
│ sources          │ Previous                               Next skill    │
└──────────────────┴─────────────────────────────────────────────────────┘
```

Visualizer mode replaces the content panel with code/current-line, variables and arrays/objects, call-stack/input/output regions, a live text explanation, and Restart/Step/Play-Pause controls. Quest mode uses the same panel for a server-checked deterministic stage, hint ladder, result explanation, and replay notice. Neither visualizer nor replay creates official mastery evidence.

On mobile, the outline becomes a disclosure above content, tabs scroll as one keyboard-accessible group, and state tables stack below code. The tutor is a dismissible sheet after the lesson content in DOM order.

## Formal exam

```text
┌ Exam title | server time remaining | autosave state | connection ──────┐
│ Question list │ prompt + constraints                                   │
│ 1 answered    │ ┌ editor ────────────────────────────────────────────┐ │
│ 2 current     │ │                                                     │ │
│ 3 unanswered  │ └─────────────────────────────────────────────────────┘ │
│ integrity     │ stdin | raw compiler output | visible cases            │
│ events        │ [Compile / Run]                         [Submit answer] │
│               │ Closed book: tutor/web/notes/visualizer unavailable    │
└───────────────┴────────────────────────────────────────────────────────┘
```

Tablet collapses the question list to a labelled drawer. The server-owned deadline and autosave state remain visible. Phone shows preparation/results only and blocks starting a formal programming exam.

## Projects

```text
┌ Projects ───────────────────────────────────────────────────────────────┐
│ project card: goal | milestone | visibility | files/quota             │
│ PRD | architecture | acceptance criteria | rubric | test plan          │
│ Public GitHub URL + pinned commit SHA  [Run safe static review]         │
│ Findings: severity | file:line | evidence | Socratic next step          │
└────────────────────────────────────────────────────────────────────────┘
```

The coach never provides a paste-ready complete feature. Private repositories remain unavailable until a later read-only selected-repository GitHub App exists.

## Closed cohort and leaderboards

```text
┌ My cohort profile preview ───────────┐ ┌ Leaderboard ──────────────────┐
│ alias/avatar                         │ │ Weekly | All time              │
│ selected mastery/badges/projects     │ │ consistency | new mastery     │
│ coarse streak                        │ │ project | comeback | capped XP│
│ [Publish] [Withdraw]                 │ │ explanation + scoring version │
└──────────────────────────────────────┘ └────────────────────────────────┘
```

No learner appears without current cohort consent and an explicit publication action. Email, private scores/failures, raw time, hint dependency, code/chat, provider use, sessions, and fastest-completion rankings never enter the projection.

## Administrator mentor console

```text
┌ Admin: learner matrix | reviews | appeals | curriculum | operations ───┐
│ Learner list     │ learner evidence summary                            │
│ blocker/status   │ roadmap + plan revision/diff/downstream impact       │
│ provider health  │ misconceptions | review due | exam readiness         │
│ runner/storage   │ appeals/projects/sessions/provider safe metadata      │
│                  │ audited deliberate detail actions                    │
└──────────────────┴─────────────────────────────────────────────────────┘
```

Curriculum publication uses a separate evidence workspace: candidates, immutable artifacts, seven-dimension human checklist, item coverage, release evidence, gate result, publish/retire, and pointer-only rollback. Every mutation requires fresh MFA and a recorded reason.

## Responsive acceptance map

| Experience | Desktop | Tablet | Phone |
|---|---|---|---|
| Lessons, quizzes, tutor, profiles | Full | Full | Full, stacked |
| Code practice | Full editor | Full editor | Short practice only |
| Visualizer and quest | Multi-panel | Collapsible panels | Text-first stacked state |
| Formal programming exam | Required | Supported | Start blocked |
| Admin mutation workflows | Full | Supported with drawers | Read-only/urgent controls only |
| Manual checks still required | Keyboard, screen reader, 200% zoom | Touch + external keyboard | Real iOS Safari, VoiceOver, 320 px |
