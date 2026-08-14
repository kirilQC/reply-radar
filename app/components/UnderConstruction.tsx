// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import AppSidebar from "./AppSidebar";
import GlobalAppearanceControl from "./GlobalAppearanceControl";
import Crumb from "./Crumb";

/**
 * A page that exists so its nav tab exists.
 *
 * Meetings was asked for ahead of being built, and the reason to ship the empty shell
 * now is that the tab is the commitment: it fixes the route, so nothing has to be renamed later, and
 * anyone clicking it gets an answer instead of a 404. It says what the page will do rather than just
 * "coming soon", because the person reading it is usually checking whether they missed a feature.
 */
export default function UnderConstruction({ title, purpose }: { title: string; purpose: string }) {
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: title }]} />
          <div className="top-actions">
            <GlobalAppearanceControl />
          </div>
        </header>
        <main className="construction-shell" aria-label={title}>
          <div className="construction-card">
            <span className="construction-badge">Under construction</span>
            <h1>{title}</h1>
            <p>{purpose}</p>
            <p className="construction-note">Nothing to do here yet — this tab is a placeholder for it.</p>
          </div>
        </main>
      </section>
    </div>
  );
}
