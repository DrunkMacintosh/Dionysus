import { describe, it, expect } from "vitest";
import { loadGatewayConfig } from "../src/gateway/config.js";

describe("loadGatewayConfig", () => {
  it("loads a full config with defaults", () => {
    const cfg = loadGatewayConfig({ GATEWAY_UPSTREAM_URL: "https://api.example.com" });
    expect(cfg).toEqual({
      port: 8787,
      upstreamUrl: "https://api.example.com",
      upstreamKey: undefined,
      inboundToken: undefined,
    });
  });

  it("strips a trailing slash from the upstream URL and honors overrides", () => {
    const cfg = loadGatewayConfig({
      GATEWAY_UPSTREAM_URL: "https://api.example.com/",
      GATEWAY_PORT: "9911",
      GATEWAY_UPSTREAM_KEY: "sk-1",
      GATEWAY_TOKEN: "tok",
    });
    expect(cfg.upstreamUrl).toBe("https://api.example.com");
    expect(cfg.port).toBe(9911);
    expect(cfg.upstreamKey).toBe("sk-1");
    expect(cfg.inboundToken).toBe("tok");
  });

  it("refuses to start without an upstream URL (fail-closed)", () => {
    expect(() => loadGatewayConfig({})).toThrow(/GATEWAY_UPSTREAM_URL/);
  });

  it("refuses to start on a non-numeric GATEWAY_PORT (fail-closed)", () => {
    expect(() =>
      loadGatewayConfig({ GATEWAY_UPSTREAM_URL: "https://x.com", GATEWAY_PORT: "abc" }),
    ).toThrow(/GATEWAY_PORT/);
  });
});
