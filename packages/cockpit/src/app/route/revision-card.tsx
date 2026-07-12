"use client";

import { useActionState } from "react";
import { approveRevisionAction, rejectRevisionAction, type ActionResult } from "../../lib/revision-actions";

export type RevisionCardProps = {
  revisionId: string; waypointTitle: string; priorGoal: string; proposedGoal: string; rationale: string;
};

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p style={{ color: state.ok ? "#0a7d33" : "#b00020", margin: "4px 0" }}>{state.message}</p>;
}

// Stage 6c, Task 5 — the founder-gated "Proposed plan change" card. All text is React-escaped
// JSX children (no dangerouslySetInnerHTML, no href built from data — the rationale/goals are
// server-composed but still rendered as plain text). Approve + Reject are two separate forms,
// each with its own useActionState and a hidden revisionId, mirroring draft-card.tsx.
export function RevisionCard(r: RevisionCardProps) {
  const [approveState, approveFormAction] = useActionState(approveRevisionAction, null);
  const [rejectState, rejectFormAction] = useActionState(rejectRevisionAction, null);
  return (
    <article style={{ border: "2px solid #c9b8f0", borderRadius: 8, padding: 12, marginBottom: 16, background: "#f4f0ff" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>Proposed plan change</p>
      <p style={{ color: "#666", margin: "8px 0 4px" }}>Waypoint: {r.waypointTitle}</p>
      <p style={{ margin: "4px 0" }}>Current goal: {r.priorGoal}</p>
      <p style={{ margin: "4px 0" }}>Proposed goal: {r.proposedGoal}</p>
      <p style={{ color: "#666", margin: "8px 0" }}>Why: {r.rationale}</p>
      <form action={approveFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="revisionId" value={r.revisionId} />
        <button type="submit">Approve</button>
      </form>{" "}
      <form action={rejectFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="revisionId" value={r.revisionId} />
        <button type="submit">Reject</button>
      </form>
      <Result state={approveState ?? rejectState} />
    </article>
  );
}
