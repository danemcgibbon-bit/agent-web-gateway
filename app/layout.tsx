import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Web Gateway",
  description: "Agent Web Gateway helps AI agents interact with compatible public websites through structured read-only tools.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><head><link rel="alternate" type="application/json" href="/agent.json" title="Agent Web Gateway instructions" /></head><body>{children}</body></html>;
}
