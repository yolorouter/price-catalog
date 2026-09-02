// StepFun price fetcher.
//
// Mintlify `.md` endpoint, like MiniMax. Each text model row:
//   | `step-3.7-flash` | 1M tokens | 1.35元 | 0.27元 | 8.1元 |
// columns: model | unit | input(cache miss) | input(cache hit) | output.
// We record input (cache miss) and output; cache hit becomes cache_read.

import { fetchWithTimeout } from "./_fetch.mjs";

const HOST = "api.stepfun.com";
const ENDPOINT = "https://platform.stepfun.com/docs/zh/guides/pricing/details.md";

export async function fetchStepFun() {
  const resp = await fetchWithTimeout(ENDPOINT);
  if (!resp.ok) throw new Error(`stepfun: HTTP ${resp.status}`);
  const md = await resp.text();

  const entries = new Map();
  // Row: | `model-name` | 1M tokens | <input miss>元 | <input hit>元 | <output>元 |
  const rowRe = /\|\s*`([a-z][\w.-]*)`\s*\|\s*1M\s*tokens\s*\|\s*([\d.]+)元\s*\|\s*([\d.]+)元\s*\|\s*([\d.]+)元\s*\|/g;
  let m;
  while ((m = rowRe.exec(md)) !== null) {
    const name = m[1];
    // StepFun lists audio/image models in the same doc; keep only the text-chat
    // families (step-* numeric versions). Audio models use stepaudio/step-audio.
    if (/^step-\d/.test(name) || name === "step-1flash") {
      entries.set(name, {
        input: Number(m[2]),
        output: Number(m[4]),
        cacheWrite: null,
        cacheRead: Number(m[3]),
      });
    }
  }

  if (entries.size === 0) throw new Error("stepfun: parsed 0 models — markdown format likely changed");
  return { host: HOST, models: Object.fromEntries(entries) };
}
