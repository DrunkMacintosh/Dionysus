export type Identity = { businessId: string };

export function loadIdentity(
  env: Record<string, string | undefined> = process.env,
): Identity {
  const businessId = env["DIONYSUS_BUSINESS_ID"];
  if (!businessId) {
    throw new Error(
      "DIONYSUS_BUSINESS_ID is not set — refusing to start. " +
        "Identity is ambient and per-process (D27.1); it is never a tool parameter.",
    );
  }
  return { businessId };
}
