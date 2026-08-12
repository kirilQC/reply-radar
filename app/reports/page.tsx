"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import {
  BUILT_IN_TEMPLATES,
  CAMPAIGN_METRICS,
  DEFAULT_CAMPAIGN_METRICS,
  isWrittenSection,
  OUTPUT_LABELS,
  PAGE_LIMIT,
  SECTION_LABELS,
  SECTIONS,
  WRITTEN_SECTION_PROMPTS,
  type CampaignMetricId,
  type ReportOutput,
  type ReportPeriod as Period,
  type ReportTemplate,
  type SectionId,
  type WrittenSectionId,
} from "../lib/report-templates";
import { packPages, paginate, suggestTrim } from "../../shared/report-pagination.mjs";
import "./reports.css";

type Workspace = { id: string; slug: string; name: string; logo_url?: string; accent_color?: string; timezone?: string };

/**
 * What the archive needs to draw a row. The heavy columns are deliberately not listed.
 *
 * `workspace_id` and `template_id` are here because the whole archive is fetched once and then sliced
 * locally — by client for the directory counts, and by template for the "last run" date on each card.
 * Those are two cheap groupings over a list that is already in memory, not two more round trips.
 */
type SavedReport = {
  id: string;
  workspace_id: string | null;
  workspace_name: string;
  template_id: string;
  template_name: string;
  title: string;
  period_label: string;
  page_estimate: number | null;
  generated_by: string | null;
  generated_at: string;
};

/** The copy Claude wrote: a headline for the page, the PDF narrative, and the message to send. */
type Composed = { headline: string; narrative: string; message: string };

/**
 * A campaign as HeyReach reports it, once the pending-lead rule has been applied.
 *
 * "Active" here means live *and* still feeding new leads into the sequence. HeyReach keeps a campaign
 * in progress while leads already in the sequence finish their steps, which is not the same thing —
 * see `app/lib/heyreach-campaigns.ts`.
 */
type LiveCampaign = {
  id: string;
  name: string;
  status: string;
  state: string;
  launchedAt: string;
  progress: { listSize: number; pending: number; contacted: number };
  /** LinkedIn accounts assigned to send it. Zero means HeyReach did not say. */
  senders: number;
  /** Pending leads ÷ daily capacity. Null when the sender count is unknown, never a guess. */
  daysLeftInSending: number | null;
};

type CampaignStatusBlock = {
  available: boolean;
  reason: string;
  fetchedAt: string;
  active: LiveCampaign[];
  workedThrough: LiveCampaign[];
  scheduled: LiveCampaign[];
  paused: LiveCampaign[];
  activeWithoutReplies: LiveCampaign[];
  total: number;
  unrecognised: string[];
};

type ClientReport = {
  workspace: { id: string; slug: string; name: string; logoUrl: string; accentColor: string; website: string; clientBrief: string; timezone: string };
  summary: {
    totalReplies: number;
    positiveReplies: number;
    neutralReplies: number;
    negativeReplies: number;
    unclassifiedReplies: number;
    positiveRate: number;
    avgRepliesPerDay: number;
    bestCampaign: string;
    bestSender: string;
    hotCount: number;
    topIcpCount: number;
    /** Null when HeyReach could not be reached — which is not the same as zero. */
    activeCampaigns: number | null;
    scheduledCampaigns: number | null;
    silentActiveCampaigns: number | null;
  };
  /**
   * The outbound funnel for the campaigns this report names, joined to our replies.
   *
   * `available: false` is a real state, not a zero — it means HeyReach could not be asked, and every
   * rate below it has to be printed as unknown rather than as 0%.
   */
  metrics: {
    available: boolean;
    reason: string;
    campaignCount: number;
    connectionsSent: number;
    connectionsAccepted: number;
    acceptanceRate: number;
    replies: number;
    positiveReplies: number;
    leadsReplied: number;
    replyRate: number;
    positiveReplyRate: number;
    campaigns: Array<{ campaignId: string; name: string; connectionsSent: number; connectionsAccepted: number; acceptanceRate: number }>;
  };
  sentiment: { positive: number; neutral: number; negative: number; unclassified: number };
  campaigns: Array<{
    name: string;
    replies: number;
    positive: number;
    negative: number;
    positiveRate: number;
    state: string;
    status: string;
    active: boolean;
  }>;
  campaignStatus: CampaignStatusBlock;
  senders: Array<{ name: string; replies: number; positive: number; positiveRate: number }>;
  topLeads: Array<{ id: string; name: string; role: string; company: string; icpScore: number; icpReason: string; profileUrl: string }>;
  icpBuckets: { excellent: number; strong: number; moderate: number; weak: number };
  hotConversations: Array<{ leadName: string; role: string; company: string; sentAt: string; urgency: number; snippet: string; campaign: string }>;
  sampleReplies: Array<{ leadName: string; role: string; company: string; sentAt: string; body: string; campaign: string; senderName: string }>;
  /** The five strongest replies, for quoting. Deliberately without campaign, sender or score. */
  bestReplies: Array<{ leadName: string; role: string; company: string; sentAt: string; body: string }>;
  replyTiming: number[];
  trend: Array<{ day: string; replies: number }>;
};

type ReportData = {
  ok: boolean;
  period: Period;
  periodLabel: string;
  since: string | null;
  until: string | null;
  generatedAt: string;
  clients: ClientReport[];
};

/**
 * What "Build your own" starts with: a selection that already fits in three pages.
 *
 * The previous default ticked eleven sections, which is what produced a ten-page PDF — so the default
 * now has to be inside the limit, or the page meter greets everyone with a warning.
 */
const DEFAULT_SECTIONS: SectionId[] = [
  "cover",
  "executive-summary",
  "kpis",
  "trend",
  "campaigns",
  "senders",
  "top-leads",
  "methodology",
];

/** The template id a build-your-own report is filed under, so its card can report a last-run date too. */
const BUILD_YOUR_OWN_ID = "build-your-own";

/**
 * Plain English for each campaign state.
 *
 * "Worked through" is the one that matters: HeyReach still calls those campaigns in progress, but with
 * no leads left to contact they are finished as far as a client is concerned.
 */
const CAMPAIGN_STATE_LABELS: Record<string, string> = {
  active: "Active",
  "worked-through": "Worked through",
  scheduled: "Scheduled",
  paused: "Paused",
  closed: "Closed",
  draft: "Draft",
  unknown: "Unknown",
};

/**
 * Applies the one per-run section choice to a layout.
 *
 * Done to the layout rather than at render time so that the page count, the page meter, the printed
 * document and the copy filed in the archive cannot disagree about whether the section is in the report.
 */
const applySectionChoices = (layout: SectionId[][], includeBestReplies: boolean) =>
  includeBestReplies
    ? layout
    : layout.map((page) => page.filter((id) => id !== "best-replies")).filter((page) => page.length);

const PERIOD_OPTIONS: Period[] = ["daily", "weekly", "monthly", "quarterly", "all-time", "custom"];
const periodLabel = (value: Period) => (value === "all-time" ? "All time" : value[0].toUpperCase() + value.slice(1));

const formatDate = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(value));
const formatShort = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(value));
const num = (value: number) => Math.round(value).toLocaleString();
const pct = (value: number) => `${value.toFixed(1)}%`;

export default function ReportsPage() {
  /**
   * Three screens, in the order the work happens: pick the client, pick the report, read the report.
   *
   * Choosing the client first is what makes the rest of the page honest. A template card can say when
   * that report was last run and the archive can show only what that client has been sent, neither of
   * which means anything until the page knows who it is talking about.
   */
  const [view, setView] = useState<"clients" | "hub" | "builder">("clients");
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>(BUILT_IN_TEMPLATES);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [savedWarning, setSavedWarning] = useState("");

  // Authoring a template: a name and a prompt, which is all a template really is.
  const [composerOpen, setComposerOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftPeriod, setDraftPeriod] = useState<Period>("monthly");
  // Email first, because the reports the agency sends most often are emails.
  const [draftOutput, setDraftOutput] = useState<ReportOutput>("email");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateError, setTemplateError] = useState("");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceSlug, setWorkspaceSlug] = useState<string>("");
  const [period, setPeriod] = useState<Period>("monthly");
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  const [sections, setSections] = useState<Set<SectionId>>(new Set(DEFAULT_SECTIONS));
  const [preparedBy, setPreparedBy] = useState("QC Growth");
  const [reportTitle, setReportTitle] = useState("Outbound Reply Report");
  const [notes, setNotes] = useState("");
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  /**
   * The campaigns HeyReach says this client has, and which of them the report may mention.
   *
   * Fetched when the builder opens rather than after generating, so the document, the write-up and the
   * archived copy are all about the same set of campaigns. Active ones are ticked to begin with —
   * that is the report almost everybody wants — and anything else is there to be opted into.
   */
  const [liveCampaigns, setLiveCampaigns] = useState<LiveCampaign[]>([]);
  const [campaignPick, setCampaignPick] = useState<Set<string>>(new Set());
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsNote, setCampaignsNote] = useState("");

  /**
   * The template's prompt, editable for this run only.
   *
   * Nearly all of what makes one report different from another lives in the prompt, so the config
   * screen puts it on the page rather than behind an edit-the-template detour. Changing it here does
   * not save it — a tweak for one client's week should not silently rewrite the template everybody
   * else is running.
   */
  const [runPrompt, setRunPrompt] = useState("");

  /**
   * The sections the account manager writes, which the app has no way to know: meetings booked, why a
   * campaign was paused, what happens next. Kept as one record keyed by section id so adding a written
   * section is a matter of listing it in WRITTEN_SECTIONS.
   */
  const [written, setWritten] = useState<Record<string, string>>({});

  /**
   * Whether the multi-page document is on screen.
   *
   * An email template does not render one until asked. The sections are still laid out and still hold
   * the numbers — that is what makes "Generate PDF" instant rather than a second trip to the server —
   * but showing three pages of charts under a recap email implies the client is getting both.
   */
  const [docRevealed, setDocRevealed] = useState(false);

  /**
   * Whether the quoted replies are in this report.
   *
   * The one pulled section that is a judgement call rather than a fact: five replies read as proof in a
   * good week and as thin in a quiet one, so it is a tick rather than part of the template. Dropping it
   * takes it out of the pages, the email and the archived copy together — a section that is only half
   * removed is worse than one that is not.
   */
  const [includeBestReplies, setIncludeBestReplies] = useState(true);

  /**
   * What each campaign line is allowed to say about itself.
   *
   * Sits with the campaign checkboxes because it is the second half of the same question: which
   * campaigns the client hears about, and what they hear about each. A week where a list is nearly
   * exhausted wants the sending runway on the line; a quiet week wants replies and nothing else.
   */
  const [campaignMetrics, setCampaignMetrics] = useState<Set<CampaignMetricId>>(
    () => new Set(DEFAULT_CAMPAIGN_METRICS),
  );
  const toggleMetric = (id: CampaignMetricId) =>
    setCampaignMetrics((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /**
   * Which of the panel's foldable blocks are open.
   *
   * The panel had every control expanded at once, so the two things somebody actually touches every time
   * — the campaigns and their own sections — were separated by a 200px prompt box and three cover-page
   * fields nobody edits twice. The prompt still matters, which is why it is one click away rather than
   * gone; it is just not the first thing you scroll past.
   */
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set(["campaigns"]));
  const toggleFold = (id: string) =>
    setOpenFolds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [composed, setComposed] = useState<Composed | null>(null);
  const [messageText, setMessageText] = useState("");
  const [composing, setComposing] = useState(false);

  /**
   * The written sections as they stood when the email was last written, as a JSON string.
   *
   * The document needs nothing from the model to stay current — `WrittenSection` prints `written`
   * verbatim, so the pages change as fast as typing. The email is the opposite: the sections are folded
   * into its bullets, so it is out of date the moment one of them changes, and comparing against this is
   * how the page knows.
   */
  const [composedFrom, setComposedFrom] = useState("");

  /**
   * Whether the email has been edited by hand since it was written.
   *
   * Once it has, nothing rewrites it without being asked. Silently replacing a paragraph somebody typed
   * because they then fixed a typo in the recap box would be the worst kind of helpful.
   */
  const [messageEdited, setMessageEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");

  const refreshSaved = useCallback(async () => {
    try {
      const response = await fetch("/api/reports/saved", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      setSaved(Array.isArray(payload.reports) ? (payload.reports as SavedReport[]) : []);
      setSavedWarning(typeof payload.warning === "string" ? payload.warning : "");
    } catch {
      setSaved([]);
    }
  }, []);

  const refreshTemplates = useCallback(async () => {
    try {
      const response = await fetch("/api/reports/templates", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      // The route always returns at least the built-ins, so an empty array means something went wrong
      // and the existing list is the better thing to keep on screen.
      if (Array.isArray(payload.templates) && payload.templates.length) {
        setTemplates(payload.templates as ReportTemplate[]);
      }
    } catch {
      /* keep whatever is already listed */
    }
  }, []);

  useEffect(() => {
    // No client is preselected: the directory is the landing screen, and quietly defaulting to
    // whichever client sorts first would make every "last run" date on the next screen belong to
    // someone the reader never chose.
    const load = async () => {
      const workspaceResponse = await fetch("/api/admin/workspaces", { cache: "no-store" }).catch(() => null);
      const payload = workspaceResponse ? await workspaceResponse.json().catch(() => ({})) : {};
      if (Array.isArray(payload.workspaces)) setWorkspaces(payload.workspaces as Workspace[]);
      await Promise.allSettled([refreshTemplates(), refreshSaved()]);
    };
    load();
  }, [refreshSaved, refreshTemplates]);

  /**
   * Asks HeyReach what this client is running. Selection defaults to the active campaigns, so someone
   * who never touches the list still gets the honest answer to "what is live?".
   */
  const loadCampaigns = useCallback(async (slug: string) => {
    if (!slug) return;
    setCampaignsLoading(true);
    setCampaignsNote("");
    try {
      const response = await fetch(`/api/reports/campaigns?workspace=${encodeURIComponent(slug)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not read the campaign list.");
      const clients = Array.isArray(payload.clients) ? (payload.clients as Array<Record<string, unknown>>) : [];
      const rows = clients.flatMap((row) => (Array.isArray(row.campaigns) ? (row.campaigns as LiveCampaign[]) : []));
      setLiveCampaigns(rows);
      setCampaignPick(new Set(rows.filter((row) => row.state === "active").map((row) => row.id)));
      const unavailable = clients.filter((row) => !row.available);
      setCampaignsNote(
        unavailable.length
          ? `HeyReach did not answer for ${unavailable.length === clients.length ? "this client" : `${unavailable.length} of ${clients.length} clients`}: ${String(unavailable[0]?.reason || "unknown reason")}`
          : "",
      );
    } catch (err) {
      setLiveCampaigns([]);
      setCampaignPick(new Set());
      setCampaignsNote(err instanceof Error ? err.message : "Could not read the campaign list.");
    } finally {
      setCampaignsLoading(false);
    }
  }, []);

  const toggleCampaign = (id: string) => {
    setCampaignPick((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Campaigns belong to one client, so changing client has to drop them rather than carry them over. */
  const clearCampaigns = () => {
    setLiveCampaigns([]);
    setCampaignPick(new Set());
    setCampaignsNote("");
  };

  const toggleSection = (id: SectionId) => {
    if (SECTIONS.find((section) => section.id === id)?.alwaysOn) return;
    setSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** Opening anything clears the last report, so the canvas never shows one report under another's title. */
  const resetOutput = () => {
    setReport(null);
    setComposed(null);
    setMessageText("");
    setSavedNotice("");
    setSavedLayout(null);
    setDocRevealed(false);
    setComposedFrom("");
    setMessageEdited(false);
    setError("");
  };

  const openTemplate = (chosen: ReportTemplate) => {
    resetOutput();
    setTemplate(chosen);
    setPeriod(chosen.defaultPeriod);
    setReportTitle(chosen.name);
    setRunPrompt(chosen.prompt);
    // Boxes start empty rather than carrying over what was typed for the last client, which would be
    // the worst possible default: last week's recap sent under this week's numbers.
    setWritten({});
    setView("builder");
    loadCampaigns(workspaceSlug);
  };

  const openBuilder = () => {
    resetOutput();
    setTemplate(null);
    setReportTitle("Outbound Reply Report");
    setRunPrompt("");
    setWritten({});
    setView("builder");
    loadCampaigns(workspaceSlug);
  };

  const openClient = (slug: string) => {
    resetOutput();
    setWorkspaceSlug(slug);
    setComposerOpen(false);
    setTemplateError("");
    clearCampaigns();
    setView("hub");
  };

  const backToClients = () => {
    resetOutput();
    setWorkspaceSlug("");
    setComposerOpen(false);
    clearCampaigns();
    setView("clients");
  };

  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [workspaces],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((row) => row.slug === workspaceSlug) ?? null,
    [workspaces, workspaceSlug],
  );

  const clientLabel = workspaceSlug === "all" ? "All clients" : activeWorkspace?.name || "";

  /**
   * The archive, narrowed to the client on screen.
   *
   * A combined report belongs to no single client, so it is stored with a null workspace id — which
   * makes "All clients" a real filter rather than the absence of one. Without that, the combined view
   * would list every client's individual reports alongside its own.
   */
  const clientReports = useMemo(
    () =>
      saved.filter((row) =>
        workspaceSlug === "all" ? !row.workspace_id : Boolean(activeWorkspace) && row.workspace_id === activeWorkspace?.id,
      ),
    [saved, workspaceSlug, activeWorkspace],
  );

  /** When each template was last run for this client — the answer to "have we sent this already?". */
  const lastRunByTemplate = useMemo(() => {
    const latest = new Map<string, string>();
    for (const row of clientReports) {
      const current = latest.get(row.template_id);
      if (!current || row.generated_at > current) latest.set(row.template_id, row.generated_at);
    }
    return latest;
  }, [clientReports]);

  const reportCountFor = useCallback(
    (workspace: Workspace) => saved.filter((row) => row.workspace_id === workspace.id).length,
    [saved],
  );

  const saveTemplate = async () => {
    const name = draftName.trim();
    const prompt = draftPrompt.trim();
    if (!name || !prompt) {
      setTemplateError("A template needs a name and a prompt.");
      return;
    }
    setTemplateBusy(true);
    setTemplateError("");
    try {
      const response = await fetch("/api/reports/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          summary: draftSummary.trim(),
          prompt,
          defaultPeriod: draftPeriod,
          output: draftOutput,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save the template.");
      await refreshTemplates();
      setComposerOpen(false);
      setDraftName("");
      setDraftSummary("");
      setDraftPrompt("");
      setDraftOutput("email");
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : "Could not save the template.");
    } finally {
      setTemplateBusy(false);
    }
  };

  /** Templates are shared, so deleting one takes it away from everybody. Hence the confirm. */
  const deleteTemplate = async (chosen: ReportTemplate) => {
    if (!window.confirm(`Delete the "${chosen.name}" template for everyone? Reports already saved from it are kept.`))
      return;
    setTemplateBusy(true);
    setTemplateError("");
    try {
      const response = await fetch(`/api/reports/templates?id=${encodeURIComponent(chosen.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not delete the template.");
      await refreshTemplates();
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : "Could not delete the template.");
    } finally {
      setTemplateBusy(false);
    }
  };

  /**
   * The page layout of the document currently on screen.
   *
   * A template states its own pages, which is what guarantees it cannot exceed the limit. "Build your
   * own" has no such declaration, so its layout is computed from section weights — the same numbers the
   * page meter reports, so the meter and the document can never disagree.
   */
  const orderedSections = useMemo(
    () => SECTIONS.filter((section) => sections.has(section.id)).map((section) => section.id),
    [sections],
  );
  // A reopened report carries the layout it was filed with, which must win over anything recomputed:
  // that layout is part of what the client was sent.
  const [savedLayout, setSavedLayout] = useState<SectionId[][] | null>(null);
  const pages: SectionId[][] = useMemo(
    () =>
      // A reopened report keeps its filed layout untouched — the tick on this screen decides what the next
      // report contains, not what a report already sent to a client turns out to have contained.
      savedLayout ??
      applySectionChoices(template ? template.pages : packPages(orderedSections), includeBestReplies),
    [savedLayout, template, orderedSections, includeBestReplies],
  );
  /**
   * The boxes to put on the config screen: one per written section the chosen layout actually prints.
   *
   * Derived from the layout rather than listed by hand, so a template that does not include a warm
   * close never asks for one — and a template that does gets the box without any code being touched.
   */
  const writtenFields = useMemo(() => pages.flat().filter(isWrittenSection), [pages]);

  /**
   * The deliverable. Build-your-own is a document by definition — it is a section picker.
   *
   * A reopened report always shows its pages: it is history, and the archive's job is to show what was
   * produced rather than to re-litigate which half of it was the deliverable.
   */
  const outputMode: ReportOutput = savedLayout ? "pdf" : (template?.output ?? "pdf");
  const showDocument = outputMode === "pdf" || docRevealed;

  const budget = useMemo(() => paginate(orderedSections), [orderedSections]);
  // Only a live build-your-own selection can be over the limit. A template is capped by construction,
  // and a report already sent to a client is history — refusing to reprint it would be absurd.
  const overLimit = !template && !savedLayout && !budget.withinLimit;
  const trimAdvice = useMemo(() => (overLimit ? suggestTrim(orderedSections) : []), [overLimit, orderedSections]);

  /**
   * Files the report in Supabase, artifacts and numbers together.
   *
   * The data snapshot goes in alongside the message and the CSV so that reopening it years later
   * renders exactly what the client saw, even after the underlying replies have been purged or
   * re-scored. Nothing about a saved report is ever recomputed.
   *
   * Everything is passed in rather than read from state. This runs at the tail of `generate`, before
   * React has re-rendered with the report it just fetched, so the state still holds the *previous*
   * report — reading it here would file the wrong document under the right name.
   */
  const fileReport = useCallback(
    async (data: ReportData, copy: Composed | null, layout: SectionId[][], sectionIds: SectionId[]) => {
      setSaving(true);
      try {
        const response = await fetch("/api/reports/saved", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspaceId: workspaceSlug === "all" ? "" : activeWorkspace?.id || "",
            workspaceName: workspaceSlug === "all" ? "All clients" : data.clients[0]?.workspace.name || "",
            templateId: template?.id || BUILD_YOUR_OWN_ID,
            templateName: template?.name || "Build your own",
            title: reportTitle,
            period: data.period,
            periodLabel: data.periodLabel,
            sections: sectionIds,
            messageText: copy?.message || "",
            csvText: buildCsv(data),
            // `written` and `prompt` are part of the document, not settings: reopening a report has to
            // show the recap the client actually read, and the prompt explains why the copy reads as
            // it does even after the template has been edited since.
            data: { report: data, pages: layout, reportTitle, preparedBy, notes, written, prompt: runPrompt, composed: copy },
            pageEstimate: layout.length,
            generatedBy: preparedBy,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save the report.");
        setSavedNotice("Saved to the archive.");
        refreshSaved();
      } catch (err) {
        // Kept out of `error`, which may already be carrying a warning about the write-up. Losing the
        // archive copy is worth saying plainly, but it does not invalidate the report on screen.
        setSavedNotice(`Not archived: ${err instanceof Error ? err.message : "the save failed."}`);
      } finally {
        setSaving(false);
      }
    },
    [workspaceSlug, activeWorkspace, template, reportTitle, preparedBy, notes, written, runPrompt, refreshSaved],
  );

  /**
   * Everything the email is written from, as one string.
   *
   * The typed boxes and the per-run choices together, because a choice changes the email as surely as a
   * box does. With only the boxes in here, unticking a metric redrew the document's campaign table and
   * left the email describing those campaigns the old way — and the two stayed at odds until somebody
   * happened to type something.
   */
  const runSignature = useCallback(
    (sections: Record<string, string>) =>
      JSON.stringify({ sections, metrics: [...campaignMetrics].sort(), includeBestReplies }),
    [campaignMetrics, includeBestReplies],
  );

  /**
   * Writes the headline, the narrative and the email from a report and the account manager's sections.
   *
   * Everything it needs is an argument. It runs both at the tail of `generate`, before React has
   * re-rendered with the report just fetched, and from the live refresh below — so reading `report` out
   * of state here would sometimes compose against the previous one.
   */
  const composeCopy = useCallback(
    async (data: ReportData, sections: Record<string, string>, chosen: ReportTemplate): Promise<Composed | null> => {
      const signature = runSignature(sections);
      setComposing(true);
      try {
        const response = await fetch("/api/reports/compose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // The prompt as it stands on the config screen, not as the template stores it.
            prompt: runPrompt.trim() || chosen.prompt,
            templateId: chosen.id,
            periodLabel: data.periodLabel,
            clients: data.clients,
            // What the account manager typed. Treated as fact by the writer, and the reason the message
            // can mention a booked meeting that appears in no table.
            written: sections,
            // The quotes are lifted from the report by the route, not written by the model, so all it
            // needs to know is whether they are wanted.
            includeBestReplies,
            // Same arrangement for the campaign lines: the route has the figures, this says which of
            // them the client is to see.
            campaignMetrics: [...campaignMetrics],
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) {
          // The report itself is valid and on screen; only the copy failed. Saying so beats replacing a
          // working document with an error, and it still gets archived — without the write-up.
          setError(`The email could not be written: ${payload.error || response.status}. The report itself is fine.`);
          return null;
        }
        const copy: Composed = {
          headline: String(payload.headline || ""),
          narrative: String(payload.narrative || ""),
          message: String(payload.message || ""),
        };
        setComposed(copy);
        setMessageText(copy.message);
        setMessageEdited(false);
        setError("");

        /**
         * The first and last lines of the email, filled into their boxes.
         *
         * Nobody wants to draft a greeting from nothing, and nobody wants software to own the first
         * sentence the client reads — so the model writes both ends, they land in the boxes, and from
         * that moment the boxes are what get printed. Anything already typed is never overwritten.
         *
         * The staleness signature has to be recorded against the seeded sections, not the ones sent, or
         * filling these boxes would immediately look like a change the account manager made and kick off
         * another rewrite of the email that was just written.
         */
        const seeds: Array<[string, string]> = [
          ["intro", String(payload.greeting || "").trim()],
          ["warm-close", String(payload.close || "").trim()],
        ];
        const fill = Object.fromEntries(seeds.filter(([id, value]) => value && !sections[id]?.trim()));
        if (Object.keys(fill).length) {
          setWritten((current) => ({
            ...current,
            ...Object.fromEntries(Object.entries(fill).filter(([id]) => !current[id]?.trim())),
          }));
          setComposedFrom(runSignature({ ...sections, ...fill }));
        } else {
          setComposedFrom(signature);
        }
        return copy;
      } catch (err) {
        setError(`The email could not be written: ${err instanceof Error ? err.message : "the request failed"}.`);
        return null;
      } finally {
        setComposing(false);
      }
    },
    [runPrompt, includeBestReplies, campaignMetrics, runSignature],
  );

  const generate = useCallback(async () => {
    if (!workspaceSlug) {
      setError("Pick a client first.");
      return;
    }
    setLoading(true);
    setError("");
    setSavedNotice("");
    // A new pull is a new document, so it must not inherit the layout of a report reopened from the
    // archive — the rendered pages and the filed pages have to be the same thing.
    setSavedLayout(null);
    const layout = applySectionChoices(template ? template.pages : packPages(orderedSections), includeBestReplies);
    try {
      const response = await fetch("/api/reports/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceSlug,
          period,
          since: period === "custom" ? customSince : undefined,
          until: period === "custom" ? customUntil : undefined,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          // Sent whenever the list was readable, even when nothing is ticked: an empty array is the
          // user saying "no campaigns", which is not the same as never having been asked.
          campaignIds: liveCampaigns.length ? [...campaignPick] : undefined,
        }),
      });
      const payload = (await response.json()) as ReportData & { error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Report generation failed");
      setReport(payload);

      // Only a template carries a prompt, so only a template gets written copy. Build-your-own keeps
      // the deterministic summary that is computed from the numbers.
      const copy = template ? await composeCopy(payload, written, template) : null;

      // Archived without being asked. Generating a client report is the act of record; making that
      // durable should not depend on remembering to press a second button afterwards.
      await fileReport(payload, copy, layout, orderedSections);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setLoading(false);
    }
  }, [
    workspaceSlug,
    period,
    customSince,
    customUntil,
    template,
    orderedSections,
    fileReport,
    liveCampaigns,
    campaignPick,
    composeCopy,
    written,
    includeBestReplies,
  ]);

  /**
   * Keeps the email in step with the sections as they are typed.
   *
   * Debounced, because every keystroke in the recap box would otherwise be a request. A hand-edited
   * email is left alone — the banner in the compose panel offers a rewrite instead, so discarding
   * somebody's wording is always their decision.
   */
  const writtenKey = useMemo(() => runSignature(written), [runSignature, written]);
  const emailStale = Boolean(report && template && composed) && writtenKey !== composedFrom;

  useEffect(() => {
    if (!emailStale || messageEdited || composing || loading || !report || !template) return;
    const timer = setTimeout(() => {
      composeCopy(report, written, template);
    }, 1500);
    return () => clearTimeout(timer);
  }, [emailStale, messageEdited, composing, loading, report, template, written, composeCopy]);

  const downloadPdf = () => {
    if (!report || overLimit) return;
    window.print();
  };

  const downloadCsv = () => {
    if (!report) return;
    const blob = new Blob([buildCsv(report)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.clients[0]?.workspace.slug || "report"}-${report.period}-${report.generatedAt.slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /** Reopens a filed report from its snapshot. Read-only in spirit: nothing is regenerated. */
  const openSaved = async (id: string) => {
    resetOutput();
    try {
      const response = await fetch(`/api/reports/saved?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "That report could not be opened.");
      const row = payload.report as Record<string, unknown>;
      const snapshot = (row.data || {}) as Record<string, unknown>;
      const storedReport = snapshot.report as ReportData | undefined;
      if (!storedReport) throw new Error("That report was saved without its data snapshot.");

      setTemplate(null);
      setReport(storedReport);
      setReportTitle(String(snapshot.reportTitle || row.title || "Report"));
      setPreparedBy(String(snapshot.preparedBy || row.generated_by || "QC Growth"));
      setNotes(String(snapshot.notes || ""));
      // Restored from the snapshot rather than left blank: the recap and the close are the halves of
      // the report the client actually read, and a reopened report without them is a different document.
      setWritten(
        snapshot.written && typeof snapshot.written === "object" && !Array.isArray(snapshot.written)
          ? (snapshot.written as Record<string, string>)
          : {},
      );
      setRunPrompt(String(snapshot.prompt || ""));
      setSections(new Set((Array.isArray(row.sections) ? row.sections : []) as SectionId[]));
      setSavedLayout(Array.isArray(snapshot.pages) ? (snapshot.pages as SectionId[][]) : null);
      const storedCopy = snapshot.composed as Composed | null | undefined;
      if (storedCopy) {
        setComposed(storedCopy);
        setMessageText(String(row.message_text || storedCopy.message || ""));
      }
      setView("builder");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That report could not be opened.");
    }
  };

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area reports-main">
        <header className="topbar print-hide">
          <div className="crumb">
            <span>Reply Radar</span>
            <strong>› Reports</strong>
          </div>
          <div className="top-actions">
            <GlobalAppearanceControl />
          </div>
        </header>

        {view === "clients" ? (
          <main className="reports-hub print-hide">
            <div className="hub-lede">
              <h1>Reports</h1>
            </div>

            <div className="hub-group-label">
              <span>Client workspaces</span>
              <span>{sortedWorkspaces.length === 1 ? "1 client" : `${sortedWorkspaces.length} clients`}</span>
            </div>
            <div className="client-grid">
              {sortedWorkspaces.map((workspace) => {
                const count = reportCountFor(workspace);
                return (
                  <button
                    key={workspace.slug}
                    type="button"
                    className="client-card"
                    onClick={() => openClient(workspace.slug)}
                  >
                    <i style={workspace.logo_url ? undefined : { background: workspace.accent_color || "var(--report-brand)" }}>
                      {workspace.logo_url ? <img src={workspace.logo_url} alt="" /> : workspace.name.slice(0, 1).toUpperCase()}
                    </i>
                    <h3>{workspace.name}</h3>
                    <small>{count ? `${count} report${count === 1 ? "" : "s"}` : "No reports yet"}</small>
                  </button>
                );
              })}
              <button type="button" className="client-card client-card-all" onClick={() => openClient("all")}>
                <i>∑</i>
                <h3>All clients</h3>
                <small>Combined across every workspace</small>
              </button>
            </div>

            {!sortedWorkspaces.length && (
              <div className="hub-empty">
                No client workspaces yet. Add one in the admin console and it will appear here.
              </div>
            )}
            {error && <div className="config-error">{error}</div>}
          </main>
        ) : view === "hub" ? (
          <main className="reports-hub print-hide">
            <button type="button" className="config-back" onClick={backToClients}>
              ← All clients
            </button>
            <div className="hub-lede">
              <h1>{clientLabel}</h1>
            </div>

            <div className="hub-group-label">
              <span>Templates</span>
              <button
                type="button"
                className="hub-add"
                onClick={() => {
                  setComposerOpen((open) => !open);
                  setTemplateError("");
                }}
              >
                {composerOpen ? "Cancel" : "+ Add template"}
              </button>
            </div>

            {composerOpen && (
              <div className="hub-composer">
                <p className="hub-composer-note">
                  A template is a prompt. The numbers always come from the data — the prompt decides what the
                  write-up emphasises, who it is addressed to, and how the message reads. Templates are shared, so
                  one saved here shows up for everyone.
                </p>

                <label className="config-label" htmlFor="template-name">
                  Template name
                </label>
                <input
                  id="template-name"
                  className="config-input"
                  placeholder="e.g. Monthly performance recap"
                  maxLength={80}
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                />

                <label className="config-label" htmlFor="template-summary">
                  One-line description
                </label>
                <input
                  id="template-summary"
                  className="config-input"
                  placeholder="Optional. Shown on the card."
                  maxLength={200}
                  value={draftSummary}
                  onChange={(event) => setDraftSummary(event.target.value)}
                />

                <label className="config-label" htmlFor="template-output">
                  What does it produce?
                </label>
                <select
                  id="template-output"
                  className="config-select"
                  value={draftOutput}
                  onChange={(event) => setDraftOutput(event.target.value as ReportOutput)}
                >
                  <option value="email">An email to send</option>
                  <option value="pdf">A PDF document</option>
                </select>
                <p className="config-hint">
                  {draftOutput === "email"
                    ? "You get the written email. The pages are still built behind it, so a PDF is one button away when you want one."
                    : "You get the multi-page document, with a short covering email to send it with."}
                </p>

                <label className="config-label" htmlFor="template-period">
                  Default period
                </label>
                <select
                  id="template-period"
                  className="config-select"
                  value={draftPeriod}
                  onChange={(event) => setDraftPeriod(event.target.value as Period)}
                >
                  {PERIOD_OPTIONS.filter((option) => option !== "custom").map((option) => (
                    <option key={option} value={option}>
                      {periodLabel(option)}
                    </option>
                  ))}
                </select>

                <label className="config-label" htmlFor="template-prompt">
                  Prompt
                </label>
                <textarea
                  id="template-prompt"
                  className="config-textarea hub-composer-prompt"
                  placeholder="What is this report for, and who reads it? Say what to lead with, what to emphasise, and how long the message should be."
                  value={draftPrompt}
                  onChange={(event) => setDraftPrompt(event.target.value)}
                />

                <button
                  className="config-generate"
                  onClick={saveTemplate}
                  disabled={templateBusy || !draftName.trim() || !draftPrompt.trim()}
                >
                  {templateBusy ? "Saving…" : "Save template"}
                </button>
              </div>
            )}
            {templateError && <div className="config-error">{templateError}</div>}

            <div className="hub-card-grid">
              {templates.map((option) => {
                const lastRun = lastRunByTemplate.get(option.id);
                return (
                  <div key={option.id} className="hub-card">
                    {/* The card is a container rather than a button so the delete control can sit beside the
                        open control instead of nested inside it, which no browser would accept. */}
                    <button type="button" className="hub-card-open" onClick={() => openTemplate(option)}>
                      <h3>{option.name}</h3>
                      <p>{option.summary || "No description."}</p>
                      <div className="hub-card-meta">
                        <b>{lastRun ? `Last run ${formatDate(lastRun)}` : "Never run"}</b>
                        <span>·</span>
                        <span>{periodLabel(option.defaultPeriod)}</span>
                        <span>·</span>
                        {/* Page count is only meaningful for a document. An email template has pages
                            behind it, but printing them is not what the template is for. */}
                        <span>
                          {option.output === "email"
                            ? OUTPUT_LABELS.email
                            : option.pages.length === 1
                              ? "1 page"
                              : `${option.pages.length} pages`}
                        </span>
                      </div>
                    </button>
                    {!option.builtIn && (
                      <button
                        type="button"
                        className="hub-card-delete"
                        disabled={templateBusy}
                        title={`Delete the ${option.name} template`}
                        aria-label={`Delete the ${option.name} template`}
                        onClick={() => deleteTemplate(option)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}

              <div className="hub-card hub-card-custom">
                <button type="button" className="hub-card-open" onClick={openBuilder}>
                  <h3>Build your own report</h3>
                  <p>
                    Pick the sections yourself. The page count is tracked as you go, so you can see when a selection
                    stops fitting.
                  </p>
                  <div className="hub-card-meta">
                    <b>
                      {lastRunByTemplate.has(BUILD_YOUR_OWN_ID)
                        ? `Last run ${formatDate(lastRunByTemplate.get(BUILD_YOUR_OWN_ID) as string)}`
                        : "Never run"}
                    </b>
                    <span>·</span>
                    <span>Up to {PAGE_LIMIT} pages</span>
                    <span>·</span>
                    <span>{SECTIONS.length} sections</span>
                  </div>
                </button>
              </div>
            </div>

            <div className="hub-group-label">
              <span>Past reports</span>
              <span>{clientReports.length ? `${clientReports.length} on file` : "nothing yet"}</span>
            </div>
            {clientReports.length ? (
              <div className="hub-saved-list">
                {clientReports.map((row) => (
                  <button key={row.id} type="button" className="hub-saved-row" onClick={() => openSaved(row.id)}>
                    <span>
                      <strong>{row.title}</strong>
                      <small>{row.template_name}</small>
                    </span>
                    <span>{row.period_label}</span>
                    <span>{row.page_estimate ? `${row.page_estimate}p` : "—"}</span>
                    <time dateTime={row.generated_at}>{formatDate(row.generated_at)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <div className="hub-empty">
                {savedWarning ? (
                  <>
                    Saved reports are unavailable: {savedWarning}. If the table has not been created yet, run{" "}
                    <code>supabase/migrations/20260812_rr_reports.sql</code>.
                  </>
                ) : (
                  "Every report generated is filed here automatically, with the exact numbers it was built from — so one a client has already seen always reopens showing what it showed on the day it was sent."
                )}
              </div>
            )}

            {error && <div className="config-error">{error}</div>}
          </main>
        ) : (
        <main className="reports-shell">
          <aside className="reports-configurator print-hide">
            <button type="button" className="config-back" onClick={() => { resetOutput(); setView("hub"); }}>
              ← {clientLabel || "All clients"}
            </button>
            <div className="config-heading">
              <h2>{template ? template.name : "Build your own report"}</h2>
              {/* Only the builder gets a line of explanation, because only the builder has a rule that is
                  not obvious from the controls. A template's screen explaining itself was three lines of
                  reassurance above the thing it was describing. */}
              {!template && (
                <p>
                  Choose the sections you want. The report is capped at three pages, so heavier sections
                  cost more of the budget.
                </p>
              )}
            </div>

            {/*
              Neither the client nor the period is a decision left at this point.
              The client was chosen two screens ago and is named in the back link; the period is part of
              what a template is — a prompt written for "the entire engagement" must not be run over a
              Tuesday. So a template shows neither, and the builder, which has no template to answer
              them, shows the period.

              The date fields are the exception: a template whose period is a custom range still has to be
              told which range, and there is nowhere else to say it.
            */}
            {(!template || period === "custom") && (
              <div className="config-group">
                {!template && (
                  <>
                    <span className="config-label">Period</span>
                    <div className="config-period-grid">
                      {PERIOD_OPTIONS.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={`config-period ${period === option ? "is-active" : ""}`}
                          onClick={() => setPeriod(option)}
                        >
                          {periodLabel(option)}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {period === "custom" && (
                  <div className="config-custom-range">
                    <label>
                      From
                      <input type="date" value={customSince} onChange={(e) => setCustomSince(e.target.value)} />
                    </label>
                    <label>
                      To
                      <input type="date" value={customUntil} onChange={(e) => setCustomUntil(e.target.value)} />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* Which campaigns the report may talk about. Read from HeyReach on the way in, so the
                document, the write-up and the archived copy all describe the same set. */}
            <ConfigFold
              id="campaigns"
              label="Campaigns"
              note={
                campaignsLoading
                  ? "asking HeyReach…"
                  : liveCampaigns.length
                    ? `${campaignPick.size} of ${liveCampaigns.length} ticked`
                    : "none found"
              }
              open={openFolds.has("campaigns")}
              onToggle={toggleFold}
            >
              {campaignsLoading ? (
                <div className="config-static">Asking HeyReach…</div>
              ) : liveCampaigns.length ? (
                <div className="config-sections config-campaigns">
                  {liveCampaigns.map((row) => {
                    const on = campaignPick.has(row.id);
                    return (
                      <label key={row.id} className={`config-section ${on ? "is-on" : ""}`}>
                        <input type="checkbox" checked={on} onChange={() => toggleCampaign(row.id)} />
                        <span>
                          <strong>{row.name}</strong>
                          <em>
                            {CAMPAIGN_STATE_LABELS[row.state] || row.status || "Unknown"} ·{" "}
                            {row.progress.pending.toLocaleString()} pending ·{" "}
                            {row.progress.contacted.toLocaleString()} contacted
                            {/* Shown here as well as in the report because it is half of why a campaign
                                is worth mentioning: a list with two days left is news. */}
                            {row.daysLeftInSending !== null && ` · ${row.daysLeftInSending}d left`}
                          </em>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="config-static">{campaignsNote || "No campaigns found for this client."}</div>
              )}
              {liveCampaigns.length > 0 && campaignsNote && <div className="config-note">{campaignsNote}</div>}

              {/* What each of those campaigns is allowed to say about itself. Inside this fold because
                  it is the same decision continued — the campaigns, then the facts about them. */}
              {liveCampaigns.length > 0 && (
                <div className="config-metrics">
                  <span className="config-label">What each campaign line says</span>
                  <div className="config-metric-grid">
                    {CAMPAIGN_METRICS.map((metric) => (
                      <label
                        key={metric.id}
                        className={`config-chip ${campaignMetrics.has(metric.id) ? "is-on" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={campaignMetrics.has(metric.id)}
                          onChange={() => toggleMetric(metric.id)}
                        />
                        {metric.label}
                      </label>
                    ))}
                  </div>
                  <div className="config-note">
                    Days left is pending leads divided by daily capacity — senders × 25 requests a day. It is left off
                    a campaign HeyReach gives no senders for rather than guessed at.
                  </div>
                </div>
              )}
            </ConfigFold>

            {/* The one pulled section that is a choice. Pulled, so it sits with the campaigns rather than
                with the boxes below — nothing here is typed. */}
            {template && (
              <div className="config-group">
                <label className="config-toggle">
                  <input
                    type="checkbox"
                    checked={includeBestReplies}
                    onChange={() => setIncludeBestReplies((current) => !current)}
                  />
                  <span>
                    <strong>Best replies from this week</strong>
                    <em>The five strongest replies, quoted as written. Name, title, company, message.</em>
                  </span>
                </label>
              </div>
            )}

            {/* The half of the report the app cannot know. Booked meetings, why a campaign was paused,
                what was promised on a call — none of it is in HeyReach or in our tables, so it is asked
                for here and printed verbatim. The write-up is told to agree with it, not rewrite it. */}
            {writtenFields.length > 0 && (
              <div className="config-group">
                <span className="config-label">Your sections</span>
                {writtenFields.map((id) => (
                  <div key={id} className="config-written">
                    <label className="config-written-label" htmlFor={`written-${id}`}>
                      {WRITTEN_SECTION_PROMPTS[id].label}
                    </label>
                    <textarea
                      id={`written-${id}`}
                      className="config-textarea"
                      placeholder={WRITTEN_SECTION_PROMPTS[id].placeholder}
                      value={written[id] || ""}
                      onChange={(event) =>
                        setWritten((current) => ({ ...current, [id]: event.target.value }))
                      }
                    />
                  </div>
                ))}
                <p className="config-hint">
                  Printed as you type them. Anything left blank is left out of the report rather than
                  filled in for you.
                  {composed && " The email is rewritten to match a moment after you stop typing."}
                </p>
              </div>
            )}

            {/* Almost everything that makes one report read differently from another is in here, so it
                is on the page rather than behind an edit-the-template detour. Tweaks apply to this run
                only — the template everybody else runs is left alone. */}
            {template && (
              <ConfigFold
                id="prompt"
                label="Edit prompt"
                note={runPrompt.trim() === template.prompt.trim() ? "template default" : "edited for this run"}
                open={openFolds.has("prompt")}
                onToggle={toggleFold}
              >
                <textarea
                  id="run-prompt"
                  className="config-textarea config-prompt"
                  value={runPrompt}
                  onChange={(event) => setRunPrompt(event.target.value)}
                />
                <p className="config-hint">
                  {runPrompt.trim() === template.prompt.trim()
                    ? "The template's prompt. Edit it for this report without changing the template."
                    : "Edited for this report only. The saved template is unchanged."}
                </p>
              </ConfigFold>
            )}

            {/* Only ever seen on a printed page, so it does not belong open on an email report's screen. */}
            <ConfigFold
              id="cover"
              label="Cover page & notes"
              note={outputMode === "email" ? "PDF only" : reportTitle || "untitled"}
              open={openFolds.has("cover")}
              onToggle={toggleFold}
            >
              <input
                className="config-input"
                placeholder="Report title"
                value={reportTitle}
                onChange={(e) => setReportTitle(e.target.value)}
              />
              <input
                className="config-input"
                placeholder="Prepared by"
                value={preparedBy}
                onChange={(e) => setPreparedBy(e.target.value)}
              />
              <textarea
                className="config-textarea"
                placeholder="Optional note that appears at the end of the report (e.g. what to look at first)."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </ConfigFold>

            {template ? (
              // The layout is the template, so it is stated rather than offered — and stated once, in
              // passing, because this is a config screen for the last few decisions rather than a place
              // to rebuild the report.
              <p className="config-hint config-layout">
                {template.output === "email" ? "Produces an email" : "Produces a PDF"} from{" "}
                {template.pages.length === 1 ? "1 page" : `${template.pages.length} pages`}:{" "}
                {template.pages.map((page) => page.map((id) => SECTION_LABELS[id]).join(", ")).join(" / ")}.
                {template.output === "email" && " The pages are there if you want the PDF too."}
              </p>
            ) : (
              <div className="config-group">
                <span className="config-label">Sections</span>
                <div className="config-sections">
                  {SECTIONS.map((section) => {
                    const on = sections.has(section.id);
                    return (
                      <label
                        key={section.id}
                        className={`config-section ${on ? "is-on" : ""} ${section.alwaysOn ? "is-locked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={section.alwaysOn}
                          onChange={() => toggleSection(section.id)}
                        />
                        <span>
                          <strong>{section.label}</strong>
                          <em>{section.blurb}</em>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <div className="page-meter">
                  <div className="page-meter-top">
                    <span>Page budget</span>
                    <b>
                      {budget.pageCount} / {PAGE_LIMIT}
                    </b>
                  </div>
                  <div className="page-meter-track">
                    {Array.from({ length: Math.max(PAGE_LIMIT, budget.pageCount) }).map((_, index) => (
                      <i
                        key={index}
                        className={index >= PAGE_LIMIT ? "over" : index < budget.pageCount ? "filled" : ""}
                      />
                    ))}
                  </div>
                  {overLimit && (
                    <div className="page-meter-warning">
                      {budget.overflowPages === 1 ? "One page" : `${budget.overflowPages} pages`} over. Drop{" "}
                      {trimAdvice.map((id) => SECTION_LABELS[id]).join(" and ")} to fit.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Pinned to the foot of the panel rather than sitting at the end of it. The panel scrolls,
                and with a prompt box and four written sections in it the Generate button and the
                downloads were below the fold — you had to scroll a form you had finished to leave it. */}
            <div className="config-actions">
              <button className="config-generate" onClick={generate} disabled={loading || overLimit}>
                {loading ? "Generating…" : composing ? "Writing…" : report ? "Regenerate report" : "Generate report"}
              </button>

              {report && (
                <div className="config-downloads">
                  {/* Two clicks for an email report, deliberately. The first renders the pages so they can
                      be read before the print dialog opens over them. */}
                  {showDocument ? (
                    <button onClick={downloadPdf} disabled={overLimit}>
                      Download PDF
                    </button>
                  ) : (
                    <button onClick={() => setDocRevealed(true)}>Generate PDF</button>
                  )}
                  <button onClick={downloadCsv}>Download CSV</button>
                </div>
              )}
              {error && <div className="config-error">{error}</div>}
              {/* Archiving happens on its own, so this reports rather than asks. It still has to be
                  visible: a save that failed is the one case where the report on screen is the only copy. */}
              {(saving || savedNotice) && (
                <div className="config-note">{saving ? "Filing to the archive…" : savedNotice}</div>
              )}
            </div>
          </aside>

          <section className="reports-canvas">
            {/* Two panels announcing "Ready when you are." and "Generating…" were a lot of furniture for
                two states that need one line each. Waiting is the only one worth dwelling on, and a
                turning wheel says it better than a heading does. */}
            {!report && (
              <div className="reports-idle">
                {loading ? (
                  <>
                    <span className="reports-spinner" aria-hidden="true" />
                    <p role="status">Reading conversations, sentiment, campaigns and ICP scores…</p>
                  </>
                ) : (
                  <p>
                    {template
                      ? "Pick a client, then hit Generate."
                      : "Pick a client and a period, choose your sections, then hit Generate."}
                  </p>
                )}
              </div>
            )}

            {report && (composed || composing) && (
              /* Widened when the email is the deliverable rather than a covering note for a PDF — it is
                 the thing being read and edited, so it gets the room the document would have had. */
              <div className={`compose-panel print-hide ${showDocument ? "" : "is-primary"}`}>
                <header>
                  <h3>Email to send</h3>
                  <span className="compose-state">
                    {composing
                      ? "Rewriting from your sections…"
                      : messageEdited
                        ? "Edited by hand"
                        : emailStale
                          ? "Your sections changed"
                          : ""}
                  </span>
                </header>

                {/* The one case the debounce deliberately will not handle. An edited email is not
                    overwritten behind somebody's back, so catching up is offered rather than done. */}
                {emailStale && messageEdited && !composing && template && (
                  <div className="compose-stale">
                    <span>Your written sections have changed since this was written.</span>
                    <button type="button" onClick={() => composeCopy(report, written, template)}>
                      Rewrite it
                    </button>
                  </div>
                )}

                <textarea
                  value={messageText}
                  onChange={(event) => {
                    setMessageText(event.target.value);
                    setMessageEdited(true);
                  }}
                  placeholder={composing ? "Writing the summary and the email…" : "The email will appear here."}
                  aria-busy={composing}
                />
              </div>
            )}

            {report &&
              showDocument &&
              report.clients.map((client) => (
                <ReportDocument
                  key={client.workspace.id}
                  client={client}
                  report={report}
                  reportTitle={reportTitle}
                  preparedBy={preparedBy}
                  notes={notes}
                  pages={pages}
                  written={written}
                  campaignMetrics={campaignMetrics}
                  headline={composed?.headline || ""}
                  narrative={composed?.narrative || ""}
                />
              ))}
          </section>
        </main>
        )}
      </section>
    </div>
  );
}

/**
 * A block of the config panel that stays shut until it is wanted.
 *
 * `note` is what the block says about itself while closed — "4 of 15 ticked", "Edited for this run" —
 * so folding something away never means losing track of what it is set to.
 */
function ConfigFold({
  id,
  label,
  note,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  note?: string;
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`config-fold ${open ? "is-open" : ""}`}>
      <button type="button" className="config-fold-head" onClick={() => onToggle(id)} aria-expanded={open}>
        <span className="config-label">{label}</span>
        {note && <em>{note}</em>}
        <i aria-hidden="true">{open ? "−" : "+"}</i>
      </button>
      {open && <div className="config-fold-body">{children}</div>}
    </div>
  );
}

function csv(value: unknown) {
  const str = String(value ?? "").replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

/**
 * The CSV of everything behind the report, built once and used twice — the download and the copy that
 * gets filed with the saved report have to be the same bytes.
 */
function buildCsv(report: ReportData) {
  const lines: string[] = [];
  for (const client of report.clients) {
    lines.push(`# ${client.workspace.name} — ${report.periodLabel}`);
    lines.push("");
    lines.push("Summary");
    lines.push("Metric,Value");
    lines.push(`Total replies,${client.summary.totalReplies}`);
    lines.push(`Positive replies,${client.summary.positiveReplies}`);
    lines.push(`Neutral replies,${client.summary.neutralReplies}`);
    lines.push(`Negative replies,${client.summary.negativeReplies}`);
    lines.push(`Positive rate,${pct(client.summary.positiveRate)}`);
    lines.push(`Avg replies/day,${client.summary.avgRepliesPerDay.toFixed(2)}`);
    lines.push(`Hot conversations,${client.summary.hotCount}`);
    lines.push(`Top ICP leads (≥75),${client.summary.topIcpCount}`);
    lines.push("");
    // The funnel, with its denominators, so someone in a spreadsheet can rebuild every rate the PDF
    // prints instead of taking them on trust.
    lines.push("Outbound funnel (HeyReach, selected campaigns only)");
    if (client.metrics?.available) {
      lines.push("Metric,Value");
      lines.push(`Campaigns counted,${client.metrics.campaignCount}`);
      lines.push(`Connection requests sent,${client.metrics.connectionsSent}`);
      lines.push(`Connection requests accepted,${client.metrics.connectionsAccepted}`);
      lines.push(`Average acceptance rate,${pct(client.metrics.acceptanceRate)}`);
      lines.push(`Replies,${client.metrics.replies}`);
      lines.push(`Leads that replied,${client.metrics.leadsReplied}`);
      lines.push(`Reply rate (replies / accepted),${pct(client.metrics.replyRate)}`);
      lines.push(`Positive reply rate (positive / accepted),${pct(client.metrics.positiveReplyRate)}`);
      lines.push("");
      lines.push("Campaign,Requests sent,Requests accepted,Acceptance rate");
      for (const row of client.metrics.campaigns) {
        lines.push([csv(row.name), row.connectionsSent, row.connectionsAccepted, pct(row.acceptanceRate)].join(","));
      }
    } else {
      lines.push(`Unavailable,${csv(client.metrics?.reason || "HeyReach was not reachable")}`);
    }
    lines.push("");
    lines.push("Campaigns");
    lines.push("Campaign,Replies,Positive,Negative,Positive rate,HeyReach state");
    for (const row of client.campaigns) {
      lines.push(
        [csv(row.name), row.replies, row.positive, row.negative, `${row.positiveRate}%`, csv(row.state || "unknown")].join(","),
      );
    }
    lines.push("");
    // Straight from HeyReach rather than from replies, so the CSV can be checked against the platform.
    lines.push("Campaign status (HeyReach)");
    if (client.campaignStatus?.available) {
      lines.push("Campaign,State,HeyReach status,Launched,Leads on list,Leads pending,Leads contacted");
      const statusRows = [
        ...client.campaignStatus.active,
        ...client.campaignStatus.scheduled,
        ...client.campaignStatus.workedThrough,
        ...client.campaignStatus.paused,
      ];
      for (const row of statusRows) {
        lines.push(
          [
            csv(row.name),
            csv(row.state),
            csv(row.status),
            row.launchedAt ? row.launchedAt.slice(0, 10) : "",
            row.progress.listSize,
            row.progress.pending,
            row.progress.contacted,
          ].join(","),
        );
      }
    } else {
      lines.push(`Unavailable,${csv(client.campaignStatus?.reason || "HeyReach was not reachable")}`);
    }
    lines.push("");
    lines.push("Senders");
    lines.push("Sender,Replies,Positive,Positive rate");
    for (const row of client.senders) {
      lines.push([csv(row.name), row.replies, row.positive, `${row.positiveRate}%`].join(","));
    }
    lines.push("");
    lines.push("Top leads");
    lines.push("Lead,Role,Company,ICP score,Reason");
    for (const row of client.topLeads) {
      lines.push([csv(row.name), csv(row.role), csv(row.company), row.icpScore, csv(row.icpReason)].join(","));
    }
    lines.push("");
    lines.push("Hot conversations");
    lines.push("Lead,Role,Company,Campaign,Sent at,Urgency,Snippet");
    for (const row of client.hotConversations) {
      lines.push(
        [csv(row.leadName), csv(row.role), csv(row.company), csv(row.campaign), row.sentAt, row.urgency, csv(row.snippet)].join(","),
      );
    }
    lines.push("");
    lines.push("Reply trend");
    lines.push("Day,Replies");
    for (const row of client.trend) {
      lines.push([row.day, row.replies].join(","));
    }
    lines.push("");
  }
  return lines.join("\n");
}

const SECTION_TITLES: Record<SectionId, string> = {
  cover: "Cover",
  intro: "Intro",
  recap: "Recap",
  "executive-summary": "Executive summary",
  metrics: "Performance",
  kpis: "Headline KPIs",
  sentiment: "Sentiment breakdown",
  trend: "Reply trend",
  "active-campaigns": "Active campaigns",
  campaigns: "Campaign performance",
  "booked-meetings": "Booked meetings",
  "best-replies": "Best replies from this week",
  senders: "Sender leaderboard",
  "top-leads": "Top leads by ICP score",
  "icp-distribution": "ICP distribution",
  "hot-conversations": "Hot conversations",
  "reply-timing": "Reply timing",
  "sample-replies": "Sample positive replies",
  "what-we-did": "What we did this week",
  priorities: "Priorities for next week",
  "warm-close": "Where we are",
  methodology: "Methodology & notes",
};

/**
 * Renders one client's report as a fixed number of printed pages.
 *
 * The `pages` prop is the layout: one printed sheet per inner array. Sections used to render as
 * `.report-page` each, which is why eleven ticked boxes produced a thirteen-page PDF; they are now
 * blocks that stack inside a page, and the page count is decided before anything renders.
 */
function ReportDocument({
  client,
  report,
  reportTitle,
  preparedBy,
  notes,
  pages,
  written,
  campaignMetrics,
  headline,
  narrative,
}: {
  client: ClientReport;
  report: ReportData;
  reportTitle: string;
  preparedBy: string;
  notes: string;
  pages: SectionId[][];
  written: Record<string, string>;
  /** The same per-campaign choices the email obeys, so the table and the email cannot disagree. */
  campaignMetrics: Set<CampaignMetricId>;
  headline: string;
  narrative: string;
}) {
  const generated = formatDate(report.generatedAt, client.workspace.timezone);
  const flat = pages.flat();

  // Number the chapters that appear in the body, skipping the cover and the methodology note so that
  // "01 / Executive summary" is the first real chapter.
  const numberFor: Record<string, string> = {};
  flat
    .filter((id) => id !== "cover" && id !== "methodology")
    .forEach((id, index) => {
      numberFor[id] = String(index + 1).padStart(2, "0");
    });

  const body = (id: SectionId) => {
    if (isWrittenSection(id)) return <WrittenSection id={id} value={written[id] || ""} />;
    switch (id) {
      case "executive-summary":
        return <ExecutiveSummary client={client} report={report} narrative={narrative} />;
      case "metrics":
        return <MetricsBlock client={client} report={report} />;
      case "kpis":
        return <KpiGrid client={client} />;
      case "sentiment":
        return <SentimentBreakdown client={client} />;
      case "trend":
        return <TrendChart client={client} />;
      case "active-campaigns":
        return <ActiveCampaignTable client={client} metrics={campaignMetrics} />;
      case "campaigns":
        return <CampaignTable client={client} />;
      case "senders":
        return <SenderTable client={client} />;
      case "top-leads":
        return <TopLeadsTable client={client} />;
      case "icp-distribution":
        return <IcpDistribution client={client} />;
      case "hot-conversations":
        return <HotConversations client={client} />;
      case "reply-timing":
        return <ReplyTimingChart client={client} />;
      case "best-replies":
        return <BestReplies client={client} />;
      case "sample-replies":
        return <SampleReplies client={client} />;
      case "methodology":
        return <Methodology client={client} report={report} notes={notes} />;
      default:
        return null;
    }
  };

  return (
    <article className="report-document">
      {pages.map((page, pageIndex) => {
        // A cover alone on a page gets the full-bleed treatment; sharing a page it becomes a masthead,
        // because a title page that is only a third of a page looks like a mistake.
        const coverOwnsPage = page.length === 1 && page[0] === "cover";
        if (coverOwnsPage) {
          return (
            <section className="report-page report-cover" key={pageIndex}>
              <div className="report-cover-topline">
                <span>{preparedBy}</span>
                <span>·</span>
                <span>Reply Radar</span>
              </div>
              {client.workspace.logoUrl ? (
                <img className="report-cover-logo" src={client.workspace.logoUrl} alt={`${client.workspace.name} logo`} />
              ) : (
                <div className="report-cover-monogram">{client.workspace.name[0]}</div>
              )}
              <h1 className="report-cover-title">{reportTitle}</h1>
              <p className="report-cover-client">{client.workspace.name}</p>
              <p className="report-cover-period">{report.periodLabel}</p>
              <div className="report-cover-footer">
                <div>
                  <label>Prepared</label>
                  <p>{generated}</p>
                </div>
                <div>
                  <label>Prepared for</label>
                  <p>{client.workspace.name}</p>
                </div>
                <div>
                  <label>Prepared by</label>
                  <p>{preparedBy}</p>
                </div>
              </div>
            </section>
          );
        }

        return (
          <section className="report-page" key={pageIndex}>
            {page.includes("cover") && (
              <header className="report-masthead">
                {client.workspace.logoUrl ? (
                  <img className="report-masthead-logo" src={client.workspace.logoUrl} alt={`${client.workspace.name} logo`} />
                ) : (
                  <div className="report-masthead-mono">{client.workspace.name[0]}</div>
                )}
                <div className="report-masthead-text">
                  <h1>{reportTitle}</h1>
                  <p>
                    {client.workspace.name} · {report.periodLabel}
                  </p>
                </div>
                <div className="report-masthead-aside">
                  {generated}
                  <br />
                  {preparedBy}
                </div>
              </header>
            )}

            {pageIndex === 0 && headline && <p className="report-headline">{headline}</p>}

            {page
              .filter((id) => id !== "cover")
              .map((id) => (
                <div className="report-block" key={id}>
                  <header className="report-section-heading">
                    {numberFor[id] && <span className="report-section-number">{numberFor[id]}</span>}
                    <h2>{SECTION_TITLES[id]}</h2>
                    <span className="report-section-rule" />
                  </header>
                  <div className="report-section-body">{body(id)}</div>
                </div>
              ))}

            <footer className="report-page-footer">
              <span>
                {client.workspace.name} · {report.periodLabel}
              </span>
              <span>
                Page {pageIndex + 1} of {pages.length}
              </span>
            </footer>
          </section>
        );
      })}
    </article>
  );
}

/**
 * The executive summary, written by Claude when a template supplies a prompt and computed from the
 * numbers otherwise.
 *
 * The highlights list is appended either way: it is derived directly from the data, so it is the part
 * that is guaranteed correct, and it gives a reader something to check the prose against.
 */
function ExecutiveSummary({
  client,
  report,
  narrative,
}: {
  client: ClientReport;
  report: ReportData;
  narrative: string;
}) {
  const { summary } = client;
  const positiveShare = summary.totalReplies ? Math.round((summary.positiveReplies / summary.totalReplies) * 100) : 0;
  const zone = client.workspace.timezone;
  return (
    <div className="exec-summary">
      {narrative ? (
        narrative
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((paragraph, index) => (
            <p className={index === 0 ? "exec-lede" : "exec-note"} key={index}>
              {paragraph}
            </p>
          ))
      ) : (
        <p className="exec-lede">
          In <strong>{report.periodLabel}</strong>, <strong>{client.workspace.name}</strong> received{" "}
          <strong>{num(summary.totalReplies)}</strong> inbound replies across the outbound motion Reply Radar
          tracks. <strong>{num(summary.positiveReplies)}</strong> ({positiveShare}%) carried positive intent,
          producing <strong>{num(summary.hotCount)}</strong> conversations flagged as high-urgency follow-ups.
        </p>
      )}
      <ul className="exec-highlights">
        <li>
          <strong>Best-performing campaign:</strong> {summary.bestCampaign}
        </li>
        <li>
          <strong>Top sender by volume:</strong> {summary.bestSender}
        </li>
        <li>
          <strong>Average replies per active day:</strong> {summary.avgRepliesPerDay.toFixed(1)}
        </li>
        <li>
          <strong>Leads scored ≥ 75 (ICP):</strong> {summary.topIcpCount}
        </li>
      </ul>
      <p className="exec-note">
        Prepared for the period beginning {report.since ? formatDate(report.since, zone) : "the earliest recorded reply"}
        {report.until ? ` and ending ${formatDate(report.until, zone)}` : " through the present"}. All figures
        are computed from Reply Radar's source-of-truth ledger; no sampling.
      </p>
    </div>
  );
}

/**
 * A section the account manager wrote, printed as typed.
 *
 * Blank lines split paragraphs and single lines that start with a dash become a list, because that is
 * how people type "one line each" into a box. Nothing else is interpreted — this is the one part of the
 * report where the words are the client's own, and reformatting them further would put sentences in
 * front of a client that nobody wrote.
 */
function WrittenSection({ id, value }: { id: WrittenSectionId; value: string }) {
  const trimmed = value.trim();
  if (!trimmed)
    return <EmptyNote>{WRITTEN_SECTION_PROMPTS[id].label} was left blank for this report.</EmptyNote>;

  const blocks = trimmed.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="written-block">
      {blocks.map((block, index) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        const bulleted = lines.length > 1 && lines.every((line) => /^[-•*]\s*/.test(line));
        if (bulleted)
          return (
            <ul key={index}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{line.replace(/^[-•*]\s*/, "")}</li>
              ))}
            </ul>
          );
        return <p key={index}>{lines.join(" ")}</p>;
      })}
    </div>
  );
}

/**
 * The outbound funnel: what was sent, what was accepted, and what came back.
 *
 * Every figure carries its denominator in the caption. A client reading "reply rate 14%" will try to
 * divide the reply count by something, and the only way that arithmetic works out is if the report says
 * which number it divided by. The scope line is there for the same reason — these rates describe the
 * campaigns this report names, not the whole account.
 */
function MetricsBlock({ client, report }: { client: ClientReport; report: ReportData }) {
  const metrics = client.metrics;
  if (!metrics)
    return <EmptyNote>Performance figures were not included when this report was generated.</EmptyNote>;
  if (!metrics.available)
    return (
      <EmptyNote>
        Acceptance and reply rates were unavailable{metrics.reason ? ` — ${metrics.reason}` : ""}. Confirm in
        HeyReach.
      </EmptyNote>
    );

  const figures = [
    { label: "Connection requests sent", value: num(metrics.connectionsSent) },
    { label: "Requests accepted", value: num(metrics.connectionsAccepted) },
    { label: "Average acceptance rate", value: pct(metrics.acceptanceRate) },
    { label: `Replies from ${num(metrics.leadsReplied)} leads`, value: num(metrics.replies) },
    { label: "Reply rate", value: pct(metrics.replyRate) },
    { label: "Positive reply rate", value: pct(metrics.positiveReplyRate) },
  ];

  return (
    <div className="metrics-block">
      <div className="kpi-grid">
        {figures.map((figure) => (
          <div className="kpi-card" key={figure.label}>
            <div className="kpi-value">{figure.value}</div>
            <div className="kpi-label">{figure.label}</div>
          </div>
        ))}
      </div>
      <p className="report-caption">
        {report.periodLabel}, across the {metrics.campaignCount === 1 ? "campaign" : `${metrics.campaignCount} campaigns`}{" "}
        named in this report — not the whole account. Acceptance rate is the average of each campaign's own
        accepted ÷ sent. Reply rate is {num(metrics.replies)} ÷ {num(metrics.connectionsAccepted)} accepted
        connections; positive reply rate is {num(metrics.positiveReplies)} ÷ the same.
      </p>
    </div>
  );
}

function KpiGrid({ client }: { client: ClientReport }) {
  const { summary } = client;
  const kpis = [
    { label: "Inbound replies", value: num(summary.totalReplies) },
    { label: "Positive reply rate", value: pct(summary.positiveRate) },
    { label: "Positive replies", value: num(summary.positiveReplies) },
    { label: "Hot conversations", value: num(summary.hotCount) },
    { label: "Top ICP leads (≥75)", value: num(summary.topIcpCount) },
    { label: "Avg replies / active day", value: summary.avgRepliesPerDay.toFixed(1) },
  ];
  return (
    <div className="kpi-grid">
      {kpis.map((kpi) => (
        <div className="kpi-card" key={kpi.label}>
          <div className="kpi-value">{kpi.value}</div>
          <div className="kpi-label">{kpi.label}</div>
        </div>
      ))}
    </div>
  );
}

function SentimentBreakdown({ client }: { client: ClientReport }) {
  const { sentiment } = client;
  const total =
    sentiment.positive + sentiment.neutral + sentiment.negative + sentiment.unclassified || 1;
  const rows = [
    { label: "Positive", count: sentiment.positive, tone: "positive" },
    { label: "Neutral", count: sentiment.neutral, tone: "neutral" },
    { label: "Negative", count: sentiment.negative, tone: "negative" },
    { label: "Unclassified", count: sentiment.unclassified, tone: "unclassified" },
  ];
  return (
    <div className="sentiment-block">
      <div className="sentiment-bar">
        {rows.map((row) => {
          const share = (row.count / total) * 100;
          return (
            <div
              key={row.label}
              className={`sentiment-bar-slice tone-${row.tone}`}
              style={{ width: `${share}%` }}
              title={`${row.label}: ${row.count} (${share.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <table className="report-table">
        <thead>
          <tr>
            <th>Sentiment</th>
            <th style={{ textAlign: "right" }}>Replies</th>
            <th style={{ textAlign: "right" }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td style={{ textAlign: "right" }}>{num(row.count)}</td>
              <td style={{ textAlign: "right" }}>{pct((row.count / total) * 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendChart({ client }: { client: ClientReport }) {
  if (!client.trend.length) return <EmptyNote>No replies were recorded in this period.</EmptyNote>;
  const max = Math.max(...client.trend.map((row) => row.replies)) || 1;
  return (
    <div className="trend-block">
      <div className="trend-bars">
        {client.trend.map((row) => (
          <div className="trend-bar" key={row.day} title={`${row.day}: ${row.replies}`}>
            <span className="trend-bar-fill" style={{ height: `${(row.replies / max) * 100}%` }} />
            <span className="trend-bar-label">{formatShort(`${row.day}T00:00:00Z`, client.workspace.timezone)}</span>
          </div>
        ))}
      </div>
      <p className="report-caption">Daily inbound reply volume across the period. Peak day: {max} replies.</p>
    </div>
  );
}

/**
 * Campaigns are the one table the API returns in full, so the cap that keeps a page a page lives here.
 *
 * Senders, top leads, hot conversations and sample replies are already bounded server-side. Capping in
 * the renderer rather than the route keeps the CSV complete, which is the point of having a CSV.
 */
const CAMPAIGN_ROW_CAP = 12;

/**
 * What is running right now, from HeyReach rather than from stored replies.
 *
 * Ordered active-first because that is the answer to the client's question; scheduled campaigns follow
 * because "launching next" is the second half of it. Campaigns that have worked through their list are
 * deliberately not here — to us they are complete, and listing them as live would be the exact
 * misreading this section exists to prevent.
 */
/**
 * The live campaigns, with the columns the account manager asked for and no others.
 *
 * Driven by the same choices as the email's campaign lines. A table showing the sending runway next to an
 * email that omitted it — or the reverse — would make the report contradict its own covering note, and
 * whichever one the client read second would be the one they queried.
 */
function ActiveCampaignTable({ client, metrics }: { client: ClientReport; metrics: Set<CampaignMetricId> }) {
  const status = client.campaignStatus;
  if (!status || !status.available)
    return (
      <EmptyNote>
        Live campaign status was unavailable{status?.reason ? ` — ${status.reason}` : ""}. Confirm in HeyReach.
      </EmptyNote>
    );

  const rows = [...status.active, ...status.scheduled];
  // Deliberately not "nothing was active": the campaigns in a report are chosen before it is
  // generated, so an empty table can equally mean none were selected. Claiming otherwise would be a
  // guess printed in front of a client.
  if (!rows.length) return <EmptyNote>No active campaigns are included in this report.</EmptyNote>;

  const key = (value: string) => value.trim().toLowerCase();
  const repliesByCampaign = new Map(client.campaigns.map((row) => [key(row.name), row]));
  const funnelById = new Map(client.metrics.campaigns.map((row) => [row.campaignId, row]));
  const funnelByName = new Map(client.metrics.campaigns.map((row) => [key(row.name), row]));

  /**
   * One column definition per metric, in the order the config screen lists them.
   *
   * `cell` returns a string rather than a node because every one of these is a number or a date, and a
   * column whose contents are built two different ways is a column that will eventually be aligned two
   * different ways.
   */
  const allColumns: Array<{ id: CampaignMetricId; label: string; cell: (row: LiveCampaign) => string }> = [
    {
      id: "launched",
      label: "Launched",
      cell: (row) => (row.launchedAt ? formatShort(row.launchedAt, client.workspace.timezone) : "—"),
    },
    {
      id: "connections-sent",
      label: "Sent",
      cell: (row) => num((funnelById.get(row.id) ?? funnelByName.get(key(row.name)))?.connectionsSent ?? 0),
    },
    {
      id: "connections-accepted",
      label: "Accepted",
      cell: (row) => num((funnelById.get(row.id) ?? funnelByName.get(key(row.name)))?.connectionsAccepted ?? 0),
    },
    { id: "replies", label: "Replies", cell: (row) => num(repliesByCampaign.get(key(row.name))?.replies ?? 0) },
    { id: "positive-replies", label: "Positive", cell: (row) => num(repliesByCampaign.get(key(row.name))?.positive ?? 0) },
    // Dashes, not zeros: HeyReach not telling us who is assigned is not the same as nobody being
    // assigned, and a runway we cannot compute must not print as "0 days".
    { id: "senders", label: "Senders", cell: (row) => (row.senders > 0 ? num(row.senders) : "—") },
    { id: "pending", label: "Leads pending", cell: (row) => num(row.progress.pending) },
    {
      id: "days-left",
      label: "Days left",
      cell: (row) => (row.daysLeftInSending === null ? "—" : num(row.daysLeftInSending)),
    },
  ];
  const columns = allColumns.filter((column) => metrics.has(column.id));

  return (
    <>
      <table className="report-table">
        <thead>
          <tr>
            <th>Campaign</th>
            {columns.map((column) => (
              <th key={column.id} style={column.id === "launched" ? undefined : { textAlign: "right" }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.name}>
              <td>
                {row.name}
                {row.state === "scheduled" && <span className="report-tag">Scheduled</span>}
              </td>
              {columns.map((column) => (
                <td key={column.id} style={column.id === "launched" ? undefined : { textAlign: "right" }}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="report-caption">
        Active means live in HeyReach with leads still to contact.
        {metrics.has("days-left") &&
          " Days left is the leads still pending divided by daily sending capacity — senders × 25 connection requests a day."}
      </p>
    </>
  );
}

function CampaignTable({ client }: { client: ClientReport }) {
  if (!client.campaigns.length) return <EmptyNote>No campaign attribution captured in this period.</EmptyNote>;
  const rows = client.campaigns.slice(0, CAMPAIGN_ROW_CAP);
  const omitted = client.campaigns.length - rows.length;
  return (
    <>
      <table className="report-table">
        <thead>
          <tr>
            <th>Campaign</th>
            <th style={{ textAlign: "right" }}>Replies</th>
            <th style={{ textAlign: "right" }}>Positive</th>
            <th style={{ textAlign: "right" }}>Negative</th>
            <th style={{ textAlign: "right" }}>Positive rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td style={{ textAlign: "right" }}>{num(row.replies)}</td>
              <td style={{ textAlign: "right" }}>{num(row.positive)}</td>
              <td style={{ textAlign: "right" }}>{num(row.negative)}</td>
              <td style={{ textAlign: "right" }}>{row.positiveRate}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      {omitted > 0 && (
        <p className="report-caption">
          Top {CAMPAIGN_ROW_CAP} campaigns by reply volume. {omitted} further{" "}
          {omitted === 1 ? "campaign is" : "campaigns are"} in the CSV.
        </p>
      )}
    </>
  );
}

function SenderTable({ client }: { client: ClientReport }) {
  if (!client.senders.length) return <EmptyNote>No sender attribution captured in this period.</EmptyNote>;
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Sender</th>
          <th style={{ textAlign: "right" }}>Replies</th>
          <th style={{ textAlign: "right" }}>Positive</th>
          <th style={{ textAlign: "right" }}>Positive rate</th>
        </tr>
      </thead>
      <tbody>
        {client.senders.map((row) => (
          <tr key={row.name}>
            <td>{row.name}</td>
            <td style={{ textAlign: "right" }}>{num(row.replies)}</td>
            <td style={{ textAlign: "right" }}>{num(row.positive)}</td>
            <td style={{ textAlign: "right" }}>{row.positiveRate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TopLeadsTable({ client }: { client: ClientReport }) {
  if (!client.topLeads.length) return <EmptyNote>No ICP-scored leads with replies in this period.</EmptyNote>;
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Lead</th>
          <th>Role</th>
          <th>Company</th>
          <th style={{ textAlign: "right" }}>ICP</th>
          <th>Why scored high</th>
        </tr>
      </thead>
      <tbody>
        {client.topLeads.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{row.role || "—"}</td>
            <td>{row.company || "—"}</td>
            <td style={{ textAlign: "right" }}>{row.icpScore}</td>
            <td>{row.icpReason || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IcpDistribution({ client }: { client: ClientReport }) {
  const { icpBuckets } = client;
  const total = icpBuckets.excellent + icpBuckets.strong + icpBuckets.moderate + icpBuckets.weak || 1;
  const rows = [
    { label: "Excellent (75–100)", count: icpBuckets.excellent },
    { label: "Strong (50–74)", count: icpBuckets.strong },
    { label: "Moderate (25–49)", count: icpBuckets.moderate },
    { label: "Weak (0–24)", count: icpBuckets.weak },
  ];
  return (
    <table className="report-table">
      <thead>
        <tr>
          <th>Band</th>
          <th style={{ textAlign: "right" }}>Leads</th>
          <th style={{ textAlign: "right" }}>Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td style={{ textAlign: "right" }}>{num(row.count)}</td>
            <td style={{ textAlign: "right" }}>{pct((row.count / total) * 100)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HotConversations({ client }: { client: ClientReport }) {
  if (!client.hotConversations.length) return <EmptyNote>No conversations exceeded urgency threshold in this period.</EmptyNote>;
  return (
    <div className="hot-list">
      {client.hotConversations.map((row) => (
        <div className="hot-item" key={`${row.leadName}-${row.sentAt}`}>
          <div className="hot-header">
            <strong>{row.leadName}</strong>
            <span className="hot-role">{[row.role, row.company].filter(Boolean).join(" · ")}</span>
            <span className="hot-urgency">Urgency {row.urgency}</span>
          </div>
          <div className="hot-meta">
            {row.campaign} · {formatDate(row.sentAt, client.workspace.timezone)}
          </div>
          <p className="hot-snippet">"{row.snippet}"</p>
        </div>
      ))}
    </div>
  );
}

function ReplyTimingChart({ client }: { client: ClientReport }) {
  const max = Math.max(...client.replyTiming) || 1;
  return (
    <div className="timing-block">
      <div className="timing-bars">
        {client.replyTiming.map((count, hour) => (
          <div className="timing-bar" key={hour} title={`${hour}:00 — ${count} replies`}>
            <span className="timing-bar-fill" style={{ height: `${(count / max) * 100}%` }} />
            <span className="timing-bar-label">{hour}</span>
          </div>
        ))}
      </div>
      <p className="report-caption">
        Inbound reply volume by hour of day in {client.workspace.timezone.replace("_", " ")}.
      </p>
    </div>
  );
}

/**
 * The five replies worth showing a client, and nothing around them.
 *
 * No campaign, no sender, no urgency score, no date. Those belong in `sample-replies`, which exists to be
 * audited; this exists to be read. A quote with four pieces of metadata hanging off it stops being
 * somebody's words and turns back into a row of a table.
 */
function BestReplies({ client }: { client: ClientReport }) {
  const replies = client.bestReplies ?? [];
  if (!replies.length) return <EmptyNote>No positive replies captured in this period.</EmptyNote>;
  return (
    <div className="best-replies">
      {replies.map((row, index) => (
        <blockquote className="best-reply" key={index}>
          <cite>
            <strong>{row.leadName}</strong>
            {[row.role, row.company].filter(Boolean).length > 0 && (
              <span>{[row.role, row.company].filter(Boolean).join(", ")}</span>
            )}
          </cite>
          <p>{row.body}</p>
        </blockquote>
      ))}
    </div>
  );
}

function SampleReplies({ client }: { client: ClientReport }) {
  if (!client.sampleReplies.length) return <EmptyNote>No positive replies captured in this period.</EmptyNote>;
  return (
    <div className="samples">
      {client.sampleReplies.map((row, index) => (
        <blockquote className="sample" key={index}>
          <p>"{row.body}"</p>
          <footer>
            — <strong>{row.leadName}</strong>
            {row.role || row.company ? `, ${[row.role, row.company].filter(Boolean).join(" · ")}` : ""}
            <span className="sample-meta">
              {row.campaign} · Sent to {row.senderName} · {formatDate(row.sentAt, client.workspace.timezone)}
            </span>
          </footer>
        </blockquote>
      ))}
    </div>
  );
}

function Methodology({
  client,
  report,
  notes,
}: {
  client: ClientReport;
  report: ReportData;
  notes: string;
}) {
  return (
    <div className="methodology">
      {notes && (
        <div className="methodology-notes">
          <h4>Notes for the reader</h4>
          <p>{notes}</p>
        </div>
      )}
      <ul>
        <li>
          <strong>Source:</strong> Reply Radar's ledger of HeyReach conversations for {client.workspace.name}. Numbers
          reflect what has been received via HeyReach webhooks and confirmed through direct API sync.
        </li>
        <li>
          <strong>Time window:</strong> {report.periodLabel}
          {report.since && ` — from ${formatDate(report.since, client.workspace.timezone)}`}
          {report.until && ` to ${formatDate(report.until, client.workspace.timezone)}`}.
        </li>
        <li>
          <strong>Sentiment:</strong> Classified per reply by Anthropic Claude Haiku 4.5 using the workspace's
          guardrails prompt. Positive / neutral / negative are the model's returned labels.
        </li>
        <li>
          <strong>ICP score:</strong> 0–100, produced by Claude with the workspace's ICP prompt. Kept forever on
          the lead row so scores are consistent across reports.
        </li>
        <li>
          <strong>Follow-up urgency:</strong> Model-scored per reply. "Hot" is urgency ≥ 60; the inbox flags
          urgency ≥ 75 in red.
        </li>
        <li>
          <strong>Attribution:</strong> Campaigns and senders come from the HeyReach webhook payload. Replies
          missing attribution appear under "— Unattributed —".
        </li>
      </ul>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="report-empty-note">{children}</p>;
}
