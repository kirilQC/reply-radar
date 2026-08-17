// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

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
  ["/meetings", "Meetings", "calendar"],
  ["/analytics", "Analytics", "analytics"],
  ["/reports", "Reports", "reports"],
  ["/mcp", "MCP", "mcp"],
  ["/qc-brain", "QC Brain", "brain"],
  ["/health", "System health", "health"],
  ["/admin", "Configuration", "settings"],
] as const;
const iconPaths: Record<string, string> = {
  dashboard: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  profiles: "M16 20a4 4 0 0 0-8 0 M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  calendar: "M5 4v3m14-3v3M4 9h16M6 6h12a2 2 0 0 1 2 2v10H4V8a2 2 0 0 1 2-2",
  analytics: "M5 19V9m5 10V5m5 14v-7m5 7V3",
  reports: "M6 3h9l3 3v15H6z M15 3v4h4 M9 12h6 M9 16h6",
  health: "M4 12h3l2-6 4 12 2-6h5",
  inbox: "M4 5h16v14H4z M4 9h5l1.5 2h3L15 9h5",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
  database: "M5 5c0-2 14-2 14 0v14c0 2-14 2-14 0z M5 5c0 2 14 2 14 0 M5 12c0 2 14 2 14 0",
  brain: "M12 5a3 3 0 0 0-3 3 2.5 2.5 0 0 0-1 4.8V16a3 3 0 0 0 4 2.8 3 3 0 0 0 4-2.8v-3.2A2.5 2.5 0 0 0 15 8a3 3 0 0 0-3-3 M12 5v14",
  // A sparkle. This was a speech bubble with three dots in it, which was wrong twice over: the arcs
  // never closed cleanly against the tail so it read as a lopsided blob, and a chat bubble beside an
  // Inbox tab says "messages" rather than "ask this anything". The sparkle is the one glyph everyone
  // already reads as an assistant, and nothing else in the rail is round-and-pointed.
  mcp: "M11 4c0 3.9 3.1 7 7 7-3.9 0-7 3.1-7 7 0-3.9-3.1-7-7-7 3.9 0 7-3.1 7-7z M19 15c0 1.7 1.3 3 3 3-1.7 0-3 1.3-3 3 0-1.7-1.3-3-3-3 1.7 0 3-1.3 3-3z",
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
  /**
   * Whether the navigation is showing on a phone.
   *
   * Under 760px the rail becomes a fixed drawer parked off the left edge, and until now nothing
   * rendered the control that brings it back — the stylesheet had the whole slide-in written for a
   * `sidebar-open` class that no component ever set, so on a phone the navigation was simply gone.
   *
   * Only the drawer reads this. Above 760px the toggle and the scrim are `display:none`, which
   * keeps them out of `.app-shell`'s flex layout entirely rather than merely invisible.
   */
  const [navOpen, setNavOpen] = useState(false);
  /**
   * Whether the rail is currently a drawer rather than a docked column.
   *
   * This exists so the collapsed state can be ignored on a phone. Collapsing is a desktop
   * affordance — it trades labels for width in a column you can always see — and `sidebar-collapsed`
   * drives a dozen rules including a `font-size:0` trick for the client names. Undoing those inside
   * a media query would mean re-listing every one and re-listing it again whenever one changed, so
   * the class is simply not applied down here.
   *
   * Starts false so the server render and the first client render agree; the media query is only
   * consulted after mount. Desktop never matches, so the class logic there is exactly what it was.
   */
  const [drawerLayout, setDrawerLayout] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setDrawerLayout(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const [sidebarClients, setSidebarClients] = useState<Array<{ name: string; slug: string; tone: string; logoUrl?: string }>>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [clientsLoading, setClientsLoading] = useState(true);
  // The dashboard is where you go to pick something, so the nav is open; everywhere else you
  // are already working in the page and the nav is out of the way. Each context remembers its
  // own toggle, so choosing otherwise on a working page does not reopen it on every page.
  const home = pathname === "/";
  const collapseKey = home
    ? "reply-radar-sidebar:home"
    : "reply-radar-sidebar:page";
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return !home;
    const stored = window.localStorage.getItem(collapseKey);
    return stored ? stored === "collapsed" : !home;
  });
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
    // Navigating between pages does not remount this, so the new context's default has to be
    // re-read rather than inherited from the page we came from.
    const stored = window.localStorage.getItem(collapseKey);
    setCollapsed(stored ? stored === "collapsed" : !home);
  }, [collapseKey, home]);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    // Written here rather than in an effect so a route change cannot save the previous
    // page's state against the new page's key.
    window.localStorage.setItem(
      collapseKey,
      next ? "collapsed" : "expanded",
    );
  };
  return (
    <>
      {/*
        The phone navigation control, and the tap-anywhere-else layer behind the open drawer.
        Both sit outside the <aside> on purpose: the aside is translated off-screen when closed, so
        anything inside it goes with it and could never be used to reopen it.
      */}
      <button
        className="rr-nav-toggle"
        onClick={() => setNavOpen(true)}
        aria-label="Open navigation"
        aria-expanded={navOpen}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <button
        className={`rr-nav-scrim ${navOpen ? "rr-nav-scrim-shown" : ""}`}
        onClick={() => setNavOpen(false)}
        aria-label="Close navigation"
        tabIndex={navOpen ? 0 : -1}
      />
      <aside
        className={`sidebar app-sidebar ${collapsed && !drawerLayout ? "sidebar-collapsed" : ""} ${navOpen ? "sidebar-open" : ""}`}
      >
      <div className="brand-row">
        <Link
          href="/"
          className="brand-name"
          style={{ textDecoration: "none", color: "inherit" }}
          onClick={() => setNavOpen(false)}
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
        {/*
          Collapse belongs to the desktop rail — on a phone the drawer is either open or gone, and a
          72px collapsed drawer is not a state anyone wants. Hidden under 760px, where the button
          beside it closes the drawer instead.
        */}
        <button
          className="sidebar-collapse"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "→" : "←"}
        </button>
        <button
          className="rr-nav-dismiss"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        >
          ✕
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
        {[...sidebarClients].filter((client) => client.name).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map((client) => (
          <a className={`client-directory-item ${selectedClient === client.slug ? "selected" : ""}`} href={`/inbox?client=${client.slug}`} key={client.slug} title={client.name} aria-label={`Open ${client.name} inbox`}>
            <i style={client.logoUrl ? undefined : { background: client.tone }}>{client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name[0]}</i>{client.name}
          </a>
        ))}
      </div>
      </aside>
    </>
  );
}
