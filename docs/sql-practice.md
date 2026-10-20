# Browser SQL practice (beta)

Open **Try SQL practice (beta)** on learning home, or navigate directly to
`/learn?practice=sql`. The existing page and authentication boundary are reused;
there is no execution API, server SQL execution, migration, or assessment credit.

`content/sql-practice/basics.json` ships SELECT, WHERE, and JOIN exercises. The
strict `sqlPracticeLessonSchema` in `src/lib/content/sql-practice.ts` defines this
local practice lesson format. Each `type: "sql"` exercise provides `schemaSql`,
`seedSql`, `task`, `starterSql`, and `expected` (`columns`, array-valued `rows`, and
`orderSensitive`). `npm run content:validate` validates these lessons alongside
the existing curriculum contracts. This beta sample is separate from reviewed
course publication and formal assessment banks.

The SQL component reuses the self-hosted Monaco editor (including its basic-editor
fallback). PGlite 0.5.8 is imported dynamically only when an SQL exercise mounts.
It was published on August 26, 2026. Each exercise and Reset opens a new in-memory
database, runs its schema and seeds, and closes the previous instance. Nothing is
persisted across navigation. Run (Ctrl+Enter) executes one statement; Check executes
the current statement and compares its result. Column names and order always
matter; unordered results retain duplicate-row counts and cell types. SQL errors
appear beside the editor. Setup failures can be retried with Reset.

Use a full document navigation to enter practice: only that document receives
`'wasm-unsafe-eval'` in its CSP. JavaScript eval and external connections remain
disallowed in production. Other documents keep their existing policy. Runtime
assets are served by the application, with no CDN dependency.

This is a small, trusted lesson sandbox: queries execute on the browser thread.
Very expensive SQL can stall the tab; worker isolation and cancellation are
outside this MVP. Local expected results are visible to the learner and provide
practice feedback only.
