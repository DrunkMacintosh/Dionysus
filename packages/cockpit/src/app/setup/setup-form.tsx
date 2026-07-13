"use client";
import { useActionState } from "react";
import { createObjectiveAction, type ActionResult } from "../../lib/objective-actions";

export function SetupForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(createObjectiveAction, null);
  return (
    <form action={action}>
      <div><label>Objective kind <input name="kind" placeholder="signups" required /></label></div>
      <div><label>Target <input name="target" placeholder="100" required /></label></div>
      <div><label>Metric <input name="metric" placeholder="new users" required /></label></div>
      <button type="submit">Save objective</button>
      {result && <p style={{ color: result.ok ? "green" : "crimson" }}>{result.message}</p>}
    </form>
  );
}
