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
};

export type AgentRunResult = { finalOutput: string };

export interface Harness {
  runAgent(def: AgentDef, input: string): Promise<AgentRunResult>;
  completeOnce(model: string, system: string, user: string): Promise<string>;
}
