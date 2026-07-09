import http from "node:http";
import { loadIdentity } from "./identity.js";
import { loadGatewayConfig } from "./gateway/config.js";
import { createGatewayHandler } from "./gateway/proxy.js";

const identity = loadIdentity();
const cfg = loadGatewayConfig();
const server = http.createServer(createGatewayHandler(identity, cfg));

// 127.0.0.1 ONLY — the gateway is a local per-container proxy, never exposed.
server.listen(cfg.port, "127.0.0.1", () => {
  console.error(
    `llm-gateway up for ${identity.businessId} on 127.0.0.1:${cfg.port} -> ${cfg.upstreamUrl} (D28 hard cap active)`,
  );
});
