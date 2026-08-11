"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import "./reports.css";

type Period = "daily" | "weekly" | "monthly" | "quarterly" | "all-time" | "custom";
type SectionId =
  | "cover"
  | "executive-summary"
  | "kpis"
  | "sentiment"
  | "trend"
  | "campaigns"
  | "senders"
  | "top-leads"
  | "icp-distribution"
  | "hot-conversations"
  | "reply-timing"
  | "sample-replies"
  | "methodology";

type SectionDef = { id: SectionId; label: string; blurb: string; alwaysOn?: boolean };

const SECTIONS: SectionDef[] = [
  { id: "cover", label: "Cover page", blurb: "Client, period, generated date, brand mark", alwaysOn: true },
  { id: "executive-summary", label: "Executive summary", blurb: "Auto-written narrative from the numbers" },
  { id: "kpis", label: "Headline KPIs", blurb: "Replies, positive rate, hot leads, avg per day" },
  { id: "sentiment", label: "Sentiment breakdown", blurb: "Positive / neutral / negative split with %" },
  { id: "trend", label: "Reply trend", blurb: "Daily bar chart over the period" },
  { id: "campaigns", label: "Campaign performance", blurb: "Replies + positive rate per campaign" },
  { id: "senders", label: "Sender leaderboard", blurb: "Top LinkedIn accounts by reply volume" },
  { id: "top-leads", label: "Top leads", blurb: "Highest ICP scores with role, company, reason" },
  { id: "icp-distribution", label: "ICP distribution", blurb: "How your replied leads cluster" },
  { id: "hot-conversations", label: "Hot conversations", blurb: "Follow-up urgency ≥ 60 with snippets" },
  { id: "reply-timing", label: "Reply timing", blurb: "Hour-of-day heatmap in client's timezone" },
  { id: "sample-replies", label: "Sample positive replies", blurb: "Six verbatim positive replies for evidence" },
  { id: "methodology", label: "Methodology & notes", blurb: "How the numbers were computed", alwaysOn: true },
];

type Workspace = { id: string; slug: string; name: string; logo_url?: string; timezone?: string };

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

const DEFAULT_SECTIONS: SectionId[] = [
  "cover",
  "executive-summary",
  "kpis",
  "sentiment",
  "trend",
  "campaigns",
  "senders",
  "top-leads",
  "hot-conversations",
  "sample-replies",
  "methodology",
];

const formatDate = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(value));
const formatShort = (value: string, timeZone = "America/New_York") =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(value));
const num = (value: number) => Math.round(value).toLocaleString();
const pct = (value: number) => `${value.toFixed(1)}%`;

export default function ReportsPage() {
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

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch("/api/admin/workspaces", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (Array.isArray(payload.workspaces)) {
          setWorkspaces(payload.workspaces as Workspace[]);
          if (!workspaceSlug && payload.workspaces.length) {
            setWorkspaceSlug(String((payload.workspaces[0] as Workspace).slug));
          }
        }
      } catch {
        /* leave empty */
      }
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSection = (id: SectionId) => {
    if (SECTIONS.find((section) => section.id === id)?.alwaysOn) return;
    setSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const generate = useCallback(async () => {
    if (!workspaceSlug) {
      setError("Pick a client first.");
      return;
    }
    setLoading(true);
    setError("");
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, period, customSince, customUntil]);

  const downloadPdf = () => {
    if (!report) return;
    window.print();
  };

  const downloadCsv = () => {
    if (!report) return;
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
        lines.push([csv(row.leadName), csv(row.role), csv(row.company), csv(row.campaign), row.sentAt, row.urgency, csv(row.snippet)].join(","));
      }
      lines.push("");
      lines.push("Reply trend");
      lines.push("Day,Replies");
      for (const row of client.trend) {
        lines.push([row.day, row.replies].join(","));
      }
      lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.clients[0]?.workspace.slug || "report"}-${report.period}-${report.generatedAt.slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const enabledSections = useMemo(() => sections, [sections]);

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

        <main className="reports-shell">
          <aside className="reports-configurator print-hide">
            <div className="config-heading">
              <h2>Report hub</h2>
              <p>Generate a formal client report from live data.</p>
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

            <label className="config-label">Sections</label>
            <div className="config-sections">
              {SECTIONS.map((section) => {
                const on = enabledSections.has(section.id);
                return (
                  <label key={section.id} className={`config-section ${on ? "is-on" : ""} ${section.alwaysOn ? "is-locked" : ""}`}>
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

            <button className="config-generate" onClick={generate} disabled={loading}>
              {loading ? "Generating…" : "Generate report"}
            </button>
            {error && <div className="config-error">{error}</div>}

            {report && (
              <div className="config-downloads">
                <button onClick={downloadPdf}>Download PDF</button>
                <button onClick={downloadCsv}>Download CSV</button>
              </div>
            )}
          </aside>

          <section className="reports-canvas">
            {!report && !loading && (
              <div className="reports-empty">
                <h3>Ready when you are.</h3>
                <p>Pick a client and a period, choose the sections you want, then hit Generate.</p>
              </div>
            )}
            {loading && (
              <div className="reports-empty">
                <h3>Generating…</h3>
                <p>Reading conversations, sentiment, campaigns and ICP scores from the source of truth.</p>
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
                  enabledSections={enabledSections}
                />
              ))}
          </section>
        </main>
      </section>
    </div>
  );
}

function csv(value: unknown) {
  const str = String(value ?? "").replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function ReportDocument({
  client,
  report,
  reportTitle,
  preparedBy,
  notes,
  enabledSections,
}: {
  client: ClientReport;
  report: ReportData;
  reportTitle: string;
  preparedBy: string;
  notes: string;
  enabledSections: Set<SectionId>;
}) {
  const generated = formatDate(report.generatedAt, client.workspace.timezone);
  const orderedSections = SECTIONS.filter((section) => enabledSections.has(section.id));

  // Number the sections that actually appear in the body (skip the cover so
  // "01 / Executive Summary" is the first real chapter).
  const numberedSections = orderedSections.filter((section) => section.id !== "cover" && section.id !== "methodology");
  const numberFor: Record<string, string> = {};
  numberedSections.forEach((section, index) => {
    numberFor[section.id] = String(index + 1).padStart(2, "0");
  });

  return (
    <article className="report-document">
      {enabledSections.has("cover") && (
        <section className="report-page report-cover">
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
      )}

      {orderedSections.some((section) => section.id !== "cover") && (
        <section className="report-page report-toc">
          <h2 className="report-toc-heading">Contents</h2>
          <ol className="report-toc-list">
            {orderedSections
              .filter((section) => section.id !== "cover")
              .map((section) => (
                <li key={section.id}>
                  <span className="toc-num">{numberFor[section.id] || "—"}</span>
                  <span className="toc-label">{section.label}</span>
                  <span className="toc-blurb">{section.blurb}</span>
                </li>
              ))}
          </ol>
        </section>
      )}

      {enabledSections.has("executive-summary") && (
        <SectionShell number={numberFor["executive-summary"]} title="Executive summary">
          <ExecutiveSummary client={client} report={report} />
        </SectionShell>
      )}

      {enabledSections.has("kpis") && (
        <SectionShell number={numberFor["kpis"]} title="Headline KPIs">
          <KpiGrid client={client} />
        </SectionShell>
      )}

      {enabledSections.has("sentiment") && (
        <SectionShell number={numberFor["sentiment"]} title="Sentiment breakdown">
          <SentimentBreakdown client={client} />
        </SectionShell>
      )}

      {enabledSections.has("trend") && (
        <SectionShell number={numberFor["trend"]} title="Reply trend">
          <TrendChart client={client} />
        </SectionShell>
      )}

      {enabledSections.has("campaigns") && (
        <SectionShell number={numberFor["campaigns"]} title="Campaign performance">
          <CampaignTable client={client} />
        </SectionShell>
      )}

      {enabledSections.has("senders") && (
        <SectionShell number={numberFor["senders"]} title="Sender leaderboard">
          <SenderTable client={client} />
        </SectionShell>
      )}

      {enabledSections.has("top-leads") && (
        <SectionShell number={numberFor["top-leads"]} title="Top leads by ICP score">
          <TopLeadsTable client={client} />
        </SectionShell>
      )}

      {enabledSections.has("icp-distribution") && (
        <SectionShell number={numberFor["icp-distribution"]} title="ICP distribution">
          <IcpDistribution client={client} />
        </SectionShell>
      )}

      {enabledSections.has("hot-conversations") && (
        <SectionShell number={numberFor["hot-conversations"]} title="Hot conversations">
          <HotConversations client={client} />
        </SectionShell>
      )}

      {enabledSections.has("reply-timing") && (
        <SectionShell number={numberFor["reply-timing"]} title="Reply timing">
          <ReplyTimingChart client={client} />
        </SectionShell>
      )}

      {enabledSections.has("sample-replies") && (
        <SectionShell number={numberFor["sample-replies"]} title="Sample positive replies">
          <SampleReplies client={client} />
        </SectionShell>
      )}

      {enabledSections.has("methodology") && (
        <SectionShell number="" title="Methodology & notes">
          <Methodology client={client} report={report} notes={notes} />
        </SectionShell>
      )}
    </article>
  );
}

function SectionShell({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <section className="report-page report-section">
      <header className="report-section-heading">
        {number && <span className="report-section-number">{number}</span>}
        <h2>{title}</h2>
        <span className="report-section-rule" />
      </header>
      <div className="report-section-body">{children}</div>
    </section>
  );
}

function ExecutiveSummary({ client, report }: { client: ClientReport; report: ReportData }) {
  const { summary } = client;
  const positiveShare = summary.totalReplies ? Math.round((summary.positiveReplies / summary.totalReplies) * 100) : 0;
  const zone = client.workspace.timezone;
  return (
    <div className="exec-summary">
      <p className="exec-lede">
        In <strong>{report.periodLabel}</strong>, <strong>{client.workspace.name}</strong> received{" "}
        <strong>{num(summary.totalReplies)}</strong> inbound replies across the outbound motion Reply Radar
        tracks. <strong>{num(summary.positiveReplies)}</strong> ({positiveShare}%) carried positive intent,
        producing <strong>{num(summary.hotCount)}</strong> conversations flagged as high-urgency follow-ups.
      </p>
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

function CampaignTable({ client }: { client: ClientReport }) {
  if (!client.campaigns.length) return <EmptyNote>No campaign attribution captured in this period.</EmptyNote>;
  return (
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
        {client.campaigns.map((row) => (
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
