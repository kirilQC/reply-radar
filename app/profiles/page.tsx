"use client";

import { useRef, useState } from "react";
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
            <strong>› {profile ? profile.name || "New profile" : "Profiles"}</strong>
          </div>
        </header>
        {profile ? <ProfileEditor profile={profile} /> : <ProfileIndex />}
      </section>
    </div>
  );
}

function ProfileIndex() {
  return (
    <main className="profiles-page">
      <div className="profiles-heading">
        <div>
          <div className="eyebrow">
            <span className="live-dot" />
            TEAM PROFILES
          </div>
          <h1>Profiles</h1>
          <p>Choose a teammate to open their assigned client inbox.</p>
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
        {initialProfiles.map((profile) => (
          <a
            href={`/profiles?profile=${profile.slug}`}
            className="profile-card-modern"
            key={profile.slug}
          >
            <div
              className="profile-card-avatar"
              style={{ background: profile.color }}
            >
              {profile.initials}
            </div>
            <div className="profile-card-copy">
              <h2>{profile.name}</h2>
              <p>{profile.role}</p>
              <div className="assigned-client-list">
                {profile.clients.map((client) => (
                  <span key={client}>{client}</span>
                ))}
              </div>
            </div>
            <div className="profile-card-arrow">→</div>
          </a>
        ))}
      </div>
    </main>
  );
}

function ProfileEditor({
  profile,
}: {
  profile: (typeof initialProfiles)[number];
}) {
  const [name, setName] = useState(profile.name);
  const [photo, setPhoto] = useState<string | null>(null);
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
        <button className="primary-button">Save profile</button>
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
