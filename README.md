# yolorouter price catalog

Daily-refreshed catalog of chat-model prices, in **CNY per million tokens**,
for 9 Chinese AI providers. [yolorouter](https://github.com/yolorouter/yolorouter)
uses it as the data behind its price-prefill suggestions when an admin adds or
imports models — and it is a plain JSON file, so anyone else can consume it too.

A GitHub Action refreshes `catalog.json` once a day (02:00 CST) by hitting each
provider's server-side data endpoint — no rendered scraping where a structured
endpoint exists. Price corrections via PR are welcome; `npm run validate` must
pass.

## The data

`catalog.json`:

```json
{
  "updated_at": "2026-09-01",
  "currency": "CNY",
  "unit": "per_million_tokens",
  "prices": {
    "api.deepseek.com": {
      "deepseek-v4-pro": {
        "input": 1.5,
        "output": 4.5,
        "cache_write": null,
        "cache_read": 0.05
      }
    }
  }
}
```

- **Host keys are bare hosts** of the provider's OpenAI-compatible `base_url`
  (no scheme, no path) — this is how the consumer matches a configured provider.
- **Prices are the provider's own prices**, including aggregators' resale
  prices; the same model under different hosts can legitimately differ.
- **Chat models only**, billed per token. Image/video/audio/embedding/rerank
  models are out — they bill per asset/second/character and would not fit an
  input/output token shape.
- **Tiered pricing takes the lowest tier** (the common short-input case).
- **Cache slots are `null` when the provider publishes no cache fee** — never
  guessed. `cache_write` only exists where a provider charges an explicit
  cache-write fee.
- **Key casing is snake_case** (`cache_write`/`cache_read`). The Go consumer's
  struct tags are snake_case and it silently zero-fills on a casing mismatch,
  so the validator hard-rejects camelCase keys.

## Using it

**From yolorouter:** instances fetch the catalog through their background
refresh loop, from the endpoint configured at `price_catalog.endpoint`
(default: `https://prices.yolorouter.com/catalog.json`, served by a small
Cloudflare Worker). Self-hosted alternatives:

- jsDelivr CDN (works in mainland China, ~12h cache):
  `https://cdn.jsdelivr.net/gh/yolorouter/price-catalog@main/catalog.json`
- GitHub raw:
  `https://raw.githubusercontent.com/yolorouter/price-catalog/main/catalog.json`
- Any static file you host yourself — or set the endpoint to `""` to disable
  live refresh and rely on the embedded seed shipped in the binary.

**As a dataset:** the file is plain JSON under CC0 (see Licensing). Treat
`updated_at` as the freshness marker.

## Sources

Each fetcher targets the pricing page's own data endpoint, not a rendered page:

| Host | Provider | Endpoint type |
|------|----------|---------------|
| `api.siliconflow.cn` | SiliconFlow | RSC stream (`text/x-component`) |
| `api.minimaxi.com` | MiniMax | Mintlify markdown |
| `api.stepfun.com` | StepFun | Mintlify markdown |
| `api.moonshot.cn` | Kimi/Moonshot | Mintlify markdown (per-model pages) |
| `api.deepseek.com` | DeepSeek | Docusaurus SSR HTML (headless) |
| `open.bigmodel.cn` | Zhipu | SPA JS bundle |
| `dashscope.aliyuncs.com` | Qwen/Alibaba | SSR HTML table |
| `api.baichuan-ai.com` | Baichuan | rendered page (headless; 元/千token ×1000) |
| `ark.cn-beijing.volces.com` | Volcengine | rendered page (headless) |

A provider that fails on a given day keeps its previous entries (best-effort
refresh) — check the latest [workflow run](../../actions) for per-provider
status.

## Running locally

```bash
npm install playwright && npx playwright install --with-deps chromium
node scripts/refresh.mjs /tmp/cat.json   # fetch + normalize + write
node scripts/validate.mjs /tmp/cat.json  # contract check (also runs in CI)
```

## Licensing

- **Data (`catalog.json`): [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)** —
  use it for anything, no attribution required.
- **Code (fetchers, validator, workflow): [Apache-2.0](./LICENSE)**
