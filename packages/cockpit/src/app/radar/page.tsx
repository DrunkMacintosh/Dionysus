import { requireSession } from "../../lib/auth";
import { listRadarObservations, isRenderableHttpUrl } from "../../lib/review";

export const dynamic = "force-dynamic";

export default async function RadarPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const observations = await listRadarObservations(identity);
  return (
    <main>
      <h2>What I noticed</h2>
      <p style={{ color: "#666" }}>
        Unverified market signals sensed from public sources. Nothing here has been acted on — the
        high-relevance ones become proposed drafts in your <a href="/drafts">review queue</a> for you to
        approve before anything is sent.
      </p>
      {observations.length === 0 ? (
        <p>Nothing noticed yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {observations.map((o) => (
            <li key={o.nodeId} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <strong>{o.title}</strong>
              <span style={{ color: "#666" }}> · confidence {o.confidence.toFixed(2)}</span>
              <p style={{ margin: "8px 0" }}>{o.body}</p>
              <div style={{ fontSize: 13, color: "#666" }}>
                source:{" "}
                {o.sourceUrl && isRenderableHttpUrl(o.sourceUrl) ? (
                  <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer">{o.sourceUrl}</a>
                ) : (
                  <span>{o.sourceUrl ?? "(no source)"}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
