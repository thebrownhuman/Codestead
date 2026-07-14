"use client";

import { Award, BookOpenCheck, BriefcaseBusiness, ClipboardList, FolderKanban, Gauge, Scale, ShieldCheck, Users, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./admin.module.css";

const links = [
  { href: "/admin", label: "Overview", icon: Gauge, exact: true },
  { href: "/admin#learners", label: "Learners", icon: Users, exact: false },
  { href: "/admin/access", label: "Access queue", icon: ClipboardList, exact: false },
  { href: "/admin/appeals", label: "Appeals", icon: Scale, exact: false },
  { href: "/admin/assessment-corrections", label: "Regrading", icon: Wrench, exact: false },
  { href: "/admin/project-review-corrections", label: "Project corrections", icon: Wrench, exact: false },
  { href: "/admin/requests", label: "Curriculum requests", icon: BookOpenCheck, exact: false },
  { href: "/admin/curriculum", label: "Course review", icon: BookOpenCheck, exact: false },
  { href: "/admin/module-projects", label: "Module projects", icon: FolderKanban, exact: false },
  { href: "/admin/career", label: "Career guidance", icon: BriefcaseBusiness, exact: false },
  { href: "/admin/certificates", label: "Certificates", icon: Award, exact: false },
] as const;

export function AdminFrame({
  adminName,
  children,
}: {
  readonly adminName: string;
  readonly children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className={styles.adminFrame}>
      <header className={styles.adminRail}>
        <div className={styles.adminIdentity}>
          <span><ShieldCheck size={18} /></span>
          <div><strong>Operations console</strong><small>{adminName} · administrator</small></div>
        </div>
        <nav aria-label="Administrator sections">
          {links.map(({ href, label, icon: Icon, exact }) => {
            const targetPath = href.split("#")[0];
            const active = exact
              ? pathname === targetPath
              : href.includes("#")
                ? false
                : pathname.startsWith(targetPath);
            return (
              <Link aria-current={active ? "page" : undefined} className={active ? styles.adminNavActive : ""} href={href} key={href}>
                <Icon size={15} /> {label}
              </Link>
            );
          })}
        </nav>
        <p><ShieldCheck size={14} /> Private, no-store views. Provider secrets remain masked.</p>
      </header>
      {children}
    </div>
  );
}
