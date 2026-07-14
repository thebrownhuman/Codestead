import { Award, BadgeCheck, ExternalLink, GitBranch as Github, ShieldCheck } from "lucide-react";
import Link from "next/link";

import type { loadPublicPortfolio } from "@/lib/portfolio/service";

import styles from "./milestones.module.css";

type Portfolio = Awaited<ReturnType<typeof loadPublicPortfolio>>;

export function PublicPortfolioView({ portfolio }: { readonly portfolio: Portfolio }) {
  return (
    <main className={`${styles.portfolioPreview} page-width`}>
      <header className={styles.portfolioHeader}>
        <span className={styles.eyebrow}>Learner-selected public portfolio</span>
        <h1>{portfolio.displayName}</h1>
        <h2>{portfolio.headline}</h2>
        {portfolio.about ? <p>{portfolio.about}</p> : null}
      </header>
      <aside className={styles.notice}><ShieldCheck aria-hidden="true" size={19} /><span>{portfolio.privacyNotice}</span></aside>
      <section aria-labelledby="portfolio-projects-title">
        <div className={styles.panelHead}><div><h2 id="portfolio-projects-title">Selected projects</h2><p>Repository links were validated as public github.com owner/repository URLs when selected.</p></div></div>
        {portfolio.projects.length ? <div className={styles.showcaseGrid}>{portfolio.projects.map((project) => <article className={`${styles.showcaseCard} card`} key={project.id}><Github aria-hidden="true" size={22} /><h3>{project.title}</h3><p>{project.summary}</p><span className={styles.status}>{project.status}</span><a href={project.githubUrl} rel="noreferrer" target="_blank">Open GitHub repository <ExternalLink aria-hidden="true" size={14} /></a></article>)}</div> : <div className={`${styles.empty} card`}><div><span><Github aria-hidden="true" size={27} /></span><h2>No project selected.</h2></div></div>}
      </section>
      {portfolio.achievements.length ? <section aria-labelledby="portfolio-achievements-title"><div className={styles.panelHead}><div><h2 id="portfolio-achievements-title">Selected achievements</h2></div></div><div className={styles.badgeRow}>{portfolio.achievements.map((achievement) => <span className={styles.badge} key={achievement.id}><BadgeCheck aria-hidden="true" size={15} /> {achievement.title}</span>)}</div></section> : null}
      {portfolio.certificates.length ? <section aria-labelledby="portfolio-certificates-title"><div className={styles.panelHead}><div><h2 id="portfolio-certificates-title">Verified certificates</h2></div></div><div className={styles.showcaseGrid}>{portfolio.certificates.map((certificate) => <article className={`${styles.showcaseCard} card`} key={certificate.id}><Award aria-hidden="true" size={22} /><h3>{certificate.title}</h3><p>Course version {certificate.version} · issued {new Date(certificate.issuedAt).toLocaleDateString()}</p><Link href={certificate.verificationPath}>Verify credential <ExternalLink aria-hidden="true" size={14} /></Link></article>)}</div></section> : null}
    </main>
  );
}
