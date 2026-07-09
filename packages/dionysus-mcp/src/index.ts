import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadIdentity } from "./identity.js";
import { buildServer } from "./server.js";

const identity = loadIdentity();
const server = buildServer(identity);
await server.connect(new StdioServerTransport());
console.error(
  `dionysus-mcp up for ${identity.businessId} (identity is ambient — D27.1)`,
);
