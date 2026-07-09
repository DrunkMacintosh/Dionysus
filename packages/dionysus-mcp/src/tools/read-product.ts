import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { scrapeLadder, type ScrapeResult } from "../lib/scrape/ladder.js";
import type { SafeFetchOptions } from "../lib/ssrf.js";

export async function readProduct(
  identity: Identity,
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<{ productId: string } & ScrapeResult> {
  const result = await scrapeLadder(url, fetchOpts);
  const row = await prisma.product.create({
    data: {
      businessId: identity.businessId,
      url,
      readTier: result.tier,
      title: result.title ?? null,
      description: result.description ?? null,
      text: result.text ?? null,
    },
  });
  return { productId: row.id, ...result };
}
