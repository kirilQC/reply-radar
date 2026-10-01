// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The sidebar's icons, in the "duotone" style Kiril picked: Lucide line icons (MIT licence,
 * https://lucide.dev) with a soft fill in the same colour, so each has body without getting heavy. The
 * fill comes from CSS (.nav-icon) so it brightens with the active page. Shared with the Help center so a
 * page looks the same everywhere it is named.
 */

type IconNode = Array<[string, Record<string, string | number>]>;

/** Keyed by the sidebar's icon names (NAV_ITEMS). Shapes copied from lucide@0.460.0. */
export const NAV_ICON_NODES: Record<string, IconNode> = {"dashboard":[["rect",{"width":"7","height":"9","x":"3","y":"3","rx":"1"}],["rect",{"width":"7","height":"5","x":"14","y":"3","rx":"1"}],["rect",{"width":"7","height":"9","x":"14","y":"12","rx":"1"}],["rect",{"width":"7","height":"5","x":"3","y":"16","rx":"1"}]],"inbox":[["polyline",{"points":"22 12 16 12 14 15 10 15 8 12 2 12"}],["path",{"d":"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"}]],"database":[["ellipse",{"cx":"12","cy":"5","rx":"9","ry":"3"}],["path",{"d":"M3 5V19A9 3 0 0 0 21 19V5"}],["path",{"d":"M3 12A9 3 0 0 0 21 12"}]],"profiles":[["path",{"d":"M18 21a8 8 0 0 0-16 0"}],["circle",{"cx":"10","cy":"8","r":"5"}],["path",{"d":"M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"}]],"calendar":[["path",{"d":"M8 2v4"}],["path",{"d":"M16 2v4"}],["rect",{"width":"18","height":"18","x":"3","y":"4","rx":"2"}],["path",{"d":"M3 10h18"}],["path",{"d":"m9 16 2 2 4-4"}]],"phone":[["path",{"d":"M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"}],["path",{"d":"M14.05 2a9 9 0 0 1 8 7.94"}],["path",{"d":"M14.05 6A5 5 0 0 1 18 10"}]],"project":[["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2"}],["path",{"d":"M8 7v7"}],["path",{"d":"M12 7v4"}],["path",{"d":"M16 7v9"}]],"deals":[["path",{"d":"m11 17 2 2a1 1 0 1 0 3-3"}],["path",{"d":"m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"}],["path",{"d":"m21 3 1 11h-2"}],["path",{"d":"M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"}],["path",{"d":"M3 4h8"}]],"onboarding":[["path",{"d":"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"}],["path",{"d":"m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"}],["path",{"d":"M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"}],["path",{"d":"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"}]],"jev":[["path",{"d":"M3 6h18"}],["path",{"d":"M7 12h10"}],["path",{"d":"M10 18h4"}]],"analytics":[["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M18 17V9"}],["path",{"d":"M13 17V5"}],["path",{"d":"M8 17v-3"}]],"reports":[["path",{"d":"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"}],["path",{"d":"M14 2v4a2 2 0 0 0 2 2h4"}],["path",{"d":"M10 9H8"}],["path",{"d":"M16 13H8"}],["path",{"d":"M16 17H8"}]],"mcp":[["path",{"d":"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"}],["path",{"d":"M20 3v4"}],["path",{"d":"M22 5h-4"}],["path",{"d":"M4 17v2"}],["path",{"d":"M5 18H3"}]],"brain":[["path",{"d":"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"}],["path",{"d":"M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"}],["path",{"d":"M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"}],["path",{"d":"M17.599 6.5a3 3 0 0 0 .399-1.375"}],["path",{"d":"M6.003 5.125A3 3 0 0 0 6.401 6.5"}],["path",{"d":"M3.477 10.896a4 4 0 0 1 .585-.396"}],["path",{"d":"M19.938 10.5a4 4 0 0 1 .585.396"}],["path",{"d":"M6 18a4 4 0 0 1-1.967-.516"}],["path",{"d":"M19.967 17.484A4 4 0 0 1 18 18"}]],"slack":[["line",{"x1":"4","x2":"20","y1":"9","y2":"9"}],["line",{"x1":"4","x2":"20","y1":"15","y2":"15"}],["line",{"x1":"10","x2":"8","y1":"3","y2":"21"}],["line",{"x1":"16","x2":"14","y1":"3","y2":"21"}]],"health":[["path",{"d":"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"}]],"settings":[["path",{"d":"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"}],["circle",{"cx":"12","cy":"12","r":"3"}]],"help":[["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"}],["path",{"d":"M12 17h.01"}]]};

export function NavIcon({ name, size = 17, className = "" }: { name: string; size?: number; className?: string }) {
  const node = NAV_ICON_NODES[name] ?? NAV_ICON_NODES.dashboard;
  return (
    <svg
      className={`nav-icon ${className}`}
      width={size}
      height={size}
      style={{ width: size, height: size, flex: "none" }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {node.map(([tag, attrs], index) => {
        const Tag = tag as "path";
        return <Tag key={index} {...(attrs as Record<string, string>)} />;
      })}
    </svg>
  );
}
