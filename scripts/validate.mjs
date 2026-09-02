// Price catalog contract validator.
//
// Validates catalog.json against the contract the Go consumer (yolorouter's
// pricecatalog package) enforces at load time: CNY / per_million_tokens, a
// YYYY-MM-DD updated_at, bare-host keys, and snake_case price slots. The Go
// side re-validates on load, but by then a bad file has already been
// committed and shipped — this runs BEFORE the commit lands, so a contract
// break fails the workflow instead of the consumers.
//
// Hard failures (exit 1): structural violations — wrong currency/unit/date,
// empty or malformed keys, non-bare hosts, missing/NaN input/output prices,
// camelCase cache keys (the Go reader zero-fills those to nil silently).
// Warnings (exit 0): suspicious-but-possible figures, e.g. a cache_read at or
// above the input price — worth a human glance, not worth blocking a refresh.

import { readFileSync } from "node:fs";

const ALLOWED_SLOTS = new Set(["input", "output", "cache_write", "cache_read"]);

function fail(violations, msg) {
  violations.push(msg);
}

function main() {
  const catalogPath = process.argv[2] || "catalog.json";
  // Strip a leading UTF-8 BOM the same way the Go loader does.
  const raw = readFileSync(catalogPath, "utf8").replace(/^\uFEFF/, "");

  const violations = [];
  const warnings = [];
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (e) {
    console.error(`✗ ${catalogPath}: not valid JSON — ${e.message}`);
    process.exit(1);
  }

  if (typeof catalog.updated_at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.updated_at)) {
    fail(violations, `updated_at must be YYYY-MM-DD, got ${JSON.stringify(catalog.updated_at)}`);
  } else {
    // V8's Date.parse accepts impossible dates by rolling over (2026-02-30 →
    // March), while the Go reader's time.Parse rejects them — round-trip the
    // components so this gate rejects exactly what the consumer would.
    const [y, mo, da] = catalog.updated_at.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, da));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) {
      fail(violations, `updated_at is not a real calendar date: ${catalog.updated_at}`);
    }
  }
  if (catalog.currency !== "CNY") fail(violations, `currency must be "CNY", got ${JSON.stringify(catalog.currency)}`);
  if (catalog.unit !== "per_million_tokens") fail(violations, `unit must be "per_million_tokens", got ${JSON.stringify(catalog.unit)}`);

  const prices = catalog.prices;
  if (typeof prices !== "object" || prices === null || Array.isArray(prices)) {
    fail(violations, "prices must be a non-empty object keyed by host");
  } else if (Object.keys(prices).length === 0) {
    fail(violations, "prices is empty — every host was dropped");
  } else {
    // Two keys that normalize alike (scheme/port/case on hosts, case on model
    // names) would make the Go reader's lookup depend on map iteration order —
    // buildIndex rejects them, so this gate must too. JSON parsing already
    // dedupes identical raw keys; this catches only distinct-raw collisions.
    const seenHosts = new Map();
    for (const [host, models] of Object.entries(prices)) {
      const normHost = host
        .trim()
        .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
        .split("/")[0]
        .replace(/:\d+$/, "")
        .toLowerCase();
      const priorHost = seenHosts.get(normHost);
      if (priorHost !== undefined && priorHost !== host) {
        fail(violations, `two host keys normalize alike: ${JSON.stringify(priorHost)} and ${JSON.stringify(host)}`);
      } else if (priorHost === undefined) {
        seenHosts.set(normHost, host);
      }
      if (!host.trim()) fail(violations, "empty host key");
      if (host.includes("://") || host.includes("/")) {
        fail(violations, `host key must be a bare host (no scheme/path), got ${JSON.stringify(host)}`);
      }
      if (typeof models !== "object" || models === null || Array.isArray(models)) {
        fail(violations, `${host}: models must be an object`);
        continue;
      }
      if (Object.keys(models).length === 0) fail(violations, `${host}: no models`);
      const seenModels = new Set();
      for (const [name, p] of Object.entries(models)) {
        const where = `${host}/${name}`;
        const normModel = name.trim().toLowerCase();
        if (!name.trim()) fail(violations, `${host}: empty model key`);
        else if (seenModels.has(normModel)) {
          fail(violations, `${host}: two model keys normalize alike to ${JSON.stringify(normModel)}`);
        } else {
          seenModels.add(normModel);
        }
        if (typeof p !== "object" || p === null || Array.isArray(p)) {
          fail(violations, `${where}: price must be an object`);
          continue;
        }
        // The exact regression this guards: a camelCase cache key parses fine
        // but the Go reader's snake_case struct tags never see it, so every
        // cache price silently becomes nil.
        if ("cacheWrite" in p || "cacheRead" in p) {
          fail(violations, `${where}: camelCase cache key — the contract is cache_write/cache_read`);
        }
        for (const k of Object.keys(p)) {
          if (!ALLOWED_SLOTS.has(k)) fail(violations, `${where}: unknown slot ${JSON.stringify(k)}`);
        }
        for (const k of ["input", "output"]) {
          const v = p[k];
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
            fail(violations, `${where}: ${k} must be a finite number >= 0, got ${JSON.stringify(v)}`);
          }
        }
        if ((p.input ?? 0) === 0 && (p.output ?? 0) === 0) {
          fail(violations, `${where}: input and output both zero`);
        }
        for (const k of ["cache_write", "cache_read"]) {
          // Absent ≡ null ≡ the Go reader's nil pointer — only reject values
          // that are present and not a finite non-negative number.
          const v = p[k];
          if (v != null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
            fail(violations, `${where}: ${k} must be null or a finite number >= 0, got ${JSON.stringify(v)}`);
          }
        }
        if (typeof p.cache_read === "number" && typeof p.input === "number" && p.cache_read >= p.input) {
          warnings.push(`${where}: cache_read (${p.cache_read}) >= input (${p.input}) — plausible?`);
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`✗ ${catalogPath}: ${violations.length} contract violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  for (const w of warnings) console.warn(`  ! ${w}`);
  const hosts = Object.keys(prices || {}).length;
  const models = Object.values(prices || {}).reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`✓ ${catalogPath}: ${models} models across ${hosts} hosts pass the contract` +
    (warnings.length ? ` (${warnings.length} warning(s))` : ""));
}

main();
