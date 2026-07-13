"use client";
import { useActionState } from "react";
import { createPitchRequestAction, type ActionResult } from "../../lib/pitch-actions";

export function PitchForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(createPitchRequestAction, null);
  return (
    <form action={action}>
      <div><label>Target name <input name="targetName" placeholder="The Newsletter" required /></label></div>
      <div><label>Target page URL <input name="targetUrl" type="url" placeholder="https://example.com/post" required /></label></div>
      <div><label>Note (optional) <input name="note" placeholder="why their audience is yours" /></label></div>
      <button type="submit">Queue pitch</button>
      {result && <p style={{ color: result.ok ? "green" : "crimson" }}>{result.message}</p>}
    </form>
  );
}
