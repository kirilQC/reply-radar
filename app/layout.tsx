// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import type { Metadata } from "next";
import "./globals.css";
import "./feature-overrides.css";
import "./dashboard.css";
import "./inbox-analytics.css";
import "./reply-radar-overrides.css";
import "./integrity-refinements.css";
import PreferenceBootstrap from "./components/PreferenceBootstrap";

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
      <body><PreferenceBootstrap />{children}</body>
    </html>
  );
}
