import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOL_SCHEMAS, buildServer } from "../src/server.js";

describe("D27.1 — tool schemas", () => {
  it("no tool schema contains a businessId field", () => {
    for (const [name, shape] of Object.entries(TOOL_SCHEMAS)) {
      expect(Object.keys(shape), `tool ${name}`).not.toContain("businessId");
    }
  });

  it("strict schemas reject an injected businessId", () => {
    for (const [name, shape] of Object.entries(TOOL_SCHEMAS)) {
      const schema = z.object(shape).strict();
      const base: Record<string, unknown> = {};
      if ("url" in shape) base["url"] = "https://example.com";
      if ("model" in shape) {
        base["model"] = "m";
        base["inputTokens"] = 1;
        base["outputTokens"] = 1;
      }
      const withInjection = { ...base, businessId: "biz_victim" };
      const parsed = schema.safeParse(withInjection);
      expect(parsed.success, `tool ${name} must reject businessId`).toBe(false);
    }
  });

  it("plan tools are registered and businessId-free; upsert_route_action has no status field", () => {
    for (const name of ["create_objective", "persist_route", "persist_waypoint", "upsert_route_action"]) {
      expect(Object.keys(TOOL_SCHEMAS), name).toContain(name);
      expect(Object.keys(TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS]), name).not.toContain("businessId");
    }
    expect(Object.keys(TOOL_SCHEMAS.upsert_route_action)).not.toContain("status");
  });
});

describe("buildServer", () => {
  it("constructs a server bound to one identity", () => {
    const server = buildServer({ businessId: "biz_x" });
    expect(server).toBeTruthy();
  });
});
