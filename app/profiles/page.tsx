"use client";

import { useEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

const initialProfiles: Array<{ slug: string; name: string; role: string; clients: string[]; color: string; initials: string }> = [];
type Profile = (typeof initialProfiles)[number] & { photo?: string };

export default function ProfilesPage() {
  const [profileSlug] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("profile")
      : null,
  );
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [workspaceNames, setWorkspaceNames] = useState<string[]>([]);
  useEffect(() => {
    const hydrate = () => {
      try {
        const savedProfiles = window.localStorage.getItem("reply-radar-profiles:v2");
        if (savedProfiles) setProfiles(JSON.parse(savedProfiles));
        const savedWorkspaces = window.localStorage.getItem("reply-radar-workspaces:v2");
        if (savedWorkspaces) setWorkspaceNames((JSON.parse(savedWorkspaces) as Array<{ name?: string }>).map((item) => item.name ?? "").filter(Boolean));
      } catch {
        // Keep the empty state when storage is unavailable or malformed.
      }
    };
    hydrate();
    void fetch("/api/admin/profiles", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(payload.profiles)) {
        window.localStorage.setItem("reply-radar-profiles:v2", JSON.stringify(payload.profiles));
        setProfiles(payload.profiles);
      }
    }).catch(() => undefined);
    void fetch("/api/admin/workspaces", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(payload.workspaces)) {
        const names = payload.workspaces.map((item: { name?: string }) => item.name ?? "").filter(Boolean);
        setWorkspaceNames(names);
        window.localStorage.setItem("reply-radar-workspaces:v2", JSON.stringify(payload.workspaces));
      }
    }).catch(() => undefined);
    window.addEventListener("storage", hydrate);
    window.addEventListener("reply-radar-profiles-changed", hydrate);
    window.addEventListener("reply-radar-workspaces-changed", hydrate);
    return () => {
      window.removeEventListener("storage", hydrate);
      window.removeEventListener("reply-radar-profiles-changed", hydrate);
      window.removeEventListener("reply-radar-workspaces-changed", hydrate);
    };
  }, []);
  const profile =
    profileSlug === "new"
      ? {
          slug: "new",
          name: "",
          role: "",
          clients: [] as string[],
          color: "#8b7cff",
          initials: "+",
        }
      : profiles.find((item) => item.slug === profileSlug);
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb">
            <span>Reply Radar</span>
            <span className="crumb-chevron" aria-hidden="true">›</span>
            <strong>{profile ? profile.name || "New profile" : "Profiles"}</strong>
          </div>
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        {profile ? <ProfileEditor profile={profile} liveClients={workspaceNames} /> : <ProfileIndex />}
      </section>
    </div>
  );
}

function ProfileIndex() {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  useEffect(() => {
    const hydrate = () => {
      try {
        const saved = window.localStorage.getItem("reply-radar-profiles:v2");
        if (saved) setProfiles(JSON.parse(saved));
      } catch {
        // Keep the empty state if browser storage is unavailable.
      }
    };
    const timer = window.setTimeout(hydrate, 0);
    window.addEventListener("storage", hydrate);
    window.addEventListener("reply-radar-profiles-changed", hydrate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", hydrate);
      window.removeEventListener("reply-radar-profiles-changed", hydrate);
    };
  }, []);
  const deleteProfile = () => {
    if (!deleteTarget) return;
    const next = profiles.filter((item) => item.slug !== deleteTarget.slug);
    void fetch("/api/admin/profiles", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: deleteTarget.slug }) }).then(async (response) => {
      if (!response.ok) return;
      window.localStorage.setItem("reply-radar-profiles:v2", JSON.stringify(next));
      setProfiles(next);
      window.dispatchEvent(new Event("reply-radar-profiles-changed"));
      setDeleteTarget(null);
    });
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
      <div className="profile-card-grid">
        {profiles.map((profile) => (
          <a
            href={`/profiles?profile=${profile.slug}`}
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
              <p>{profile.role}</p>
              <div className="assigned-client-list">
                {profile.clients.map((client) => (
                  <span key={client}>{client}</span>
                ))}
              </div>
            </div>
            <div className="profile-card-actions"><button type="button" className="profile-delete-button" aria-label={`Delete ${profile.name}`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); setDeleteTarget(profile); }}>Delete</button><div className="profile-card-arrow">→</div></div>
          </a>
        ))}
      </div>
      {deleteTarget && <div className="help-overlay" role="dialog" aria-modal="true" aria-labelledby="delete-profile-title"><div className="help-card delete-confirm-card"><button className="help-close" onClick={() => setDeleteTarget(null)} aria-label="Cancel">×</button><h2 id="delete-profile-title">Delete profile?</h2><p>This will remove {deleteTarget.name || "this profile"} and their saved client assignments.</p><div className="delete-confirm-actions"><button className="secondary-button" onClick={() => setDeleteTarget(null)}>Cancel</button><button className="primary-button delete-danger-button" onClick={deleteProfile}>Delete profile</button></div></div></div>}
    </main>
  );
}

function ProfileEditor({
  profile,
  liveClients,
}: {
  profile: Profile;
  liveClients: string[];
}) {
  const [name, setName] = useState(profile.name);
  const [photo, setPhoto] = useState<string | null>(profile.photo ?? null);
  const [assigned, setAssigned] = useState(profile.clients);
  const [saveError, setSaveError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const allClients = liveClients.length ? liveClients : profile.clients;
  useEffect(() => {
    // Keep removed workspaces out of an open profile editor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssigned((current) => current.filter((client) => allClients.includes(client)));
    // The joined list is the stable identity of the workspace options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveClients.join("|")]);
  const onPhoto = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result));
    reader.readAsDataURL(file);
  };
  const toggleClient = (client: string) =>
    setAssigned((current) =>
      current.includes(client)
        ? current.filter((item) => item !== client)
      : [...current, client],
    );
  const saveProfile = () => {
    setSaveError("");
    const normalizedName = name.trim() || "Unnamed teammate";
    const initials = normalizedName
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
    const savedProfile = {
      ...profile,
      name: normalizedName,
      role: profile.role || "Teammate",
      clients: assigned,
      initials: initials || "?",
      ...(photo ? { photo } : {}),
    };
    const existing = (() => {
      try {
        return JSON.parse(
          window.localStorage.getItem("reply-radar-profiles:v2") || JSON.stringify(initialProfiles),
        ) as Profile[];
      } catch {
        return [];
      }
    })();
    void fetch("/api/admin/profiles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: profile.slug === "new" ? undefined : profile.slug, name: normalizedName, photo, clients: assigned }) }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setSaveError(String(payload.error ?? "Could not save this profile.")); return; }
      const savedId = String(payload.profile?.id ?? savedProfile.slug);
      const persisted = { ...savedProfile, slug: savedId };
      const persistedProfiles = [...existing.filter((item) => item.slug !== profile.slug && item.slug !== savedId), persisted];
      window.localStorage.setItem("reply-radar-profiles:v2", JSON.stringify(persistedProfiles));
      window.dispatchEvent(new Event("reply-radar-profiles-changed"));
      window.location.href = "/profiles";
    });
  };
  return (
    <main className="profile-editor-page">
      <div className="profile-editor-heading">
        <h1>{name || "New profile"}</h1>
      </div>
      <div className="profile-editor-toolbar">
        <a className="secondary-button" href="/profiles">← Back to profiles</a>
        <button className="primary-button" onClick={saveProfile}>
          Save profile
        </button>
      </div>
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
        </section>
        <section className="profile-editor-panel">
          <h2>Assigned clients</h2>
          <p className="panel-help">
            These clients appear in this teammate’s Inbox view.
          </p>
          <div className="assigned-client-options">
            {allClients.map((client) => (
              <label
                key={client}
                className={`assigned-client-option ${assigned.includes(client) ? "checked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={assigned.includes(client)}
                  onChange={() => toggleClient(client)}
                />
                <span>{client}</span>
                <small>
                  {assigned.includes(client) ? "Assigned" : "Not assigned"}
                </small>
              </label>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
