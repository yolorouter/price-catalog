// Shared fetch helper for price-catalog providers.
//
// Node's global fetch() has NO default timeout. A provider endpoint that hangs
// (slow DNS, a stalled connection) would block the whole daily refresh forever
// — neither failing (so the workflow emails the owner) nor completing. This
// wraps fetch with a hard timeout via AbortSignal.timeout, turning a hang into
// a fetch failure the per-provider error path already handles. 30s is generous
// for an ~8 KB JSON / markdown page and tight enough that a stuck endpoint
// surfaces within the workflow's overall budget.

const DEFAULT_TIMEOUT_MS = 30000;

export function fetchWithTimeout(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  return fetch(url, {
    headers: { "User-Agent": "yolorouter-price-catalog/1.0", ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// parseYuan pulls the leading number off a cell like "8元" / "0.02元". Shared
// here so the six providers that need it don't each redefine it.
export function parseYuan(cell) {
  const m = String(cell).match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

// launchBrowser starts a headless chromium for the providers that render their
// prices client-side (DeepSeek/Baichuan/Volcengine). It prefers the system
// Chrome so the fetcher works without `npx playwright install` locally, and
// falls back to the bundled chromium on CI runners. Centralising this here keeps
// the three providers from each carrying the same try-channel-then-fallback
// boilerplate.
export async function launchBrowser() {
  const { chromium } = await import("playwright");
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

// readTables extracts every <table> on the page as rows-of-cells (text content,
// trimmed), so the three headless fetchers don't each re-spell the same
// page.evaluate(() => [...querySelectorAll("table")]...). stripZeroWidth (default
// false) also removes U+200B, which Volcengine's renderer sprinkles into price
// cells and which breaks number parsing. Returns one array of rows per table.
export async function readTables(page, stripZeroWidth = false) {
  return page.evaluate((zw) => {
    const strip = zw ? /[\u200b]/g : null;
    return [...document.querySelectorAll("table")].map((t) =>
      [...t.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("td,th")].map((td) => {
          const s = (td.textContent || "").trim();
          return strip ? s.replace(strip, "") : s;
        }),
      ),
    );
  }, stripZeroWidth);
}
