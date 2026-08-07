"use client";

import { useEffect, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";

const initialProfiles = [
  {
    slug: "alex-spencer",
    name: "Alex Spencer",
    role: "Agency owner",
    clients: ["Northstar AI", "Pylon Labs"],
    color: "#8b7cff",
    initials: "AS",
  },
  {
    slug: "jordan-lee",
    name: "Jordan Lee",
    role: "Sales teammate",
    clients: ["Vectorly"],
    color: "#55c7a2",
    initials: "JL",
  },
  {
    slug: "maya-patel",
    name: "Maya Patel",
    role: "Growth teammate",
    clients: ["Northstar AI", "Vectorly"],
    color: "#f2a36b",
    initials: "MP",
  },
];
type Profile = (typeof initialProfiles)[number] & { photo?: string };

export default function ProfilesPage() {
  const [profileSlug] = useState(() =>
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("profile")
      : null,
  );
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
      : initialProfiles.find((item) => item.slug === profileSlug);
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
        </header>
        {profile ? <ProfileEditor profile={profile} /> : <ProfileIndex />}
      </section>
    </div>
  );
}

function ProfileIndex() {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem("reply-radar-profiles");
        if (saved) setProfiles(JSON.parse(saved));
      } catch {
        // Keep the seeded profiles if browser storage is unavailable.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const deleteProfile = () => {
    if (!deleteTarget) return;
    const next = profiles.filter((item) => item.slug !== deleteTarget.slug);
    window.localStorage.setItem("reply-radar-profiles", JSON.stringify(next));
    setProfiles(next);
    window.dispatchEvent(new Event("reply-radar-profiles-changed"));
    setDeleteTarget(null);
  };
  return (
    <main className="profiles-page">
      <div className="profiles-heading">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            TEAM PROFILES
          </div>
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
}: {
  profile: Profile;
}) {
  const [name, setName] = useState(profile.name);
  const [photo, setPhoto] = useState<string | null>(profile.photo ?? null);
  const [assigned, setAssigned] = useState(profile.clients);
  const fileRef = useRef<HTMLInputElement>(null);
  const allClients = ["Northstar AI", "Pylon Labs", "Vectorly"];
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
          window.localStorage.getItem("reply-radar-profiles") || JSON.stringify(initialProfiles),
        ) as Profile[];
      } catch {
        return [];
      }
    })();
    const next = [
      ...existing.filter((item) => item.slug !== savedProfile.slug),
      savedProfile,
    ];
    window.localStorage.setItem("reply-radar-profiles", JSON.stringify(next));
    window.location.href = "/profiles";
  };
  return (
    <main className="profile-editor-page">
      <a className="back-link" href="/profiles">
        ← All profiles
      </a>
      <div className="profile-editor-heading">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            PROFILE SETTINGS
          </div>
          <h1>{name}</h1>
          <p>Configure this teammate’s identity and assigned client view.</p>
        </div>
        <button className="primary-button" onClick={saveProfile}>
          Save profile
        </button>
      </div>
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
