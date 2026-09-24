"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type TutorLesson = { courseId: string; skillId: string; skillTitle: string };

const LAST_LESSON_KEY = "codestead.tutor-last-lesson";

const TutorLessonContext = createContext<{
  lesson: TutorLesson | null;
  setLesson: (lesson: TutorLesson) => void;
}>({ lesson: null, setLesson: () => undefined });

function readLastLesson(): TutorLesson | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LAST_LESSON_KEY) ?? "null") as Partial<TutorLesson> | null;
    return saved && typeof saved.courseId === "string" && typeof saved.skillId === "string" && typeof saved.skillTitle === "string"
      ? { courseId: saved.courseId, skillId: saved.skillId, skillTitle: saved.skillTitle }
      : null;
  } catch {
    return null;
  }
}

// Patch lives in the app shell, so the lesson he talks about is whichever one
// the learner opened last; off lesson pages he keeps using that one.
export function TutorLessonProvider({ children }: { children: ReactNode }) {
  const [lesson, setLessonState] = useState<TutorLesson | null>(null);

  useEffect(() => {
    const saved = readLastLesson();
    // Storage is only readable after hydration; a lesson page may already have registered.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setLessonState((current) => current ?? saved);
  }, []);

  const setLesson = useCallback((next: TutorLesson) => {
    setLessonState(next);
    try {
      window.localStorage.setItem(LAST_LESSON_KEY, JSON.stringify(next));
    } catch {
      // Remembering the last lesson is a convenience only.
    }
  }, []);
  const value = useMemo(() => ({ lesson, setLesson }), [lesson, setLesson]);

  return <TutorLessonContext.Provider value={value}>{children}</TutorLessonContext.Provider>;
}

export function useTutorLesson() {
  return useContext(TutorLessonContext).lesson;
}

// Lesson pages call this so Patch answers about the lesson on screen.
export function useRegisterTutorLesson(lesson: TutorLesson) {
  const { setLesson } = useContext(TutorLessonContext);
  const { courseId, skillId, skillTitle } = lesson;
  useEffect(() => {
    setLesson({ courseId, skillId, skillTitle });
  }, [setLesson, courseId, skillId, skillTitle]);
}
