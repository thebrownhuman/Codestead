import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RunnerPanel } from "../runner-panel";

it("switches panels with roving tabindex and skips the disabled Terminal", () => {
  render(<RunnerPanel submittedFile="main.py" output={<p>last log</p>} input={<textarea aria-label="stdin" />} stderr="" onJump={vi.fn()} />);
  const output = screen.getByRole("tab", { name: "Output" });
  const problems = screen.getByRole("tab", { name: /Problems/ });
  const input = screen.getByRole("tab", { name: "Input" });
  expect(output).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("tabindex", "-1");
  output.focus();
  fireEvent.keyDown(output, { key: "ArrowRight" });
  expect(problems).toHaveFocus();
  expect(problems).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(problems, { key: "End" });
  expect(input).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "stdin" })).toBeVisible();
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(output).toHaveFocus();
  expect(screen.getByRole("tab", { name: /Terminal/ })).toBeDisabled();
  fireEvent.click(input);
  expect(input).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Home" });
  expect(output).toHaveFocus();
  fireEvent.keyDown(output, { key: "ArrowLeft" });
  expect(input).toHaveFocus();
});

it("jumps to the parsed line and column without losing raw output", () => {
  const jump = vi.fn();
  render(<RunnerPanel submittedFile="main.c" output={<p>main.c:4:8: error: missing semicolon</p>} input={null} stderr="main.c:4:8: error: missing semicolon" onJump={jump} />);
  fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
  fireEvent.click(screen.getByRole("button", { name: /main.c:4:8.*missing semicolon/ }));
  expect(jump).toHaveBeenCalledWith({ file: "main.c", line: 4, column: 8, message: "missing semicolon" });
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByText("main.c:4:8: error: missing semicolon")).toBeVisible();
});

it("lists only deduplicated learner diagnostics and keeps runtime frames in Output", () => {
  const stderr = "TypeError: failure\n at run (/box/main.js:4:8)\n at run (/box/main.js:4:8)\n at run (/piston/main.js:40:8)\n at run (node:internal/main.js:50:8)";
  render(<RunnerPanel submittedFile="main.js" output={<pre>{stderr}</pre>} input={null} stderr={stderr} onJump={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "Problems (1)" }));
  expect(screen.getAllByRole("button", { name: /main.js:4:8/ })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /piston|node:internal/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByText(/node:internal/)).toBeVisible();
});
