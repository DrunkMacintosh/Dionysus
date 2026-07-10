import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const cache = new Map<string, string>();

export function loadPrompt(name: "reasoning-standard" | "historian" | "strategist" | "route-strategist" | "copywriter" | "simulator"): string {
  if (!cache.has(name)) cache.set(name, readFileSync(join(dir, `${name}.md`), "utf8"));
  return cache.get(name)!;
}
