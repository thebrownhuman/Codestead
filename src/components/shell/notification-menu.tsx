"use client";

import { Bell, CheckCheck, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./app-shell.module.css";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  actionUrl: string | null;
  readAt: string | null;
  createdAt: string;
};

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setState("loading");
    try {
      const response = await fetch("/api/notifications?limit=20", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as {
        notifications?: NotificationItem[];
        unreadCount?: number;
      };
      if (!response.ok || !Array.isArray(body.notifications)) throw new Error("load failed");
      setItems(body.notifications);
      setUnreadCount(Number(body.unreadCount ?? 0));
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/notifications?limit=1", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { unreadCount?: number };
        setUnreadCount(Number(body.unreadCount ?? 0));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      queueMicrotask(() => buttonRef.current?.focus());
    };
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  async function markAllRead() {
    const response = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true, readAll: true }),
    });
    if (!response.ok) return;
    const stamp = new Date().toISOString();
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? stamp })));
    setUnreadCount(0);
  }

  async function markOneRead(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.readAt) return;
    const response = await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], read: true }),
    });
    if (!response.ok) return;
    setItems((current) => current.map((candidate) => candidate.id === id
      ? { ...candidate, readAt: new Date().toISOString() }
      : candidate));
    setUnreadCount((value) => Math.max(0, value - 1));
  }

  return (
    <div className={styles.notificationMenu} ref={rootRef}>
      <button
        aria-controls="notification-panel"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        className={styles.iconButton}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && state === "idle") void load();
        }}
        ref={buttonRef}
        type="button"
      >
        <Bell aria-hidden="true" size={19} />
        {unreadCount > 0 && <span className={styles.notificationDot} />}
      </button>
      {open && (
        <section aria-label="Notifications" className={styles.notificationPanel} id="notification-panel" role="dialog">
          <header>
            <div><strong>Notifications</strong><small>{unreadCount ? `${unreadCount} unread` : "You are caught up"}</small></div>
            <button disabled={!unreadCount} onClick={() => void markAllRead()} type="button"><CheckCheck size={15} /> Mark all read</button>
          </header>
          {state === "loading" && <p className={styles.notificationState} role="status">Loading notifications…</p>}
          {state === "error" && <div className={styles.notificationState} role="alert"><p>Notifications could not be loaded.</p><button onClick={() => void load()} type="button"><RefreshCw size={14} /> Try again</button></div>}
          {state === "ready" && items.length === 0 && <p className={styles.notificationState}>No notifications yet. Learning and security updates will appear here.</p>}
          {state === "ready" && items.length > 0 && <div className={styles.notificationList}>{items.map((item) => {
            const content = <><span className={item.readAt ? styles.notificationRead : styles.notificationUnread}><i aria-hidden="true" /><strong>{item.title}</strong><small>{relativeTime(item.createdAt)}</small></span><p>{item.body}</p></>;
            const safeAction = item.actionUrl?.startsWith("/") && !item.actionUrl.startsWith("//") ? item.actionUrl : null;
            return safeAction
              ? <Link href={safeAction} key={item.id} onClick={() => { void markOneRead(item.id); setOpen(false); }}>{content}</Link>
              : <button key={item.id} onClick={() => void markOneRead(item.id)} type="button">{content}</button>;
          })}</div>}
          <footer><Link href="/settings?section=notifications" onClick={() => setOpen(false)}>Reminder settings</Link></footer>
        </section>
      )}
    </div>
  );
}
