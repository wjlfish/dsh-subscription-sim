# VERIFICATION — dsh-subscription-sim (v2)

Independent verification report. Subject: `dsh-subscription-sim` (Host half `index.js` + `lib/`, Client
half `client.js`), v2 redesign (Claude/OpenAI vendor catalogs, v1→v2 migration, settings-page split) built in
`$HOME/dsh-plugins/dsh-subscription-sim`, installed by the Lead into profile `web` and
loaded in the live Harness Web host.

- **Date (Asia/Shanghai):** 2026-10-23 — base v2 verification ~16:55 CST; **Lead refinement (ChatGPT Pro Max, §9)** re-verified ~17:46 CST; final source hashes and shared state re-checked at the end
- **Verdict:** **PASS** — 110/110 deterministic tests pass (unit + mock-Cordis host integration + static and
  mock-rendered client), the v1→v2 migration was proven against the operator's real v1 state bytes, and the v2
  live API action/migration/enforcement matrix passes on an authenticated disposable instance. No blocking
  defects. Explicit limits in §8: **no browser/visual verification**; the main panel and settings page were
  verified statistically and by mock-render only; runtime slot occupancy (`settings.section`) is pending an
  operator page refresh; live API checks were made on disposable instances, never on `:3080`. A follow-up
  refinement (2026-10 ChatGPT personal tiers now Free / Go / Plus / Pro / Pro Max — 9 plans total) re-ran the
  suite and a disposable-instance live check: **green** (§9).
- **Operator-quota safety:** the operator's live host was never targeted by an API action (unauthenticated
  `curl` against `:3080` still correctly returns the 403 connection-fence response). Phase B ran on disposable
  `dsh web --port 3099` instances created and destroyed by verification. Both were shut down, the port is free,
  no cookie jar was ever written to disk, and the shared state file is healthy v2 (`blocked:false`). The
  operator host's own in-memory state has authority over the file and rewrote it with its healthy live baseline
  after verification finished (see §5.2) — this is expected per CONTRACT §14.

---

## 1. Environment and artifacts

| Fact | Value |
|---|---|
| macOS | 27.2 (arm64) |
| Node.js | v22.23.2 |
| DSH | 0.2.1-rc.2 (Web GUI `http://127.0.0.1:3080`, operator host) |
| `DSH_HOME` | `$HOME/.dsh` |
| Package dir | `$HOME/dsh-plugins/dsh-subscription-sim` |
| Installed dependency | `"dsh-subscription-sim": "link:$HOME/dsh-plugins/dsh-subscription-sim"` (profile `web`) |
| Installed row | `id: subscription-sim`, bundle patch `cordis.patch.yml` (v2 config: `vendor: claude`, `plan: max20x`, windows/enforce/countAuxiliary on) |
| State file | `$HOME/.dsh/plugin-data/dsh-subscription-sim/state.json` |
| Client inject | `dsh.client.inject` = conversation + `@deepseek-ai/dsh-client-ui-settings` (owner of `settings.section`) |
| Catalogs (after §9 refinement) | Claude: Free / Pro / Max 5× / Max 20× (4) · OpenAI ChatGPT: Free / Go / Plus / Pro / Pro Max (5) — **9 plans total** |

Source hashes at final verification (md5 / lines / mtime):

```
index.js         a0f33cb643e07aaae3befbe748c0ba9d   627 lines   16:44
client.js        fa87c996f89fcc4a392b3c7925cd762c  2202 lines   16:50
lib/engine.js    12484bcbf2a12789aa3ac82d53c66d9d  1209 lines   16:43
lib/format.js    c0a376330f86f5e624afef2c8e7293b6   168 lines   16:44
lib/plans.js     acb248183604c2cd388dd301b08ebc0f   498 lines   17:44   (5-tier OpenAI catalog, §9)
```

The verifier did not modify host/client/package/patch/locale sources. Write scope used:
`dsh-subscription-sim/test/**` (updated/extended suite) and this document.

## 2. Commands

```sh
# Phase A — deterministic suite (no install, no browser, no network)
cd $HOME/dsh-plugins/dsh-subscription-sim
node --test 'test/*.test.mjs'
# NOTE: on Node 22.23.2 the bare-directory form `node --test test/` is broken (treated as a module path);
# the glob form above is the working invocation.

# Phase B — live authenticated DISPOSABLE instance (never the operator's :3080)
# 1. freeze the operator's real v1 bytes (before Phase B, cfbd147028129c995dde3de47ffb43e104e73eae)
cp "$DSH_HOME/plugin-data/dsh-subscription-sim/state.json" /tmp/dss-v2-phaseb/operator-state-frozen.json
# 2. plant those bytes on the shared state path and immediately start a disposable instance
cp /tmp/dss-v2-phaseb/operator-state-frozen.json \
   "$DSH_HOME/plugin-data/dsh-subscription-sim/state.json"
dsh web --port 3099 --no-open          # prints http://127.0.0.1:3099/?token=…
# 3. exchange the printed launch URL for that instance's own cookie (login 303 + Set-Cookie),
#    then run the full matrix (state → set-plan → invalid bodies → set-limit → probe blocked →
#    probe healthy → simulateBlock → HARD RESTORE clean v2 baseline), asserting every response.
node /tmp/dss-v2-phaseb/phaseb.mjs http://127.0.0.1:3099 '<printed launch URL>' \
     /tmp/dss-v2-phaseb/operator-state-frozen.json true
# 4. kill the disposable instance, verify :3099 free, verify shared state file health.
```

## 3. Phase A — deterministic suite (110/110 pass)

Final run:

```
# tests 110
# suites 0
# pass 110
# fail 0
# duration_ms 1065
```

| File | Tests | v2 coverage |
|---|---:|---|
| `test/plans.test.mjs` | 21 | **exact §10 catalog** (`deepEqual` against the two-vendor catalog incl. names/notes/prices/limits; OpenAI ChatGPT now lists five tiers `free/go/plus/pro/promax`, Pro Max = $500, h5 60,000,000 / d7 500,000,000, updated vendor note) `VENDORS`, `DEFAULT_VENDOR`/`DEFAULT_PLAN`/`CUSTOM_PLAN`; vendor-scoped `vendorById`/`findPlan` (cross-vendor pairings such as claude/plus and openai/max20x do **not** resolve); `effectiveLimits(vendor,plan,customLimits)` and `planDescriptor(...)` incl. `custom` under either vendor; `normalizeConfig` v2 defaults (`vendor:'claude'`, `plan:'max20x'`), partial input, invalid repair (never yields an invalid vendor/plan pair), idempotence; unchanged `WINDOW_MS`, rolling-window/`prune`/`ratio`/`resetIn`/bucket helpers, `formatTokens`, documented constants |
| `test/engine.test.mjs` | 43 | fresh **v2** state (`version:2`, `vendor:'claude'`, claude/max20x `{h5:30_000_000,d7:300_000_000}`) + persisted v2; all unchanged v1 engine behaviour (buckets, rolling windows + exact boundaries, pruning, lifetime monotonicity, cards/claim/cooldown/maxHeld, redeem h5-only/d7-all/auto, `simulateBlock` once + durable, stale-hit self-heal, dismiss, reset-all semantics, reload persistence, corrupt-file quarantine, structurally-invalid file, atomic writes, full snapshot derivation, events cap, enforce/countAuxiliary gating, default `DSH_HOME` path); **`setPlan({vendor,planId})`** success incl. `openai/promax` → 60M/500M with usage preserved, + 15 invalid bodies (positional v1 call, missing vendor/plan, wrong pairings, `custom`, unknown vendor/plan, non-string) → `unknown_plan` with vendor/plan/usage/events untouched; **`setLimit` keeps the vendor** and the other window's vendor-scoped limit; snapshot v2 (`vendor`, `plan.vendorId`/`vendorName`, `vendors` = Claude 4 + ChatGPT 5 = **9 plans** (incl. `promax` 60M/500M), **no top-level `plans` key**) ; **§11 migration matrix** (max20x→claude/max20x with `limits.h5=30_000_000`, max5x→claude/max5x, free→claude/free, pro→claude/pro, plus→openai/plus, go→openai/go, custom→claude/custom with custom limits preserved, unknown plan→claude/max20x, explicit-valid-vendor-wins then pair validation, already-v2 unchanged, malformed/null/array records never throw, both-windows-disabled repair, customLimits preserved verbatim, v1 file persisted as v2 on next save) |
| `test/host.test.mjs` | 16 | mock-Cordis integration of `index.js`: listener registered exactly `{global:true, prepend:true}`; blocked stream yields exactly one terminal `finish` (`kind:error`, `SUBSCRIPTION_QUOTA`, status 429, bilingual message) and **never calls `next()`**; `state` route returns snapshot v2 shape; `set-plan` route takes `{vendor, planId}`, switches vendor+limits, preserves usage and records `claude/free` → `openai/go` → `openai/promax` (60M/500M), usage preserved; snapshot lists 5 ChatGPT tiers; v1 body / missing vendor / wrong pairing / custom / unknown vendor/plan → `unknown_plan`; `set-limit` keeps vendor; enforce/countAuxiliary gating; one-shot `simulateBlock`; `probe` healthy and blocked end-to-end; `reset-all` keeps vendor/plan/windows; tool `subscription_status` reports vendor+plan, v2 limits and the `设置 → 订阅额度` settings-page hint |
| `test/format.test.mjs` | 12 | unchanged format contract (code constant, window labels, hand-rolled count/duration formatting, bilingual blocked message variants, price) — still green with the v2 plan labels |
| `test/static.test.mjs` | 9 | `node --check` on host/client/lib; no `@deepseek-ai/*` imports in host files; `index.js` exports; **4 client slots** incl. `settings.section`; react-only `__ModuleLoader__` module + locale wiring + `useSyncExternalStore`; client must not read the removed `snapshot.plans` and must read `snapshot.vendors[].plans`; package.json (exports/files/`dsh.client.inject` incl. settings package); locale JSON meta; icon SVG; patch row now asserts `vendor: claude` |
| `test/client.test.mjs` | 8 | new **mock-render harness** (node:vm fake module-loader + fake React/DOM + recording `fetch`): all four slots registered with exact ids/orders (`sidebar.footer.action` 3, `conversation.composer.dock` 6, `shell.overlay` 30, **`settings.section` 12**) and label thunks (`settings.section` label resolves `t('settingsLabel')`); ZH/EN dictionary key-set parity; **main `Panel` mock-rendered**: no switches, no inputs, no plan rows/custom inputs/reset zone, and clicking every panel control sends **zero** `set-plan`/`set-windows`/`set-settings`/`set-limit`/`reset-all` requests — while still rendering usage, reset cards, vendor+plan header, state-file footer and the `设置 → 订阅额度` hint; **`SettingsPage` mock-rendered**: both vendor names + notes, all 9 plan rows (data attrs `vendor/plan`) incl. Pro Max with its $500/月 price, 4 switches, 2 custom-limit number inputs, reset-all, storage path and every settings section title; clicking plan rows sends `set-plan` for **all 9 `{vendor,planId}` pairs incl. `openai/promax`**; switches send `set-windows`/`set-settings`; editing both numbers + 保存 sends `set-limit` per changed window; two-step reset fires `reset-all`; settings page has no fixed/backdrop/modal chrome (rendered tree, class rules and component source); no literal colors outside inline SVG artwork; **v1 snapshot fallback renders every slot without throwing**; only `/subscription-sim/api` is polled |
| `test/_support.test.mjs` | 1 (runner file entry) | shared helpers updated to v2: snapshot-shape walker (`version:2`, `vendor`, `plan.vendorId/vendorName`, `vendors`, absence of `plans`), persisted-state walker (v2 + `vendor`), v1-record factory and `bootFromState()` for the migration matrix, injected clock/temp-dir engine factory, failure-code asserts |

Determinism: no timers, no real clock (injected `now()`), state files under `fs.mkdtemp` temp dirs; the client
tests use a fake loader/React/DOM and never open a browser or network.

## 4. Phase B — live checks on a disposable authenticated instance

The operator's Web host fences every `/api` route behind the signed browser cookie minted from its process
launch token; plain `curl` against `:3080` correctly returns
`403 {"ok":false,"error":{"code":"forbidden",…}}` (the fence runs before the method check — see §5.3). The
operator's token/cookie was not extracted. Verification therefore started its own
`dsh web --port 3099 --no-open` instance, exchanged **its own** printed launch URL for **its own** cookie
(`303` + `Set-Cookie`), and made every request against that instance. The disposable instance shares the
profile (and therefore the plugin state file) with the operator host; the operator host keeps authoritative
in-memory state (CONTRACT §14 note).

### 4.1 v1→v2 migration against the operator's real state bytes

Frozen operator v1 bytes captured before Phase B:
`cfbd147028129c995dde3de47ffb43e104e73eae` (v1: `plan:'max20x'`, `windows:{h5:false,d7:true}`, 11 minute
buckets, rolling h5/d7 usage 32,119,851 tokens, `lifetime:{tokens:46,757,267, calls:287}`, cards 2,
`customLimits:{h5:18_000_000,d7:160_000_000}`, 30 events, `lastHit:null`).

These bytes were planted on the shared state path and a disposable instance was started immediately; the very
first successful activation read them and migrated to v2. Snapshot from the hosted API:

```json
{"ok":true,"version":2,
 "vendor":{"id":"claude","name":{"zh":"Anthropic Claude","en":"Anthropic Claude"}},
 "plan":{"id":"max20x","vendorId":"claude","custom":false,"limits":{"h5":30000000,"d7":300000000}},
 "vendors":[{"id":"claude","plans":["free","pro","max5x","max20x"]},
            {"id":"openai","plans":["free","go","plus","pro"]}],
 "windows":{"h5":{"enabled":false,"used":32119851},"d7":{"enabled":true,"used":32119851}},
 "lifetime":{"tokens":46757267,"calls":287},"cards":{"held":2},"events":30,"blocked":false}
```

Observed: `vendor:'claude'`, `plan.id:'max20x'`, `plan.limits.h5:30000000`, `plan.limits.d7:300000000`;
windows flags, per-window usage, lifetime counters, cards and event log were **all preserved**; the migrated
state was persisted immediately as `version:2` (confirmed independently by loading the same frozen bytes
through `lib/engine.js` in plain Node: persisted file `{version:2, vendor:'claude', plan:'max20x'}`,
customLimits/usage/cards unchanged).

> Honesty note: the first plant attempt raced the operator host — it rewrote the shared file with its own clean
> v2 in-memory baseline between the plant and disposable activation, so that instance loaded a *clean* v2 state
> (lifetime 2,376,996, h5 enabled) instead of the planted v1 file. That was recognized as an environment race
> (its snapshot was internally consistent v2, not a migration failure) and retried; the second attempt planted
> and validated in one uninterrupted step and produced the evidence above. No migration defect.

### 4.2 API action matrix (all PASS)

| Step | Expected / observed |
|---|---|
| `state` | HTTP 200, `version:2`, `vendor` object, `plan.vendorId='claude'`, `plan.vendorName` bilingual, `vendors` (Claude 4 + ChatGPT 5 after the §9 refinement; this matrix was captured before it, when OpenAI had 4 tiers — see the note under §4.1), **no top-level `plans`**, windows/settings/cards/lifetime/storage unchanged |
| `set-plan {vendor:'claude',planId:'free'}` | ok; `plan.limits:{h5:150000,d7:1000000}`; **usage preserved** (32,119,851); event message `claude/free` |
| `set-plan {vendor:'openai',planId:'go'}` | ok; `vendor.id='openai'`, `plan.limits:{h5:500000,d7:4000000}`; **vendor + limits both changed, usage still 32,119,851**; event message `openai/go` |
| 7 invalid `set-plan` bodies: old v1 `{planId}` body, missing `planId`, claude/plus, openai/max20x, `custom`, unknown vendor, unknown plan | every one → `{ok:false,error.code:'unknown_plan'}`, and the state stayed `openai/go` |
| `set-limit {window:'h5',tokens:1234}` | ok; **vendor stays `openai`**, plan `custom`, limits `{h5:1234,d7:4000000}` (other window keeps the vendor-scoped limit) |
| enforcement — temporary tiny limit `set-limit {window:'d7',tokens:1}` (d7 is the enabled window) | state `blocked:true`, `blockedWindow:'d7'`, d7 `used:32,119,851 > limit:1` |
| `probe` while exhausted | `{ok:true, probe:{blocked:true, failure:{code:'SUBSCRIPTION_QUOTA',status:429}, chunkTypes:['finish'], usage:null}}`, bilingual message (396 chars) incl. both zh/en substrings, provider **not** called, `lastHit:{window:'d7',seq:1}` |
| restore `set-plan claude/max20x` then `probe` | `blocked:false`, `failure:null`, streamed `block-start … usage … finish`, `usage:{inputTokens:31,outputTokens:16,totalTokens:47}` recorded |
| `arm-simulate-block` + `probe` | one diagnostic block (`SUBSCRIPTION_QUOTA`), flag consumed exactly once (`simulateBlock:false` afterwards), `lastHit` recorded; `dismiss-hit` clears it |
| HARD RESTORE: `set-plan claude/max20x` → `set-windows {h5:true,d7:true}` → `set-settings {enforce:true,countAuxiliary:true}` → `reset-all` (last, so it clears buckets/lifetime/events while keeping plan/windows/settings) | clean healthy v2 baseline (below) |

Final state written by the disposable instance (evidence of HARD RESTORE):

```json
{"ok":true,"version":2,"vendor":"claude","plan":"max20x","planVendorId":"claude",
 "limits":{"h5":30000000,"d7":300000000},"custom":false,
 "windows":{"h5":true,"d7":true},"blocked":false,"blockedWindow":null,
 "settings":{"enforce":true,"countAuxiliary":true},
 "cards":{"held":2},"lastHit":null,"simulateBlock":false,
 "lifetime":{"tokens":0,"calls":0},"usage":{"h5":0,"d7":0},"events":1}
```

## 5. Operator host state and cleanup evidence

### 5.1 No action was sent to `:3080`

```
POST http://127.0.0.1:3080/subscription-sim/api {"action":"state"}   → HTTP 403
{"ok":false,"error":{"code":"forbidden",
 "message":"请求被拒绝：未通过本机连接鉴权。Request rejected: not admitted by the local connection fence."}}
```

All Phase B requests went to `http://127.0.0.1:3099/subscription-sim/api` on the disposable instance.

### 5.2 Shared state file after Phase B — healthy v2, not blocked

The operator host keeps its own live in-memory authority and rewrote the file with its healthy baseline after
the disposable instance shut down (expected per CONTRACT §14). Final observed file (16:55 CST):

```json
{"version":2,"vendor":"claude","plan":"max20x","customLimits":{"h5":30000000,"d7":300000000},
 "windows":{"h5":true,"d7":true},"settings":{"enforce":true,"countAuxiliary":true},
 "cards":2,"claimAt":0,"lastHit":null,"simulateBlock":false,
 "lifetime":{"tokens":6674092,"calls":26},"computedUsage":{"h5":6674092,"d7":6674092},
 "blocked":false}
```

`blocked:false` because 6.67M used is far below both v2 limits. The file is valid JSON, version 2, and the
operator's next real request would not be blocked.

At the §9 refinement re-check (17:46) the operator host's in-memory state had changed on its own to
`{vendor:'openai', plan:'pro', windows:{h5:false,d7:true}}` and overwrote the disposable instance's restored
`claude/max20x` file within about a second of the disposable shutting down — the expected proof that the running
operator host keeps authoritative in-memory state (CONTRACT §14). The resulting file is still valid, version 2,
healthy and **not blocked**; the Lead reloads the plugin afterwards and can set the plan from the Settings page.

### 5.3 Live v2 host is loaded in the operator process

`cordis_inspect_query host Tool.listTools` shows the live `subscription_status` tool with the v2 description:
*"Simulated plans come from two vendor catalogs: Anthropic Claude (Free / Pro / Max 5× / Max 20×) and OpenAI
ChatGPT (Free / Go / Plus / Pro); the active vendor and plan are reported. … plan/vendor, quota-window and
enforcement settings are changed in the Web Settings page (设置 → 订阅额度), not here …"*. That confirms the v2
host half is active in the running operator host.

### 5.4 Cleanup

- Disposable instance killed; `lsof -iTCP:3099 -sTCP:LISTEN` is empty, no `dsh web --port 3099/3098` process
  remains. The operator `:3080` host was never restarted or mutated by verification.
- The disposable login cookie was kept in memory only; no cookie jar was written to disk. A stray cookie-header
  artifact left in `/tmp` by the previous (v1) verification run was deleted.
- Phase B scratch evidence kept outside the repo: `/tmp/dss-v2-phaseb/phaseb-evidence.json` (assertions, steps,
  0 failures), `/tmp/dss-v2-phaseb/phaseb-run2.log`, `/tmp/dss-v2-phaseb/operator-state-frozen.json`.

### 5.5 Client runtime slot check — pending page refresh

`cordis_inspect_query client Slots.listSubTree` was attempted once against the live operator page and timed
out: *"Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then
retry."* The operator page has not been refreshed since the client bundle changed, so this is **not** a defect:
the new four-slot client bundle is on disk and will load on the next page refresh. Runtime slot occupancy
(especially the new `settings.section` entry in the real Settings shell) is therefore **unverified live**; the
four registrations, the settings page tree and the panel tree were verified statically and by mock-render.

## 6. Pass/fail summary against CONTRACT §14

| Requirement | Evidence | Status |
|---|---|---|
| Vendor catalog exact shape (claude free/pro/max5x/max20x, openai free/go/plus/pro/**promax**, prices/limits) | `plans.test.mjs` deepEqual vs §10; live snapshot `vendors` (§9) | PASS |
| Vendor-scoped lookups / `effectiveLimits` | `plans.test.mjs` cross-vendor pairings rejected; custom limits under either vendor | PASS |
| `setPlan({vendor,planId})` validation (wrong pairing, unknown vendor, `custom` → `unknown_plan`, state unchanged) | 14 unit cases + 7 live invalid bodies, state unchanged | PASS |
| Snapshot v2 (`vendor`, `plan.vendorId/vendorName`, `vendors`, no top-level `plans`) | unit shape walker, mock-host route test, live `state` | PASS |
| `set-limit` keeps vendor | unit + live: openai stayed openai, plan→custom | PASS |
| `vendor` persistence / v1→v2 migration matrix (§11) | unit matrix (all legacy ids, custom, unknown, no-vendor, already-v2, malformed) + live migration of the operator's real v1 bytes | PASS |
| Limits follow the selected plan (`claude/max20x` h5 = 30,000,000) | fresh-state unit test, migration unit matrix, live migration snapshot | PASS |
| Pre-existing v1 behaviours still valid (windows/buckets/cards/enforce/probe/tool) | engine 43 + host 16 + format 12 | PASS |
| 4 client slots incl. `settings.section` id/order 12/label thunk | mock-loader registration assertions; static source check | PASS |
| Main `Panel` has no configuration controls | mock-render absence checks + zero configuration actions when clicking every panel control | PASS |
| `SettingsPage` has both vendors, **9 plans**, 4 switches, custom inputs, reset-all | mock-render tree + click behaviour (all 9 `{vendor,planId}` actions, set-windows/set-settings, set-limit, reset-all) | PASS |
| Refinement: OpenAI Pro Max ($500, 60M/500M) in catalog, selectable live, usage preserved, restore works | §9 live disposable check | PASS |
| Settings page no fixed positioning/backdrop/modal | rendered tree, its class CSS rules, component source | PASS |
| ZH/EN key parity, no literal colors outside SVG, react-only require | `client.test.mjs` (and `static.test.mjs` for require/module shape) | PASS |
| v1-snapshot fallback renders without throwing | `client.test.mjs` fallback test across all four slots | PASS |
| Host mock integration: `set-plan` route body `{vendor,planId}`, snapshot v2, tool mentions vendor + settings page | `host.test.mjs` | PASS |
| Live: snapshot v2, vendor switch preserves usage, v1 body → `unknown_plan`, enforcement via probe, migration, hard restore | Phase B matrix (§4) | PASS |

## 7. Defects

None blocking. Notes and observations:

1. **Migration race on the shared state file (environmental, not a product defect).** On the first Phase B
   attempt the running operator host rewrote the planted v1 file with its own clean v2 in-memory baseline
   before the disposable instance read it. Verification detected this from the snapshot (clean v2 numbers
   instead of the planted v1 numbers), retried with an uninterrupted plant+start, and obtained the correct
   migration evidence. In a real install the migration happens during the host restart itself, so this race
   only exists for the "second live instance on a shared state file" verification technique.
2. **The operator's obsolete 32M dirty usage was intentionally not carried into the final state.** Before
   Phase B the operator's v1 state had 32.1M tokens in the h5 window (above even the v2 30M h5 limit) with h5
   disabled. The Lead reset the live state to a clean v2 baseline before Phase B, and Phase B's hard restore
   used `reset-all` to leave a clean baseline (`lifetime:0`, empty buckets) instead of re-introducing that
   dirty usage — otherwise enabling both windows would have left the operator blocked. This matches the
   Lead-approved Phase B target.
3. **Operator host authority over the file is expected.** After the disposable instance wrote the clean final
   state, the operator host overwrote it with its own healthy live v2 memory (6.67M used at the final check).
   Both states are healthy; `blocked:false`. CONTRACT §14 documents this behavior.

## 8. Explicit limits of this verification

- **No browser / visual verification.** No screenshot, no human-visible layout check, no interaction with the
  real Settings shell or sidebar. The client was verified by static analysis plus a `node:vm` mock-loader /
  fake-React/DOM render harness; CSS/token/absence checks are source-level.
- **Runtime slot occupancy is pending an operator page refresh.** The live `Slots.listSubTree` client-inspect
  query timed out because the operator page predates the new client bundle; `settings.section` rendering inside
  the real Settings shell was not observed live. The four slot registrations and both trees were verified
  statically and by mock-render.
- **Live API checks used a disposable `dsh web` instance**, not the operator's `:3080` host (whose cookie was
  deliberately not extracted; unauthenticated access is fenced at 403). The disposable instance shares the
  profile/state file with the operator host; the operator host may rewrite the file at any time.
- **Real model calls:** exactly two `probe` calls reached the real provider (one in each matrix run; ~47 total
  tokens each, ~94 tokens in total). Every blocked probe short-circuited before `next()` and made no provider
  call. All enforcement mutations were temporary and restored inside the disposable instance.
- **Test coverage is deterministic evidence, not a proof of absence of defects**: the suite asserts the
  CONTRACT §10–§14 interface and behaviour listed above; it cannot cover rendering aesthetics or long-run
  durability races.

---

## Lead addendum — live client slot occupancy (supersedes the "pending refresh" limitation)

Collected by the Lead from the connected Web page with `cordis_inspect_query` (platform `client`,
provider `Slots`, `listSubTree`) after the v2 host reload, on 2026-10-23 ~16:58 CST:

| Slot | Live occupant | Result |
| --- | --- | --- |
| `sidebar.footer.action` | `{ id: "subscription-sim", order: 3, active: true }` | PASS |
| `conversation.composer.dock` | `{ id: "subscription-sim", order: 6, active: true }` | PASS |
| `shell.overlay` | `{ id: "subscription-sim", order: 30, active: true }` | PASS |
| `settings.section` | `{ id: "subscription-sim", order: 12, active: true }` | PASS |

All four v2 client registrations are live in the operator's page (the page hot-loaded the new client
bundle after the host-side plugin reload; no manual page refresh was needed for registration).
Visual geometry, spacing, light/dark rendering and focus behaviour remain unverified (no browser
control / no screenshots in this environment) — that is now the only open verification item.

## 9. Lead refinement — ChatGPT Pro Max ($500) tier (2026-10)

**Request (user):** ChatGPT's Pro is no longer a single price. The current OpenAI personal tiers are
Free / Go ($8) / Plus ($20) / Pro ($200) / **Pro Max ($500, Astra Ultrafast)**. The Lead updated the CONTRACT
(§10/§14), `lib/plans.js` and README; verification re-ran the suite and a disposable-instance live check.

**Catalog change** (`lib/plans.js`, md5 `acb248183604c2cd388dd301b08ebc0f`, 498 lines): the OpenAI ChatGPT
vendor now has five plans — `free`, `go`, `plus`, `pro`, `promax` — with
`promax = { id:'promax', name:{zh:'Pro Max', en:'Pro Max'}, priceUSD:500, limits:{h5:60_000_000, d7:500_000_000} }`.
The OpenAI vendor note now lists all five tiers (`Free / Go / Plus / Pro / Pro Max`). The Claude catalog is
unchanged (4 tiers), so the combined catalog is **9 plans** (4 + 5). No `client.js` change was needed: the
Settings page renders plan rows from `snapshot.vendors`, so the new tier appears automatically.

**Phase A re-run:** `node --test 'test/*.test.mjs'` → **110/110 pass, 0 fail** (same test count; assertions
widened rather than added as separate tests). Updated assertions:
- `plans.test.mjs` — exact `deepEqual` catalog now includes `promax` (name/price/60000000/500000000) and the new
  OpenAI note; OpenAI plan-id order `free,go,plus,pro,promax` with length 5; `findPlan('openai','promax')`,
  `effectiveLimits('openai','promax', …)` and `planDescriptor('openai','promax', …)`; `claude/promax` correctly
  does **not** resolve.
- `engine.test.mjs` — `setPlan({vendor:'openai',planId:'promax'})` → price 500, limits 60M/500M, usage
  preserved, event message `openai/promax`; `{vendor:'claude',planId:'promax'}` → `unknown_plan`;
  snapshot `vendors` lists 5 ChatGPT tiers and 9 plans total.
- `host.test.mjs` — live mock route snapshot lists the 5 ChatGPT tiers + Pro Max h5 60M; `set-plan` route
  switch to `openai/promax` with usage preserved; invalid-body matrix unchanged otherwise.
- `client.test.mjs` — SettingsPage mock-render now expects **9** plan rows, includes `Pro Max` and `$500/月`,
  and clicking every plan row must produce all **9** `{vendor,planId}` `set-plan` actions including
  `openai/promax`. Main-panel status-only assertions unchanged.
- `_support.test.mjs` — `OPENAI_PLAN_IDS` includes `promax`.

**Phase B re-check (disposable `dsh web --port 3099 --no-open`, never `:3080`; evidence
`/tmp/dss-v2-phaseb/promax-evidence.json`, `promax-run.log`):**

```json
{"passed":true,"failures":0,
 "catalog":{"vendors":[
   {"id":"claude","plans":["free:$0:150000/1000000","pro:$20:2000000/20000000",
                            "max5x:$100:8000000/80000000","max20x:$200:30000000/300000000"]},
   {"id":"openai","plans":["free:$0:100000/800000","go:$8:500000/4000000","plus:$20:2500000/20000000",
                            "pro:$200:30000000/250000000","promax:$500:60000000/500000000"]}],
  "openaiPlanCount":5,
  "promax":{"id":"promax","name":{"zh":"Pro Max","en":"Pro Max"},"priceUSD":500,
            "limits":{"h5":60000000,"d7":500000000}}},
 "promaxSwitch":{"ok":true,"vendor":"openai","plan":"promax","priceUSD":500,
                 "limits":{"h5":60000000,"d7":500000000},
                 "usage":{"h5":17613918,"d7":17613918,"lifetime":17613918,"calls":59,"cards":2},
                 "event":{"kind":"plan","message":"openai/promax"}},
 "restore":{"planOk":true,"windowsOk":true,"settingsOk":true,
   "final":{"version":2,"vendor":"claude","plan":"max20x","planVendorId":"claude",
            "limits":{"h5":30000000,"d7":300000000},"windows":{"h5":true,"d7":true},
            "enforce":true,"countAuxiliary":true,"lastHit":null,"simulateBlock":false,
            "blocked":false,"usage":{"h5":17613918,"d7":17613918,"lifetime":17613918,"calls":59,"cards":2}}}}
```

Observed: the hosted snapshot lists the 5-tier ChatGPT catalog including `promax` with the exact $500 /
60,000,000 / 500,000,000 values and the unchanged 4-tier Claude catalog; `set-plan {openai, promax}` switches
vendor/plan/limits and **preserves usage exactly** (17,613,918 tokens, 59 calls, 2 cards) and records the
`openai/promax` plan event; `set-plan {claude, max20x}` + `set-windows {h5:true,d7:true}` +
`set-settings {enforce:true,countAuxiliary:true}` + `dismiss-hit` restores the healthy operator target
(`blocked:false`). The disposable instance was killed; `:3099` is free, no `dsh web` leftovers, and no cookie
jar was written (in-memory cookie only). The operator `:3080` host was never addressed (unauthenticated POST is
still fenced at 403).

**Known environmental note:** immediately after the disposable shut down, the running operator host (which was
still serving the pre-refinement code and its own in-memory state `{vendor:'openai', plan:'pro',
windows:{h5:false,d7:true}}`) rewrote the shared state file with that state. As before this is the documented
operator-host authority, not a defect; the file stays valid v2, healthy and `blocked:false`. The Lead reloads
the live plugin after this report, at which point the new catalog is served live.

**Limits unchanged:** no browser/visual check was possible for the refinement (the new tier is rendered from
the snapshot by the existing client code, verified statically/mock-rendered; the operator page still needs a
refresh for the four-slot client bundle). No `client.js` changes were made or needed.
