import { describe, it, expect } from "vitest";
import { RouteProposalSchema, parseRouteProposal } from "../src/plan-schemas.js";
import { loadPrompt } from "../src/prompts.js";

describe("RouteProposalSchema", () => {
  it("accepts an ordered set of waypoints with actions carrying rationale", () => {
    const ok = { waypoints: [
      { title: "Launch", goal: "20 signups", actions: [
        { employeeRole: "copywriter", type: "post", rationale: "HN loves authentic launches", features: { channel: "hackernews" } } ] } ] };
    expect(RouteProposalSchema.safeParse(ok).success).toBe(true);
  });
  it("rejects a waypoint with no actions and an action with no rationale", () => {
    expect(RouteProposalSchema.safeParse({ waypoints: [{ title: "t", goal: "g", actions: [] }] }).success).toBe(false);
    expect(RouteProposalSchema.safeParse({ waypoints: [{ title: "t", goal: "g",
      actions: [{ employeeRole: "r", type: "p" }] }] }).success).toBe(false); // missing rationale
  });
  it("parseRouteProposal recovers once then throws", async () => {
    const good = JSON.stringify({ waypoints: [{ title: "t", goal: "g",
      actions: [{ employeeRole: "r", type: "p", rationale: "because" }] }] });
    const fixed = await parseRouteProposal("{bad", async () => good);
    expect(fixed.waypoints[0]!.actions[0]!.rationale).toBe("because");
    await expect(parseRouteProposal("{bad", async () => "{worse")).rejects.toThrow();
  });
});

describe("route-strategist prompt", () => {
  it("carries the objective-grounding + rationale + no-invented-metrics rules", () => {
    const p = loadPrompt("route-strategist");
    for (const s of ["objective", "rationale", "UNTRUSTED-CONTENT"]) expect(p).toContain(s);
  });
});
