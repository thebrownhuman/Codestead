import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RunnerPanel } from "../runner-panel";

it("switches panels with roving tabindex and skips the disabled Terminal", () => {
  render(<RunnerPanel output={<p>last log</p>} input={<textarea aria-label="stdin" />} stderr="" onJump={vi.fn()} />);
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
  render(<RunnerPanel output={<p>main.c:4:8: error: missing semicolon</p>} input={null} stderr="main.c:4:8: error: missing semicolon" onJump={jump} />);
  fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
  fireEvent.click(screen.getByRole("button", { name: /main.c:4:8.*missing semicolon/ }));
  expect(jump).toHaveBeenCalledWith({ file: "main.c", line: 4, column: 8, message: "missing semicolon" });
  fireEvent.click(screen.getByRole("tab", { name: "Output" }));
  expect(screen.getByText("main.c:4:8: error: missing semicolon")).toBeVisible();
});
