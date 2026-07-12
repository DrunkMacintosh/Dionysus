import { requireSession } from "../../lib/auth";
import { getRouteOverview, getRoutePendingRevision } from "../../lib/review";
import { RevisionCard } from "./revision-card";

export const dynamic = "force-dynamic";

export default async function RoutePage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const view = await getRouteOverview(identity);
  const pendingRevision = await getRoutePendingRevision(identity);
  if (!view.objective) return <main><p>No route yet. The department has not proposed one.</p></main>;
  return (
    <main>
      <h2>Objective: {view.objective.target} {view.objective.metric} ({view.objective.kind})</h2>
      <p>Status: {view.objective.status}</p>
      {pendingRevision ? (
        <RevisionCard
          revisionId={pendingRevision.id}
          waypointTitle={pendingRevision.waypointTitle}
          priorGoal={pendingRevision.priorGoal}
          proposedGoal={pendingRevision.proposedGoal}
          rationale={pendingRevision.rationale}
        />
      ) : null}
      {view.waypoints.map((wp) => (
        <section key={wp.order} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>{wp.order}. {wp.title} — {wp.status}</h3>
          <p>{wp.goal}</p>
          <ul>
            {wp.actions.map((a) => (
              <li key={a.id}>{a.employeeRole} / {a.type} — <strong>{a.status}</strong></li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
