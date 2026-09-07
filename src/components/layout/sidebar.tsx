"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, FileClock, LayoutDashboard,
  Shield, Sparkles, Target, Zap,
} from "lucide-react";

/**
 * Persistent navigation.
 *
 * Collapses to icons under 1080px rather than disappearing — a demo may run on
 * a projector at an odd resolution, and losing navigation mid-story is worse
 * than a narrower rail.
 */
const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/opportunities", label: "Opportunities", icon: Target },
  { href: "/interventions", label: "Interventions", icon: Zap },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/policies", label: "Policies", icon: Shield },
  { href: "/audit", label: "Audit", icon: FileClock },
] as const;

export function Sidebar({
  merchantName, mode, role,
}: { merchantName: string; mode: string; role: string }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={14} strokeWidth={2.2} /></div>
          <div>
            <div className="brand-name">RevenuePilot</div>
            <div className="brand-sub">Merchant Growth Agent</div>
          </div>
        </div>
      </div>

      <div className="merchant-chip">
        <span className="dot" />
        <div style={{ minWidth: 0 }}>
          <div className="name">{merchantName}</div>
          <div className="meta">Demo merchant · {role}</div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-label">Workspace</div>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link key={href} href={href} className={`nav-item${active ? " active" : ""}`}>
              <Icon strokeWidth={active ? 2.3 : 1.9} />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        {/* Always visible. There is no live-mode code path in this build. */}
        <div className="mode-card test-banner">
          <div className="t"><Shield size={11} strokeWidth={2.4} />{mode} mode</div>
          <div className="d">Razorpay Test Mode · no live money can move</div>
        </div>
        <div className="sys-status">
          <span className="status-dot active" />
          <span>All systems operational</span>
        </div>
      </div>
    </aside>
  );
}
