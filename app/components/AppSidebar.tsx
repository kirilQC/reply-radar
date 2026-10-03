// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { BrandIcon, BrandWordmark } from "./BrandMark";
import HelpMascot from "./HelpMascot";
import { NavIcon } from "./NavIcon";

export const NAV_ITEMS = [
  ["/", "Dashboard", "dashboard"],
  ["/inbox", "Inbox", "inbox"],
  ["/database", "Database", "database"],
  ["/profiles", "Profiles", "profiles"],
  // In the order the work happens: a reply becomes a booked call, a call becomes pipeline, and a won
  // deal becomes a client to get live. Analytics and reporting sit after all of it because they are
  // what you read once it has happened.
  ["/meetings", "Meetings", "calendar"],
  ["/cold-calling", "Cold calling", "phone"],
  ["/project-management", "Project management", "project"],
  ["/deals", "Deals", "deals"],
  ["/onboarding", "Onboarding", "onboarding"],
  // Before a campaign launches: checking the contact list it will be sent to.
  ["/jev", "Jev", "jev"],
  ["/analytics", "Analytics", "analytics"],
  ["/reports", "Reports", "reports"],
  ["/scout", "Scout", "mcp"],
  ["/qc-brain", "QC Brain", "brain"],
  ["/slack", "Slack", "slack"],
  ["/health", "System health", "health"],
  ["/admin", "Configuration", "settings"],
  ["/help", "Help", "help"],
] as const;
export const iconPaths: Record<string, string> = {
  dashboard: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  profiles: "M16 20a4 4 0 0 0-8 0 M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  calendar: "M5 4v3m14-3v3M4 9h16M6 6h12a2 2 0 0 1 2 2v10H4V8a2 2 0 0 1 2-2",
  analytics: "M5 19V9m5 10V5m5 14v-7m5 7V3",
  reports: "M6 3h9l3 3v15H6z M15 3v4h4 M9 12h6 M9 16h6",
  health: "M4 12h3l2-6 4 12 2-6h5",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.3-2.5 3.9 M12 17h.01",
  inbox: "M4 5h16v14H4z M4 9h5l1.5 2h3L15 9h5",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7",
  database: "M5 5c0-2 14-2 14 0v14c0 2-14 2-14 0z M5 5c0 2 14 2 14 0 M5 12c0 2 14 2 14 0",
  brain: "M12 5a3 3 0 0 0-3 3 2.5 2.5 0 0 0-1 4.8V16a3 3 0 0 0 4 2.8 3 3 0 0 0 4-2.8v-3.2A2.5 2.5 0 0 0 15 8a3 3 0 0 0-3-3 M12 5v14",
  // A sparkle. This was a speech bubble with three dots in it, which was wrong twice over: the arcs
  // never closed cleanly against the tail so it read as a lopsided blob, and a chat bubble beside an
  // Inbox tab says "messages" rather than "ask this anything". The sparkle is the one glyph everyone
  // already reads as an assistant, and nothing else in the rail is round-and-pointed.
  mcp: "M11 4c0 3.9 3.1 7 7 7-3.9 0-7 3.1-7 7 0-3.9-3.1-7-7-7 3.9 0 7-3.1 7-7z M19 15c0 1.7 1.3 3 3 3-1.7 0-3 1.3-3 3 0-1.7-1.3-3-3-3 1.7 0 3-1.3 3-3z",
  // A funnel, because a deal is a stage in one. Not a currency symbol: the tab is about where each
  // conversation has got to, and the amount is one column of that rather than the point of it.
  deals: "M4 5h16l-6 7v6l-4-2v-4z",
  // A handset. The tab is a call list, and a phone is the one glyph that reads as "make calls" instantly.
  phone: "M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  // A kanban board — three columns — the universal shorthand for project management.
  project: "M4 4h4v16H4z M10 4h4v10h-4z M16 4h4v13h-4z",
  // Ascending steps — a sequence to walk a client through. Three 6-unit steps rather than four 4-unit
  // ones: at the 16px this renders at, 4 units is under 3px and the whole thing collapsed into what
  // looked like a plain diagonal line. Still distinct from the analytics bars beside it because it is
  // one connected polyline rather than four separate uprights.
  onboarding: "M4 20h6v-6h6v-6h4",
  // A funnel of rows narrowing to a tick — a list going in, only the good fits coming out.
  jev: "M4 5h16 M6 10h12 M9 15h6 M10 19l2 2 4-4",
  // A channel hash. Slack's own mark is four rounded bars in a pinwheel, which is theirs and needs
  // fills this rail does not use; `#` is how everyone writes a Slack channel anyway.
  slack: "M9 4v16M15 4v16M4 9h16M4 15h16",
};

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
  // Starts empty, exactly as the server rendered it, and the cached list is applied in a layout effect
  // (before the first paint). Reading localStorage in the initializer made the browser's first render
  // differ from the server's on every page, which React reports as a hydration error (#418) and answers by
  // throwing away the server HTML and redrawing everything.
  const [sidebarClients, setSidebarClients] = useState<Array<{ name: string; slug: string; tone: string; logoUrl?: string }>>([]);
  // Two writers share this cache (this sidebar and the Configuration page) with slightly different
  // shapes, so whatever is read is put into the sidebar's own shape first.
  const fromCache = (saved: string) =>
    (JSON.parse(saved) as Array<Record<string, unknown>>).map((item) => ({
      name: String(item.name ?? ""),
      slug: String(item.slug ?? ""),
      tone: String(item.tone ?? item.accentColor ?? item.accent_color ?? "var(--accent)"),
      logoUrl: String(item.logoUrl ?? item.logo_url ?? "") || undefined,
    }));
  useLayoutEffect(() => {
    try {
      const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setSidebarClients(fromCache(saved));
    } catch { /* keep the empty list until the fetch lands */ }
  }, []);
  const [clientsLoading, setClientsLoading] = useState(true);
  // The dashboard is where you go to pick something, so the nav is open; everywhere else you
  // are already working in the page and the nav is out of the way. Each context remembers its
  // own toggle, so choosing otherwise on a working page does not reopen it on every page.
  const home = pathname === "/";
  // Wide, work-heavy tabs (cold calling, project management) each get their own collapse key so they stay
  // collapsed by default — they need the width — instead of inheriting the shared "page" key.
  const collapseKey = home
    ? "reply-radar-sidebar:home"
    : pathname.startsWith("/cold-calling")
      ? "reply-radar-sidebar:cold-calling"
      : pathname.startsWith("/project-management")
        ? "reply-radar-sidebar:project-management"
        : "reply-radar-sidebar:page";
  // Help always opens with the rail folded: the article list is its own navigation, and the reading
  // column wants every pixel. It can still be expanded for the visit; it just doesn't stay that way.
  const forceCollapsed = pathname.startsWith("/help");
  // The server's answer first (it cannot see the stored choice); the stored choice is applied before paint
  // by the layout effect below.
  const [collapsed, setCollapsed] = useState(() => forceCollapsed || !home);
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
          // Guarded on its own: a full or blocked store throwing here used to fall into the catch below,
          // which then painted the stale cache over the fresh list that had just been set.
          // When the list changed (a client added, renamed or offboarded elsewhere), pages that drew from
          // the cache are told to read it again, so an offboarded client does not linger on them.
          let changed = false;
          try { changed = window.localStorage.getItem("reply-radar-workspaces:v2") !== JSON.stringify(fresh); } catch { /* unreadable store */ }
          try { window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(fresh)); } catch { /* cache is optional */ }
          if (changed) window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
          setClientsLoading(false);
          return;
        }
      } catch { /* use the offline cache */ }
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (saved) setSidebarClients(fromCache(saved));
      } catch { /* keep empty state */ }
      setClientsLoading(false);
    };
    void hydrate();
    const onStorage = () => {
      try { const saved = window.localStorage.getItem("reply-radar-workspaces:v2"); if (saved) setSidebarClients(fromCache(saved)); } catch { /* ignore */ }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("reply-radar-workspaces-changed", onStorage);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("reply-radar-workspaces-changed", onStorage); };
  }, []);
  useLayoutEffect(() => {
    // Navigating between pages does not remount this, so the new context's default has to be
    // re-read rather than inherited from the page we came from. A layout effect, so the stored choice is
    // on screen before the first paint.
    if (forceCollapsed) { setCollapsed(true); return; }
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(collapseKey); } catch { /* storage blocked: use the default */ }
    setCollapsed(stored ? stored === "collapsed" : !home);
  }, [collapseKey, home, forceCollapsed]);
  // Marks the few hundred milliseconds of a real collapse/expand, so the logo's crossfade runs then and
  // never on a plain page load.
  const [railAnim, setRailAnim] = useState(false);
  const railAnimTimer = useRef<number | undefined>(undefined);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    setRailAnim(true);
    window.clearTimeout(railAnimTimer.current);
    railAnimTimer.current = window.setTimeout(() => setRailAnim(false), 450);
    // Written here rather than in an effect so a route change cannot save the previous
    // page's state against the new page's key.
    if (forceCollapsed) return;
    try { window.localStorage.setItem(collapseKey, next ? "collapsed" : "expanded"); } catch { /* storage blocked */ }
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
        data-rail-anim={railAnim ? "" : undefined}
      >
      <div className="brand-row">
        {/*
          On the desktop rail the logo is the collapse control: one click folds the rail to icons, the
          next opens it again. In the phone drawer, which has no collapsed state, it still goes home.
        */}
        {drawerLayout ? (
          <Link
            href="/"
            className="brand-name"
            style={{ textDecoration: "none", color: "inherit" }}
            onClick={() => setNavOpen(false)}
          >
            <span className="brand-mark brand-mark-grid">
              <BrandIcon size={22} />
            </span>{" "}
            <span className="sidebar-label">
              <BrandWordmark height={21} />
            </span>
          </Link>
        ) : (
          <button
            type="button"
            className="brand-name brand-toggle"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <span className="brand-mark brand-mark-grid">
              <BrandIcon size={22} />
            </span>{" "}
            <span className="sidebar-label">
              <BrandWordmark height={21} />
            </span>
          </button>
        )}
        <button
          className="rr-nav-dismiss"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        >
          ✕
        </button>
      </div>
      {/*
        `Link`, not `<a href>`. These were plain anchors, which meant every tab switch was a full
        document navigation: the entire bundle re-downloaded and re-parsed, React remounted from
        nothing, and every page's fetches restarted cold — several seconds of blank screen to move
        between two pages that were both already loaded once. Link transitions on the client and
        prefetches the target, so the switch is immediate.

        Each of these goes to a different pathname, which is what makes it safe: the destination
        component still mounts fresh, so the pages that read `window.location.search` in a
        mount-only effect (this file, page.tsx, analytics) read the new URL exactly as before.
        The client links below are deliberately *not* converted — they only change `?client=`, and
        on a same-pathname transition those effects would not re-run.
      */}
      <nav>
        {NAV_ITEMS.map(([href, label, icon]) => {
          // A tab stays lit on its nested routes too — /deals/[slug], /onboarding/[slug],
          // /qc-brain/[client], /meetings/[slug] — not just an exact match. Dashboard ("/") is
          // exact-only, since every path starts with "/".
          const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
          return (
          <Link
            key={href}
            href={href}
            className={`nav-item ${active ? "active" : ""}`}
            onClick={() => setNavOpen(false)}
          >
            <span className={`sidebar-icon ${href === "/scout" ? "sidebar-icon-scout" : ""}`}>
              {href === "/scout" ? <HelpMascot size={20} /> : <NavIcon name={icon} />}
            </span>
            <span>{label}</span>
          </Link>
          );
        })}
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
