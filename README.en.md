# Cloud Blanket

[中文说明](README.md)

Turn a DeepSeek chat export into a "blanket": a chat companion that carries someone's memories and way of speaking. A pure static web app, your own API key, no backend, no deployment — just open the link.

**Online:** [open the app](https://yuyuyuyi623.github.io/cloud-blanket/) · **Illustrated tutorial (17 screenshots, Chinese):** [tutorial](https://yuyuyuyi623.github.io/cloud-blanket/tutorial/)

## Feedback & Support

Found a bug? Please [open an issue](https://github.com/yuyuyuyi623/cloud-blanket/issues/new?template=bug_report.yml) (a free GitHub account is required; the [illustrated tutorial](https://yuyuyuyi623.github.io/cloud-blanket/tutorial/) covers most questions). Feature ideas are welcome [here](https://github.com/yuyuyuyi623/cloud-blanket/issues/new?template=feature_request.yml).

> Personal project, single maintainer, replies may be slow. **Issues only** — no WeChat / QQ / email, please.

## What it does

- **Distillation** — Import the ZIP exported from the official DeepSeek app, pick the conversations that really capture that person, and distill them (a few cents, about a minute) into structured memory: persona card, core memories, impressions, diary.
- **Blanket mode** — Chat with the distilled persona. Each turn injects a stable segment (full persona memory, cache-friendly) plus a dynamic segment (topic-relevant memories retrieved by full-text search), so they remember how you met and what you talked about last week.
- **Plain mode** — The upstream chat-demo experience, unchanged: plain chat billed at DeepSeek's official rates straight from your key (no per-message price shown in the UI; the platform dashboard is the source of truth). The two modes never interfere.
- **Your own key** — All requests go straight from your browser to `api.deepseek.com`. The key lives only in your browser; no third-party server is involved.

## Getting started

1. **Get an API key** — [platform.deepseek.com](https://platform.deepseek.com) → sign up, top up, create a key.
2. **Export your chats** — In the official DeepSeek mobile app, Settings → Export chat history. A ZIP arrives in your inbox a few minutes later.
3. **Wrap it up** — Open the app → import the ZIP → select conversations → review the estimate → start distilling.

## Data & privacy

- API key and settings live in `localStorage`; conversations, distilled memory packs and attachments live in `IndexedDB`. Everything stays on your device.
- Clearing browser data means losing the blanket. Export the memory pack first.
- Messages and distillation content are sent only to the API service you configured (DeepSeek by default). No other server is involved.
- The site records **anonymous visit events** (timestamp + page path) so the author knows whether anyone uses it. No IP, no device fingerprint, no keys, no chat content.

## Cost

- Distillation is usage-based; the app shows an estimate before you start.
- Blanket mode benefits from prompt caching: the stable segment is billed at cache-hit prices, so long-term input cost is far below plain chat.

## Development

Node.js 22.12+ and pnpm:

```sh
pnpm install
pnpm dev      # dev server at http://localhost:8090
pnpm build    # static build into dist/
pnpm test     # vitest
pnpm type     # type check
```

Layout: `engine/` (distillation pipeline, FTS retrieval, session parsing — pure TS, UI-agnostic), `src/app` (layout, themes), `src/components` (chat, blanket list, import wizard, settings), `src/services` (API/SSE, chat storage, memory packs).

## Credits & license

Forked from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT License), with distillation and the blanket memory system added on top.

[MIT](LICENSE).
