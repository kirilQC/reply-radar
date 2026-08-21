// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./feature-overrides.css";
import "./dashboard.css";
import "./inbox-analytics.css";
import "./reply-radar-overrides.css";
import "./integrity-refinements.css";
import "./onboarding.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import PreferenceBootstrap from "./components/PreferenceBootstrap";

/**
 * Without this, iOS Safari assumes a 980px-wide desktop page and scales the whole thing down to
 * fit the phone — which also means every `max-width` breakpoint in the stylesheets measures 980
 * and never fires. The app had a full off-canvas sidebar and a dozen narrow-screen layouts
 * written for it that were unreachable purely for want of this tag.
 *
 * `maximumScale` and `userScalable` are deliberately left alone. Locking zoom is the usual way to
 * stop iOS magnifying the page when a text field is focused, but it takes pinch-zoom away from
 * everyone to do it. The focus jump is caused by fields under 16px, and that is fixed in CSS
 * where the cause actually is.
 *
 * Desktop is unaffected: browsers there already lay out at the real window width.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Reply Radar — Follow-up intelligence",
  description: "The operating system for every conversation after the first reply.",
  /**
   * The one part of the authorship stamp that survives a build.
   *
   * Every source file carries the same line in its first two, but source comments are stripped by
   * compilation — so a deployed copy would carry no trace of who wrote it. This puts the name in the
   * served HTML of every page, where view-source finds it on whatever host it is running on.
   */
  authors: [{ name: "Kiril Ivlev", url: "https://www.linkedin.com/in/kiril-ivlev/" }],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Dark is the product's own look rather than a follow of the OS setting, so it is stamped
    // on the document before any preference loads. Light only arrives from an explicit choice.
    <html lang="en" data-appearance-mode="midnight">
      {/*
        Real-user Core Web Vitals, from the browsers of the people actually using this.
        Imported from `/next` rather than the bare package so the dynamic route is reported as
        `/qc-brain/[client]` instead of one entry per client — otherwise every client's slug becomes
        its own page in the dashboard and nothing has enough samples to mean anything.

        No `beforeSend` redaction, deliberately: the URLs it reports carry client slugs
        (`/analytics?client=acme`), and Vercel already has every one of them in its request logs by
        virtue of serving the page. Adding a filter would mean wrapping this in a client component to
        pass a function, which is real complexity for no change in who can see what.
      */}
      {/*
        Page views, which here are a usage signal rather than a marketing one: with no login, this is
        the only way to know whether the team actually opened the inbox this week or went back to
        HeyReach. The `?client=` query on those URLs is the useful part — it says which clients get
        worked and which get forgotten — and it goes to a dashboard only we can see.
      */}
      <body><PreferenceBootstrap />{children}<SpeedInsights /><Analytics /></body>
    </html>
  );
}
