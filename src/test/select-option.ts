import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Exercise the visible accessible control instead of setting a native DOM value. */
export async function selectOption(user: Pick<UserEvent, "click" | "selectOptions">, control: HTMLElement, value: string) {
  if (control instanceof HTMLSelectElement) return user.selectOptions(control, value);
  await user.click(control);
  const list = screen.getByRole("listbox");
  const option = within(list).getAllByRole("option").find((item) => item.dataset.value === value);
  if (!option) throw new Error(`Missing select option: ${value}`);
  await user.click(option);
}
