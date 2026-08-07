"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";

const items = [
  ["/", "Dashboard", "dashboard"],
  ["/profiles", "Profiles", "profiles"],
  ["/calendar", "Follow-up calendar", "calendar"],
  ["/analytics", "Analytics", "analytics"],
  ["/health", "System health", "health"],
  ["/admin", "Configuration", "settings"],
] as const;
const iconPaths: Record<string, string> = {
  dashboard: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  profiles: "M16 20a4 4 0 0 0-8 0 M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  calendar: "M5 4v3m14-3v3M4 9h16M6 6h12a2 2 0 0 1 2 2v10H4V8a2 2 0 0 1 2-2",
  analytics: "M5 19V9m5 10V5m5 14v-7m5 7V3",
  health: "M4 12h3l2-6 4 12 2-6h5",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
};
function SidebarIcon({ name }: { name: string }) {
  return (
    <svg
      className="sidebar-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name] ?? iconPaths.dashboard} />
    </svg>
  );
}

export default function AppSidebar() {
  const pathname = usePathname();
  const [selectedClient] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("client")
      : null,
  );
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("reply-radar-sidebar") === "collapsed",
  );
  useEffect(() => {
    window.localStorage.setItem(
      "reply-radar-sidebar",
      collapsed ? "collapsed" : "expanded",
    );
  }, [collapsed]);
  return (
    <aside
      className={`sidebar app-sidebar ${collapsed ? "sidebar-collapsed" : ""}`}
    >
      <div className="brand-row">
        <Link
          href="/"
          className="brand-name"
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>{" "}
          <span className="sidebar-label">
            reply<span>radar</span>
          </span>
        </Link>
        <button
          className="sidebar-collapse"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "→" : "←"}
        </button>
      </div>
      <div className="nav-label">Operate</div>
      <nav>
        {items.map(([href, label, icon]) => (
          <a
            key={href}
            href={href}
            className={`nav-item ${pathname === href ? "active" : ""}`}
          >
            <span className="sidebar-icon">
              <SidebarIcon name={icon} />
            </span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="nav-label clients-label">
        Clients <button aria-label="Add client">+</button>
      </div>
      <div className="client-list">
        <a
          className={`client-directory-item ${selectedClient === "northstar" ? "selected" : ""}`}
          href="/inbox?client=northstar"
        >
          <i style={{ background: "#8b7cff" }}>N</i>Northstar AI <span>6</span>
        </a>
        <a
          className={`client-directory-item ${selectedClient === "pylon" ? "selected" : ""}`}
          href="/inbox?client=pylon"
        >
          <i style={{ background: "#55c7a2" }}>P</i>Pylon Labs <span>3</span>
        </a>
        <a
          className={`client-directory-item ${selectedClient === "vectorly" ? "selected" : ""}`}
          href="/inbox?client=vectorly"
        >
          <i style={{ background: "#f2a36b" }}>V</i>Vectorly <span>2</span>
        </a>
      </div>
      <div className="sidebar-bottom">
        <div className="user-chip">
          <div className="user-avatar">AS</div>
          <div>
            <strong>Alex Spencer</strong>
            <small>Agency owner</small>
          </div>
        </div>
      </div>
    </aside>
  );
}
