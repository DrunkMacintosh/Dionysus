"use client";
import { useActionState } from "react";
import { connectAnalyticsAction, connectVideoSourceAction, type ActionResult } from "../../lib/integration-actions";

export function ConnectForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(connectAnalyticsAction, null);
  return (
    <form action={action}>
      <div><label>Metric name <input name="metric" placeholder="signups" required /></label></div>
      <div><label>Stats endpoint (JSON) <input name="endpoint" placeholder="https://…" required /></label></div>
      <div><label>API key (optional) <input name="apiKey" type="password" /></label></div>
      <button type="submit">Connect analytics</button>
      {result && <p style={{ color: result.ok ? "green" : "crimson" }}>{result.message}</p>}
    </form>
  );
}

// The apiKey input is type=password and write-only: it is never pre-filled from the
// stored (encrypted) value, so the secret never round-trips back to the browser.
export function ConnectVideoForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(connectVideoSourceAction, null);
  return (
    <form action={action}>
      <div><label>Generation endpoint (JSON) <input name="endpoint" placeholder="https://…" required /></label></div>
      <div><label>API key <input name="apiKey" type="password" required /></label></div>
      <button type="submit">Connect video source</button>
      {result && <p style={{ color: result.ok ? "green" : "crimson" }}>{result.message}</p>}
    </form>
  );
}
