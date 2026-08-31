// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AppSidebar from "../../components/AppSidebar";
import Crumb from "../../components/Crumb";
import GlobalAppearanceControl from "../../components/GlobalAppearanceControl";
import "../project-management.css";

type Client = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null };

export default function ClientProjects() {
  const params = useParams<{ slug: string }>();
  const slug = String(params?.slug ?? "");
  const [client, setClient] = useState<Client | null>(null);

  useEffect(() => {
    void (async () => {
      const payload = await fetch("/api/project-management/clients", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      const found = (payload.clients as Client[] | undefined)?.find((c) => c.slug === slug) ?? null;
      setClient(found);
    })();
  }, [slug]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Project management", href: "/project-management" }, { label: client?.name || "Client" }]} />
          <div className="top-actions"><GlobalAppearanceControl /></div>
        </header>
        <main className="pm-shell">
          <Link href="/project-management" className="pm-back">← All clients</Link>
          <div className="pm-client-head">
            <span className="pm-client-logo" style={client?.logoUrl ? undefined : { background: client?.accentColor || "var(--accent)" }}>
              {client?.logoUrl ? <img src={client.logoUrl} alt="" /> : (client?.name?.[0] || "?").toUpperCase()}
            </span>
            <h1>{client?.name || "Client"}</h1>
          </div>
          <div className="pm-placeholder">
            <h2>Board coming next</h2>
            <p>This is where {client?.name || "this client"}&apos;s projects for the week will live — add tasks, drag them through stages, and see auto-detected work from morning briefs and call analysis. Pick a board design and I&apos;ll build it here.</p>
          </div>
        </main>
      </section>
    </div>
  );
}
