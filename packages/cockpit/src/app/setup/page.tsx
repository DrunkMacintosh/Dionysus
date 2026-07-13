import { requireSession } from "../../lib/auth";
import { getActiveObjective } from "../../lib/review";
import { prisma } from "dionysus-mcp/db";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

// Stage 6f, Task 2 — the founder states the objective here; the nightly bootstraps
// the first route overnight. One active objective at a time (the dogfood
// simplification): an existing active objective renders as a SUMMARY (not the form),
// with an HONEST next-step line — a route already exists → point at /route; otherwise
// the plan is coming overnight. All model/founder text is React-escaped JSX children.
export default async function SetupPage() {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const objective = await getActiveObjective(identity);

  if (objective) {
    // Scoped route lookup: is there already a route for this tenant? (Determines the honest next step.)
    const route = await prisma.route.findFirst({ where: { businessId: identity.businessId } });
    return (
      <main>
        <h2>Your objective: {objective.kind} — {objective.target} ({objective.metric})</h2>
        <p>
          {route
            ? "Your route is on /route."
            : "Dionysus will propose a route overnight — check /route in the morning."}
        </p>
      </main>
    );
  }

  return (
    <main>
      <h2>State your objective</h2>
      <p style={{ color: "#666" }}>
        Tell Dionysus what you&apos;re trying to move. Tonight it proposes a route from the best
        discovered case — waypoints and draft actions you review in the morning. Nothing ships without you.
      </p>
      <SetupForm />
    </main>
  );
}
