import { requireSession } from "../lib/auth";
import { getRouteOverview } from "../lib/review";

export const dynamic = "force-dynamic";

export default async function RoutePage() {
  const session = await requireSession();
  const view = await getRouteOverview({ businessId: session.businessId });
  if (!view.objective) return <main><p>No route yet. The department has not proposed one.</p></main>;
  return (
    <main>
      <h2>Objective: {view.objective.target} {view.objective.metric} ({view.objective.kind})</h2>
      <p>Status: {view.objective.status}</p>
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
