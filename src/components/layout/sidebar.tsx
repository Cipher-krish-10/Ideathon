"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, ChevronsUpDown, FileClock, LayoutDashboard,
  LifeBuoy, ShieldAlert, SlidersHorizontal, Target, Zap,
} from "lucide-react";

/**
 * Primary navigation.
 *
 * Grouped by what the merchant is doing — running the business, versus
 * governing it — because those are different sessions with different urgency.
 * The active item gets a hairline rail and a weight change rather than a
 * filled pill: navigation is never the loudest thing on an operations screen.
 *
 * Collapses to an icon rail under 1024px rather than disappearing. A demo may
 * run at an odd projector resolution, and losing navigation mid-story is worse
 * than a narrow rail.
 */
const GROUPS = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/opportunities", label: "Opportunities", icon: Target },
      { href: "/interventions", label: "Interventions", icon: Zap },
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/policies", label: "Policies", icon: SlidersHorizontal },
      { href: "/audit", label: "Audit", icon: FileClock },
    ],
  },
] as const;

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] ?? "").join("").toUpperCase();
}

export function Sidebar({
  merchantName, mode, role, userName,
}: { merchantName: string; mode: string; role: string; userName: string }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-mark">
          {/* A plain geometric mark. A gradient rounded-square with a sparkle
              is the single most recognisable generated-app signature. */}
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 11.5 6.4 7l2.6 3 4-6.5" stroke="currentColor" strokeWidth="1.8"
                  strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="sb-wordmark">RevenuePilot</span>
      </div>

      {/* Workspace selector. One merchant exists in this build, so it does not
          open a menu — it reads as a switcher without pretending to be one. */}
      <div className="sb-workspace" title={`${merchantName} · demo merchant`}>
        <span className="sb-ws-avatar">{initials(merchantName)}</span>
        <span className="sb-ws-text">
          <span className="sb-ws-name">{merchantName}</span>
          <span className="sb-ws-meta">Demo merchant</span>
        </span>
        <ChevronsUpDown size={13} className="sb-ws-chevron" />
      </div>

      <nav className="sb-nav">
        {GROUPS.map((group) => (
          <div className="sb-group" key={group.label}>
            <div className="sb-group-label">{group.label}</div>
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`sb-item${active ? " active" : ""}`}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon strokeWidth={active ? 2.2 : 1.8} />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sb-foot">
        {/* Always visible. There is no live-mode code path in this build, and
            the merchant should never have to wonder which mode they are in. */}
        <div className="sb-env test-banner" title="Razorpay Test Mode · no live money can move">
          <ShieldAlert strokeWidth={2.2} />
          <span className="sb-env-text">
            <span className="sb-env-title">{mode} mode</span>
            <span className="sb-env-detail">Razorpay Test Mode · no live money can move</span>
          </span>
        </div>

        <a className="sb-item" href="/docs" onClick={(event) => event.preventDefault()}>
          <LifeBuoy strokeWidth={1.8} />
          <span>Help &amp; docs</span>
        </a>

        <div className="sb-user">
          <span className="sb-avatar">{initials(userName)}</span>
          <span style={{ minWidth: 0 }}>
            <span className="sb-user-name">{userName}</span>
            <span className="sb-user-role">{role}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
