import { createHash } from "node:crypto";

/** D29 content binding: sha256 hex over the Asset's stored contentJson string, byte-exact. */
export function hashContent(contentJson: string): string {
  return createHash("sha256").update(contentJson, "utf8").digest("hex");
}
