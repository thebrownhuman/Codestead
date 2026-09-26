"use client";

import { BadgeCheck, BrainCircuit, Gamepad2, Route, X, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";

import styles from "./landing-page.module.css";

type Promise = {
  icon: LucideIcon;
  title: string;
  copy: string;
  detail: string;
  example: string;
};

const promises: Promise[] = [
  {
    icon: Route,
    title: "A roadmap that changes with you",
    copy: "Diagnostics find the exact skills you know, then reopen only the gaps—not an entire course.",
    detail: "A short diagnostic checks specific skills instead of assuming a start-from-zero level. Every gap it finds reopens the exact lesson that covers it; everything you already know stays closed so you never re-sit material you've mastered.",
    example: "Example: you already write loops confidently but have never used recursion. The roadmap skips straight past loops and opens only the recursion track.",
  },
  {
    icon: BrainCircuit,
    title: "Explanations that feel familiar",
    copy: "Your hobbies shape examples and analogies while canonical definitions keep every lesson technically sound.",
    detail: "The definitions you're graded on never change—they're the same precise, canonical wording for every learner. What changes is the analogy wrapped around them, drawn from interests you tell Codestead about.",
    example: "Example: a linked list explained through a scavenger hunt for a treasure-hunting learner, or a relay race for a track-and-field learner—same formal definition, different door in.",
  },
  {
    icon: Gamepad2,
    title: "Practice you can see moving",
    copy: "Logical games, trace tables, and code visualizers make program state tangible without replacing real code.",
    detail: "Before or alongside writing code, you can step through what a program's state actually does—variables changing, pointers moving, stacks growing—so the abstract mental model behind the syntax becomes something you've watched happen.",
    example: "Example: a trace table that fills in step-by-step as a sorting algorithm runs, showing exactly which two elements swap on each pass.",
  },
  {
    icon: BadgeCheck,
    title: "Mastery backed by evidence",
    copy: "Badges require independent work, critical tests, and delayed review—not clicks, streaks, or one lucky answer.",
    detail: "A badge is only awarded after you've solved problems independently, passed tests designed to catch shortcuts or copied logic, and demonstrated the skill again after time has passed—so it reflects retained understanding, not a lucky streak.",
    example: "Example: a recursion badge requires solving a new recursive problem unaided, passing edge-case tests (empty input, deep recursion), and correctly explaining a recursive trace a week later.",
  },
];

export function PromiseCards() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const active = openIndex === null ? null : promises[openIndex];

  return (
    <>
      <div className={styles.promiseGrid}>
        {promises.map(({ icon: Icon, title, copy }, index) => (
          <button
            aria-haspopup="dialog"
            className={`card ${styles.promiseCard}`}
            key={title}
            onClick={() => setOpenIndex(index)}
            type="button"
          >
            <div className={styles.promiseNumber}>0{index + 1}</div>
            <Icon aria-hidden="true" size={24} />
            <h3>{title}</h3>
            <p>{copy}</p>
          </button>
        ))}
      </div>
      {active && (
        <ModalDialog
          backdropClassName={styles.promiseBackdrop}
          describedBy="promise-dialog-description"
          dialogClassName={`${styles.promiseDialog} card`}
          labelledBy="promise-dialog-title"
          onClose={() => setOpenIndex(null)}
        >
          <div className={styles.promiseDialogHead}>
            <active.icon aria-hidden="true" size={26} />
            <button aria-label="Close" data-dialog-initial-focus onClick={() => setOpenIndex(null)} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <h2 id="promise-dialog-title">{active.title}</h2>
          <p id="promise-dialog-description">{active.detail}</p>
          <p className={styles.promiseExample}>{active.example}</p>
        </ModalDialog>
      )}
    </>
  );
}
