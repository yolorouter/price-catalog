// Kimi (Moonshot) price fetcher.
//
// Mintlify multi-page: each model has its own pricing page listed in
// /docs/llms.txt. We fetch llms.txt, filter to the /docs/pricing/chat-*.md pages,
// then fetch each and parse its pricing row. All in CNY per million tokens.
//
// A Kimi per-model page carries a row like:
//   ["kimi-k3", "1M tokens", "¥2.00", "¥20.00", "¥100.00", "1,048,576 tokens"]
// columns: model | unit | input(cache hit) | input(cache miss) | output | context.
// catalog: input = cache-miss column, output = output column, cache_read = hit column.

import { fetchWithTimeout } from "./_fetch.mjs";

const HOST = "api.moonshot.cn";
const LLMS_TXT = "https://platform.kimi.com/docs/llms.txt";

export async function fetchKimi() {
  const resp = await fetchWithTimeout(LLMS_TXT);
  if (!resp.ok) throw new Error(`kimi llms.txt: HTTP ${resp.status}`);
  const txt = await resp.text();

  // Pull chat pricing page URLs. llms.txt lists them as markdown links.
  const pageUrls = [...txt.matchAll(/https:\/\/platform\.kimi\.com\/docs\/pricing\/chat-[a-z0-9-]+\.md/g)]
    .map((m) => m[0]);
  // De-dup (llms.txt may repeat).
  const unique = [...new Set(pageUrls)];

  if (unique.length === 0) throw new Error("kimi: found 0 chat pricing pages in llms.txt");

  const entries = new Map();
  // Sequential to be polite to the docs host; there are only ~6 pages.
  for (const url of unique) {
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) continue;
      const md = await r.text();
      // The pricing row is a JSON array literal in the markdown.
      const row = md.match(/\[\s*"([a-z0-9][\w.-]*)"\s*,\s*"\d+\s*[Mm]\s*tokens"\s*,\s*"¥\s*([\d.]+)"\s*,\s*"¥\s*([\d.]+)"\s*,\s*"¥\s*([\d.]+)"/);
      if (row) {
        entries.set(row[1], {
          input: Number(row[3]),   // cache-miss input
          output: Number(row[4]),  // output
          cacheWrite: null,
          cacheRead: Number(row[2]), // cache-hit input
        });
      }
    } catch {
      // One page failing shouldn't abort the whole provider.
    }
  }

  if (entries.size === 0) throw new Error("kimi: parsed 0 models across pricing pages");
  return { host: HOST, models: Object.fromEntries(entries) };
}
