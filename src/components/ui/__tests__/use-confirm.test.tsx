import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { useConfirm } from "../use-confirm";

function Harness({ onResult }: { onResult: (value: boolean) => void }) {
  const { confirm, confirmDialog } = useConfirm();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void confirm({ title: "Discard draft?", description: "This cannot be undone.", confirmLabel: "Discard", destructive: true })
            .then(onResult);
        }}
      >
        Open
      </button>
      {confirmDialog}
    </div>
  );
}

describe("useConfirm", () => {
  it("resolves true when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    render(<Harness onResult={(value) => results.push(value)} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: "Discard draft?" })).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(results).toEqual([true]));
    expect(screen.queryByRole("heading", { name: "Discard draft?" })).not.toBeInTheDocument();
  });

  it("resolves false when cancel is clicked", async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    render(<Harness onResult={(value) => results.push(value)} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results).toEqual([false]));
  });

  it("resolves false when Escape closes the dialog", async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    render(<Harness onResult={(value) => results.push(value)} />);

    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(results).toEqual([false]));
  });
});
