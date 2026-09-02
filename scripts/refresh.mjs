// Price catalog refresh — main entry.
//
// Fetches each provider's current prices, normalizes them against the catalog's
// contract (CNY / per_million_tokens, chat models only), merges into the shape
// catalog.json expects, and writes the file. Designed to run in a GitHub Action
// cron daily (see .github/workflows/refresh.yml).
//
// Design notes:
//   - Each provider fetcher returns { host, models: { name: {input,output,...} } }.
//     Its ONLY job is to faithfully extract numbers; it does not decide what
//     belongs in the catalog. That decision lives here, once, so the rules
//     (drop audio/image/embedding, drop Pro variants, drop snapshot dates, drop
//     zero prices) apply uniformly across providers.
//   - A provider THROWING is caught and treated like returning {}: that host
//     keeps its existing entries and the run continues. Several providers sit
//     on domestic domains intermittently unreachable from the CI runner, so
//     aborting the whole run on one transient failure would make the cron
//     fail constantly. The cost is a silently stale host if a fetcher fails
//     persistently — the failure is logged (with cause chain) but not fatal.
//   - Fetchers report cache fees with camelCase keys (cacheWrite/cacheRead)
//     internally; the catalog's JSON contract is snake_case because the Go
//     reader's struct tags are snake_case and encoding/json silently zero-fills
//     on a casing mismatch. The rename happens once, at the normalize()
//     chokepoint, and a write-time check rejects any camelCase key that slips
//     through (including ones carried over from a stale catalog on disk).

import { readFileSync, writeFileSync } from "node:fs";
import { fetchSiliconFlow } from "./providers/siliconflow.mjs";
import { fetchMiniMax } from "./providers/minimax.mjs";
import { fetchStepFun } from "./providers/stepfun.mjs";
import { fetchKimi } from "./providers/kimi.mjs";
import { fetchDeepSeek } from "./providers/deepseek.mjs";
import { fetchZhipu } from "./providers/zhipu.mjs";
import { fetchQwen } from "./providers/qwen.mjs";
import { fetchBaichuan } from "./providers/baichuan.mjs";
import { fetchVolcengine } from "./providers/volcengine.mjs";

const PROVIDERS = [
  { name: "siliconflow", fn: fetchSiliconFlow },
  { name: "minimax", fn: fetchMiniMax },
  { name: "stepfun", fn: fetchStepFun },
  { name: "kimi", fn: fetchKimi },
  { name: "deepseek", fn: fetchDeepSeek },
  { name: "zhipu", fn: fetchZhipu },
  { name: "qwen", fn: fetchQwen },
  { name: "baichuan", fn: fetchBaichuan },
  { name: "volcengine", fn: fetchVolcengine },
];

// Providers whose every model is a chat model keyed by the provider's own host.
// Non-chat models (image/video/audio/embedding/rerank) leak into several docs;
// this is the single chokepoint that keeps them out of a token-billed catalog.
const NON_CHAT_HINTS = [
  "image", "vision", "video", "audio", "tts", "asr", "voice",
  "embed", "rerank", "vl-", "-vl", "ocr", "speech", "dalle", "sora",
  "hailuo", // MiniMax's image/video family, billed per asset not per token
  "omni",   // multimodal (text+audio+video); per-token text price isn't its real billing unit
  "realtime", // streaming voice / live-translation realtime SKUs, not chat completions
];

function looksLikeChatModel(name) {
  const lower = name.toLowerCase();
  return !NON_CHAT_HINTS.some((h) => lower.includes(h));
}

// Drop redundant variants the catalog's rules exclude: Pro-tier prefixes,
// date-stamped snapshots (both -YYYY-MM-DD and the shorter -MMDD/-YYMM forms
// some providers like StepFun use, e.g. step-3.5-flash-2603), and
// overseas/character variants.
function isRedundantVariant(name) {
  return (
    name.startsWith("Pro/") ||
    /-\d{4}-\d{2}-\d{2}$/.test(name) || // -YYYY-MM-DD
    /-\d{4}$/.test(name) || // -MMDD / -YYMM short snapshot (e.g. -2603)
    /-(us|character)$/i.test(name)
  );
}

function normalize(providerResult) {
  const out = {};
  for (const [name, price] of Object.entries(providerResult.models)) {
    if (!looksLikeChatModel(name)) continue;
    if (isRedundantVariant(name)) continue;
    // A zero/negative price is a free-tier marker or a parse artifact, not a
    // billable per-million figure. Skip rather than emit a misleading 0.
    if (price.input <= 0 && price.output <= 0) continue;
    out[name] = {
      input: price.input,
      output: price.output,
      cache_write: price.cacheWrite ?? null,
      cache_read: price.cacheRead ?? null,
    };
  }
  return out;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const catalogPath = process.argv[2] || "catalog.json";

  // Read the existing catalog so a fetcher returning 0 models (page layout
  // changed, every row filtered) keeps that host's prior entries instead of
  // wiping them. A full overwrite would drop the carried-over prices for any
  // host that fails this run, breaking it until the fetcher is fixed.
  const existing = JSON.parse(readFileSync(catalogPath, "utf8"));

  const prices = { ...existing.prices };
  const refreshedHosts = new Set();
  const report = [];
  let totalModels = 0;

  for (const p of PROVIDERS) {
    try {
      const result = await p.fn();
      const normalized = normalize(result);
      const count = Object.keys(normalized).length;
      // A provider returning no models (page layout changed, or every row got
      // filtered) must NOT wipe the host's existing entries. Overwriting with
      // {} would drop that host's carried-over prices, breaking it until the
      // fetcher is fixed — the opposite of "preserve what we have". Skip the
      // assignment instead, so the host keeps its prior entries and the report
      // flags it.
      if (count === 0) {
        report.push(`  · ${p.name.padEnd(12)}   0 models  (${result.host}) — kept existing entries`);
        continue;
      }
      prices[result.host] = normalized;
      refreshedHosts.add(result.host);
      totalModels += count;
      report.push(`  ✓ ${p.name.padEnd(12)} ${String(count).padStart(3)} models  (${result.host})`);
    } catch (e) {
      // Best-effort: a provider that fails (network timeout, page layout change,
      // anything) does NOT abort the run. We just keep that host's existing
      // entries and move on, so one unreachable provider can't block the rest.
      // The cost is a silently stale host if a fetcher fails persistently — a
      // trade-off chosen because several providers are on domestic domains
      // intermittently unreachable from the CI runner, and abort-on-failure
      // would make the cron fail constantly for transient reasons. The full
      // cause chain is logged (Node's fetch() rejects with a bare TypeError
      // "fetch failed"; its .cause holds the real reason) so a persistent
      // failure is still visible in the run log.
      console.error(`  ✗ ${p.name}: ${e.message}`);
      for (let c = e.cause; c; c = c.cause) {
        console.error(`      cause: ${c.code || c.name}: ${c.message}`);
      }
      report.push(`  ✗ ${p.name.padEnd(12)} FAILED — kept existing entries`);
    }
  }

  // Hosts present in the existing catalog that no fetcher refreshed this run
  // (a fetcher returned 0 models and was skipped) — their entries are carried
  // over unchanged.
  const preservedHostCount = Object.keys(prices).filter((h) => !refreshedHosts.has(h)).length;

  const catalog = {
    updated_at: todayUTC(),
    currency: "CNY",
    unit: "per_million_tokens",
    prices,
  };

  // Contract self-check before writing: matches the Go reader's buildIndex
  // validation (currency/unit/date), so a bug here surfaces as a CI failure
  // rather than a runtime load error in every consumer.
  if (catalog.currency !== "CNY") throw new Error("currency contract violation");
  if (catalog.unit !== "per_million_tokens") throw new Error("unit contract violation");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(catalog.updated_at)) throw new Error("updated_at format violation");

  // Key casing is part of the contract: the Go reader's struct tags are
  // snake_case and encoding/json silently zero-fills on mismatch, so a
  // camelCase cache key means every cache price quietly disappears downstream.
  // This also catches keys carried over from a stale on-disk catalog.
  for (const [host, models] of Object.entries(catalog.prices)) {
    for (const [name, p] of Object.entries(models)) {
      if ("cacheWrite" in p || "cacheRead" in p) {
        throw new Error(`camelCase price key violation at ${host}/${name}`);
      }
    }
  }

  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

  console.log("price catalog refreshed:");
  for (const line of report) console.log(line);
  console.log(`  total: ${totalModels} models across ${PROVIDERS.length} refreshed hosts`);
  if (preservedHostCount > 0) {
    console.log(`  preserved: ${preservedHostCount} hosts returned 0 models and kept their prior entries`);
  }
  console.log(`  wrote: ${catalogPath} (updated_at ${catalog.updated_at})`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
