"use client";

import type { PGlite } from "@electric-sql/pglite";
import { useEffect, useRef, useState } from "react";

import type { SqlExercise, SqlPracticeLesson as Lesson } from "@/lib/content/sql-practice";
import { matchesSqlResult, type SqlResult } from "@/lib/sql-practice/compare";

import SelfHostedMonacoEditor from "./self-hosted-monaco-editor";
import styles from "./sql-practice-lesson.module.css";

export function SqlPracticeLesson({ lesson }: { readonly lesson: Lesson }) {
  const [index, setIndex] = useState(0);
  const exercise = lesson.exercises[index]!;
  return <div className={styles.lesson}>
    {/* Full document navigation gives this page its scoped WebAssembly CSP. */}
    <a href="/learn">Back to learning home</a>
    <header><p>Beta · SQL practice</p><h1>{lesson.title}</h1>
      <p>Queries run entirely in this browser tab. Practice checks do not award mastery or exam credit. Reset restores the original data.</p>
    </header>
    <nav aria-label="SQL exercises" className={styles.tabs}>
      {lesson.exercises.map((item, nextIndex) => <button aria-pressed={index === nextIndex} key={item.id} onClick={() => setIndex(nextIndex)} type="button">{item.title}</button>)}
    </nav>
    <SqlExercisePanel exercise={exercise} key={exercise.id} />
  </div>;
}

function displayCell(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SqlExercisePanel({ exercise }: { readonly exercise: SqlExercise }) {
  const [reset, setReset] = useState(0);
  return <SqlExerciseSession exercise={exercise} key={`${exercise.id}:${reset}`} onReset={() => setReset((value) => value + 1)} />;
}

function SqlExerciseSession({ exercise, onReset }: {
  readonly exercise: SqlExercise;
  readonly onReset: () => void;
}) {
  const [sql, setSql] = useState(exercise.starterSql);
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const database = useRef<PGlite | null>(null);
  const locked = useRef(true);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let disposed = false;
    let db: PGlite | undefined;
    let closed = false;
    function close() {
      if (!db || closed) return;
      closed = true;
      void db.close().catch(() => { /* Failed initialization can also fail cleanup. */ });
    }
    locked.current = true;
    async function initialize() {
      try {
        // Never import this runtime in a shared workspace/dashboard bundle.
        const { PGlite } = await import("@electric-sql/pglite");
        if (disposed) return;
        db = new PGlite(); // No dataDir: a new, in-memory database every time.
        await db.exec(exercise.schemaSql);
        await db.exec(exercise.seedSql);
        if (!disposed) {
          database.current = db;
          setReady(true);
        }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (disposed || database.current !== db) close();
        if (!disposed && generation.current === current) {
          locked.current = false;
          setBusy(false);
        }
      }
    }
    void initialize();
    return () => {
      disposed = true;
      generation.current = current + 1;
      database.current = null;
      // close() waits for any in-flight query before releasing WASM memory.
      close();
    };
  }, [exercise]);

  async function execute(check: boolean) {
    if (locked.current || !database.current || !sql.trim()) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setFeedback("");
    setResult(null);
    const current = generation.current;
    try {
      // Extended query protocol accepts one statement; arrays preserve duplicate column names.
      const response = await database.current.query<unknown[]>(sql, [], { rowMode: "array" });
      if (generation.current !== current) return;
      const next = { columns: response.fields.map((field) => field.name), rows: response.rows };
      setResult(next);
      if (check) setFeedback(matchesSqlResult(next, exercise.expected)
        ? "Correct! Your result matches the expected columns and rows."
        : "Not yet. Compare the columns, values, and row order requested by the task.");
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation.current === current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  return <section aria-labelledby="sql-task-title" className={styles.exercise}>
    <h2 id="sql-task-title">{exercise.title}</h2>
    <p>{exercise.task}</p>
    <details><summary>Schema and starting data</summary><pre>{exercise.schemaSql}{"\n\n"}{exercise.seedSql}</pre></details>
    <div onKeyDownCapture={(event) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void execute(false);
      }
    }}>
      <SelfHostedMonacoEditor height="260px" language="sql" theme="vs-dark" value={sql}
        options={{ minimap: { enabled: false }, readOnly: busy, automaticLayout: true, ariaLabel: "SQL query" }}
        onChange={(value) => { setSql(value ?? ""); setResult(null); setFeedback(""); setError(""); }} />
    </div>
    <div className={styles.actions}>
      <button disabled={busy || !ready || !sql.trim()} onClick={() => void execute(false)} type="button">Run (Ctrl+Enter)</button>
      <button disabled={busy || !ready || !sql.trim()} onClick={() => void execute(true)} type="button">Check</button>
      <button disabled={busy} onClick={onReset} type="button">Reset</button>
    </div>
    <p aria-live="polite" role="status">{busy ? "Preparing or running SQL…" : feedback}</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {result && <div className={styles.results}>
      <p>{result.rows.length} {result.rows.length === 1 ? "row" : "rows"}</p>
      {result.columns.length > 0 && <table>
        <caption>Query result</caption>
        <thead><tr>{result.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{displayCell(value)}</td>)}</tr>)}</tbody>
      </table>}
    </div>}
  </section>;
}
