# Codestead design system

This file is the visual source of truth for Codestead. A page-specific file in `design-system/learncoding/pages/` may override a rule only when it names the reason and preserves the accessibility and evidence rules below.

## Product point of view

Codestead is a code arcade field guide for university-age learners. Its promise is **Build skills that stay.** It should feel energetic and game-like without looking childish or making education feel disposable.

- Audience: primarily learners aged 18–24, plus one administrator/mentor.
- Tone: friendly, direct, optimistic, technically credible.
- Signature: a restrained four-colour “signal rail” that marks navigation, progress, checkpoints, and feedback.
- Visual risk: selective cyan/violet/amber/coral signals inside the established forest-and-paper world. The surrounding surfaces remain quiet so the signals stay meaningful.
- Never fabricate XP, coins, levels, mastery, demand, completion, or achievements. A colorful placeholder must still say that it is a preview.

The generated “Baloo 2 + Comic Neue” child-learning recommendation was deliberately rejected. The learners are young adults, external font fetching adds privacy/performance cost, and cartoon typography would weaken trust.

## Foundations

### Typography

Use installed/system fonts only.

| Role | Stack | Use |
| --- | --- | --- |
| Interface and display | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Navigation, headings, body, controls |
| Code and evidence | `"SFMono-Regular", Consolas, "Liberation Mono", monospace` | Code, hashes, timers, tabular technical data |

- Headings use weight and tight tracking for character; no novelty font is needed.
- Body copy uses 1.5–1.7 line-height and a readable measure of roughly 65–75 characters.
- Controls and mobile inputs remain at least 16px where browser zoom behavior matters.
- User font-size preferences must continue to scale the interface.

### Core palette

The forest palette communicates trust and continuity. Signal colors add game energy and must retain a stable role.

| Token | Light | Dark | High contrast | Meaning |
| --- | --- | --- | --- | --- |
| `--brand` | `#225e3d` | `#80d1a3` | `#8cffb3` | Primary action and learning continuity |
| `--signal-cyan` | `#0b6f73` | `#65d4d5` | `#67f4ff` | Active path, code/run, current location |
| `--signal-violet` | `#6548a8` | `#c0a6ff` | `#d5b8ff` | Checkpoints, reflection, profile state |
| `--signal-amber` | `#7a5314` | `#f0c36a` | `#ffd400` | Rewards, pending work, caution |
| `--signal-coral` | `#a84432` | `#ff9d82` | `#ffab96` | Attention, social activity, warm emphasis |

Every signal has a matching `-soft` surface token. Use the base color for text/icons and the soft token for backgrounds. Do not communicate state with color alone: pair it with text, an icon, shape, `aria-current`, or another semantic attribute.

Existing compatibility tokens map to signals:

- `--info` → cyan
- `--gold` → amber
- `--accent` → coral

### Surfaces and shape

- Canvas: soft mineral/forest background, with low-opacity signal washes only at the page edges.
- Cards: clearly separated surfaces with a 1px semantic border; blur is optional and never required for legibility.
- Radius scale: 14px controls, 20px cards, 28px large containers.
- Elevation: two levels only (`--shadow-small`, `--shadow`) to avoid random floating panels.
- Layout follows a 4/8px rhythm with adaptive gutters at 375, 768, 1024, and 1440 widths.

## Interaction and motion

Motion explains cause and effect. It is not ambient decoration.

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | `120ms` | Press response and tiny state feedback |
| `--motion-base` | `180ms` | Hover, menu, drawer, scrim |
| `--motion-slow` | `260ms` | Route-stage entrance and one-time success emphasis |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entering and interactive movement |

- Animate only `transform` and `opacity` for spatial movement. Color, border, and shadow may transition without moving layout.
- Route changes use one 260ms fade/8px rise on the content stage. Navigation remains stable.
- A press scales to about `0.975` immediately and releases through the shared easing.
- Hover is an enhancement behind `@media (hover: hover)`; no feature depends on it.
- Keep normal screens to one or two prominent moving elements.
- `prefers-reduced-motion`, `data-motion="reduce"`, and `data-reduce-motion="true"` collapse transitions and animations to effectively instant state changes.

## Navigation shell

- Desktop: persistent 248px sidebar and sticky top bar.
- Tablet: focus-managed drawer with a visible scrim and Escape dismissal.
- Phone: five top-level destinations in a safe-area-aware bottom bar; secondary destinations remain in the drawer.
- Current location is announced with `aria-current="page"`, a surface change, an active rail, stronger text, and a cyan icon. Color is not the only cue.
- All internal destinations use Next.js `Link`; browser history and deep links remain intact.
- Every interactive target is at least 44×44px.
- The skip link and visible keyboard focus ring remain mandatory.

## Component rules

### Buttons

- One primary action per decision area.
- Primary buttons use the forest action token; signal colors are contextual accents, not competing CTAs.
- Provide hover, pressed, focus-visible, busy, and disabled states.
- Press feedback must not alter surrounding layout.
- Icon-only controls require an accessible name.

### Cards and paths

- Static cards do not lift on hover. Only genuinely interactive cards receive pointer/pressed behavior.
- A roadmap/path may use the signal sequence cyan → violet → amber → coral, but each node also needs a label and completion state.
- Progress animation reveals already-authoritative progress; it must never imply unearned completion.

### Feedback and rewards

- Success: brand green plus confirmation text/icon.
- Attention: coral plus a clear next action.
- Pending/reward: amber plus status text.
- Informational/current: cyan.
- Reflection/checkpoint: violet.
- Mastery and trophies render only from deterministic stored evidence.

## Responsive and accessibility contract

- Minimum supported viewport is 320px; primary visual checks are 375, 768, 1024, and 1440px.
- No horizontal page scrolling. Long code/data regions may use clearly bounded internal overflow when necessary.
- Fixed navigation reserves content space and respects `env(safe-area-inset-bottom)`.
- Normal text meets WCAG AA 4.5:1; large text and UI graphics meet at least 3:1.
- Light, dark, and high-contrast themes are designed independently, not mechanically inverted.
- Full keyboard operation, logical focus order, visible focus, zoom, adjustable text, and reduced motion are release requirements.
- Never rely on hover, animation, color, drag, or swipe as the only way to understand or perform an action.

## Content truth rules

- Market-demand claims require an administrator-reviewed source and an “as of” date.
- “Recommended next” must explain the prerequisite/evidence used.
- Draft courses, practice, and projects are labeled as draft/beta wherever surfaced.
- Community counts and rankings use persisted, consented data only.
- Gamification rewards motivation; they do not override mastery evidence or hide failure/remediation.

## Pre-delivery checks

- [ ] Light, dark, and high-contrast states inspected.
- [ ] Keyboard-only navigation and Escape behavior verified.
- [ ] 44px targets and visible focus verified.
- [ ] 320/375/768/1024/1440 widths have no page overflow.
- [ ] 200% text does not hide actions or status.
- [ ] Reduced-motion path preserves every state change without meaningful movement.
- [ ] Animations use transform/opacity for movement and remain at or below 260ms.
- [ ] No emoji used as a structural icon; Lucide stroke language stays consistent.
- [ ] No fabricated progress, XP, coins, trophies, mastery, or market demand.
