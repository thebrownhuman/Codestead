"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  BookOpen,
  BriefcaseBusiness,
  ClipboardCheck,
  ChevronDown,
  CodeXml,
  Compass,
  FolderKanban,
  LayoutDashboard,
  Lightbulb,
  LogOut,
  Menu,
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
import { InterfaceThemeMenu } from "./interface-theme-menu";
import { NotificationMenu } from "./notification-menu";

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

const mobileNavLabels: Readonly<Record<string, string>> = {
  "/learn": "Home",
  "/roadmap": "Path",
  "/courses": "Learn",
  "/playground": "Code",
  "/projects": "Build",
};

function isActivePath(pathname: string, href: string) {
  return pathname === href || (href !== "/learn" && pathname.startsWith(`${href}/`));
}

export function AppShell({
  children,
  admin = false,
  viewer = { name: "Aarav Rao", role: "Learner" },
  browserDurabilityNamespace = null,
  navigate = (destination: string) => { window.location.href = destination; },
}: {
  children: React.ReactNode;
  admin?: boolean;
  viewer?: { name: string; role: string; image?: string | null };
  browserDurabilityNamespace?: string | null;
  navigate?: (destination: string) => void;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [compactNavigation, setCompactNavigation] = useState(false);
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
      setCompactNavigation(query.matches);
      if (!query.matches) setOpen(false);
    };
    syncNavigationMode();
    query.addEventListener("change", syncNavigationMode);
    return () => query.removeEventListener("change", syncNavigationMode);
  }, []);

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
      profileMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
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
      profileMenuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();

    if (event.key === "Tab") {
      // Preserve the browser's native Tab destination in either direction.
      window.requestAnimationFrame(() => setProfileOpen(false));
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
    <div className={styles.shell}>
      {recoveryReady && <ExamLockdownOverlay />}
      <aside
        aria-hidden={compactNavigation && !open ? true : undefined}
        aria-label="Primary navigation"
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}
        id="app-sidebar"
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
          <button ref={closeMenuRef} aria-label="Close navigation" className={styles.closeMenu} onClick={() => setOpen(false)} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div aria-disabled="true" className={styles.searchBox} title="Course search is coming soon">
          <Search size={16} aria-hidden="true" />
          <span>Search · coming soon</span>
        </div>
        <nav className={styles.sideNav} aria-label="Learner navigation">
          <span className={styles.navLabel}>LEARN</span>
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = isActivePath(pathname, href);
            return (
              <Link aria-current={active ? "page" : undefined} className={active ? styles.activeNav : ""} href={href} key={href} onClick={() => setOpen(false)}>
                <Icon aria-hidden="true" size={18} /> <span>{label}</span>
              </Link>
            );
          })}
          <span className={styles.navLabel}>SUPPORT</span>
          <Link aria-current={isActivePath(pathname, "/tutor") ? "page" : undefined} className={isActivePath(pathname, "/tutor") ? styles.activeNav : ""} href="/tutor" onClick={() => setOpen(false)}><MessageCircleMore aria-hidden="true" size={18} /><span>Codestead mentor</span><i /></Link>
          <Link aria-current={isActivePath(pathname, "/settings") ? "page" : undefined} className={isActivePath(pathname, "/settings") ? styles.activeNav : ""} href="/settings" onClick={() => setOpen(false)} ref={admin ? undefined : lastSidebarControlRef}><Settings aria-hidden="true" size={18} /><span>Settings</span></Link>
          {admin && <Link aria-current={isActivePath(pathname, "/admin") ? "page" : undefined} className={isActivePath(pathname, "/admin") ? styles.activeNav : ""} href="/admin" onClick={() => setOpen(false)} ref={lastSidebarControlRef}><Shield aria-hidden="true" size={18} /><span>Admin studio</span></Link>}
        </nav>
        <div className={styles.sidebarFoot}>
          <div className={styles.levelTop}><span>Evidence before points</span></div>
          <small>Mastery appears only after independent, deterministic evidence. Practice replays never farm unlimited XP.</small>
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
        <header className={styles.topbar}>
          <button ref={menuButtonRef} className={styles.menuButton} aria-controls="app-sidebar" aria-expanded={open} aria-label="Open navigation" onClick={() => setOpen(true)} type="button">
            <Menu aria-hidden="true" size={21} />
          </button>
          <div className={styles.mobileBrand}><BrandMark compact /></div>
          <div className={styles.topbarSpacer} />
          <InterfaceThemeMenu />
          <NotificationMenu />
          <div
            className={styles.profileMenu}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
                setProfileOpen(false);
              }
            }}
            ref={profileMenuRef}
          >
            <button ref={profileButtonRef} aria-controls="profile-menu" aria-expanded={profileOpen} aria-haspopup="menu" className={styles.profileButton} onClick={() => setProfileOpen(!profileOpen)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setProfileOpen(true); } }} type="button">
              <span className={styles.avatar}>{initials || "LC"}</span>
              <span className={styles.profileCopy}><strong>{viewer.name}</strong><small>{viewer.role}</small></span>
              <ChevronDown aria-hidden="true" size={15} />
            </button>
            {profileOpen && <div aria-label="Account menu" className={styles.profileDropdown} id="profile-menu" onKeyDown={handleProfileMenuKeyDown} role="menu"><Link href="/settings" role="menuitem" tabIndex={-1} onClick={() => setProfileOpen(false)}><Settings aria-hidden="true" size={15} /> Settings</Link>{admin && <Link href="/admin" role="menuitem" tabIndex={-1} onClick={() => setProfileOpen(false)}><Shield aria-hidden="true" size={15} /> Admin studio</Link>}<button disabled={signOutPending} role="menuitem" tabIndex={-1} type="button" onClick={() => void handleSignOut()}><LogOut aria-hidden="true" size={15} /> {signOutPending ? "Signing out..." : "Sign out"}</button></div>}
          </div>
        </header>
        {signOutError && <p role="alert">Sign-out could not be confirmed, so saved browser work was kept. Check your connection and retry.</p>}
        <main ref={mainRef} id="main-content" className={styles.main} tabIndex={-1}>
          <div className={styles.routeStage} data-route-stage={pathname} key={pathname}>
            {recoveryReady ? children : preparation.status === "failed"
              ? <section role="alert"><p>Codestead could not prepare private browser recovery storage. Retry, or clear this site&apos;s browser data before continuing.</p><button className="button button-secondary" onClick={() => setPreparationRetry((value) => value + 1)} type="button">Retry browser storage cleanup</button></section>
              : <p role="status">Preparing private browser recovery storage...</p>}
          </div>
        </main>
        <nav className={styles.mobileNav} aria-label="Mobile navigation">
          {navItems.filter((item) => ["/learn", "/roadmap", "/courses", "/playground", "/projects"].includes(item.href)).map(({ href, label, icon: Icon }) => {
            const active = isActivePath(pathname, href);
            return <Link aria-label={label} aria-current={active ? "page" : undefined} className={active ? styles.mobileActive : ""} href={href} key={href}><Icon aria-hidden="true" size={19} /><span>{mobileNavLabels[href] ?? label}</span></Link>;
          })}
        </nav>
      </div>
    </div>
    </BrowserDurabilityNamespaceProvider>
  );
}
