import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  Code2,
  Gamepad2,
  GitBranch,
  LockKeyhole,
  Play,
  Route,
  ShieldCheck,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import styles from "./landing-page.module.css";

const tracks = ["C", "C++", "Java", "Python", "Web", "DSA", "Git", "AI"];

const promises = [
  {
    icon: Route,
    title: "A roadmap that changes with you",
    copy: "Diagnostics find the exact skills you know, then reopen only the gaps—not an entire course."
  },
  {
    icon: BrainCircuit,
    title: "Explanations that feel familiar",
    copy: "Your hobbies shape examples and analogies while canonical definitions keep every lesson technically sound."
  },
  {
    icon: Gamepad2,
    title: "Practice you can see moving",
    copy: "Logical games, trace tables, and code visualizers make program state tangible without replacing real code."
  },
  {
    icon: BadgeCheck,
    title: "Mastery backed by evidence",
    copy: "Badges require independent work, critical tests, and delayed review—not clicks, streaks, or one lucky answer."
  }
];

export function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={`${styles.header} page-width`}>
        <BrandMark />
        <nav className={styles.nav} aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#curriculum">Curriculum</a>
          <a href="#trust">Trust</a>
        </nav>
        <div className={styles.headerActions}>
          <Link className="button button-ghost" href="/login">
            Sign in
          </Link>
          <Link className="button button-primary" href="/request-access">
            Request access <ArrowRight size={16} />
          </Link>
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className={`${styles.hero} page-width`}>
          <div className={styles.heroCopy}>
            <span className="pill">
              <Sparkles size={14} aria-hidden="true" /> Private adaptive learning studio
            </span>
            <p className={styles.heroKicker}>Codestead · Build skills that stay.</p>
            <h1>
              Learn to code with a mentor that remembers <em>how you learn.</em>
            </h1>
            <p className={styles.heroLead}>
              Build real understanding through short explanations, executable examples, logical games, honest exams,
              and a roadmap shaped around your goals.
            </p>
            <div className={styles.heroActions}>
              <Link className="button button-primary" href="/request-access">
                Join the private beta <ArrowRight size={17} />
              </Link>
              <Link className="button button-secondary" href="/learn">
                <Play size={16} fill="currentColor" /> Explore the learner demo
              </Link>
            </div>
            <div className={styles.heroProof} aria-label="Product principles">
              <span><Check size={15} /> Verified curriculum</span>
              <span><Check size={15} /> Your own AI keys</span>
              <span><Check size={15} /> Private by default</span>
            </div>
          </div>

          <div className={styles.heroVisual} aria-label="Preview of a personalized lesson">
            <div className={styles.visualGlow} />
            <div className={styles.lessonCard}>
              <div className={styles.lessonTopline}>
                <span className={styles.lessonIcon}><Code2 size={19} /></span>
                <div>
                  <span>PYTHON · VARIABLES</span>
                  <strong>Changing state, one step at a time</strong>
                </div>
                <span className={styles.stepPill}>Step 2 of 5</span>
              </div>
              <div className={styles.analogyCard}>
                <span><Sparkles size={14} /> Your cooking analogy</span>
                <p>A variable is a labelled prep bowl. The label stays useful even when the ingredient changes.</p>
              </div>
              <div className={styles.codeWindow}>
                <div className={styles.windowBar}><i /><i /><i /><span>kitchen.py</span></div>
                <pre><code><b>servings</b> = <mark>2</mark>{"\n"}<b>servings</b> = servings + <mark>3</mark>{"\n"}<span>print</span>(servings)</code></pre>
                <div className={styles.traceRow}>
                  <span>servings</span><del>2</del><strong>5</strong><span className={styles.output}>Output: 5</span>
                </div>
              </div>
              <div className={styles.lessonFooter}>
                <div><span>Mastery evidence</span><strong>2 of 3 signals</strong></div>
                <Link href="/learn">Try the next step <ArrowRight size={15} /></Link>
              </div>
            </div>
            <div className={styles.floatCardOne}>
              <BrainCircuit size={19} />
              <span><strong>Nice recovery</strong>String conversion is now ready to review.</span>
            </div>
            <div className={styles.floatCardTwo}>
              <BadgeCheck size={19} />
              <span><strong>7-day streak</strong>Consistency, not speed.</span>
            </div>
          </div>
        </section>

        <section id="curriculum" className={`${styles.trackBand} page-width`} aria-label="Available curriculum">
          <span>Launch curriculum</span>
          <div aria-label="Launch curriculum tracks" tabIndex={0}>{tracks.map((track) => <b key={track}>{track}</b>)}</div>
        </section>

        <section id="how-it-works" className={`${styles.section} page-width`}>
          <div className={styles.sectionHeading}>
            <span className="pill">BUILT FOR REAL LEARNING</span>
            <h2>Less watching. More thinking, trying, and remembering.</h2>
            <p>The app adapts presentation and practice while keeping curriculum and grading deterministic.</p>
          </div>
          <div className={styles.promiseGrid}>
            {promises.map(({ icon: Icon, title, copy }, index) => (
              <article className="card" key={title}>
                <div className={styles.promiseNumber}>0{index + 1}</div>
                <Icon size={24} aria-hidden="true" />
                <h3>{title}</h3>
                <p>{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="trust" className={`${styles.trustSection} page-width`}>
          <div className={styles.trustCopy}>
            <span className="pill"><ShieldCheck size={14} /> TRUSTED BY DESIGN</span>
            <h2>The AI is the tutor. It is not the answer key.</h2>
            <p>
              Lessons, expected results, hidden tests, and mastery rules are versioned and reviewable. AI can explain
              evidence, but it cannot silently rewrite the truth.
            </p>
            <ul>
              <li><LockKeyhole size={18} /><span><strong>Encrypted provider vault</strong>Your keys stay server-side and every reveal is audited.</span></li>
              <li><TerminalSquare size={18} /><span><strong>Isolated execution</strong>Official submissions run in pinned, network-denied environments.</span></li>
              <li><GitBranch size={18} /><span><strong>Versioned learning</strong>Every course change has sources, coverage, and migration history.</span></li>
              <li><BarChart3 size={18} /><span><strong>Evidence over engagement</strong>Progress is measured by retained independent skill.</span></li>
            </ul>
          </div>
          <div className={`${styles.trustCard} card`}>
            <div className={styles.trustCardHeader}>
              <Bot size={20} /> <strong>Codestead mentor</strong><span>Grounded</span>
            </div>
            <div className={styles.chatBubble}>Why did my loop stop one step early?</div>
            <div className={`${styles.chatBubble} ${styles.chatReply}`}>
              Your condition checks before each lap. Let&apos;s trace the last two values together—without changing your code yet.
            </div>
            <div className={styles.evidenceBox}>
              <span>Feedback is grounded in</span>
              <div><Check size={15} /> Compiler result</div>
              <div><Check size={15} /> Published skill definition</div>
              <div><Check size={15} /> Your assistance history</div>
            </div>
          </div>
        </section>

        <section className={`${styles.cta} page-width`}>
          <div>
            <span className="pill">INVITE-ONLY BETA</span>
            <h2>Ready to build understanding that lasts?</h2>
            <p>Request access. Your administrator will review and send a secure activation link.</p>
          </div>
          <Link className="button button-primary" href="/request-access">
            Request access <ArrowRight size={17} />
          </Link>
        </section>
      </main>

      <footer className={`${styles.footer} page-width`}>
        <BrandMark />
        <p>Build skills that stay. · Self-hosted · AGPL-3.0-only</p>
        <Link href="/source">License &amp; source</Link>
      </footer>
    </div>
  );
}
