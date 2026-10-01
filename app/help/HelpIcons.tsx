// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Icons for the Help center.
 *
 * Pages use the sidebar's own glyphs, so "Inbox" in Help looks like Inbox in the rail. Each article
 * also gets a topic icon picked from its title and keywords (a tag for tagging, a handset for calls, a
 * shield for blocking), so a long list can be scanned by shape. Kinds get their own: a book for
 * walkthroughs, a speech bubble for FAQ, a wrench for fixes, a lifebuoy for support.
 */

import { iconPaths, NAV_ITEMS } from "../components/AppSidebar";
import { NavIcon } from "../components/NavIcon";
import type { HelpArticle, HelpKind } from "../lib/help-shared";

const TOPIC: Record<string, string> = {
  tag: "M3 12V4h8l9 9-8 8z M7.5 7.5h.01",
  send: "M4 12l16-8-6 16-3-7z M11 13l9-9",
  sliders: "M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  upload: "M12 16V4 M7 9l5-5 5 5 M4 20h16",
  download: "M12 4v12 M7 11l5 5 5-5 M4 20h16",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4",
  chat: "M4 5h16v11H9l-5 4z M8 10.5h.01 M12 10.5h.01 M16 10.5h.01",
  key: "M15 4a5 5 0 1 1-4.6 7H8v3H5v3H3v-5l7.4-5A5 5 0 0 1 15 4z M16 8h.01",
  palette: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4-4-7.5-9-7.5z M7.5 11h.01 M10 7h.01 M15 7h.01",
  gauge: "M4 18a8 8 0 1 1 16 0 M12 18l4-6",
  smile: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 14s1.5 2 4 2 4-2 4-2 M9 9h.01 M15 9h.01",
  alert: "M12 3l10 18H2z M12 10v5 M12 18h.01",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  pen: "M4 20h4L19 9l-4-4L4 16z M14 6l4 4",
  trash: "M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13",
  mobile: "M8 3h8v18H8z M11 18h2",
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M15.5 8.5l-2 5-5 2 2-5z",
  layers: "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
  doc: iconPaths.reports,
  phone: iconPaths.phone,
  calendar: iconPaths.calendar,
  sparkle: iconPaths.mcp,
  chart: iconPaths.analytics,
  users: iconPaths.profiles,
  brain: iconPaths.brain,
};

const KIND_PATHS: Record<HelpKind, string> = {
  walkthrough: "M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z M4 20V5 M8 7h7",
  faq: "M4 5h16v11H9l-5 4z M10 8.8a2 2 0 1 1 2.6 1.9c-.4.1-.6.4-.6.8v.5 M12 14h.01",
  troubleshooting: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  support: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M5.6 5.6l3.6 3.6 M14.8 14.8l3.6 3.6 M18.4 5.6l-3.6 3.6 M9.2 14.8l-3.6 3.6",
};

/** Topic rules, first match wins. Tested against the title, then the keywords. */
const RULES: Array<[RegExp, string]> = [
  [/your phone|mobile/i, "mobile"],
  [/\btags?\b|dq/i, "tag"],
  [/follow-?ups?/i, "clock"],
  [/time zone|date|this week/i, "calendar"],
  [/sentiment/i, "smile"],
  [/score|tier/i, "gauge"],
  [/draft|send|unsend|reply didn/i, "send"],
  [/filter|search/i, "sliders"],
  [/export|download/i, "download"],
  [/csv|import|upload|attach|documents/i, "upload"],
  [/block|deleted|do not contact|dnc/i, "shield"],
  [/script/i, "doc"],
  [/call analysis/i, "chat"],
  [/call|phone|enrich/i, "phone"],
  [/qc bot|bot|brief/i, "chat"],
  [/prompt|ai\b|model|assistant|mcp/i, "sparkle"],
  [/granola|key/i, "key"],
  [/appearance|looks/i, "palette"],
  [/feedback|bug/i, "alert"],
  [/log|audit|health/i, "list"],
  [/template|checklist|writing|edit/i, "pen"],
  [/remov/i, "trash"],
  [/graph|analytics|numbers/i, "chart"],
  [/report/i, "doc"],
  [/view|group/i, "layers"],
  [/profile|teammate|inbox/i, "users"],
  [/brain|icp/i, "brain"],
  [/getting around|navigate/i, "compass"],
];

const pageIconName = (page: string) => NAV_ITEMS.find(([href]) => href === page)?.[2] ?? "";

export function pagePath(page: string): string {
  const name = pageIconName(page);
  return name ? iconPaths[name] : TOPIC.compass;
}

export function topicPath(article: Pick<HelpArticle, "title" | "keywords" | "page" | "kind">): string {
  for (const [rule, name] of RULES) if (rule.test(article.title)) return TOPIC[name];
  const words = article.keywords.join(" ");
  for (const [rule, name] of RULES) if (rule.test(words)) return TOPIC[name];
  return article.page ? pagePath(article.page) : KIND_PATHS[article.kind];
}

/** A page's icon, the same duotone one the sidebar shows. */
export function PageIcon({ path, size = 16 }: { path: string; size?: number }) {
  const name = pageIconName(path);
  return name ? <NavIcon name={name} size={size} /> : <Glyph d={TOPIC.compass} size={size} />;
}

export const kindPath = (kind: HelpKind) => KIND_PATHS[kind];

export function Glyph({ d, size = 16, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} style={{ width: size, height: size, flex: "none" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export const SEARCH_PATH = "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4";
export const HOME_PATH = "M4 11l8-7 8 7 M6 9.5V20h12V9.5";
export const ARROW_PATH = "M5 12h14 M13 6l6 6-6 6";
export const EXPAND_PATH = "M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5";
