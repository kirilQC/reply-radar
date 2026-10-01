// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Help center's shape, shared by the page, the API and the assistant tool. No server imports, so the
 * client page can use it directly.
 */

export type HelpKind = "walkthrough" | "faq" | "troubleshooting" | "support";

export type HelpArticle = {
  id: string;
  kind: HelpKind;
  title: string;
  /** Markdown. The steps, the answer, or the fix. */
  body: string;
  /** A Loom share link. Optional; shown as an embedded player on the page and linked by the bot. */
  loomUrl: string;
  /** Screenshots served from public/help/, shown under the video. */
  images?: HelpImage[];
  /** Shipped with the app (app/lib/help-defaults.ts) rather than written in the editor. */
  builtIn?: boolean;
  /** The app page this article is about, e.g. "/inbox". Empty for general articles. */
  page: string;
  /** Extra words people might search with ("dq", "tag", "disqualify") that are not in the title. */
  keywords: string[];
  order: number;
  updatedAt: string;
};

export type HelpImage = { src: string; caption: string };

export const HELP_KINDS: { key: HelpKind; label: string; blurb: string }[] = [
  { key: "walkthrough", label: "Walkthroughs", blurb: "Step-by-step guides to each part of QC Command." },
  { key: "faq", label: "FAQ", blurb: "Quick answers to common questions." },
  { key: "troubleshooting", label: "Troubleshooting", blurb: "When something looks wrong, start here." },
  { key: "support", label: "Support", blurb: "Who to ask and how to get help." },
];

/** The pages an article can be about. Mirrors the sidebar. */
export const HELP_PAGES: { path: string; label: string }[] = [
  { path: "/", label: "Dashboard" },
  { path: "/inbox", label: "Inbox" },
  { path: "/database", label: "Database" },
  { path: "/profiles", label: "Profiles" },
  { path: "/meetings", label: "Meetings" },
  { path: "/cold-calling", label: "Cold calling" },
  { path: "/project-management", label: "Project management" },
  { path: "/deals", label: "Deals" },
  { path: "/onboarding", label: "Onboarding" },
  { path: "/jev", label: "Jev" },
  { path: "/analytics", label: "Analytics" },
  { path: "/reports", label: "Reports" },
  { path: "/mcp", label: "MCP" },
  { path: "/qc-brain", label: "QC Brain" },
  { path: "/slack", label: "Slack" },
  { path: "/health", label: "System health" },
  { path: "/admin", label: "Configuration" },
];

export const pageLabel = (path: string) => HELP_PAGES.find((page) => page.path === path)?.label ?? "";

/**
 * A Loom share link as its embeddable player URL, or "" if it is not a Loom link.
 * loom.com/share/<id> and loom.com/embed/<id> both become loom.com/embed/<id>.
 */
export function loomEmbedUrl(url: string): string {
  const match = String(url ?? "").match(/loom\.com\/(?:share|embed)\/([a-zA-Z0-9]+)/);
  return match ? `https://www.loom.com/embed/${match[1]}` : "";
}
