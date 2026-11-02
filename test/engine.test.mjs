// Unit tests for lib/engine.js against CONTRACT.md v2 (sections 2, 5, 10, 11, 12).
//
// The engine is created against a throwaway state file with an injected `now`, so every
// assertion is deterministic: no timers, no real clock, no writes outside the temp dir.
// v2 adds vendor-scoped plans, the state version bump and the v1 -> v2 migration matrix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DAY,
  D7_MS,
  H5_MS,
  HOUR,
  MINUTE,
  T0,
  assertFailure,
  assertPersistedShape,
  assertSnapshotShape,
  bootFromState,
  blockedOf,
  configValue,
  flush,
  makeClock,
  makeEngine,
  makeTempDir,
  readJson,
  setPlanOn,
  v1State,
  vendorPlanPairs,
} from './_support.test.mjs'
import { VENDORS, normalizeConfig } from '../lib/plans.js'
import { createEngine } from '../lib/engine.js'

test('fresh engine starts from claude/max20x v2 defaults and persists version-2 state', async (t) => {
  const { engine, stateFile } = await makeEngine(t, { rawConfig: {} })
  const snap = engine.snapshot()
  assertSnapshotShape(snap)
  assert.equal(snap.vendor.id, 'claude', 'v2 default vendor must be claude')
  assert.equal(snap.vendor.name.zh, 'Anthropic Claude')
  assert.equal(snap.plan.id, 'max20x', 'default plan must be max20x (cannot lock the operator out)')
  assert.equal(snap.plan.custom, false)
  assert.equal(snap.plan.vendorId, 'claude')
  assert.equal(snap.plan.limits.h5, 30_000_000, 'limits follow the claude max20x catalog')
  assert.deepEqual(snap.plan.limits, { h5: 30_000_000, d7: 300_000_000 })
  assert.equal(snap.windows.h5.enabled, true)
  assert.equal(snap.windows.d7.enabled, true)
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.windows.h5.limit, 30_000_000)
  assert.equal(snap.cards.held, 2, 'default initialHeld is 2')
  assert.equal(snap.cards.maxHeld, 9)
  assert.equal(snap.lifetime.tokens, 0)
  assert.equal(snap.lastHit, null)
  assert.equal(snap.simulateBlock, false)
  assert.equal(snap.settings.enforce, true)
  assert.equal(snap.settings.countAuxiliary, true)
  assert.equal(snap.storage.stateFile, stateFile)
  assert.equal(snap.storage.ok, true)

  // CONTRACT section 2: activation establishes the durable file even when absent.
  assert.ok(readdirSync(join(stateFile, '..')).length >= 1)
  const persisted = readJson(stateFile)
  assertPersistedShape(persisted)
  assert.equal(persisted.vendor, 'claude')
  assert.equal(persisted.plan, 'max20x')
  assert.equal(persisted.cards, 2)
  assert.deepEqual(persisted.buckets, {})
  assert.equal(persisted.lifetime.tokens, 0)
})

test('recordUsage aggregates into the current minute bucket and the lifetime counters', async (t) => {
  const { engine, clock, stateFile } = await makeEngine(t)
  await engine.recordUsage({
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
  })
  let snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 150)
  assert.equal(snap.windows.d7.used, 150)
  assert.equal(snap.lifetime.tokens, 150)
  assert.equal(snap.lifetime.input, 100)
  assert.equal(snap.lifetime.output, 50)
  assert.equal(snap.lifetime.calls, 1)

  await flush(engine)
  const persisted = readJson(stateFile)
  const key = String(Math.floor(clock.now() / MINUTE))
  assert.deepEqual(persisted.buckets[key], {
    input: 100,
    output: 50,
    cacheRead: 30,
    cacheWrite: 10,
    tokens: 150,
    calls: 1,
  })

  // Second call in the same minute must merge into the same bucket.
  await engine.recordUsage({ inputTokens: 20, outputTokens: 5, totalTokens: 25 })
  snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 175)
  assert.equal(snap.lifetime.tokens, 175)
  assert.equal(snap.lifetime.calls, 2)
  await flush(engine)
  const merged = readJson(stateFile).buckets[key]
  assert.equal(merged.tokens, 175)
  assert.equal(merged.input, 120)
  assert.equal(merged.output, 55)
  assert.equal(merged.calls, 2)
})

test('recordUsage derives tokens from input+output when totalTokens is absent', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.recordUsage({ inputTokens: 7, outputTokens: 3 })
  assert.equal(engine.snapshot().windows.h5.used, 10)
  assert.equal(engine.snapshot().lifetime.tokens, 10)
})

test('h5 rolling sum includes a bucket until it is exactly 5h old', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 150 })
  assert.equal(engine.snapshot().windows.h5.used, 150)
  assert.equal(engine.snapshot().windows.d7.used, 150)
  assert.equal(engine.snapshot().windows.h5.resetAt, T0 + H5_MS)
  assert.equal(engine.snapshot().windows.h5.resetInMs, H5_MS)

  clock.advance(5 * HOUR - 1)
  assert.equal(engine.snapshot().windows.h5.used, 150, 'bucket younger than 5h still counts')
  clock.advance(1) // bucket start is now exactly now - 5h → excluded (`>` comparison)
  const snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.h5.resetAt, null)
  assert.equal(snap.windows.h5.resetInMs, null)
  assert.equal(snap.windows.d7.used, 150, 'the 7d window still counts it')
})

test('d7 rolling sum includes a bucket until it is exactly 7d old', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 150 })
  clock.advance(7 * DAY - 1)
  assert.equal(engine.snapshot().windows.d7.used, 150)
  clock.advance(1)
  const snap = engine.snapshot()
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.windows.d7.resetAt, null)
  assert.equal(snap.windows.h5.used, 0)
})

test('pruning removes only buckets older than 7d + 1h', async (t) => {
  const { engine, clock, stateFile } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 100 }) // bucket at T0
  clock.advance(7 * DAY + 90 * MINUTE)
  const keptStart = Math.floor(clock.now() / MINUTE) * MINUTE
  await engine.recordUsage({ totalTokens: 40 }) // bucket at T0+7d+90m
  clock.advance(30 * MINUTE)
  await flush(engine)

  const buckets = readJson(stateFile).buckets
  assert.deepEqual(Object.keys(buckets), [String(keptStart / MINUTE)])
  assert.equal(buckets[String(keptStart / MINUTE)].tokens, 40)
})

test('lifetime counters are never reduced by window aging or reset cards', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 100 })
  clock.advance(8 * DAY)
  let snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 0, 'window naturally aged out')
  assert.equal(snap.windows.d7.used, 0, 'window naturally aged out')
  assert.equal(snap.lifetime.tokens, 100, 'lifetime survives window aging')

  await engine.useCard('d7')
  snap = engine.snapshot()
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.cards.held, 1)
  assert.equal(snap.lifetime.tokens, 100, 'card spends only window buckets, not lifetime')
})

test('setPlan({vendor, planId}) is vendor-scoped, validates pairings and keeps usage', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 250 })

  // claude/max20x -> claude/free
  await setPlanOn(engine, 'claude', 'free')
  let snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'free')
  assert.equal(snap.plan.vendorId, 'claude')
  assert.deepEqual(snap.plan.vendorName, { zh: 'Anthropic Claude', en: 'Anthropic Claude' })
  assert.deepEqual(snap.plan.limits, { h5: 150_000, d7: 1_000_000 })
  assert.equal(snap.plan.custom, false)
  assert.equal(snap.windows.h5.used, 250)
  assert.equal(snap.windows.d7.used, 250)
  assert.equal(snap.events[0].kind, 'plan')
  assert.equal(snap.events[0].message, 'claude/free', 'CONTRACT section 12: message is `${vendor}/${planId}`')

  // -> openai/go: vendor AND limits both change, usage still preserved.
  await setPlanOn(engine, 'openai', 'go')
  snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'openai')
  assert.deepEqual(snap.vendor.name, { zh: 'OpenAI ChatGPT', en: 'OpenAI ChatGPT' })
  assert.equal(snap.plan.id, 'go')
  assert.equal(snap.plan.vendorId, 'openai')
  assert.deepEqual(snap.plan.vendorName, { zh: 'OpenAI ChatGPT', en: 'OpenAI ChatGPT' })
  assert.deepEqual(snap.plan.limits, { h5: 500_000, d7: 4_000_000 })
  assert.equal(snap.windows.h5.limit, 500_000)
  assert.equal(snap.windows.d7.limit, 4_000_000)
  assert.equal(snap.windows.h5.used, 250, 'usage is not reset by a vendor/plan switch')
  assert.equal(snap.events[0].message, 'openai/go')

  // -> openai/promax: the top ChatGPT tier ($500, 60M/500M), usage still preserved.
  await setPlanOn(engine, 'openai', 'promax')
  snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'openai')
  assert.equal(snap.plan.id, 'promax')
  assert.equal(snap.plan.priceUSD, 500)
  assert.equal(snap.plan.vendorId, 'openai')
  assert.deepEqual(snap.plan.limits, { h5: 60_000_000, d7: 500_000_000 })
  assert.equal(snap.windows.h5.limit, 60_000_000)
  assert.equal(snap.windows.d7.limit, 500_000_000)
  assert.equal(snap.windows.h5.used, 250, 'usage is not reset by selecting Pro Max')
  assert.equal(snap.events[0].message, 'openai/promax')

  // -> claude/max20x: the big v2 limit.
  await setPlanOn(engine, 'claude', 'max20x')
  snap = engine.snapshot()
  assert.equal(snap.plan.limits.h5, 30_000_000)
  assert.equal(snap.plan.limits.d7, 300_000_000)
  assert.equal(snap.windows.h5.limit, 30_000_000)
  assert.equal(snap.windows.h5.used, 250, 'limits are pure functions of the new catalog')
})

test('setPlan rejects invalid vendor/plan inputs with unknown_plan and leaves state untouched', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 250 })
  const before = engine.snapshot()

  const invalidCalls = [
    [undefined, 'positional/undefined arg'],
    ['free', 'legacy v1 positional planId'],
    ['claude', 'legacy v1 positional vendor string'],
    [{}, 'empty object (both required)'],
    [{ planId: 'free' }, 'missing vendor'],
    [{ vendor: 'claude' }, 'missing planId'],
    [{ vendor: 'claude', planId: 'custom' }, 'custom is not selectable via set-plan'],
    [{ vendor: 'claude', planId: 'go' }, 'wrong pairing: claude has no go'],
    [{ vendor: 'claude', planId: 'plus' }, 'wrong pairing: claude has no plus'],
    [{ vendor: 'openai', planId: 'max20x' }, 'wrong pairing: openai has no max20x'],
    [{ vendor: 'openai', planId: 'max5x' }, 'wrong pairing: openai has no max5x'],
    [{ vendor: 'claude', planId: 'promax' }, 'wrong pairing: claude has no promax'],
    [{ vendor: 'nope', planId: 'free' }, 'unknown vendor'],
    [{ vendor: 'claude', planId: 'enterprise' }, 'unknown plan'],
    [{ vendor: 'claude', planId: 42 }, 'non-string planId'],
  ]
  for (const [input, label] of invalidCalls) {
    await assertFailure(() => engine.setPlan(input), 'unknown_plan', `setPlan(${label})`)
  }

  const after = engine.snapshot()
  assert.equal(after.vendor.id, before.vendor.id, 'rejected set-plan must not change the vendor')
  assert.equal(after.plan.id, before.plan.id, 'rejected set-plan must not change the plan')
  assert.deepEqual(after.plan.limits, before.plan.limits)
  assert.deepEqual(after.windows, before.windows)
  assert.deepEqual(after.events, before.events, 'rejected set-plan must not record an event')
})

test('setLimit switches to custom but keeps the current vendor', async (t) => {
  const { engine, stateFile } = await makeEngine(t)
  // Default vendor is claude; the other window keeps the current claude/max20x d7 limit.
  await engine.setLimit({ window: 'h5', tokens: 1234 })
  let snap = engine.snapshot()
  assert.equal(snap.plan.id, 'custom')
  assert.equal(snap.plan.custom, true)
  assert.equal(snap.vendor.id, 'claude', 'set-limit keeps the vendor (CONTRACT section 12)')
  assert.equal(snap.plan.vendorId, 'claude')
  assert.deepEqual(snap.plan.name, { zh: '自定义', en: 'Custom' })
  assert.equal(snap.plan.priceUSD, 0)
  assert.deepEqual(snap.plan.limits, { h5: 1234, d7: 300_000_000 })
  assert.equal(snap.events[0].kind, 'plan')

  // Selecting openai/plus then editing a limit keeps openai and the plus d7 limit.
  await setPlanOn(engine, 'openai', 'plus')
  await engine.setLimit({ window: 'h5', tokens: 100 })
  snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'openai', 'set-limit after a vendor switch keeps that vendor')
  assert.equal(snap.plan.id, 'custom')
  assert.equal(snap.plan.vendorId, 'openai')
  assert.deepEqual(snap.plan.limits, { h5: 100, d7: 20_000_000 })

  await engine.setLimit({ window: 'd7', tokens: 999_999 })
  snap = engine.snapshot()
  assert.deepEqual(snap.plan.limits, { h5: 100, d7: 999_999 })
  await flush(engine)
  const persisted = readJson(stateFile)
  assert.equal(persisted.vendor, 'openai', 'the selected vendor is persisted')
  assert.equal(persisted.plan, 'custom')
  assert.deepEqual(persisted.customLimits, { h5: 100, d7: 999_999 })
})

test('setLimit rejects invalid token counts and keeps state unchanged', async (t) => {
  const { engine } = await makeEngine(t)
  const before = engine.snapshot().plan
  for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_000_000_001]) {
    await assertFailure(() => engine.setLimit({ window: 'h5', tokens: bad }), 'invalid_limit', `setLimit h5 ${bad}`)
  }
  await assertFailure(() => engine.setLimit({ window: 'nope', tokens: 100 }), 'invalid_body', 'setLimit unknown window')
  const after = engine.snapshot().plan
  assert.equal(after.id, before.id)
  assert.deepEqual(after.limits, before.limits)
})

test('setWindows refuses to disable both windows', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setWindows({ h5: false })
  let snap = engine.snapshot()
  assert.equal(snap.windows.h5.enabled, false)
  assert.equal(snap.windows.d7.enabled, true)

  await assertFailure(() => engine.setWindows({ d7: false }), 'both_windows_disabled', 'disable last window')
  snap = engine.snapshot()
  assert.equal(snap.windows.h5.enabled, false, 'rejected mutation must not change state')
  assert.equal(snap.windows.d7.enabled, true)

  await assertFailure(
    () => engine.setWindows({ h5: false, d7: false }),
    'both_windows_disabled',
    'explicitly disable both',
  )

  await engine.setWindows({ h5: true })
  snap = engine.snapshot()
  assert.equal(snap.windows.h5.enabled, true)
  assert.equal(snap.windows.d7.enabled, true)
  assert.equal(snap.events[0].kind, 'windows')
})

test('claimCard respects claimBatch, claim cooldown and maxHeld', async (t) => {
  const rawConfig = {
    cards: { initialHeld: 0, maxHeld: 3, claimCooldownSeconds: 60, claimBatch: 2 },
  }
  const { engine, clock } = await makeEngine(t, { rawConfig })
  let snap = engine.snapshot()
  assert.equal(snap.cards.held, 0)
  assert.equal(snap.cards.claimBatch, 2)
  assert.equal(snap.cards.canClaim, true)
  assert.equal(snap.cards.cooldownRemainingMs, 0)

  await engine.claimCard()
  snap = engine.snapshot()
  assert.equal(snap.cards.held, 2, 'one claim grants claimBatch cards')
  assert.equal(snap.cards.canClaim, false)
  assert.equal(snap.cards.cooldownRemainingMs, 60_000)
  assert.equal(snap.events[0].kind, 'claim')

  await assertFailure(() => engine.claimCard(), 'claim_cooldown', 'claim during cooldown')

  clock.advance(30_000)
  assert.equal(engine.snapshot().cards.cooldownRemainingMs, 30_000)
  clock.advance(30_001)
  assert.equal(engine.snapshot().cards.canClaim, true)

  await engine.claimCard() // 2 + 2 capped at maxHeld 3
  assert.equal(engine.snapshot().cards.held, 3)
  await assertFailure(() => engine.claimCard(), 'max_held', 'claim at maxHeld')
})

test('useCard h5 clears only buckets inside the last 5h and decrements cards', async (t) => {
  const { engine, clock, stateFile } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 100 }) // bucket B0 at T0
  clock.advance(6 * HOUR)
  await engine.recordUsage({ totalTokens: 40 }) // bucket B1 at T0+6h
  let snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 40, 'only B1 is inside the 5h window')
  assert.equal(snap.windows.d7.used, 140)
  const lifetime = snap.lifetime.tokens
  const cards = snap.cards.held

  await engine.useCard('h5')
  snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.d7.used, 100, 'B0 (older than 5h) must survive an h5 card')
  assert.equal(snap.cards.held, cards - 1)
  assert.equal(snap.lifetime.tokens, lifetime)
  assert.equal(snap.events[0].kind, 'redeem')
  assert.equal(snap.events[0].window, 'h5')

  await flush(engine)
  const buckets = readJson(stateFile).buckets
  assert.deepEqual(Object.keys(buckets), [String(T0 / MINUTE)])
})

test('useCard d7 clears every bucket but keeps lifetime', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.recordUsage({ totalTokens: 100 })
  clock.advance(6 * HOUR)
  await engine.recordUsage({ totalTokens: 40 })
  const lifetime = engine.snapshot().lifetime.tokens
  const cards = engine.snapshot().cards.held

  await engine.useCard('d7')
  const snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.lifetime.tokens, lifetime)
  assert.equal(snap.cards.held, cards - 1)
})

test('useCard fails with no_cards when the inventory is empty', async (t) => {
  const { engine } = await makeEngine(t, { rawConfig: { cards: { initialHeld: 0 } } })
  await assertFailure(() => engine.useCard('h5'), 'no_cards', 'use card with empty inventory')
  assert.equal(engine.snapshot().cards.held, 0)
  assert.ok(!engine.snapshot().events.some((event) => event.kind === 'redeem'))
})

test('useCard auto targets the enabled window with the highest percent', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 1000 })
  await engine.recordUsage({ totalTokens: 900 }) // h5 90%, d7 0.0006%
  await engine.useCard('auto')
  const snap = engine.snapshot()
  assert.equal(snap.events[0].kind, 'redeem')
  assert.equal(snap.events[0].window, 'h5', 'auto must clear the most-used enabled window')
  // Buckets are shared by both windows, so clearing the h5 window clears this one bucket.
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.cards.held, 1)
})

test('useCard auto prefers an enabled over a disabled window', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 100 })
  await engine.recordUsage({ totalTokens: 900 }) // h5 exhausted (900%), d7 tiny
  await engine.setWindows({ h5: false })
  await engine.useCard('auto')
  const snap = engine.snapshot()
  assert.equal(snap.events[0].window, 'd7', 'the only enabled window is the auto target')
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.cards.held, 1)
})

test('simulateBlock blocks exactly once, records a hit, clears itself and persists the flag', async (t) => {
  const { engine, stateFile } = await makeEngine(t)
  assert.equal(blockedOf(await engine.consumeBlock({})), false, 'healthy account is not blocked')
  await engine.armSimulateBlock()
  assert.equal(engine.snapshot().simulateBlock, true)
  await flush(engine)
  assert.equal(readJson(stateFile).simulateBlock, true, 'armed flag must be durable')

  assert.equal(blockedOf(await engine.consumeBlock({})), true, 'first request after arming is blocked')
  assert.equal(engine.snapshot().simulateBlock, false, 'arming is consumed exactly once')
  const hit = engine.snapshot().lastHit
  assert.ok(hit, 'CONTRACT section 2: lastHit records the last request actually blocked')
  assert.equal(hit.window, 'h5')
  assert.equal(engine.snapshot().blocked, false, 'the diagnostic block does not fake exhaustion')

  assert.equal(blockedOf(await engine.consumeBlock({})), false, 'second request passes through')
  assert.equal(engine.snapshot().lastHit, null, 'the next passing request clears a diagnostic hit')
  await flush(engine)
  assert.equal(readJson(stateFile).simulateBlock, false)
  assert.equal(readJson(stateFile).lastHit, null)
})

test('a stale real lastHit self-heals after its window ages out', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 100 })
  await engine.recordUsage({ totalTokens: 150 })
  assert.equal(blockedOf(await engine.consumeBlock({})), true)
  assert.equal(engine.snapshot().lastHit?.window, 'h5')

  clock.advance(5 * HOUR + 1) // the h5 buckets age out; d7 is nowhere near exhausted
  const snap = engine.snapshot()
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.blocked, false)
  assert.equal(snap.lastHit, null, 'the exhausted banner must not outlive the exhaustion')
  assert.equal(blockedOf(await engine.consumeBlock({})), false)
})

test('exhausted enabled windows block requests; disabled windows do not', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 100 })
  await engine.recordUsage({ totalTokens: 120 })
  let snap = engine.snapshot()
  assert.equal(snap.windows.h5.exhausted, true)
  assert.equal(snap.blocked, true)
  assert.equal(snap.blockedWindow, 'h5')
  assert.equal(blockedOf(await engine.consumeBlock({})), true)
  assert.equal(engine.snapshot().lastHit?.window, 'h5', 'a blocked decision must record lastHit')
  assert.equal(engine.snapshot().events[0].kind, 'blocked')

  await engine.setWindows({ h5: false })
  snap = engine.snapshot()
  assert.equal(snap.windows.h5.exhausted, true, 'disabled window keeps its usage')
  assert.equal(snap.blocked, false, 'blocked only considers ENABLED windows')
  assert.equal(snap.blockedWindow, null)
  assert.equal(blockedOf(await engine.consumeBlock({})), false)
})

test('blocking picks the enabled window with the highest percent', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 1000 })
  await engine.recordUsage({ totalTokens: 900 })
  await engine.setLimit({ window: 'd7', tokens: 5000 })
  await engine.recordUsage({ totalTokens: 200 }) // h5 110%, d7 22%
  await engine.recordUsage({ totalTokens: 50 }) // h5 115%, d7 23%
  const snap = engine.snapshot()
  assert.equal(snap.windows.h5.percent, 115)
  assert.equal(snap.windows.d7.percent, 23)
  assert.equal(snap.blocked, true)
  assert.equal(snap.blockedWindow, 'h5', 'the enabled window with the highest percent is blamed')
})

test('dismissHit clears only lastHit, not the exhausted state', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 100 })
  await engine.recordUsage({ totalTokens: 120 })
  clock.advance(1)
  assert.equal(blockedOf(await engine.consumeBlock({})), true)
  const hit = engine.snapshot().lastHit
  assert.ok(hit, 'blocked request records lastHit')
  assert.equal(hit.window, 'h5')
  assert.equal(typeof hit.at, 'number')
  assert.equal(typeof hit.seq, 'number')

  await engine.dismissHit()
  const snap = engine.snapshot()
  assert.equal(snap.lastHit, null, 'dismiss-hit clears the banner state')
  assert.equal(snap.windows.h5.exhausted, true, 'quota stays exhausted after dismiss')
  assert.equal(snap.blocked, true, 'still blocked for real requests')
})

test('resetAll clears quota/hit/events and restores cards while keeping vendor/plan/windows/settings', async (t) => {
  const { engine } = await makeEngine(t, {
    rawConfig: { vendor: 'openai', plan: 'plus', windows: { h5: true, d7: true } },
  })
  assert.equal(engine.snapshot().vendor.id, 'openai')
  await engine.setLimit({ window: 'h5', tokens: 100 }) // custom plan, keeps openai, d7 = plus 20M
  await engine.recordUsage({ totalTokens: 150 }) // exhausted
  assert.equal(blockedOf(await engine.consumeBlock({})), true)
  await engine.armSimulateBlock()
  await engine.setWindows({ h5: true, d7: false })
  await engine.useCard('h5') // spends one card, clears the h5 window
  await engine.recordUsage({ totalTokens: 10 }) // non-zero lifetime to clear

  await engine.resetAll()
  const snap = engine.snapshot()
  assert.equal(snap.lifetime.tokens, 0)
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.windows.d7.used, 0)
  assert.equal(snap.lastHit, null)
  assert.equal(snap.simulateBlock, false)
  assert.equal(snap.cards.held, snap.settings.cards.initialHeld, 'cards restored to initialHeld')
  assert.equal(snap.vendor.id, 'openai', 'resetAll keeps the vendor')
  assert.equal(snap.plan.id, 'custom', 'resetAll keeps the active plan id')
  assert.equal(snap.plan.vendorId, 'openai')
  assert.deepEqual(snap.plan.limits, { h5: 100, d7: 20_000_000 }, 'resetAll keeps custom limits')
  assert.equal(snap.windows.h5.enabled, true, 'resetAll keeps window flags')
  assert.equal(snap.windows.d7.enabled, false)
  assert.equal(snap.settings.enforce, true)
  assert.ok(snap.events.length <= 1, 'events are cleared and only the reset event remains')
  assert.ok(snap.events.every((event) => event.kind === 'reset'))
})

test('reload from the same state file preserves vendor, quota, plan, windows and cards', async (t) => {
  const dir = makeTempDir(t)
  const clock = makeClock()
  const rawConfig = { vendor: 'openai', plan: 'plus', cards: { initialHeld: 1, claimCooldownSeconds: 10 } }
  const first = await makeEngine(t, { dir, clock, rawConfig })
  await first.engine.recordUsage({ inputTokens: 70, outputTokens: 50, totalTokens: 120 })
  await first.engine.claimCard()
  await first.engine.setWindows({ h5: true, d7: false })
  await first.engine.close?.()
  const expected = first.engine.snapshot()
  assert.equal(expected.cards.held, 2)

  const second = await makeEngine(t, { dir, clock, rawConfig })
  const reloaded = second.engine.snapshot()
  assert.equal(reloaded.vendor.id, 'openai', 'the vendor survives a restart')
  assert.equal(reloaded.plan.id, 'plus')
  assert.equal(reloaded.plan.vendorId, 'openai')
  assert.deepEqual(reloaded.plan.limits, { h5: 2_500_000, d7: 20_000_000 })
  assert.equal(reloaded.windows.h5.enabled, true)
  assert.equal(reloaded.windows.d7.enabled, false)
  assert.equal(reloaded.windows.h5.used, 120)
  assert.equal(reloaded.lifetime.tokens, 120)
  assert.equal(reloaded.cards.held, 2)
  assert.ok(reloaded.cards.cooldownRemainingMs > 0, 'claimAt/cooldown survives the restart')
  assert.equal(reloaded.lastHit, null)
})

test('corrupt state file is renamed aside and replaced by fresh claude/max20x state without throwing', async (t) => {
  const dir = makeTempDir(t)
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, '{ this is not valid json')
  const logs = []
  const { engine } = await makeEngine(t, { dir, stateFile, log: (...args) => logs.push(args) })

  const snap = engine.snapshot()
  assertSnapshotShape(snap)
  assert.equal(snap.vendor.id, 'claude', 'corrupt file falls back to the default vendor')
  assert.equal(snap.plan.id, 'max20x', 'corrupt file falls back to the default plan')
  assert.equal(snap.lifetime.tokens, 0)
  assert.equal(snap.cards.held, 2)
  const corrupt = readdirSync(dir).filter((name) => name.startsWith('state.json.corrupt-'))
  assert.equal(corrupt.length, 1, 'corrupt file must be renamed to <file>.corrupt-<ts>')
  assert.ok(logs.length >= 1, 'recovery must be logged, not silent')
})

test('structurally invalid but parseable state does not crash activation', async (t) => {
  const dir = makeTempDir(t)
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ version: 99, plan: 'enterprise', buckets: 'nope' }))
  const { engine } = await makeEngine(t, { dir, stateFile })
  const snap = engine.snapshot()
  assertSnapshotShape(snap)
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')
  assert.equal(snap.windows.h5.used, 0)
  assert.equal(snap.lifetime.tokens, 0)
})

test('state writes are atomic: no temp files remain and the file is always parseable JSON', async (t) => {
  const { engine, dir } = await makeEngine(t)
  for (let i = 1; i <= 20; i += 1) await engine.recordUsage({ totalTokens: i })
  await flush(engine)
  const persisted = readJson(join(dir, 'state.json')) // throws on partial JSON
  assert.equal(persisted.lifetime.tokens, 210, 'every usage record reached the state file')
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [], 'atomic write must not leave .tmp-* files behind')
})

test('snapshot derives window fields exactly as CONTRACT section 3/12 specifies', async (t) => {
  const { engine, clock } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 1000 }) // custom: h5 1000, d7 = claude max20x 300M
  await engine.recordUsage({ inputTokens: 200, outputTokens: 51, totalTokens: 251 })
  const snap = engine.snapshot()
  const bucketStart = Math.floor(clock.now() / MINUTE) * MINUTE

  assert.equal(snap.serverNow, clock.now())
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'custom')
  assert.equal(snap.plan.custom, true)
  assert.equal(snap.plan.vendorId, 'claude')
  assert.deepEqual(snap.plan.limits, { h5: 1000, d7: 300_000_000 })
  assert.equal(snap.windows.h5.windowMs, H5_MS)
  assert.equal(snap.windows.d7.windowMs, D7_MS)
  assert.equal(snap.windows.h5.used, 251)
  assert.equal(snap.windows.h5.limit, 1000)
  assert.equal(snap.windows.h5.remaining, 749)
  assert.equal(snap.windows.h5.percent, 25.1)
  assert.equal(snap.windows.h5.exhausted, false)
  assert.equal(snap.windows.h5.resetAt, bucketStart + H5_MS)
  assert.equal(snap.windows.h5.resetInMs, H5_MS - (clock.now() - bucketStart))
  assert.equal(snap.blocked, false)
  assert.equal(snap.blockedWindow, null)
  assert.equal(snap.cards.held, 2)

  await engine.recordUsage({ totalTokens: 800 }) // 1051 > 1000
  const exhausted = engine.snapshot()
  assert.equal(exhausted.windows.h5.exhausted, true)
  assert.equal(exhausted.windows.h5.percent, 105.1, 'percent may exceed 100 and is rounded to one decimal')
  assert.ok(exhausted.windows.h5.remaining <= 0, 'remaining may not claim headroom when exhausted')
  assert.equal(exhausted.blocked, true)
  assert.equal(exhausted.blockedWindow, 'h5')
})

test('snapshot vendors list is exactly the two documented catalogs (no flat plans field)', async (t) => {
  const { engine } = await makeEngine(t)
  const snap = engine.snapshot()
  assert.equal('plans' in snap, false, 'v2 removes the old top-level snapshot.plans field')
  assert.equal(snap.vendors.length, 2)
  assert.deepEqual(
    snap.vendors.map((vendor) => vendor.id),
    ['claude', 'openai'],
  )
  const claude = snap.vendors.find((vendor) => vendor.id === 'claude')
  const openai = snap.vendors.find((vendor) => vendor.id === 'openai')
  assert.deepEqual(
    claude.plans.map((plan) => plan.id),
    ['free', 'pro', 'max5x', 'max20x'],
  )
  assert.deepEqual(
    openai.plans.map((plan) => plan.id),
    ['free', 'go', 'plus', 'pro', 'promax'],
  )
  assert.equal(openai.plans.length, 5, 'snapshot lists the five ChatGPT personal tiers (incl. Pro Max)')
  // The snapshot catalogs must mirror the exported VENDORS (names/prices/limits).
  for (const vendor of VENDORS) {
    const listed = snap.vendors.find((entry) => entry.id === vendor.id)
    assert.ok(listed, `snapshot.vendors must list ${vendor.id}`)
    assert.deepEqual(listed.name, vendor.name)
    assert.deepEqual(listed.note, vendor.note)
    for (const plan of vendor.plans) {
      const listedPlan = listed.plans.find((entry) => entry.id === plan.id)
      assert.ok(listedPlan, `snapshot.vendors[${vendor.id}].plans must list ${plan.id}`)
      assert.deepEqual(listedPlan.limits, plan.limits)
      assert.equal(listedPlan.priceUSD, plan.priceUSD)
      assert.deepEqual(listedPlan.name, plan.name)
    }
  }
  assert.deepEqual(vendorPlanPairs(snap.vendors).length, 9, 'Claude 4 + ChatGPT 5 = nine plans total')
  // The active plan is inside its vendor's catalog (custom excepted).
  assert.ok(claude.plans.some((plan) => plan.id === snap.plan.id))
})

test('events are newest-first and bounded to 30 entries', async (t) => {
  const { engine } = await makeEngine(t)
  for (let i = 0; i < 35; i += 1) await engine.setSettings({ enforce: i % 2 === 0 })
  const snap = engine.snapshot()
  assert.equal(snap.events.length, 30, 'events log must be capped at 30')
  for (let i = 1; i < snap.events.length; i += 1) {
    assert.ok(snap.events[i - 1].at >= snap.events[i].at, 'events must be newest-first')
  }
})

test('enforce=false fails open and countAuxiliary=false frees auxiliary calls', async (t) => {
  const { engine } = await makeEngine(t)
  await engine.setLimit({ window: 'h5', tokens: 100 })
  await engine.recordUsage({ totalTokens: 120 })
  assert.equal(blockedOf(await engine.consumeBlock({})), true)

  await engine.setSettings({ enforce: false })
  assert.equal(blockedOf(await engine.consumeBlock({})), false, 'enforce=false must never block')
  await engine.setSettings({ enforce: true })

  await engine.setSettings({ countAuxiliary: false })
  const before = engine.snapshot().lifetime.tokens
  await engine.recordUsage({ totalTokens: 50 }, { purpose: 'compaction' })
  assert.equal(engine.snapshot().lifetime.tokens, before, 'auxiliary calls are free when countAuxiliary=false')
  assert.equal(blockedOf(await engine.consumeBlock({ purpose: 'compaction' })), false)
  assert.equal(blockedOf(await engine.consumeBlock({ purpose: 'session-title' })), false)
  assert.equal(blockedOf(await engine.consumeBlock({ sessionId: 'abc', purpose: undefined })), true)

  await engine.setSettings({ countAuxiliary: true })
  await engine.recordUsage({ totalTokens: 50 }, { purpose: 'compaction' })
  assert.equal(engine.snapshot().lifetime.tokens, before + 50, 'auxiliary calls count when countAuxiliary=true')
  assert.equal(blockedOf(await engine.consumeBlock({ purpose: 'compaction' })), true)
})

test('default state file lives under DSH_HOME/plugin-data/dsh-subscription-sim', async (t) => {
  const dir = makeTempDir(t)
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  let engine
  try {
    const config = normalizeConfig({})
    assert.equal(typeof config, 'object')
    engine = await createEngine({ now: () => T0, config, log: () => {} })
    const snap = engine.snapshot()
    assert.equal(snap.storage.stateFile, join(dir, 'plugin-data', 'dsh-subscription-sim', 'state.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    try {
      await engine?.close?.()
    } catch {
      /* ignore */
    }
  }
})

test('normalizeConfig output is accepted by createEngine (smoke)', async (t) => {
  const config = normalizeConfig({
    vendor: 'enterprise',
    plan: 'not-a-plan',
    windows: { h5: false, d7: false },
    cards: { maxHeld: -3, claimBatch: 0 },
  })
  assert.equal(typeof configValue(config, 'enforce'), 'boolean')
  const dir = makeTempDir(t)
  const engine = await createEngine({ now: () => T0, stateFile: join(dir, 'state.json'), config })
  const snap = engine.snapshot()
  assertSnapshotShape(snap)
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')
  await engine.close?.()
})

// ---------------------------------------------------------------------------
// v1 -> v2 migration matrix (CONTRACT section 11)
// ---------------------------------------------------------------------------

/** A v1 record populated with distinguishable usage/counters that must survive migration. */
function populatedV1(overrides = {}) {
  return v1State({
    buckets: {
      [String(T0 / MINUTE)]: { input: 300, output: 200, cacheRead: 0, cacheWrite: 0, tokens: 500, calls: 5 },
    },
    lifetime: { tokens: 900, input: 500, output: 400, calls: 9, since: T0 - DAY },
    cards: 4,
    customLimits: { h5: 777, d7: 888 },
    events: [{ at: T0 - 1000, kind: 'claim' }],
    ...overrides,
  })
}

/** Assert the usage/counters a migration must preserve exactly (CONTRACT section 11). */
function assertUsagePreserved(snap, label) {
  assert.equal(snap.windows.h5.used, 500, `${label}: h5 bucket usage preserved`)
  assert.equal(snap.windows.d7.used, 500, `${label}: d7 bucket usage preserved`)
  assert.equal(snap.lifetime.tokens, 900, `${label}: lifetime tokens preserved`)
  assert.equal(snap.lifetime.input, 500, `${label}: lifetime input preserved`)
  assert.equal(snap.lifetime.output, 400, `${label}: lifetime output preserved`)
  assert.equal(snap.lifetime.calls, 9, `${label}: lifetime calls preserved`)
  assert.equal(snap.cards.held, 4, `${label}: cards preserved`)
}

test('migration matrix: legacy plan ids resolve to the documented vendor/plan pairs', async (t) => {
  const cases = [
    { plan: 'max20x', vendor: 'claude', limits: { h5: 30_000_000, d7: 300_000_000 } },
    { plan: 'max5x', vendor: 'claude', limits: { h5: 8_000_000, d7: 80_000_000 } },
    { plan: 'free', vendor: 'claude', limits: { h5: 150_000, d7: 1_000_000 } },
    { plan: 'pro', vendor: 'claude', limits: { h5: 2_000_000, d7: 20_000_000 } },
    { plan: 'plus', vendor: 'openai', limits: { h5: 2_500_000, d7: 20_000_000 } },
    { plan: 'go', vendor: 'openai', limits: { h5: 500_000, d7: 4_000_000 } },
  ]
  for (const entry of cases) {
    const { engine } = await bootFromState(t, populatedV1({ plan: entry.plan }))
    const snap = engine.snapshot()
    assertSnapshotShape(snap)
    assert.equal(snap.version, 2, `${entry.plan}: migrated snapshot must be version 2`)
    assert.equal(snap.vendor.id, entry.vendor, `${entry.plan}: inferred vendor`)
    assert.equal(snap.plan.id, entry.plan, `${entry.plan}: plan id preserved`)
    assert.equal(snap.plan.vendorId, entry.vendor)
    assert.deepEqual(snap.plan.limits, entry.limits, `${entry.plan}: new catalog limits apply`)
    assert.equal(snap.windows.h5.limit, entry.limits.h5, `${entry.plan}: live window limit follows the new catalog`)
    assertUsagePreserved(snap, entry.plan)
  }
})

test('migration: legacy max20x exposes the bigger v2 claude h5 limit (30,000,000)', async (t) => {
  const { engine, stateFile } = await bootFromState(t, populatedV1({ plan: 'max20x' }))
  const snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')
  assert.equal(snap.plan.limits.h5, 30_000_000, 'CONTRACT section 11: the bigger v2 Max 20x h5 limit takes effect on reload')
  assert.equal(snap.plan.limits.d7, 300_000_000)
  assert.equal(snap.windows.h5.limit, 30_000_000)

  // The migration is persisted as version 2 on the next save.
  await flush(engine)
  const persisted = readJson(stateFile)
  assertPersistedShape(persisted)
  assert.equal(persisted.vendor, 'claude')
  assert.equal(persisted.plan, 'max20x')
  assert.deepEqual(persisted.customLimits, { h5: 777, d7: 888 }, 'customLimits preserved by the migration')
})

test('migration: legacy custom keeps the custom limits and resolves to claude', async (t) => {
  const { engine } = await bootFromState(t, populatedV1({ plan: 'custom', customLimits: { h5: 1234, d7: 999 } }))
  const snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'claude', 'custom resolves under the default vendor when no vendor is stored')
  assert.equal(snap.plan.id, 'custom')
  assert.equal(snap.plan.custom, true)
  assert.deepEqual(snap.plan.limits, { h5: 1234, d7: 999 })
  assertUsagePreserved(snap, 'custom')
})

test('migration: no vendor field on an otherwise-fresh v1 record', async (t) => {
  const record = v1State()
  delete record.vendor
  const { engine } = await bootFromState(t, record)
  const snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')
  assert.deepEqual(snap.plan.limits, { h5: 30_000_000, d7: 300_000_000 })
})

test('migration: unknown legacy plan falls back to the default claude/max20x pair', async (t) => {
  const { engine } = await bootFromState(t, populatedV1({ plan: 'enterprise' }))
  const snap = engine.snapshot()
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')
  assertUsagePreserved(snap, 'unknown plan')
})

test('migration: an explicit valid vendor wins, then the plan is validated inside it', async (t) => {
  // Valid vendor + valid plan pair: kept.
  const kept = await bootFromState(t, populatedV1({ vendor: 'openai', plan: 'pro' }))
  let snap = kept.engine.snapshot()
  assert.equal(snap.vendor.id, 'openai')
  assert.equal(snap.plan.id, 'pro')
  assert.deepEqual(snap.plan.limits, { h5: 30_000_000, d7: 250_000_000 })

  // Valid vendor + plan that does not exist in it: fallback to claude/max20x.
  const wrongPairing = await bootFromState(t, populatedV1({ vendor: 'claude', plan: 'plus' }))
  snap = wrongPairing.engine.snapshot()
  assert.equal(snap.vendor.id, 'claude', 'invalid pair falls back to DEFAULT_VENDOR')
  assert.equal(snap.plan.id, 'max20x', 'invalid pair falls back to DEFAULT_PLAN')

  const wrongPairing2 = await bootFromState(t, populatedV1({ vendor: 'openai', plan: 'max5x' }))
  snap = wrongPairing2.engine.snapshot()
  assert.equal(snap.vendor.id, 'claude')
  assert.equal(snap.plan.id, 'max20x')

  const badVendor = await bootFromState(t, populatedV1({ vendor: 'nope', plan: 'max20x' }))
  snap = badVendor.engine.snapshot()
  assert.equal(snap.vendor.id, 'claude', 'invalid vendor is ignored and inferred from the plan')
  assert.equal(snap.plan.id, 'max20x')
})

test('migration: already-v2 records stay unchanged', async (t) => {
  const v2record = {
    version: 2,
    vendor: 'openai',
    plan: 'pro',
    customLimits: { h5: 0, d7: 0 },
    windows: { h5: true, d7: true },
    settings: { enforce: true, countAuxiliary: true },
    buckets: {
      [String(T0 / MINUTE)]: { input: 300, output: 200, cacheRead: 0, cacheWrite: 0, tokens: 500, calls: 5 },
    },
    lifetime: { tokens: 900, input: 500, output: 400, calls: 9, since: T0 - DAY },
    cards: 4,
    claimAt: 0,
    lastHit: null,
    simulateBlock: false,
    events: [],
  }
  const { engine } = await bootFromState(t, v2record)
  const snap = engine.snapshot()
  assert.equal(snap.version, 2)
  assert.equal(snap.vendor.id, 'openai')
  assert.equal(snap.plan.id, 'pro')
  assert.deepEqual(snap.plan.limits, { h5: 30_000_000, d7: 250_000_000 })
  assertUsagePreserved(snap, 'already-v2')

  // And a v2 claude record also stays put.
  const claudeRecord = { ...v2record, vendor: 'claude', plan: 'max5x' }
  const second = await bootFromState(t, claudeRecord)
  const secondSnap = second.engine.snapshot()
  assert.equal(secondSnap.vendor.id, 'claude')
  assert.equal(secondSnap.plan.id, 'max5x')
  assert.deepEqual(secondSnap.plan.limits, { h5: 8_000_000, d7: 80_000_000 })
})

test('migration: malformed v1/v2 records never throw and always yield a valid v2 snapshot', async (t) => {
  const records = [
    { version: 1, plan: null, buckets: 'nope', windows: 'nope', settings: 7, cards: -5, lifetime: [] },
    { version: 2, vendor: 42, plan: 42, buckets: ['x'], lifetime: null, events: 'nope' },
    { version: 'two', vendor: 'claude', plan: 'free' },
    { version: 1, plan: 'max20x', windows: { h5: false, d7: false } },
    { version: 1, plan: 'custom', customLimits: 'nope' },
  ]
  for (const record of records) {
    const { engine } = await bootFromState(t, record)
    const snap = engine.snapshot()
    assertSnapshotShape(snap)
    assert.ok(['claude', 'openai'].includes(snap.vendor.id))
    assert.equal(typeof snap.plan.id, 'string')
    assert.equal(snap.windows.h5.enabled || snap.windows.d7.enabled, true, 'at least one window stays enabled')
    assert.equal(snap.lifetime.tokens, 0)
    assert.equal(snap.windows.h5.used, 0)
  }
})

test('migration: malformed top-level values (null/array/string) start fresh without throwing', async (t) => {
  for (const raw of [null, [], 'a string', 42]) {
    const dir = makeTempDir(t)
    const { engine } = await bootFromState(t, JSON.stringify(raw), { dir })
    const snap = engine.snapshot()
    assertSnapshotShape(snap)
    assert.equal(snap.vendor.id, 'claude')
    assert.equal(snap.plan.id, 'max20x')
  }
})
