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

  it("persist_asset is registered and businessId-free", () => {
    expect(Object.keys(TOOL_SCHEMAS)).toContain("persist_asset");
    expect(Object.keys(TOOL_SCHEMAS.persist_asset)).not.toContain("businessId");
  });

  it("record_simulation is registered, businessId-free, engine-enum'd", () => {
    expect(Object.keys(TOOL_SCHEMAS)).toContain("record_simulation");
    const shape = TOOL_SCHEMAS.record_simulation as Record<string, z.ZodTypeAny>;
    expect(Object.keys(shape)).not.toContain("businessId");
    expect(shape.engine.safeParse("focus_group").success).toBe(true);
    expect(shape.engine.safeParse("oracle").success).toBe(false);
    expect(shape.confidence.safeParse(1.5).success).toBe(false);
  });
});

describe("buildServer", () => {
  it("constructs a server bound to one identity", () => {
    const server = buildServer({ businessId: "biz_x" });
    expect(server).toBeTruthy();
  });
});

describe("plan-tool status enums (MCP boundary)", () => {
  it("plan-tool status schemas reject garbage at the MCP boundary", () => {
    for (const key of ["create_objective", "persist_route", "persist_waypoint"] as const) {
      const shape = TOOL_SCHEMAS[key] as Record<string, z.ZodTypeAny>;
      expect(shape.status.safeParse("garbage").success).toBe(false);
      expect(shape.status.safeParse(undefined).success).toBe(true); // still optional
    }
    expect((TOOL_SCHEMAS.create_objective as Record<string, z.ZodTypeAny>).status.safeParse("active").success).toBe(true);
    expect((TOOL_SCHEMAS.persist_route as Record<string, z.ZodTypeAny>).status.safeParse("proposed").success).toBe(true);
    expect((TOOL_SCHEMAS.persist_waypoint as Record<string, z.ZodTypeAny>).status.safeParse("locked").success).toBe(true);
  });
});
