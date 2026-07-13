import type { ReactNode } from "react";

export const metadata = { title: "Dionysus Cockpit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 860, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 20 }}>Dionysus Cockpit</h1>
        <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
          <a href="/setup">Setup</a>
          <a href="/">Home</a>
          <a href="/route">Route</a>
          <a href="/timeline">Timeline</a>
          <a href="/radar">Radar</a>
          <a href="/learned">Learned</a>
          <a href="/drafts">Drafts</a>
          <a href="/send">Send</a>
          <a href="/report">Report</a>
          <a href="/connect">Connect</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
