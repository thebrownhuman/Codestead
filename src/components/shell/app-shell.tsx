"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  BookOpen,
  BriefcaseBusiness,
  ClipboardCheck,
  ChevronUp,
  CodeXml,
  Compass,
  FolderKanban,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  MessageCircleMore,
  Search,
  Settings,
  Shield,
  Trophy,
  UserRoundCheck,
  X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { TutorLessonProvider } from "@/components/lesson/tutor-context";
import { TutorLauncherHost } from "@/components/lesson/tutor-panel";
import { authClient } from "@/lib/auth-client";
import { BrowserDurabilityNamespaceProvider } from "@/lib/browser-durability/context";
import { openBrowserOutbox } from "@/lib/browser-durability/indexed-db";
import {
  prepareBrowserRecoveryNamespace,
  withBrowserRecoveryRepository,
} from "@/lib/browser-durability/lifecycle";
import { signOutWithBrowserDurabilityCleanup } from "@/lib/drafts/logout";
import styles from "./app-shell.module.css";
import { ExamLockdownOverlay } from "./exam-lockdown-overlay";
import { InterfaceThemeOptions } from "./interface-theme-menu";
import { NotificationMenu } from "./notification-menu";

const SIDEBAR_HIDDEN_KEY = "codestead.sidebar-collapsed";

const navItems = [
  { href: "/learn", label: "Home", icon: LayoutDashboard },
  { href: "/roadmap", label: "My roadmap", icon: Compass },
  { href: "/courses", label: "Courses", icon: BookOpen },
  { href: "/requests", label: "Request a topic", icon: Lightbulb },
  { href: "/playground", label: "Code lab", icon: CodeXml },
  { href: "/review", label: "Skill refresh", icon: ClipboardCheck },
  { href: "/exams", label: "Exams", icon: ClipboardCheck },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/career", label: "Career trails", icon: BriefcaseBusiness },
  { href: "/certificates", label: "Certificates", icon: BadgeCheck },
  { href: "/portfolio", label: "Public portfolio", icon: UserRoundCheck },
  { href: "/community", label: "Community", icon: Trophy }
];

function isActivePath(pathname: string, href: string) {
  return pathname === href || (href !== "/learn" && pathname.startsWith(`${href}/`));
}

export function AppShell({
  children,
  admin = false,
  viewer = { name: "Aarav Rao", role: "Learner" },
  browserDurabilityNamespace = null,
  authenticatedSessionMonitoring = browserDurabilityNamespace !== null,
  navigate = (destination: string) => { window.location.href = destination; },
}: {
  children: React.ReactNode;
  admin?: boolean;
  viewer?: { name: string; role: string; image?: string | null };
  browserDurabilityNamespace?: string | null;
  authenticatedSessionMonitoring?: boolean;
  navigate?: (destination: string) => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  // After collapsing, the pointer is still over the rail; keep it collapsed until
  // the pointer leaves once, as browser vertical tabs do.
  const [railHoverSuppressed, setRailHoverSuppressed] = useState(false);
  // Collapsed (desktop) keeps an icon rail that expands on hover, like browser
  // vertical tabs; only narrow viewports switch to the off-canvas drawer.
  const compactNavigation = narrowViewport;
  const [preparation, setPreparation] = useState<{
    namespace: string | null;
    status: "preparing" | "ready" | "failed";
  }>(() => ({
    namespace: browserDurabilityNamespace,
    status: browserDurabilityNamespace ? "preparing" : "ready",
  }));
  const [preparationRetry, setPreparationRetry] = useState(0);
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const preparationGenerationRef = useRef(0);
  const signOutGenerationRef = useRef(0);
  const latestNamespaceRef = useRef(browserDurabilityNamespace);
  useLayoutEffect(() => {
    if (latestNamespaceRef.current !== browserDurabilityNamespace) {
      latestNamespaceRef.current = browserDurabilityNamespace;
      signOutGenerationRef.current += 1;
    }
  }, [browserDurabilityNamespace]);
  const signOutPendingRef = useRef(false);
  const closeMenuRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const lastSidebarControlRef = useRef<HTMLAnchorElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navigationWasOpen = useRef(false);
  const previousPathnameRef = useRef(pathname);
  const initials = viewer.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const recoveryReady = browserDurabilityNamespace === null
    || (preparation.namespace === browserDurabilityNamespace
      && preparation.status === "ready");

  useEffect(() => {
    const generation = preparationGenerationRef.current + 1;
    preparationGenerationRef.current = generation;
    if (!browserDurabilityNamespace) {
      return;
    }
    const namespace = browserDurabilityNamespace;
    queueMicrotask(() => {
      if (preparationGenerationRef.current === generation) {
        setPreparation({ namespace, status: "preparing" });
      }
    });
    void (async () => {
      try {
        await withBrowserRecoveryRepository(openBrowserOutbox, (repository) => (
          prepareBrowserRecoveryNamespace({
            namespace,
            sessionStorage: window.sessionStorage,
            localStorage: window.localStorage,
            repository,
          })
        ));
        if (preparationGenerationRef.current === generation) {
          setPreparation({ namespace, status: "ready" });
        }
      } catch {
        if (preparationGenerationRef.current === generation) {
          setPreparation({ namespace, status: "failed" });
        }
      }
    })();
    return () => {
      if (preparationGenerationRef.current === generation) {
        preparationGenerationRef.current += 1;
      }
    };
  }, [browserDurabilityNamespace, preparationRetry]);

  const handleSignOut = useCallback(async () => {
    if (signOutPendingRef.current) return;
    signOutPendingRef.current = true;
    setSignOutPending(true);
    setSignOutError(false);
    const generation = signOutGenerationRef.current;
    const namespace = browserDurabilityNamespace;
    const navigateIfCurrent = (destination: string) => {
      if (signOutGenerationRef.current === generation
        && latestNamespaceRef.current === namespace) navigate(destination);
    };
    try {
      if (namespace) {
        await signOutWithBrowserDurabilityCleanup({
          namespace,
          sessionStorage: window.sessionStorage,
          localStorage: window.localStorage,
          signOut: () => authClient.signOut(),
          navigate: navigateIfCurrent,
        });
      } else {
        const result = await authClient.signOut();
        if (result && typeof result === "object" && "error" in result
          && (result as { error?: unknown }).error) {
          throw new Error("Sign-out could not be confirmed.");
        }
        navigateIfCurrent("/login");
      }
    } catch {
      if (signOutGenerationRef.current === generation
        && latestNamespaceRef.current === namespace) setSignOutError(true);
    } finally {
      signOutPendingRef.current = false;
      setSignOutPending(false);
    }
  }, [browserDurabilityNamespace, navigate]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 920px)");
    const syncNavigationMode = () => {
      setNarrowViewport(query.matches);
      if (!query.matches) setOpen(false);
    };
    syncNavigationMode();
    query.addEventListener("change", syncNavigationMode);
    return () => query.removeEventListener("change", syncNavigationMode);
  }, []);

  useEffect(() => {
    try {
      // Read after mount on purpose: localStorage is unavailable during the server render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarHidden(window.localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "true");
    } catch {
      // Storage can be unavailable (private mode); the sidebar then stays visible.
    }
  }, []);

  function toggleSidebarHidden() {
    const next = !sidebarHidden;
    setSidebarHidden(next);
    setRailHoverSuppressed(next);
    setOpen(false);
    if (next && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    try {
      window.localStorage.setItem(SIDEBAR_HIDDEN_KEY, String(next));
    } catch {
      // Preference is a convenience only.
    }
  }

  useEffect(() => {
    if (!compactNavigation) {
      navigationWasOpen.current = open;
      return;
    }
    if (open) {
      closeMenuRef.current?.focus();
      document.documentElement.dataset.navigationOpen = "true";
    } else {
      delete document.documentElement.dataset.navigationOpen;
      if (navigationWasOpen.current) menuButtonRef.current?.focus();
    }
    navigationWasOpen.current = open;
    return () => {
      delete document.documentElement.dataset.navigationOpen;
    };
  }, [compactNavigation, open]);

  useEffect(() => {
    function closeOverlays(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        if (profileOpen) {
          setProfileOpen(false);
          queueMicrotask(() => profileButtonRef.current?.focus());
        }
      }
    }
    window.addEventListener("keydown", closeOverlays);
    return () => window.removeEventListener("keydown", closeOverlays);
  }, [profileOpen]);

  useEffect(() => {
    if (!profileOpen) return;
    const frame = window.requestAnimationFrame(() => {
      profileMenuRef.current?.querySelector<HTMLElement>("[role='menuitem'], [role='menuitemradio']")?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) setProfileOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [profileOpen]);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;

    const frame = window.requestAnimationFrame(() => {
      mainRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  function closeProfileMenu() {
    setProfileOpen(false);
    queueMicrotask(() => profileButtonRef.current?.focus());
  }

  function handleProfileMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      profileMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem'], [role='menuitemradio']") ?? [],
    );
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();

    if (event.key === "Tab") {
      // Preserve the browser's native Tab destination in either direction.
      const menuAtKeydown = event.currentTarget;
      window.requestAnimationFrame(() => {
        if (profileMenuRef.current?.contains(menuAtKeydown)) setProfileOpen(false);
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeProfileMenu();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    }
  }

  return (
    <BrowserDurabilityNamespaceProvider namespace={browserDurabilityNamespace}>
    <TutorLessonProvider>
    <div className={`${styles.shell} ${sidebarHidden ? styles.shellDrawer : ""}`}>
      {recoveryReady && (
        <ExamLockdownOverlay enabled={authenticatedSessionMonitoring} />
      )}
      <aside
        aria-hidden={compactNavigation && !open ? true : undefined}
        aria-label="Primary navigation"
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""} ${railHoverSuppressed ? styles.railSuppressed : ""} ${profileOpen ? styles.railMenuOpen : ""}`}
        id="app-sidebar"
        onMouseLeave={() => setRailHoverSuppressed(false)}
        inert={compactNavigation && !open ? true : undefined}
      >
        <button
          aria-label="Wrap to last navigation item"
          className={styles.focusGuard}
          data-focus-guard
          onFocus={() => lastSidebarControlRef.current?.focus()}
          tabIndex={compactNavigation && open ? 0 : -1}
          type="button"
        />
        <div className={styles.sidebarHeader}>
          <BrandMark />
          {!narrowViewport && (
            <button
              aria-label={sidebarHidden ? "Pin sidebar open" : "Collapse sidebar"}
              className={styles.sidebarToggle}
              onClick={toggleSidebarHidden}
              title={sidebarHidden ? "Pin sidebar open" : "Collapse sidebar"}
              type="button"
            >
              {sidebarHidden ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
            </button>
          )}
          <button ref={closeMenuRef} aria-label="Close navigation" className={styles.closeMenu} onClick={() => setOpen(false)} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div aria-disabled="true" className={styles.searchBox} title="Course search is coming soon">
          <Search size={16} aria-hidden="true" />
          <span>Search · coming soon</span>
        </div>
        <nav className={styles.sideNav} aria-label="Learner navigation">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = isActivePath(pathname, href);
            return (
              <Link aria-current={active ? "page" : undefined} className={active ? styles.activeNav : ""} href={href} key={href} onClick={() => setOpen(false)}>
                <Icon aria-hidden="true" size={18} /> <span>{label}</span>
              </Link>
            );
          })}
          <Link aria-current={isActivePath(pathname, "/tutor") ? "page" : undefined} className={isActivePath(pathname, "/tutor") ? styles.activeNav : ""} href="/tutor" onClick={() => setOpen(false)}><MessageCircleMore aria-hidden="true" size={18} /><span>Codestead mentor</span><i /></Link>
          <Link aria-current={isActivePath(pathname, "/settings") ? "page" : undefined} className={isActivePath(pathname, "/settings") ? styles.activeNav : ""} href="/settings" onClick={() => setOpen(false)} ref={admin ? undefined : lastSidebarControlRef}><Settings aria-hidden="true" size={18} /><span>Settings</span></Link>
          <NotificationMenu inSidebar />
          {admin && <Link aria-current={isActivePath(pathname, "/admin") ? "page" : undefined} className={isActivePath(pathname, "/admin") ? styles.activeNav : ""} href="/admin" onClick={() => setOpen(false)} ref={lastSidebarControlRef}><Shield aria-hidden="true" size={18} /><span>Admin studio</span></Link>}
        </nav>
        <div
          className={styles.sidebarAccount}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
              setProfileOpen(false);
            }
          }}
          ref={profileMenuRef}
        >
          <button ref={profileButtonRef} aria-controls="profile-menu" aria-expanded={profileOpen} aria-haspopup="menu" className={styles.accountButton} onClick={() => setProfileOpen(!profileOpen)} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setProfileOpen(true); } }} type="button">
            <span className={styles.avatar}>{initials || "LC"}</span>
            <span className={styles.profileCopy}><strong>{viewer.name}</strong><small>{viewer.role}</small></span>
            <ChevronUp aria-hidden="true" size={15} />
          </button>
          {profileOpen && <div aria-label="Account menu" className={styles.accountDropdown} id="profile-menu" onKeyDown={handleProfileMenuKeyDown} role="menu">
            <InterfaceThemeOptions onChosen={() => setProfileOpen(false)} />
            <span className={styles.accountDivider} role="presentation" />
            <button disabled={signOutPending} role="menuitem" tabIndex={-1} type="button" onClick={() => void handleSignOut()}><LogOut aria-hidden="true" size={15} /> {signOutPending ? "Signing out..." : "Sign out"}</button>
          </div>}
        </div>
        <button
          aria-label="Wrap to first navigation item"
          className={styles.focusGuard}
          data-focus-guard
          onFocus={() => closeMenuRef.current?.focus()}
          tabIndex={compactNavigation && open ? 0 : -1}
          type="button"
        />
      </aside>

      {open && <button className={styles.scrim} aria-label="Close navigation" onClick={() => setOpen(false)} tabIndex={-1} type="button" />}

      <div className={styles.contentColumn} id="app-content-column" inert={compactNavigation && open ? true : undefined}>
        {/* No top bar (owner preference, like Claude): on narrow screens a single
            floating button opens the navigation drawer. */}
        <button ref={menuButtonRef} className={styles.menuButton} aria-controls="app-sidebar" aria-expanded={open} aria-label="Open navigation" onClick={() => setOpen(true)} type="button">
          <Menu aria-hidden="true" size={21} />
        </button>
        {signOutError && <p role="alert">Sign-out could not be confirmed, so saved browser work was kept. Check your connection and retry.</p>}
        <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
          <div className={styles.routeStage} data-route-stage={pathname} key={pathname}>
            {recoveryReady ? children : preparation.status === "failed"
              ? <section role="alert"><p>Codestead could not prepare private browser recovery storage. Retry, or clear this site&apos;s browser data before continuing.</p><button className="button button-secondary" onClick={() => setPreparationRetry((value) => value + 1)} type="button">Retry browser storage cleanup</button></section>
              : <p role="status">Preparing private browser recovery storage...</p>}
          </div>
        </main>
        {recoveryReady && <TutorLauncherHost />}
      </div>
    </div>
    </TutorLessonProvider>
    </BrowserDurabilityNamespaceProvider>
  );
}
