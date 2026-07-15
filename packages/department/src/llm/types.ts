import type { z } from "zod";

export type ToolDef = {
  name: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  execute: (args: Record<string, unknown>) => Promise<string>; // JSON string result
};

export type AgentDef = {
  name: string;
  model: string; // e.g. "nvidia/nemotron-3-super-120b-a12b"
  instructions: string; // assembled prompt text
  tools: ToolDef[];
  // Per-agent override of the harness's tool-turn safety bound. Omitted for
  // ordinary agents (they use the default guard); raised only for research
  // agents whose legitimate work is many search/fetch turns.
  maxToolTurns?: number;
  // Per-agent override of the harness's per-call OUTPUT-token bound. Omitted for
  // ordinary agents (they use DEFAULT_MAX_OUTPUT_TOKENS); set only when an agent
  // legitimately needs a different completion ceiling.
  maxOutputTokens?: number;
};

export type AgentRunResult = { finalOutput: string };

export interface Harness {
  runAgent(def: AgentDef, input: string): Promise<AgentRunResult>;
  completeOnce(model: string, system: string, user: string): Promise<string>;
}
