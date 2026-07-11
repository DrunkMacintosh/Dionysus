import { requireSession } from "../../lib/auth";
import { getIntegrations } from "../../lib/review";
import { ConnectForm } from "./connect-form";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const session = await requireSession();
  const integrations = await getIntegrations({ businessId: session.businessId });
  const analytics = integrations.filter((i) => i.kind === "analytics" && i.status === "connected");
  return (
    <main>
      <h2>Connect analytics</h2>
      <p style={{ color: "#666" }}>
        Connect a read-only analytics source so your report can grade <strong>real</strong> outcomes, not just what shipped.
        Until you connect one, the report stays honest — it never claims a number moved that it can&apos;t measure.
        Your credentials are encrypted at rest.
      </p>
      {analytics.length > 0 ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <strong>Connected:</strong> {analytics[0]!.provider} · measuring <em>{analytics[0]!.metric}</em>
        </div>
      ) : (
        <p>No analytics connected yet.</p>
      )}
      <ConnectForm />
    </main>
  );
}
