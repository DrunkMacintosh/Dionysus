import * as cheerio from "cheerio";

export type BrandSignals = { colors: string[]; fonts: string[] };

const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "-apple-system", "blinkmacsystemfont", "segoe ui", "inherit", "initial", "unset",
]);
const MAX_COLORS = 6;
const MAX_FONTS = 4;

function normalizeHex(raw: string): string | null {
  let h = raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(h)) return null; // ignore 4/8-digit alpha forms
  return h;
}

function isNearWhiteOrBlack(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (r + g + b) / 3;
  return lum > 240 || lum < 16;
}

export function extractBrandSignals(html: string, cssSources: string[]): BrandSignals {
  const inlineStyles: string[] = [];
  if (html) {
    const $ = cheerio.load(html);
    $("style").each((_i, el) => {
      inlineStyles.push($(el).text());
    });
  }
  const css = [...cssSources, ...inlineStyles].join("\n");

  const colorCounts = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hex = normalizeHex(m[0]);
    if (!hex || isNearWhiteOrBlack(hex)) continue;
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }
  const colors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COLORS)
    .map(([hex]) => hex);

  const fontCounts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const partRaw of m[1]!.split(",")) {
      const part = partRaw.trim().replace(/^["']|["']$/g, "");
      if (!part || GENERIC_FONTS.has(part.toLowerCase())) continue;
      fontCounts.set(part, (fontCounts.get(part) ?? 0) + 1);
    }
  }
  const fonts = [...fontCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FONTS)
    .map(([f]) => f);

  return { colors, fonts };
}
