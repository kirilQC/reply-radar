// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/**
 * The onboarding cockpit: four logo buttons at the top right of a client's onboarding page. HubSpot and Attio
 * push the client's replies into their CRM (connect → read-only audit → plan → approve and build → push),
 * Google Sheets does the same into a sheet, and the calendar opens the booked meetings workflow.
 */

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
    countsCapped?: boolean;
    lists?: Array<{ name: string }>;
  };
  plan: null | {
    items: PlanItem[];
    settings: { leadSourceProperty: string | null; lifecycleOnCreate: string | null; ownerId: string | null };
    conversation: string;
    notTouched: string[];
    warnings: string[];
    deals?: { enabled: boolean; pipelineId?: string | null; pipelineLabel?: string; stageExists?: boolean; stageId?: string | null; createProperties?: string[]; pipelines?: Array<{ id: string; label: string; hasStage: boolean }>; available?: boolean; statusExists?: boolean; createAttributes?: string[] };
  };
  buildLog: Array<{ at?: string; kind: string; name: string; result: string; detail: string }>;
  autoPush: boolean;
  config: { dashboard_id?: string };
  hubspotUser: null | { user: string; hubId: string; connectedAt: string };
  lastPushAt: string | null;
  lastPushSummary: null | { pushed: number; created: number; updated: number; unchanged: number; failed: number; errors: string[] };
};

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
      <rect x="4" y="6" width="24" height="22" rx="4" fill="var(--accent)" />
      <path d="M4 12h24" stroke="var(--oc-logo-ink)" strokeWidth="2" />
      <path d="M10 3.5v5M22 3.5v5" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="m11 20 3.4 3.2L21.5 16" stroke="var(--oc-logo-ink)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const HUBSPOT_STEPS = [
  "In the client's HubSpot: Development → Keys → Service keys → Create service key",
  "Name it QC Growth",
  "Scopes: crm.objects.contacts.read + write, crm.objects.companies.read + write, crm.schemas.contacts.read + write, crm.objects.owners.read, crm.lists.write (the QC Growth segment), and settings.users.write if there is no QC Growth user in HubSpot yet",
  "Copy the key (starts with pat-) and paste it here",
];

const ATTIO_STEPS = [
  "In the client's Attio: Workspace settings → Developers → New access token",
  "Name it QC Growth",
  "Read & write: Records, Object configuration, List configuration, List entries, Notes. Read: User management",
  "Copy the token and paste it here",
];

function when(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Build log stamp: "Oct 9, 2:54:07 PM". */
function logTime(value: string) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function CrmPanel({ slug, clientName, provider, onClose, returned }: { slug: string; clientName: string; provider: "hubspot" | "attio"; onClose: () => void; returned?: { ok: boolean; message: string } }) {
  const [crm, setCrm] = useState<Crm | null>(null);
  const [appReady, setAppReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [ownerId, setOwnerId] = useState("");
  // The plan's owner (the client's QC Growth user) is the default; QC's leads are never left unassigned.
  useEffect(() => { if (crm?.plan?.settings.ownerId) setOwnerId(crm.plan.settings.ownerId); }, [crm?.plan?.settings.ownerId]);
  const [lifecycle, setLifecycle] = useState(true);
  const [pushDeals, setPushDeals] = useState(true);
  const [dealPipeline, setDealPipeline] = useState("");
  useEffect(() => {
    if (crm?.plan?.deals) { setPushDeals(crm.plan.deals.enabled); setDealPipeline(crm.plan.deals.pipelineId ?? ""); }
  }, [crm?.plan?.deals?.enabled, crm?.plan?.deals?.pipelineId]);
  const [meetingsPushed, setMeetingsPushed] = useState<null | { created: number; updated: number; failed: number }>(null);
  const [leadSource, setLeadSource] = useState(true);
  const [tested, setTested] = useState<null | { name: string; company: string; campaign: string; created: boolean; link: string | null }>(null);
  const [progress, setProgress] = useState<{ pushed: number; created: number; updated: number; unchanged: number; failed: number } | null>(null);

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
    setNote(`Done: ${total.created} contacts created, ${total.updated} updated, ${total.unchanged} unchanged${total.failed ? `, ${total.failed} failed` : ""}.`);
  };

  const connectedHere = crm?.connected && crm.provider === provider;
  const otherProvider = crm?.connected && crm.provider !== provider;
  const name = provider === "hubspot" ? "HubSpot" : "Attio";
  const creates = crm?.plan?.items.filter((item) => item.action === "create") ?? [];
  const verified = crm?.buildLog.filter((entry) => entry.result === "verified").length ?? 0;

  return (
    <div className="oc-backdrop">
      <button className="oc-scrim" aria-label="Close" onClick={onClose} />
      <aside className="oc-panel" role="dialog" aria-label={`${name} for ${clientName}`}>
        <div className="oc-head">
          <span className={`oc-head-logo oc-${provider}`}>{provider === "hubspot" ? <HubSpotLogo /> : <AttioLogo />}</span>
          <div>
            <h2>{name}</h2>
            <span>{connectedHere ? (provider === "hubspot" ? `${crm?.accountName ?? ""} · portal ${crm?.accountId ?? ""}` : `${crm?.accountName ?? ""} workspace`) : clientName}</span>
          </div>
          <button className="oc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!loaded && <p className="oc-muted">Loading…</p>}
        {loaded && otherProvider && (
          <section className="oc-section"><p className="oc-muted">{clientName} is connected to {crm?.provider === "hubspot" ? "HubSpot" : "Attio"}. A client uses one CRM.</p></section>
        )}

        {loaded && !crm?.connected && (
          <section className="oc-section">
            <h3>Connect</h3>
            <ol className="oc-steps">{(provider === "hubspot" ? HUBSPOT_STEPS : ATTIO_STEPS).map((line) => <li key={line}>{line}</li>)}</ol>
            <div className="oc-row">
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === "hubspot" ? "pat-…" : "Attio access token"} />
              <button type="button" className="oc-primary" disabled={!apiKey.trim() || Boolean(busy)} onClick={() => void step("connect", { provider, apiKey: apiKey.trim() }).then((ok) => ok && setApiKey(""))}>{busy === "connect" ? `Reading ${name}…` : "Connect"}</button>
            </div>
          </section>
        )}

        {connectedHere && crm?.audit && (
          <section className="oc-section">
            <h3>Lay of the land</h3>
            <div className="oc-stats">
              <span><strong>{crm.audit.contacts.toLocaleString()}{crm.audit.countsCapped && crm.audit.contacts >= 2000 ? "+" : ""}</strong>{provider === "attio" ? "people" : "contacts"}</span>
              <span><strong>{crm.audit.companies.toLocaleString()}{crm.audit.countsCapped && crm.audit.companies >= 2000 ? "+" : ""}</strong>companies</span>
              <span><strong>{crm.audit.owners.length}</strong>owners</span>
            </div>
            {provider === "attio" && (crm.audit.lists?.length ?? 0) > 0 && <p className="oc-muted">Lists: {crm.audit.lists!.map((l) => l.name).join(", ")}</p>}
            {crm.audit.recentSources.length > 0 && <p className="oc-muted">Last 100 contacts came from: {crm.audit.recentSources.slice(0, 4).map((s) => `${s.source} (${s.count})`).join(", ")}</p>}
            {crm.audit.lookAlikes.length > 0 && (
              <p className="oc-muted">Existing look-alike fields: {crm.audit.lookAlikes.slice(0, 6).map((f) => `${f.label} (${f.why})`).join(", ")}</p>
            )}
          </section>
        )}

        {connectedHere && crm?.plan && (crm.status !== "built" || (provider === "hubspot" && crm.plan.deals && !crm.plan.deals.stageId && (crm.plan.deals.pipelines?.length ?? 0) > 0) || (provider === "attio" && crm.plan.deals?.available && !crm.plan.deals.statusExists)) && (
          <section className="oc-section">
            <h3>Game plan</h3>
            {crm.plan.warnings.map((w) => <p key={w} className="oc-warn">{w}</p>)}
            <ul className="oc-plan">
              {crm.plan.items.map((item) => (
                <li key={item.id} className={`oc-plan-${item.action}`}>
                  <span className="oc-tag">{item.action === "create" ? "Create" : item.action === "reuse" ? "Existing" : "Skip"}</span>
                  <div><strong>{item.label}</strong> <code>{item.name}</code><small>{item.detail}</small></div>
                </li>
              ))}
            </ul>
            <div className="oc-choices">
              {provider === "hubspot" && <label><input type="checkbox" checked={lifecycle} disabled={!crm.plan.settings.lifecycleOnCreate} onChange={(e) => setLifecycle(e.target.checked)} /> New contacts get lifecycle stage Lead</label>}
              {crm.plan.settings.leadSourceProperty && <label><input type="checkbox" checked={leadSource} onChange={(e) => setLeadSource(e.target.checked)} /> New contacts get lead source QC Growth</label>}
              <label>{provider === "attio" ? "Owner on the QC Growth list" : "Owner for new contacts"}
                <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  {!crm.plan.settings.ownerId && <option value="">{provider === "attio" ? "None (invite QC Growth to set it)" : "QC Growth (added by the build)"}</option>}
                  {(crm.audit?.owners ?? []).map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
                </select>
              </label>
            </div>
            {provider === "attio" && crm.plan.deals && (
              <div className="oc-choices">
                {crm.plan.deals.available
                  ? <label><input type="checkbox" checked={pushDeals} onChange={(e) => setPushDeals(e.target.checked)} /> Booked meetings become deals in a "Booked Meeting (QC)" stage</label>
                  : <span className="oc-muted">Deals are switched off in this Attio workspace, so booked meetings can't become deals.</span>}
              </div>
            )}
            {provider === "hubspot" && crm.plan.deals && (crm.plan.deals.pipelines?.length ?? 0) > 0 && (
              <div className="oc-choices">
                <label><input type="checkbox" checked={pushDeals} onChange={(e) => setPushDeals(e.target.checked)} /> Booked meetings become deals in a "Booked Meeting (QC)" stage</label>
                {pushDeals && (
                  <label>Pipeline
                    <select value={dealPipeline} onChange={(e) => setDealPipeline(e.target.value)}>
                      {(crm.plan.deals.pipelines ?? []).map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.label}{pipeline.hasStage ? " (stage already there)" : ""}</option>)}
                    </select>
                  </label>
                )}
              </div>
            )}
            <p className="oc-muted">{crm.plan.conversation}</p>
            <p className="oc-muted">Not touched: {crm.plan.notTouched.join(" · ")}</p>
            <div className="oc-row">
              <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void step("apply", { settings: { ownerId, lifecycleOnCreate: lifecycle, useLeadSource: leadSource, pushDeals, dealPipelineId: dealPipeline } })}>
                {busy === "apply" ? "Building…" : `Approve and build${creates.length ? ` (${creates.length} to create)` : ""}`}
              </button>
              <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("replan")}>{busy === "replan" ? "Reading…" : `Re-read ${name}`}</button>
            </div>
          </section>
        )}

        {connectedHere && crm?.status === "built" && (
          <section className="oc-section">
            <h3>Replies → {name}</h3>
            <div className="oc-stats">
              <span><strong>{verified}</strong>fields verified</span>
              <span><strong>{when(crm.lastPushAt)}</strong>last push</span>
            </div>
            <div className="oc-row">
              <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("push_one").then((payload) => payload?.test && setTested(payload.test))}>{busy === "push_one" ? "Pushing 1…" : "Push 1 lead (test)"}</button>
              <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void pushAll()}>{busy === "push" ? "Pushing…" : "Push all replies"}</button>
              <label className="oc-toggle"><input type="checkbox" checked={crm.autoPush} disabled={Boolean(busy)} onChange={(e) => void step("auto", { on: e.target.checked })} /> Push new replies automatically</label>
            </div>
            {tested && (
              <p className="oc-note">
                {tested.created ? "Created" : "Updated"} {tested.name}{tested.company ? ` (${tested.company})` : ""} · {tested.campaign}
                {tested.link && <> · <a href={tested.link} target="_blank" rel="noreferrer">Open in {name} ↗</a></>}
              </p>
            )}
            {progress && <p className="oc-muted">{progress.created} created · {progress.updated} updated · {progress.unchanged} unchanged{progress.failed ? ` · ${progress.failed} failed` : ""}</p>}
            {meetingsPushed && <p className="oc-muted">Booked meetings: {meetingsPushed.created} deals created · {meetingsPushed.updated} updated{meetingsPushed.failed ? ` · ${meetingsPushed.failed} failed` : ""}</p>}
            {provider === "hubspot" && crm.plan?.deals?.enabled && crm.plan.deals.stageId && <p className="oc-muted">Booked meetings go to {crm.plan.deals.pipelineLabel} → Booked Meeting (QC)</p>}
            {provider === "attio" && crm.plan?.deals?.enabled && crm.plan.deals.statusExists && <p className="oc-muted">Booked meetings go to Deals → Booked Meeting (QC)</p>}
            {crm.lastPushSummary?.errors?.length ? <ul className="oc-errors">{crm.lastPushSummary.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
          </section>
        )}

        {connectedHere && crm?.status === "built" && provider === "hubspot" && (
          <section className="oc-section">
            <h3>Dashboard</h3>
            {returned && <p className={returned.ok ? "oc-note" : "oc-error"}>{returned.message}</p>}
            {!crm.hubspotUser ? (
              <div className="oc-row">
                <a className={`oc-primary${appReady ? "" : " oc-disabled"}`} href={appReady ? `/api/hubspot/oauth/start?slug=${encodeURIComponent(slug)}` : undefined} aria-disabled={!appReady}>Connect QC Growth user</a>
                {!appReady && <span className="oc-muted">App keys not on Vercel yet</span>}
              </div>
            ) : (
              <>
                <p className="oc-muted">Signed in as {crm.hubspotUser.user || "QC Growth"}</p>
                <div className="oc-row">
                  <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void step("reporting").then((payload) => payload && setNote(payload.built ? "Reports and dashboard ready." : payload.pending ? (payload.failed ?? [])[0] : `Some steps failed: ${(payload.failed ?? []).join("; ")}`))}>{busy === "reporting" ? "Building…" : crm.config?.dashboard_id ? "Rebuild reports" : "Build reports and dashboard"}</button>
                  {crm.config?.dashboard_id && <a className="oc-ghost" href={`https://${(crm.accountName ?? "").includes("hubspot.com") ? crm.accountName : "app.hubspot.com"}/reports-dashboard/${crm.accountId}/view/${crm.config.dashboard_id}`} target="_blank" rel="noreferrer">Open dashboard ↗</a>}
                  <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("disconnect_user")}>Sign out</button>
                </div>
              </>
            )}
            {!crm.config?.dashboard_id && crm.accountId && (
              <div className="oc-row">
                <a className="oc-ghost" href={`https://${(crm.accountName ?? "").includes("hubspot.com") ? crm.accountName : "app.hubspot.com"}/product-updates/${crm.accountId}/in-beta?puQuery=api&rollout=327896`} target="_blank" rel="noreferrer">Join Reporting API beta ↗</a>
                <span className="oc-muted">"Manage reports and dashboards programmatically with the new Reporting API"</span>
              </div>
            )}
          </section>
        )}

        {connectedHere && (crm?.buildLog.length ?? 0) > 0 && (
          <details className="oc-section oc-log">
            <summary>Build log ({crm?.buildLog.length})</summary>
            <ol>{crm?.buildLog.map((entry, index) => <li key={`${entry.name}-${index}`}><span className="oc-log-n">{index + 1}</span><time className="oc-log-at" dateTime={entry.at}>{logTime(entry.at ?? "")}</time><span className={`oc-result oc-${entry.result}`}>{entry.result}</span><span>{entry.kind} <code>{entry.name}</code> {entry.detail}</span></li>)}</ol>
          </details>
        )}

        {note && <p className="oc-note">{note}</p>}
        {error && <p className="oc-error" role="alert">{error}</p>}

        {connectedHere && (
          <div className="oc-foot">
            <span className="oc-muted">Key {crm?.keyMasked}</span>
            <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("disconnect")}>Disconnect</button>
          </div>
        )}
      </aside>
    </div>
  );
}

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

function ContentSwitch({ value, disabled, onChange }: { value: "replies" | "meetings"; disabled: boolean; onChange: (value: "replies" | "meetings") => void }) {
  return (
    <div className="oc-row" role="radiogroup" aria-label="What goes in this sheet">
      {(["replies", "meetings"] as const).map((option) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} className={value === option ? "oc-primary" : "oc-ghost"} disabled={disabled} onClick={() => onChange(option)}>
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
    <section className="oc-section">
      <h3>{sheet.accountName ?? "Sheet"} · {sheet.config.tab ?? ""}</h3>
      <ContentSwitch value={sheet.content} disabled={Boolean(busy)} onChange={(value) => { if (value !== sheet.content) void step("content", { content: value }); }} />
      <ul className="oc-plan">
        {headers.map((header, index) => index === sheet.config.qcIdColumn ? null : (
          <li key={`${header}-${index}`} className="oc-sheet-col">
            <span>{header || `Column ${index + 1}`}</span>
            <select value={mapping[index] ?? ""} onChange={(e) => setMapping((current) => { const next = [...current]; next[index] = e.target.value; return next; })}>
              <option value="">Leave empty</option>
              {fields[sheet.content].map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <div className="oc-row">
        <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void step("map", { mapping })}>{doing("map") ? "Saving…" : built ? "Save mapping" : "Confirm mapping"}</button>
        <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("reread")}>{doing("reread") ? "Reading…" : "Re-read headers"}</button>
        {built && <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("format")}>{doing("format") ? "Formatting…" : "Format sheet"}</button>}
        {sheet.config.url && <a className="oc-ghost" href={sheet.config.url} target="_blank" rel="noreferrer">Open sheet ↗</a>}
      </div>
      {built && (
        <>
          <div className="oc-stats"><span><strong>{when(sheet.lastPushAt)}</strong>last push</span></div>
          <div className="oc-row">
            <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void pushAll()}>{doing("push") ? "Pushing…" : meetings ? "Push all booked meetings" : "Push all replies"}</button>
            <label className="oc-toggle"><input type="checkbox" checked={sheet.autoPush} disabled={Boolean(busy)} onChange={(e) => void step("auto", { on: e.target.checked })} /> Push new {meetings ? "bookings" : "replies"} automatically</label>
          </div>
          {progress && <p className="oc-muted">{progress.created} added · {progress.updated} updated{progress.failed ? ` · ${progress.failed} failed` : ""}</p>}
          {sheet.lastPushSummary?.errors?.length ? <ul className="oc-errors">{sheet.lastPushSummary.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
        </>
      )}
      <div className="oc-row"><button type="button" className="oc-ghost" disabled={Boolean(busy) && !mine} onClick={() => void step("disconnect")}>{doing("disconnect") ? "Removing…" : "Remove sheet"}</button></div>
    </section>
  );
}

function SheetsPanel({ slug, clientName, onClose, returned }: { slug: string; clientName: string; onClose: () => void; returned?: { ok: boolean; message: string } }) {
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [robot, setRobot] = useState<string | null>(null);
  const [google, setGoogle] = useState<{ email: string } | null>(null);
  const [googleOauth, setGoogleOauth] = useState(false);
  const [fields, setFields] = useState<FieldsByContent>({ replies: [], meetings: [] });
  const [loaded, setLoaded] = useState(false);
  const [url, setUrl] = useState("");
  const [content, setContent] = useState<"replies" | "meetings">("replies");
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
    void fetch(`/api/sheets-push/${encodeURIComponent(slug)}`, { cache: "no-store" }).then((r) => r.json()).then((payload) => { if (payload?.ok) take(payload); }).finally(() => setLoaded(true));
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

  const writer = google?.email ?? robot;

  return (
    <div className="oc-backdrop">
      <button className="oc-scrim" aria-label="Close" onClick={onClose} />
      <aside className="oc-panel" role="dialog" aria-label={`Google Sheets for ${clientName}`}>
        <div className="oc-head">
          <span className="oc-head-logo"><SheetsLogo /></span>
          <div><h2>Google Sheets</h2><span>{clientName} · {sheets.length} {sheets.length === 1 ? "sheet" : "sheets"}</span></div>
          <button className="oc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!loaded && <p className="oc-muted">Loading…</p>}
        {loaded && (
          <section className="oc-section">
            <h3>Google account</h3>
            {google ? (
              <div className="oc-row"><span className="oc-muted">Writing as {google.email}</span></div>
            ) : (
              <div className="oc-row">
                <a className={`oc-primary${googleOauth ? "" : " oc-disabled"}`} href={googleOauth ? `/api/google/oauth/start?return=${encodeURIComponent(`/onboarding/${slug}`)}` : undefined} aria-disabled={!googleOauth}>Connect Google</a>
                <span className="oc-muted">{googleOauth ? "Sign in once as admin@qcgrowth.com" : "Google sign-in keys not on Vercel yet"}</span>
              </div>
            )}
          </section>
        )}
        {returned && <p className={returned.ok ? "oc-note" : "oc-error"}>{returned.message}</p>}

        {sheets.map((sheet) => <SheetCard key={sheet.key} sheet={sheet} fields={fields} run={run} busy={busy} />)}

        {loaded && writer && (
          <section className="oc-section">
            <h3>{sheets.length ? "Add another sheet" : "Connect a sheet"}</h3>
            <ContentSwitch value={content} disabled={Boolean(busy)} onChange={setContent} />
            <ol className="oc-steps">
              <li>Make the sheet and put your headers in row 1</li>
              <li>{google ? <>Make sure <code>{writer}</code> can edit it (its own sheets already can)</> : <>Share it with <code>{writer}</code> as Editor</>}</li>
              <li>Paste the sheet's link here</li>
            </ol>
            <div className="oc-row">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
              <button type="button" className="oc-primary" disabled={!url.trim() || Boolean(busy)} onClick={() => void run("connect", { url: url.trim(), content }).then((ok) => ok && setUrl(""))}>{busy === "new:connect" ? "Reading sheet…" : "Connect"}</button>
            </div>
          </section>
        )}

        {error && <p className="oc-error" role="alert">{error}</p>}
      </aside>
    </div>
  );
}

export default function OpsCockpit({ slug, clientName }: { slug: string; clientName: string }) {
  const [open, setOpen] = useState<"" | "hubspot" | "attio" | "sheets">("");
  // Back from HubSpot's sign-in: reopen the HubSpot panel with the outcome, and tidy the address bar.
  const [returned, setReturned] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [sheetsReturned, setSheetsReturned] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleOk = params.get("google") === "connected";
    const googleFailure = params.get("google_error");
    if (googleOk || googleFailure) {
      setSheetsReturned(googleOk ? { ok: true, message: "Google connected." } : { ok: false, message: googleFailure ?? "" });
      setOpen("sheets");
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }
    const ok = params.get("hubspot") === "connected";
    const failure = params.get("hubspot_error");
    if (!ok && !failure) return;
    setReturned(ok ? { ok: true, message: "QC Growth user connected." } : { ok: false, message: failure ?? "" });
    setOpen("hubspot");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  return (
    <div className="oc-buttons" role="toolbar" aria-label="Client operations">
      <button type="button" className="oc-button" title="HubSpot" aria-label="HubSpot" onClick={() => setOpen("hubspot")}><HubSpotLogo /></button>
      <button type="button" className="oc-button oc-attio" title="Attio" aria-label="Attio" onClick={() => setOpen("attio")}><AttioLogo /></button>
      <button type="button" className="oc-button" title="Google Sheets" aria-label="Google Sheets" onClick={() => setOpen("sheets")}><SheetsLogo /></button>
      <Link href={`/bookings/${slug}`} className="oc-button" title="Booked meetings workflow" aria-label="Booked meetings workflow"><MeetingsLogo /></Link>
      {(open === "hubspot" || open === "attio") && <CrmPanel slug={slug} clientName={clientName} provider={open} returned={open === "hubspot" ? returned : undefined} onClose={() => setOpen("")} />}
      {open === "sheets" && <SheetsPanel slug={slug} clientName={clientName} returned={sheetsReturned} onClose={() => setOpen("")} />}
    </div>
  );
}
