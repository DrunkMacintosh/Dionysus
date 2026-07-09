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
  });

  it("completeOnce returns the message content", async () => {
    const harness = createSdkHarness({ baseUrl: url, apiKey: "test-key" });
    const out = await harness.completeOnce("mock-model", "sys", "user");
    expect(out).toContain("FINAL: pong"); // mock returns the same final shape
  });
});
