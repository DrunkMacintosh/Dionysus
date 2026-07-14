import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

/** Stage 6i Task 1 — the Videographer's storyboard contract. Scenes are
 * truncate-not-reject at MAX_SCENES (an over-long storyboard keeps its FIRST 6
 * shots — the cro/radar posture): a hard-fail would throw a filmable shot list
 * away (the 6a truncate-not-reject lesson). A storyboard with ZERO scenes is
 * malformed and fails: `.min(1)` fires before the truncating `.transform`. */
export const MAX_SCENES = 6;

export const SceneSchema = z.object({
  shot: z.string().min(1),  // what the camera sees — every scene needs one
  text: z.string(),         // the spoken line or overlay (may be empty)
});

export const StoryboardSchema = z.object({
  concept: z.string().min(1),  // the hook — becomes the asset title
  // `.min(1)` rejects zero scenes; `.transform` then keeps the FIRST MAX_SCENES
  // (truncate-not-reject, the 6a lesson) so a 7-scene storyboard drafts.
  scenes: z.array(SceneSchema).min(1).transform((s) => s.slice(0, MAX_SCENES)),
  caption: z.string().min(1),  // the post caption the founder pastes
});
export type StoryboardOutput = z.infer<typeof StoryboardSchema>;

export function parseStoryboard(raw: string, retryFn: (err: string) => Promise<string>): Promise<StoryboardOutput> {
  return parseWithRetry(StoryboardSchema, raw, retryFn);
}
