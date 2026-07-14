import type { Metadata } from "next";
import Link from "next/link";

import { BrandMark } from "@/components/brand-mark";

import styles from "./source.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "License and source",
  description: "Codestead license, warranty notice, and corresponding-source access.",
};

export default function SourcePage() {
  const sourceUrl = process.env.SOURCE_CODE_URL?.trim();
  return (
    <main className={styles.page} id="main-content">
      <header><BrandMark /><Link href="/">Return home</Link></header>
      <article className={styles.card}>
        <span className={styles.eyebrow}>Appropriate legal notice</span>
        <h1>License and corresponding source</h1>
        <p>Codestead is free software licensed under the <strong>GNU Affero General Public License, version 3 only</strong> (SPDX: AGPL-3.0-only). You may copy, redistribute, and modify it under that license.</p>
        <p>The program is provided <strong>without warranty</strong>, including without implied warranties of merchantability or fitness for a particular purpose, to the extent permitted by law. See the full license for the controlling terms.</p>
        <div className={styles.actions}>
          <a className="button button-secondary" href="https://www.gnu.org/licenses/agpl-3.0.html" rel="noreferrer" target="_blank">Read the full license</a>
          {sourceUrl ? <a className="button button-primary" href={sourceUrl} rel="noreferrer">Get this deployment&apos;s source</a> : <span className={styles.missing}>Source archive URL is not configured for this local build.</span>}
        </div>
        <p className={styles.note}>Operators who modify and expose the application over a network must offer the Corresponding Source for their running version as required by AGPL section 13. Commercial use cannot be prohibited while calling the project open source.</p>
      </article>
    </main>
  );
}
