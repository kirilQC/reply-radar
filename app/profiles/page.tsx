// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Skeleton from "../components/Skeleton";

const initialProfiles: Array<{ slug: string; name: string; role: string; clients: string[]; color: string; initials: string }> = [];
type Profile = (typeof initialProfiles)[number] & { photo?: string; title?: string; linkedinUrl?: string; clientSlugs?: string[] };

/** A client as the picker needs it: enough to draw the same card the dashboard draws. */
type ClientOption = { name: string; slug: string; logoUrl: string; tone: string };

const PROFILES_CACHE_KEY = "reply-radar-profiles:v2";
const WORKSPACES_CACHE_KEY = "reply-radar-workspaces:v2";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/*
 * Reads and writes of the offline caches, never allowed to throw.
 *
 * A teammate photo is a base64 data URL of up to 2MB, and an unguarded setItem of one blew the ~5MB
 * localStorage quota and threw out of the save. Data URLs are never cached: the server hands photos out
 * as short /api/img URLs, so the cache only ever needs those.
 */
const readCache = <T,>(key: string): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const writeCache = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode: the cache is a convenience, the server is the record */
  }
};
const cacheableProfiles = (list: Profile[]) =>
  list.map((item) => (typeof item.photo === "string" && item.photo.startsWith("data:") ? { ...item, photo: undefined } : item));

// Reads both shapes of the shared workspace cache: the raw rows this page stores and the camelCase list
// the admin console stores under the same key.
const toClientOptions = (rows: unknown): ClientOption[] =>
  (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const item = row as { name?: string; slug?: string; logo_url?: string; logoUrl?: string; accent_color?: string; tone?: string };
      return {
        name: String(item.name ?? ""),
        slug: String(item.slug ?? ""),
        logoUrl: String(item.logo_url ?? item.logoUrl ?? ""),
        tone: String(item.accent_color || item.tone || "#8b7cff"),
      };
    })
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

type LoadState = "loading" | "ready" | "error";

export default function ProfilesPage() {
  // Read from the URL after mount, not in the state initializer: the server render has no window, so an
  // initializer that reads it renders one thing on the server and another on the client.
  const [route, setRoute] = useState<{ ready: boolean; profile: string | null }>({ ready: false, profile: null });
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading the URL is the external sync this effect exists for
    setRoute({ ready: true, profile: new URLSearchParams(window.location.search).get("profile") });
  }, []);
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [profilesState, setProfilesState] = useState<LoadState>("loading");
  const [clientOptions, setClientOptions] = useState<ClientOption[]>([]);
  const [clientsState, setClientsState] = useState<LoadState>("loading");
  /*
   * The server is the record; the cache only fills the gap until it answers.
   *
   * The list used to read localStorage once, before the fetch came back, and never look again, so a
   * profile added or changed on another machine did not appear until a second visit. Everything below
   * the page now renders from this one copy.
   */
  useEffect(() => {
    let cancelled = false;
    const fromCache = () => {
      const cachedProfiles = readCache<Profile[]>(PROFILES_CACHE_KEY);
      if (Array.isArray(cachedProfiles)) setProfiles((current) => (current.length ? current : cachedProfiles));
      const cachedWorkspaces = readCache<unknown[]>(WORKSPACES_CACHE_KEY);
      if (Array.isArray(cachedWorkspaces)) setClientOptions((current) => (current.length ? current : toClientOptions(cachedWorkspaces)));
    };
    const loadProfiles = () => fetch("/api/admin/profiles", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (response.ok && Array.isArray(payload.profiles)) {
        writeCache(PROFILES_CACHE_KEY, cacheableProfiles(payload.profiles));
        setProfiles(payload.profiles);
        setProfilesState("ready");
      } else {
        setProfilesState("error");
      }
    }).catch(() => { if (!cancelled) setProfilesState("error"); });
    const loadWorkspaces = () => fetch("/api/admin/workspaces", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (cancelled) return;
      if (response.ok && Array.isArray(payload.workspaces)) {
        setClientOptions(toClientOptions(payload.workspaces));
        setClientsState("ready");
        writeCache(WORKSPACES_CACHE_KEY, payload.workspaces);
      } else {
        setClientsState("error");
      }
    }).catch(() => { if (!cancelled) setClientsState("error"); });
    fromCache();
    void loadProfiles();
    void loadWorkspaces();
    const onProfilesChanged = () => { void loadProfiles(); };
    const onWorkspacesChanged = () => { void loadWorkspaces(); };
    window.addEventListener("reply-radar-profiles-changed", onProfilesChanged);
    window.addEventListener("reply-radar-workspaces-changed", onWorkspacesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("reply-radar-profiles-changed", onProfilesChanged);
      window.removeEventListener("reply-radar-workspaces-changed", onWorkspacesChanged);
    };
  }, []);
  const profileSlug = route.profile;
  const profile =
    profileSlug === "new"
      ? {
          slug: "new",
          name: "",
          role: "",
          clients: [] as string[],
          clientSlugs: [] as string[],
          color: "#8b7cff",
          initials: "+",
        }
      : profiles.find((item) => item.slug === profileSlug);
  // An existing profile's editor waits for the server's copy of it. Started from the cache, it saved
  // whatever was cached last time, including client access somebody has since changed elsewhere.
  const editorReady = profileSlug === "new" || profilesState !== "loading";
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb
            trail={
              profileSlug && profile
                ? [{ label: "Profiles", href: "/profiles" }, { label: profile.name || "New profile" }]
                : [{ label: "Profiles" }]
            }
          />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        {!route.ready ? null : profileSlug ? (
          !editorReady ? (
            <main className="profile-editor-page"><Skeleton variant="list" count={4} label="Loading profile" /></main>
          ) : profile ? (
            <ProfileEditor key={profile.slug} profile={profile} liveClients={clientOptions} clientsLoaded={clientsState === "ready"} profileStale={profilesState === "error"} />
          ) : (
            <main className="profiles-page">
              <p className="form-error" role="alert">{profilesState === "error" ? "Profiles could not be loaded. Refresh to try again." : "That profile no longer exists."} <a href="/profiles">Back to profiles</a></p>
            </main>
          )
        ) : (
          <ProfileIndex profiles={profiles} loadFailed={profilesState === "error"} loading={profilesState === "loading" && !profiles.length} onProfilesChange={setProfiles} />
        )}
      </section>
    </div>
  );
}

function ProfileIndex({ profiles, loadFailed, loading, onProfilesChange }: { profiles: Profile[]; loadFailed: boolean; loading: boolean; onProfilesChange: (next: Profile[]) => void }) {
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const deleteProfile = () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    void fetch("/api/admin/profiles", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: deleteTarget.slug }) }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setDeleteError(typeof payload?.error === "string" && payload.error ? payload.error : "Could not delete this profile.");
        return;
      }
      const next = profiles.filter((item) => item.slug !== deleteTarget.slug);
      writeCache(PROFILES_CACHE_KEY, cacheableProfiles(next));
      onProfilesChange(next);
      window.dispatchEvent(new Event("reply-radar-profiles-changed"));
      setDeleteTarget(null);
    }).catch(() => setDeleteError("Could not reach the server.")).finally(() => setDeleting(false));
  };
  return (
    <main className="profiles-page">
      <div className="profiles-heading">
        <div>
          <h1>Profiles</h1>
        </div>
        <button
          className="primary-button"
          onClick={() => {
            window.location.href = "/profiles?profile=new";
          }}
        >
          + New profile
        </button>
      </div>
      {loadFailed && <p className="form-error" role="alert">Profiles could not be refreshed from the server{profiles.length ? "; showing the last saved copy" : ""}.</p>}
      {loading && <Skeleton variant="list" count={4} label="Loading profiles" />}
      <div className="profile-card-grid">
        {profiles.map((profile) => (
          <a
            href={`/profiles?profile=${encodeURIComponent(profile.slug)}`}
            className="profile-card-modern"
            key={profile.slug}
          >
            {profile.photo ? (
              <img src={profile.photo} alt="" className="profile-card-avatar" />
            ) : (
              <div
                className="profile-card-avatar"
                style={{ background: profile.color }}
              >
                {profile.initials}
              </div>
            )}
            <div className="profile-card-copy">
              <h2>{profile.name}</h2>
              <div className="assigned-client-list">
                {profile.clients.map((client, index) => (
                  <span key={profile.clientSlugs?.[index] ?? `${client}-${index}`}>{client}</span>
                ))}
              </div>
            </div>
            <div className="profile-card-actions"><button type="button" className="profile-delete-button" aria-label={`Delete ${profile.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setDeleteError(""); setDeleteTarget(profile); }}>Delete</button><div className="profile-card-arrow">→</div></div>
          </a>
        ))}
      </div>
      {deleteTarget && <div className="help-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-profile-title"><div className="help-card delete-confirm-card"><button className="help-close" onClick={() => setDeleteTarget(null)} aria-label="Cancel">×</button><h2 id="delete-profile-title">Delete profile?</h2><p>This will remove {deleteTarget.name || "this profile"} and their saved client assignments.</p>{deleteError && <p className="form-error" role="alert">{deleteError}</p>}<div className="delete-confirm-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="primary-button delete-danger-button" onClick={deleteProfile} disabled={deleting}>{deleting ? "Deleting…" : "Delete profile"}</button></div></div></div>}
    </main>
  );
}

function ProfileEditor({
  profile,
  liveClients,
  clientsLoaded,
  profileStale,
}: {
  profile: Profile;
  liveClients: ClientOption[];
  clientsLoaded: boolean;
  profileStale: boolean;
}) {
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(profile.linkedinUrl ?? "");
  const [photo, setPhoto] = useState<string | null>(profile.photo ?? null);
  /*
   * Assignments by slug, not by display name. Two clients can share a name, and a renamed client used to
   * drop out of every profile that had it. A profile from an older cache that only has names is mapped
   * onto slugs through the live list.
   */
  const [assigned, setAssigned] = useState<string[]>(() =>
    profile.clientSlugs?.length || !profile.clients.length
      ? [...(profile.clientSlugs ?? [])]
      : profile.clients.map((client) => liveClients.find((option) => option.name === client)?.slug || client),
  );
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  // Set once the server has created the row, so a retry after a partial failure updates it instead of
  // creating a second teammate.
  const createdId = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /*
   * Until the workspace list has loaded, what this profile is already assigned to is the only thing
   * known about it, shown as plain cards. Nothing is filtered against a list that is still loading:
   * that silently removed access to every client the moment a save landed before the list did.
   */
  const allClients: ClientOption[] = clientsLoaded
    ? liveClients
    : assigned.map((slug, index) => liveClients.find((option) => option.slug === slug) ?? { name: profile.clients[index] ?? slug, slug, logoUrl: "", tone: "#8b7cff" });
  const onPhoto = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) {
      setSaveError(`That photo is ${(file.size / (1024 * 1024)).toFixed(1)}MB. The limit is 2MB.`);
      return;
    }
    setSaveError("");
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result));
    reader.onerror = () => setSaveError("That photo could not be read.");
    reader.readAsDataURL(file);
  };
  const toggleClient = (slug: string) =>
    setAssigned((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
      : [...current, slug],
    );
  const saveProfile = () => {
    // One save at a time: a double click used to create the same teammate twice.
    if (saving) return;
    setSaving(true);
    setSaveError("");
    const normalizedName = name.trim() || "Unnamed teammate";
    const id = createdId.current ?? (profile.slug === "new" ? undefined : profile.slug);
    void fetch("/api/admin/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, name: normalizedName, title: title.trim(), linkedinUrl: linkedinUrl.trim(), photo, clientSlugs: assigned }) }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (payload?.profile?.id) createdId.current = String(payload.profile.id);
      if (!response.ok || payload?.ok === false) {
        setSaveError(typeof payload?.error === "string" && payload.error ? payload.error : "Could not save this profile.");
        setSaving(false);
        return;
      }
      // The list page refetches from the server, so nothing is written to the cache here, and in
      // particular not a freshly uploaded photo as base64.
      window.dispatchEvent(new Event("reply-radar-profiles-changed"));
      window.location.href = "/profiles";
    }).catch(() => {
      setSaveError("Could not reach the server. Nothing was saved.");
      setSaving(false);
    });
  };
  return (
    <main className="profile-editor-page">
      <div className="profile-editor-heading">
        <h1>{name || "New profile"}</h1>
      </div>
      <div className="profile-editor-toolbar">
        <a className="secondary-button" href="/profiles">← Back to profiles</a>
        <button className="primary-button" onClick={saveProfile} disabled={saving}>
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
      {profileStale && <p className="form-error" role="alert">This profile could not be refreshed from the server, so it shows the last saved copy. Saving will overwrite anything changed since.</p>}
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      <div className="profile-editor-grid">
        <section className="profile-editor-panel">
          <div className="profile-photo-row">
            {photo ? (
              <img
                src={photo}
                alt={`${name} profile`}
                className="profile-photo-large"
              />
            ) : (
              <div
                className="profile-photo-large"
                style={{ background: profile.color }}
              >
                {profile.initials}
              </div>
            )}
            <div>
              <h2>Profile photo</h2>
              <p>PNG or JPG · max 2MB</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                onChange={onPhoto}
                hidden
              />
              <button
                className="secondary-button"
                onClick={() => fileRef.current?.click()}
              >
                Upload photo
              </button>
            </div>
          </div>
          <label className="profile-field">
            FULL NAME
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="profile-field">
            TITLE
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Account Manager"
            />
          </label>
          <label className="profile-field">
            LINKEDIN URL
            <input
              value={linkedinUrl}
              onChange={(event) => setLinkedinUrl(event.target.value)}
              placeholder="https://www.linkedin.com/in/…"
              inputMode="url"
            />
          </label>
        </section>
        <section className="profile-editor-panel">
          <h2>Client directory</h2>
          <p className="panel-help">
            Pick the clients to attach to this profile. They are the ones that appear in this
            teammate’s Inbox view.
          </p>
          {/* The same cards as the dashboard's client directory, because that is how everyone here
              already recognises a client — by its logo, not by reading a list of names. */}
          <div className="client-picker-grid">
            {allClients.map((client) => {
              const isAssigned = assigned.includes(client.slug);
              return (
                <button
                  type="button"
                  key={client.slug || client.name}
                  className={`client-picker-card ${isAssigned ? "selected" : ""}`}
                  aria-pressed={isAssigned}
                  onClick={() => toggleClient(client.slug)}
                >
                  <i style={client.logoUrl ? undefined : { background: client.tone }}>
                    {client.logoUrl ? <img src={client.logoUrl} alt="" /> : client.name[0]}
                  </i>
                  <span className="client-picker-name">{client.name}</span>
                  <span className="client-picker-check" aria-hidden="true">✓</span>
                </button>
              );
            })}
            {!allClients.length && (
              <p className="panel-help">{clientsLoaded ? "No client workspaces exist yet." : "Loading clients…"}</p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
