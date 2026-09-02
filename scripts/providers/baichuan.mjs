// Baichuan (百川) price fetcher.
//
// The pricing page (platform.baichuan-ai.com/prices) is a client-rendered SPA;
// prices appear only after hydration, so we render it headless and read the
// table. Each model is a row:
//   ["模型调用 Baichuan-M3-Plus", "32k", "00:00 ~ 24:00",
//    "输入：0.005元/千tokens输出：0.009元/千tokens", "备注…"]
// The price cell packs input and output as "输入：X元/千tokens输出：Y元/千tokens".
// Baichuan quotes PER THOUSAND tokens, so we multiply by 1000 to match the
// catalog's per-million-token contract. Rows with a single combined price
// ("包含输入和输出", no separate 输入/输出) are merged-billing models the seed
// rules exclude — we skip them.

import { launchBrowser, readTables } from "./_fetch.mjs";

const HOST = "api.baichuan-ai.com";
const PRICING_PAGE = "https://platform.baichuan-ai.com/prices";
const PER_K_TO_PER_M = 1000; // 元/千token → 元/百万token

// parsePaired pulls "输入：0.005元/千tokens" and "输出：0.009元/千tokens" out of a
// packed price cell. Returns {input, output} in per-million-token units, or null
// when the cell is a single combined price (which the catalog excludes).
function parsePaired(priceCell) {
  const inputM = priceCell.match(/输入[：:]\s*([\d.]+)\s*元/);
  const outputM = priceCell.match(/输出[：:]\s*([\d.]+)\s*元/);
  if (!inputM || !outputM) return null; // merged-billing or unparseable
  return {
    input: Number(inputM[1]) * PER_K_TO_PER_M,
    output: Number(outputM[1]) * PER_K_TO_PER_M,
  };
}

export async function fetchBaichuan() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(PRICING_PAGE, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("table", { timeout: 15000 });
    await page.waitForTimeout(2000);

    const tables = await readTables(page);

    const entries = {};
    for (const rows of tables) {
      for (const cells of rows) {
        // The model-name cell looks like "模型调用 Baichuan-M3-Plus".
        const nameCell = cells.find((c) => /模型调用\s+(Baichuan[\w.-]*)/i.test(c));
        if (!nameCell) continue;
        const name = nameCell.match(/模型调用\s+(Baichuan[\w.-]*)/i)[1];
        // The price cell is the one carrying 输入/输出 (or a combined figure).
        const priceCell = cells.find((c) => /元\/千tokens|元\/千token/.test(c));
        if (!priceCell) continue;
        const paired = parsePaired(priceCell);
        if (!paired) continue; // merged-billing model, excluded by seed rules
        entries[name.toLowerCase()] = {
          input: paired.input,
          output: paired.output,
          cacheWrite: null,
          cacheRead: null,
        };
      }
    }

    if (Object.keys(entries).length === 0) {
      throw new Error("baichuan: parsed 0 models — table layout likely changed");
    }
    return { host: HOST, models: entries };
  } finally {
    await browser.close();
  }
}
