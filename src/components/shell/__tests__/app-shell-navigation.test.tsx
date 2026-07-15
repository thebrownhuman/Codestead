import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/learn" }));
const durability = vi.hoisted(() => ({
  openBrowserOutbox: vi.fn(),
  prepareNamespace: vi.fn(),
  signOutCleanup: vi.fn(),
  close: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/lib/browser-durability/indexed-db", () => ({
  openBrowserOutbox: durability.openBrowserOutbox,
}));
vi.mock("@/lib/browser-durability/lifecycle", () => ({
  prepareBrowserRecoveryNamespace: durability.prepareNamespace,
}));
vi.mock("@/lib/drafts/logout", () => ({
  signOutWithBrowserDurabilityCleanup: durability.signOutCleanup,
}));
vi.mock("../exam-lockdown-overlay", () => ({ ExamLockdownOverlay: () => null }));

import { AppShell } from "../app-shell";

const shellCss = readFileSync(resolve(process.cwd(), "src/components/shell/app-shell.module.css"), "utf8");

describe("AppShell compact navigation", () => {
  beforeEach(() => {
    navigation.pathname = "/learn";
    durability.close.mockReset();
    durability.openBrowserOutbox.mockReset();
    durability.prepareNamespace.mockReset();
    durability.signOutCleanup.mockReset();
    durability.openBrowserOutbox.mockResolvedValue({ close: durability.close });
    durability.prepareNamespace.mockResolvedValue(undefined);
    durability.signOutCleanup.mockResolvedValue({ cleanupSucceeded: true });
    localStorage.clear();
    document.documentElement.removeAttribute("data-interface-theme");
    document.documentElement.removeAttribute("data-navigation-open");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 920px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it("gates recovery consumers until private browser storage preparation completes", async () => {
    let finish!: () => void;
    durability.prepareNamespace.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    render(
      <AppShell browserDurabilityNamespace="namespace-current">
        <p>Private lesson editor</p>
      </AppShell>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/preparing private browser recovery/i);
    expect(screen.queryByText("Private lesson editor")).not.toBeInTheDocument();
    await waitFor(() => expect(durability.prepareNamespace).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "namespace-current",
        repository: expect.any(Object),
      }),
    ));

    await act(async () => finish());
    expect(await screen.findByText("Private lesson editor")).toBeInTheDocument();
    expect(durability.close).toHaveBeenCalledOnce();
  });

  it("blocks consumers on preparation failure and retries with a fresh repository", async () => {
    durability.prepareNamespace
      .mockRejectedValueOnce(new Error("private key detail"))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(
      <AppShell browserDurabilityNamespace="namespace-current">
        <p>Private lesson editor</p>
      </AppShell>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not prepare private browser recovery storage/i,
    );
    expect(screen.queryByText("private key detail")).not.toBeInTheDocument();
    expect(screen.queryByText("Private lesson editor")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry browser storage cleanup" }));

    expect(await screen.findByText("Private lesson editor")).toBeInTheDocument();
    expect(durability.openBrowserOutbox).toHaveBeenCalledTimes(2);
    expect(durability.close).toHaveBeenCalledTimes(2);
  });

  it("keeps demo mode usable without opening authenticated browser storage", () => {
    render(<AppShell browserDurabilityNamespace={null}><p>Demo content</p></AppShell>);
    expect(screen.getByText("Demo content")).toBeInTheDocument();
    expect(durability.openBrowserOutbox).not.toHaveBeenCalled();
  });

  it("disables sign-out while pending and shows a retryable authority error", async () => {
    durability.signOutCleanup.mockRejectedValueOnce(new Error("secret network detail"));
    const user = userEvent.setup();
    render(
      <AppShell browserDurabilityNamespace="namespace-current">
        <p>Learning content</p>
      </AppShell>,
    );
    expect(await screen.findByText("Learning content")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Aarav Rao/i }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /sign-out could not be confirmed.*saved browser work was kept/i,
    );
    expect(screen.queryByText("secret network detail")).not.toBeInTheDocument();
    expect(durability.signOutCleanup).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "namespace-current",
    }));
  });

  it("does not navigate a newly supplied namespace after an old sign-out completes", async () => {
    let finish!: () => void;
    durability.signOutCleanup.mockImplementationOnce((input: { navigate: (value: string) => void }) => (
      new Promise<void>((resolve) => { finish = resolve; }).then(() => {
        input.navigate("/login");
        return { cleanupSucceeded: true };
      })
    ));
    const navigate = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <AppShell browserDurabilityNamespace="namespace-old" navigate={navigate}>
        <p>Learning content</p>
      </AppShell>,
    );
    expect(await screen.findByText("Learning content")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Aarav Rao/i }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    view.rerender(
      <AppShell browserDurabilityNamespace="namespace-new" navigate={navigate}>
        <p>New session content</p>
      </AppShell>,
    );
    await act(async () => finish());

    expect(await screen.findByText("New session content")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the closed drawer inert, focuses it when opened, and restores focus after Escape", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Learning content</p></AppShell>);

    const sidebar = document.getElementById("app-sidebar");
    const content = document.getElementById("app-content-column");
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await waitFor(() => expect(sidebar).toHaveAttribute("inert"));
    expect(sidebar).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTitle("Course search is coming soon")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Notifications" })).toBeEnabled();

    await user.click(trigger);
    expect(sidebar).not.toHaveAttribute("inert");
    expect(content).toHaveAttribute("inert");
    expect(within(sidebar as HTMLElement).getByRole("button", { name: "Close navigation" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(sidebar).toHaveAttribute("inert"));
    expect(content).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("exposes profile-menu semantics and restores trigger focus after Escape", async () => {
    const user = userEvent.setup();
    render(<AppShell><button type="button">Learning action</button></AppShell>);

    const trigger = screen.getByRole("button", { name: /Aarav Rao/i });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-controls", "profile-menu");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus());

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("closes the profile menu after forward and reverse Tab without overriding focus", async () => {
    const user = userEvent.setup();
    render(<AppShell><button type="button">Learning action</button></AppShell>);

    const trigger = screen.getByRole("button", { name: /Aarav Rao/i });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus());

    await user.tab();
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menu", { name: "Account menu" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Learning action" })).toHaveFocus();

    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus());
    await user.tab({ shift: true });
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menu", { name: "Account menu" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("lets keyboard users choose an exact interface theme and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Learning content</p></AppShell>);

    const trigger = screen.getByRole("button", { name: "Interface theme: System" });
    await user.click(trigger);

    const themeMenu = screen.getByRole("menu", { name: "Choose interface theme" });
    const highContrast = within(themeMenu).getByRole("menuitemradio", { name: /High contrast/i });
    expect(within(themeMenu).getByRole("menuitemradio", { name: /System/i })).toHaveAttribute("aria-checked", "true");

    await user.click(highContrast);

    expect(document.documentElement).toHaveAttribute("data-interface-theme", "contrast");
    expect(document.documentElement).toHaveAttribute("data-contrast", "more");
    expect(trigger).toHaveAccessibleName("Interface theme: High contrast");
    expect(trigger).toHaveFocus();
  });

  it("closes the theme menu after forward and reverse Tab without trapping focus", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Learning content</p></AppShell>);

    const themeTrigger = screen.getByRole("button", { name: "Interface theme: System" });
    const notificationTrigger = screen.getByRole("button", { name: "Notifications" });
    await user.click(themeTrigger);
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: /System/i })).toHaveFocus(),
    );

    await user.tab();
    await waitFor(() => expect(themeTrigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menu", { name: "Choose interface theme" })).not.toBeInTheDocument();
    expect(notificationTrigger).toHaveFocus();

    await user.click(themeTrigger);
    await waitFor(() =>
      expect(screen.getByRole("menuitemradio", { name: /System/i })).toHaveFocus(),
    );
    await user.tab({ shift: true });
    await waitFor(() => expect(themeTrigger).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("menu", { name: "Choose interface theme" })).not.toBeInTheDocument();
    expect(themeTrigger).toHaveFocus();
  });

  it("keeps keyboard focus inside an open compact navigation drawer", async () => {
    const user = userEvent.setup();
    render(<AppShell><p>Learning content</p></AppShell>);

    const sidebar = document.getElementById("app-sidebar") as HTMLElement;
    await waitFor(() => expect(sidebar).toHaveAttribute("inert"));
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await waitFor(() => expect(sidebar).not.toHaveAttribute("inert"));
    const close = within(sidebar).getByRole("button", { name: "Close navigation" });
    const last = within(sidebar).getByRole("link", { name: "Settings" });
    const startGuard = within(sidebar).getByRole("button", { name: "Wrap to last navigation item" });
    const endGuard = within(sidebar).getByRole("button", { name: "Wrap to first navigation item" });
    expect(close).toHaveFocus();
    expect(startGuard).toHaveAttribute("data-focus-guard");
    expect(endGuard).toHaveAttribute("data-focus-guard");
    expect(startGuard).toHaveAttribute("tabindex", "0");
    expect(endGuard).toHaveAttribute("tabindex", "0");

    startGuard.focus();
    expect(last).toHaveFocus();
    endGuard.focus();
    expect(close).toHaveFocus();
  });

  it("replaces the animated content stage on a route change", () => {
    const { rerender } = render(<AppShell><p>Learning content</p></AppShell>);
    const initialStage = document.querySelector("[data-route-stage]");

    expect(initialStage).toHaveAttribute("data-route-stage", "/learn");

    navigation.pathname = "/projects/project-1";
    rerender(<AppShell><p>Project content</p></AppShell>);

    const nextStage = document.querySelector("[data-route-stage]");
    expect(nextStage).toHaveAttribute("data-route-stage", "/projects/project-1");
    expect(nextStage).not.toBe(initialStage);
    expect(screen.getByText("Project content")).toBeInTheDocument();
  });

  it("keeps initial focus in place and moves it to main content after a route change", async () => {
    const { rerender } = render(<AppShell><button type="button">Current learning action</button></AppShell>);
    const initialAction = screen.getByRole("button", { name: "Current learning action" });
    initialAction.focus();

    await Promise.resolve();
    expect(initialAction).toHaveFocus();

    navigation.pathname = "/projects/project-1";
    rerender(<AppShell><h1>Project workspace</h1></AppShell>);

    await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
  });

  it("marks nested desktop and mobile destinations as the current page", () => {
    navigation.pathname = "/projects/project-1";
    render(<AppShell><p>Project content</p></AppShell>);

    const projectLinks = screen.getAllByRole("link", { name: "Projects", hidden: true });
    expect(projectLinks).toHaveLength(2);
    expect(projectLinks.every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
  });

  it("keeps full accessible mobile labels while using compact sighted labels", () => {
    render(<AppShell><p>Learning content</p></AppShell>);

    const mobileNavigation = screen.getByRole("navigation", { name: "Mobile navigation" });
    expect(within(mobileNavigation).getByRole("link", { name: "My roadmap" })).toHaveTextContent("Path");
    expect(within(mobileNavigation).getByRole("link", { name: "Courses" })).toHaveTextContent("Learn");
    expect(within(mobileNavigation).getByRole("link", { name: "Projects" })).toHaveTextContent("Build");
  });

  it("contains explicit large-text and reduced-motion shell fallbacks", () => {
    expect(shellCss).toContain(':global(html[data-text-size="150"]) .sidebar');
    expect(shellCss).toContain(':global(html[data-text-size="200"]) .mobileNav');
    expect(shellCss).toContain(':global(html[data-text-size="200"]) .main');
    expect(shellCss).toContain(':global(html[data-motion="reduce"]) .routeStage');
    expect(shellCss).toContain(':global(html:not([data-motion="normal"])) .routeStage');
    expect(shellCss).toContain("@media (forced-colors: active)");
    expect(shellCss).toContain("env(safe-area-inset-top)");
    expect(shellCss).toContain(".themeDropdown");
  });

  it("keeps route-transition text fully opaque so transient frames retain WCAG contrast", () => {
    const routeAnimationStart = shellCss.indexOf("@keyframes route-stage-enter");
    const nextAnimationStart = shellCss.indexOf("@keyframes menu-enter", routeAnimationStart);
    const routeAnimation = shellCss.slice(routeAnimationStart, nextAnimationStart);

    expect(routeAnimationStart).toBeGreaterThanOrEqual(0);
    expect(nextAnimationStart).toBeGreaterThan(routeAnimationStart);
    expect(routeAnimation).not.toContain("opacity");
  });
});
