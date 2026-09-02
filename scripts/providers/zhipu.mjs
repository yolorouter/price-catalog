// Zhipu (智谱 / BigModel) price fetcher.
//
// Zhipu's pricing page (https://open.bigmodel.cn/pricing) is a Vue SPA. Unlike
// SiliconFlow, the current-model prices (GLM-5.x) are NOT behind a JSON API —
// the older operation/query endpoint carries only legacy GLM-4 models billed
// per-thousand-tokens. The GLM-5.x price table is HARDCODED in the app's main
// JS bundle as a `modelList` array:
//
//   {name:"GLM-5.2", inPrice:["8元"], outPrice:["28元"], hit:["2元"], ...}
//
// inPrice/outPrice are CNY per million tokens (verified against the existing
// catalog: GLM-5.2 = 8/28 matches); `hit` is the cache-read price. The bundle
// filename is hashed (app.<hash>.js), so we first fetch the pricing page HTML
// to discover the current bundle URL, then fetch and parse that.
//
// This is inherently more brittle than a real API (a Zhipu frontend rebuild can
// reshuffle the bundle), but the daily cron + failure-email bounds staleness,
// and the embedded seed covers any gap.

import { fetchWithTimeout } from "./_fetch.mjs";

const HOST = "open.bigmodel.cn";
const PRICING_PAGE = "https://open.bigmodel.cn/pricing";

function numFromYuan(s) {
  // "8元" / "0.5元" / "限时免费" → number or null
  const m = String(s).match(/([\d.]+)\s*元/);
  return m ? Number(m[1]) : null;
}

export async function fetchZhipu() {
  const pageResp = await fetchWithTimeout(PRICING_PAGE);
  if (!pageResp.ok) throw new Error(`zhipu page: HTTP ${pageResp.status}`);
  const html = await pageResp.text();

  // Discover the hashed app bundle URL. Zhipu emits a script tag like
  //   <script src="/wd-paas-front/js/app.<hash>.js">
  const appMatch = html.match(/\/wd-paas-front\/js\/app\.[a-f0-9]+\.js/);
  if (!appMatch) {
    throw new Error("zhipu: could not find app bundle URL in pricing page HTML");
  }
  const bundleUrl = "https://static.bigmodel.cn" + appMatch[0];

  const jsResp = await fetchWithTimeout(bundleUrl);
  if (!jsResp.ok) throw new Error(`zhipu bundle: HTTP ${jsResp.status}`);
  const js = await jsResp.text();

  // Locate the price table. It's the modelList immediately following the
  // "输入单价","输出单价",...,"缓存命中" thead. Anchor on that thead so we
  // grab the right one of several modelList arrays in the bundle.
  const anchor = js.indexOf('"输入单价"');
  if (anchor < 0) {
    throw new Error("zhipu: price-table thead anchor not found in bundle (frontend rebuilt?)");
  }
  const after = js.slice(anchor);
  const listMatch = after.match(/modelList:\[(?:\{[^}]*\},?)+\]/);
  if (!listMatch) {
    throw new Error("zhipu: modelList array not found after thead anchor");
  }

  // Parse the modelList entries. Each looks like:
  //   {name:"GLM-5.2",...,inPrice:["8元"],outPrice:["28元"],...,hit:["2元"],...}
  // Rows with empty name are tier continuations of the previous named model
  // (e.g. GLM-5.1 has [0,32k) and [32k+) tiers). We keep the FIRST tier per
  // named model (the seed's "take the lowest tier" rule).
  const entries = new Map();
  const rowRe = /\{[^{}]*name:"([^"]*)"[^{}]*inPrice:\[([^\]]*)\][^{}]*outPrice:\[([^\]]*)\][^{}]*hit:\[([^\]]*)\][^{}]*\}/g;
  let m;
  while ((m = rowRe.exec(listMatch[0])) !== null) {
    const name = m[1];
    if (!name) continue; // tier-continuation row, skip (keeps first tier)
    const input = numFromYuan(m[2]);
    const output = numFromYuan(m[3]);
    const cacheRead = numFromYuan(m[4]);
    if (input == null || output == null) continue;
    if (!entries.has(name.toLowerCase())) {
      entries.set(name.toLowerCase(), {
        input,
        output,
        cacheWrite: null,
        cacheRead: cacheRead,
      });
    }
  }

  if (entries.size === 0) {
    throw new Error("zhipu: parsed 0 models — bundle modelList format likely changed");
  }
  return { host: HOST, models: Object.fromEntries(entries) };
}
