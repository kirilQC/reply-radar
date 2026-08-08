"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";

const items = [
  ["/", "Dashboard", "dashboard"],
  ["/inbox", "Inbox", "inbox"],
  ["/database", "Database", "database"],
  ["/profiles", "Profiles", "profiles"],
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
  inbox: "M4 5h16v14H4z M4 9h5l1.5 2h3L15 9h5",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
  database: "M5 5c0-2 14-2 14 0v14c0 2-14 2-14 0z M5 5c0 2 14 2 14 0 M5 12c0 2 14 2 14 0",
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
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [sidebarClients, setSidebarClients] = useState<Array<{ name: string; slug: string; tone: string; logoUrl?: string }>>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [clientsLoading, setClientsLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("reply-radar-sidebar") === "collapsed",
  );
  useEffect(() => {
    // URL selection is client-only state for static navigation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedClient(new URLSearchParams(window.location.search).get("client"));
  }, [pathname]);
  useEffect(() => {
    const hydrate = async () => {
      try {
        const response = await fetch("/api/admin/workspaces", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && Array.isArray(payload.workspaces)) {
          const fresh = payload.workspaces.map((item: Record<string, unknown>) => ({ name: String(item.name ?? ""), slug: String(item.slug ?? ""), tone: String(item.accent_color ?? "var(--accent)"), logoUrl: String(item.logo_url ?? "") }));
          setSidebarClients(fresh);
          window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(fresh));
          setClientsLoading(false);
          return;
        }
      } catch { /* use the offline cache */ }
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (saved) setSidebarClients(JSON.parse(saved));
      } catch { /* keep empty state */ }
      setClientsLoading(false);
    };
    void hydrate();
    const onStorage = () => {
      try { const saved = window.localStorage.getItem("reply-radar-workspaces:v2"); if (saved) setSidebarClients(JSON.parse(saved)); } catch { /* ignore */ }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("reply-radar-workspaces-changed", onStorage);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("reply-radar-workspaces-changed", onStorage); };
  }, []);
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
      <div className="nav-label clients-label">Clients</div>
      <div className="client-list">
        {clientsLoading && sidebarClients.length === 0 && <div className="sidebar-client-skeleton" aria-label="Loading clients"><i /><span /><i /><span /><i /><span /></div>}
        {sidebarClients.filter((client) => client.name).map((client) => (
          <a className={`client-directory-item ${selectedClient === client.slug ? "selected" : ""}`} href={`/inbox?client=${client.slug}`} key={client.slug}>
            <i style={client.logoUrl ? undefined : { background: client.tone }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name[0]}</i>{client.name}
          </a>
        ))}
      </div>
    </aside>
  );
}
