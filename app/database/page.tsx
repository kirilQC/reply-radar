"use client";

import AppSidebar from "../components/AppSidebar";

export default function DatabasePage() {
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <div className="crumb"><span>Reply Radar</span><strong>Database</strong></div>
        </header>
        <main className="content-wrap database-placeholder" aria-label="Database">
          <div className="eyebrow"><span className="live-dot" /> DATABASE</div>
          <h1>Database</h1>
        </main>
      </section>
    </div>
  );
}
