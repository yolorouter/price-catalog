// SiliconFlow price fetcher.
//
// The model center at https://siliconflow.cn/models is a React Server Components
// app. Its data is NOT behind an authenticated API — `GET /models?type=对话`
// with an `RSC: 1` header returns the same `text/x-component` stream the page
// renders from, with every model's pricing embedded as JSON objects. So a single
// curl is enough; no browser, no clicking, no scroll-paginated virtual list
// (that exists only for display — the data endpoint returns all models at once).
//
// Each model object in the RSC stream carries, among other fields:
//   "modelName":"deepseek-ai/DeepSeek-V4-Pro"
//   "type":"text"            <- we keep only text models (the ?type=对话 filter
//                              already asks for chat, but we double-check)
//   "inputPrice":12
//   "outputPrice":24
// We pair each modelName with the first inputPrice/outputPrice that appears
// after it (and before the next modelName), then emit catalog entries under
// the host key "api.siliconflow.cn" (the OpenAI-compatible base_url).

import { fetchWithTimeout } from "./_fetch.mjs";

const HOST = "api.siliconflow.cn";
const ENDPOINT = "https://siliconflow.cn/models?type=" + encodeURIComponent("对话");

export async function fetchSiliconFlow() {
  const resp = await fetchWithTimeout(ENDPOINT, {
    headers: { "RSC": "1", "Accept": "text/x-component" },
  });
  if (!resp.ok) {
    throw new Error(`siliconflow: HTTP ${resp.status}`);
  }
  const rsc = await resp.text();

  // Collect every match position for the three fields, then pair by position.
  // A fixed lookahead window is fragile (the gap modelName→inputPrice grows as
  // model descriptions lengthen); positional pairing is exact as long as the
  // field order in the stream stays modelName, ..., inputPrice, outputPrice.
  const names = [...rsc.matchAll(/"modelName":"([^"]+)"/g)];
  const inputs = [...rsc.matchAll(/"inputPrice":(-?[\d.]+)/g)];
  const outputs = [...rsc.matchAll(/"outputPrice":(-?[\d.]+)/g)];

  const entries = new Map();
  for (let i = 0; i < names.length; i++) {
    const name = names[i][1];
    const nameEnd = names[i].index;
    const nextNameStart = i + 1 < names.length ? names[i + 1].index : rsc.length;

    // First inputPrice/outputPrice at or after this modelName and before the next.
    const inp = inputs.find((m) => m.index >= nameEnd && m.index < nextNameStart);
    const out = outputs.find((m) => m.index >= nameEnd && m.index < nextNameStart);
    if (!inp || !out) continue;

    const input = Number(inp[1]);
    const output = Number(out[1]);
    // A zero input on a chat model is almost always a free-tier signal we don't
    // bill by, not a real per-million price. Skip those rather than emit 0.
    if (input <= 0 && output <= 0) continue;

    entries.set(name, { input, output, cacheWrite: null, cacheRead: null });
  }

  if (entries.size === 0) {
    throw new Error("siliconflow: parsed 0 models — RSC stream format likely changed");
  }
  return { host: HOST, models: Object.fromEntries(entries) };
}
