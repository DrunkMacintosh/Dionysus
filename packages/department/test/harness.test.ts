import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { z } from "zod";
import { createSdkHarness } from "../src/llm/harness.js";
import type { AgentDef } from "../src/llm/types.js";

let server: http.Server;
let url: string;
let call = 0;
const seenBodies: string[] = [];

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    seenBodies.push(body);
    call++;
    res.writeHead(200, { "content-type": "application/json" });
    if (call === 1) {
      res.end(JSON.stringify({
        id: "1", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "echo_tool", arguments: JSON.stringify({ text: "ping" }) } }],
        }}],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    } else {
      res.end(JSON.stringify({
        id: "2", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "FINAL: pong" } }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});

afterAll(() => server.close());

describe("sdk harness (against a mock OpenAI-compatible server)", () => {
  it("runs an agent through a tool loop to final output", async () => {
    const harness = createSdkHarness({ baseUrl: url, apiKey: "test-key" });
    const executed: string[] = [];
    const def: AgentDef = {
      name: "probe", model: "mock-model", instructions: "You are a probe.",
      tools: [{
        name: "echo_tool", description: "echoes",
        parameters: z.object({ text: z.string() }),
        execute: async (args) => { executed.push(String(args["text"])); return JSON.stringify({ echoed: args["text"] }); },
      }],
    };
    const result = await harness.runAgent(def, "go");
    expect(executed).toEqual(["ping"]);
    expect(result.finalOutput).toContain("FINAL: pong");

    // Protocol shape: the loop must append the tool result to the SECOND request
    // with the correct chat-completions tool-message shape ({role, tool_call_id}).
    const secondBody = JSON.parse(seenBodies[1]!) as {
      messages: Array<{ role: string; tool_call_id?: string }>;
    };
    const toolMsg = secondBody.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.tool_call_id).toBe("t1");
  });

  it("completeOnce returns the message content", async () => {
    const harness = createSdkHarness({ baseUrl: url, apiKey: "test-key" });
    const out = await harness.completeOnce("mock-model", "sys", "user");
    expect(out).toContain("FINAL: pong"); // mock returns the same final shape
  });
});

// The tool-turn guard, and its per-agent override. A misbehaving (or merely
// deliberate — the historian is a research agent) model that keeps issuing tool
// calls must not loop forever; the loop runs at most `maxTurns` iterations
// (== HTTP requests here, one create() per turn) and then throws. `maxToolTurns`
// on the AgentDef raises that ceiling for research agents; every other def keeps
// the default 8.
describe("sdk harness tool-turn guard", () => {
  const toolCall = (i: number) => ({
    id: String(i), object: "chat.completion", created: 0, model: "m",
    choices: [{ index: 0, finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ id: `t${i}`, type: "function", function: { name: "loop_tool", arguments: "{}" } }],
    }}],
  });
  const final = (i: number, content: string) => ({
    id: String(i), object: "chat.completion", created: 0, model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  });

  async function withServer(
    respond: (callIndex: number) => Record<string, unknown>,
    run: (ctx: { url: string; count: () => number }) => Promise<void>,
  ): Promise<void> {
    let n = 0;
    const srv = http.createServer(async (req, res) => {
      for await (const _ of req) void _;
      n += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respond(n)));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      await run({ url: `http://127.0.0.1:${port}/v1`, count: () => n });
    } finally {
      srv.close();
    }
  }

  const looperDef = (extra: Partial<AgentDef> = {}): AgentDef => ({
    name: "looper", model: "mock-model", instructions: "loop forever",
    tools: [{
      name: "loop_tool", description: "always callable",
      parameters: z.object({}),
      execute: async () => JSON.stringify({ ok: true }),
    }],
    ...extra,
  });

  it("a def WITHOUT maxToolTurns throws after exactly 8 turns (default guard preserved)", async () => {
    await withServer(toolCall, async ({ url, count }) => {
      const harness = createSdkHarness({ baseUrl: url, apiKey: "k" });
      await expect(harness.runAgent(looperDef(), "go")).rejects.toThrow(
        /exceeded 8 tool turns/,
      );
      expect(count()).toBe(8);
    });
  });

  it("a def WITH maxToolTurns:3 that loops forever throws after exactly 3 turns", async () => {
    await withServer(toolCall, async ({ url, count }) => {
      const harness = createSdkHarness({ baseUrl: url, apiKey: "k" });
      await expect(
        harness.runAgent(looperDef({ maxToolTurns: 3 }), "go"),
      ).rejects.toThrow(/exceeded 3 tool turns/);
      expect(count()).toBe(3);
    });
  });

  it("a def WITH maxToolTurns:3 that finals on turn 3 succeeds", async () => {
    // Turns 1 and 2 are tool calls; turn 3 returns a final within the raised ceiling.
    const respond = (i: number) => (i < 3 ? toolCall(i) : final(i, "DONE-ON-3"));
    await withServer(respond, async ({ url, count }) => {
      const harness = createSdkHarness({ baseUrl: url, apiKey: "k" });
      const result = await harness.runAgent(looperDef({ maxToolTurns: 3 }), "go");
      expect(result.finalOutput).toBe("DONE-ON-3");
      expect(count()).toBe(3);
    });
  });
});
