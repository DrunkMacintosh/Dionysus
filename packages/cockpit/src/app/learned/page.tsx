import { requireSession } from "../../lib/auth";
import { getCraftBeliefs } from "../../lib/review";

export const dynamic = "force-dynamic";

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.6) return "confident";
  if (confidence >= 0.3) return "some evidence";
  return "still learning";
}

export default async function LearnedPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const beliefs = await getCraftBeliefs(identity);
  return (
    <main>
      <h2>What I&apos;ve learned about your drafts</h2>
      <p style={{ color: "#666" }}>
        Craft observations from how you review drafts — what you approve as-is versus edit or reject.
        These are hypotheses, not performance claims; I label low confidence where the evidence is thin.
      </p>
      {beliefs.length === 0 ? (
        <p>Nothing learned yet — I&apos;ll start noticing patterns as you review drafts.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {beliefs.map((b, i) => (
            <li key={i} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <strong>{b.title}</strong>
              <span style={{ color: "#666" }}> · {confidenceLabel(b.confidence)}</span>
              <p style={{ margin: "8px 0" }}>{b.body}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
