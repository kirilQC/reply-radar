// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import BookingAlerts from "../slack/BookingAlerts";

/**
 * A client's Operations page: where its replies and booked meetings go outside QC Command. One page, four
 * views switched from the left rail: HubSpot and Attio (connect → read-only audit → plan → approve and build →
 * push, plus the dashboard and booked meetings as deals), Google Sheets (as many sheets as wanted), and the
 * booked meetings workflow. Opened from the client's onboarding page.
 */

type View = "hubspot" | "attio" | "sheets" | "meetings";
const VIEWS: View[] = ["hubspot", "attio", "sheets", "meetings"];

type PlanItem = { id: string; kind: string; name: string; label: string; detail: string; action: "create" | "reuse" | "skip" };
type Crm = {
  provider: string;
  connected: boolean;
  keyMasked: string;
  accountId: string | null;
  accountName: string | null;
  status: string;
  audit: null | {
    contacts: number;
    companies: number;
    owners: Array<{ id: string; name: string }>;
    recentSources: Array<{ source: string; count: number }>;
    lookAlikes: Array<{ name: string; label: string; why: string }>;
    missingScopes: string[];
    scopes?: string[];
    countsCapped?: boolean;
    lists?: Array<{ name: string }>;
  };
  plan: null | {
    items: PlanItem[];
    settings: { leadSourceProperty: string | null; lifecycleOnCreate: string | null; ownerId: string | null; listId?: string };
    conversation: string;
    notTouched: string[];
    warnings: string[];
    deals?: { enabled: boolean; pipelineId?: string | null; pipelineLabel?: string; stageExists?: boolean; stageId?: string | null; createProperties?: string[]; pipelines?: Array<{ id: string; label: string; hasStage: boolean }>; blocker?: string | null; available?: boolean; statusExists?: boolean; createAttributes?: string[] };
  };
  buildLog: Array<{ at?: string; kind: string; name: string; result: string; detail: string }>;
  autoPush: boolean;
  config: { dashboard_id?: string; attio_slug?: string };
  hubspotUser: null | { user: string; hubId: string; connectedAt: string };
  lastPushAt: string | null;
  lastPushSummary: null | { pushed: number; created: number; updated: number; unchanged: number; failed: number; errors: string[] };
};
type Sheet = {
  key: string;
  content: "replies" | "meetings";
  connected: boolean;
  accountName: string | null;
  status: string;
  autoPush: boolean;
  lastPushAt: string | null;
  lastPushSummary: null | { pushed: number; created: number; updated: number; failed: number; errors: string[] };
  config: { url?: string; tab?: string; headers?: string[]; mapping?: string[]; qcIdColumn?: number };
};
type FieldsByContent = { replies: Array<{ key: string; label: string }>; meetings: Array<{ key: string; label: string }> };
type SheetsPayload = { sheets?: Sheet[]; robotEmail?: string | null; google?: { email: string } | null; googleOauth?: boolean; fieldsByContent?: FieldsByContent; summary?: { created: number; updated: number; failed: number; nextOffset: number | null } };
type Client = { name: string; slug: string; logoUrl?: string | null; accentColor?: string | null };
type Returned = { ok: boolean; message: string } | undefined;

function HubSpotLogo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="20.5" cy="19.5" r="5.2" fill="none" stroke="#FF7A59" strokeWidth="3" />
      <path d="M20.5 14.3V8.6" stroke="#FF7A59" strokeWidth="3" strokeLinecap="round" />
      <circle cx="20.5" cy="7" r="2.6" fill="#FF7A59" />
      <path d="M16.6 16.2 8.4 10" stroke="#FF7A59" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="7" cy="9" r="2.4" fill="#FF7A59" />
      <path d="M16.9 23.4 12.6 27.5" stroke="#FF7A59" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="11.4" cy="28.4" r="2" fill="#FF7A59" />
    </svg>
  );
}
/** Attio's own mark (attio.com), drawn in the text colour so it reads on light and dark. */
function AttioLogo() {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M16.7802 11.5317L15.4723 9.43851C15.4723 9.43851 15.4674 9.42975 15.4645 9.42586L15.3613 9.2614C15.1667 8.94902 14.83 8.76218 14.4622 8.76121L12.3553 8.75439L12.2084 8.98989L9.69085 13.0187L9.55169 13.2415L10.6066 14.927C10.8012 15.2404 11.1379 15.4272 11.5087 15.4272H14.4612C14.8251 15.4272 15.1696 15.2355 15.3623 14.928L15.4664 14.7616C15.4664 14.7616 15.4703 14.7567 15.4713 14.7548L16.7812 12.6586C16.9962 12.3161 16.9962 11.8733 16.7812 11.5317H16.7802ZM16.3812 12.4085L15.0714 14.5047C15.0655 14.5144 15.0587 14.5222 15.0529 14.53C15.0071 14.5816 14.9478 14.5884 14.9215 14.5884C14.8913 14.5884 14.8174 14.5796 14.7697 14.5037L13.4598 12.4076C13.4452 12.3842 13.4326 12.3599 13.4209 12.3336C13.4092 12.3083 13.4005 12.283 13.3927 12.2567C13.3635 12.1516 13.3635 12.0387 13.3927 11.9336C13.4073 11.8821 13.4297 11.8305 13.4589 11.7838L14.7668 9.68958C14.7668 9.68958 14.7687 9.68666 14.7697 9.68472C14.8008 9.63801 14.8397 9.6166 14.8738 9.60979C14.8874 9.60589 14.8991 9.60492 14.9088 9.60297C14.9137 9.60297 14.9186 9.60297 14.9234 9.60297C14.9536 9.60297 15.0285 9.61271 15.0752 9.68861L16.3831 11.7818C16.5028 11.9726 16.5028 12.2178 16.3831 12.4085H16.3812Z" stroke="currentColor" strokeWidth="1.2" />
      <path d="M12.9099 6.46677C13.124 6.12325 13.124 5.68145 12.9099 5.33988L11.602 3.24665L11.493 3.07051C11.2974 2.75813 10.9607 2.57129 10.5909 2.57129H7.63838C7.26956 2.57129 6.93285 2.75813 6.73628 3.07148L1.4492 11.5329C1.34313 11.7023 1.28571 11.8979 1.28571 12.0964C1.28571 12.2949 1.34216 12.4905 1.44823 12.6589L2.8661 14.9292C3.0617 15.2426 3.3984 15.4284 3.76722 15.4284H6.71974C7.0905 15.4284 7.42721 15.2416 7.62184 14.9282L7.72986 14.757C7.72986 14.757 7.72986 14.757 7.72986 14.755C7.72986 14.755 7.7318 14.7521 7.7318 14.7511L8.78572 13.0656L11.9095 8.06662L12.9079 6.46775L12.9099 6.46677ZM12.6014 5.90332C12.6014 6.01134 12.5712 6.12034 12.5099 6.21668L7.33087 14.5059C7.28416 14.5808 7.20923 14.5896 7.17906 14.5896C7.14889 14.5896 7.07493 14.5808 7.02725 14.5059L5.71837 12.4088C5.59965 12.219 5.59965 11.9748 5.71837 11.783L10.8974 3.49577C10.9441 3.41987 11.0191 3.41111 11.0492 3.41111C11.0794 3.41111 11.1543 3.41987 11.202 3.49675L12.5099 5.58997C12.5712 5.68631 12.6014 5.79531 12.6014 5.90332V5.90332Z" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function SheetsLogo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 3h11l7 7v17a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#0F9D58" />
      <path d="M19 3v7h7z" fill="#87CEAC" />
      <rect x="10" y="14" width="12" height="10" rx="1" fill="#fff" />
      <path d="M10 17.4h12M10 20.7h12M15 14v10" stroke="#0F9D58" strokeWidth="1.3" />
    </svg>
  );
}
function MeetingsLogo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="6" width="24" height="22" rx="4" fill="#9b7bf0" />
      <path d="M4 12h24" stroke="#fff" strokeWidth="2" />
      <path d="M10 3.5v5M22 3.5v5" stroke="#9b7bf0" strokeWidth="2.6" strokeLinecap="round" />
      <path d="m11 20 3.4 3.2L21.5 16" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const HUBSPOT_STEPS = [
  "In the client's HubSpot: Development → Keys → Service keys → Create service key",
  "Name it QC Growth",
  "Scopes: crm.objects.contacts.read + write, crm.objects.companies.read + write, crm.schemas.contacts.read + write, crm.objects.owners.read, crm.lists.write (the QC Growth segment), crm.objects.deals.read + write and crm.schemas.deals.read + write (booked meetings as deals), and settings.users.write if there is no QC Growth user in HubSpot yet",
  "Copy the key (starts with pat-) and paste it here",
];
const ATTIO_STEPS = [
  "In the client's Attio: Workspace settings → Developers → New access token",
  "Name it QC Growth",
  "Read & write: Records, Object configuration, List configuration, List entries, Notes. Read: User management",
  "Copy the token and paste it here",
];
export const HUBSPOT_DEAL_SCOPES = ["crm.objects.deals.read", "crm.objects.deals.write", "crm.schemas.deals.read", "crm.schemas.deals.write"];

function when(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function clock(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
/** Build log stamp: "Oct 9, 2:54:07 PM". */
function logTime(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}
/** The Booked Meeting (QC) stage exists, so booked meetings land as deals. */
const dealsAreLive = (crm: Crm | null, provider: string) => {
  const deals = crm?.plan?.deals;
  return Boolean(deals && (provider === "hubspot" ? deals.stageId : deals.statusExists));
};
const hubspotHost = (crm: Crm) => ((crm.accountName ?? "").includes("hubspot.com") ? crm.accountName : "app.hubspot.com");

/** The CRM's state and actions, shared by the rail (status) and the HubSpot and Attio views. */
function useCrm(slug: string) {
  const [crm, setCrm] = useState<Crm | null>(null);
  const [appReady, setAppReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const payload = await fetch(`/api/crm-push/${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
    if (payload?.ok) { setCrm(payload.crm); setAppReady(Boolean(payload.hubspotApp)); }
    setLoaded(true);
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  const step = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action); setError(""); setNote("");
    try {
      const response = await fetch(`/api/crm-push/${encodeURIComponent(slug)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) { setError(String(payload.error || `That step failed (${response.status}).`)); return null; }
      if (payload.crm !== undefined) setCrm(payload.crm);
      return payload;
    } finally {
      setBusy("");
    }
  };
  return { crm, appReady, loaded, busy, error, note, setNote, step, load };
}
type CrmState = ReturnType<typeof useCrm>;

function BuildLog({ entries }: { entries: Crm["buildLog"] }) {
  const [all, setAll] = useState(false);
  const numbered = entries.map((entry, index) => ({ ...entry, n: index + 1 })).reverse();
  const shown = all ? numbered : numbered.slice(0, 12);
  return (
    <section className="ops-panel ops-flush" aria-label="Build log">
      <div className="ops-panel-head">
        <span className="ops-label">Build log · {entries.length} {entries.length === 1 ? "step" : "steps"} · newest first</span>
        {entries.length > 12 && <button type="button" className="ops-link" onClick={() => setAll((value) => !value)}>{all ? "Show latest" : "Show all"}</button>}
      </div>
      <div className="ops-scroll">
        <table className="ops-log">
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.n}>
                <td className="ops-log-n">{entry.n}</td>
                <td className="ops-log-at"><time dateTime={entry.at}>{logTime(entry.at ?? "")}</time></td>
                <td className={`ops-log-r ops-r-${entry.result}`}>{entry.result}</td>
                <td className="ops-log-k">{entry.kind}</td>
                <td className="ops-log-name">{entry.name}</td>
                <td className="ops-log-d">{entry.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CrmView({ slug, clientName, provider, state, returned }: { slug: string; clientName: string; provider: "hubspot" | "attio"; state: CrmState; returned: Returned }) {
  const { crm, appReady, loaded, busy, error, note, setNote, step } = state;
  const [apiKey, setApiKey] = useState("");
  const [ownerId, setOwnerId] = useState("");
  useEffect(() => { if (crm?.plan?.settings.ownerId) setOwnerId(crm.plan.settings.ownerId); }, [crm?.plan?.settings.ownerId]);
  const [lifecycle, setLifecycle] = useState(true);
  const [leadSource, setLeadSource] = useState(true);
  const [dealPipeline, setDealPipeline] = useState("");
  useEffect(() => {
    if (crm?.plan?.deals) setDealPipeline(crm.plan.deals.pipelineId ?? crm.plan.deals.pipelines?.[0]?.id ?? "");
  }, [crm?.plan?.deals?.pipelineId, crm?.plan?.deals?.pipelines]);
  const [meetingsPushed, setMeetingsPushed] = useState<null | { created: number; updated: number; failed: number }>(null);
  const [tested, setTested] = useState<null | { name: string; company: string; campaign: string; created: boolean; link: string | null }>(null);
  const [progress, setProgress] = useState<{ pushed: number; created: number; updated: number; unchanged: number; failed: number } | null>(null);

  const pushAll = async () => {
    let offset = 0;
    const total = { pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
    setProgress({ ...total });
    for (let round = 0; round < 40; round += 1) {
      const payload = await step("push", { offset });
      if (!payload?.summary) break;
      if (payload.meetings) setMeetingsPushed({ created: payload.meetings.created, updated: payload.meetings.updated, failed: payload.meetings.failed });
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += Number(payload.summary[key]) || 0;
      setProgress({ ...total });
      if (payload.summary.nextOffset === null || payload.summary.nextOffset === undefined) break;
      offset = payload.summary.nextOffset;
    }
    setNote(`Done: ${total.created} created, ${total.updated} updated, ${total.unchanged} unchanged${total.failed ? `, ${total.failed} failed` : ""}.`);
  };

  const name = provider === "hubspot" ? "HubSpot" : "Attio";
  const connectedHere = Boolean(crm?.connected && crm.provider === provider);
  const otherProvider = crm?.connected && crm.provider !== provider;
  const built = connectedHere && crm?.status === "built";
  const creates = crm?.plan?.items.filter((item) => item.action === "create") ?? [];
  const verified = crm?.buildLog.filter((entry) => entry.result === "verified").length ?? 0;
  const deals = crm?.plan?.deals;
  const dealsLive = dealsAreLive(crm, provider);
  // Why the Booked Meeting (QC) stage can't be built yet. It is never skipped: the build waits on it.
  const dealScopesMissing = provider === "hubspot" && crm?.audit?.scopes ? HUBSPOT_DEAL_SCOPES.filter((scope) => !crm.audit!.scopes!.includes(scope)) : [];
  const dealsBlocker = dealsLive ? null
    : deals?.blocker ?? (dealScopesMissing.length ? `The service key can't read this HubSpot's deal pipelines. Add ${dealScopesMissing.join(", ")} to the QC Growth key (Development → Keys), then re-read.` : null)
      ?? (provider === "attio" && deals && !deals.available ? "The Deals object is switched off in this Attio workspace (or the token can't see it). Turn on Deals in Attio (Workspace settings → Objects), then re-read." : null);
  const showPlan = connectedHere && crm?.plan && (crm.status !== "built" || !dealsLive);

  if (!loaded) return <p className="ops-muted">Loading {name}…</p>;

  if (otherProvider) {
    return (
      <div className="ops-stack">
        <div className="ops-titlebar"><div><span className="ops-label">{name}</span><h1>{clientName} uses {crm?.provider === "hubspot" ? "HubSpot" : "Attio"}</h1></div></div>
        <section className="ops-panel"><p className="ops-muted">A client uses one CRM. Disconnect {crm?.provider === "hubspot" ? "HubSpot" : "Attio"} first to switch.</p></section>
      </div>
    );
  }

  if (!connectedHere) {
    return (
      <div className="ops-stack">
        <div className="ops-titlebar"><div><span className="ops-label">{name}</span><h1>Connect {name}</h1></div></div>
        <section className="ops-panel">
          <ol className="ops-steps">{(provider === "hubspot" ? HUBSPOT_STEPS : ATTIO_STEPS).map((line) => <li key={line}>{line}</li>)}</ol>
          <div className="ops-row">
            <input className="ops-input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === "hubspot" ? "pat-…" : "Attio access token"} aria-label={`${name} key`} />
            <button type="button" className="ops-btn ops-pri" disabled={!apiKey.trim() || Boolean(busy)} onClick={() => void step("connect", { provider, apiKey: apiKey.trim() }).then((ok) => ok && setApiKey(""))}>{busy === "connect" ? `Reading ${name}…` : "Connect"}</button>
          </div>
        </section>
        {error && <p className="ops-error" role="alert">{error}</p>}
      </div>
    );
  }

  const c = crm!;
  return (
    <div className="ops-stack">
      <div className="ops-titlebar">
        <div><span className="ops-label">{name}</span><h1>{built ? `Replies flowing into ${name}` : `Set up ${name}`}</h1></div>
        {built && (
          <div className="ops-row">
            <button type="button" className="ops-btn ops-sec" disabled={Boolean(busy)} onClick={() => void step("push_one").then((payload) => payload?.test && setTested(payload.test))}>{busy === "push_one" ? "Pushing 1…" : "Push 1 lead (test)"}</button>
            <button type="button" className="ops-btn ops-pri" disabled={Boolean(busy)} onClick={() => void pushAll()}>{busy === "push" ? "Pushing…" : "Push all replies"}</button>
          </div>
        )}
      </div>

      {c.audit && (
        <div className="ops-tiles">
          <div className="ops-tile"><span className="ops-label">{provider === "attio" ? "People" : "Contacts"}</span><span className="ops-num">{c.audit.contacts.toLocaleString()}{c.audit.countsCapped && c.audit.contacts >= 2000 ? "+" : ""}</span></div>
          <div className="ops-tile"><span className="ops-label">Companies</span><span className="ops-num">{c.audit.companies.toLocaleString()}{c.audit.countsCapped && c.audit.companies >= 2000 ? "+" : ""}</span></div>
          <div className="ops-tile"><span className="ops-label">{built ? "QC fields" : "Owners"}</span><span className="ops-num">{built ? verified : c.audit.owners.length}</span></div>
          <div className="ops-tile"><span className="ops-label">Last push</span><span className="ops-num ops-num-sm">{clock(c.lastPushAt)}</span></div>
        </div>
      )}

      {built && (
        <div className="ops-strip">
          <label className="ops-check"><input type="checkbox" checked={c.autoPush} disabled={Boolean(busy)} onChange={(e) => void step("auto", { on: e.target.checked })} /> Push new replies automatically</label>
          {tested && <span className="ops-ok">{tested.created ? "Created" : "Updated"} {tested.name}{tested.company ? ` (${tested.company})` : ""} · {tested.campaign}{tested.link && <> · <a href={tested.link} target="_blank" rel="noreferrer">Open ↗</a></>}</span>}
          {progress && <span className="ops-muted">{progress.created} created · {progress.updated} updated · {progress.unchanged} unchanged{progress.failed ? ` · ${progress.failed} failed` : ""}</span>}
          {meetingsPushed && <span className="ops-muted">Deals: {meetingsPushed.created} created · {meetingsPushed.updated} updated{meetingsPushed.failed ? ` · ${meetingsPushed.failed} failed` : ""}</span>}
        </div>
      )}
      {c.lastPushSummary?.errors?.length ? <ul className="ops-errors">{c.lastPushSummary.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}

      {showPlan && c.plan && (
        <section className="ops-panel">
          <div className="ops-panel-head"><span className="ops-label">Game plan</span>{creates.length > 0 && <span className="ops-tag">{creates.length} to create</span>}</div>
          {c.plan.warnings.map((w) => <p key={w} className="ops-warn">{w}</p>)}
          <ul className="ops-plan">
            {c.plan.items.map((item) => (
              <li key={item.id} className={`ops-plan-${item.action}`}>
                <span className="ops-tag">{item.action === "create" ? "Create" : item.action === "reuse" ? "Existing" : "Skip"}</span>
                <div><strong>{item.label}</strong> <code>{item.name}</code><small>{item.detail}</small></div>
              </li>
            ))}
          </ul>
          <div className="ops-choices">
            {provider === "hubspot" && <label className="ops-check"><input type="checkbox" checked={lifecycle} disabled={!c.plan.settings.lifecycleOnCreate} onChange={(e) => setLifecycle(e.target.checked)} /> New contacts get lifecycle stage Lead</label>}
            {c.plan.settings.leadSourceProperty && <label className="ops-check"><input type="checkbox" checked={leadSource} onChange={(e) => setLeadSource(e.target.checked)} /> New contacts get lead source QC Growth</label>}
            <label className="ops-field">{provider === "attio" ? "Owner on the QC Growth list" : "Owner for new contacts"}
              <select className="ops-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                {!c.plan.settings.ownerId && <option value="">{provider === "attio" ? "None (invite QC Growth to set it)" : "QC Growth (added by the build)"}</option>}
                {(c.audit?.owners ?? []).map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
              </select>
            </label>
            {provider === "hubspot" && deals && (deals.pipelines?.length ?? 0) > 0 && (
              <label className="ops-field">Pipeline for the Booked Meeting (QC) stage
                <select className="ops-input" value={dealPipeline} onChange={(e) => setDealPipeline(e.target.value)}>
                  {(deals.pipelines ?? []).map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.label}{pipeline.hasStage ? " (stage already there)" : ""}</option>)}
                </select>
              </label>
            )}
          </div>
          <p className="ops-muted">{c.plan.conversation}</p>
          <p className="ops-muted">Not touched: {c.plan.notTouched.join(" · ")}</p>
          {dealsBlocker && <p className="ops-error">Booked Meeting (QC) stage: {dealsBlocker}</p>}
          <div className="ops-row">
            <button type="button" className="ops-btn ops-pri" disabled={Boolean(busy) || Boolean(dealsBlocker)} onClick={() => void step("apply", { settings: { ownerId, lifecycleOnCreate: lifecycle, useLeadSource: leadSource, pushDeals: true, dealPipelineId: dealPipeline } })}>
              {busy === "apply" ? "Building…" : `Approve and build${creates.length ? ` (${creates.length} to create)` : ""}`}
            </button>
            <button type="button" className="ops-btn ops-sec" disabled={Boolean(busy)} onClick={() => void step("replan")}>{busy === "replan" ? "Reading…" : `Re-read ${name}`}</button>
          </div>
        </section>
      )}

      {built && (
        <div className="ops-pair">
          {provider === "hubspot" ? (
            <section className="ops-panel">
              <div className="ops-panel-head"><span className="ops-label">Dashboard</span>{c.config?.dashboard_id ? <span className="ops-state ops-good">● Built</span> : <span className="ops-state ops-wait">● Not built</span>}</div>
              {returned && <p className={returned.ok ? "ops-ok" : "ops-error"}>{returned.message}</p>}
              <div className="ops-h2">QC Growth{c.config?.dashboard_id ? " · 7 reports" : ""}</div>
              <ul className="ops-reports"><li>Leads who replied</li><li>Replies by month</li><li>Replies by campaign</li><li>Reply sentiment</li><li>Replies by platform</li><li>Replies by sender</li><li>Latest replies</li></ul>
              {!c.hubspotUser ? (
                <div className="ops-row">
                  <a className={`ops-btn ops-pri${appReady ? "" : " ops-disabled"}`} href={appReady ? `/api/hubspot/oauth/start?slug=${encodeURIComponent(slug)}` : undefined} aria-disabled={!appReady}>Connect QC Growth user</a>
                  {!appReady && <span className="ops-muted">App keys not on Vercel yet</span>}
                </div>
              ) : (
                <>
                  <div className="ops-row">
                    {c.config?.dashboard_id && <a className="ops-btn ops-pri" href={`https://${hubspotHost(c)}/reports-dashboard/${c.accountId}/view/${c.config.dashboard_id}`} target="_blank" rel="noreferrer">Open dashboard ↗</a>}
                    <button type="button" className={`ops-btn ${c.config?.dashboard_id ? "ops-sec" : "ops-pri"}`} disabled={Boolean(busy)} onClick={() => void step("reporting").then((payload) => payload && setNote(payload.built ? "Reports and dashboard ready." : payload.pending ? (payload.failed ?? [])[0] : `Some steps failed: ${(payload.failed ?? []).join("; ")}`))}>{busy === "reporting" ? "Building…" : c.config?.dashboard_id ? "Rebuild" : "Build reports and dashboard"}</button>
                  </div>
                  <div className="ops-row ops-quiet"><span className="ops-muted">Signed in as {c.hubspotUser.user || "QC Growth"}</span><button type="button" className="ops-link" disabled={Boolean(busy)} onClick={() => void step("disconnect_user")}>Sign out</button></div>
                </>
              )}
              {!c.config?.dashboard_id && c.accountId && (
                <div className="ops-row ops-quiet"><a className="ops-link" href={`https://${hubspotHost(c)}/product-updates/${c.accountId}/in-beta?puQuery=api&rollout=327896`} target="_blank" rel="noreferrer">Join Reporting API beta ↗</a></div>
              )}
            </section>
          ) : (
            <section className="ops-panel">
              <div className="ops-panel-head"><span className="ops-label">In Attio</span><span className="ops-state ops-good">● Built</span></div>
              <div className="ops-h2">QC Growth list · QC Dashboard</div>
              <div className="ops-row">
                {c.config?.attio_slug && c.plan?.settings.listId && <a className="ops-btn ops-pri" href={`https://app.attio.com/${c.config.attio_slug}/collection/${c.plan.settings.listId}`} target="_blank" rel="noreferrer">Open QC Growth list ↗</a>}
                {c.config?.attio_slug && <a className="ops-btn ops-sec" href={`https://app.attio.com/${c.config.attio_slug}/apps/qc-growth-dashboard/qc-growth`} target="_blank" rel="noreferrer">Open QC Dashboard ↗</a>}
              </div>
            </section>
          )}

          <section className="ops-panel">
            <div className="ops-panel-head">
              <span className="ops-label">Booked meetings → Deals</span>
              {dealsLive ? <span className="ops-state ops-good">● Live</span> : dealsBlocker ? <span className="ops-state ops-bad">● Blocked</span> : <span className="ops-state ops-wait">● Needs approval</span>}
            </div>
            <div className="ops-h2">Booked Meeting (QC) stage</div>
            {dealsLive && deals ? (
              <p className="ops-muted">{provider === "hubspot" ? `${deals.pipelineLabel || "Pipeline"} → Booked Meeting (QC)` : "Deals → Booked Meeting (QC)"} · first stage, one deal per booked lead, named after the company</p>
            ) : dealsBlocker ? (
              <>
                <p className="ops-error">{dealsBlocker}</p>
                <div className="ops-row"><button type="button" className="ops-btn ops-sec" disabled={Boolean(busy)} onClick={() => void step("replan")}>{busy === "replan" ? "Reading…" : `Re-read ${name}`}</button></div>
              </>
            ) : (
              <p className="ops-muted">Choose the pipeline in the game plan above and approve.</p>
            )}
          </section>
        </div>
      )}

      {note && <p className="ops-ok">{note}</p>}
      {error && <p className="ops-error" role="alert">{error}</p>}

      {c.buildLog.length > 0 && <BuildLog entries={c.buildLog} />}
    </div>
  );
}

function ContentSwitch({ value, disabled, onChange }: { value: "replies" | "meetings"; disabled: boolean; onChange: (value: "replies" | "meetings") => void }) {
  return (
    <div className="ops-seg" role="radiogroup" aria-label="What goes in this sheet">
      {(["replies", "meetings"] as const).map((option) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} className={value === option ? "ops-seg-on" : ""} disabled={disabled} onClick={() => onChange(option)}>
          {option === "replies" ? "Replies" : "Booked meetings"}
        </button>
      ))}
    </div>
  );
}

/** One connected sheet: what it holds, its column mapping, formatting and pushing. */
function SheetCard({ sheet, fields, run, busy }: { sheet: Sheet; fields: FieldsByContent; run: (action: string, extra?: Record<string, unknown>) => Promise<SheetsPayload | null>; busy: string }) {
  const [mapping, setMapping] = useState<string[]>(sheet.config.mapping ?? []);
  useEffect(() => setMapping(sheet.config.mapping ?? []), [sheet.config.mapping]);
  const [progress, setProgress] = useState<{ created: number; updated: number; failed: number } | null>(null);
  const step = (action: string, extra: Record<string, unknown> = {}) => run(action, { sheet: sheet.key, ...extra });
  const mine = busy.startsWith(`${sheet.key}:`);
  const doing = (action: string) => busy === `${sheet.key}:${action}`;
  const built = sheet.status === "built";
  const headers = sheet.config.headers ?? [];
  const meetings = sheet.content === "meetings";

  const pushAll = async () => {
    let offset = 0;
    const total = { created: 0, updated: 0, failed: 0 };
    setProgress({ ...total });
    for (let round = 0; round < 40; round += 1) {
      const payload = await step("push", { offset });
      if (!payload?.summary) break;
      total.created += payload.summary.created; total.updated += payload.summary.updated; total.failed += payload.summary.failed;
      setProgress({ ...total });
      if (payload.summary.nextOffset == null) break;
      offset = payload.summary.nextOffset;
    }
  };

  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <span className="ops-label">{meetings ? "Booked meetings" : "Replies"} · {built ? `last push ${when(sheet.lastPushAt)}` : "mapping not confirmed"}</span>
        <span className={`ops-state ${built ? "ops-good" : "ops-wait"}`}>● {built ? "Live" : "Setup"}</span>
      </div>
      <div className="ops-titleline">
        <div className="ops-h2">{sheet.accountName ?? "Sheet"} <span className="ops-muted">· {sheet.config.tab ?? ""}</span></div>
        {sheet.config.url && <a className="ops-link" href={sheet.config.url} target="_blank" rel="noreferrer">Open sheet ↗</a>}
      </div>
      <ContentSwitch value={sheet.content} disabled={Boolean(busy)} onChange={(value) => { if (value !== sheet.content) void step("content", { content: value }); }} />
      <ul className="ops-map">
        {headers.map((header, index) => index === sheet.config.qcIdColumn ? null : (
          <li key={`${header}-${index}`}>
            <span>{header || `Column ${index + 1}`}</span>
            <select className="ops-input" value={mapping[index] ?? ""} onChange={(e) => setMapping((current) => { const next = [...current]; next[index] = e.target.value; return next; })} aria-label={`Field for ${header || `column ${index + 1}`}`}>
              <option value="">Leave empty</option>
              {fields[sheet.content].map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <div className="ops-row">
        <button type="button" className={`ops-btn ${built ? "ops-sec" : "ops-pri"}`} disabled={Boolean(busy)} onClick={() => void step("map", { mapping })}>{doing("map") ? "Saving…" : built ? "Save mapping" : "Confirm mapping"}</button>
        <button type="button" className="ops-btn ops-sec" disabled={Boolean(busy)} onClick={() => void step("reread")}>{doing("reread") ? "Reading…" : "Re-read headers"}</button>
        {built && <button type="button" className="ops-btn ops-sec" disabled={Boolean(busy)} onClick={() => void step("format")}>{doing("format") ? "Formatting…" : "Format sheet"}</button>}
      </div>
      {built && (
        <div className="ops-row">
          <button type="button" className="ops-btn ops-pri" disabled={Boolean(busy)} onClick={() => void pushAll()}>{doing("push") ? "Pushing…" : meetings ? "Push all booked meetings" : "Push all replies"}</button>
          <label className="ops-check"><input type="checkbox" checked={sheet.autoPush} disabled={Boolean(busy)} onChange={(e) => void step("auto", { on: e.target.checked })} /> Push new {meetings ? "bookings" : "replies"} automatically</label>
        </div>
      )}
      {progress && <p className="ops-muted">{progress.created} added · {progress.updated} updated{progress.failed ? ` · ${progress.failed} failed` : ""}</p>}
      {sheet.lastPushSummary?.errors?.length ? <ul className="ops-errors">{sheet.lastPushSummary.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
      <div className="ops-row ops-quiet"><button type="button" className="ops-link ops-danger" disabled={Boolean(busy) && !mine} onClick={() => void step("disconnect")}>{doing("disconnect") ? "Removing…" : "Remove sheet"}</button></div>
    </section>
  );
}

function useSheets(slug: string) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [robot, setRobot] = useState<string | null>(null);
  const [google, setGoogle] = useState<{ email: string } | null>(null);
  const [googleOauth, setGoogleOauth] = useState(false);
  const [fields, setFields] = useState<FieldsByContent>({ replies: [], meetings: [] });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const take = (payload: SheetsPayload) => {
    if (payload.sheets) setSheets(payload.sheets);
    if (payload.google !== undefined) setGoogle(payload.google);
    if (payload.googleOauth !== undefined) setGoogleOauth(payload.googleOauth);
    if (payload.robotEmail !== undefined) setRobot(payload.robotEmail);
    if (payload.fieldsByContent) setFields(payload.fieldsByContent);
  };
  useEffect(() => {
    void fetch(`/api/sheets-push/${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json()).then((payload) => { if (payload?.ok) take(payload); }).catch(() => undefined).finally(() => setLoaded(true));
  }, [slug]);
  const run = async (action: string, extra: Record<string, unknown> = {}): Promise<SheetsPayload | null> => {
    setBusy(`${String(extra.sheet ?? "new")}:${action}`); setError("");
    try {
      const response = await fetch(`/api/sheets-push/${encodeURIComponent(slug)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) { setError(String(payload.error || `That step failed (${response.status}).`)); return null; }
      take(payload);
      return payload;
    } finally {
      setBusy("");
    }
  };
  return { sheets, robot, google, googleOauth, fields, loaded, busy, error, run };
}
type SheetsState = ReturnType<typeof useSheets>;

function SheetsView({ slug, state, returned }: { slug: string; state: SheetsState; returned: Returned }) {
  const { sheets, robot, google, googleOauth, fields, loaded, busy, error, run } = state;
  const [url, setUrl] = useState("");
  const [content, setContent] = useState<"replies" | "meetings">("replies");
  const writer = google?.email ?? robot;
  const live = sheets.filter((sheet) => sheet.status === "built").length;

  if (!loaded) return <p className="ops-muted">Loading sheets…</p>;
  return (
    <div className="ops-stack">
      <div className="ops-titlebar">
        <div><span className="ops-label">Google Sheets</span><h1>{sheets.length ? `${sheets.length} ${sheets.length === 1 ? "sheet" : "sheets"}, ${live} live` : "Push into Google Sheets"}</h1></div>
      </div>

      <section className="ops-panel">
        <div className="ops-panel-head"><span className="ops-label">Google account</span>{google ? <span className="ops-state ops-good">● Signed in</span> : <span className="ops-state ops-wait">● Not signed in</span>}</div>
        {returned && <p className={returned.ok ? "ops-ok" : "ops-error"}>{returned.message}</p>}
        {google ? (
          <p className="ops-muted">Writing as {google.email}. Any sheet this account can edit can be connected.</p>
        ) : (
          <div className="ops-row">
            <a className={`ops-btn ops-pri${googleOauth ? "" : " ops-disabled"}`} href={googleOauth ? `/api/google/oauth/start?return=${encodeURIComponent(`/operations/${slug}`)}` : undefined} aria-disabled={!googleOauth}>Connect Google</a>
            <span className="ops-muted">{googleOauth ? "Sign in once as admin@qcgrowth.com" : "Google sign-in keys not on Vercel yet"}</span>
          </div>
        )}
      </section>

      {sheets.map((sheet) => <SheetCard key={sheet.key} sheet={sheet} fields={fields} run={run} busy={busy} />)}

      {writer && (
        <section className="ops-panel">
          <div className="ops-panel-head"><span className="ops-label">{sheets.length ? "Add another sheet" : "Connect a sheet"}</span></div>
          <ContentSwitch value={content} disabled={Boolean(busy)} onChange={setContent} />
          <ol className="ops-steps">
            <li>Make the sheet and put your headers in row 1</li>
            <li>{google ? <>Make sure <code>{writer}</code> can edit it (its own sheets already can)</> : <>Share it with <code>{writer}</code> as Editor</>}</li>
            <li>Paste the sheet's link here</li>
          </ol>
          <div className="ops-row">
            <input className="ops-input ops-grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" aria-label="Sheet link" />
            <button type="button" className="ops-btn ops-pri" disabled={!url.trim() || Boolean(busy)} onClick={() => void run("connect", { url: url.trim(), content }).then((ok) => ok && setUrl(""))}>{busy === "new:connect" ? "Reading sheet…" : "Connect"}</button>
          </div>
        </section>
      )}
      {error && <p className="ops-error" role="alert">{error}</p>}
    </div>
  );
}

const VIEW_NAMES: Record<View, string> = { hubspot: "HubSpot", attio: "Attio", sheets: "Google Sheets", meetings: "Booked meetings" };
const VIEW_LOGOS: Record<View, () => React.ReactElement> = { hubspot: HubSpotLogo, attio: AttioLogo, sheets: SheetsLogo, meetings: MeetingsLogo };

export default function ClientOperations({ slug }: { slug: string }) {
  const [client, setClient] = useState<Client | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [returned, setReturned] = useState<{ hubspot?: Returned; sheets?: Returned }>({});
  const crmState = useCrm(slug);
  const sheetsState = useSheets(slug);
  const { crm } = crmState;

  useEffect(() => {
    void fetch(`/api/onboarding/clients/${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json()).then((payload) => { if (payload?.client) setClient(payload.client); }).catch(() => undefined);
  }, [slug]);

  // The view comes from ?view=, or from a sign-in coming back (HubSpot user, Google); the address bar is tidied.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const asked = params.get("view") as View | null;
    if (params.get("google") === "connected" || params.get("google_error")) {
      setReturned({ sheets: params.get("google") === "connected" ? { ok: true, message: "Google connected." } : { ok: false, message: params.get("google_error") ?? "" } });
      setView("sheets");
    } else if (params.get("hubspot") === "connected" || params.get("hubspot_error")) {
      setReturned({ hubspot: params.get("hubspot") === "connected" ? { ok: true, message: "QC Growth user connected." } : { ok: false, message: params.get("hubspot_error") ?? "" } });
      setView("hubspot");
    } else if (asked && VIEWS.includes(asked)) {
      setView(asked);
    }
  }, []);
  // No view asked for: open on the client's CRM once it is known.
  useEffect(() => {
    if (view || !crmState.loaded) return;
    setView(crm?.connected && crm.provider === "attio" ? "attio" : "hubspot");
  }, [view, crmState.loaded, crm?.connected, crm?.provider]);
  useEffect(() => {
    if (!view) return;
    const params = new URLSearchParams(window.location.search);
    for (const done of ["hubspot", "hubspot_error", "google", "google_error"]) params.delete(done);
    params.set("view", view);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }, [view]);

  const status = (target: View): { label: string; tone: "good" | "wait" | "off" } => {
    if (target === "hubspot" || target === "attio") {
      if (!crm?.connected || crm.provider !== target) return { label: crm?.connected ? "Off" : "Connect", tone: "off" };
      if (crm.status !== "built") return { label: "Setup", tone: "wait" };
      return dealsAreLive(crm, target) ? { label: "Live", tone: "good" } : { label: "Deals", tone: "wait" };
    }
    if (target === "sheets") {
      const live = sheetsState.sheets.filter((sheet) => sheet.status === "built").length;
      if (!sheetsState.sheets.length) return { label: "Add", tone: "off" };
      return live ? { label: `${live} live`, tone: "good" } : { label: "Setup", tone: "wait" };
    }
    return { label: "Flow", tone: "off" };
  };

  const name = client?.name ?? slug;
  const crmHere = crm?.connected && (view === "hubspot" || view === "attio") && crm.provider === view;

  return (
    <div className="ops">
      <aside className="ops-rail">
        <div className="ops-client">
          <span className="ops-avatar" style={client?.logoUrl ? undefined : { background: client?.accentColor || undefined }}>
            {client?.logoUrl ? <img src={client.logoUrl} alt="" /> : (name[0] || "?").toUpperCase()}
          </span>
          <div><div className="ops-client-name">{name}</div><Link href={`/onboarding/${slug}`} className="ops-back">← Onboarding</Link></div>
        </div>

        <nav aria-label="Destinations" className="ops-nav">
          <span className="ops-label">Destinations</span>
          {VIEWS.map((target) => {
            const Logo = VIEW_LOGOS[target];
            const s = status(target);
            return (
              <button key={target} type="button" className={`ops-dest${view === target ? " ops-dest-on" : ""}`} aria-current={view === target ? "page" : undefined} onClick={() => setView(target)}>
                <span className={`ops-dest-logo${target === "attio" ? " ops-attio" : ""}`}><Logo /></span>
                <span className="ops-dest-name">{VIEW_NAMES[target]}</span>
                <span className={`ops-dest-state ops-${s.tone}`}>{s.label}</span>
              </button>
            );
          })}
        </nav>

        {crmHere && crm && (
          <div className="ops-panel ops-account">
            <span className="ops-label">Account</span>
            {crm.provider === "hubspot" ? <><span>{crm.accountName}</span><span>portal {crm.accountId}</span></> : <span>{crm.accountName} workspace</span>}
            <span className="ops-faint">key {crm.keyMasked}</span>
            <button type="button" className="ops-link ops-danger" disabled={Boolean(crmState.busy)} onClick={() => void crmState.step("disconnect")}>Disconnect</button>
          </div>
        )}
      </aside>

      <main className="ops-main">
        {!view && <p className="ops-muted">Loading…</p>}
        {(view === "hubspot" || view === "attio") && <CrmView key={view} slug={slug} clientName={name} provider={view} state={crmState} returned={view === "hubspot" ? returned.hubspot : undefined} />}
        {view === "sheets" && <SheetsView slug={slug} state={sheetsState} returned={returned.sheets} />}
        {view === "meetings" && (
          <div className="ops-stack ops-meetings"><BookingAlerts focus={slug} /></div>
        )}
      </main>
    </div>
  );
}
