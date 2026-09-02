// Qwen (通义千问 / 阿里百炼) price fetcher.
//
// The pricing page (help.aliyun.com/zh/model-studio/model-pricing) is server-
// side rendered — the full table ships in the initial HTML (~3 MB), no JS
// needed. The page is a SEQUENCE of independent tables, one per model family,
// and critically: NOT all tables share the same column layout. A single page
// carries ~8 distinct header shapes — some tables have a 模式 column, some a
// 服务部署范围 (region) column, some a token-range column — so the input and
// output price columns sit at different indices in different tables.
//
// The only reliable way to align is to read each table's OWN header and locate
// the 输入单价 / 输出单价 columns by their header text, then index into data
// rows at those positions. Taking "the first two N元 cells" (the old approach)
// mis-aligns across header shapes and even grabbed year strings from dated
// model IDs as "prices".
//
// We only collect DOMESTIC prices: rows whose region is 全球 or that carry no
// region at all. 国际 / 美国 / 欧盟 rows are premium regional pricing and are
// dropped — the catalog is keyed to the China baseline.
//
// Omni (multimodal) tables add a second sub-header row under the main one that
// names the modality of each price column (文本 / 音频 / 图片视频). The catalog
// records text-chat prices only, so for those tables we pick the 文本 columns.

import { fetchWithTimeout, parseYuan } from "./_fetch.mjs";

const HOST = "dashscope.aliyuncs.com";
const PRICING_PAGE = "https://help.aliyun.com/zh/model-studio/model-pricing";

// Domestic-only: these region labels mark premium international rows we drop.
const FOREIGN_REGIONS = /^(国际|美国|欧盟)$/;

// canonicalName collapses alias qualifiers so the many dated/preview snapshots
// the page lists all fold onto one catalog entry:
//   qwen3.7-max-2026-06-08 → qwen3.7-max
//   qwen-plus-2025-12-01-us → qwen-plus  (the -us suffix is an intl variant)
//   qwen-omni-turbo-latest → qwen-omni-turbo
function canonicalName(versionName) {
  return versionName
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, "") // dated snapshot
    .replace(/-us$/, "")                 // intl-only variant suffix
    .replace(/-latest$/, "")             // rolling alias
    .replace(/-preview$/, "")            // preview variant
    .trim();
}

// extractId pulls the leading qwen model id out of a name cell. The page glues
// Chinese promo notes AND the word "Batch" (a billing-mode tag) into the same
// cell as the id, e.g. "qwen3.8-maxBatch调用半价上下文缓存享有折扣". The newest
// flagship (qwen3.8-max) ONLY appears in these glued cells. We lowercase, then
// capture the id up to the first CJK character OR the literal "batch" tag, then
// strip a trailing "-batch" the tag leaves behind. No /i flag on the id match:
// it would make the CJK lookahead match ASCII letters too and truncate at the
// first letter after "qwen".
function extractId(nameCell) {
  const raw = String(nameCell)
    .toLowerCase()
    // "qwen3.8-maxBatch调用…" → stop the id at "batch" (lowercased) regardless
    // of whether CJK notes follow it.
    .replace(/batch/, "\u4e00batch")
    .match(/^(qwen[a-z0-9.\-]*?)(?=[\u4e00-\u9fff]|$)/);
  if (!raw) return null;
  return raw[1].replace(/-batch$/, "");
}

// parseRows walks every <tr>, tracking the most recent header row to know which
// columns hold input/output prices for the table the current row belongs to.
export async function fetchQwen() {
  const resp = await fetchWithTimeout(PRICING_PAGE);
  if (!resp.ok) throw new Error(`qwen: HTTP ${resp.status}`);
  const html = await resp.text();

  const rows = parseRows(html);

  const entries = new Map();
  let cols = null; // {input: number, output: number, region: number|null} for current table

  for (const cells of rows) {
    // A header row's first cell always starts with "模型 ID". It defines the
    // column layout for the rows that follow, so recompute cols here.
    if (/^模型\s*ID/i.test(cells[0])) {
      cols = locateColumns(cells);
      continue;
    }
    if (!cols) continue; // rows before any header (page chrome) — ignore

    // Skip sub-header rows inside omni tables: their cells are modality labels
    // (文本/音频/图片视频) rather than prices. They carry no qwen id and no N元.
    if (!cells.some((c) => /元/.test(c))) continue;

    const nameCell = cells.find((c) => /qwen/i.test(c));
    if (!nameCell) continue;
    const id = extractId(nameCell);
    if (!id) continue;

    const name = canonicalName(id);
    if (!name || !/^qwen/.test(name)) continue;

    // Region filter: drop 国际/美国/欧盟 rows. Region is whichever cell matches
    // the set; a 全球 cell or no region cell at all is domestic and kept.
    if (cols.region != null && FOREIGN_REGIONS.test(cells[cols.region] || "")) continue;

    if (entries.has(name)) continue; // first domestic row wins; later tiers skipped

    const input = parseYuan(cells[cols.input] || "");
    const output = parseYuan(cells[cols.output] || "");
    if (input == null || output == null) continue;

    entries.set(name, { input, output, cacheWrite: null, cacheRead: null });
  }

  if (entries.size === 0) {
    throw new Error("qwen: parsed 0 models — HTML table structure likely changed");
  }
  return { host: HOST, models: Object.fromEntries(entries) };
}

// parseRows extracts every <tr> as an array of stripped cell strings.
function parseRows(html) {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
  const stripTags = (s) =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/\s+/g, " ")
      .trim();

  const rows = [];
  let rm;
  while ((rm = rowRe.exec(html)) !== null) {
    const cells = [];
    let cm;
    const inner = rm[1];
    while ((cm = cellRe.exec(inner)) !== null) {
      cells.push(stripTags(cm[1]));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

// locateColumns reads a header row and returns the column indices for input
// price, output price, and the region column (null if the table has none).
// Header cells are matched by text: the one containing 输入单价 is inputCol,
// 输出单价 is outputCol. The region column, when present, is the one whose
// header is exactly 服务部署范围.
function locateColumns(headerCells) {
  let input = -1;
  let output = -1;
  let region = null;
  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i];
    if (input === -1 && /输入单价/.test(h)) input = i;
    if (output === -1 && /输出单价/.test(h)) output = i;
    if (region === null && /^服务部署范围/.test(h)) region = i;
  }
  if (input === -1 || output === -1) return null; // unrecognized header shape
  return { input, output, region };
}
