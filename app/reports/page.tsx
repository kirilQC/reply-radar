"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import {
  BUILT_IN_TEMPLATES,
  PAGE_LIMIT,
  SECTION_LABELS,
  SECTIONS,
  type ReportPeriod as Period,
  type ReportTemplate,
  type SectionId,
} from "../lib/report-templates";
import { packPages, paginate, suggestTrim } from "../../shared/report-pagination.mjs";
import "./reports.css";

type Workspace = { id: string; slug: string; name: string; logo_url?: string; timezone?: string };

/** What the archive needs to draw a row. The heavy columns are deliberately not listed. */
type SavedReport = {
  id: string;
  workspace_name: string;
  template_name: string;
  title: string;
  period_label: string;
  page_estimate: number | null;
  generated_by: string | null;
  generated_at: string;
};

/** The copy Claude wrote: a headline for the page, the PDF narrative, and the message to send. */
type Composed = { headline: string; narrative: string; message: string };

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
  };
  sentiment: { positive: number; neutral: number; negative: number; unclassified: number };
  campaigns: Array<{ name: string; replies: number; positive: number; negative: number; positiveRate: number }>;
  senders: Array<{ name: string; replies: number; positive: number; positiveRate: number }>;
  topLeads: Array<{ id: string; name: string; role: string; company: string; icpScore: number; icpReason: string; profileUrl: string }>;
  icpBuckets: { excellent: number; strong: number; moderate: number; weak: number };
  hotConversations: Array<{ leadName: string; role: string; company: string; sentAt: string; urgency: number; snippet: string; campaign: string }>;
  sampleReplies: Array<{ leadName: string; role: string; company: string; sentAt: string; body: string; campaign: string; senderName: string }>;
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

const formatDate = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(value));
const formatShort = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(value));
const num = (value: number) => Math.round(value).toLocaleString();
const pct = (value: number) => `${value.toFixed(1)}%`;

export default function ReportsPage() {
  // "hub" is the landing: choose a template, build your own, or reopen something already sent.
  const [view, setView] = useState<"hub" | "builder">("hub");
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>(BUILT_IN_TEMPLATES);
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [savedWarning, setSavedWarning] = useState("");

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

  const [composed, setComposed] = useState<Composed | null>(null);
  const [messageText, setMessageText] = useState("");
  const [composing, setComposing] = useState(false);
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

  useEffect(() => {
    const load = async () => {
      const [workspaceResponse, templateResponse] = await Promise.allSettled([
        fetch("/api/admin/workspaces", { cache: "no-store" }),
        fetch("/api/reports/templates", { cache: "no-store" }),
      ]);

      if (workspaceResponse.status === "fulfilled") {
        const payload = await workspaceResponse.value.json().catch(() => ({}));
        if (Array.isArray(payload.workspaces)) {
          setWorkspaces(payload.workspaces as Workspace[]);
          if (payload.workspaces.length) setWorkspaceSlug(String((payload.workspaces[0] as Workspace).slug));
        }
      }
      if (templateResponse.status === "fulfilled") {
        const payload = await templateResponse.value.json().catch(() => ({}));
        if (Array.isArray(payload.templates) && payload.templates.length) {
          setTemplates(payload.templates as ReportTemplate[]);
        }
      }
      refreshSaved();
    };
    load();
  }, [refreshSaved]);

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
    setError("");
  };

  const openTemplate = (chosen: ReportTemplate) => {
    resetOutput();
    setTemplate(chosen);
    setPeriod(chosen.defaultPeriod);
    setReportTitle(chosen.name);
    setView("builder");
  };

  const openBuilder = () => {
    resetOutput();
    setTemplate(null);
    setReportTitle("Outbound Reply Report");
    setView("builder");
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
    () => savedLayout ?? (template ? template.pages : packPages(orderedSections)),
    [savedLayout, template, orderedSections],
  );
  const budget = useMemo(() => paginate(orderedSections), [orderedSections]);
  // Only a live build-your-own selection can be over the limit. A template is capped by construction,
  // and a report already sent to a client is history — refusing to reprint it would be absurd.
  const overLimit = !template && !savedLayout && !budget.withinLimit;
  const trimAdvice = useMemo(() => (overLimit ? suggestTrim(orderedSections) : []), [overLimit, orderedSections]);

  const generate = useCallback(async () => {
    if (!workspaceSlug) {
      setError("Pick a client first.");
      return;
    }
    setLoading(true);
    setError("");
    setSavedNotice("");
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
        }),
      });
      const payload = (await response.json()) as ReportData & { error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Report generation failed");
      setReport(payload);

      // Only a template carries a prompt, so only a template gets written copy. Build-your-own keeps
      // the deterministic summary that is computed from the numbers.
      if (!template) return;
      setComposing(true);
      try {
        const composeResponse = await fetch("/api/reports/compose", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: template.prompt,
            templateId: template.id,
            channel: template.channel,
            periodLabel: payload.periodLabel,
            clients: payload.clients,
          }),
        });
        const composePayload = await composeResponse.json().catch(() => ({}));
        if (!composeResponse.ok || !composePayload.ok) {
          // The report itself is valid and on screen; only the copy failed. Saying so beats replacing
          // a working document with an error.
          setError(`Report generated, but the write-up failed: ${composePayload.error || composeResponse.status}`);
          return;
        }
        const result: Composed = {
          headline: String(composePayload.headline || ""),
          narrative: String(composePayload.narrative || ""),
          message: String(composePayload.message || ""),
        };
        setComposed(result);
        setMessageText(result.message);
      } finally {
        setComposing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, period, customSince, customUntil, template]);

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

  /**
   * Files the report in Supabase, artifacts and numbers together.
   *
   * The data snapshot goes in alongside the message and the CSV so that reopening it years later
   * renders exactly what the client saw, even after the underlying replies have been purged or
   * re-scored. Nothing about a saved report is ever recomputed.
   */
  const saveReport = async () => {
    if (!report) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/reports/saved", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspaceSlug === "all" ? "" : workspaces.find((row) => row.slug === workspaceSlug)?.id || "",
          workspaceName: workspaceSlug === "all" ? "All clients" : report.clients[0]?.workspace.name || "",
          templateId: template?.id || "build-your-own",
          templateName: template?.name || "Build your own",
          title: reportTitle,
          period: report.period,
          periodLabel: report.periodLabel,
          sections: orderedSections,
          messageChannel: template?.channel || null,
          messageText,
          csvText: buildCsv(report),
          data: { report, pages, reportTitle, preparedBy, notes, composed },
          pageEstimate: pages.length,
          generatedBy: preparedBy,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not save the report.");
      setSavedNotice("Saved to the archive.");
      refreshSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the report.");
    } finally {
      setSaving(false);
    }
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

        {view === "hub" ? (
          <main className="reports-hub print-hide">
            <div className="hub-lede">
              <h1>Report hub</h1>
              <p>
                Start from a template to get a finished report with the write-up already drafted, or build your own
                from the sections you want. Either way it comes out as three pages or fewer, with a message to send
                and a CSV of the underlying numbers.
              </p>
            </div>

            <div className="hub-group-label">
              <span>Templates</span>
              <span>{templates.length === 1 ? "1 template" : `${templates.length} templates`}</span>
            </div>
            <div className="hub-card-grid">
              {templates.map((option) => (
                <button key={option.id} type="button" className="hub-card" onClick={() => openTemplate(option)}>
                  <h3>{option.name}</h3>
                  <p>{option.summary || "No description."}</p>
                  <div className="hub-card-meta">
                    <b>{option.pages.length === 1 ? "1 page" : `${option.pages.length} pages`}</b>
                    <span>·</span>
                    <span>{option.channel === "slack" ? "Slack message" : "Email"}</span>
                    <span>·</span>
                    <span>{option.defaultPeriod === "all-time" ? "All time" : option.defaultPeriod}</span>
                  </div>
                </button>
              ))}

              <button type="button" className="hub-card hub-card-custom" onClick={openBuilder}>
                <h3>Build your own report</h3>
                <p>
                  Pick the sections yourself. The page count is tracked as you go, so you can see when a selection
                  stops fitting.
                </p>
                <div className="hub-card-meta">
                  <b>Up to {PAGE_LIMIT} pages</b>
                  <span>·</span>
                  <span>{SECTIONS.length} sections</span>
                </div>
              </button>
            </div>

            <div className="hub-group-label">
              <span>Saved reports</span>
              <span>{saved.length ? `${saved.length} on file` : "nothing yet"}</span>
            </div>
            {saved.length ? (
              <div className="hub-saved-list">
                {saved.map((row) => (
                  <button key={row.id} type="button" className="hub-saved-row" onClick={() => openSaved(row.id)}>
                    <span>
                      <strong>{row.title}</strong>
                      <small>{row.template_name}</small>
                    </span>
                    <span>{row.workspace_name}</span>
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
                  "Reports you save are kept here permanently, with the exact numbers they were built from — so one a client has already seen always reopens showing what it showed on the day it was sent."
                )}
              </div>
            )}

            {error && <div className="config-error">{error}</div>}
          </main>
        ) : (
        <main className="reports-shell">
          <aside className="reports-configurator print-hide">
            <button type="button" className="config-back" onClick={() => { resetOutput(); setView("hub"); }}>
              ← All reports
            </button>
            <div className="config-heading">
              <h2>{template ? template.name : "Build your own report"}</h2>
              <p>
                {template
                  ? template.summary
                  : "Choose the sections you want. The report is capped at three pages, so heavier sections cost more of the budget."}
              </p>
            </div>

            <label className="config-label">Client</label>
            <select className="config-select" value={workspaceSlug} onChange={(e) => setWorkspaceSlug(e.target.value)}>
              <option value="">Pick a client…</option>
              <option value="all">All clients (combined)</option>
              {workspaces.map((workspace) => (
                <option key={workspace.slug} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>

            <label className="config-label">Period</label>
            <div className="config-period-grid">
              {(["daily", "weekly", "monthly", "quarterly", "all-time", "custom"] as Period[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`config-period ${period === option ? "is-active" : ""}`}
                  onClick={() => setPeriod(option)}
                >
                  {option === "all-time" ? "All time" : option[0].toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>

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

            <label className="config-label">Cover page</label>
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

            <label className="config-label">{template ? "Layout" : "Sections"}</label>
            {template ? (
              // A template's layout is the template. Showing it as read-only pages explains what will
              // print without inviting an edit that would break the page guarantee.
              <div className="config-sections">
                {template.pages.map((page, index) => (
                  <div key={index} className="config-section is-locked">
                    <span>
                      <strong>Page {index + 1}</strong>
                      <em>{page.map((id) => SECTION_LABELS[id]).join(" · ")}</em>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <>
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
              </>
            )}

            <button className="config-generate" onClick={generate} disabled={loading || overLimit}>
              {loading ? "Generating…" : composing ? "Writing…" : "Generate report"}
            </button>
            {error && <div className="config-error">{error}</div>}

            {report && (
              <div className="config-downloads">
                <button onClick={downloadPdf} disabled={overLimit}>
                  Download PDF
                </button>
                <button onClick={downloadCsv}>Download CSV</button>
                <button onClick={saveReport} disabled={saving}>
                  {saving ? "Saving…" : "Save to archive"}
                </button>
              </div>
            )}
            {savedNotice && <div className="config-error">{savedNotice}</div>}
          </aside>

          <section className="reports-canvas">
            {!report && !loading && (
              <div className="reports-empty">
                <h3>Ready when you are.</h3>
                <p>
                  {template
                    ? "Pick a client, then hit Generate. The layout and the write-up come from the template."
                    : "Pick a client and a period, choose the sections you want, then hit Generate."}
                </p>
              </div>
            )}
            {loading && (
              <div className="reports-empty">
                <h3>Generating…</h3>
                <p>Reading conversations, sentiment, campaigns and ICP scores from the source of truth.</p>
              </div>
            )}

            {report && (composed || composing) && (
              <div className="compose-panel print-hide">
                <header>
                  <h3>{template?.channel === "slack" ? "Slack message" : "Email to send"}</h3>
                  {composed && (
                    <button type="button" className="compose-copy" onClick={() => navigator.clipboard?.writeText(messageText)}>
                      Copy
                    </button>
                  )}
                </header>
                {composing ? (
                  <p className="report-empty-note">Writing the summary and the message…</p>
                ) : (
                  <textarea value={messageText} onChange={(event) => setMessageText(event.target.value)} />
                )}
              </div>
            )}

            {report &&
              report.clients.map((client) => (
                <ReportDocument
                  key={client.workspace.id}
                  client={client}
                  report={report}
                  reportTitle={reportTitle}
                  preparedBy={preparedBy}
                  notes={notes}
                  pages={pages}
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
    lines.push("Campaigns");
    lines.push("Campaign,Replies,Positive,Negative,Positive rate");
    for (const row of client.campaigns) {
      lines.push([csv(row.name), row.replies, row.positive, row.negative, `${row.positiveRate}%`].join(","));
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
  "executive-summary": "Executive summary",
  kpis: "Headline KPIs",
  sentiment: "Sentiment breakdown",
  trend: "Reply trend",
  campaigns: "Campaign performance",
  senders: "Sender leaderboard",
  "top-leads": "Top leads by ICP score",
  "icp-distribution": "ICP distribution",
  "hot-conversations": "Hot conversations",
  "reply-timing": "Reply timing",
  "sample-replies": "Sample positive replies",
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
  headline,
  narrative,
}: {
  client: ClientReport;
  report: ReportData;
  reportTitle: string;
  preparedBy: string;
  notes: string;
  pages: SectionId[][];
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
    switch (id) {
      case "executive-summary":
        return <ExecutiveSummary client={client} report={report} narrative={narrative} />;
      case "kpis":
        return <KpiGrid client={client} />;
      case "sentiment":
        return <SentimentBreakdown client={client} />;
      case "trend":
        return <TrendChart client={client} />;
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
