"use client";

import { useActionState } from "react";
import { approveDraft, rejectDraft, editDraft, type ActionResult } from "../actions";

export type DraftCardProps = {
  actionId: string; employeeRole: string; type: string; kind: string;
  channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; rationale: string | null; editDistance: number | null;
  simulation: { engagementScore: number | null; verdict: string | null; topConcerns: string[]; confidence: number; createdAt: Date } | null;
};

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p style={{ color: state.ok ? "#0a7d33" : "#b00020", margin: "4px 0" }}>{state.message}</p>;
}

export function DraftCard(d: DraftCardProps) {
  const [approveState, approveFormAction] = useActionState(approveDraft, null);
  const [rejectState, rejectFormAction] = useActionState(rejectDraft, null);
  const [editState, editFormAction] = useActionState(editDraft, null);
  return (
    <article style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <p style={{ color: "#666", margin: 0 }}>
        {d.waypointTitle} · {d.employeeRole} · {d.type} · {d.kind} · {d.channel}
        {d.editDistance != null ? ` · edit distance so far: ${d.editDistance}` : ""}
      </p>
      {d.title ? <h3>{d.title}</h3> : null}
      <form action={editFormAction}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <textarea name="newBody" defaultValue={d.body ?? ""} rows={6} style={{ width: "100%", fontFamily: "inherit" }} />
        <button type="submit">Save edit</button>
      </form>
      <Result state={editState} />
      {d.rationale ? <p style={{ color: "#666" }}>Why: {d.rationale}</p> : null}
      {d.simulation ? (
        <aside style={{ background: "#f4f0ff", border: "1px solid #c9b8f0", borderRadius: 6, padding: 8, margin: "8px 0" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            Focus-group prediction (simulated — not a measurement)
          </p>
          <p style={{ margin: "4px 0" }}>
            {d.simulation.engagementScore != null ? `Engagement ${d.simulation.engagementScore}/10 · ` : ""}
            {d.simulation.verdict ?? "(no verdict)"} · confidence {(d.simulation.confidence * 100).toFixed(0)}%
          </p>
          {d.simulation.topConcerns.length > 0 ? (
            <p style={{ margin: 0, color: "#555" }}>Concerns: {d.simulation.topConcerns.join("; ")}</p>
          ) : null}
        </aside>
      ) : null}
      <form action={approveFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <button type="submit">Approve</button>
      </form>{" "}
      <form action={rejectFormAction} style={{ display: "inline" }}>
        <input type="hidden" name="routeActionId" value={d.actionId} />
        <button type="submit">Reject</button>
      </form>
      <Result state={approveState ?? rejectState} />
    </article>
  );
}
