"use client";

import AppSidebar from "./AppSidebar";

const clients = [
  {
    name: "Northstar AI",
    slug: "northstar",
    tone: "#8b7cff",
    leads: 486,
    replies: 6,
    status: "Connected",
  },
  {
    name: "Pylon Labs",
    slug: "pylon",
    tone: "#55c7a2",
    leads: 312,
    replies: 3,
    status: "Connected",
  },
  {
    name: "Vectorly",
    slug: "vectorly",
    tone: "#f2a36b",
    leads: 198,
    replies: 2,
    status: "Needs attention",
  },
];
const profiles = [
  ["Alex Spencer", "Northstar AI · Pylon Labs", "2 clients", "#8b7cff", "AS"],
  ["Jordan Lee", "Vectorly", "1 client", "#55c7a2", "JL"],
  ["Maya Patel", "Northstar AI · Vectorly", "2 clients", "#f2a36b", "MP"],
];

export default function DashboardHome() {
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb" />
          <div className="top-actions">
            <button className="icon-button theme-toggle">◐</button>
          </div>
        </header>
        <main className="dashboard-home">
          <section>
            <div className="section-heading">
              <div>
                <h2>Client workspaces</h2>
              </div>
              <a href="/admin" className="text-button">
                Manage clients →
              </a>
            </div>
            <div className="dashboard-client-grid">
              {clients.map((client) => (
                <a
                  href={`/inbox?client=${client.slug}`}
                  className="dashboard-client-card"
                  key={client.slug}
                >
                  <div className="dashboard-card-top">
                    <i style={{ background: client.tone }}>{client.name[0]}</i>
                    <span
                      className={
                        client.status === "Connected"
                          ? "status-ok"
                          : "status-warn"
                      }
                    >
                      {client.status}
                    </span>
                  </div>
                  <h3>{client.name}</h3>
                  <p>
                    {client.leads} active leads · {client.replies} need action
                  </p>
                  <div className="dashboard-progress">
                    <span
                      style={{
                        width: `${Math.min(92, 48 + client.replies * 8)}%`,
                        background: client.tone,
                      }}
                    />
                  </div>
                  <strong>Open workspace →</strong>
                </a>
              ))}
            </div>
          </section>
          <section>
            <div className="section-heading">
              <div>
                <h2>Teammate profiles</h2>
              </div>
              <a href="/profiles" className="text-button">
                Manage profiles →
              </a>
            </div>
            <div className="dashboard-profile-grid">
              {profiles.map(([name, description, count, tone, initials]) => (
                <a
                  href={`/inbox?profile=${name.toLowerCase().replaceAll(" ", "-")}`}
                  className="dashboard-profile-card"
                  key={name}
                >
                  <i style={{ background: tone }}>{initials}</i>
                  <div>
                    <h3>{name}</h3>
                    <p>{description}</p>
                    <small>{count}</small>
                  </div>
                  <span>→</span>
                </a>
              ))}
            </div>
          </section>
        </main>
      </section>
    </div>
  );
}
