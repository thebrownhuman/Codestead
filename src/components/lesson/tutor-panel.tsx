"use client";

import { ArrowUp, Check, Minus, PanelRightClose, PanelRightOpen, PenLine, Sparkles, SquarePen } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useTutorLesson } from "./tutor-context";
import { TutorMarkdown } from "./tutor-markdown";
import styles from "./tutor-panel.module.css";

export type PetState = "ready" | "thinking" | "writing" | "error";

type PetAction = "look" | "hop" | "wave" | "stretch" | "cheer" | "hi" | null;

export function MentorPet({ state, size = "md", action = null }: { state: PetState; size?: "sm" | "md"; action?: PetAction }) {
  return <div
    aria-hidden="true"
    className={styles.mentorPet}
    data-action={action ?? undefined}
    data-size={size}
    data-state={state}
    data-testid="codestead-mentor-pet"
  >
    <svg viewBox="0 0 80 80">
      <circle className={styles.petOrbit} cx="40" cy="39" r="31" />
      <ellipse className={styles.petShadow} cx="40" cy="69" rx="18" ry="4" />
      <g className={styles.petCharacter}>
        <path className={styles.petStem} d="M40 24V17" />
        <path className={styles.petLeaf} d="M40 18c1-8 8-10 13-8-1 7-6 11-13 8Z" />
        <path className={styles.petLeaf} d="M40 20c-1-6-6-9-11-7 1 6 5 9 11 7Z" />
        <rect className={styles.petBody} height="39" rx="17" width="48" x="16" y="24" />
        <rect className={styles.petFace} height="23" rx="10" width="36" x="22" y="32" />
        <g className={styles.petEyes}>
          <ellipse cx="32" cy="42" rx="2.4" ry="3.2" />
          <ellipse cx="48" cy="42" rx="2.4" ry="3.2" />
        </g>
        <path className={styles.petSmile} d="M35 48c3 3 7 3 10 0" />
        <path className={styles.petFrown} d="M35 50c3-2.5 7-2.5 10 0" />
        <g className={styles.petArm}>
          <path d="M16 42c-5 1-6 5-4 8" />
          <circle className={styles.petHand} cx="12.3" cy="50.6" r="2" />
        </g>
        <g className={`${styles.petArm} ${styles.petArmRight}`}>
          <path d="M64 42c5 1 6 5 4 8" />
          <circle className={styles.petHand} cx="67.7" cy="50.6" r="2" />
        </g>
        <path className={styles.petFoot} d="M27 62v4m26-4v4" />
        {/* Laptop in front, lid facing us: his eyes peek over the top, the
            screen lights his face, and two little hands type on the front edge. */}
        <g className={styles.petLaptop}>
          <ellipse className={styles.laptopGlow} cx="40" cy="44" rx="16" ry="9" />
          <g className={styles.laptopLid}>
            <path className={styles.lidShell} d="M22.5 49.5h35a2 2 0 0 1 2 2.3l-1.6 10.2h-35.8l-1.6-10.2a2 2 0 0 1 2-2.3Z" />
            <path className={styles.lidShine} d="M25 51.5h12" />
            <path className={styles.lidLogo} d="M40 58.6c-2.3 0-3.6-1.6-3.6-3.4 0-1.6 1.1-2.7 2.4-2.7.6 0 1 .3 1.2.3s.6-.3 1.2-.3c1.3 0 2.4 1.1 2.4 2.7 0 1.8-1.3 3.4-3.6 3.4Zm0-6.4c.1-1.1.8-1.9 1.9-2.1" />
          </g>
          <rect className={styles.laptopBase} height="3.4" rx="1.7" width="46" x="17" y="61.6" />
          <g className={styles.typingHand}><path d="M19 44c-3 5-2 12 6 17.5" /><circle cx="26" cy="61.8" r="2.2" /></g>
          <g className={`${styles.typingHand} ${styles.typingHandRight}`}><path d="M61 44c3 5 2 12-6 17.5" /><circle cx="54" cy="61.8" r="2.2" /></g>
        </g>
      </g>
    </svg>
  </div>;
}

type Mode = "float" | "dock" | "min";
type Rect = { x: number; y: number; w: number; h: number };
type Message = { id: string; role: "user" | "assistant"; content: string; error?: boolean };

const STORAGE_KEY = "codestead.tutor-window";
const MIN_W = 320;
const MIN_H = 380;
const EDGE = 8;
const DOCK_SNAP = 24;
const PHONE_QUERY = "(max-width: 640px)";
const RESIZE_DIRS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type ResizeDir = typeof RESIZE_DIRS[number];

// One-word thoughts that change every few seconds while Patch waits on the
// model, so a slow answer still feels alive.
const THINKING_PHRASES = [
  "Reading", "Looking", "Searching", "Thinking", "Simplifying", "Checking", "Almost",
] as const;
const IDLE_ACTIONS: readonly PetAction[] = ["look", "hop", "wave", "stretch"];

function PetPerch({ state, typing }: { state: PetState; typing: boolean }) {
  const [action, setAction] = useState<PetAction>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const previous = useRef(state);

  // One-off reactions to state changes: a hop when a question goes out and a
  // cheer when an answer finishes.
  useEffect(() => {
    const before = previous.current;
    previous.current = state;
    if (before === state) return;
    const reaction: PetAction = prefersReducedMotion() ? null
      : state === "thinking" ? "hop" : before === "writing" && state === "ready" ? "cheer" : null;
    const start = window.setTimeout(() => {
      if (reaction) setAction(reaction);
      if (state === "thinking") {
        setStartedAt(Date.now());
        setNow(Date.now());
      }
    }, 0);
    // Each timer only clears its own action, so it never cuts off a hi wave.
    const clear = window.setTimeout(() => setAction((current) => current === reaction ? null : current), reaction === "cheer" ? 1600 : 700);
    return () => {
      window.clearTimeout(start);
      window.clearTimeout(clear);
    };
  }, [state]);

  useEffect(() => {
    if (state !== "thinking") return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => window.clearInterval(timer);
  }, [state]);

  // While idle Patch fidgets every few seconds: glance around, hop, wave or stretch.
  useEffect(() => {
    if (state !== "ready" || prefersReducedMotion()) return;
    let clear = 0;
    const timer = window.setInterval(() => {
      const fidget = IDLE_ACTIONS[Math.floor(Math.random() * IDLE_ACTIONS.length)] ?? null;
      // Skip this fidget if Patch is already doing something (like waving hi).
      setAction((current) => current ?? fidget);
      clear = window.setTimeout(() => setAction((current) => current === fidget ? null : current), 1400);
    }, 7000 + Math.floor(Math.random() * 4000));
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(clear);
    };
  }, [state]);

  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const phrase = THINKING_PHRASES[Math.floor(seconds / 3) % THINKING_PHRASES.length];
  // Idle Patch says nothing; the thought cloud only appears when something happens.
  const thought: { kind: string; word: string } | null = state === "thinking" ? { kind: "thinking", word: phrase }
    : state === "writing" ? { kind: "writing", word: "Writing" }
      : action === "hi" ? { kind: "hi", word: "Hi!" }
        : state === "error" ? { kind: "error", word: "Oops" }
          : action === "cheer" ? { kind: "done", word: "Done" }
            : typing ? { kind: "listening", word: "Listening" } : null;

  // Keep the last thought on screen while the cloud shrinks away.
  const [shown, setShown] = useState(thought);
  if (thought && (thought.kind !== shown?.kind || thought.word !== shown.word)) setShown(thought);

  // Hovering (or clicking) Patch makes him wave and say hi. A short cooldown
  // stops him waving non-stop while the pointer wiggles over him; a hi
  // replaces any idle fidget that happens to be playing.
  const lastHi = useRef(0);
  function sayHi() {
    if (state === "thinking" || state === "writing" || action === "hi" || Date.now() - lastHi.current < 1500) return;
    lastHi.current = Date.now();
    setAction("hi");
    window.setTimeout(() => setAction((current) => current === "hi" ? null : current), 1300);
  }

  return <div
    className={styles.perch}
    data-action={action ?? undefined}
    data-listening={typing && state === "ready" ? "true" : undefined}
    data-state={state}
  >
    <i aria-hidden="true" className={styles.ground} />
    {/* The rig moves as one piece, so the cloud hops and bobs with Patch. */}
    <div className={styles.rig}>
      <span aria-live="polite" className={styles.srOnly} role="status">{thought ? `${thought.word}${thought.kind === "thinking" || thought.kind === "listening" ? "…" : ""}` : ""}</span>
      <span aria-hidden="true" className={styles.thought} data-kind={shown?.kind} data-visible={thought ? "true" : undefined}>
        <span className={styles.thoughtCloud}>
          {/* Stretched to fit the word, so the cloud grows wide and thin rather than tall. */}
          <svg className={styles.cloudShape} preserveAspectRatio="none" viewBox="0 0 120 52">
            <path d="M22 44C8 45 3 33 12 26C5 15 18 5 30 12C36 2 54 1 61 10C69 1 87 3 91 14C105 9 117 20 109 30C119 38 109 49 96 45C88 53 72 51 66 45C58 53 40 53 34 45C30 49 24 48 22 44Z" />
          </svg>
          <span className={styles.thoughtText} key={shown?.word}>{shown?.word}</span>
          {(shown?.kind === "thinking" || shown?.kind === "listening") && <span className={styles.thinkDots}><i /><i /><i /></span>}
          {shown?.kind === "writing" && <PenLine className={styles.pencil} size={11} />}
          {shown?.kind === "done" && <Check className={styles.check} size={12} strokeWidth={3} />}
          {shown?.kind === "error" && <span className={styles.question}>?</span>}
        </span>
        {/* Trail circles sit in front of the cloud, growing from Patch's head. */}
        <i className={styles.trailMid} />
        <i className={styles.trailSmall} />
      </span>
      <button aria-label="Say hi to Patch" className={styles.petButton} onClick={sayHi} onPointerEnter={sayHi} type="button">
        <MentorPet action={action} size="sm" state={state} />
      </button>
    </div>
  </div>;
}

function clampRect(rect: Rect): Rect {
  const w = Math.min(Math.max(rect.w, MIN_W), window.innerWidth - EDGE * 2);
  const h = Math.min(Math.max(rect.h, MIN_H), window.innerHeight - EDGE * 2);
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, EDGE), window.innerWidth - w - EDGE),
    y: Math.min(Math.max(rect.y, EDGE), window.innerHeight - h - EDGE),
  };
}

function defaultRect(): Rect {
  const w = 420;
  const h = Math.min(640, window.innerHeight - 110);
  return clampRect({ w, h, x: window.innerWidth - w - 16, y: 84 });
}

function loadSaved(): { mode: Mode; rect: Rect } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as { mode?: unknown; rect?: Partial<Rect> } | null;
    const rect = saved?.rect;
    if (rect && [rect.x, rect.y, rect.w, rect.h].every((value) => typeof value === "number" && Number.isFinite(value))) {
      return { mode: saved?.mode === "dock" ? "dock" : "float", rect: clampRect(rect as Rect) };
    }
  } catch {
    // Storage can be blocked; the default window position is fine.
  }
  return { mode: "float", rect: defaultRect() };
}

// matchMedia is missing in some embedded and test browsers; treat that as "no preference".
function mediaMatches(query: string) {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function prefersReducedMotion() {
  return mediaMatches("(prefers-reduced-motion: reduce)");
}

const BUBBLE_KEY = "codestead.patch-bubble";
const BUBBLE_SIZE = 60;
const BUBBLE_MARGIN = 18;
const DRAG_THRESHOLD = 5;
// Apple-style motion: a springy grow out of the icon, a quicker ease back in.
const OPEN_EASING = "cubic-bezier(.2,1.18,.4,1)";
const CLOSE_EASING = "cubic-bezier(.45,0,.55,1)";

type BubblePos = { x: number; y: number };

function clampBubble(pos: BubblePos): BubblePos {
  return {
    x: Math.min(Math.max(pos.x, BUBBLE_MARGIN), window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN),
    y: Math.min(Math.max(pos.y, BUBBLE_MARGIN), window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN),
  };
}

function loadBubble(): BubblePos {
  try {
    const saved = JSON.parse(window.localStorage.getItem(BUBBLE_KEY) ?? "null") as Partial<BubblePos> | null;
    if (saved && typeof saved.x === "number" && typeof saved.y === "number" && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return clampBubble({ x: saved.x, y: saved.y });
    }
  } catch {
    // Fall back to the default corner.
  }
  return clampBubble({ x: window.innerWidth, y: window.innerHeight });
}

function starterPromptsFor(title: string) {
  return [
    { label: `Explain ${title} simply`, prompt: `Explain ${title} in plain words.` },
    { label: "Show a tiny example", prompt: "Show me one tiny example of this skill." },
    { label: "Quiz me", prompt: "Ask me one beginner question about this skill." },
  ];
}

const noSubscribe = () => () => undefined;

// Patch reads window size and storage when he first renders, so he only mounts in the browser.
export function TutorLauncherHost() {
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  return inBrowser ? <TutorLauncher /> : null;
}

// Patch lives on every page as a draggable bubble. Clicking him grows the chat
// out of the bubble; minimizing shrinks it back in. The conversation survives
// page changes because this component stays mounted in the app shell.
export function TutorLauncher() {
  const lesson = useTutorLesson();
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ id: string; shown: number } | null>(null);
  const [initial] = useState(loadSaved);
  const [mode, setMode] = useState<Mode>("min");
  const [rect, setRect] = useState<Rect>(initial.rect);
  const [dockHint, setDockHint] = useState(false);
  const [phone, setPhone] = useState(() => mediaMatches(PHONE_QUERY));
  const [bubble, setBubble] = useState<BubblePos>(loadBubble);
  const [bubbleDragging, setBubbleDragging] = useState(false);
  const [landing, setLanding] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const lastDockedRef = useRef(initial.mode === "dock");
  const draggedRef = useRef(false);
  const closingRef = useRef(false);
  const openedFromBubble = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy, reveal, mode]);

  useEffect(() => {
    const onResize = () => {
      setPhone(mediaMatches(PHONE_QUERY));
      setRect((current) => clampRect(current));
      setBubble((current) => clampBubble(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (mode === "min") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, rect }));
    } catch {
      // Position memory is a convenience only.
    }
  }, [mode, rect]);

  // A docked panel reserves room on the right so the page reflows beside it.
  const docked = mode === "dock" && !phone;
  useEffect(() => {
    if (!docked) return;
    const root = document.documentElement;
    root.dataset.tutorDocked = "true";
    root.style.setProperty("--tutor-dock-width", `${rect.w}px`);
    return () => {
      delete root.dataset.tutorDocked;
      root.style.removeProperty("--tutor-dock-width");
    };
  }, [docked, rect.w]);

  // Replies arrive whole; revealing them over about a second gives Patch a
  // "writing" phase and keeps long answers readable as they appear.
  useEffect(() => {
    if (!reveal) return;
    const target = messages.find((item) => item.id === reveal.id);
    if (!target || reveal.shown >= target.content.length) {
      setReveal(null);
      return;
    }
    const step = Math.max(4, Math.ceil(target.content.length / 45));
    const timer = window.setTimeout(() => setReveal({ id: reveal.id, shown: reveal.shown + step }), 24);
    return () => window.clearTimeout(timer);
  }, [reveal, messages]);

  // Grow the panel out of the bubble, like an app opening from its icon.
  useLayoutEffect(() => {
    if (mode === "min" || !openedFromBubble.current) return;
    openedFromBubble.current = false;
    const panel = panelRef.current;
    if (!panel || phone || prefersReducedMotion() || typeof panel.animate !== "function") return;
    panel.animate(bubbleKeyframes(panel, bubble, mode === "dock"), { duration: 520, easing: OPEN_EASING });
    innerRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 140, easing: "ease-out", fill: "backwards" });
  }, [mode, phone, bubble]);

  useEffect(() => {
    if (!landing) return;
    const timer = window.setTimeout(() => setLanding(false), 450);
    return () => window.clearTimeout(timer);
  }, [landing]);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const lastMessage = messages.at(-1);
  const petState: PetState = busy ? "thinking" : reveal ? "writing" : lastMessage?.error ? "error" : "ready";

  async function send() {
    const text = message.trim();
    if (!text || busy || !lesson) return;

    const requestId = crypto.randomUUID();
    const userMessageId = `user-${requestId}`;
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        requestId,
        courseId: lesson.courseId,
        skillId: lesson.skillId,
        message: text,
        ...(threadId ? { threadId } : {}),
      }),
    };

    setMessage("");
    setMessages((items) => [...items, { id: userMessageId, role: "user", content: text }]);
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch("/api/ai/tutor", requestInit);
      } catch {
        // A provider call may have committed before its response was lost.
        // Reusing the exact request ID makes this one retry replay-safe.
        response = await fetch("/api/ai/tutor", requestInit);
      }
      const body = await response.json().catch(() => ({})) as {
        acceptedMessage?: string;
        callId?: string;
        content?: string;
        error?: string;
        threadId?: string;
      };
      if (!response.ok || !body.content || !body.threadId) {
        throw new Error(body.error ?? "Codestead is unavailable; the authored lesson and practice still work.");
      }
      const assistantContent = body.content;
      const assistantId = body.callId ? `assistant-${body.callId}` : `assistant-${requestId}`;
      setThreadId(body.threadId);
      setMessages((items) => [
        ...items.map((item) => item.id === userMessageId && body.acceptedMessage
          ? { ...item, content: body.acceptedMessage }
          : item),
        { id: assistantId, role: "assistant", content: assistantContent },
      ]);
      if (!prefersReducedMotion()) setReveal({ id: assistantId, shown: 0 });
    } catch (cause) {
      setMessages((items) => [...items, {
        id: `error-${requestId}`,
        role: "assistant",
        error: true,
        content: cause instanceof Error
          ? cause.message
          : "Codestead is offline right now. Keep going with the authored lesson, visualizer, or practice.",
      }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function newChat() {
    if (messages.length === 0) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    setMessages([]);
    setThreadId(null);
    setReveal(null);
    setMessage("");
    inputRef.current?.focus();
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (phone || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const base = mode === "dock"
      ? clampRect({ ...rect, h: Math.min(rect.h, window.innerHeight - 110), x: event.clientX - rect.w / 2, y: event.clientY - 24 })
      : rect;
    if (mode === "dock") {
      setMode("float");
      setRect(base);
    }
    const move = (moveEvent: PointerEvent) => {
      setRect(clampRect({ ...base, x: base.x + moveEvent.clientX - startX, y: base.y + moveEvent.clientY - startY }));
      setDockHint(moveEvent.clientX >= window.innerWidth - DOCK_SNAP);
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDockHint(false);
      if (upEvent.clientX >= window.innerWidth - DOCK_SNAP) setMode("dock");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function startResize(dir: ResizeDir) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const base = rect;
      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (mode === "dock") {
          setRect({ ...base, w: Math.min(Math.max(base.w - dx, MIN_W), Math.round(window.innerWidth * 0.6)) });
          return;
        }
        let { x, y, w, h } = base;
        if (dir.includes("e")) w = base.w + dx;
        if (dir.includes("s")) h = base.h + dy;
        if (dir.includes("w")) {
          w = Math.max(base.w - dx, MIN_W);
          x = base.x + base.w - w;
        }
        if (dir.includes("n")) {
          h = Math.max(base.h - dy, MIN_H);
          y = base.y + base.h - h;
        }
        setRect(clampRect({ x, y, w, h }));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }

  function minimize() {
    if (closingRef.current) return;
    lastDockedRef.current = mode === "dock";
    const panel = panelRef.current;
    const finish = () => {
      closingRef.current = false;
      setMode("min");
      setLanding(true);
      window.setTimeout(() => bubbleRef.current?.focus(), 0);
    };
    if (!panel || phone || prefersReducedMotion() || typeof panel.animate !== "function") {
      finish();
      return;
    }
    closingRef.current = true;
    innerRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in", fill: "forwards" });
    const animation = panel.animate([...bubbleKeyframes(panel, bubble, mode === "dock")].reverse(), { duration: 320, easing: CLOSE_EASING, fill: "forwards" });
    animation.onfinish = finish;
  }

  function restore() {
    openedFromBubble.current = true;
    setMode(lastDockedRef.current ? "dock" : "float");
  }

  // Drag the bubble anywhere; on release it glides to the nearest side edge.
  function startBubbleDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const base = bubble;
    draggedRef.current = false;
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      draggedRef.current = true;
      setBubbleDragging(true);
      setBubble(clampBubble({ x: base.x + dx, y: base.y + dy }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!draggedRef.current) return;
      setBubbleDragging(false);
      setBubble((current) => {
        const snapped = clampBubble({
          x: current.x + BUBBLE_SIZE / 2 < window.innerWidth / 2 ? 0 : window.innerWidth,
          y: current.y,
        });
        try {
          window.localStorage.setItem(BUBBLE_KEY, JSON.stringify(snapped));
        } catch {
          // Position memory is a convenience only.
        }
        return snapped;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  if (mode === "min") {
    return createPortal(<button
      aria-controls="lesson-buddy-tutor"
      aria-expanded="false"
      aria-label={busy ? "Open Patch (thinking)" : "Open Patch"}
      className={styles.bubble}
      data-dragging={bubbleDragging ? "true" : undefined}
      data-landing={landing ? "true" : undefined}
      onClick={() => {
        if (draggedRef.current) {
          draggedRef.current = false;
          return;
        }
        restore();
      }}
      onPointerDown={startBubbleDrag}
      ref={bubbleRef}
      style={{ left: bubble.x, top: bubble.y }}
      type="button"
    >
      <MentorPet size="sm" state={petState} />
    </button>, document.body);
  }

  const panelStyle = phone ? undefined : docked ? { width: rect.w } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  const title = lesson?.skillTitle;

  return createPortal(<>
    {dockHint && <div aria-hidden="true" className={styles.dockHint} style={{ width: rect.w }} />}
    <div
      aria-labelledby="lesson-buddy-title"
      className={styles.tutorPanel}
      data-mode={phone ? "sheet" : mode}
      id="lesson-buddy-tutor"
      onKeyDown={(event) => { if (event.key === "Escape") minimize(); }}
      ref={panelRef}
      role="dialog"
      style={panelStyle}
    >
      {!phone && (docked
        ? <div aria-hidden="true" className={styles.resize} data-dir="w" onPointerDown={startResize("w")} />
        : RESIZE_DIRS.map((dir) => <div aria-hidden="true" className={styles.resize} data-dir={dir} key={dir} onPointerDown={startResize(dir)} />))}
      <div className={styles.panelInner} ref={innerRef}>
        <div className={styles.tutorHead} onPointerDown={startDrag}>
          {phone && <span aria-hidden="true" className={styles.grabber} />}
          <span className={styles.title}>
            <strong id="lesson-buddy-title">Patch</strong>
            <small>{title ? `About: ${title}` : "No lesson open yet"}</small>
          </span>
          <span className={styles.headActions}>
            <button
              aria-label={confirmClear ? "Confirm new chat" : "New chat"}
              className={confirmClear ? styles.confirmClear : undefined}
              disabled={messages.length === 0 || busy}
              onClick={newChat}
              title={confirmClear ? "Click again to clear this chat" : "New chat"}
              type="button"
            >{confirmClear ? <span>Clear?</span> : <SquarePen size={16} />}</button>
            {!phone && <button
              aria-label={docked ? "Undock tutor" : "Dock tutor to the right"}
              onClick={() => setMode(docked ? "float" : "dock")}
              title={docked ? "Undock" : "Dock to the right"}
              type="button"
            >{docked ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}</button>}
            <button aria-label="Minimize tutor" onClick={minimize} title="Minimize" type="button"><Minus size={16} /></button>
          </span>
        </div>
        <div aria-busy={busy} aria-live="polite" className={styles.chatMessages} ref={messageListRef} role="log">
          {messages.length === 0 && !busy && <section className={styles.welcome}>
            <span className={styles.eyebrow}><Sparkles aria-hidden="true" size={13} /> {title ? "Ask about this skill" : "Hi, I'm Patch"}</span>
            <p>{title
              ? <>I know you are working on <strong>{title}</strong>. Ask anything, or pick a start below.</>
              : "Open any lesson and I can help you with it."}</p>
          </section>}
          {messages.map((item) => {
            if (item.role === "user") return <div className={styles.userMessage} key={item.id}>{item.content}</div>;
            const text = reveal?.id === item.id ? item.content.slice(0, reveal.shown) : item.content;
            return <div className={styles.aiMessage} data-error={item.error ? "true" : undefined} key={item.id}>
              {item.error ? item.content : <TutorMarkdown>{text}</TutorMarkdown>}
            </div>;
          })}
        </div>
        <div className={styles.composer}>
          {messages.length === 0 && !busy && title && <div aria-label="Starter prompts" className={styles.prompts} role="group">
            {starterPromptsFor(title).map((starter) => <button key={starter.label} onClick={() => { setMessage(starter.prompt); inputRef.current?.focus(); }} type="button">{starter.label}</button>)}
          </div>}
          <form className={styles.chatInput} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <PetPerch state={petState} typing={message.trim().length > 0} />
            <textarea
              aria-label="Message Patch"
              autoFocus
              disabled={!lesson}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }}
              placeholder={lesson ? "Ask Patch about this skill…" : "Open a lesson to chat with Patch"}
              ref={inputRef}
              rows={1}
              value={message}
            />
            <button aria-label="Send message" disabled={busy || !message.trim() || !lesson} type="submit"><ArrowUp aria-hidden="true" size={16} /></button>
          </form>
          <p className={styles.privacy}>Enter to send · Shift+Enter for a new line · Hidden tests and keys stay private.</p>
        </div>
      </div>
    </div>
  </>, document.body);
}

// Keyframes that take the panel from the bubble's circle to its own box.
function bubbleKeyframes(panel: HTMLElement, bubble: BubblePos, docked: boolean): Keyframe[] {
  const box = panel.getBoundingClientRect();
  const dx = bubble.x + BUBBLE_SIZE / 2 - (box.left + box.width / 2);
  const dy = bubble.y + BUBBLE_SIZE / 2 - (box.top + box.height / 2);
  const sx = BUBBLE_SIZE / Math.max(box.width, 1);
  const sy = BUBBLE_SIZE / Math.max(box.height, 1);
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: "50%", opacity: 0.5 },
    { transform: "none", borderRadius: docked ? "0px" : "18px", opacity: 1 },
  ];
}
