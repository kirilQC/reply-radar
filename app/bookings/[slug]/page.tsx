// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import BookingAlerts from "../../slack/BookingAlerts";
import "../../reports/reports.css";

/** One client's booked-meeting workflow, opened from its onboarding page. */
export default function ClientBookingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area reports-main">
        <header className="topbar">
          <Crumb trail={[{ label: "Onboarding", href: "/onboarding" }, { label: "Client", href: `/onboarding/${slug}` }, { label: "Booked meetings" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <BookingAlerts focus={slug} backLabel="← Onboarding" onBack={() => router.push(`/onboarding/${slug}`)} />
      </section>
    </div>
  );
}
