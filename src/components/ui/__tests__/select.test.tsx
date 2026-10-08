import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { Select } from "../select";
import { ModalDialog } from "../modal-dialog";

vi.mock("next/navigation", () => ({ usePathname: () => "/settings" }));

it("opens by keyboard, moves with arrows, selects, and restores focus on Escape", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<label>Language<Select defaultValue="python" onChange={(event) => changed(event.target.value)}><option value="python">Python</option><option value="java">Java</option><option value="cpp" disabled>C++</option></Select></label>);
  const trigger = screen.getByRole("combobox", { name: "Language" });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(changed).toHaveBeenCalledWith("java");
  expect(trigger).toHaveTextContent("Java");
  await user.keyboard("{Enter}{Escape}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("preserves native field names, values, defaults, disabled fields and form reset", async () => {
  const user = userEvent.setup();
  const { container } = render(<form><label htmlFor="track">Primary track</label><Select id="track" name="track" defaultValue="cpp"><option value="">Choose</option><option value="python">Python</option><option value="cpp">C++</option></Select><Select name="disabled" disabled defaultValue="secret"><option value="secret">Disabled field</option></Select><button type="reset">Reset</button></form>);
  const form = container.querySelector("form")!;
  expect([...new FormData(form)]).toEqual([["track", "cpp"]]);
  await user.click(screen.getByLabelText("Primary track"));
  await user.click(screen.getByRole("option", { name: "Python" }));
  expect([...new FormData(form)]).toEqual([["track", "python"]]);
  await user.click(screen.getByRole("button", { name: "Reset" }));
  await waitFor(() => expect([...new FormData(form)]).toEqual([["track", "cpp"]]));
  expect(screen.getByLabelText("Primary track")).toHaveTextContent("C++");
});

it("retains the empty placeholder and required native validation", async () => {
  const user = userEvent.setup();
  const { container } = render(<form><label>Provider<Select name="provider" required defaultValue=""><option value="">Choose a provider</option><option value="openrouter">OpenRouter</option></Select></label></form>);
  const form = container.querySelector("form")!;
  expect(form.checkValidity()).toBe(false);
  expect(screen.getByLabelText("Provider")).toHaveFocus();
  await user.click(screen.getByLabelText("Provider"));
  await user.click(screen.getByRole("option", { name: "OpenRouter" }));
  expect(form.checkValidity()).toBe(true);
  expect([...new FormData(form)]).toEqual([["provider", "openrouter"]]);
});

it("keeps a controlled value authoritative and supplies a real change event", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const { rerender } = render(<Select aria-label="Controlled" value="a" onChange={(event) => { changed(event.target instanceof HTMLSelectElement, event.target.value); }}><option value="a">A</option><option value="b">B</option></Select>);
  await user.click(screen.getByLabelText("Controlled"));
  await user.click(screen.getByRole("option", { name: "B" }));
  expect(changed).toHaveBeenCalledWith(true, "b");
  expect(screen.getByLabelText("Controlled")).toHaveTextContent("A");
  rerender(<Select aria-label="Controlled" value="b"><option value="a">A</option><option value="b">B</option></Select>);
  expect(screen.getByLabelText("Controlled")).toHaveTextContent("B");
});

it("opens inside ModalDialog; first Escape closes only the list, second closes the dialog", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open settings</button>{open && <ModalDialog backdropClassName="backdrop" dialogClassName="dialog" labelledBy="title" onClose={() => setOpen(false)}><h2 id="title">Settings</h2><label>Theme<Select defaultValue="light"><option value="light">Light</option><option value="dark">Dark</option></Select></label><button>Save</button></ModalDialog>}</>;
  }
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Open settings" }));
  await user.click(screen.getByLabelText("Theme"));
  await user.click(screen.getByRole("option", { name: "Dark" }));
  expect(screen.getByLabelText("Theme")).toHaveTextContent("Dark");
  await user.keyboard("{Enter}{Escape}");
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByLabelText("Theme")).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Open settings" })).toHaveFocus();
});

it("uses option text as the value when no explicit value was supplied", () => {
  const { container } = render(<form><Select name="track"><option>Python</option><option>C++</option></Select></form>);
  expect(new FormData(container.querySelector("form")!).get("track")).toBe("Python");
});

it("reflects native change events such as autofill", () => {
  const changed = vi.fn();
  const { container } = render(<Select name="course" onChange={changed}><option value="python">Python</option><option value="java">Java</option></Select>);
  act(() => fireEvent.change(container.querySelector('select[name="course"]')!, { target: { value: "java" } }));
  expect(screen.getByRole("combobox")).toHaveTextContent("Java");
  expect(changed).toHaveBeenCalledOnce();
});

it("emits one form change event from the original named native field", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<form onChange={(event) => {
    const target = event.target;
    if (target instanceof HTMLSelectElement) changed(target.name, target.value);
    else changed(null);
  }}><label>Course<Select name="course"><option value="python">Python</option><option value="java">Java</option></Select></label></form>);
  await user.click(screen.getByLabelText("Course"));
  await user.click(screen.getByRole("option", { name: "Java" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith("course", "java");
});
