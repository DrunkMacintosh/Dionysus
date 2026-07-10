import { requireSession } from "../../lib/auth";
import { listProposedDrafts, getDigestHeader } from "../../lib/review";
import { markReviewed } from "../actions";
import { DraftCard } from "./draft-card";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const header = await getDigestHeader(identity);
  const drafts = await listProposedDrafts(identity);
  return (
    <main>
      <h2>Daily review — {header.date}</h2>
      <p style={{ color: "#666" }}>
        {header.itemCount} item(s) batched today · {header.openCount} open now ·{" "}
        {header.reviewedAt ? `reviewed ${header.reviewedAt.toISOString()}` : "not yet reviewed"}
      </p>
      {!header.reviewedAt ? (
        <form action={async (fd: FormData) => { "use server"; await markReviewed(null, fd); }}>
          <input type="hidden" name="digestId" value={header.digestId} />
          <button type="submit">Mark today reviewed</button>
        </form>
      ) : null}
      {drafts.length === 0 ? <p>No drafts waiting for review.</p> : drafts.map((d) => <DraftCard key={d.actionId} {...d} />)}
    </main>
  );
}
