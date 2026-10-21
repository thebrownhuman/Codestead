import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import basics from "../../../../content/sql-practice/basics.json";
import { sqlPracticeLessonSchema } from "@/lib/content/sql-practice";

const mocks = vi.hoisted(() => ({
  instances: [] as { exec: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  exec: vi.fn(),
}));

vi.mock("@electric-sql/pglite", () => ({
  PGlite: class {
    exec = vi.fn((sql: string) => mocks.exec(sql));
    query = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.instances.push(this); }
  },
}));
vi.mock("../self-hosted-monaco-editor", () => ({
  default: ({ value, onChange, options }: {
    value: string; onChange: (value: string) => void; options: { readOnly: boolean };
  }) => <textarea aria-label="SQL query" readOnly={options.readOnly} value={value} onChange={(event) => onChange(event.target.value)} />,
}));

import { SqlExercisePanel, SqlPracticeLesson } from "../sql-practice-lesson";

const lesson = sqlPracticeLessonSchema.parse(basics);
const exercise = lesson.exercises[0]!;
const response = { fields: exercise.expected.columns.map((name) => ({ name })), rows: exercise.expected.rows };
const run = () => screen.getByRole("button", { name: "Run (Ctrl+Enter)" });
async function ready() { await waitFor(() => expect(run()).toBeEnabled()); }

beforeEach(() => { mocks.instances.length = 0; mocks.exec.mockReset().mockResolvedValue([]); });

describe("browser SQL practice", () => {
  it("seeds an in-memory DB, runs current SQL, shows a result, and checks by re-executing", async () => {
    const user = userEvent.setup();
    render(<SqlExercisePanel exercise={exercise} />);
    await ready();
    const db = mocks.instances[0]!;
    expect(db.exec.mock.calls).toEqual([[exercise.schemaSql], [exercise.seedSql]]);
    db.query.mockResolvedValue(response);
    const editor = screen.getByRole("textbox", { name: "SQL query" });
    fireEvent.change(editor, { target: { value: "SELECT title, year FROM books ORDER BY year;" } });
    await user.click(run());
    expect(db.query).toHaveBeenCalledWith("SELECT title, year FROM books ORDER BY year;", [], { rowMode: "array" });
    const table = await screen.findByRole("table", { name: "Query result" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["title", "year"]);
    expect(within(table).getByText("The Hobbit")).toBeInTheDocument();
    expect(screen.queryByText(/Correct!/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Correct!/)).toBeInTheDocument();
    expect(db.query).toHaveBeenCalledTimes(2);
    fireEvent.change(editor, { target: { value: "SELECT year FROM books;" } });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Correct!/)).not.toBeInTheDocument();
    db.query.mockResolvedValue({ fields: [{ name: "year" }], rows: [[1937]] });
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/Not yet/)).toBeInTheDocument();
  });

  it("runs with Ctrl+Enter, renders errors, and clears stale results", async () => {
    render(<SqlExercisePanel exercise={exercise} />);
    await ready();
    const db = mocks.instances[0]!;
    db.query.mockResolvedValue(response);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(await screen.findByRole("table")).toBeInTheDocument();
    db.query.mockRejectedValueOnce(new Error("syntax error at or near FROM"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("syntax error at or near FROM");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(/Correct!/)).not.toBeInTheDocument();
  });

  it("restores the starter query and creates and seeds a fresh DB on Reset", async () => {
    const user = userEvent.setup();
    const view = render(<SqlExercisePanel exercise={exercise} />);
    await ready();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "DELETE FROM books;" } });
    mocks.instances[0]!.query.mockResolvedValue({ fields: [], rows: [] });
    await user.click(run());
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await ready();
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.instances[1]!.exec.mock.calls).toEqual([[exercise.schemaSql], [exercise.seedSql]]);
    expect(screen.getByRole("textbox")).toHaveValue(exercise.starterSql);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    view.unmount();
    expect(mocks.instances[1]!.close).toHaveBeenCalledTimes(1);
  });

  it("handles setup failure and recovers on Reset", async () => {
    mocks.exec.mockRejectedValueOnce(new Error("seed failed"));
    render(<SqlExercisePanel exercise={exercise} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("seed failed");
    expect(mocks.instances[0]!.close).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await ready();
    expect(mocks.instances).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks concurrent commands and ignores a result after unmount", async () => {
    let finish!: (value: typeof response) => void;
    const view = render(<SqlExercisePanel exercise={exercise} />);
    await ready();
    const db = mocks.instances[0]!;
    db.query.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(run()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    view.unmount();
    await act(async () => { finish(response); });
    expect(db.close).toHaveBeenCalledTimes(1);
  });

  it("closes a database when unmounted during initialization", async () => {
    let finish!: () => void;
    mocks.exec.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const view = render(<SqlExercisePanel exercise={exercise} />);
    await waitFor(() => expect(mocks.instances).toHaveLength(1));
    view.unmount();
    await act(async () => { finish(); });
    expect(mocks.instances[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("shows NULL and empty results, preserving duplicate column names", async () => {
    render(<SqlExercisePanel exercise={exercise} />);
    await ready();
    const db = mocks.instances[0]!;
    db.query.mockResolvedValue({ fields: [{ name: "x" }, { name: "x" }], rows: [[null, false]] });
    fireEvent.click(run());
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(table).getByText("NULL")).toBeInTheDocument();
    expect(within(table).getByText("false")).toBeInTheDocument();
    db.query.mockResolvedValue({ fields: [{ name: "x" }], rows: [] });
    fireEvent.click(run());
    expect(await screen.findByText("0 rows")).toBeInTheDocument();
    expect(screen.getByRole("columnheader")).toHaveTextContent("x");
  });

  it("switches among the sample exercises with isolated databases", async () => {
    render(<SqlPracticeLesson lesson={lesson} />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: lesson.exercises[2]!.title }));
    await ready();
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0]!.close).toHaveBeenCalledTimes(1);
    expect(mocks.instances[1]!.exec).toHaveBeenCalledWith(lesson.exercises[2]!.schemaSql);
    expect(screen.getByRole("textbox")).toHaveValue(lesson.exercises[2]!.starterSql);
  });
});
