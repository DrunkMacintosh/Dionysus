"use client";

import { useActionState } from "react";
import { approveDraft, rejectDraft, editDraft, type ActionResult } from "../actions";

export type DraftCardProps = {
  actionId: string; employeeRole: string; type: string;
  channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; rationale: string | null; editDistance: number | null;
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
        {d.waypointTitle} · {d.employeeRole} · {d.type} · {d.channel}
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
