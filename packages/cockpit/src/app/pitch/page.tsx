import { requireSession } from "../../lib/auth";
import { listPitchRequests } from "../../lib/review";
import { PitchForm } from "./pitch-form";

export const dynamic = "force-dynamic";

// Stage 6g, Task 2 — the founder names an outreach target here (newsletter/podcast/
// blog: name + URL, optional note); the nightly drafts a personalized pitch overnight,
// grounded in a verbatim quote from the target's real page, and the draft lands on
// /drafts for review (the founder sends it from their own mail client). Dionysus NEVER
// invents a target — one exists only because the founder created it here. All founder
// text is React-escaped JSX children; the target URL renders as PLAIN TEXT (it is
// founder-typed, never a live link — no <a href>).
export default async function PitchPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const requests = await listPitchRequests(identity);
  return (
    <main>
      <h2>Pitch a target</h2>
      <p style={{ color: "#666" }}>
        Name a newsletter, podcast, or blog whose audience is yours — with a link to a page
        worth referencing. Tonight Dionysus drafts a personalized pitch grounded in that page;
        you review it on /drafts and send it from your own mail client. Nothing is emailed for you.
      </p>
      <PitchForm />
      <h3>Your pitch requests</h3>
      {requests.length === 0 ? (
        <p>No pitch requests yet.</p>
      ) : (
        <ul>
          {requests.map((r) => (
            <li key={r.actionId}>
              <strong>{r.targetName}</strong> — {r.targetUrl}
              <br />
              <span style={{ color: "#666" }}>
                {r.drafted ? "drafted — review on /drafts" : "drafting overnight"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
