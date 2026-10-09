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
  };
  plan: null | { items: PlanItem[]; settings: { leadSourceProperty: string | null; lifecycleOnCreate: string | null; ownerId: string | null }; conversation: string; notTouched: string[]; warnings: string[] };
  buildLog: Array<{ kind: string; name: string; result: string; detail: string }>;
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
function AttioLogo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="2" y="2" width="28" height="28" rx="8" fill="currentColor" />
      <path d="M11 22.5 16 9.5l5 13" stroke="var(--oc-logo-ink)" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.8 18h6.4" stroke="var(--oc-logo-ink)" strokeWidth="2.6" strokeLinecap="round" />
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

function when(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
            <span>{connectedHere ? `${crm?.accountName ?? ""} · portal ${crm?.accountId ?? ""}` : clientName}</span>
          </div>
          <button className="oc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {!loaded && <p className="oc-muted">Loading…</p>}
        {loaded && provider === "attio" && !connectedHere && (
          <section className="oc-section"><h3>Attio</h3><p className="oc-muted">Coming next, on the same connect → plan → build flow as HubSpot.</p></section>
        )}
        {loaded && otherProvider && (
          <section className="oc-section"><p className="oc-muted">{clientName} is connected to {crm?.provider === "hubspot" ? "HubSpot" : "Attio"}. A client uses one CRM.</p></section>
        )}

        {loaded && provider === "hubspot" && !crm?.connected && (
          <section className="oc-section">
            <h3>Connect</h3>
            <ol className="oc-steps">{HUBSPOT_STEPS.map((line) => <li key={line}>{line}</li>)}</ol>
            <div className="oc-row">
              <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="pat-…" />
              <button type="button" className="oc-primary" disabled={!apiKey.trim() || Boolean(busy)} onClick={() => void step("connect", { provider: "hubspot", apiKey: apiKey.trim() }).then((ok) => ok && setApiKey(""))}>{busy === "connect" ? "Reading HubSpot…" : "Connect"}</button>
            </div>
          </section>
        )}

        {connectedHere && crm?.audit && (
          <section className="oc-section">
            <h3>Lay of the land</h3>
            <div className="oc-stats">
              <span><strong>{crm.audit.contacts.toLocaleString()}</strong>contacts</span>
              <span><strong>{crm.audit.companies.toLocaleString()}</strong>companies</span>
              <span><strong>{crm.audit.owners.length}</strong>owners</span>
            </div>
            {crm.audit.recentSources.length > 0 && <p className="oc-muted">Last 100 contacts came from: {crm.audit.recentSources.slice(0, 4).map((s) => `${s.source} (${s.count})`).join(", ")}</p>}
            {crm.audit.lookAlikes.length > 0 && (
              <p className="oc-muted">Existing look-alike fields: {crm.audit.lookAlikes.slice(0, 6).map((f) => `${f.label} (${f.why})`).join(", ")}</p>
            )}
          </section>
        )}

        {connectedHere && crm?.plan && crm.status !== "built" && (
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
              <label><input type="checkbox" checked={lifecycle} disabled={!crm.plan.settings.lifecycleOnCreate} onChange={(e) => setLifecycle(e.target.checked)} /> New contacts get lifecycle stage Lead</label>
              {crm.plan.settings.leadSourceProperty && <label><input type="checkbox" checked={leadSource} onChange={(e) => setLeadSource(e.target.checked)} /> New contacts get lead source QC Growth</label>}
              <label>Owner for new contacts
                <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  {!crm.plan.settings.ownerId && <option value="">QC Growth (added by the build)</option>}
                  {(crm.audit?.owners ?? []).map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
                </select>
              </label>
            </div>
            <p className="oc-muted">{crm.plan.conversation}</p>
            <p className="oc-muted">Not touched: {crm.plan.notTouched.join(" · ")}</p>
            <div className="oc-row">
              <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void step("apply", { settings: { ownerId, lifecycleOnCreate: lifecycle, useLeadSource: leadSource } })}>
                {busy === "apply" ? "Building…" : `Approve and build${creates.length ? ` (${creates.length} to create)` : ""}`}
              </button>
              <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("replan")}>{busy === "replan" ? "Reading…" : "Re-read HubSpot"}</button>
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
                {tested.link && <> · <a href={tested.link} target="_blank" rel="noreferrer">Open in HubSpot ↗</a></>}
              </p>
            )}
            {progress && <p className="oc-muted">{progress.created} created · {progress.updated} updated · {progress.unchanged} unchanged{progress.failed ? ` · ${progress.failed} failed` : ""}</p>}
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
                  <button type="button" className="oc-primary" disabled={Boolean(busy)} onClick={() => void step("reporting").then((payload) => payload && setNote(payload.built ? "Reports and dashboard ready." : `Some steps failed: ${(payload.failed ?? []).join("; ")}`))}>{busy === "reporting" ? "Building…" : crm.config?.dashboard_id ? "Rebuild reports" : "Build reports and dashboard"}</button>
                  {crm.config?.dashboard_id && <a className="oc-ghost" href={`https://${(crm.accountName ?? "").includes("hubspot.com") ? crm.accountName : "app.hubspot.com"}/reports-dashboard/${crm.accountId}/view/${crm.config.dashboard_id}`} target="_blank" rel="noreferrer">Open dashboard ↗</a>}
                  <button type="button" className="oc-ghost" disabled={Boolean(busy)} onClick={() => void step("disconnect_user")}>Sign out</button>
                </div>
              </>
            )}
          </section>
        )}

        {connectedHere && (crm?.buildLog.length ?? 0) > 0 && (
          <details className="oc-section oc-log">
            <summary>Build log ({crm?.buildLog.length})</summary>
            <ul>{crm?.buildLog.map((entry, index) => <li key={`${entry.name}-${index}`}><span className={`oc-result oc-${entry.result}`}>{entry.result}</span> {entry.kind} <code>{entry.name}</code> {entry.detail}</li>)}</ul>
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

function SheetsPanel({ clientName, onClose }: { clientName: string; onClose: () => void }) {
  return (
    <div className="oc-backdrop">
      <button className="oc-scrim" aria-label="Close" onClick={onClose} />
      <aside className="oc-panel" role="dialog" aria-label={`Google Sheets for ${clientName}`}>
        <div className="oc-head">
          <span className="oc-head-logo"><SheetsLogo /></span>
          <div><h2>Google Sheets</h2><span>{clientName}</span></div>
          <button className="oc-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <section className="oc-section"><p className="oc-muted">Coming after HubSpot and Attio: replies into a shared sheet, one row per lead.</p></section>
      </aside>
    </div>
  );
}

export default function OpsCockpit({ slug, clientName }: { slug: string; clientName: string }) {
  const [open, setOpen] = useState<"" | "hubspot" | "attio" | "sheets">("");
  // Back from HubSpot's sign-in: reopen the HubSpot panel with the outcome, and tidy the address bar.
  const [returned, setReturned] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
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
      {open === "sheets" && <SheetsPanel clientName={clientName} onClose={() => setOpen("")} />}
    </div>
  );
}
