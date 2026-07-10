"use client";

import { useActionState } from "react";
import { submitSend, type ActionResult } from "../actions";

export type SendCardProps = {
  actionId: string; channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; status: "approved" | "executing"; postedUrl: string | null;
};

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <p style={{ color: state.ok ? "#0a7d33" : "#b00020", margin: "4px 0" }}>{state.message}</p>;
}

export function SendCard(c: SendCardProps) {
  const [state, formAction] = useActionState(submitSend, null);
  const copyText = [c.title, c.body].filter((s): s is string => Boolean(s)).join("\n\n");
  return (
    <article style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <p style={{ color: "#666", margin: 0 }}>
        {c.waypointTitle} · {c.channel} · {c.status}
      </p>
      {c.title ? <h3 style={{ marginBottom: 4 }}>{c.title}</h3> : null}
      <p style={{ color: "#666", margin: "8px 0 4px" }}>Copy this, post it, then paste the public URL below:</p>
      <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", background: "#f7f7f7", border: "1px solid #eee", borderRadius: 6, padding: 8, margin: "0 0 8px" }}>{copyText}</pre>
      <form action={formAction}>
        <input type="hidden" name="routeActionId" value={c.actionId} />
        <input
          type="url"
          name="postedUrl"
          defaultValue={c.postedUrl ?? ""}
          placeholder="https://… the public URL where you posted this"
          style={{ width: "100%", fontFamily: "inherit", marginBottom: 6, boxSizing: "border-box" }}
        />
        <button type="submit">I posted this — verify</button>
      </form>
      <Result state={state} />
    </article>
  );
}
