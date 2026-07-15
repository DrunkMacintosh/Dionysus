// Stage 6m: shared by draft-waypoint (routing) and propose-route (role clamping).
// Server-derived — the model never picks its own router or its own role.
export const VIDEO_CHANNELS = new Set(["tiktok", "reels", "shorts", "youtube-shorts", "instagram-reels", "video"]);
export const isVideoChannel = (channel: string): boolean => VIDEO_CHANNELS.has(channel.toLowerCase().trim());
