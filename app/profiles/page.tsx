"use client";
import AppSidebar from "../components/AppSidebar";
/* eslint-disable @next/next/no-html-link-for-pages */
const profiles = [
  {
    name: "Alex Spencer",
    desc: "Agency owner",
    clients: "Northstar AI · Pylon Labs",
    color: "#8b7cff",
    initials: "AS",
  },
  {
    name: "Jordan Lee",
    desc: "Sales teammate",
    clients: "Vectorly",
    color: "#55c7a2",
    initials: "JL",
  },
  {
    name: "Maya Patel",
    desc: "Growth teammate",
    clients: "Northstar AI · Vectorly",
    color: "#f2a36b",
    initials: "MP",
  },
];
export default function ProfilesPage() {
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb">
            <span>All clients</span>
            <strong>Profiles</strong>
          </div>
        </header>
        <main className="admin-shell">
          <section className="admin-content">
            <div className="admin-heading">
              <div>
                <div className="eyebrow">
                  <span className="live-dot" />
                  TEAM PROFILES
                </div>
                <h1>Profiles</h1>
                <p>
                  Each teammate gets a simple profile and an assigned client
                  view.
                </p>
              </div>
              <button className="primary-button">+ New profile</button>
            </div>
            <div className="profile-grid">
              {profiles.map((profile) => (
                <button className="profile-card" key={profile.name}>
                  <div
                    className="profile-icon"
                    style={{ background: profile.color }}
                  >
                    {profile.initials}
                  </div>
                  <div>
                    <h2>{profile.name}</h2>
                    <p>{profile.desc}</p>
                    <small>{profile.clients}</small>
                  </div>
                  <strong>
                    {profile.clients.split("·").length}
                    <span> clients</span>
                  </strong>
                  <div className="profile-open">Open profile →</div>
                </button>
              ))}
            </div>
          </section>
        </main>
      </section>
    </div>
  );
}
