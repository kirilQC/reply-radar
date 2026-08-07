"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import Link from "next/link";

const items = [
  ["/", "Dashboard", "⌂"],
  ["/inbox", "Priority inbox", "▣"],
  ["/profiles", "Profiles", "♙"],
  ["/calendar", "Follow-up calendar", "□"],
  ["/analytics", "Analytics", "▥"],
  ["/health", "System health", "⌁"],
  ["/admin", "Configuration", "⚙"],
] as const;

export default function AppSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
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
      <button className="workspace-select">
        <span className="workspace-dot" />
        <span>
          <small>WORKSPACE</small>
          <strong>All client workspaces</strong>
        </span>
        <span>⌄</span>
      </button>
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
            {href === "/inbox" && <b className="nav-count">12</b>}
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
