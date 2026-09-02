// Volcengine (火山方舟 / Doubao) price fetcher.
//
// The pricing doc (volcengine.com/docs/82379/1099320) redirects to the live
// price page and renders client-side; prices appear only after hydration, so we
// render headless and read the tables. There are ~25 tables (grouped by model
// family), each with the header:
//   模型名称 | 条件(千token) | 输入(非音频) 元/百万token | 输入(音频) ... |
//   缓存命中(非音频) 元/百万token | ... | 输出 元/百万token
// Prices are already in 元/百万token (no unit conversion needed). Each model
// has multiple "输入长度 [a, b]" tier rows; we keep the first (lowest tier),
// matching the seed's "take the lowest tier" rule. cache_read comes from the
// "缓存命中(非音频)" column.

import { launchBrowser, parseYuan, readTables } from "./_fetch.mjs";

const HOST = "ark.cn-beijing.volces.com";
const PRICING_PAGE = "https://www.volcengine.com/docs/82379/1099320";

export async function fetchVolcengine() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(PRICING_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
    // The doc page redirects (1099320 → 1544106) and hydrates; wait for tables.
    await page.waitForSelector("table", { timeout: 20000 });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(800);
    }

    // Volcengine's renderer sprinkles U+200B into price cells, which breaks
    // number parsing — readTables(page, true) strips them.
    const tables = await readTables(page, true);

    const entries = {};
    for (const rows of tables) {
      if (rows.length < 2) continue;
      // Identify column indices from the header row.
      const header = rows[0];
      const colName = header.findIndex((h) => /模型名称/.test(h));
      const colInput = header.findIndex((h) => /输入.*非音频|输入(?=.*百万)/.test(h));
      const colOutput = header.findIndex((h) => /输出/.test(h) && /百万/.test(h));
      const colCacheHit = header.findIndex((h) => /缓存命中.*非音频/.test(h));
      if (colName < 0 || colInput < 0 || colOutput < 0) continue;

      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const rawName = (cells[colName] || "").toLowerCase();
        if (!rawName || /doubao/.test(rawName) === false) continue;
        if (entries[rawName]) continue; // already kept the first tier

        const input = parseYuan(cells[colInput]);
        const output = parseYuan(cells[colOutput]);
        const cacheRead = colCacheHit >= 0 ? parseYuan(cells[colCacheHit]) : null;
        if (input == null || output == null) continue;
        entries[rawName] = {
          input,
          output,
          cacheWrite: null,
          cacheRead: cacheRead,
        };
      }
    }

    if (Object.keys(entries).length === 0) {
      throw new Error("volcengine: parsed 0 models — table layout likely changed");
    }
    return { host: HOST, models: entries };
  } finally {
    await browser.close();
  }
}
