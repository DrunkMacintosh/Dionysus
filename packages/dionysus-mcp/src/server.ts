import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { Identity } from "./identity.js";
import { readProduct } from "./tools/read-product.js";
import { extractBrand } from "./tools/extract-brand.js";
import { recordCost, checkBudget } from "./tools/cost-budget.js";

/** Single source of truth for tool input shapes.
 *  INVARIANT (D27.1): no shape ever includes businessId — identity is ambient. */
export const TOOL_SCHEMAS = {
  read_product: { url: z.string().url() },
  extract_brand: { url: z.string().url() },
  record_cost: {
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    note: z.string().optional(),
  },
  check_budget: {},
} satisfies Record<string, ZodRawShape>;

function asText(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function buildServer(identity: Identity): McpServer {
  const server = new McpServer({ name: "dionysus-mcp", version: "0.1.0" });

  server.registerTool(
    "read_product",
    {
      description:
        "SSRF-guarded scrape ladder: read a product page into a structured Product (tier 4 = couldn't read).",
      inputSchema: TOOL_SCHEMAS.read_product,
    },
    async ({ url }) => asText(await readProduct(identity, url)),
  );

  server.registerTool(
    "extract_brand",
    {
      description:
        "Deterministic brand signals (CSS colors/fonts) from a URL into a BrandKit. Judgment lives in skills, not here.",
      inputSchema: TOOL_SCHEMAS.extract_brand,
    },
    async ({ url }) => asText(await extractBrand(identity, url)),
  );

  server.registerTool(
    "record_cost",
    {
      description:
        "Record a non-gateway LLM/service cost to the ledger. Unknown models record costUsd=null.",
      inputSchema: TOOL_SCHEMAS.record_cost,
    },
    async (args) => asText(await recordCost(identity, args)),
  );

  server.registerTool(
    "check_budget",
    {
      description:
        "Advisory daily-budget check (fail-closed). The D28 gateway is the enforcement point.",
      inputSchema: TOOL_SCHEMAS.check_budget,
    },
    async () => asText(await checkBudget(identity)),
  );

  return server;
}
