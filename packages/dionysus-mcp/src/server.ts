import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import type { Identity } from "./identity.js";
import { readProduct } from "./tools/read-product.js";
import { extractBrand } from "./tools/extract-brand.js";
import { recordCost, checkBudget } from "./tools/cost-budget.js";
import { persistCase, type CaseInput } from "./tools/persist-case.js";
import {
  createObjective,
  persistRoute,
  persistWaypoint,
  upsertRouteAction,
  OBJECTIVE_STATUSES,
  ROUTE_STATUSES,
  WAYPOINT_STATUSES,
  type ObjectiveInput,
  type RouteInput,
  type WaypointInput,
  type RouteActionInput,
} from "./tools/plan.js";
import { persistAsset, type AssetInput } from "./tools/asset.js";
import { recordSimulation, SIMULATION_ENGINES, type SimulationInput } from "./tools/simulation.js";

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
  persist_case: {
    name: z.string(),
    platform: z.string(),
    mode: z.string(),
    rank: z.number().int(),
    historicalArc: z.unknown(),
    modernizedPlan: z.unknown(),
    insight: z.string(),
    sources: z.unknown(),
    confidence: z.number().min(0).max(1),
  },
  create_objective: {
    kind: z.string().min(1), target: z.string().min(1), metric: z.string().min(1),
    dueDate: z.string().optional(), status: z.enum(OBJECTIVE_STATUSES).optional(),
  },
  persist_route: {
    objectiveId: z.string().min(1), source: z.enum(["case", "composed"]),
    caseRef: z.string().optional(), status: z.enum(ROUTE_STATUSES).optional(),
  },
  persist_waypoint: {
    routeId: z.string().min(1), order: z.number().int().min(1),
    title: z.string().min(1), goal: z.string().min(1), status: z.enum(WAYPOINT_STATUSES).optional(),
  },
  upsert_route_action: {
    waypointId: z.string().min(1), employeeRole: z.string().min(1), type: z.string().min(1),
    rationale: z.string().optional(), features: z.unknown(),
  },
  persist_asset: {
    channel: z.string().min(1), kind: z.string().min(1), content: z.unknown(),
    routeActionId: z.string().optional(),
  },
  record_simulation: {
    routeActionId: z.string().min(1), engine: z.enum(SIMULATION_ENGINES),
    prediction: z.unknown(), confidence: z.number().min(0).max(1),
  },
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

  server.registerTool(
    "persist_case",
    {
      description:
        "Persist a researched Case (historical arc + modernized plan + sourced insight) scoped to the ambient identity. JSON payloads are stored as strings (SQLite).",
      inputSchema: TOOL_SCHEMAS.persist_case,
    },
    async (args) => asText(await persistCase(identity, args as CaseInput)),
  );

  server.registerTool(
    "create_objective",
    {
      description: "Create the founder's measurable objective (north star).",
      inputSchema: TOOL_SCHEMAS.create_objective,
    },
    async (args) => asText(await createObjective(identity, args as ObjectiveInput)),
  );

  server.registerTool(
    "persist_route",
    {
      description: "Persist a route toward an objective (scope-checked).",
      inputSchema: TOOL_SCHEMAS.persist_route,
    },
    async (args) => asText(await persistRoute(identity, args as RouteInput)),
  );

  server.registerTool(
    "persist_waypoint",
    {
      description: "Persist an ordered waypoint on a route.",
      inputSchema: TOOL_SCHEMAS.persist_waypoint,
    },
    async (args) => asText(await persistWaypoint(identity, args as WaypointInput)),
  );

  server.registerTool(
    "upsert_route_action",
    {
      description: "Create a proposed route action (status is server-set to 'proposed').",
      inputSchema: TOOL_SCHEMAS.upsert_route_action,
    },
    async (args) => asText(await upsertRouteAction(identity, args as RouteActionInput)),
  );

  server.registerTool(
    "persist_asset",
    {
      description: "Persist a draft asset (optionally linked to a route action).",
      inputSchema: TOOL_SCHEMAS.persist_asset,
    },
    async (args) => asText(await persistAsset(identity, args as AssetInput)),
  );

  server.registerTool(
    "record_simulation",
    {
      description:
        "Record a pre-flight simulation prediction for a route action (labeled prediction, never fact).",
      inputSchema: TOOL_SCHEMAS.record_simulation,
    },
    async (args) => asText(await recordSimulation(identity, args as SimulationInput)),
  );

  return server;
}
