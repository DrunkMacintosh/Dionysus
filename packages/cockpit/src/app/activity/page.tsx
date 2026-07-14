import { requireSession } from "../../lib/auth";
import { listNightlyActivity } from "../../lib/review";

export const dynamic = "force-dynamic";

// Stage 6j — "While you slept": the founder's verbatim account of the nightly's
// work. Every recorded night lists its section results EXACTLY as runNightly
// returned them — including what was SKIPPED and what FAILED, and why. Nothing is
// summarized or softened between runNightly and this screen (§16 accountability;
// D31 liveness): a failed section shows FAILED with its real reason as plain text
// (no color library — the honest word is enough). Newest night first. Identity
// comes from the session only (D27.1) — another tenant's diary is unreachable here.
// All run/section text is React-escaped JSX children (no dangerouslySetInnerHTML).
export default async function ActivityPage() {
  const session = await requireSession();
  const runs = await listNightlyActivity({ businessId: session.businessId });
  return (
    <main>
      <h2>While you slept</h2>
      <p style={{ color: "#666" }}>
        {"Every night's work, verbatim — including what was skipped and what failed, and why."}
      </p>
      {runs.length === 0 ? (
        <p>No nights recorded yet — the first nightly run writes its diary here.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0 }}>
          {runs.map((run) => (
            <li key={run.runId} style={{ borderLeft: "2px solid #ddd", paddingLeft: 16, marginBottom: 24 }}>
              <div style={{ fontSize: 12, color: "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {run.ranAt.toLocaleString()}
              </div>
              <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
                {run.sections.map((s) => (
                  <li key={`${run.runId}-${s.section}`} style={{ marginBottom: 4 }}>
                    {s.section} — {s.status === "failed" ? "FAILED" : s.status}: {s.text}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
