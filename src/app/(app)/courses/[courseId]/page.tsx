import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";

import { createContentRepository } from "@/lib/content";
import styles from "@/components/courses/courses.module.css";

export async function generateStaticParams() {
  const courses = await createContentRepository().listCourses();
  return courses.map((course) => ({ courseId: course.id }));
}

export default async function CoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { courseId } = await params;
  const course = await createContentRepository().getCourse(courseId);
  if (!course) notFound();
  const total = course.coverage_summary.total_skills;
  const coverage = Math.round((course.coverage_summary.covered / total) * 100);
  return (
    <div className={styles.page}>
      <nav className={styles.breadcrumbs}><Link href="/courses"><ArrowLeft size={14} /> Courses</Link><span>/</span><span>{course.title}</span></nav>
      <section className={styles.courseHero}>
        <div className={styles.courseHeroTitle}><span className={styles.largeCode}>{course.id === "programming-foundations" ? "PF" : course.id.slice(0,3).toUpperCase()}</span><div><span className={styles.eyebrow}>{course.status} · {course.version}</span><h1>{course.title}</h1><p>{course.summary}</p></div></div>
        <aside className={`${styles.outcomeCard} card`}><span><ShieldCheck size={15} /> Exit capability</span><p>{course.audience.target_capability}</p><div className={styles.runtime}>{course.runtime.toolchain.slice(0,4).map((tool) => <i key={tool}>{tool}</i>)}</div><div className={styles.coverageBar}><span><b>Declared coverage</b><b>{coverage}%</b></span><div><i style={{ width: `${coverage}%` }} /></div><span><small>{total} required/elective skills</small><small>{course.modules.length} modules</small></span></div></aside>
      </section>
      <section className={styles.courseLayout}>
        <div className={styles.moduleList}>
          {course.modules.map((module, moduleIndex) => (
            <details className={`${styles.module} card`} key={module.id} open={moduleIndex === 0}>
              <summary><span className={styles.moduleNumber}>{String(moduleIndex + 1).padStart(2, "0")}</span><span><strong>{module.title}</strong><small>{module.description}</small></span><span className="pill">{module.skills.length} skills</span></summary>
              <div className={styles.skillList}>{module.skills.map((skill, index) => <Link href={`/courses/${course.id}/skills/${encodeURIComponent(skill.id)}`} key={skill.id}><b>{index + 1}</b><span><strong>{skill.title}</strong><small>{skill.description}</small></span><em>{skill.evidence_types.slice(0,2).join(" · ")}</em><ArrowRight size={14} /></Link>)}</div>
            </details>
          ))}
        </div>
        <aside className={styles.sideColumn}>
          <div className={`${styles.sideCard} card`}><h3>What is included</h3><ul>{course.scope.includes.slice(0,7).map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div className={`${styles.sideCard} card`}><h3>Authoritative sources</h3>{course.authoritative_sources.slice(0,6).map((source) => <a className={styles.sourceLink} href={source.url} key={source.id} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {source.title}</a>)}</div>
          <div className={`${styles.sideCard} card`}><h3>Publication evidence</h3><ul><li><CheckCircle2 size={12} /> Scope and sources declared</li><li><CheckCircle2 size={12} /> Prerequisite DAG validated</li><li><CheckCircle2 size={12} /> Assessment modes mapped</li><li>Editorial lesson verification in progress</li></ul></div>
        </aside>
      </section>
    </div>
  );
}
