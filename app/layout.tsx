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
