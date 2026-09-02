// DeepSeek price fetcher.
//
// DeepSeek's pricing page (api-docs.deepseek.com) is a Docusaurus SPA. The
// prices are NOT in the initial HTML and NOT behind any JSON API — they are
// compiled into a JSX table inside a hashed JS chunk, rendered only at runtime.
// Parsing the JSX source by position is brittle (the table layout reshuffles on
// every doc revision), so we render the page in a headless browser and read the
// table cells by their visible labels instead.
//
// Rendered table layout (verified Aug 2026), column-aligned across rows:
//   row 0:  ["模型",                "deepseek-v4-flash", "deepseek-v4-pro"]
//   row N:  ["百万tokens输入（缓存命中）",   "0.02元",            "0.025元"]     ← cache_read
//   row N+1:["百万tokens输入（缓存未命中）", "1元",               "3元"]         ← input
//   row N+2:["百万tokens输出",              "2元",               "6元"]         ← output
// Each model occupies one column; the price rows carry that model's value in
// the SAME column index as its name in the header row.

const HOST = "api.deepseek.com";
import { launchBrowser, parseYuan, readTables } from "./_fetch.mjs";

const PRICING_PAGE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";

// priceCells extracts just the price cells (those containing 元) from a row, in
// order. DeepSeek's price rows mix label cells and price cells with inconsistent
// column counts (rowspan/colspan makes absolute column indices unreliable), so
// we align by "the Nth price cell = the Nth model" rather than by column index.
function priceCells(row) {
  if (!row) return [];
  return row
    .filter((c) => /[\d.]+\s*元/.test(c || ""))
    .map((c) => parseYuan(c));
}

export async function fetchDeepSeek() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(PRICING_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("table", { timeout: 15000 });
    await page.waitForTimeout(2000); // let Docusaurus hydrate the table

    // DeepSeek renders a single pricing table; readTables returns all tables,
    // so take the first. An empty list means the page didn't hydrate in time.
    const allTables = await readTables(page);
    const rows = allTables[0];
    if (!rows || rows.length === 0) throw new Error("deepseek: no table found");

    // Header row: the one carrying the canonical model ids. Collect them in
    // left-to-right order; the Nth price cell in each price row pairs with the
    // Nth model here.
    const header = rows.find((r) => r.some((c) => /^deepseek-v/.test(c)));
    if (!header) throw new Error("deepseek: model header row not found");
    const modelNames = header
      .map((c) => (c || "").trim().toLowerCase())
      .filter((c) => /^deepseek-v/.test(c));

    const cacheHitRow = rows.find((r) => r.some((c) => /缓存命中|cache.*hit/i.test(c || "")));
    const inputRow = rows.find((r) => r.some((c) => /缓存未命中|cache.*miss/i.test(c || "")));
    const outputRow = rows.find((r) => r.some((c) => /tokens.*输出|百万.*输出/.test(c || "")));

    const inputs = priceCells(inputRow);
    const outputs = priceCells(outputRow);
    const cacheReads = priceCells(cacheHitRow);

    const entries = {};
    for (let i = 0; i < modelNames.length; i++) {
      const input = inputs[i] ?? null;
      const output = outputs[i] ?? null;
      const cacheRead = cacheReads[i] ?? null;
      if (input == null && output == null) continue;
      entries[modelNames[i]] = {
        input: input ?? 0,
        output: output ?? 0,
        cacheWrite: null,
        cacheRead: cacheRead,
      };
    }

    if (Object.keys(entries).length === 0) {
      throw new Error("deepseek: parsed 0 models — table layout likely changed");
    }
    return { host: HOST, models: entries };
  } finally {
    await browser.close();
  }
}
