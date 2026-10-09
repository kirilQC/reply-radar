// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { use } from "react";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import ClientOperations from "../../components/ClientOperations";
import "../../reports/reports.css";
import "../operations.css";

const sans = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--ops-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--ops-mono" });

/** One client's Operations: HubSpot, Attio, Google Sheets and booked meetings, opened from its onboarding page. */
export default function ClientOperationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className={`main-area ops-area ${sans.variable} ${mono.variable}`}>
        <header className="topbar">
          <Crumb trail={[{ label: "Onboarding", href: "/onboarding" }, { label: "Client", href: `/onboarding/${slug}` }, { label: "Operations" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <ClientOperations slug={slug} />
      </section>
    </div>
  );
}
