# CONTRACT — dsh-subscription-sim

Shared implementation contract for the Host half (`index.js` + `lib/`), the Client half (`client.js`),
and verification (`test/`). **Do not change this contract unilaterally**: if an API or shape must change,
message the Lead first so the other half and the tests are updated together.

Workspace package dir: the repository root (checked out anywhere)
Installed by the Lead through `plugin_manager install_bundle` (never install it yourself).

Reference implementation to copy patterns from (same profile, already working):
`a local reference plugin (not part of this repository)` (Host: web route + tool) and
`a local reference plugin (not part of this repository)` (Client: `window.__ModuleLoader__`,
`slots.inject/register`, `locale.register`, fetch ROUTE, sidebar footer action + shell.overlay panel).

---

## 1. What the product does

DeepSeek has no subscription. This plugin pretends it does, in the current DSH Web UI:

- Four preset "plans" copied from the current OpenAI / Anthropic consumer tiers (Free, Plus/Pro,
  Max 5×, Max 20× / Pro), each mapping to a simulated **token quota per rolling window**.
- Two rolling windows: **5 hours** (`h5`) and **7 days** (`d7`). Either can be enabled on its own;
  at least one must stay enabled. Config can start with only `d7` enabled.
- Every model request in this Harness process consumes quota: input + output tokens recorded from
  the `usage` StreamChunk on the `llm/stream` waterfall. All sessions, subagents and workflow agents
  count against the same account-wide quota.
- When an enabled window is exhausted, the **next real model request fails for real**: the listener
  short-circuits with a terminal `finish` chunk (`kind: 'error'`, code `SUBSCRIPTION_QUOTA`). The user
  sees a genuine turn error and a frame-wide banner offering "use a reset card".
- The user can **issue reset cards to themselves** in the plugin panel (cooldown + inventory limit,
  configurable) and spend a card to clear one window immediately.
- Fully durable: quota state survives restarts in a JSON file; lifetime counters are never cleared by
  cards (cards only clear the window's usage buckets).

## 2. Host state and persistence

State file default: `path.join(process.env.DSH_HOME || ~/.dsh, 'plugin-data', 'dsh-subscription-sim', 'state.json')`.
Config `stateFile` (string) overrides it with an absolute path. Create the directory recursively.
Atomic write: write `<file>.tmp-<pid>-<n>` then `rename`; serialize writes with a promise chain.
Load at activation (`readFileSync`/`readFile` + `JSON.parse`); on missing/corrupt file start fresh
(corrupt file renamed to `<file>.corrupt-<ts>`, warn on console, never throw from activation).
Every mutation is applied in memory synchronously, then persisted (await for user actions, fire-and-forget
serialized save for usage recording). Usage recording must never await disk inside the stream.

Persisted state (version 1):

```js
{
  version: 1,
  plan: 'max20x',                    // preset id or 'custom'
  customLimits: { h5: 0, d7: 0 },    // used when plan === 'custom'
  windows: { h5: true, d7: true },   // enable flags
  settings: { enforce: true, countAuxiliary: true },
  buckets: {                         // minute buckets, sparse, pruned to > 7d + 1h only
    '30123456': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, calls: 0 }
  },
  lifetime: { tokens: 0, input: 0, output: 0, calls: 0, since: 0 }, // never cleared by cards
  cards: 2,
  claimAt: 0,                        // epoch ms of last successful claim
  lastHit: null,                     // { window: 'h5'|'d7', at, seq } — last request actually blocked
  simulateBlock: false,              // diagnostic: block the next request once, then auto-clear
  events: []                         // newest first, max 30: { at, kind, window?, tokens?, message? }
}
```

`events.kind` ∈ `usage` | `claim` | `redeem` | `plan` | `windows` | `settings` | `reset` | `blocked`.
Keep the events log bounded; never put raw prompts/messages into it.

## 3. Plans (simulated quotas — fictional, documented as simulated in UI/README)

```js
const PLAN_PRESETS = [
  { id: 'free',   name: { zh: 'Free 免费',  en: 'Free' },          priceUSD: 0,   limits: { h5: 200_000,     d7: 1_000_000 } },
  { id: 'plus',   name: { zh: 'Plus / Pro', en: 'Plus / Pro' },    priceUSD: 20,  limits: { h5: 1_500_000,   d7: 12_000_000 } },
  { id: 'max5x',  name: { zh: 'Max 5×',     en: 'Max 5×' },        priceUSD: 100, limits: { h5: 5_000_000,   d7: 45_000_000 } },
  { id: 'max20x', name: { zh: 'Max 20× / Pro', en: 'Max 20× / Pro' }, priceUSD: 200, limits: { h5: 18_000_000, d7: 160_000_000 } },
]
```

Default plan is `max20x` (so installing the plugin mid-session cannot lock the operator out).
Plan `custom` uses `customLimits` and is reached by `set-limit`; it has `priceUSD: 0`, name `{zh:'自定义',en:'Custom'}`.
Changing plan keeps bucket usage (limits change, usage does not).

Window definitions: `WINDOW_MS = { h5: 18_000_000, d7: 604_800_000 }`.
`used(window, now)` = sum of bucket `tokens` whose bucket start is `> now - WINDOW_MS[window]`.
Prune buckets with start `<= now - 604_800_000 - 3_600_000` on every mutation.
`resetInMs(window, now)` = `minBucketStartInWindow + WINDOW_MS[window] - now` (null when no bucket).
`percent` = `used / limit * 100`, one decimal, may exceed 100 (display caps the bar width).
`exhausted` = `used >= limit` (also true when `limit <= 0`).

## 4. Client ↔ Host HTTP API

Route: `POST /subscription-sim/api`, JSON body → JSON response. Guard every request with
`ctx.connection.requestRejection(req) !== undefined` → 403 `{ok:false, error:{code:'forbidden',message}}`.
Non-POST → 405. Body limit 64 KiB. `content-type: application/json; charset=utf-8`, `cache-control: no-store`.

Success response for every action except `probe`:

```js
{ ok: true, state: <snapshot> }
```

Failure response (HTTP 200 unless auth/method failure):

```js
{ ok: false, error: { code: '<code>', message: '<zh + en hint>' } }
```

Error codes: `invalid_action` | `invalid_body` | `unknown_plan` | `both_windows_disabled` |
`no_cards` | `claim_cooldown` | `max_held` | `cards_disabled` | `invalid_limit` | `storage_failure`.

### Actions

| action | body | semantics |
|---|---|---|
| `state` | `{}` | read-only snapshot (client polls this) |
| `claim-card` | `{ count?: 1..9 }` | self-issue card(s): +`claimBatch` per request (default 1), capped by `maxHeld`, blocked while `claimCooldownSeconds` remains; records `claim` event |
| `use-card` | `{ window?: 'h5'\|'d7'\|'auto' }` | spend 1 held card to clear one window; `auto` = `lastHit.window` if it is still exhausted, else the enabled window with the highest percent, else `h5`; decrements cards, records `redeem`, clears `lastHit` when no window remains exhausted |
| `set-plan` | `{ planId }` | `free`/`plus`/`max5x`/`max20x`/`custom`; records `plan` |
| `set-windows` | `{ h5?: boolean, d7?: boolean }` | reject when both would be disabled; records `windows` |
| `set-settings` | `{ enforce?: boolean, countAuxiliary?: boolean }` | records `settings` |
| `set-limit` | `{ window: 'h5'\|'d7', tokens: number }` | finite integer 1..2_000_000_000; switches plan to `custom`, keeps the other window's current effective limit; records `plan` |
| `reset-all` | `{}` | clear buckets, lifetime, lastHit, simulateBlock, events; cards → `cards.initialHeld`; keep plan/windows/settings; records `reset` |
| `dismiss-hit` | `{}` | clear `lastHit` (banner goes away; quota stays exhausted) |
| `arm-simulate-block` | `{}` | `simulateBlock = true`: the next model request is blocked once with the same quota failure, then the flag clears and normal requests continue (diagnostic used by verification; not exposed in the UI) |
| `probe` | `{ provider?, model? }` | run one real tiny model call through `ctx.llm.stream()` to prove enforcement end-to-end; returns `{ ok: true, probe: { blocked, failure, chunkTypes, usage, error }, state }` |

Default window for `use-card`: the `latestHitWindow` when set & exhausted, else highest percent.

### Snapshot shape (exact field names the Client uses)

```js
{
  ok: true,
  serverNow: 1790000000000,
  plan: { id, name: { zh, en }, priceUSD, limits: { h5, d7 }, custom: false },
  plans: [ { id, name: { zh, en }, priceUSD, limits: { h5, d7 } } ],  // presets + custom
  windows: {
    h5: { enabled, windowMs, used, limit, remaining, percent, exhausted, resetAt, resetInMs },
    d7: { enabled, windowMs, used, limit, remaining, percent, exhausted, resetAt, resetInMs }
  },
  blocked: false,               // true iff any ENABLED window is exhausted
  blockedWindow: null,          // 'h5' | 'd7' | null — which enabled window blocks (max percent if several)
  settings: { enforce, countAuxiliary, windows: { h5, d7 }, cards: { maxHeld, claimCooldownSeconds, claimBatch, initialHeld } },
  cards: { held, maxHeld, canClaim, cooldownRemainingMs, claimBatch },
  lifetime: { tokens, input, output, calls, since },
  lastHit: null,                // { window, at, seq } | null
  simulateBlock: false,
  events: [ { at, kind, window, tokens, message } ],  // newest first, max 30
  storage: { stateFile, ok, lastError: null },
  version: 1
}
```

`resetAt` = epoch ms when the oldest counted bucket leaves the window, `null` when `used === 0`.

## 5. Enforcement — the one thing that must be exactly right

Host `index.js` registers (this exact form matters; other packages do the same):

```js
ctx.on('llm/stream', (options, next) => {
  // do NOT call next() when blocked
  return (async function* () {
    if (shouldBlock(options)) {
      // record lastHit + blocked event, clear simulateBlock, persist, then:
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'SUBSCRIPTION_QUOTA', status: 429 } } }
      return
    }
    for await (const chunk of next()) {
      if (chunk.type === 'usage') recordUsage(chunk.usage, options)
      yield chunk
    }
  })()
}, { global: true, prepend: true })
```

Rules:

- `shouldBlock(options)`: skip when `settings.enforce === false`; skip auxiliary calls when
  `settings.countAuxiliary === false` and `options.purpose` is defined (`compaction` / `session-title`);
  skip until state finished loading (fail-open at boot). Otherwise block iff `simulateBlock` is true or
  an enabled window is exhausted.
- `recordUsage(usage, options)`: token count = `usage.totalTokens ?? usage.inputTokens + usage.outputTokens`;
  add to the current minute bucket and `lifetime`. Auxiliary calls (`purpose` set) are counted only when
  `settings.countAuxiliary === true` — the same flag gates both counting and blocking, so
  `countAuxiliary:false` means "compaction/session-title calls are free and never blocked".
- Blocked message (bilingual, user-facing, includes window, used/limit, deadline, held cards):
  e.g. `订阅额度已用尽：5 小时窗口 1,500,000 / 1,500,000 tokens。请求已被「订阅额度模拟器」拦截。你还有 2 张重置卡，打开侧边栏「订阅」面板即可使用；额度也会在 2 小时 13 分后自动释放。` +
  newline + `Subscription quota exhausted (5-hour window): model requests are blocked. Use a reset card in the Subscription panel to continue.`
  Build it in host code with `Intl`-free manual formatting. Keep it under ~500 chars total.
- The same wrapper must NOT block `options.purpose === 'session-title'` when `countAuxiliary === false`
  (otherwise session naming breaks while usage-only mode is on).
- Never throw synchronously from the listener; a thrown error would surface as `code: UNKNOWN`.
  The `finish` chunk is the protocol-correct route and keeps the code `SUBSCRIPTION_QUOTA` visible.

## 6. Host files and exports

```
index.js          — export const name; export const inject = ['tools','webServer','connection','llm','agentDefaultModel'];
                    export function apply(ctx, config) { ... }  (may be async; await state load)
                    responsibilities: normalize config, create engine, register llm/stream listener,
                    register the agent tool, register the web route, persist on mutation
lib/plans.js      — PLAN_PRESETS, WINDOW_MS, DEFAULT_CONFIG, normalizeConfig(raw), formatTokens, window helpers (pure)
lib/engine.js     — createEngine({ now, stateFile, config, log }): { ready, snapshot(), recordUsage(), claimCard(),
                    useCard(), setPlan(), setWindows(), setSettings(), setLimit(), resetAll(), dismissHit(),
                    armSimulateBlock(), consumeBlock(), shouldBlock(options), close() } (all pure-ish, no ctx)
lib/format.js     — shared formatting of counts/durations + the bilingual blocked message (pure, unit-testable)
```

Agent tool `subscription_status` (registered with `ctx.tools.register`): read-only snapshot summary.
Parameters `{ verbose?: boolean }`, `output.schema` object, `output.render` → text. It must explain that the
quota is a local simulation and report plan, per-window used/limit/percent/resetIn, cards, enforce state.
Never expose claim/redeem as tools (authority-granting actions stay user-only).

## 7. Client half (`client.js`)

Single plain-JS module: `window.__ModuleLoader__.load({ id: '@local/dsh-subscription-sim', factory(require) { ... } })`.
Only `require('react')`. No imports of Harness client packages. `inject: ['slots', 'locale']`.
Call `ctx.locale.register('subscription-sim', { zh: ZH, en: EN })` inside `ctx.effect` and re-render on
`ctx.locale.subscribe`. All visible text through `ctx.locale.bind('subscription-sim')`
(use the reference plugin's ZH/EN dict pattern). Include styles as React `<style>` elements or a single
injected style tag owned by `ctx.effect` (cleanup on unload); class prefix `dss-`.

Three slot registrations through `ctx.slots.inject(slot, () => ctx.slots.register({...}, Component))`:

1. `sidebar.footer.action` — id `subscription-sim`, order `3`, label `t('sidebarLabel')`.
   Compact chip (sidebar expanded; when the sidebar collapses the host renders the entry in the rail —
   keep it usable at 36px, icon + optional short percent). Click toggles the panel.
   Shows worst enabled window percentage, or a red `!` when exhausted; a tiny card-count badge when cards > 0.
2. `conversation.composer.dock` — id `subscription-sim`, order `6`, label `t('stripLabel')`.
   One thin ambient strip below the composer: plan name, mini progress bars for enabled windows,
   `🎋 n 张重置卡`-style count (SVG icon, no emoji in the shipped UI), exhausted state in error color.
   Clicking any part opens the panel. Hide the strip entirely while there is no snapshot yet.
3. `shell.overlay` — id `subscription-sim`, order `30`, label `t('panelLabel')`.
   Renders (a) the full panel when open, and (b) the exhausted banner when `snapshot.lastHit !== null`
   and the panel is closed.

Polling: one module-level store + `useSyncExternalStore` (copy the reference plugin's store pattern).
`refresh()` = POST `{action:'state'}`; poll every 4000 ms only while `document.visibilityState === 'visible'`,
plus immediately on mount/`visibilitychange`; every mutation action posts and applies `state` from the
response; on network failure keep the last snapshot and mark `offline: true` (show a muted hint, never crash).
Start the poll from `apply` inside `ctx.effect` and clear it on dispose. Do not render before the first
successful snapshot (nothing to show).

Panel content (all strings localized):

- Header: title, plan name + price (e.g. `$20/月`), `模拟订阅` badge, close button.
- Usage section: one card per enabled window (5 小时 / 7 天). Show used / limit tokens, percent, a bar
  (normal `--dsw-alias-brand-primary`, ≥80% `--dsw-alias-state-warn-primary`, exhausted `--dsw-alias-state-error-primary`),
  countdown `额度 X 后自动释放` (or `暂无消耗` / `已用尽`), and the disabled windows as compact "未启用" rows.
- Reset cards: held count, claim button (`+ 领取重置卡`, shows cooldown seconds when unavailable,
  disabled at max), and one `使用重置卡` button whose target window defaults to the blocked/most-used window
  with a small window selector (`5 小时` / `7 天`) when both are enabled. Show the card count as repeated
  small ticket icons (max ~9).
- Plan section: preset rows (name, price, `5h / 7d` simulated limits) with the active one marked;
  clicking sends `set-plan`. A `自定义` row with number inputs + 保存 sends `set-limit` twice if needed.
- Settings: toggles 5h / 7d windows, 拦截请求 (enforce), 统计压缩/标题调用 (countAuxiliary);
  a `重置全部模拟数据` destructive action with inline confirmation (two-step button), not a browser confirm.
- Recent events: compact list of the last ~8 events with localized labels and relative time.
- Footer hint: quota is a local simulation; data file path in a muted monospace note.

Exhausted banner: frame-wide card (bottom-center, above composer, max-width ~520px) with error accent:
title `额度已用尽`, the blocked window + used/limit, auto-release countdown, and buttons:
`使用重置卡（剩 n 张）` (primary; sends `use-card` with the blocking window), `领取重置卡` when claimable,
`稍后` (sends `dismiss-hit`). It must disappear after a successful `use-card`/`reset-all` (host clears lastHit).
Keyboard: Escape dismisses the banner; panel Escape closes, focus trapped in panel, restore focus on close.

Style rules: only the listed `--dsw-alias-*` tokens (bg-base/layer-1/layer-2/overlay, border-l1/l2,
brand-primary, label-primary/secondary, state-error/warn/success/idle-primary, specific-sidebar-fill)
plus geometry tokens already used by host CSS (`--dsw-radius-sm/md`, `--ds-font-family-code`,
`--dsw-focus-ring-*`). No literal colors except inside SVG artwork. Works in light and dark themes.

## 8. Verification split

- Host engineer: `node --check` every file; a quick local run of `lib/` helpers with `node -e` is welcome.
- Client engineer: `node --check client.js`; open no browser; report visual state unverified.
- Verifier (separate teammate): `test/*.mjs` unit tests of `lib/` against this contract (windows,
  buckets, cards, plan switching, simulateBlock, snapshot shape, prune); after the Lead installs,
  live checks via `curl -X POST http://127.0.0.1:3080/subscription-sim/api` (state/claim/use/set-plan/
  set-windows/probe), live slot inspection with `cordis_inspect_query`, and a written report.
  The operator's real quota must never be left exhausted at the end of a check.
- Lead: install, integration, final report.

## 9. Facts already confirmed by inspection (do not re-derive)

- `ctx.on('llm/stream', fn, { global: true, prepend: true })` is the listener form; the waterfall's
  `next()` returns an `AsyncIterable<StreamChunk>`.
- `StreamChunk` usage variant: `{ type: 'usage', usage: TokenUsage }`, `TokenUsage` has
  `inputTokens`, `outputTokens`, `totalTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`.
- `GenerateOptions` has `provider`, `model`, `messages`, `system?`, `tools?`, `purpose?: 'compaction'|'session-title'`, `sessionId?`.
- Web route: `ctx.webServer.register({ kind: 'exact', path, handler: async (req, res) => {} })`; handler owns the response.
- `ctx.connection.requestRejection(req)` returns undefined when admitted.
- Tool registration: `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })`
  (see the reference plugin's `api_usage` tool).
- Client slot catalogue: `sidebar.footer.action` (list, id/order/label), `conversation.composer.dock`
  (list, id/order/label), `shell.overlay` (list, id/order/label), `shell.quota-notice` (chain; not used).
- Client locale: `ctx.locale.register(ns, { zh, en })` + `ctx.locale.bind(ns)`; subscribe to re-render.

---

# v2 — 2026-10-23 用户追加需求（本节覆盖前文冲突部分）

用户要求：① **分清 OpenAI 与 Claude 两套不同的订阅档位**；② **配置独立成设置页，主页面不再出现设置项**。
前文的单套合并档位（`free/plus/max5x/max20x` 四选一）与"面板里含设置控件"全部作废，以下为准。

## 10. 档位：两套 vendor 目录（覆盖 §3）

```js
export const VENDORS = deepFreeze([
  {
    id: 'claude',
    name: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
    note: { zh: '5 小时会话额度 + 每周额度', en: '5-hour session limit + weekly limit' },
    plans: [
      { id: 'free',   name: { zh: 'Free',    en: 'Free' },    priceUSD: 0,   limits: { h5: 150_000,    d7: 1_000_000 } },
      { id: 'pro',    name: { zh: 'Pro',     en: 'Pro' },     priceUSD: 20,  limits: { h5: 2_000_000,  d7: 20_000_000 } },
      { id: 'max5x',  name: { zh: 'Max 5×',  en: 'Max 5×' },  priceUSD: 100, limits: { h5: 8_000_000,  d7: 80_000_000 } },
      { id: 'max20x', name: { zh: 'Max 20×', en: 'Max 20×' }, priceUSD: 200, limits: { h5: 30_000_000, d7: 300_000_000 } },
    ],
  },
  {
    id: 'openai',
    name: { zh: 'OpenAI ChatGPT', en: 'OpenAI ChatGPT' },
    note: {
      zh: '滚动窗口消息额度（Free / Go / Plus / Pro / Pro Max，按 tokens 模拟）',
      en: 'Rolling message caps (Free / Go / Plus / Pro / Pro Max, simulated as tokens)',
    },
    plans: [
      { id: 'free',   name: { zh: 'Free',    en: 'Free' },    priceUSD: 0,   limits: { h5: 100_000,    d7: 800_000 } },
      { id: 'go',     name: { zh: 'Go',      en: 'Go' },      priceUSD: 8,   limits: { h5: 500_000,    d7: 4_000_000 } },
      { id: 'plus',   name: { zh: 'Plus',    en: 'Plus' },    priceUSD: 20,  limits: { h5: 2_500_000,  d7: 20_000_000 } },
      { id: 'pro',    name: { zh: 'Pro',     en: 'Pro' },     priceUSD: 200, limits: { h5: 30_000_000, d7: 250_000_000 } },
      { id: 'promax', name: { zh: 'Pro Max', en: 'Pro Max' }, priceUSD: 500, limits: { h5: 60_000_000, d7: 500_000_000 } },
    ],
  },
])
export const DEFAULT_VENDOR = 'claude'
export const DEFAULT_PLAN = 'max20x'      // 迁移旧状态与新装默认
export const CUSTOM_PLAN = { id: 'custom', name: { zh: '自定义', en: 'Custom' }, priceUSD: 0 }
```

- Plan ids are only unique **within** a vendor (`free`/`pro` exist twice). Every lookup must be
  vendor-scoped: `findPlan(vendorId, planId)`, `effectiveLimits(vendorId, planId, customLimits)`,
  `planDescriptor(vendorId, planId, customLimits)`.
- `custom` is available under either vendor: `state.plan = 'custom'` keeps `state.vendor` unchanged and
  reads global `customLimits`.
- Windows (`h5`/`d7` enable flags) stay **global and user-configurable** for both vendors (user asked
  earlier for 7d-only or 5h+7d). Vendor notes explain the real-world limit style; do not force toggles.

## 11. Host state v2 + migration

Persisted state gains `vendor`, `version` becomes **2**:

```js
{ version: 2, vendor: 'claude', plan: 'max20x', customLimits, windows, settings, buckets, lifetime, cards, claimAt, lastHit, simulateBlock, events }
```

Migration in `normalizeState` from version-1 records (must never throw, operator's live file is v1 today):

- `vendor` present and valid → keep; else infer from the legacy plan id:
  `max5x`/`max20x`→`claude`; `plus`/`go`→`openai`; `free`/`pro`/`custom`→`claude`; invalid→`claude`.
- Then require the plan to exist in the resolved vendor: `custom` always valid; otherwise if the legacy
  plan is not in that vendor (e.g. legacy `max20x` + inferred `claude` is fine; legacy `plus` + `claude`
  would be invalid), fall back to `{ vendor: DEFAULT_VENDOR, plan: DEFAULT_PLAN }`.
- Keep buckets/lifetime/cards/windows/settings/customLimits/events/lastHit exactly as before
  (limits are pure functions of the new catalog, so a bigger Max 20× h5 limit takes effect on reload
  without touching recorded usage — that is expected).

## 12. HTTP API v2（覆盖 §4 的 plan / snapshot 部分；其余 action 语义不变）

- `set-plan` body is now `{ vendor: 'claude'|'openai', planId: string }` — **both required**.
  Unknown vendor/plan → `{ok:false,error:{code:'unknown_plan'}}`. `custom` is not selectable via
  `set-plan` (use `set-limit`); selecting a preset records event `plan` with message `${vendor}/${planId}`
  and keeps usage.
- Snapshot v2 (all other fields from §4 unchanged):

```js
{
  ok: true, serverNow, version: 2,
  vendor: { id, name: { zh, en }, note: { zh, en } },
  plan: { id, name: { zh, en }, priceUSD, limits: { h5, d7 }, custom, vendorId, vendorName: { zh, en } },
  vendors: [ { id, name: { zh, en }, note: { zh, en }, plans: [ { id, name: { zh, en }, priceUSD, limits } ] } ],
  windows, blocked, blockedWindow, settings, cards, lifetime, lastHit, simulateBlock, events, storage
  // NOTE: the old top-level `plans` field is removed (replaced by `vendors`)
}
```

- `set-limit` unchanged: sets `customLimits[window]`, `plan='custom'`, keeps current `vendor`.
- `reset-all` unchanged. `subscription_status` tool: report vendor + plan, and mention that plan/window
  settings live in the Web Settings page (`设置 → 订阅额度`), not the main panel.

## 13. Client v2（覆盖 §7 的槽位与面板内容）

Four slot registrations now (the first three unchanged, plus the settings page):

1. `sidebar.footer.action` — id `subscription-sim`, order `3` — status chip (unchanged behavior).
2. `conversation.composer.dock` — id `subscription-sim`, order `6` — status strip (unchanged behavior).
3. `shell.overlay` — id `subscription-sim`, order `30` — **主面板改为只读状态 + 重置卡**：
   - Keep: header(title / vendor + plan name / price / `模拟订阅` badge / close), the two usage cards
     (used/limit/percent/bar/countdown, disabled rows), reset cards section (held icons, claim with
     cooldown/max, use-card with window selector), last ~8 events, footer (state-file path).
   - **Remove every configuration control**: no plan presets, no vendor switching, no custom-limit inputs,
     no 5h/7d window switches, no enforce/countAuxiliary switches, no 重置全部模拟数据.
   - Add one muted hint line in the footer: `在 设置 → 订阅额度 中调整档位、窗口与拦截开关`
     (en: `Plan, windows and enforcement live in Settings → Subscription Quota`).
   - Exhausted banner unchanged (use-card / claim / later).
4. **`settings.section`** — id `subscription-sim`, order `12`, label thunk `t('settingsLabel')` →
   `SettingsPage` component. Registration options: `{ name: 'settings.section', id: 'subscription-sim',
   order: 12, label: () => t('settingsLabel') }`. The settings shell renders the section inside its panel
   content column and passes `{ close }` plus the standard props; the component renders **normal-flow page
   content only** (no fixed positioning, no modal/backdrop, no own close button, no header chrome the shell
   already owns). Match the existing settings pages' visual conventions: read
   `dsh-client-ui-settings-general/lib/client.js` (its `settings.section` registration ~line 1293, page
   markup/CSS around its section component) and `dsh-client-ui-settings-models/lib/client.js` for row/card
   patterns; reuse the same type scale, paddings, section-title and row styles with `dss-` class names and
   theme tokens only.
   `SettingsPage` content:
   - Intro note: 本地模拟、与真实计费无关。
   - **订阅方案**：two vendor groups (Claude / ChatGPT), each with its vendor note and 4 plan rows
     (name, `$price/月`, `5小时 / 7天` simulated limits, active mark). Click a plan row → `set-plan`
     `{vendor, planId}`; rows of the selected vendor+plan show active state.
   - **额度窗口**：5 小时 / 7 天 switches (disabled when it's the only enabled one still trying to turn off;
     show inline error from host `both_windows_disabled`).
   - **拦截设置**：`enforce` (是否真的拦截请求) and `countAuxiliary` (压缩/会话标题等后台调用是否计数) switches.
   - **自定义额度**：two number inputs + 保存 → `set-limit` per changed window (host switches plan to custom).
   - **危险区域**：重置全部模拟数据，inline two-step confirm.
   - **存储**：state-file path + last save status.
- Locale: add the new settings-page keys and the vendor/plan strings come from the snapshot (host-provided
  bilingual names) — client picks `name[localeKey]`. Keep ZH/EN dictionary key parity; remove keys that are
  no longer rendered (or keep them all — parity is the only hard rule).
- `package.json` `dsh.client.inject` gains `@deepseek-ai/dsh-client-ui-settings` (owner of `settings.section`);
  Lead edits package.json, engineers do not.

## 14. Verification v2 additions

- Unit: vendor catalog shape (claude = free/pro/max5x/max20x; openai = free/go/plus/pro; exact prices/limits),
  vendor-scoped lookup, `set-plan` vendor validation (wrong pairing → `unknown_plan`), snapshot `vendors` /
  `vendor` / `plan.vendorId`, limits follow the selected vendor plan, `set-limit` keeps vendor, persistence of
  `vendor`, v1→v2 migration matrix (max20x→claude/max20x, plus→openai/plus, go→openai/go, max5x→claude/max5x,
  free→claude/free, custom+claude, unknown plan→default, no vendor field, already-v2 stays).
- Client static/mock-render: 4 slots registered (incl. `settings.section` id `subscription-sim` order 12);
  main `Panel` tree contains **no** switch toggles / plan rows / reset-all (assert absence); `SettingsPage` tree
  contains both vendor names, all 9 plan ids (Claude 4 + ChatGPT 5 incl. Pro Max), the 4 switches, custom inputs, reset-all; ZH/EN parity; no
  literal colors outside SVG; settings page uses no fixed/backdrop styles.
- Live (disposable authenticated instance as before): snapshot v2 shape; `set-plan {vendor:'claude',planId:'free'}`
  then `{vendor:'openai',planId:'go'}` changes `plan.vendorId` + limits; old `set-plan {planId}` (v1 body) now
  returns `unknown_plan`; enforcement unchanged; migration: disposable instance starting against the operator's
  current v1 state file must load healthy and expose `vendor:'claude', plan.id:'max20x', plan.limits.h5:30000000`
  (back up the operator state file first, restore it byte-for-byte afterwards; the operator host keeps its own
  in-memory authority and will overwrite on next write).
- The operator's live host picks up new host code only after a plugin reload/restart; the verifier checks a
  disposable instance. Client half needs one page refresh.
