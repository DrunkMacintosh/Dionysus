// The ONE file in packages/department that owns the LLM-SDK boundary.
//
// SDK verified against the installed package: @openai/agents@0.13.0
// (agents-core / agents-openai 0.13.0). VERDICT: unusable in this workspace.
// @openai/agents@0.13.0 declares `zod@^4.0.0` as a REQUIRED peer and constructs
// its protocol schemas with the zod-v4 API at module load. The workspace is
// pinned to zod@3.25.76 (Global Constraints: `zod: ^3`; dionysus-mcp is zod 3;
// the FIXED `types.ts` uses the zod-3 `z.ZodObject<z.ZodRawShape>` generic).
// Under zod 3 the SDK throws at IMPORT time inside
// `@openai/agents-core .../types/protocol.ts` -> zod/v3 `create`
// ("Cannot read properties of undefined (reading 'type')"). The plan's
// representative symbols also drifted: `setTracingDisabled` does not exist in
// 0.13.0 (tracing is a `Runner({ tracingDisabled })` / RunConfig field).
//
// Per Task-1 Step 6 and Orchestrator note 4, we implement `runAgent` as a
// hand-rolled chat-completions tool loop directly over the `openai` client.
// This keeps the FIXED `Harness` surface byte-identical for Tasks 6-8, and is
// in fact closer to D34 (the D28 gateway speaks chat-completions only). If the
// workspace ever moves to zod 4, the internals here can be swapped back to the
// SDK without touching the exported interface.
import OpenAI from "openai";
import { z } from "zod";
import type { AgentDef, AgentRunResult, Harness, ToolDef } from "./types.js";

// Safety bound so a misbehaving model cannot loop forever (D34 cost/fail-closed).
const MAX_TOOL_TURNS = 8;

/**
 * Minimal zod-object -> JSON-Schema conversion for tool `parameters`.
 * Covers the primitives department tools use (string/number/boolean/enum/array/
 * object, and optional/nullable/default wrappers); anything else degrades to an
 * unconstrained schema `{}` rather than throwing.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToJsonSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema.removeDefault());
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: [...schema.options] };
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element) };
  }
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(schema.shape as z.ZodRawShape)) {
      properties[key] = zodToJsonSchema(field);
      const isOptional =
        field instanceof z.ZodOptional || field instanceof z.ZodDefault;
      if (!isOptional) required.push(key);
    }
    const out: Record<string, unknown> = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  return {};
}

function toChatTool(t: ToolDef): OpenAI.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    },
  };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createSdkHarness(opts: { baseUrl: string; apiKey: string }): Harness {
  // D34: all model calls go through the D28 gateway (chat-completions only).
  const client = new OpenAI({ baseURL: opts.baseUrl, apiKey: opts.apiKey });

  return {
    async runAgent(def: AgentDef, input: string): Promise<AgentRunResult> {
      const toolMap = new Map<string, ToolDef>(def.tools.map((t) => [t.name, t]));
      const tools = def.tools.map(toChatTool);
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: def.instructions },
        { role: "user", content: input },
      ];

      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const res = await client.chat.completions.create({
          model: def.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        });
        const choice = res.choices[0];
        const message = choice?.message;
        if (!message) {
          throw new Error("harness.runAgent: model returned no choices");
        }

        const toolCalls = message.tool_calls ?? [];
        const assistant: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: message.content ?? null,
        };
        if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
        messages.push(assistant);

        if (toolCalls.length === 0) {
          return { finalOutput: message.content ?? "" };
        }

        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          const toolDef = toolMap.get(tc.function.name);
          const content = toolDef
            ? await toolDef.execute(parseToolArgs(tc.function.arguments))
            : JSON.stringify({ error: `unknown tool: ${tc.function.name}` });
          messages.push({ role: "tool", tool_call_id: tc.id, content });
        }
      }

      throw new Error(
        `harness.runAgent: exceeded ${MAX_TOOL_TURNS} tool turns without a final message`,
      );
    },

    async completeOnce(model: string, system: string, user: string): Promise<string> {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}
