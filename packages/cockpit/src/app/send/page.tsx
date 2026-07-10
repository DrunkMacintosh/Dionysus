import { requireSession } from "../../lib/auth";
import { listSendQueue, listExecuted, isRenderableHttpUrl } from "../../lib/review";
import { SendCard } from "./send-card";

export const dynamic = "force-dynamic";

export default async function SendPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const queue = await listSendQueue(identity);
  const executed = await listExecuted(identity);
  return (
    <main>
      <h2>Send queue</h2>
      <p style={{ color: "#666" }}>
        Copy the approved content, post it on its channel, paste the public URL back here, then verify it went live.
      </p>
      {queue.length === 0
        ? <p>Nothing approved is waiting to be sent.</p>
        : queue.map((c) => <SendCard key={c.actionId} {...c} />)}

      <h2 style={{ marginTop: 32 }}>Verified</h2>
      {executed.length === 0 ? (
        <p>No verified sends yet.</p>
      ) : (
        <ul>
          {executed.map((e) => (
            <li key={e.actionId} style={{ marginBottom: 8 }}>
              ✓ {e.title ?? "(untitled)"}
              {e.channel ? ` · ${e.channel}` : ""}
              {e.verifiedAt ? ` · verified ${e.verifiedAt.toISOString()}` : ""}
              {" · "}
              {e.postedUrl && isRenderableHttpUrl(e.postedUrl) ? (
                <a href={e.postedUrl} target="_blank" rel="noopener noreferrer">{e.postedUrl}</a>
              ) : (
                <span>{e.postedUrl ?? "(no URL)"}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
