"use client";

import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";

export default function ReportsPage() {
  return <div className="app-shell"><AppSidebar /><section className="main-area"><header className="topbar"><div className="crumb"><span>Reply Radar</span><strong>› Reports</strong></div><div className="top-actions"><GlobalAppearanceControl /></div></header><main className="reports-shell"><h1>Reports</h1></main></section></div>;
}
