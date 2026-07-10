import { requireSession } from "../../lib/auth";
import { getTimeline } from "../../lib/review";

export const dynamic = "force-dynamic";

// "How your plan has evolved" (§13 anchored-to-the-plan). The live evolution graph:
// getTimeline lazily mirrors the structured plan into memory nodes on view, then
// renders the waypoint spine in order with each waypoint's actions beneath it. All
// waypoint/action text is React-escaped JSX children — no dangerouslySetInnerHTML,
// and the timeline carries no URLs, so there is no href sink to guard.
export default async function TimelinePage() {
  const session = await requireSession();
  const timeline = await getTimeline({ businessId: session.businessId });

  return (
    <main>
      <h2>How your plan has evolved</h2>
      <p style={{ color: "#666" }}>
        The live evolution graph, mirrored from your current plan each time you open this page. Each
        waypoint is a step on your route, with the actions your team proposed beneath it.
      </p>
      {!timeline.hasRoute ? (
        <p>No route yet — once you have a plan, its evolution will show up here.</p>
      ) : (
        <ol style={{ listStyle: "none", padding: 0 }}>
          {timeline.waypoints.map((wp, i) => (
            <li key={wp.nodeId} style={{ borderLeft: "2px solid #ddd", paddingLeft: 16, marginBottom: 24 }}>
              <div style={{ fontSize: 12, color: "#999", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Waypoint {i + 1}
              </div>
              <strong style={{ fontSize: 16 }}>{wp.title}</strong>
              <p style={{ margin: "4px 0 8px", color: "#666" }}>{wp.goal}</p>
              {wp.actions.length === 0 ? (
                <p style={{ color: "#999", fontSize: 13 }}>No actions proposed yet.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0 }}>
                  {wp.actions.map((a) => (
                    <li key={a.nodeId} style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <strong>{a.label}</strong>
                      {a.rationale ? <span style={{ color: "#666" }}> · {a.rationale}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
