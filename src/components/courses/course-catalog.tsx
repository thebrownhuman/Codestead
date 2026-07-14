"use client";

import Link from "next/link";
import { ArrowRight, BookOpen, Layers3 } from "lucide-react";
import { useMemo, useState } from "react";

import type { CourseManifest } from "@/lib/content";
import styles from "./courses.module.css";

const colors: Record<string, string> = {
  "programming-foundations": "#225e3d", c: "#4a67a1", cpp: "#7555a7", java: "#b45231",
  python: "#326d68", html: "#b94a26", css: "#496fc1", javascript: "#8b6c00", react: "#19738f",
  dsa: "#7555a7", "git-tooling": "#aa4d44", ai: "#8054a2",
};

const shortCode: Record<string, string> = {
  "programming-foundations": "PF", c: "C", cpp: "C++", java: "JV", python: "PY", html: "HT",
  css: "CS", javascript: "JS", react: "RE", dsa: "DS", "git-tooling": "GT", ai: "AI",
};

const courseFilters = [
  { id: "all", label: "All tracks", courseIds: null },
  { id: "languages", label: "Languages", courseIds: ["c", "cpp", "java", "python"] },
  { id: "web", label: "Web", courseIds: ["html", "css", "javascript", "react"] },
  { id: "computer-science", label: "Computer science", courseIds: ["programming-foundations", "dsa", "ai"] },
  { id: "tooling", label: "Tooling", courseIds: ["git-tooling"] },
] as const;

type CourseFilterId = (typeof courseFilters)[number]["id"];

export function CourseCatalog({ courses }: { courses: readonly CourseManifest[] }) {
  const [activeFilter, setActiveFilter] = useState<CourseFilterId>("all");
  const visibleCourses = useMemo(() => {
    const filter = courseFilters.find((item) => item.id === activeFilter);
    if (!filter?.courseIds) return courses;
    return courses.filter((course) => (filter.courseIds as readonly string[]).includes(course.id));
  }, [activeFilter, courses]);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div><span className={styles.eyebrow}>Launch 1 · Beta curriculum</span><h1>Choose what you want to understand.</h1><p>Every track has an explicit scope, prerequisite graph, evidence plan, and authoritative sources. Select broadly; your roadmap will unlock the right order.</p></div>
        <div className={styles.heroStats}><span><strong>{courses.length}</strong><small>complete track scopes</small></span><span><strong>{courses.reduce((sum, course) => sum + course.modules.length, 0)}</strong><small>learning modules</small></span><span><strong>{courses.reduce((sum, course) => sum + course.coverage_summary.total_skills, 0)}</strong><small>atomic skills</small></span></div>
      </section>
      <div className={styles.filterBar}>
        <div className={styles.filterRow} aria-label="Course filters" role="group">
          {courseFilters.map((filter) => <button aria-pressed={activeFilter === filter.id} className={activeFilter === filter.id ? styles.activeFilter : ""} key={filter.id} onClick={() => setActiveFilter(filter.id)} type="button">{filter.label}</button>)}
        </div>
        <span aria-live="polite" className={styles.filterSummary}>{visibleCourses.length} {visibleCourses.length === 1 ? "track" : "tracks"}</span>
      </div>
      <section className={styles.courseGrid} aria-label="Course catalog">
        {visibleCourses.map((course) => (
          <article className={`${styles.courseCard} card`} key={course.id} style={{ "--course-color": colors[course.id] ?? "#225e3d", "--course-ink": "#ffffff" } as React.CSSProperties}>
            <div className={styles.cardTop}><span className={styles.courseCode}>{shortCode[course.id] ?? course.id.slice(0,2).toUpperCase()}</span><span className={styles.status}>{course.status}</span></div>
            <h2>{course.title}</h2><p>{course.summary}</p>
            <div className={styles.courseMeta}><span><Layers3 size={13} /> {course.modules.length} modules</span><span><BookOpen size={13} /> {course.coverage_summary.total_skills} skills</span><span>{course.audience.level}</span></div>
            <Link className={styles.cardAction} href={`/courses/${course.id}`}>Explore roadmap <ArrowRight size={16} /></Link>
          </article>
        ))}
        {!visibleCourses.length && <div className={`${styles.filterEmpty} card`} role="status"><strong>No tracks match this filter yet.</strong><span>Choose another category to keep browsing the published catalog.</span></div>}
      </section>
    </div>
  );
}
