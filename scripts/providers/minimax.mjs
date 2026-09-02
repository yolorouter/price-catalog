// MiniMax price fetcher.
//
// MiniMax's docs are a Mintlify site: appending `.md` to a doc URL returns the
// raw markdown table instead of the rendered page. The pay-as-you-go pricing
// page is one such table — input/output/cache-read per million tokens, in CNY.
// We parse the markdown table rows directly.

import { fetchWithTimeout } from "./_fetch.mjs";

const HOST = "api.minimaxi.com";
const ENDPOINT = "https://platform.minimaxi.com/docs/guides/pricing-paygo.md";

export async function fetchMiniMax() {
  const resp = await fetchWithTimeout(ENDPOINT);
  if (!resp.ok) throw new Error(`minimax: HTTP ${resp.status}`);
  const md = await resp.text();

  const entries = new Map();
  // Match table rows: | <model+label> | <input> | <output> | <cacheread> |
  // Numbers may carry a discount "~~old~~ new" form; take the trailing number.
  const rowRe = /\|\s*\*{0,2}([A-Za-z][\w.-]*)[^|]*\|[^|]*?([\d.]+)[^|]*\|[^|]*?([\d.]+)[^|]*\|[^|]*?([\d.]+)?[^|]*\|/g;
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    const name = m[1].toLowerCase();
    if (!name.startsWith("minimax")) continue; // skip table headers / unrelated rows
    const input = Number(m[2]);
    const output = Number(m[3]);
    const cacheRead = m[4] ? Number(m[4]) : null;
    // Keep only the first (cheapest tier) row per base model name.
    if (!entries.has(name)) {
      entries.set(name, { input, output, cacheWrite: null, cacheRead });
    }
  }

  if (entries.size === 0) throw new Error("minimax: parsed 0 models — markdown format likely changed");
  return { host: HOST, models: Object.fromEntries(entries) };
}
