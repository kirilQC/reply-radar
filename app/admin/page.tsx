// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable @next/next/no-html-link-for-pages, jsx-a11y/label-has-associated-control, react/no-unescaped-entities, react-hooks/set-state-in-effect */

import { useEffect, useMemo, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import { defaultFollowUpPrompt, defaultIcpPrompt, FOLLOW_UP_TEMPLATES, ICP_TEMPLATES, MIN_CLIENT_BRIEF_LENGTH, type ScoringTemplate, templateLabel } from "../lib/scoring-templates";
import { brainFolderFor } from "../../shared/brain-link.mjs";
import { airtableBaseFor } from "../../shared/airtable-link.mjs";
import { looksLikeChannelId, normalizeChannelId } from "../lib/slack-channel";
import { parseTitleNeedles, describeNeedles } from "../lib/granola-match";

/** What the breadcrumb calls each configuration section. */
const adminSectionLabels: Record<string, string> = {
  workspaces: "Client directory",
  "ai-hub": "AI",
  granola: "Granola keys",
  ai: "AI context",
  scoring: "Scoring engine",
  heartbeat: "Heartbeat",
  feedback: "Feedback",
  audit: "Audit log",
  theme: "Theme studio",
};

type ClientWorkspace = {
  id?: string;
  name: string;
  slug: string;
  leads: number;
  status: string;
  tone: string;
  lastSync: string;
  createdAt?: string;
  isNew?: boolean;
  brief?: string;
  apiKey?: string;
  timezone?: string;
  keyConfigured?: boolean;
  logoUrl?: string;
  website?: string;
  brainFolder?: string;
  slackInternalChannelId?: string;
  slackExternalChannelId?: string;
  granolaTitleMatch?: string;
  /** The extras, always lists. A database without the migration run reads them as empty, not as absent. */
  slackExtraChannelIds?: string[];
  granolaExtraTitleMatches?: string[];
  /** The Airtable base a person chose. Empty means nothing is written to Airtable for this client. */
  airtableBaseId?: string;
  anthropicModel?: string;
  systemPrompt?: string;
  webhookUrl?: string;
  apiKeyMasked?: string;
  guardrails?: Record<string, unknown>;
};

const initialClients: ClientWorkspace[] = [];

/** A Postgres text array as a list of non-blank strings. Absent columns and `null` both read as empty. */
const asTextList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean);

/**
 * How many extras one client may add, matching what the brief will actually read.
 *
 * Stated here as well as on the server because a form that lets somebody add a fifth channel, saves it, and
 * then silently reads three is worse than a form that stops at three: the missing one looks like a bug in
 * the brief rather than a limit. The server still enforces its own cap; this is only so nobody meets it.
 */
const MAX_EXTRAS = 3;

/**
 * A list of one-line values with a plus to add and a minus to remove, for the extras beside a main field.
 *
 * A list of inputs rather than one comma-separated field, because these are separate things: one channel per
 * row and one meeting per row is what the brief does with them, and a comma inside a meeting title would
 * otherwise split it in two.
 */
function ExtraRows({ label, values, placeholder, onChange }: { label: string; values: string[]; placeholder: string; onChange: (next: string[]) => void }) {
  return (
    <div className="extra-rows">
      <div className="extra-rows-head">
        <span className="extra-rows-label">{label}</span>
        {values.length < MAX_EXTRAS && <button className="extra-rows-add" type="button" onClick={() => onChange([...values, ""])}>+ Add</button>}
      </div>
      {values.map((value, index) => (
        <div className="extra-row" key={index}>
          <input
            value={value}
            placeholder={placeholder}
            onChange={(event) => onChange(values.map((entry, position) => (position === index ? event.target.value : entry)))}
          />
          <button className="extra-row-remove" type="button" aria-label={`Remove ${label} ${index + 1}`} onClick={() => onChange(values.filter((_, position) => position !== index))}>×</button>
        </div>
      ))}
    </div>
  );
}
type HeartbeatPayload = {
  status: string;
  checkedAt?: string;
  services: Array<{ id: string; label: string; configured: boolean; explanation?: string }>;
  clients: Array<{ name: string; slug: string; logoUrl?: string | null; keyConfigured: boolean; webhookAgeSeconds: number | null; pollAgeSeconds: number | null; status: string; webhookStatus?: string; pollStatus?: string; lastWebhookReceivedAt?: string | null; lastSuccessfulPollAt?: string | null; recentRuns?: unknown[]; recentEvents?: unknown[]; raw?: Record<string, unknown> }>;
  worker?: { status: string; recordedStatus?: unknown; ageSeconds: number | null; startedAt?: string; finishedAt?: string; durationSeconds?: number | null; workspacesSeen: number; recordsWritten?: unknown; source?: unknown; runType?: unknown; error: string | null; recentRuns?: unknown[]; raw?: Record<string, unknown> } | null;
  thresholds?: Record<string, number>;
  diagnostics?: Record<string, unknown>;
  aiArk?: { status: string; enabled: boolean; configured: boolean; failureThreshold: number; failures24h: number; successes24h: number; calls24h: number; unenrichedLeads24h: number; explanation: string; recentFailures?: unknown[]; recentRuns?: unknown[] };
  error?: string;
};

export default function AdminPage() {
  // Read once from the URL so other pages can link to a section rather than to "the configuration page,
  // now find it yourself". Anything unrecognised falls back to the directory.
  const [active, setActive] = useState(() => {
    if (typeof window === "undefined") return "workspaces";
    const requested = new URLSearchParams(window.location.search).get("section") ?? "";
    return requested in adminSectionLabels ? requested : "workspaces";
  });
  const [workspaceClients, setWorkspaceClients] = useState(initialClients);
  const [workspaceStorageReady, setWorkspaceStorageReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [clientSearch, setClientSearch] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [workspaceError, setWorkspaceError] = useState("");
  const [messagingSyncing, setMessagingSyncing] = useState(false);
  const [messagingSyncResult, setMessagingSyncResult] = useState("");
  const [themePreset, setThemePreset] = useState("midnight");
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [accentOverrides, setAccentOverrides] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = window.localStorage.getItem("reply-radar-admin-accent-overrides");
      return stored ? (JSON.parse(stored) as Record<string, string>) : {};
    } catch { return {}; }
  });
  const logoInput = useRef<HTMLInputElement>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatPayload | null>(null);
  const [heartbeatRefresh, setHeartbeatRefresh] = useState(0);
  const clients = workspaceClients;
  const client = clients[Math.min(selected, Math.max(0, clients.length - 1))] ?? { name: "", slug: "", leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced" };
  const [workspaceDraft, setWorkspaceDraft] = useState<{
    name: string; slug: string; brief: string; timezone: string; website: string; messagingDocUrl: string;
    anthropicModel: string; systemPrompt: string; apiKey: string; brainFolder: string;
    slackInternal: string; slackExternal: string; granolaTitleMatch: string;
    slackExtra: string[]; granolaExtra: string[]; airtableBaseId: string;
  }>({ name: "", slug: "", brief: "", timezone: "America/New_York", website: "", messagingDocUrl: "", anthropicModel: "", systemPrompt: "", apiKey: "", brainFolder: "", slackInternal: "", slackExternal: "", granolaTitleMatch: "", slackExtra: [], granolaExtra: [], airtableBaseId: "" });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [workspacePassword, setWorkspacePassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const showSavedConfirmation = () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
    setSaved(true);
    savedTimer.current = setTimeout(() => setSaved(false), 3_000);
  };
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const response = await fetch("/api/admin/workspaces", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!cancelled && response.ok && Array.isArray(payload.workspaces)) {
          const hydratedClients = payload.workspaces.map((item: Record<string, unknown>) => ({
            id: String(item.id ?? ""), name: String(item.name ?? ""), slug: String(item.slug ?? ""), leads: 0,
            status: item.last_successful_poll_at ? "Connected" : "Not configured", tone: String(item.accent_color ?? "var(--accent)"),
            lastSync: String(item.last_successful_poll_at ?? "not synced"), createdAt: String(item.created_at ?? ""),
            brief: String(item.client_brief ?? ""), apiKey: "", apiKeyMasked: String(item.heyreach_api_key_masked ?? ""), timezone: String(item.timezone ?? "America/New_York"), website: String(item.website_url ?? ""), anthropicModel: String(item.anthropic_model ?? ""), systemPrompt: String(item.custom_system_prompt ?? ""), webhookUrl: String(item.webhook_url ?? ""), keyConfigured: Boolean(item.key_configured),
            logoUrl: String(item.logo_url ?? ""), brainFolder: String(item.brain_folder ?? ""),
            slackInternalChannelId: String(item.slack_internal_channel_id ?? ""), slackExternalChannelId: String(item.slack_external_channel_id ?? ""), granolaTitleMatch: String(item.granola_title_match ?? ""),
            slackExtraChannelIds: asTextList(item.slack_extra_channel_ids), granolaExtraTitleMatches: asTextList(item.granola_extra_title_matches),
            airtableBaseId: String(item.airtable_base_id ?? ""),
            guardrails: item.guardrails && typeof item.guardrails === "object" ? item.guardrails as Record<string, unknown> : {},
          }));
          setWorkspaceClients(hydratedClients);
          const requestedClient = new URLSearchParams(window.location.search).get("client");
          const requestedIndex = requestedClient ? hydratedClients.findIndex((item: ClientWorkspace) => item.slug === requestedClient) : -1;
          if (requestedIndex >= 0) { setSelected(requestedIndex); setWorkspaceOpen(true); }
          setWorkspaceStorageReady(true);
          return;
        }
      } catch { /* use the offline cache */ }
      try {
        const saved = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (!cancelled && saved) setWorkspaceClients((JSON.parse(saved) as ClientWorkspace[]).map((item) => ({ ...item, createdAt: item.createdAt ?? "" })));
      } catch { /* keep the empty state */ }
      if (!cancelled) setWorkspaceStorageReady(true);
    };
    void hydrate();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (workspaceStorageReady) window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(workspaceClients));
  }, [workspaceClients, workspaceStorageReady]);
  useEffect(() => {
    if (!workspaceOpen || !client) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */ setWorkspaceDraft({ name: client.name, slug: client.slug, brief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", website: client.website ?? "", messagingDocUrl: String(client.guardrails?.messaging_doc_url ?? ""), anthropicModel: client.anthropicModel ?? "", systemPrompt: client.systemPrompt ?? "", apiKey: "", brainFolder: client.brainFolder ?? "", slackInternal: client.slackInternalChannelId ?? "", slackExternal: client.slackExternalChannelId ?? "", granolaTitleMatch: client.granolaTitleMatch ?? "", slackExtra: client.slackExtraChannelIds ?? [], granolaExtra: client.granolaExtraTitleMatches ?? [], airtableBaseId: client.airtableBaseId ?? "" });
  }, [selected, workspaceOpen]);
  const addWorkspace = () => {
    const next: ClientWorkspace = { name: "", slug: `workspace-${Date.now()}`, leads: 0, status: "Not configured", tone: "#8b7cff", lastSync: "not synced", createdAt: new Date().toISOString(), isNew: true };
    setWorkspaceError("");
    setSaved(false);
    setWorkspaceClients((current) => [...current, next]);
    setSelected(clients.length);
    setWorkspaceOpen(true);
  };
  const saveWorkspaceChanges = async () => {
    setSaving(true);
    setSaved(false);
    setWorkspaceError("");
    const normalizedName = workspaceDraft.name.trim();
    const normalizedSlug = workspaceDraft.slug.trim() || normalizedName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || client.slug;
    const logoUrl = logos[client.slug] ?? client.logoUrl ?? "";
    const mutationIdentity = isNewWorkspace ? { create: true } : { id: client.id, previousSlug: client.slug };
    const nextGuardrails = { ...(client.guardrails ?? {}), messaging_doc_url: workspaceDraft.messagingDocUrl.trim() };
    const response = await fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...mutationIdentity, name: normalizedName, slug: normalizedSlug, clientBrief: workspaceDraft.brief, timezone: workspaceDraft.timezone || "America/New_York", websiteUrl: workspaceDraft.website, brainFolder: workspaceDraft.brainFolder, slackInternalChannelId: workspaceDraft.slackInternal, slackExternalChannelId: workspaceDraft.slackExternal, granolaTitleMatch: workspaceDraft.granolaTitleMatch, slackExtraChannelIds: workspaceDraft.slackExtra, granolaExtraTitleMatches: workspaceDraft.granolaExtra, airtableBaseId: workspaceDraft.airtableBaseId, anthropicModel: workspaceDraft.anthropicModel || null, systemPrompt: workspaceDraft.systemPrompt || null, ...(workspaceDraft.apiKey.trim() ? { heyreachApiKey: workspaceDraft.apiKey.trim() } : {}), logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone, guardrails: nextGuardrails }) }).catch(() => null);
    if (!response?.ok) {
      const detail = await response?.json().catch(() => ({}));
      setWorkspaceError(String(detail?.error ?? "Could not save this workspace. Check Supabase and try again."));
      setSaved(false);
      setSaving(false);
      return;
    }
    const payload = await response.json().catch(() => ({}));
    const savedRow = Array.isArray(payload.workspaces) ? payload.workspaces[0] : null;
    const keyWasSaved = Boolean(workspaceDraft.apiKey.trim()) || client.keyConfigured;
    const next = workspaceClients.map((item, index) => index === selected ? { ...item, id: String(savedRow?.id ?? item.id ?? ""), name: normalizedName, slug: normalizedSlug, brief: workspaceDraft.brief, apiKey: "", apiKeyMasked: savedRow?.heyreach_api_key_masked ?? (workspaceDraft.apiKey.trim() ? `Saved key ••••${workspaceDraft.apiKey.trim().slice(-4)}` : item.apiKeyMasked), keyConfigured: savedRow?.key_configured ?? keyWasSaved, timezone: workspaceDraft.timezone, website: workspaceDraft.website, brainFolder: workspaceDraft.brainFolder, slackInternalChannelId: String(savedRow?.slack_internal_channel_id ?? workspaceDraft.slackInternal), slackExternalChannelId: String(savedRow?.slack_external_channel_id ?? workspaceDraft.slackExternal), granolaTitleMatch: String(savedRow?.granola_title_match ?? workspaceDraft.granolaTitleMatch), slackExtraChannelIds: asTextList(savedRow?.slack_extra_channel_ids ?? workspaceDraft.slackExtra), granolaExtraTitleMatches: asTextList(savedRow?.granola_extra_title_matches ?? workspaceDraft.granolaExtra), airtableBaseId: String(savedRow?.airtable_base_id ?? workspaceDraft.airtableBaseId), anthropicModel: workspaceDraft.anthropicModel, tone: accentOverrides[client.slug] ?? item.tone, logoUrl, guardrails: nextGuardrails, isNew: false } : item);
    setWorkspaceClients(next);
    setWorkspaceDraft((draft) => ({ ...draft, apiKey: "" }));
    window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
    window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
    setSaving(false);
    showSavedConfirmation();
  };
  const removeWorkspace = async () => {
    const response = await fetch("/api/admin/workspaces", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: client.id, slug: client.slug }) }).catch(() => null);
    if (!response?.ok) { setPasswordError("Could not delete this workspace from Supabase."); return; }
    const next = clients.filter((_, index) => index !== selected);
    setWorkspaceClients(next);
    window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
    window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
    setSelected(0);
    setWorkspaceOpen(false);
    setSaved(false);
    setPasswordOpen(false);
    setWorkspacePassword("");
  };
  const requestRemoveWorkspace = () => { setPasswordError(""); setWorkspacePassword(""); setPasswordOpen(true); };
  const confirmRemoveWorkspace = async () => {
    if (workspacePassword !== "QueenCity@2026") { setPasswordError("Incorrect password."); return; }
    await removeWorkspace();
  };
  const isNewWorkspace = Boolean(client.isNew);
  const visibleClients = clients
    .filter((item) => item.name.toLowerCase().includes(clientSearch.toLowerCase()) || item.slug.includes(clientSearch.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  useEffect(() => {
    window.localStorage.setItem("reply-radar-admin-accent-overrides", JSON.stringify(accentOverrides));
  }, [accentOverrides]);
  useEffect(() => {
    if (active !== "heartbeat") return;
    fetch("/api/heartbeat", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: HeartbeatPayload) => setHeartbeat(payload))
      .catch(() => setHeartbeat({ status: "error", services: [], clients: [] }));
  }, [active, heartbeatRefresh]);
  /**
   * The folders in the QC Brain, so a person can say which one this client is.
   *
   * The two systems named the same companies independently and mostly agree, so the guess below is
   * right for most clients and silently wrong for the rest. Silently wrong is the bad case — it puts
   * one client's campaign figures under another client's strategy note — so the guess is shown as a
   * guess and can be overruled here, once, permanently.
   */
  const [brainFolders, setBrainFolders] = useState<string[]>([]);
  useEffect(() => {
    if (active !== "workspaces") return;
    fetch("/api/brain/clients", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => setBrainFolders(Array.isArray(payload?.clients) ? payload.clients.map((item: { client: string }) => item.client) : []))
      .catch(() => setBrainFolders([]));
  }, [active]);
  const guessedFolder = brainFolderFor({ slug: workspaceDraft.slug, name: workspaceDraft.name, brainFolder: "" }, brainFolders) as { folder: string; how: string };
  /*
   * The Airtable bases this token can see, so a person can say which one is this client's tracker.
   *
   * Same shape as the brain folder above and deliberately so, with one difference that matters: the
   * guess there is used when nothing is stored, and the guess here is not. A wrong brain folder shows
   * the wrong figures on our own screen. A wrong Airtable base writes our action items into another
   * company's project tracker — so the guess prefills the picker and a person still has to agree.
   */
  const [airtableBases, setAirtableBases] = useState<{ id: string; name: string }[]>([]);
  const [airtableError, setAirtableError] = useState("");
  useEffect(() => {
    if (active !== "workspaces") return;
    fetch("/api/airtable/bases", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        setAirtableBases(Array.isArray(payload?.bases) ? payload.bases : []);
        setAirtableError(payload?.ok ? "" : String(payload?.error ?? "Airtable could not be reached."));
      })
      .catch(() => { setAirtableBases([]); setAirtableError("Airtable could not be reached."); });
  }, [active]);
  const guessedBase = airtableBaseFor({ slug: workspaceDraft.slug, name: workspaceDraft.name, airtableBaseId: "" }, airtableBases) as { baseId: string; name: string; how: string; candidates: { id: string; name: string }[] };
  /*
   * Whether the mapped base's tracker can actually be written into.
   *
   * Only the base somebody settled on is read, and only when it changes. Auditing every base in the
   * dropdown would be fifty schema requests against a five-per-second limit to answer a question about
   * one client, and the answer for the other forty-nine would be thrown away.
   */
  type TableAudit = { name: string; table: { id: string; name: string } | null; missing: { name: string }[]; mistyped: { name: string; expected: string; actual: string }[] };
  const [tracker, setTracker] = useState<{ ready: boolean; campaigns: TableAudit; actionItems: TableAudit; weeklyCalls: TableAudit; needsSplit: boolean; legacyTable: { name: string } | null } | null>(null);
  const [trackerState, setTrackerState] = useState<"idle" | "checking" | "error">("idle");
  const [trackerError, setTrackerError] = useState("");
  const [trackerChecks, setTrackerChecks] = useState(0);
  useEffect(() => {
    const baseId = workspaceDraft.airtableBaseId;
    if (!baseId) { setTracker(null); setTrackerState("idle"); setTrackerError(""); return; }
    let cancelled = false;
    setTrackerState("checking");
    fetch(`/api/airtable/tracker?baseId=${encodeURIComponent(baseId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (payload?.ok) { setTracker(payload.tracker); setTrackerState("idle"); setTrackerError(""); return; }
        setTracker(null); setTrackerState("error"); setTrackerError(String(payload?.error ?? "That base could not be read."));
      })
      .catch(() => { if (!cancelled) { setTracker(null); setTrackerState("error"); setTrackerError("That base could not be read."); } });
    return () => { cancelled = true; };
  }, [workspaceDraft.airtableBaseId, trackerChecks]);

  /*
   * The one place in the app that changes the structure of a client's base, so it is a button and not
   * a repair the audit does for you. It only ever adds, and it reports every table and column by name
   * — somebody has to be able to tell their client exactly what appeared in their workspace.
   */
  const [buildState, setBuildState] = useState<"idle" | "building">("idle");
  const [buildNote, setBuildNote] = useState("");
  const buildTrackers = async () => {
    const baseId = workspaceDraft.airtableBaseId;
    if (!baseId || buildState === "building") return;
    setBuildState("building");
    setBuildNote("");
    try {
      const response = await fetch("/api/airtable/tracker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseId }) });
      const payload = await response.json();
      const lines = [...(payload?.created ?? []), ...(payload?.added ?? []).map((line: string) => `Added ${line}.`), ...(payload?.skipped ?? []), ...(payload?.problems ?? [])];
      setBuildNote(lines.length ? lines.join(" ") : String(payload?.error ?? "Nothing came back."));
    } catch {
      setBuildNote("That base could not be reached.");
    } finally {
      setBuildState("idle");
      setTrackerChecks((count) => count + 1);
    }
  };
  // Echoed back as the writer will read it, same as the Slack and Granola notes: the failure worth
  // catching is a base that is mapped, saves cleanly, and has no tracker table to write into.
  const airtableNote = (() => {
    if (airtableError) return airtableError;
    if (!workspaceDraft.airtableBaseId) {
      if (guessedBase.how === "ambiguous") return `${guessedBase.candidates.length} bases match this name (${guessedBase.candidates.map((base) => base.name).join(", ")}). Pick the right one above.`;
      if (guessedBase.baseId) return `${guessedBase.name} looks like this client's base. Pick it above to confirm — nothing is written to Airtable until a base is chosen here.`;
      return airtableBases.length ? "No base matches this name. Pick this client's base above, or leave it unset to write nothing to Airtable." : "No Airtable bases have been listed yet.";
    }
    if (trackerState === "checking") return "Checking the tables in that base.";
    if (trackerState === "error") return trackerError;
    if (!tracker) return "";
    if (tracker.ready) return "Campaign Tracker, Project Tracker and Weekly Calls are all ready.";
    // Said as the thing to go and do. "Not ready" is three different jobs depending on why, and the
    // one that reads as a missing column is usually a base nobody has split yet.
    if (tracker.needsSplit) return `That base still has the old ${tracker.legacyTable?.name ?? "combined tracker"}. It needs splitting into Campaign Tracker and Project Tracker before the brief can write to it.`;
    const faults: string[] = [];
    for (const audit of [tracker.campaigns, tracker.actionItems, tracker.weeklyCalls]) {
      if (!audit.table) { faults.push(`${audit.name} is missing`); continue; }
      for (const field of audit.missing) faults.push(`${audit.name}: ${field.name} is missing`);
      for (const field of audit.mistyped) faults.push(`${audit.name}: ${field.name} is a ${field.actual}, not a ${field.expected}`);
    }
    return faults.length ? faults.join(". ") + "." : "";
  })();
  const slackChannelNote = (() => {
    const internal = normalizeChannelId(workspaceDraft.slackInternal);
    const external = normalizeChannelId(workspaceDraft.slackExternal);
    const wrong = [internal && !looksLikeChannelId(internal) ? "internal" : "", external && !looksLikeChannelId(external) ? "external" : ""].filter(Boolean);
    if (wrong.length) return `That does not look like a channel id (${wrong.join(" and ")}). Open the channel in Slack, choose View channel details, and copy the id from the bottom — or paste the channel URL here and the id will be read out of it.`;
    if (internal && internal === external) return "Both fields hold the same channel. The internal channel is where the team talks and the external one is shared with the client — briefs written for one are not safe to post in the other.";
    if (internal && external) return "The internal channel is read for what the team committed to. The external channel is read for anything the client asked that nobody answered. The Reply Radar bot has to be invited to both.";
    if (internal || external) return `Only the ${internal ? "internal" : "external"} channel is set. A brief will still be written, but it will be missing whatever the other channel would have told it.`;
    return "Briefs need at least one channel. Paste the channel id, or the channel URL, and the id will be read out of it.";
  })();
  // Echoed back as the matcher will read it, not as typed. The failure this catches is a name that looks
  // fine and matches nothing: two letters, or a word this drops as generic.
  const granolaTitleNote = (() => {
    const needles = parseTitleNeedles(workspaceDraft.granolaTitleMatch, workspaceDraft.name);
    if (!needles.length) return "Nothing here is specific enough to find a meeting by.";
    return `Meetings with “${describeNeedles(needles)}” in the title.`;
  })();
  // Echoed the same way, and only when there is something to echo. The one thing worth saying is which
  // of these will actually find a meeting: a row typed and left too vague matches nothing and looks fine.
  const extraCallNote = (() => {
    const rows = workspaceDraft.granolaExtra.map((entry) => entry.trim()).filter(Boolean);
    if (!rows.length) return "";
    const described = rows.map((entry) => {
      const needles = parseTitleNeedles(entry, "");
      return needles.length ? `“${describeNeedles(needles)}”` : "";
    });
    const vague = described.filter((entry) => !entry).length;
    const found = described.filter(Boolean);
    return `${found.length ? `Also the latest meeting with ${found.join(" or ")} in the title. ` : ""}${vague ? `${vague} of these is not specific enough to find a meeting by.` : "Ranked below the main call."}`;
  })();
  const accentColor = accentOverrides[client.slug] ?? client.tone;
  const workspaceLogo = logos[client.slug] ?? client.logoUrl ?? "";
  const setAccentColor = (value: string) =>
    setAccentOverrides((current) => ({ ...current, [client.slug]: value }));
  const chooseLogo = () => logoInput.current?.click();
  const handleLogo = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      const logoUrl = String(reader.result);
      setLogos((current) => ({ ...current, [client.slug]: logoUrl }));
      const next = workspaceClients.map((item, index) => index === selected ? { ...item, logoUrl } : item);
      setWorkspaceClients(next);
      window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(next));
      window.dispatchEvent(new Event("reply-radar-workspaces-changed"));
      void fetch("/api/admin/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: client.id, previousSlug: client.slug, name: client.name, slug: client.slug, clientBrief: client.brief ?? "", timezone: client.timezone ?? "America/New_York", websiteUrl: client.website ?? "", brainFolder: client.brainFolder ?? "", anthropicModel: client.anthropicModel ?? null, logoUrl, accentColor: accentOverrides[client.slug] ?? client.tone }) });
    };
    reader.readAsDataURL(file);
  };
  // No fallback address. The server fills this in from the domain it is actually being served on, so
  // a literal here would only ever be a stale second opinion — and the failure it caused would be a
  // client's replies quietly not arriving, which nobody notices for a week.
  const copyWebhook = () => {
    if (!client.webhookUrl) return;
    void navigator.clipboard?.writeText(client.webhookUrl);
    showSavedConfirmation();
  };
  const syncMessagingDoc = async () => {
    const slug = client.slug;
    if (!slug || !workspaceDraft.messagingDocUrl.trim()) return;
    setMessagingSyncing(true);
    setMessagingSyncResult("");
    const response = await fetch(`/api/messaging/sync?workspace=${encodeURIComponent(slug)}`, { method: "POST" }).catch(() => null);
    const payload = await response?.json().catch(() => null) as { ok?: boolean; filed?: number; results?: Array<{ filed: number; skipped: number; note: string }>; error?: string } | null;
    if (!payload?.ok) {
      setMessagingSyncResult(payload?.error || "Sync failed. Check the document sharing and try again.");
    } else {
      const result = payload.results?.[0];
      const filed = result?.filed ?? payload.filed ?? 0;
      const skipped = result?.skipped ?? 0;
      setMessagingSyncResult(result?.note || `Filed ${filed} new tab${filed === 1 ? "" : "s"}${skipped ? `, ${skipped} already in the brain` : ""}.`);
    }
    setMessagingSyncing(false);
  };
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <main className={`admin-shell admin-theme-${themePreset}`}>
          <header className="admin-topbar">
            <Crumb
              trail={[
                { label: "Configuration", href: "/admin" },
                ...(active === "workspaces"
                  ? workspaceOpen
                    ? [
                        { label: "Client directory", href: "/admin", onClick: (event: React.MouseEvent) => { event.preventDefault(); setWorkspaceOpen(false); } },
                        { label: client.name || "New workspace" },
                      ]
                    : [{ label: "Client directory" }]
                  : [{ label: adminSectionLabels[active] ?? "Theme studio" }]),
              ]}
            />
            <div className="admin-top-actions">
              <GlobalAppearanceControl />
            </div>
          </header>
          <div className="admin-layout">
            <aside className="admin-nav">
              <div className="admin-nav-caption">CONFIGURATION</div>
              <button
                className={active === "workspaces" ? "active" : ""}
                onClick={() => { setActive("workspaces"); setWorkspaceOpen(false); }}
              >
                <span>▦</span>Client directory
              </button>
              <button
                className={active === "ai-hub" ? "active" : ""}
                onClick={() => setActive("ai-hub")}
              >
                <span>✦</span>AI
              </button>
              <button
                className={active === "granola" ? "active" : ""}
                onClick={() => setActive("granola")}
              >
                <span>◉</span>Granola keys
              </button>
              <div className="admin-nav-caption system-caption">SYSTEM</div>
              {[
                ["feedback", "Feedback", "✎"],
                ["audit", "Audit log", "≡"],
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  className={active === id ? "active" : ""}
                  onClick={() => setActive(id)}
                >
                  <span>{icon}</span>
                  {label}
                </button>
              ))}
            </aside>
            <section className={`admin-content ${active === "audit" ? "audit-content" : ""}`}>
              {active !== "ai-hub" && active !== "granola" && <div className="admin-heading">
                <div>
                  <h1 className={active === "workspaces" ? (workspaceOpen ? "client-config-heading" : "workspace-directory-page-title") : undefined}>
                    {active === "workspaces" && workspaceOpen ? <>{workspaceLogo ? <img className="admin-client-heading-logo" src={workspaceLogo} alt="" /> : <span className="admin-client-heading-logo" style={{ background: accentColor }}>{client.name[0] || "?"}</span>}{client.name || "New workspace"}</> : active === "workspaces"
                        ? "Client workspaces"
                        : active === "ai"
                          ? "AI context & voice"
                          : active === "scoring"
                            ? "Scoring engine"
                            : active === "theme"
                              ? "Theme studio"
                              : active === "heartbeat"
                                ? "Heartbeat"
                                : active === "feedback"
                                  ? "Feedback"
                                  : active === "audit"
                                    ? "Audit log"
                                    : "System health"}
                  </h1>
                  {!(active === "workspaces" && workspaceOpen) && active !== "workspaces" && active !== "audit" && active !== "feedback" && <p>
                    {active === "ai"
                          ? "Tune the Anthropic drafting context for every client."
                          : active === "scoring"
                            ? "Make follow-up urgency explainable and client-specific."
                            : active === "heartbeat"
                              ? "Live pulse checks for credentials, webhooks, and sync freshness."
                              : active === "audit"
                                ? ""
                            : active === "theme"
                              ? "Customize the interface without touching code."
                              : "Verify ingestion and worker reliability across every workspace."}
                  </p>}
                </div>
                {active === "workspaces" && !workspaceOpen && <button
                  className="primary-button"
                  onClick={addWorkspace}
                >
                  + Add workspace
                </button>}
              </div>}
              {workspaceError && active === "workspaces" && <p className="form-error" role="alert">{workspaceError}</p>}
              {active === "heartbeat" && <HeartbeatView heartbeat={heartbeat} onRefresh={() => { setHeartbeat(null); setHeartbeatRefresh((value) => value + 1); }} />}
              {active === "feedback" && <FeedbackView />}
              {active === "audit" && <AuditView />}
              {active === "workspaces" && (
                <>
                  {!workspaceOpen && <div className="workspace-directory">
                    <div className="workspace-directory-heading">
                      <div><strong>Client directory</strong></div>
                      <input aria-label="Search clients" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Search clients…" />
                    </div>
                    <div className="workspace-directory-list">
                    {visibleClients.map((item) => {
                      const index = clients.findIndex((candidate) => candidate.slug === item.slug);
                      return (
                      <button
                        key={item.slug}
                        className="workspace-card"
                        onClick={() => { setSelected(index); setWorkspaceOpen(true); }}
                      >
                        <i
                          className="workspace-directory-logo"
                          style={item.logoUrl ? undefined : { background: item.tone }}
                        >
                          {item.logoUrl ? <img src={item.logoUrl} alt={`${item.name} logo`} /> : (item.name || "?")[0]}
                        </i>
                        <strong>{item.name || "Unnamed workspace"}</strong>
                      </button>
                    ); })}
                    {!visibleClients.length && <div className="workspace-directory-empty">No clients match your search.</div>}
                    </div>
                  </div>}
                  {workspaceOpen && <div className="workspace-editor-toolbar"><button className="secondary-button" onClick={() => { setWorkspaceError(""); setWorkspaceOpen(false); }}>← Back to directory</button><button className="primary-button" onClick={saveWorkspaceChanges} disabled={saving}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save changes"}</button></div>}
                  {workspaceOpen && <div className="admin-grid">
                    <section className="admin-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>HeyReach connection</h2>
                          <p>
                            Each client gets an isolated API key and webhook
                            endpoint.
                          </p>
                        </div>
                        <span className={isNewWorkspace ? "saved-dot" : "connection-badge"}>
                          <i /> {isNewWorkspace ? "Not configured" : "API healthy"}
                        </span>
                      </div>
                      <label className="field-label">
                        WORKSPACE NAME
                        <input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Enter workspace name" />
                      </label>
                      <label className="field-label">
                        HEYREACH API KEY
                        <div className="secret-field">
                          <input
                              value={workspaceDraft.apiKey}
                              onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, apiKey: event.target.value }))}
                              placeholder={client.keyConfigured ? (client.apiKeyMasked || "Saved HeyReach API key · enter a new key to replace") : "Enter HeyReach API key"}
                              type={showKey ? "text" : "password"}
                          />
                          <button onClick={() => setShowKey(!showKey)}>
                            {showKey ? "Hide" : "Reveal"}
                          </button>
                        </div>
                      </label>
                      <div className="field-row">
                        <label className="field-label">
                          WEBHOOK STATUS
                          <div className="status-field">
                            <i /> {isNewWorkspace ? "Not configured" : "Registered · 10 event types"}
                          </div>
                        </label>
                        <label className="field-label">
                          LAST RECONCILIATION
                          <div className="status-field">
                            {isNewWorkspace ? "—" : <>Today, 09:42 AM <span>↻</span></>}
                          </div>
                        </label>
                      </div>
                      <label className="field-label">
                        CLIENT MESSAGING DOC
                        <input value={workspaceDraft.messagingDocUrl} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, messagingDocUrl: event.target.value }))} placeholder="https://docs.google.com/document/d/…" type="url" />
                        <div className="messaging-doc-sync">
                          <button type="button" onClick={syncMessagingDoc} disabled={messagingSyncing || isNewWorkspace || !workspaceDraft.messagingDocUrl.trim()}>
                            {messagingSyncing ? "Pulling tabs…" : "Sync tabs to brain"}
                          </button>
                          {messagingSyncResult && <small className="messaging-doc-sync-result">{messagingSyncResult}</small>}
                        </div>
                      </label>
                      <div className="endpoint-box">
                        <div>
                          <small>WEBHOOK ENDPOINT</small>
                          <code>{client.webhookUrl || "Save this client to generate its endpoint."}</code>
                        </div>
                        <button onClick={copyWebhook} disabled={!client.webhookUrl}>
                          Copy
                        </button>
                      </div>
                      <div className="panel-actions">
                        <button className="text-button" onClick={() => setActive("audit")}>
                          View event log →
                        </button>
                      </div>
                    </section>
                    <section className="admin-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Client profile</h2>
                          <p>This context powers scoring and reply drafts.</p>
                        </div>
                        <span className="saved-dot">● Auto-saved</span>
                      </div>
                      <label className="field-label">
                        DISPLAY NAME
                        <input value={workspaceDraft.name} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, name: event.target.value }))} placeholder="Enter display name" />
                      </label>
                      <label className="field-label">
                        CLIENT BRIEF
                        <textarea value={workspaceDraft.brief} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, brief: event.target.value }))} placeholder="Add a short client brief" />
                      </label>
                      <div className="field-row">
                        <label className="field-label">
                          TIMEZONE
                          <select value={workspaceDraft.timezone} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, timezone: event.target.value }))}>
                            <option value="America/New_York">Eastern Time — New York (default)</option>
                            <option value="America/Chicago">Central Time — Chicago</option>
                            <option value="America/Los_Angeles">Pacific Time — Los Angeles</option>
                            <option value="Pacific/Honolulu">Hawaii Time — Honolulu</option>
                            <option value="Europe/London">London</option>
                          </select>
                        </label>
                        <label className="field-label">
                          CLIENT WEBSITE
                          <input value={workspaceDraft.website} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, website: event.target.value }))} placeholder="https://client.example" type="url" />
                        </label>
                      </div>
                      <div className="field-row">
                        <label className="field-label">
                          WORKSPACE SLUG
                          <input value={workspaceDraft.slug} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, slug: event.target.value }))} placeholder="Enter workspace slug" />
                        </label>
                        <label className="field-label">
                          QC BRAIN FOLDER
                          <select value={workspaceDraft.brainFolder} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, brainFolder: event.target.value }))}>
                            <option value="">
                              {guessedFolder.folder ? `Matched automatically — clients/${guessedFolder.folder}` : "No folder matched this name"}
                            </option>
                            {brainFolders.map((folder) => (
                              <option key={folder} value={folder}>clients/{folder}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <p className="brain-link-note">
                        {/* Named plainly, because the consequence of getting it wrong is invisible: the
                            wrong client's reply rates would appear under this client's strategy notes,
                            and nothing on the page would look broken. */}
                        {workspaceDraft.brainFolder
                          ? `This workspace is pinned to clients/${workspaceDraft.brainFolder} in the QC Brain. Its context, campaign figures and logo are joined there.`
                          : guessedFolder.folder
                            ? guessedFolder.how === "loose"
                              ? `Guessed from the name — clients/${guessedFolder.folder}. The names are close but not identical, so it is worth confirming.`
                              : `Matched on the ${guessedFolder.how === "slug" ? "slug" : "display name"} — clients/${guessedFolder.folder}. Pick a folder above only if that is wrong.`
                            : brainFolders.length
                              ? "Nothing in the QC Brain matches this name. Pick the folder this client is written up in, if there is one."
                              : "The QC Brain has not been reached, so folders cannot be listed yet."}
                      </p>
                    </section>
                  </div>}
                    {workspaceOpen && <div className="client-config-sections">
                    <section className="admin-panel client-config-section" id="client-slack">
                      <div className="panel-heading"><div><h2>Slack channels</h2><p>Where this client&apos;s briefs are read and posted.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <div className="field-row">
                        <label className="field-label">
                          MAIN · INTERNAL CHANNEL ID
                          <input value={workspaceDraft.slackInternal} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, slackInternal: event.target.value }))} placeholder="C09ABCDEF" />
                        </label>
                        <label className="field-label">
                          MAIN · EXTERNAL CHANNEL ID
                          <input value={workspaceDraft.slackExternal} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, slackExternal: event.target.value }))} placeholder="C09XYZ123" />
                        </label>
                      </div>
                      {/* Named plainly because both mistakes here are silent. A channel name instead of an
                          id saves without complaint and resolves to nothing; the two ids the wrong way
                          round sends the team's own notes to the client. */}
                      <p className="slack-channel-note">{slackChannelNote}</p>
                      {/* Marked as extras in the label as well as by position, because the prompt ranks
                          them below the two above and somebody who thought this was a third equal channel
                          would read the brief as having ignored it. */}
                      <ExtraRows
                        label="EXTRA CHANNELS"
                        values={workspaceDraft.slackExtra}
                        placeholder="C09MOREID"
                        onChange={(next) => setWorkspaceDraft((draft) => ({ ...draft, slackExtra: next }))}
                      />
                    </section>
                    <section className="admin-panel client-config-section" id="client-granola">
                      <div className="panel-heading"><div><h2>Call transcripts</h2><p>Which Granola meeting belongs to this client.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <label className="field-label">
                        MAIN CALL · MEETING TITLE CONTAINS
                        <input value={workspaceDraft.granolaTitleMatch} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, granolaTitleMatch: event.target.value }))} placeholder={workspaceDraft.name || "Bluevia"} />
                      </label>
                      {/* Blank is the normal case: the client's own name is used. This is for when the
                          calendar calls them something else — the account is "Vitalic Health" and the
                          invite says "Vitalic" — and takes a comma-separated list. */}
                      <p className="slack-channel-note">{granolaTitleNote}</p>
                      {/* One meeting per row, not more entries in the field above: everything in that
                          field is an alternate spelling of the *same* call, so a weekly internal meeting
                          typed there would become this client's "last call" whenever it ran latest. */}
                      <ExtraRows
                        label="EXTRA MEETINGS"
                        values={workspaceDraft.granolaExtra}
                        placeholder="QC internal weekly"
                        onChange={(next) => setWorkspaceDraft((draft) => ({ ...draft, granolaExtra: next }))}
                      />
                      {extraCallNote && <p className="slack-channel-note">{extraCallNote}</p>}
                    </section>
                    <section className="admin-panel client-config-section" id="client-airtable">
                      <div className="panel-heading"><div><h2>Airtable base</h2><p>Which base this client&apos;s action items are written to.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <label className="field-label">
                        CLIENT BASE
                        {/* The guess is the placeholder option, not the value. Selecting it is the
                            confirmation — an Airtable base is another company's project tracker, so a
                            name that merely looks right is not enough to start writing into it. */}
                        <select value={workspaceDraft.airtableBaseId} onChange={(event) => setWorkspaceDraft((draft) => ({ ...draft, airtableBaseId: event.target.value }))}>
                          <option value="">
                            {guessedBase.how === "ambiguous"
                              ? `${guessedBase.candidates.length} bases match — choose one`
                              : guessedBase.baseId ? `Not set — ${guessedBase.name} looks right` : "Not set — nothing written to Airtable"}
                          </option>
                          {airtableBases.map((base) => (
                            <option key={base.id} value={base.id}>{base.name}</option>
                          ))}
                        </select>
                      </label>
                      <p className="slack-channel-note">{airtableNote}</p>
                      {tracker && !tracker.ready && (
                        <button className="secondary-button" type="button" onClick={buildTrackers} disabled={buildState === "building"}>
                          {buildState === "building" ? "Building" : "Build the tables"}
                        </button>
                      )}
                      {buildNote && <p className="slack-channel-note">{buildNote}</p>}
                    </section>
                    <section className="admin-panel client-config-section" id="client-theme">
                      <div className="panel-heading"><div><h2>Theme & logo</h2><p>Brand this client's workspace without changing other clients.</p></div><span className="saved-dot">● Auto-saved</span></div>
                      <div className="logo-drop">{workspaceLogo ? <img className="logo-sample" src={workspaceLogo} alt={`${client.name} logo`} /> : <div className="logo-sample" style={{ background: accentColor }}>{client.name[0] || "?"}</div>}<div><strong>Upload client logo</strong><small>SVG, PNG, JPG · max 2MB</small></div><button className="secondary-button" type="button" onClick={chooseLogo}>Choose file</button><input ref={logoInput} type="file" accept="image/png,image/jpeg,image/svg+xml" hidden onChange={handleLogo} /></div>
                      <label className="field-label">CLIENT ACCENT<input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} /></label>
                    </section>
                  </div>}
                  {workspaceOpen && <div className="workspace-config-footer"><div className="workspace-created-meta">Created {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : "—"}</div>{!isNewWorkspace && <button className="remove-workspace-button" onClick={requestRemoveWorkspace}>Remove workspace</button>}</div>}
                </>
              )}
              {active === "ai-hub" && <AiHubView />}
              {active === "granola" && <GranolaKeysView />}
              {active === "ai" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Anthropic configuration</h2>
                        <p>
                          Drafting and scoring for {client.name} run through the
                          Anthropic API.
                        </p>
                      </div>
                      <span className="connection-badge">
                        <i /> Connected
                      </span>
                    </div>
                    <label className="field-label">
                      MODEL
                      <select defaultValue="">
                        <option value="">Select model</option>
                        <option>claude-opus-4-1-20250805</option>
                        <option>claude-opus-4-6</option>
                        <option>claude-sonnet-4-6</option>
                        <option>claude-haiku-4-5-20251001</option>
                      </select>
                    </label>
                    <label className="field-label">
                      ANTHROPIC API KEY
                      <div className="secret-field">
                        <input value="sk-ant-api03-••••••••••••••••" readOnly />
                        <button>Reveal</button>
                      </div>
                    </label>
                    <div className="field-row">
                      <label className="field-label">
                        TEMPERATURE
                        <input type="number" placeholder="Set temperature" step="0.05" />
                      </label>
                      <label className="field-label">
                        MONTHLY SPEND CAP
                        <input placeholder="Set monthly spend cap" />
                      </label>
                    </div>
                    <div className="usage-meter">
                      <div>
                        <span>Current usage</span>
                        <strong>—</strong>
                      </div>
                      <div>
                        <i style={{ width: "0%" }} />
                      </div>
                    </div>
                  </section>
                </div>
              )}
              {active === "scoring" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Signal weights</h2>
                        <p>Adjust how {client.name}'s queue is ranked.</p>
                      </div>
                      <span className="saved-dot">● Draft config</span>
                    </div>
                    {["Unanswered question", "Reply depth", "Meeting language", "Response speed", "Time decay"].map((name) => (
                      <div className="range-row" key={name}>
                        <div>
                          <span>{name}</span>
                          <strong>—</strong>
                        </div>
                        <input
                          type="range"
                          defaultValue="0"
                        />
                      </div>
                    ))}
                    <div className="preview-score">
                      <span>Preview with current rules</span>
                      <strong>
                        No synced lead data <b>—</b>
                      </strong>
                      <small>
                        No synced conversation is available yet.
                      </small>
                    </div>
                  </section>
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Tier thresholds</h2>
                        <p>Labels are always paired with score and reason.</p>
                      </div>
                    </div>
                    <div className="threshold hot-threshold">
                      <span>HOT</span>
                      <input placeholder="Set threshold" />
                      <small>Priority reply within 24 hours</small>
                    </div>
                    <div className="threshold warm-threshold">
                      <span>WARM</span>
                      <input placeholder="Set threshold" />
                      <small>Follow up this week</small>
                    </div>
                    <div className="threshold nurture-threshold">
                      <span>NURTURE</span>
                      <input placeholder="Set threshold" />
                      <small>Keep warm or snooze</small>
                    </div>
                    <div className="threshold dead-threshold">
                      <span>DEAD</span>
                      <input placeholder="Set threshold" />
                      <small>No action required</small>
                    </div>
                  </section>
                </div>
              )}
              {active === "theme" && (
                <div className="admin-grid">
                  <section className="admin-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Theme presets</h2>
                        <p>
                          Theme and branding settings for {client.name} only.
                        </p>
                      </div>
                    </div>
                    <div className="theme-presets">
                      <button
                        onClick={() => setThemePreset("midnight")}
                        className={`theme-preview midnight-preview ${themePreset === "midnight" ? "selected" : ""}`}
                      >
                        <span />
                        Midnight
                      </button>
                      <button
                        onClick={() => setThemePreset("slate")}
                        className={`theme-preview slate-preview ${themePreset === "slate" ? "selected" : ""}`}
                      >
                        <span />
                        Slate
                      </button>
                      <button
                        onClick={() => setThemePreset("paper")}
                        className={`theme-preview paper-preview ${themePreset === "paper" ? "selected" : ""}`}
                      >
                        <span />
                        Paper
                      </button>
                      <button
                        onClick={() => setThemePreset("contrast")}
                        className={`theme-preview contrast-preview ${themePreset === "contrast" ? "selected" : ""}`}
                      >
                        <span />
                        High contrast
                      </button>
                    </div>
                    <div className="field-row">
                      <label className="field-label">
                        ACCENT COLOR
                        <input
                          type="color"
                          value={accentColor}
                          onChange={(event) =>
                            setAccentColor(event.target.value)
                          }
                        />
                      </label>
                      <label className="field-label">
                        ROW DENSITY
                        <select defaultValue="">
                          <option value="">Select row density</option>
                          <option>Compact</option>
                          <option>Comfortable</option>
                          <option>Spacious</option>
                        </select>
                      </label>
                    </div>
                  </section>
                  <section className="admin-panel token-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Workspace branding</h2>
                        <p>{client.name} override</p>
                      </div>
                    </div>
                    <div className="logo-drop">
                      {workspaceLogo ? (
                        <img
                          className="logo-sample"
                          src={workspaceLogo}
                          alt={`${client.name} logo`}
                        />
                      ) : (
                        <div
                          className="logo-sample"
                          style={{ background: client.tone }}
                        >
                          {client.name[0]}
                        </div>
                      )}
                      <div>
                        <strong>Upload client logo</strong>
                        <small>SVG, PNG, JPG · max 2MB</small>
                      </div>
                      <input
                        ref={logoInput}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml"
                        onChange={handleLogo}
                        hidden
                      />
                      <button className="secondary-button" type="button" onClick={chooseLogo}>
                        Choose file
                      </button>
                    </div>
                    <label className="field-label">
                      CLIENT ACCENT
                      <input
                        type="text"
                        value={accentColor}
                        onChange={(event) => setAccentColor(event.target.value)}
                      />
                    </label>
                    <div className="contrast-check">
                      <i /> WCAG AA contrast passes <span>6.8:1</span>
                    </div>
                  </section>
                </div>
              )}
            </section>
          </div>
        </main>
      </section>
      {passwordOpen && <div className="help-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-workspace-title"><div className="help-card delete-confirm-card"><button className="help-close" onClick={() => setPasswordOpen(false)} aria-label="Cancel">×</button><h2 id="delete-workspace-title">Remove workspace?</h2><p>This permanently removes {client.name || "this workspace"} from the local workspace directory. Enter the admin password to continue.</p><label className="field-label">ADMIN PASSWORD<input type="password" value={workspacePassword} onChange={(event) => setWorkspacePassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && confirmRemoveWorkspace()} /></label>{passwordError && <p className="delete-password-error">{passwordError}</p>}<div className="delete-confirm-actions"><button className="secondary-button" onClick={() => setPasswordOpen(false)}>Cancel</button><button className="primary-button delete-danger-button" onClick={confirmRemoveWorkspace}>Remove workspace</button></div></div></div>}
    </div>
  );
}

function HeartbeatView({ heartbeat, onRefresh }: { heartbeat: HeartbeatPayload | null; onRefresh: () => void }) {
  const [detail, setDetail] = useState<"basic" | "advanced">("basic");
  const formatAge = (seconds: number | null) => {
    if (seconds === null) return "never";
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${days}d ${hours}h ${minutes}m ${String(secs).padStart(2, "0")}s ago`;
  };
  return (
    <div className="heartbeat-view">
      <div className="heartbeat-summary admin-panel">
        <div><span className="eyebrow"><span className="live-dot" /> LIVE PULSE</span><h2>{heartbeat?.status === "live" ? "Reply Radar finished its checkup" : heartbeat?.status === "not_configured" ? "Setup is not finished" : "Checking Reply Radar…"}</h2><p>Think of this page as a check-engine light for the database, AI, worker, and each client connection.</p></div>
        <div className="health-actions"><div className="segmented-control"><button className={detail === "basic" ? "active" : ""} onClick={() => setDetail("basic")}>Basic view</button><button className={detail === "advanced" ? "active" : ""} onClick={() => setDetail("advanced")}>Advanced view</button></div><button className="secondary-button" onClick={onRefresh}>Refresh checks ↻</button></div>
      </div>
      <div className="heartbeat-service-grid">{(heartbeat?.services ?? []).map((service) => <div className="heartbeat-service admin-panel" key={service.id}><i className={service.configured ? "heartbeat-ok" : "heartbeat-missing"} /><div><strong>{service.label}</strong><small>{service.configured ? "Ready to use" : "Needs setup"}</small><small>{service.explanation}</small></div></div>)}</div>
      <section className="admin-panel"><div className="panel-heading"><div><h2>Worker heartbeat</h2><p>The worker is a robot helper that wakes up, checks every client, and reports what happened.</p></div><span className={`health-state ${heartbeat?.worker?.status === "running" ? "ready" : "missing"}`}>{heartbeat?.worker?.status === "running" ? "Running" : "Needs attention"}</span></div><div className="heartbeat-log-list"><div><strong>Did the helper check in?</strong><span>{heartbeat?.worker ? `Yes — ${formatAge(heartbeat.worker.ageSeconds)}` : "No check-in found yet"}</span></div><div><strong>How many clients did it check?</strong><span>{heartbeat?.worker?.workspacesSeen ?? 0}</span></div><div><strong>Did it finish normally?</strong><span>{heartbeat?.worker?.error ? `No — ${heartbeat.worker.error}` : heartbeat?.worker ? "No error was reported" : "Waiting for the first run"}</span></div></div>{detail === "advanced" && <details className="diagnostic-details" open><summary>Worker timestamps, counters, recent runs, and raw row</summary><pre>{JSON.stringify(heartbeat?.worker ?? null, null, 2)}</pre></details>}</section>
      <section className={`admin-panel ai-ark-health ${heartbeat?.aiArk?.status === "attention" || heartbeat?.aiArk?.status === "not_configured" ? "has-alert" : ""}`}><div className="panel-heading"><div><h2>AI Ark enrichment</h2><p>We compare real API calls with recently stored LinkedIn leads. More than five failures triggers an alert.</p></div><span className={`health-state ${heartbeat?.aiArk?.status === "healthy" ? "ready" : heartbeat?.aiArk?.status === "disabled" ? "neutral" : "missing"}`}>{heartbeat?.aiArk?.status === "healthy" ? "Healthy" : heartbeat?.aiArk?.status === "disabled" ? "Globally disabled" : "Needs attention"}</span></div><p className="ai-ark-health-explanation">{heartbeat?.aiArk?.explanation ?? "Waiting for the first check."}</p><div className="heartbeat-kid-grid ai-ark-health-grid"><div className={heartbeat?.aiArk?.configured || !heartbeat?.aiArk?.enabled ? "ok" : "bad"}><b>{heartbeat?.aiArk?.configured || !heartbeat?.aiArk?.enabled ? "✓" : "!"}</b><span><strong>Global switch and key</strong><small>{heartbeat?.aiArk?.enabled ? heartbeat?.aiArk?.configured ? "Enabled and configured." : "Enabled, but the API key is missing." : "Disabled in Vercel."}</small></span></div><div className={(heartbeat?.aiArk?.failures24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat?.aiArk?.failures24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>Calls · last 24 hours</strong><small>{heartbeat?.aiArk?.successes24h ?? 0} successful · {heartbeat?.aiArk?.failures24h ?? 0} failed</small></span></div><div className={(heartbeat?.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "bad" : "ok"}><b>{(heartbeat?.aiArk?.unenrichedLeads24h ?? 0) > 5 ? "!" : "✓"}</b><span><strong>Missing enrichment</strong><small>{heartbeat?.aiArk?.unenrichedLeads24h ?? 0} recent LinkedIn lead(s)</small></span></div></div>{detail === "advanced" && <details className="diagnostic-details" open><summary>AI Ark failures, counts, and raw run records</summary><pre>{JSON.stringify(heartbeat?.aiArk ?? null, null, 2)}</pre></details>}</section>
      <section className="admin-panel"><div className="panel-heading"><div><h2>Client connection heartbeat</h2><p>Each client needs three things: a key, incoming webhook replies, and a recent background poll.</p></div></div><div className="heartbeat-client-list">{heartbeat?.clients?.length ? heartbeat.clients.map((item) => {
        const keyHealthy = item.keyConfigured;
        const webhookHealthy = item.webhookAgeSeconds !== null && item.webhookAgeSeconds <= Number(heartbeat?.thresholds?.webhookFreshSeconds ?? 1800);
        const pollHealthy = item.pollAgeSeconds !== null && item.pollAgeSeconds <= Number(heartbeat?.thresholds?.pollFreshSeconds ?? 3600);
        return <div className="heartbeat-client" key={item.slug}><div className="heartbeat-client-title"><div className="heartbeat-client-name"><i style={item.logoUrl ? undefined : { background: "var(--accent)" }}>{item.logoUrl ? <img src={item.logoUrl} alt={`${item.name} logo`} /> : item.name[0]}</i><strong>{item.name}</strong></div><span className={item.status === "healthy" ? "health-state ready" : "health-state missing"}>{item.status === "healthy" ? "Everything works" : item.status === "missing" ? "API key missing" : "Needs attention"}</span></div><div className="heartbeat-kid-grid"><div className={keyHealthy ? "ok" : "bad"}><b>{keyHealthy ? "✓" : "!"}</b><span><strong>Door key</strong><small>{keyHealthy ? "Reply Radar can ask HeyReach for updates." : "Add this client’s HeyReach key."}</small></span></div><div className={webhookHealthy ? "ok" : "bad"}><b>{webhookHealthy ? "✓" : "!"}</b><span><strong>Incoming replies</strong><small>{item.webhookStatus ?? "No webhook information."}</small></span></div><div className={pollHealthy ? "ok" : "bad"}><b>{pollHealthy ? "✓" : "!"}</b><span><strong>Background check</strong><small>{item.pollStatus ?? "No poll information."}</small></span></div></div>{detail === "advanced" && <details className="diagnostic-details"><summary>Full client timestamps, recent runs, webhook events, and sanitized database row</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>}</div>;
      }) : <div className="heartbeat-empty">No clients were found. Add a client and start the Render worker to begin checks.</div>}</div></section>
      {detail === "advanced" && <section className="admin-panel"><div className="panel-heading"><div><h2>Full diagnostic payload</h2><p>Runtime flags, freshness thresholds, query status codes, timings, row counts, recent sync runs, and webhook events. Secrets are never included.</p></div></div><details className="diagnostic-details" open><summary>Raw heartbeat JSON</summary><pre>{JSON.stringify(heartbeat, null, 2)}</pre></details></section>}
      <p className="heartbeat-last-checked">Last checked {heartbeat?.checkedAt ? new Date(heartbeat.checkedAt).toLocaleString() : "not yet"}</p>
    </div>
  );
}

type FeedbackEvent = {
  id: string;
  author: string;
  comment: string;
  /** Null when the update was a comment that did not move the report along. */
  status: string | null;
  createdAt: string;
};
type FeedbackItem = {
  id: string;
  kind: string;
  message: string;
  submittedBy: string | null;
  page: string | null;
  status: string;
  screenshot: string | null;
  /** Every signed update since it was reported, oldest first. */
  history: FeedbackEvent[];
  createdAt: string;
  updatedAt: string;
};
const feedbackStages = [
  ["new", "New"],
  ["viewed", "Viewed"],
  ["working", "Working on"],
  ["fixed", "Fixed"],
] as const;
const feedbackKinds = [
  ["bug", "Bug"],
  ["idea", "Idea"],
  ["other", "Something else"],
] as const;
const feedbackStageLabel = (status: string) => feedbackStages.find(([value]) => value === status)?.[1] ?? status;
/** Where the sign-off name is kept, so nobody types it again on every update. */
const FEEDBACK_AUTHOR_KEY = "reply-radar-feedback-author";

/**
 * Reads an image file as a data URL small enough to live in a text column.
 *
 * A screenshot off a modern display is several megabytes, and none of that resolution survives
 * being looked at in a card, so it is redrawn at a sane width and re-encoded as JPEG. Doing it
 * in the browser means the upload is already the size it will be stored at.
 */
const readScreenshot = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.onload = () => {
      const source = String(reader.result);
      const image = new Image();
      image.onerror = () => reject(new Error("That image could not be read."));
      image.onload = () => {
        const scale = Math.min(1, 1600 / (image.width || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        // No 2D context is not worth an error path: the original is already in hand, and the
        // server's size cap is the thing that actually protects the table.
        if (!context) {
          resolve(source);
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      image.src = source;
    };
    reader.readAsDataURL(file);
  });

type GranolaKeyRow = { id: string; label: string; masked: string; lastCheckedAt: string | null; lastStatus: string; lastError: string };
/** What one Test found: the meetings this key can see, and the window they were looked for in. */
type GranolaSighting = { windowDays: number; meetings: Array<{ title: string; startedAt: string }> };

/**
 * One Granola key per teammate.
 *
 * A key sees only its owner's meetings, so no single key covers the roster — Kiril is not on the Bluevia
 * weekly and Kori is not on the Cotool one. Ten keys between them do cover it, which is why this is a
 * list anyone can add to rather than one field in an environment variable.
 *
 * Keys never come back from the server: what is listed is the last four characters. Editing a key is
 * therefore removing it and adding the new one, which is deliberate — an amendable field would have to
 * be pre-filled, and pre-filling means the key travels back to a browser.
 */
function GranolaKeysView() {
  const [keys, setKeys] = useState<GranolaKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [sightings, setSightings] = useState<Record<string, GranolaSighting>>({});

  const load = async () => {
    const response = await fetch("/api/granola/keys", { cache: "no-store" }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok) {
      setError(String(payload?.error || "The Granola keys could not be read."));
      setKeys([]);
    } else {
      setError("");
      setKeys(Array.isArray(payload?.keys) ? payload.keys : []);
    }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const addKey = async () => {
    setSaving(true);
    setError("");
    const response = await fetch("/api/granola/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label.trim(), apiKey: apiKey.trim() }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setSaving(false);
    if (!response?.ok || !payload?.ok) {
      setError(String(payload?.error || "The key could not be saved."));
      return;
    }
    setLabel("");
    setApiKey("");
    await load();
  };

  /*
   * Test says what the key can see, not only that it works.
   *
   * The meetings are held per key on the page rather than stored, because they are a live answer to "which
   * client's calls are on this key" and a stored one would be read weeks later as though it were current.
   */
  const checkKey = async (id: string) => {
    setBusyId(id);
    const response = await fetch("/api/granola/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "check", id }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    setSightings((current) => ({
      ...current,
      [id]: {
        windowDays: Number(payload?.windowDays ?? 0),
        meetings: Array.isArray(payload?.meetings) ? (payload.meetings as GranolaSighting["meetings"]) : [],
      },
    }));
    setBusyId("");
    await load();
  };

  const removeKey = async (id: string) => {
    setBusyId(id);
    await fetch(`/api/granola/keys?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    setBusyId("");
    await load();
  };

  const working = keys.filter((key) => key.lastStatus !== "error").length;
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h2>Granola keys</h2>
          {/* Two counts, because the gap between them is the whole point: a key that stopped working
              still looks like coverage on the morning brief grid until somebody checks it. */}
          <p className="release-count"><b>{working}</b> of {keys.length} working</p>
        </div>
        <a className="filter-button" href="https://granola.ai" target="_blank" rel="noreferrer">Granola → Settings → API</a>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="granola-key-form">
        <label className="field-label">WHOSE KEY<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Kiril" /></label>
        <label className="field-label">API KEY<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="grn_…" autoComplete="off" spellCheck={false} /></label>
        <button className="primary-button" type="button" onClick={addKey} disabled={saving || !label.trim() || !apiKey.trim()}>{saving ? "Checking…" : "Add key"}</button>
      </div>
      {loading ? <p className="feedback-empty">Loading…</p> : keys.length === 0 ? <p className="feedback-empty">No keys yet. Without one, briefs go out without the client&apos;s call.</p> : (
        <ul className="granola-key-list">
          {keys.map((key) => (
            <li key={key.id} className={key.lastStatus === "error" ? "granola-key broken" : "granola-key"}>
              <div className="granola-key-who">
                <strong>{key.label || "Unnamed"}</strong>
                <code>{key.masked}</code>
              </div>
              <div className="granola-key-state">
                <span className={key.lastStatus === "error" ? "granola-key-badge broken" : "granola-key-badge"}>{key.lastStatus === "error" ? "Not working" : "Working"}</span>
                {key.lastCheckedAt && <small>Checked {new Date(key.lastCheckedAt).toLocaleDateString()}</small>}
              </div>
              {key.lastError && <p className="granola-key-error">{key.lastError}</p>}
              <div className="granola-key-actions">
                <button className="secondary-button" type="button" onClick={() => checkKey(key.id)} disabled={busyId === key.id}>{busyId === key.id ? "…" : "Test"}</button>
                <button className="text-button" type="button" onClick={() => removeKey(key.id)} disabled={busyId === key.id}>Remove</button>
              </div>
              {sightings[key.id] && (
                <div className="granola-key-meetings">
                  {sightings[key.id].meetings.length === 0 ? (
                    <p className="granola-key-meetings-empty">No meetings in the last {sightings[key.id].windowDays || 14} days.</p>
                  ) : (
                    <ul>
                      {sightings[key.id].meetings.map((meeting, index) => (
                        <li key={`${meeting.startedAt}-${index}`}>
                          <span>{meeting.title}</span>
                          <small>{new Date(meeting.startedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Release = { sha: string; shortSha: string; date: string; author: string; summary: string; url: string };
/** Five, then five more. Long enough to see the last few days, short enough not to bury the form below it. */
const RELEASE_PAGE = 5;

/**
 * What has shipped, straight from the commit history.
 *
 * It sits in the feedback tab because it answers the question feedback provokes: "was that fixed yet?"
 * Nothing here is written by hand — every entry is a real commit, so the log cannot fall out of date
 * and there is no step anyone has to remember after a release.
 */
function ReleaseHistory() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [total, setTotal] = useState(0);
  const [repoUrl, setRepoUrl] = useState("https://github.com/kirilQC/reply-radar");
  const [shown, setShown] = useState(RELEASE_PAGE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/releases", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        // The repo link is served even when the history is not, so it is read before the error check.
        if (typeof payload.repoUrl === "string") setRepoUrl(payload.repoUrl);
        if (!response.ok || !payload.ok) throw new Error(payload.error || "The commit history could not be loaded.");
        setReleases(Array.isArray(payload.releases) ? payload.releases : []);
        setTotal(Number(payload.total) || 0);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The commit history could not be loaded.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visible = releases.slice(0, shown);
  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h2>Release history</h2>
          {/* The count is every commit on the branch, not the length of the list below it — the list
              is one page of the most recent, and saying "5 changes" would undersell the project. It is
              set as a figure rather than a sentence because it is the one number on this panel worth
              reading, and in body copy it was the same size as the word "shipped" beside it. */}
          {total ? (
            <p className="release-count">
              <b>{total.toLocaleString()}</b> change{total === 1 ? "" : "s"} shipped
            </p>
          ) : (
            <p>Every change to Reply Radar, newest first.</p>
          )}
        </div>
        <a className="filter-button" href={repoUrl} target="_blank" rel="noreferrer">View the repo</a>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {loading && <p className="feedback-empty">Loading…</p>}
      {!loading && !error && !visible.length && <p className="feedback-empty">No commits found.</p>}
      {visible.length > 0 && (
        <ol className="release-list">
          {visible.map((release) => (
            <li key={release.sha}>
              <div className="release-meta">
                <time dateTime={release.date}>{new Date(release.date).toLocaleString()}</time>
                <span className="release-author">{release.author}</span>
              </div>
              <a className="release-summary" href={release.url} target="_blank" rel="noreferrer">
                {release.summary}
                <code>{release.shortSha}</code>
              </a>
            </li>
          ))}
        </ol>
      )}
      {shown < releases.length && (
        <button type="button" className="release-more" onClick={() => setShown((value) => value + RELEASE_PAGE)}>
          View {Math.min(RELEASE_PAGE, releases.length - shown)} more
        </button>
      )}
    </section>
  );
}

function FeedbackView() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<string>("bug");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [signed, setSigned] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [shot, setShot] = useState("");
  const [expanded, setExpanded] = useState("");
  /** Which report's update form is open. Only one at a time — these are written one by one. */
  const [logOpen, setLogOpen] = useState("");
  const [logComment, setLogComment] = useState("");
  const [logStatus, setLogStatus] = useState("");
  const [posting, setPosting] = useState(false);
  const [author, setAuthor] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(FEEDBACK_AUTHOR_KEY) ?? "";
  });

  const load = async () => {
    try {
      const response = await fetch("/api/feedback", { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Feedback could not be loaded.");
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Feedback could not be loaded.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const submit = async () => {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only send a name when the reporter opted in, so the anonymous path never
        // depends on the server ignoring a value we shipped anyway.
        body: JSON.stringify({ kind, message, submittedBy: signed ? name : "", page: window.location.pathname, screenshot: shot }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Submitting failed.");
      setMessage("");
      setShot("");
      setSent(true);
      window.setTimeout(() => setSent(false), 4000);
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Submitting failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const pickShot = async (file: File | undefined) => {
    if (!file) return;
    try {
      setShot(await readScreenshot(file));
    } catch (shotError) {
      setError(shotError instanceof Error ? shotError.message : "That image could not be read.");
    }
  };

  const openLog = (item: FeedbackItem) => {
    // The form opens on where the report already stands, so posting a comment without touching
    // the buttons does not silently look like a status change.
    setLogOpen(item.id);
    setLogStatus(item.status);
    setLogComment("");
  };

  /**
   * Posts a signed update. Not optimistic: the whole value of the log is that what is on screen
   * is what was recorded, so the row is replaced with what the server actually stored.
   */
  const postUpdate = async (item: FeedbackItem) => {
    const moved = logStatus && logStatus !== item.status ? logStatus : "";
    if (!author.trim() || posting || (!moved && !logComment.trim())) return;
    setPosting(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, status: moved, comment: logComment, author }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || "The update could not be saved.");
      window.localStorage.setItem(FEEDBACK_AUTHOR_KEY, author.trim());
      if (payload.item) setItems((current) => current.map((row) => (row.id === item.id ? payload.item : row)));
      else await load();
      setLogOpen("");
      setLogComment("");
      setError("");
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "The update could not be saved.");
    } finally {
      setPosting(false);
    }
  };
  const remove = async (item: FeedbackItem) => {
    setItems((current) => current.filter((row) => row.id !== item.id));
    const response = await fetch("/api/feedback", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }) });
    if (!response.ok) void load();
  };

  const visible = statusFilter ? items.filter((item) => item.status === statusFilter) : items;
  return (
    <div className="feedback-view">
      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Send feedback</h2></div></div>
        <div className="feedback-form">
          <div className="feedback-kind">
            {feedbackKinds.map(([value, label]) => (
              <button key={value} type="button" className={kind === value ? "selected" : ""} onClick={() => setKind(value)}>{label}</button>
            ))}
          </div>
          <label className="field-label">WHAT HAPPENED<textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={6} placeholder="What were you doing, what did you expect, and what happened instead?" /></label>
          <div className="feedback-attach">
            {/* The file input is inside its own label, which is both the accessible name and the
                thing that gets styled — a bare file input cannot be made to look like anything. */}
            <label className="feedback-attach-button">
              {shot ? "Replace screenshot" : "Attach a screenshot"}
              <input type="file" accept="image/*" onChange={(event) => void pickShot(event.target.files?.[0])} />
            </label>
            {shot && (
              <span className="feedback-attach-preview">
                <img src={shot} alt="The screenshot attached to this report" />
                <button type="button" onClick={() => setShot("")} aria-label="Remove the screenshot">×</button>
              </span>
            )}
          </div>
          <div className="feedback-identity">
            <button type="button" className={`feedback-anon-toggle ${signed ? "" : "anonymous"}`} onClick={() => setSigned((value) => !value)}>
              {signed ? "Signing this" : "Staying anonymous"}
            </button>
            {signed && <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" aria-label="Your name" />}
            <button type="button" className="primary-button" onClick={() => void submit()} disabled={submitting || !message.trim()}>
              {submitting ? "Sending…" : "Submit"}
            </button>
          </div>
          {sent && <p className="feedback-sent" role="status">Thanks — that landed.</p>}
        </div>
      </section>
      <section className="admin-panel">
        <div className="panel-heading">
          <div><h2>Submitted feedback</h2><p>{items.length} item{items.length === 1 ? "" : "s"}. Move each one along as you work through it.</p></div>
          <select className="filter-button" aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">All statuses</option>
            {feedbackStages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading && <p className="feedback-empty">Loading…</p>}
        {!loading && !visible.length && <p className="feedback-empty">Nothing here yet.</p>}
        <div className="feedback-list">
          {visible.map((item) => (
            <article key={item.id} className={`feedback-card status-${item.status}`}>
              <header>
                <span className={`feedback-kind-tag kind-${item.kind}`}>{feedbackKinds.find(([value]) => value === item.kind)?.[1] ?? item.kind}</span>
                <span className="feedback-byline">{item.submittedBy ?? "Anonymous"}</span>
                <span className="feedback-stamp">{new Date(item.createdAt).toLocaleString()}</span>
                <button type="button" className="feedback-delete" aria-label="Delete this feedback" onClick={() => void remove(item)}>×</button>
              </header>
              <p>{item.message}</p>
              {item.screenshot && (
                // Clicking the shot gives it the full width of the card. A data URL cannot be
                // opened in a tab, so growing in place is the only way to see the detail.
                <button
                  type="button"
                  className={`feedback-shot ${expanded === item.id ? "is-expanded" : ""}`}
                  onClick={() => setExpanded((current) => (current === item.id ? "" : item.id))}
                  aria-label={expanded === item.id ? "Shrink the screenshot" : "Enlarge the screenshot"}
                >
                  <img src={item.screenshot} alt="The screenshot attached to this report" />
                </button>
              )}
              {item.history.length > 0 && (
                <ol className="feedback-log">
                  {item.history.map((entry) => (
                    <li key={entry.id}>
                      <span className="feedback-log-head">
                        <b>{entry.author}</b>
                        {entry.status && <span className={`feedback-log-move stage-${entry.status}`}>{feedbackStageLabel(entry.status)}</span>}
                        <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
                      </span>
                      {entry.comment && <p>{entry.comment}</p>}
                    </li>
                  ))}
                </ol>
              )}
              <footer>
                <span className={`feedback-stage stage-${item.status}`}>{feedbackStageLabel(item.status)}</span>
                <button
                  type="button"
                  className="feedback-update-toggle"
                  onClick={() => (logOpen === item.id ? setLogOpen("") : openLog(item))}
                >
                  {logOpen === item.id ? "Cancel" : "Add update"}
                </button>
              </footer>
              {logOpen === item.id && (
                <div className="feedback-update">
                  <div className="feedback-kind">
                    {feedbackStages.map(([value, label]) => (
                      <button key={value} type="button" className={logStatus === value ? "selected" : ""} onClick={() => setLogStatus(value)}>{label}</button>
                    ))}
                  </div>
                  <textarea
                    value={logComment}
                    onChange={(event) => setLogComment(event.target.value)}
                    rows={3}
                    placeholder="What you found, what changed, what is left to do."
                    aria-label="Update comment"
                  />
                  <div className="feedback-identity">
                    <input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Signed by" aria-label="Sign this update with your name" />
                    <button
                      type="button"
                      className="primary-button"
                      // A name is required, and so is something to record: an update that neither
                      // moves the status nor says anything would be an empty line in the history.
                      disabled={posting || !author.trim() || (!logComment.trim() && logStatus === item.status)}
                      onClick={() => void postUpdate(item)}
                    >
                      {posting ? "Posting…" : "Post update"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {/* Below the reports rather than above them. Somebody opening this tab came to file something or
          to check on what they filed; what shipped is the answer to "was it fixed", which is a question
          you only have after reading the item. */}
      <ReleaseHistory />
    </div>
  );
}

function AuditView() {
  type AuditEvent = { id: string; timestamp: string; source: string; sourceKey: string; action: string; status: string; severity: "success" | "info" | "warning" | "error"; workspace?: string | null; workspaceLogo?: string | null; summary: string; details?: Record<string, unknown> };
  type GroupedItem = { type: "single"; event: AuditEvent } | { type: "group"; events: AuditEvent[]; timestamp: string };
  const pageSize = 24;
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const isWorkspaceSync = (event: AuditEvent) => event.severity === "success" && (event.action.includes("workspace") || event.action.includes("heartbeat") || event.action.includes("sync")) && event.sourceKey === "worker";
  const groupedEvents: GroupedItem[] = useMemo(() => {
    const items: GroupedItem[] = [];
    let syncBuffer: AuditEvent[] = [];
    const flushBuffer = () => {
      if (syncBuffer.length > 1) {
        items.push({ type: "group", events: [...syncBuffer], timestamp: syncBuffer[0].timestamp });
      } else if (syncBuffer.length === 1) {
        items.push({ type: "single", event: syncBuffer[0] });
      }
      syncBuffer = [];
    };
    for (const event of events) {
      if (isWorkspaceSync(event)) {
        syncBuffer.push(event);
      } else {
        flushBuffer();
        items.push({ type: "single", event });
      }
    }
    flushBuffer();
    return items;
  }, [events]);
  useEffect(() => {
    let cancelled = false;
    const load = async (quiet = false) => {
      if (!quiet) setLoading(true);
      const query = new URLSearchParams({ limit: String(visibleCount) });
      if (source) query.set("source", source);
      if (status) query.set("status", status);
      if (search.trim()) query.set("search", search.trim());
      if (from) query.set("from", new Date(from).toISOString());
      if (to) query.set("to", new Date(to).toISOString());
      try {
        const response = await fetch(`/api/admin/audit?${query}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(payload.error || "The audit feed could not be loaded."));
        if (!cancelled) { setEvents(Array.isArray(payload.events) ? payload.events : []); setHasMore(Boolean(payload.hasMore)); setUpdatedAt(String(payload.generatedAt ?? new Date().toISOString())); setError(""); }
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "The audit feed could not be loaded.");
      } finally { if (!cancelled && !quiet) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [visibleCount, source, status, search, from, to]);
  const exportAudit = () => {
    const csv = ["Timestamp,Source,Workspace,Action,Explanation,Status", ...events.map((event) => [new Date(event.timestamp).toISOString(), event.source, event.workspace ?? "", event.action, event.summary, event.status].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `reply-radar-audit-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="audit-view">
    <div className="audit-toolbar"><div className="audit-filters"><label><span>Search events</span><input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(pageSize); }} placeholder="Client, system, or event…" /></label><label><span>Source</span><select value={source} onChange={(event) => { setSource(event.target.value); setVisibleCount(pageSize); }}><option value="">All sources</option><option value="worker">Background worker</option><option value="heyreach">HeyReach webhook</option><option value="ai_ark">AI Ark</option><option value="supabase">Supabase</option><option value="anthropic">Anthropic</option><option value="admin">Admin console</option><option value="user">Dashboard user</option></select></label><label><span>Status</span><select value={status} onChange={(event) => { setStatus(event.target.value); setVisibleCount(pageSize); }}><option value="">All statuses</option><option value="success">Successful</option><option value="warning">In progress / warning</option><option value="error">Failed</option><option value="info">Recorded</option></select></label><label><span>From</span><input type="datetime-local" value={from} onChange={(event) => { setFrom(event.target.value); setVisibleCount(pageSize); }} /></label><label><span>To</span><input type="datetime-local" value={to} onChange={(event) => { setTo(event.target.value); setVisibleCount(pageSize); }} /></label></div><div className="audit-actions"><div className="audit-live"><i /><span>Live · refreshes every 5 seconds{updatedAt ? <small>Updated {new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</small> : null}</span></div><button className="secondary-button" onClick={exportAudit} disabled={!events.length}>Export CSV ↓</button></div></div>
    {error && <p className="audit-error">{error}</p>}
    <div className="audit-table"><div className="audit-table-head"><span>When</span><span>Source</span><span>What happened</span><span>Status</span></div>{loading && !events.length ? <p className="audit-empty">Loading the live audit feed…</p> : groupedEvents.map((item) => {
      if (item.type === "single") {
        const event = item.event;
        return <article className={`audit-row ${event.severity}`} key={event.id}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div className="audit-source">{event.workspaceLogo ? <img src={event.workspaceLogo} alt={`${event.workspace ?? "Client"} logo`} /> : <i />}<span><strong>{event.source}</strong>{event.workspace && <small>{event.workspace}</small>}</span></div><div className="audit-description"><strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong><p>{event.summary}</p><details><summary>Technical details</summary><pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre></details></div><span className={`audit-status ${event.severity}`}>{event.status}</span></article>;
      }
      const groupKey = item.timestamp;
      const expanded = expandedGroups.has(groupKey);
      const clients = item.events.map((event) => event.workspace).filter(Boolean);
      return <div className="audit-group-row" key={groupKey}>
        <button className={`audit-group-toggle ${expanded ? "expanded" : ""}`} onClick={() => setExpandedGroups((current) => { const next = new Set(current); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next; })}>
          <time>{new Date(item.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time>
          <div className="audit-source"><i /><span><strong>worker</strong><small>{item.events.length} syncs</small></span></div>
          <div className="audit-description"><strong>workspace sync batch</strong><p>{clients.length} client{clients.length !== 1 ? "s" : ""} synced successfully{clients.length ? ` — ${clients.join(", ")}` : ""}</p></div>
          <span className="audit-status success">success</span>
          <span className="audit-group-chevron">▾</span>
        </button>
        {expanded && <div className="audit-group-children">{item.events.map((event) => <article className={`audit-row ${event.severity}`} key={event.id}><time>{new Date(event.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" })}</time><div className="audit-source">{event.workspaceLogo ? <img src={event.workspaceLogo} alt={`${event.workspace ?? "Client"} logo`} /> : <i />}<span><strong>{event.source}</strong>{event.workspace && <small>{event.workspace}</small>}</span></div><div className="audit-description"><strong>{event.action.replaceAll("_", " ").replaceAll(".", " · ")}</strong><p>{event.summary}</p><details><summary>Technical details</summary><pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre></details></div><span className={`audit-status ${event.severity}`}>{event.status}</span></article>)}</div>}
      </div>;
    })}{!loading && !events.length && !error && <p className="audit-empty">No real events match these filters yet.</p>}{hasMore && <button className="audit-see-more" onClick={() => setVisibleCount((count) => count + pageSize)}>See 24 more events ↓</button>}</div>
  </section>;
}

type AiConfig = {
  anthropic: { configured: boolean; maskedKey: string | null; model: string };
  globalSentimentPrompt: string;
  defaultSentimentPrompt: string;
  icpDocPrompt: string;
  defaultIcpDocPrompt: string;
  morningBriefPrompt: string;
  defaultMorningBriefPrompt: string;
  workspaceAi: { name: string; slug: string; brief: string; model: string; icpPrompt: string; followUpPrompt: string; replyPrompt: string; sentimentPrompt: string; morningBriefPrompt?: string; followUpThreshold?: number } | null;
  workspaces: Array<{ id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; hasBrief: boolean }>;
};
type PastReplyRef = { body: string; senderName: string; leadName: string; campaignName: string };
type AiAuditEvent = { id: string; timestamp: string; action: string; status: string; sentiment: string | null; inputTokens: number; outputTokens: number; durationMs: number | null; workspaceName: string | null; workspaceLogoUrl: string | null; leadName: string | null; leadPhotoUrl: string | null; conversationId?: string | null; draft?: string | null; reason?: string | null; inboundMessage?: string | null; campaignName?: string | null; leadTitle?: string | null; leadCompany?: string | null; pastReplies?: string[]; pastReplyContext?: PastReplyRef[] };
type AiAuditData = { ok?: boolean; events: AiAuditEvent[]; drafts?: AiAuditEvent[]; summary: { totalCalls: number; successful: number; failed: number; totalInputTokens: number; totalOutputTokens: number } };
type SlackLogEvent = { id: string; timestamp: string; action: string; surface: string; channel: string | null; askedBy: string | null; question: string | null; outcome: string; durationMs: number | null; toolCount: number; inputTokens: number; outputTokens: number; model: string | null; error: string | null; workspaceLogoUrl: string | null };
type SlackLogData = { ok?: boolean; events: SlackLogEvent[]; summary: { total: number; succeeded: number; failed: number; totalInputTokens: number; totalOutputTokens: number } };

/**
 * Vetted prompts offered as a choice, with the current one named.
 *
 * The label is derived from the text rather than remembered from the last click, so editing a
 * template's wording immediately reports it as "Custom" — a teammate can always tell whether the AI
 * is running something we vetted or something they wrote.
 */
function TemplatePicker({ templates, value, onPick, onSave, onDelete }: {
  templates: ScoringTemplate[];
  value: string;
  onPick: (prompt: string) => void;
  onSave: (name: string) => Promise<string>;
  onDelete: (id: string) => void;
}) {
  const current = templateLabel(templates, value);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameInput = useRef<HTMLInputElement | null>(null);
  // Focused on appearance rather than through autoFocus, which would also steal focus on page load.
  useEffect(() => { if (naming) nameInput.current?.focus(); }, [naming]);
  const commit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const failure = await onSave(name.trim());
    setBusy(false);
    if (failure) { setError(failure); return; }
    setNaming(false); setName(""); setError("");
  };
  return <div className="template-picker">
    <div className="template-picker-head"><span className="field-label" style={{ margin: 0 }}>START FROM A TEMPLATE</span><b className={current.id ? "template-badge" : "template-badge custom"}>{current.name}</b></div>
    <div className="template-picker-grid">
      {templates.map((template) => <div key={template.id} className={`template-card${current.id === template.id ? " active" : ""}`} role="button" tabIndex={0}
        onClick={() => onPick(template.prompt)}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(template.prompt); } }}
      >
        <strong>{template.name}{template.saved && <span className="template-saved-tag">Saved</span>}</strong>
        {template.summary && <p>{template.summary}</p>}
        {template.tracks && <small><em>Tracks:</em> {template.tracks}</small>}
        {template.saved && <button type="button" className="template-delete" title="Delete this saved template"
          onClick={(event) => { event.stopPropagation(); onDelete(template.id); }}
        >×</button>}
      </div>)}
      {naming
        // Named inline rather than through a browser prompt, which cannot be styled, cannot show why
        // a save failed, and cannot be cancelled without losing what was typed.
        ? <div className="template-card template-card-naming">
            <input ref={nameInput} value={name} placeholder="Template name" maxLength={80}
              onChange={(event) => { setName(event.target.value); setError(""); }}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } if (event.key === "Escape") { setNaming(false); setName(""); setError(""); } }} />
            {error ? <small className="template-error">{error}</small> : <small>Saving under a name already in use replaces it.</small>}
            <div className="template-naming-actions">
              <button type="button" className="primary-button" disabled={!name.trim() || busy} onClick={() => void commit()}>{busy ? "Saving…" : "Save"}</button>
              <button type="button" className="text-button" onClick={() => { setNaming(false); setName(""); setError(""); }}>Cancel</button>
            </div>
          </div>
        : <button type="button" className="template-card template-card-add" onClick={() => setNaming(true)} disabled={!value.trim()}>
            <span>＋</span>
            <strong>Save this prompt as a template</strong>
            <p>{value.trim() ? "Keeps it in this list for every client." : "Write a prompt below first."}</p>
          </button>}
    </div>
    <small className="template-picker-hint">Pick one to fill the box below, then edit it freely — any change makes it a custom prompt for this client. Editing and saving changes is enough to use a custom prompt; only save it as a template if other clients should be able to pick it too.</small>
  </div>;
}

/**
 * Live feed of Anthropic suggested-reply generations. Shows the past client replies that
 * were fed in as tone reference and the draft that came out, with client + lead photos.
 *
 * The AI hub already polls /api/ai/audit every 3s and highlights fresh rows for 2s,
 * so surfacing the same event stream here — filtered to drafting events and expanded
 * with the raw draft text and voice examples — is enough to feel live without adding
 * another polling loop.
 */
function DraftFeedPanel({ events, freshIds }: { events: AiAuditEvent[]; freshIds: string[] }) {
  const [visible, setVisible] = useState(10);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Only show events with the full v2 payload (inbound message, references, etc.).
  // Older rows still appear in the raw audit log below, but rendering them here
  // would show a half-empty card.
  const allDrafts = events.filter((event) => {
    if (event.action !== "conversation.analyzed" && event.action !== "draft.generated" && event.action !== "draft.failed") return false;
    if (event.action === "draft.failed") return true;
    const hasDraft = Boolean(event.draft && event.draft.trim());
    const hasInbound = Boolean(event.inboundMessage && event.inboundMessage.trim());
    return hasDraft && hasInbound;
  });
  const drafts = allDrafts.slice(0, visible);
  const toggle = (id: string) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  return (
    <section className="admin-panel ai-draft-feed-section">
      <div className="panel-heading">
        <div className="ai-audit-title">
          <h2 style={{ fontSize: 22 }}>Suggested reply feed</h2>
          <span className="ai-audit-live"><i />live</span>
        </div>
      </div>
      {drafts.length === 0 ? (
        <p className="audit-empty">No drafts yet. New generations will stream in here.</p>
      ) : (
        <div className="ai-draft-feed">
          {drafts.map((event) => {
            const d = event.timestamp ? new Date(event.timestamp) : null;
            const when = d && !Number.isNaN(d.getTime())
              ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })
              : "—";
            const date = d && !Number.isNaN(d.getTime())
              ? `${d.getMonth() + 1}/${d.getDate()}`
              : "";
            const isFresh = freshIds.includes(String(event.id));
            const isFailed = event.action === "draft.failed" || event.status === "error" || event.status === "failed";
            const isOpen = Boolean(expanded[String(event.id)]);
            const references = event.pastReplyContext ?? [];
            // Compose the sub-line: title @ company, then campaign
            const titleCompany = [event.leadTitle, event.leadCompany].filter(Boolean).join(" @ ");
            return (
              <article className={`ai-draft-card${isFresh ? " ai-draft-card-fresh" : ""}${isFailed ? " ai-draft-card-failed" : ""}${isOpen ? " ai-draft-card-open" : ""}`} key={event.id}>
                <button type="button" className="ai-draft-card-toggle" onClick={() => toggle(String(event.id))} aria-expanded={isOpen}>
                  <header className="ai-draft-card-head">
                    <div className="ai-draft-card-who">
                      <div className="ai-draft-avatar-pair">
                        {event.leadPhotoUrl ? <img className="ai-draft-avatar-lead" src={event.leadPhotoUrl} alt="" /> : <span className="ai-draft-avatar-placeholder">{(event.leadName ?? "?")[0]}</span>}
                        {event.workspaceLogoUrl ? <img className="ai-draft-avatar-client" src={event.workspaceLogoUrl} alt="" /> : <span className="ai-draft-avatar-placeholder ai-draft-avatar-client">{(event.workspaceName ?? "?")[0]}</span>}
                      </div>
                      <div className="ai-draft-card-identity">
                        <strong>{event.leadName || "—"}</strong>
                        {titleCompany && <span className="ai-draft-card-role">{titleCompany}</span>}
                        <small>
                          {event.workspaceName || "—"}
                          {event.campaignName ? ` · ${event.campaignName}` : ""}
                          {` · ${date} ${when}`}
                        </small>
                      </div>
                    </div>
                    <div className="ai-draft-card-meta">
                      {event.sentiment && <span className={`sentiment-badge sentiment-${event.sentiment}`}>{event.sentiment}</span>}
                      <small>{event.durationMs ? `${event.durationMs}ms` : ""}</small>
                      <small>{event.inputTokens || event.outputTokens ? `${event.inputTokens}→${event.outputTokens}` : ""}</small>
                      <span className="ai-draft-card-caret" aria-hidden>{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </header>
                  <div className="ai-draft-block ai-draft-block-output">
                    <span className="ai-draft-block-label">SUGGESTED REPLY</span>
                    <p>{event.draft || (isFailed ? "Draft failed to generate." : "(empty)")}</p>
                  </div>
                </button>
                {isOpen && (
                  <div className="ai-draft-card-details">
                    {event.inboundMessage && (
                      <div className="ai-draft-block ai-draft-block-inbound">
                        <span className="ai-draft-block-label">INBOUND MESSAGE (what we&apos;re replying to)</span>
                        <p>{event.inboundMessage}</p>
                      </div>
                    )}
                    {event.reason && (
                      <div className="ai-draft-block ai-draft-block-reason">
                        <span className="ai-draft-block-label">WHY THIS DESERVES ATTENTION</span>
                        <p>{event.reason}</p>
                      </div>
                    )}
                    {references.length > 0 && (
                      <div className="ai-draft-block ai-draft-block-input">
                        <span className="ai-draft-block-label">
                          VOICE REFERENCE · {references.length} past reply from this client
                        </span>
                        <ol className="ai-draft-references">
                          {references.map((ref, index) => (
                            <li key={index}>
                              <div className="ai-draft-reference-meta">
                                {ref.senderName && <span><b>Sender:</b> {ref.senderName}</span>}
                                {ref.leadName && <span><b>Lead:</b> {ref.leadName}</span>}
                                {ref.campaignName && <span><b>Campaign:</b> {ref.campaignName}</span>}
                              </div>
                              <p>{ref.body}</p>
                            </li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {allDrafts.length > visible && (
            <button type="button" className="audit-see-more" onClick={() => setVisible((v) => v + 10)}>
              See 10 more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function AiHubView() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [audit, setAudit] = useState<AiAuditData | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [promptSaved, setPromptSaved] = useState(false);
  const [promptError, setPromptError] = useState("");
  const [icpDoc, setIcpDoc] = useState("");
  const [icpDocSaved, setIcpDocSaved] = useState(false);
  const [icpDocError, setIcpDocError] = useState("");
  const [briefPrompt, setBriefPrompt] = useState("");
  const [briefSaved, setBriefSaved] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [clientBrief, setClientBrief] = useState("");
  const [icpPrompt, setIcpPrompt] = useState("");
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpThreshold, setFollowUpThreshold] = useState(50);
  const [replyPrompt, setReplyPrompt] = useState("");
  const [clientSaving, setClientSaving] = useState(false);
  const [clientSaved, setClientSaved] = useState(false);
  // Opened straight on the prompt when the Slack hub linked here, because that link exists for one reason.
  const [activeTab, setActiveTab] = useState<"overview" | "prompts" | "clients" | "slack-log">(() =>
    typeof window !== "undefined" && window.location.hash === "#ai-morning-brief" ? "prompts" : "overview");
  const [savedTemplates, setSavedTemplates] = useState<Array<{ id: string; kind: string; name: string; summary: string; prompt: string }>>([]);

  // The browser's own hash scroll fires before this tab's panels exist, so it lands on nothing and the
  // link drops you at the top of a long page. Re-run it once the panel is actually in the document.
  useEffect(() => {
    if (activeTab !== "prompts" || window.location.hash !== "#ai-morning-brief") return;
    document.getElementById("ai-morning-brief")?.scrollIntoView({ block: "start" });
  }, [activeTab]);

  const loadSavedTemplates = () => fetch("/api/ai/templates", { cache: "no-store" })
    .then((r) => r.json())
    .then((payload) => setSavedTemplates(Array.isArray(payload?.templates) ? payload.templates : []))
    .catch(() => null);

  /** Returns an error message, or "" when the save landed. */
  const saveTemplate = async (kind: "icp" | "follow_up", name: string, prompt: string): Promise<string> => {
    const response = await fetch("/api/ai/templates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, name, prompt }) }).catch(() => null);
    const payload = await response?.json().catch(() => ({}));
    if (!response?.ok || !payload?.ok) return String(payload?.error ?? "Could not save the template.");
    await loadSavedTemplates();
    return "";
  };

  const deleteTemplate = async (id: string) => {
    // Optimistic, then reconciled from the server — a delete that failed would otherwise leave the
    // card gone from the page but still there for everyone else.
    setSavedTemplates((previous) => previous.filter((template) => template.id !== id));
    await fetch(`/api/ai/templates?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    await loadSavedTemplates();
  };

  const templatesFor = (kind: "icp" | "follow_up"): ScoringTemplate[] => [
    ...(kind === "icp" ? ICP_TEMPLATES : FOLLOW_UP_TEMPLATES),
    ...savedTemplates.filter((template) => template.kind === kind).map((template) => ({ id: template.id, name: template.name, summary: template.summary, prompt: template.prompt, saved: true })),
  ];

  const loadConfig = (workspace?: string) => {
    const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
    fetch(`/api/ai/config${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiConfig) => {
        setConfig(payload);
        setGlobalPrompt(String(payload.globalSentimentPrompt ?? ""));
        setIcpDoc(String(payload.icpDocPrompt ?? ""));
        setBriefPrompt(String(payload.morningBriefPrompt ?? ""));
        if (payload.workspaceAi) {
          setClientBrief(payload.workspaceAi.brief);
          // A client with nothing stored is shown the same defaults the scoring routes fall back to,
          // so the page always displays the prompt the AI is actually running rather than a blank box
          // standing in for a default nobody can read.
          setIcpPrompt(payload.workspaceAi.icpPrompt || defaultIcpPrompt());
          setFollowUpPrompt(payload.workspaceAi.followUpPrompt || defaultFollowUpPrompt());
          setFollowUpThreshold(Number(payload.workspaceAi.followUpThreshold ?? 50));
          setReplyPrompt(payload.workspaceAi.replyPrompt);
        }
      })
      .catch(() => null);
  };

  useEffect(() => { loadConfig(); void loadSavedTemplates(); }, []);
  const [auditVisible, setAuditVisible] = useState(25);
  const [freshIds, setFreshIds] = useState<string[]>([]);
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const load = () => fetch("/api/ai/audit", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: AiAuditData) => {
        if (payload?.ok === false) return;
        setAudit(payload);
        const ids = (payload?.events ?? []).map((e) => String(e.id));
        if (seenIdsRef.current === null) { seenIdsRef.current = new Set(ids); return; }
        const seen = seenIdsRef.current;
        const added = ids.filter((id) => !seen.has(id));
        if (added.length) {
          added.forEach((id) => seen.add(id));
          setFreshIds(added);
          setTimeout(() => setFreshIds((cur) => cur.filter((id) => !added.includes(id))), 2000);
        }
      })
      .catch(() => null);
    load();
    const interval = setInterval(load, 3_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  const [slackLog, setSlackLog] = useState<SlackLogData | null>(null);
  const [slackLogVisible, setSlackLogVisible] = useState(25);
  useEffect(() => {
    const load = () => fetch("/api/ai/slack-log", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: SlackLogData) => { if (payload?.ok !== false) setSlackLog(payload); })
      .catch(() => null);
    load();
    const interval = setInterval(load, 5_000);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  useEffect(() => {
    if (selectedClient) loadConfig(selectedClient);
  }, [selectedClient]);

  /**
   * "Saved ✓" now means saved.
   *
   * This used to flash regardless of what came back, and the route it calls was writing to a table with
   * no `key` column — so the prompt failed to save every time and the button said it had worked. The
   * reason is shown instead of swallowed.
   */
  const saveGlobalPrompt = async () => {
    setPromptError("");
    const response = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_sentiment_prompt", value: globalPrompt }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!payload?.ok) {
      setPromptError(payload?.error || "Could not save the prompt.");
      return;
    }
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 2500);
  };

  /** The instructions the QC Brain's "Generate ICP document" button runs on. */
  const saveIcpDocPrompt = async () => {
    setIcpDocError("");
    const response = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_icp_doc_prompt", value: icpDoc }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!payload?.ok) {
      setIcpDocError(payload?.error || "Could not save the prompt.");
      return;
    }
    setIcpDocSaved(true);
    setTimeout(() => setIcpDocSaved(false), 2500);
  };

  /** The instructions every morning brief is written on, unless a client overrides them. */
  const saveBriefPrompt = async () => {
    setBriefError("");
    const response = await fetch("/api/ai/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_morning_brief_prompt", value: briefPrompt }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!payload?.ok) {
      setBriefError(payload?.error || "Could not save the prompt.");
      return;
    }
    setBriefSaved(true);
    setTimeout(() => setBriefSaved(false), 2500);
  };

  const saveClientAi = async () => {
    if (!selectedClient) return;
    setClientSaving(true);
    await fetch("/api/ai/config", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_workspace_ai", workspace: selectedClient, brief: clientBrief, icpPrompt, followUpPrompt, replyPrompt, followUpThreshold }),
    });
    setClientSaving(false);
    setClientSaved(true);
    setTimeout(() => setClientSaved(false), 2500);
  };

  const selectedWs = config?.workspaces?.find((ws) => ws.slug === selectedClient);
  // Judged on the live textarea rather than what is saved, so the panel unlocks as the brief is
  // typed instead of demanding a save round-trip first.
  const briefLength = clientBrief.trim().length;
  const icpLocked = briefLength < MIN_CLIENT_BRIEF_LENGTH;

  return <div className="ai-hub-view">
    <div className="admin-heading"><div>
      <h1 className="workspace-directory-page-title">AI</h1>
      <p>Anthropic configuration, sentiment analysis, and per-client AI context.</p>
    </div></div>

    <div className="ai-hub-tabs">
      <button className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
      <button className={activeTab === "prompts" ? "active" : ""} onClick={() => setActiveTab("prompts")}>Prompts</button>
      <button className={activeTab === "clients" ? "active" : ""} onClick={() => setActiveTab("clients")}>Client AI context</button>
      <button className={activeTab === "slack-log" ? "active" : ""} onClick={() => setActiveTab("slack-log")}>Slack bot log</button>
    </div>

    {activeTab === "overview" && <>
      <div className="admin-grid">
        <section className="admin-panel">
          <div className="panel-heading"><div><h2>Anthropic connection</h2><p>API heartbeat and configuration.</p></div>
            <span className={config?.anthropic?.configured ? "connection-badge" : "saved-dot"}><i /> {config?.anthropic?.configured ? "Connected" : "Not configured"}</span>
          </div>
          <label className="field-label">API KEY<div className="status-field">{config?.anthropic?.maskedKey ?? "Not set"}</div></label>
          <label className="field-label">MODEL<div className="status-field">{config?.anthropic?.model ?? "—"}</div></label>
          <div className="field-row">
            <label className="field-label">CURRENT FUNCTIONS<div className="status-field">Sentiment analysis · ICP scoring · Follow-up scoring · Reply drafts</div></label>
          </div>
        </section>
        <section className="admin-panel">
          <div className="panel-heading"><div><h2>Usage summary</h2><p>Token usage from Anthropic API calls.</p></div></div>
          <div className="ai-hub-kpis">
            <div className="ai-hub-kpi"><span>Total API calls</span><strong>{audit?.summary?.totalCalls ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Successful</span><strong>{audit?.summary?.successful ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Failed</span><strong>{audit?.summary?.failed ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Input tokens</span><strong>{audit?.summary?.totalInputTokens?.toLocaleString() ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Output tokens</span><strong>{audit?.summary?.totalOutputTokens?.toLocaleString() ?? "—"}</strong></div>
          </div>
        </section>
      </div>

      <DraftFeedPanel events={audit?.drafts ?? audit?.events ?? []} freshIds={freshIds} />

      <section className="admin-panel ai-audit-section">
        <div className="panel-heading"><div className="ai-audit-title"><h2 style={{ fontSize: 22 }}>AI audit log</h2><span className="ai-audit-live"><i />live</span></div>
          <button className="secondary-button" onClick={() => {
            if (!audit?.events?.length) return;
            const csv = ["When,Client,Lead,Action,Input Tokens,Output Tokens,Duration (ms),Status",
              ...audit.events.map((e) => `"${e.timestamp}","${e.workspaceName ?? ""}","${e.leadName ?? ""}","${e.action ?? ""}",${e.inputTokens},${e.outputTokens},${e.durationMs ?? ""},${e.status}`)
            ].join("\n");
            const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `ai-audit-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
          }}>Export CSV ↓</button>
        </div>
        <div className="ai-audit-table ai-audit-compact">
          <div className="ai-audit-head"><span>When</span><span>Client</span><span>Lead</span><span>Action</span><span>Tokens</span><span>Duration</span><span>Status</span></div>
          {audit?.events?.length ? audit.events.slice(0, auditVisible).map((event) => {
            const d = event.timestamp ? new Date(event.timestamp) : null;
            const when = d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}` : "—";
            const actionLabel: Record<string, string> = { "conversation.analyzed": "Sentiment + Reply", "draft.generated": "Suggested reply", "draft.failed": "Reply failed", "sentiment_analysis": "Sentiment analysis", "icp.scored": "ICP scoring", "followup.scored": "Follow-up score" };
            return <div className={`ai-audit-row${freshIds.includes(String(event.id)) ? " ai-audit-row-fresh" : ""}`} key={event.id}>
              <time>{when}</time>
              <span className="ai-audit-client-cell">{event.workspaceLogoUrl ? <img className="ai-audit-logo" src={event.workspaceLogoUrl} alt="" /> : null}{event.workspaceName || "—"}</span>
              <span className="ai-audit-lead-cell">{event.leadPhotoUrl ? <img className="ai-audit-avatar" src={event.leadPhotoUrl} alt="" /> : null}{event.leadName || "—"}</span>
              <span><strong>{actionLabel[event.action ?? ""] ?? event.action?.replaceAll(".", " ") ?? "—"}</strong></span>
              <span>{event.inputTokens || event.outputTokens ? `${event.inputTokens} in · ${event.outputTokens} out` : "—"}</span>
              <span>{event.durationMs ? `${event.durationMs}ms` : "—"}</span>
              <span className={`audit-status ${event.status === "success" ? "success" : event.status === "error" || event.status === "failed" ? "error" : "warning"}`}>{event.status}</span>
            </div>;
          }) : <p className="audit-empty">No AI audit events yet. Events will appear after the first reply is analyzed.</p>}
          {audit?.events && audit.events.length > auditVisible && <button className="audit-see-more" onClick={() => setAuditVisible((v) => v + 25)}>See 25 more</button>}
        </div>
      </section>
    </>}

    {activeTab === "slack-log" && <>
      <div className="admin-grid">
        <section className="admin-panel">
          <div className="panel-heading"><div><h2>QC Bot activity</h2><p>Every question answered over Slack — mentions, DMs, and thread replies.</p></div></div>
          <div className="ai-hub-kpis">
            <div className="ai-hub-kpi"><span>Total runs</span><strong>{slackLog?.summary?.total ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Answered</span><strong>{slackLog?.summary?.succeeded ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Failed</span><strong>{slackLog?.summary?.failed ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Input tokens</span><strong>{slackLog?.summary?.totalInputTokens?.toLocaleString() ?? "—"}</strong></div>
            <div className="ai-hub-kpi"><span>Output tokens</span><strong>{slackLog?.summary?.totalOutputTokens?.toLocaleString() ?? "—"}</strong></div>
          </div>
        </section>
      </div>

      <section className="admin-panel ai-audit-section">
        <div className="panel-heading"><div className="ai-audit-title"><h2 style={{ fontSize: 22 }}>Slack bot log</h2><span className="ai-audit-live"><i />live</span></div>
          <button className="secondary-button" onClick={() => {
            if (!slackLog?.events?.length) return;
            const csv = ["When,Surface,User,Question,Outcome,Tools,Input Tokens,Output Tokens,Duration (ms)",
              ...slackLog.events.map((e) => `"${e.timestamp}","${e.surface}","${e.askedBy ?? ""}","${(e.question ?? "").replaceAll('"', '""')}","${e.outcome}",${e.toolCount},${e.inputTokens},${e.outputTokens},${e.durationMs ?? ""}`)
            ].join("\n");
            const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `slack-bot-log-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href);
          }}>Export CSV ↓</button>
        </div>
        <div className="ai-audit-table slack-log-table">
          <div className="ai-audit-head"><span>When</span><span>Surface</span><span>User</span><span>Question</span><span>Tools</span><span>Tokens</span><span>Duration</span><span>Outcome</span></div>
          {slackLog?.events?.length ? slackLog.events.slice(0, slackLogVisible).map((event) => {
            const d = event.timestamp ? new Date(event.timestamp) : null;
            const when = d && !isNaN(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}` : "—";
            const surfaceLabel: Record<string, string> = { mention: "@mention", dm: "DM", thread: "Thread" };
            const outcomeClass = event.outcome === "success" ? "success" : event.outcome === "error" ? "error" : "warning";
            return <div className="ai-audit-row" key={event.id}>
              <time>{when}</time>
              <span><strong>{surfaceLabel[event.surface] ?? event.surface}</strong></span>
              <span className="ai-audit-lead-cell">{event.workspaceLogoUrl ? <img className="ai-audit-logo" src={event.workspaceLogoUrl} alt="" /> : null}{event.askedBy || "—"}</span>
              <span className="slack-log-question" title={event.question ?? ""}>{event.question || "—"}</span>
              <span>{event.toolCount || "—"}</span>
              <span>{event.inputTokens || event.outputTokens ? `${event.inputTokens} in · ${event.outputTokens} out` : "—"}</span>
              <span>{event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : "—"}</span>
              <span className={`audit-status ${outcomeClass}`} title={event.error ?? ""}>{event.outcome}</span>
            </div>;
          }) : <p className="audit-empty">No Slack runs yet. Activity appears after the bot answers its first mention or DM.</p>}
          {slackLog?.events && slackLog.events.length > slackLogVisible && <button className="audit-see-more" onClick={() => setSlackLogVisible((v) => v + 25)}>See 25 more</button>}
        </div>
      </section>
    </>}

    {activeTab === "prompts" && <>
      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Sentiment analysis prompt</h2><p>This prompt is used to classify every inbound reply as positive, neutral, or negative. Edit it here to adjust how the AI categorizes replies.</p></div>
          <button className="primary-button" onClick={saveGlobalPrompt}>{promptSaved ? "Saved ✓" : "Save prompt"}</button>
        </div>
        <label className="field-label">GLOBAL SENTIMENT PROMPT
          <textarea value={globalPrompt} onChange={(event) => setGlobalPrompt(event.target.value)} rows={8} style={{ minHeight: 180 }} />
        </label>
        {promptError && <p className="form-error" role="alert">{promptError}</p>}
        <button className="text-button" onClick={() => setGlobalPrompt(config?.defaultSentimentPrompt ?? "")}>Reset to default prompt</button>
      </section>

      {/* What a client's ICP document says is a positioning decision rather than a technical one, so the
          instructions live here and the button in the QC Brain reads whatever is saved. */}
      <section className="admin-panel">
        <div className="panel-heading"><div><h2>Create ICP doc prompt</h2><p>Run by “Generate ICP document” on a client’s QC Brain page. Every file the brain holds on that client is handed over with it.</p></div>
          <button className="primary-button" onClick={saveIcpDocPrompt}>{icpDocSaved ? "Saved ✓" : "Save prompt"}</button>
        </div>
        <label className="field-label">CREATE ICP DOC PROMPT
          <textarea value={icpDoc} onChange={(event) => setIcpDoc(event.target.value)} rows={16} style={{ minHeight: 360 }} />
        </label>
        {icpDocError && <p className="form-error" role="alert">{icpDocError}</p>}
        <button className="text-button" onClick={() => setIcpDoc(config?.defaultIcpDocPrompt ?? "")}>Reset to default prompt</button>
      </section>

      {/* The figures a brief quotes are computed before the model is called, so this prompt decides
          what gets raised first and what goes unsaid — not what the numbers are. */}
      <section className="admin-panel" id="ai-morning-brief">
        <div className="panel-heading"><div><h2>Morning brief prompt</h2><p>Run by the morning brief on the Slack tab. The client’s campaign figures, both Slack channels and the transcript of their last call are handed over with it.</p></div>
          <button className="primary-button" onClick={saveBriefPrompt}>{briefSaved ? "Saved ✓" : "Save prompt"}</button>
        </div>
        <label className="field-label">MORNING BRIEF PROMPT
          <textarea value={briefPrompt} onChange={(event) => setBriefPrompt(event.target.value)} rows={16} style={{ minHeight: 360 }} />
        </label>
        {briefError && <p className="form-error" role="alert">{briefError}</p>}
        <button className="text-button" onClick={() => setBriefPrompt(config?.defaultMorningBriefPrompt ?? "")}>Reset to default prompt</button>
      </section>
    </>}

    {activeTab === "clients" && <>
      <div className="ai-client-layout">
        <aside className="ai-client-sidebar">
          <div className="admin-nav-caption">CLIENT AI CONTEXT</div>
          {config?.workspaces?.map((ws) => (
            <button key={ws.slug} className={`admin-nav-client-button ${selectedClient === ws.slug ? "active" : ""}`} onClick={() => setSelectedClient(ws.slug)}>
              <i style={ws.logoUrl ? undefined : { background: ws.accentColor || "var(--accent)" }}>{ws.logoUrl ? <img src={ws.logoUrl} alt="" /> : (ws.name?.[0] ?? "?")}</i>
              <span>{ws.name}</span>
              {ws.hasBrief && <b>●</b>}
            </button>
          ))}
        </aside>
        <div className="ai-client-content">
          {!selectedClient ? <div className="ai-client-empty"><p>Select a client to configure their AI context, ICP prompt, follow-up rules, and reply prompt.</p></div> : <>
            <div className="ai-client-header">
              <h2>{selectedWs?.logoUrl ? <img src={selectedWs.logoUrl} alt="" className="admin-client-heading-logo" /> : <span className="admin-client-heading-logo" style={{ background: selectedWs?.accentColor || "var(--accent)" }}>{selectedWs?.name?.[0] ?? "?"}</span>}{selectedWs?.name ?? selectedClient}</h2>
              <button className="primary-button" onClick={saveClientAi} disabled={clientSaving}>{clientSaving ? "Saving…" : clientSaved ? "Saved ✓" : "Save changes"}</button>
            </div>
            <div className="client-config-sections">
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Client brief & documents</h2><p>Give the AI all the context about this client. This feeds into ICP scoring, follow-up scoring, and reply drafts.</p></div></div>
                {/* Deep, not tall-ish. What goes in here is the output of /client-summary in the QC
                    Growth OS, which runs to thousands of words — six rows made a correct paste look
                    like a mistake, and the first instinct on seeing a full box overflow is to trim it. */}
                <label className="field-label">CLIENT BRIEF<textarea value={clientBrief} onChange={(event) => setClientBrief(event.target.value)} placeholder="Paste the output of /client-summary from the QC Growth OS. Longer is better — every ICP score, follow-up score and draft for this client reads it." rows={18} style={{ minHeight: 380 }} /></label>
                {briefLength > 0 && <p className="brief-count">{briefLength.toLocaleString()} characters{briefLength > 24000 ? " · only the first 24,000 reach the AI" : ""}</p>}
                <button className="upload-zone" type="button"><span style={{ fontSize: 20 }}>＋</span><div><strong>Upload client documents</strong><small>PDF, DOCX, TXT · stored in Supabase Storage</small></div></button>
              </section>
              <section className={`admin-panel client-config-section${icpLocked ? " section-locked" : ""}`}>
                <div className="panel-heading"><div><h2>ICP scoring prompt</h2><p>How should the AI score this lead against the client&apos;s ideal customer profile?</p></div>
                  {icpLocked && <span className="locked-badge">🔒 Locked</span>}
                </div>
                {icpLocked
                  // ICP scoring is a judgement about fit, and fit is meaningless without knowing what
                  // the client sells and to whom. Scoring against an empty brief produces confident
                  // numbers derived from nothing, which is worse than no score at all.
                  ? <div className="locked-explainer">
                      <p>Fill in the <strong>client brief</strong> above first. ICP scoring judges how well a lead fits <em>this client</em>, so the AI needs to know what they sell and who they sell it to before any score means anything.</p>
                      <div className="locked-progress"><i style={{ width: `${Math.min(100, Math.round((briefLength / MIN_CLIENT_BRIEF_LENGTH) * 100))}%` }} /></div>
                      <small>{briefLength} of {MIN_CLIENT_BRIEF_LENGTH} characters written — {MIN_CLIENT_BRIEF_LENGTH - briefLength} to go.</small>
                    </div>
                  : <>
                      <TemplatePicker templates={templatesFor("icp")} value={icpPrompt} onPick={setIcpPrompt} onSave={(name) => saveTemplate("icp", name, icpPrompt)} onDelete={(id) => void deleteTemplate(id)} />
                      <label className="field-label">ICP PROMPT<textarea value={icpPrompt} onChange={(event) => setIcpPrompt(event.target.value)} placeholder="Describe what makes a lead a good fit for this client: the titles, seniority, company size, and industries that matter, and who to score down." rows={12} style={{ minHeight: 240 }} /></label>
                      <small className="threshold-hint">The client brief above is sent to the AI alongside this prompt on every score.</small>
                    </>}
              </section>
              <section className="admin-panel client-config-section">
                <div className="panel-heading"><div><h2>Follow-up scoring prompt</h2><p>How should the AI determine follow-up urgency?</p></div></div>
                <TemplatePicker templates={templatesFor("follow_up")} value={followUpPrompt} onPick={setFollowUpPrompt} onSave={(name) => saveTemplate("follow_up", name, followUpPrompt)} onDelete={(id) => void deleteTemplate(id)} />
                <label className="field-label">FOLLOW-UP PROMPT<textarea value={followUpPrompt} onChange={(event) => setFollowUpPrompt(event.target.value)} placeholder="Describe what should make a conversation urgent to follow up on, and what should keep it quiet." rows={12} style={{ minHeight: 240 }} /></label>
                <label className="field-label">FOLLOW-UP ALERT THRESHOLD<span className="threshold-row"><input type="range" min={0} max={100} step={5} value={followUpThreshold} onChange={(event) => setFollowUpThreshold(Number(event.target.value))} /><b>{followUpThreshold}</b></span><small className="threshold-hint">Only show the &ldquo;follow-up recommended&rdquo; box when a lead scores at or above this. Higher = less noise.</small></label>
              </section>
            </div>
          </>}
        </div>
      </div>
    </>}
  </div>;
}
