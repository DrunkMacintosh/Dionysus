import { requireSession } from "../lib/auth";
import { getCmoReport } from "../lib/review";

export const dynamic = "force-dynamic";

// Progress-to-objective home (§3/D21/D31). Leads with the objective, then the
// HONEST verdict (headline + recommendation from the grader), then the primary-
// metric CTA (shown because analytics is not connected at 4f), then a compact
// this-week snapshot. All model/founder text is rendered as React-escaped JSX
// children — no dangerouslySetInnerHTML.
export default async function HomePage() {
  const session = await requireSession();
  const report = await getCmoReport({ businessId: session.businessId });

  if (!report.objective) {
    return (
      <main>
        <h2>No route yet</h2>
        <p>
          The department has not proposed an objective or a route. Once it does, this page tracks your
          progress toward it — what has gone live, what is in flight, and an honest read on whether it is working.
        </p>
      </main>
    );
  }

  const { objective, verdict, whatRan, inFlight, proposedPending, radarNoticed, analyticsConnected } = report;

  return (
    <main>
      <section>
        <h2>Objective: {objective.target} {objective.metric} ({objective.kind})</h2>
        <p>Status: {objective.status}</p>
        <p>{whatRan.length} posts went live this week toward this objective.</p>
      </section>

      <section style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <h3>{verdict.headline}</h3>
        <p>{verdict.recommendation}</p>
      </section>

      {!analyticsConnected && (
        <section style={{ border: "1px dashed #999", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <p>
            Your number&rsquo;s source is not connected yet, so this report grades activity, not outcomes —
            it will never claim your metric moved until a real source is connected.
          </p>
          <button type="button" disabled>Connect your number&rsquo;s source</button>
        </section>
      )}

      <section>
        <h3>This week</h3>
        <ul>
          <li>{whatRan.length} posts went live</li>
          <li>{inFlight} in flight</li>
          <li>{proposedPending} drafts awaiting review</li>
          <li>{radarNoticed.length} signals noticed on radar</li>
        </ul>
      </section>
    </main>
  );
}
