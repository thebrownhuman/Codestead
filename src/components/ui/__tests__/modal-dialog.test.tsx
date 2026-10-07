import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Field } from "../field";
import { ModalDialog } from "../modal-dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return <div>
    <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
    <p>Background content</p>
    {open && <ModalDialog
      backdropClassName="backdrop"
      dialogClassName="dialog"
      labelledBy="dialog-title"
      onClose={() => setOpen(false)}
    >
      <h2 id="dialog-title">Accessible dialog</h2>
      <button type="button" data-dialog-initial-focus>First action</button>
      <button type="button">Last action</button>
    </ModalDialog>}
  </div>;
}

describe("ModalDialog", () => {
  it("keeps a single element child single so Field can label its control", () => {
    render(<ModalDialog backdropClassName="backdrop" dialogClassName="dialog" labelledBy="field-title" onClose={() => {}}>
      <h2 id="field-title">Field dialog</h2>
      <form><Field id="field-message" label="Message" help="Plain text only."><textarea /></Field></form>
    </ModalDialog>);
    const message = screen.getByRole("textbox", { name: "Message" });
    expect(message).toHaveAttribute("aria-describedby", "field-message-help");
    expect(screen.getByRole("dialog", { name: "Field dialog" })).toContainElement(message);
  });
  it("contains focus when mounted inside a nested page beside an outside control", async () => {
    const user = userEvent.setup();
    render(<><button type="button">Outside page</button><main><Harness /></main></>);
    const outside = screen.getByRole("button", { name: "Outside page" });
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    outside.focus();
    await user.tab();
    expect(screen.getByRole("dialog", { name: "Accessible dialog" })).toContainElement(document.activeElement as HTMLElement);
  });
  it("isolates background content, traps focus, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Accessible dialog" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(trigger.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "First action" })).toHaveFocus();

    screen.getByRole("button", { name: "Last action" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "First action" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).not.toHaveAttribute("inert");
    expect(trigger).not.toHaveAttribute("aria-hidden");
    expect(trigger).toHaveFocus();
  });
});
