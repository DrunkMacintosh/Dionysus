import { requireSession } from "../../lib/auth";
import { listProposedDrafts } from "../../lib/review";
import { approveDraft, rejectDraft } from "../actions";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await listProposedDrafts({ businessId: session.businessId });
  if (drafts.length === 0) return <main><p>No drafts waiting for review.</p></main>;
  return (
    <main>
      <h2>Drafts for review</h2>
      {drafts.map((d) => (
        <article key={d.actionId} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <p style={{ color: "#666", margin: 0 }}>{d.waypointTitle} · {d.employeeRole} · {d.type} · {d.channel}</p>
          {d.title ? <h3>{d.title}</h3> : null}
          <p style={{ whiteSpace: "pre-wrap" }}>{d.body}</p>
          {d.rationale ? <p style={{ color: "#666" }}>Why: {d.rationale}</p> : null}
          <form action={async (fd: FormData) => { "use server"; await approveDraft(null, fd); }} style={{ display: "inline" }}>
            <input type="hidden" name="routeActionId" value={d.actionId} />
            <button type="submit">Approve</button>
          </form>{" "}
          <form action={async (fd: FormData) => { "use server"; await rejectDraft(null, fd); }} style={{ display: "inline" }}>
            <input type="hidden" name="routeActionId" value={d.actionId} />
            <button type="submit">Reject</button>
          </form>
        </article>
      ))}
    </main>
  );
}
