"use client";

import { X } from "lucide-react";
import { useId, useState } from "react";

import { ModalDialog } from "@/components/ui/modal-dialog";

import styles from "./landing-page.module.css";

type Track = {
  code: string;
  label: string;
  level: string;
  blurb: string;
  topics: string[];
};

const tracks: Track[] = [
  { code: "C", label: "C", level: "Beginner → Intermediate", blurb: "Systems fundamentals: memory, pointers, and how a computer actually runs your code.", topics: ["Pointers & arrays", "Manual memory management", "Structs & file I/O", "Debugging with a mental model of the stack"] },
  { code: "C++", label: "C++", level: "Intermediate → Advanced", blurb: "Everything from C, plus object-oriented and generic programming for larger systems.", topics: ["Classes & inheritance", "Templates & the STL", "RAII and smart pointers", "Operator overloading"] },
  { code: "Java", label: "Java", level: "Beginner → Intermediate", blurb: "Strongly-typed OOP with a huge standard library, built for maintainable applications.", topics: ["OOP design & interfaces", "Collections & generics", "Exceptions", "Basic concurrency"] },
  { code: "Python", label: "Python", level: "Beginner-friendly", blurb: "Readable syntax for fast iteration, from first script to data-heavy projects.", topics: ["Core syntax & data structures", "Functions & comprehensions", "File & error handling", "Intro to libraries (requests, pandas)"] },
  { code: "Web", label: "Web", level: "Beginner → Intermediate", blurb: "Build real pages and apps: structure, style, and interactivity in the browser.", topics: ["HTML & semantic structure", "CSS layout (flexbox/grid)", "JavaScript & the DOM", "Fetch & basic APIs"] },
  { code: "DSA", label: "DSA", level: "Intermediate → Advanced", blurb: "The data structures and algorithms every technical interview and real system leans on.", topics: ["Arrays, lists, trees, graphs", "Sorting & searching", "Recursion & dynamic programming", "Complexity analysis (Big-O)"] },
  { code: "Git", label: "Git", level: "Beginner-friendly", blurb: "Version control workflows for working solo or shipping with a team.", topics: ["Commits, branches, merges", "Resolving conflicts", "Pull requests & code review", "Rebasing & history cleanup"] },
  { code: "AI", label: "AI", level: "Intermediate", blurb: "Practical foundations for working with and building on modern AI systems.", topics: ["How LLMs generate text", "Prompting & context windows", "Embeddings & retrieval", "Using AI APIs responsibly"] },
];

export function CurriculumChips() {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const baseId = useId();
  const pinned = pinnedIndex === null ? null : tracks[pinnedIndex];

  return (
    <>
      <div aria-label="Launch curriculum tracks" className={styles.trackList}>
        {tracks.map((track, index) => {
          const popoverId = `${baseId}-popover-${index}`;
          const showPopover = hoverIndex === index && pinnedIndex === null;
          return (
            <div className={styles.trackChipWrap} key={track.code}>
              <button
                aria-describedby={showPopover ? popoverId : undefined}
                aria-expanded={pinnedIndex === index}
                aria-haspopup="dialog"
                className={styles.trackChip}
                onBlur={() => setHoverIndex((current) => (current === index ? null : current))}
                onClick={() => setPinnedIndex(index)}
                onFocus={() => setHoverIndex(index)}
                onMouseEnter={() => setHoverIndex(index)}
                onMouseLeave={() => setHoverIndex((current) => (current === index ? null : current))}
                type="button"
              >
                {track.label}
              </button>
              {showPopover && (
                <div className={styles.trackPopover} id={popoverId} role="tooltip">
                  <strong>{track.label}</strong>
                  <span className={styles.trackLevel}>{track.level}</span>
                  <p>{track.blurb}</p>
                  <ul>{track.topics.slice(0, 4).map((topic) => <li key={topic}>{topic}</li>)}</ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {pinned && (
        <ModalDialog
          backdropClassName={styles.promiseBackdrop}
          describedBy="track-dialog-description"
          dialogClassName={`${styles.promiseDialog} card`}
          labelledBy="track-dialog-title"
          onClose={() => setPinnedIndex(null)}
        >
          <div className={styles.promiseDialogHead}>
            <span className={styles.trackLevel}>{pinned.level}</span>
            <button aria-label="Close" data-dialog-initial-focus onClick={() => setPinnedIndex(null)} type="button">
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <h2 id="track-dialog-title">{pinned.label}</h2>
          <p id="track-dialog-description">{pinned.blurb}</p>
          <ul className={styles.trackDialogTopics}>{pinned.topics.map((topic) => <li key={topic}>{topic}</li>)}</ul>
        </ModalDialog>
      )}
    </>
  );
}
