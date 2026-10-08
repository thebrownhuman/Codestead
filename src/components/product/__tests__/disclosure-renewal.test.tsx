import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DisclosureRenewal } from "../disclosure-renewal";
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("requires one explicit acknowledgement, saves once and refreshes access without requesting keys", async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<DisclosureRenewal />);
  expect(screen.getByRole("heading", { name: "What changed: your last 10 chats" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Accept update and continue" })).toBeDisabled();
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Accept update and continue" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledOnce();
  const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof requestBody !== "string") throw new Error("Expected a JSON renewal request");
  const body: unknown = JSON.parse(requestBody);
  expect(body).toMatchObject({ purpose: "retention_policy", decision: "accepted", renewDisclosures: true, policyVersion: "enrollment-disclosure-2026-07-12.v3" });
  if (!body || typeof body !== "object") throw new Error("Expected a renewal object");
  expect(Object.keys(body).sort()).toEqual(["decision", "policyVersion", "purpose", "renewDisclosures", "requestId"]);
});

it("shows a retryable error and reuses the receipt after a lost response", async () => {
  const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("Connection unavailable")).mockResolvedValue(new Response('{}'));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<DisclosureRenewal />);
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Accept update and continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
  expect(refresh).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Accept update and continue" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
});
