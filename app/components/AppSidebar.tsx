"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";

const items = [
  ["/", "Dashboard", "⌂"],
  ["/profiles", "Profiles", "♙"],
  ["/calendar", "Follow-up calendar", "□"],
  ["/analytics", "Analytics", "▥"],
  ["/health", "System health", "⌁"],
  ["/admin", "Configuration", "⚙"],
] as const;

export default function AppSidebar() {
  const pathname = usePathname();
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
          <span style={{ color: "var(--accent)" }}>▰</span>{" "}
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
            <span style={{ flex: "none", width: 16 }}>{icon}</span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="nav-label clients-label">
        Clients <button aria-label="Add client">+</button>
      </div>
      <div className="client-list">
        <button>
          <i style={{ background: "#8b7cff" }}>N</i>Northstar AI <span>6</span>
        </button>
        <button>
          <i style={{ background: "#55c7a2" }}>P</i>Pylon Labs <span>3</span>
        </button>
        <button>
          <i style={{ background: "#f2a36b" }}>V</i>Vectorly <span>2</span>
        </button>
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
