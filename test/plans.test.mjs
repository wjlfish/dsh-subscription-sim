// Unit tests for lib/plans.js against CONTRACT.md v2 section 10 (vendor catalogs),
// plus the unchanged pure window/config helpers from sections 2-3.
//
// The v2 catalog is asserted exactly as documented: Claude has four tiers and OpenAI
// ChatGPT has five (Free / Go / Plus / Pro / Pro Max, the 2026-10 refinement); prices
// and simulated limits are identical to the CONTRACT code block. Plan ids are only
// unique within a vendor, so every lookup here is vendor-scoped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plans from '../lib/plans.js'
import { configValue } from './_support.test.mjs'

const VENDOR_CATALOG = [
  {
    id: 'claude',
    name: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
    note: { zh: '5 小时会话额度 + 每周额度', en: '5-hour session limit + weekly limit' },
    plans: [
      { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 150_000, d7: 1_000_000 } },
      { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 20, limits: { h5: 2_000_000, d7: 20_000_000 } },
      { id: 'max5x', name: { zh: 'Max 5×', en: 'Max 5×' }, priceUSD: 100, limits: { h5: 8_000_000, d7: 80_000_000 } },
      {
        id: 'max20x',
        name: { zh: 'Max 20×', en: 'Max 20×' },
        priceUSD: 200,
        limits: { h5: 30_000_000, d7: 300_000_000 },
      },
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
      { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 100_000, d7: 800_000 } },
      { id: 'go', name: { zh: 'Go', en: 'Go' }, priceUSD: 8, limits: { h5: 500_000, d7: 4_000_000 } },
      { id: 'plus', name: { zh: 'Plus', en: 'Plus' }, priceUSD: 20, limits: { h5: 2_500_000, d7: 20_000_000 } },
      { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 200, limits: { h5: 30_000_000, d7: 250_000_000 } },
      {
        id: 'promax',
        name: { zh: 'Pro Max', en: 'Pro Max' },
        priceUSD: 500,
        limits: { h5: 60_000_000, d7: 500_000_000 },
      },
    ],
  },
]

const pick = (config, key) => {
  if (!config || typeof config !== 'object') return undefined
  if (key in config) return config[key]
  return config.settings?.[key]
}
const pickCards = (config) => pick(config, 'cards') ?? {}
const pickWindows = (config) => pick(config, 'windows') ?? {}

test('VENDORS is exactly the documented two-vendor catalog (CONTRACT section 10)', () => {
  assert.ok(Array.isArray(plans.VENDORS), 'VENDORS must be exported as an array')
  assert.equal(plans.VENDORS.length, 2, 'exactly two vendors: claude and openai')
  assert.deepEqual(
    plans.VENDORS.map((vendor) => vendor.id),
    ['claude', 'openai'],
  )
  assert.deepEqual(plans.VENDORS, VENDOR_CATALOG, 'vendor/plan names, prices and limits must match CONTRACT section 10')

  const claude = plans.VENDORS.find((vendor) => vendor.id === 'claude')
  const openai = plans.VENDORS.find((vendor) => vendor.id === 'openai')
  assert.deepEqual(
    claude.plans.map((plan) => plan.id),
    ['free', 'pro', 'max5x', 'max20x'],
  )
  assert.deepEqual(
    openai.plans.map((plan) => plan.id),
    ['free', 'go', 'plus', 'pro', 'promax'],
  )
  assert.equal(openai.plans.length, 5, 'ChatGPT now has five personal tiers (CONTRACT refinement)')
  const promax = openai.plans.find((plan) => plan.id === 'promax')
  assert.deepEqual(promax, {
    id: 'promax',
    name: { zh: 'Pro Max', en: 'Pro Max' },
    priceUSD: 500,
    limits: { h5: 60_000_000, d7: 500_000_000 },
  })
  // Plan ids are only unique within a vendor: the same id exists twice with different limits.
  const claudeFree = claude.plans.find((plan) => plan.id === 'free')
  const openaiFree = openai.plans.find((plan) => plan.id === 'free')
  assert.notDeepEqual(claudeFree.limits, openaiFree.limits)
  for (const vendor of plans.VENDORS) {
    assert.ok(vendor.name.zh.length > 0 && vendor.name.en.length > 0, `${vendor.id}: bilingual name`)
    assert.ok(vendor.note.zh.length > 0 && vendor.note.en.length > 0, `${vendor.id}: bilingual note`)
    for (const plan of vendor.plans) {
      assert.ok(Number.isInteger(plan.priceUSD) && plan.priceUSD >= 0, `${vendor.id}/${plan.id}: price`)
      assert.ok(Number.isInteger(plan.limits.h5) && plan.limits.h5 > 0, `${vendor.id}/${plan.id}: h5 limit`)
      assert.ok(Number.isInteger(plan.limits.d7) && plan.limits.d7 > 0, `${vendor.id}/${plan.id}: d7 limit`)
      assert.ok(plan.limits.h5 < plan.limits.d7, `${vendor.id}/${plan.id}: h5 limit must be tighter than d7`)
    }
  }
})

test('DEFAULT_VENDOR / DEFAULT_PLAN / CUSTOM_PLAN match CONTRACT section 10', () => {
  assert.equal(plans.DEFAULT_VENDOR, 'claude')
  assert.equal(plans.DEFAULT_PLAN, 'max20x')
  assert.equal(plans.DEFAULT_PLAN, 'max20x', 'a fresh install must not lock the operator out')
  assert.equal(plans.CUSTOM_PLAN.id, 'custom')
  assert.deepEqual(plans.CUSTOM_PLAN.name, { zh: '自定义', en: 'Custom' })
  assert.equal(plans.CUSTOM_PLAN.priceUSD, 0)
})

test('vendor-scoped lookups: findPlan only matches a plan inside its own vendor', () => {
  assert.equal(typeof plans.vendorById, 'function', 'vendorById(vendorId) is part of the v2 catalog helpers')
  assert.equal(plans.vendorById('claude')?.name?.zh, 'Anthropic Claude')
  assert.equal(plans.vendorById('openai')?.name?.zh, 'OpenAI ChatGPT')
  assert.equal(plans.vendorById('nope'), undefined)

  assert.equal(typeof plans.findPlan, 'function', 'findPlan(vendorId, planId) is named by CONTRACT section 10')
  assert.equal(plans.findPlan('claude', 'max20x').limits.h5, 30_000_000)
  assert.equal(plans.findPlan('claude', 'max20x').limits.d7, 300_000_000)
  assert.equal(plans.findPlan('claude', 'free').limits.h5, 150_000)
  assert.equal(plans.findPlan('openai', 'free').limits.h5, 100_000)
  assert.equal(plans.findPlan('openai', 'go').limits.d7, 4_000_000)
  assert.equal(plans.findPlan('openai', 'plus').priceUSD, 20)
  assert.equal(plans.findPlan('openai', 'pro').limits.h5, 30_000_000)
  assert.equal(plans.findPlan('openai', 'promax').priceUSD, 500)
  assert.deepEqual(plans.findPlan('openai', 'promax').limits, { h5: 60_000_000, d7: 500_000_000 })
  assert.deepEqual(plans.findPlan('openai', 'promax').name, { zh: 'Pro Max', en: 'Pro Max' })
  // Cross-vendor pairings must not resolve.
  assert.ok(!plans.findPlan('claude', 'go'), 'claude has no go plan')
  assert.ok(!plans.findPlan('claude', 'plus'), 'claude has no plus plan')
  assert.ok(!plans.findPlan('claude', 'promax'), 'claude has no promax plan')
  assert.ok(!plans.findPlan('openai', 'max5x'), 'openai has no max5x plan')
  assert.ok(!plans.findPlan('openai', 'max20x'), 'openai has no max20x plan')
  assert.ok(!plans.findPlan('claude', 'nope'))
  assert.ok(!plans.findPlan('nope', 'free'))
})

test('effectiveLimits is vendor-scoped and custom reads global customLimits', () => {
  assert.equal(typeof plans.effectiveLimits, 'function', 'effectiveLimits(vendorId, planId, customLimits)')
  assert.deepEqual(plans.effectiveLimits('claude', 'max20x', null), { h5: 30_000_000, d7: 300_000_000 })
  assert.deepEqual(plans.effectiveLimits('claude', 'max5x', null), { h5: 8_000_000, d7: 80_000_000 })
  assert.deepEqual(plans.effectiveLimits('openai', 'go', null), { h5: 500_000, d7: 4_000_000 })
  assert.deepEqual(plans.effectiveLimits('openai', 'pro', {}), { h5: 30_000_000, d7: 250_000_000 })
  assert.deepEqual(plans.effectiveLimits('openai', 'promax', null), { h5: 60_000_000, d7: 500_000_000 })
  assert.deepEqual(plans.effectiveLimits('openai', 'promax', {}), { h5: 60_000_000, d7: 500_000_000 })
  assert.deepEqual(plans.effectiveLimits('claude', 'free', null), { h5: 150_000, d7: 1_000_000 })
  assert.deepEqual(plans.effectiveLimits('openai', 'free', null), { h5: 100_000, d7: 800_000 })

  // `custom` is available under either vendor and reads the same global customLimits.
  assert.deepEqual(plans.effectiveLimits('claude', 'custom', { h5: 1234, d7: 999 }), { h5: 1234, d7: 999 })
  assert.deepEqual(plans.effectiveLimits('openai', 'custom', { h5: 1234, d7: 999 }), { h5: 1234, d7: 999 })
  assert.deepEqual(plans.effectiveLimits('claude', 'custom', null), { h5: 0, d7: 0 })
  assert.deepEqual(plans.effectiveLimits('claude', 'custom', { h5: -1 }), { h5: 0, d7: 0 })
})

test('planDescriptor is vendor-scoped and snapshot-ready', () => {
  assert.equal(typeof plans.planDescriptor, 'function', 'planDescriptor(vendorId, planId, customLimits)')
  const go = plans.planDescriptor('openai', 'go', null)
  assert.equal(go.id, 'go')
  assert.deepEqual(go.name, { zh: 'Go', en: 'Go' })
  assert.equal(go.priceUSD, 8)
  assert.deepEqual(go.limits, { h5: 500_000, d7: 4_000_000 })

  const promax = plans.planDescriptor('openai', 'promax', null)
  assert.equal(promax.id, 'promax')
  assert.deepEqual(promax.name, { zh: 'Pro Max', en: 'Pro Max' })
  assert.equal(promax.priceUSD, 500)
  assert.deepEqual(promax.limits, { h5: 60_000_000, d7: 500_000_000 })

  const max20x = plans.planDescriptor('claude', 'max20x', null)
  assert.equal(max20x.id, 'max20x')
  assert.deepEqual(max20x.limits, { h5: 30_000_000, d7: 300_000_000 })

  const custom = plans.planDescriptor('openai', 'custom', { h5: 1, d7: 2 })
  assert.equal(custom.id, 'custom')
  assert.deepEqual(custom.name, { zh: '自定义', en: 'Custom' })
  assert.equal(custom.priceUSD, 0)
  assert.deepEqual(custom.limits, { h5: 1, d7: 2 })
})

test('WINDOW_MS exposes the rolling 5h and 7d windows', () => {
  assert.deepEqual(plans.WINDOW_MS, { h5: 18_000_000, d7: 604_800_000 })
  assert.equal(plans.WINDOW_MS.h5, 5 * 60 * 60 * 1000)
  assert.equal(plans.WINDOW_MS.d7, 7 * 24 * 60 * 60 * 1000)
})

test('DEFAULT_CONFIG matches the documented defaults (v2 adds vendor)', () => {
  const def = plans.DEFAULT_CONFIG
  assert.ok(def && typeof def === 'object', 'DEFAULT_CONFIG must be exported as an object')
  assert.equal(pick(def, 'vendor'), 'claude', 'v2 config defaults to the claude catalog')
  assert.equal(pick(def, 'plan') ?? pick(def, 'planId'), 'max20x')
  assert.equal(pickWindows(def).h5, true)
  assert.equal(pickWindows(def).d7, true)
  const enforce = configValue(def, 'enforce')
  const countAuxiliary = configValue(def, 'countAuxiliary')
  assert.equal(typeof enforce, 'boolean')
  assert.equal(enforce, true)
  assert.equal(typeof countAuxiliary, 'boolean')
  assert.equal(countAuxiliary, true)
  const cards = pickCards(def)
  assert.equal(cards.initialHeld, 2)
  assert.equal(cards.maxHeld, 9)
  assert.equal(cards.claimCooldownSeconds, 10)
  assert.equal(cards.claimBatch, 1)
})

test('normalizeConfig defaults a missing config to claude/max20x, both windows, enforce on', () => {
  for (const raw of [undefined, null, {}, 'ignored']) {
    const config = plans.normalizeConfig(raw)
    assert.ok(config && typeof config === 'object', `normalizeConfig(${String(raw)}) must return an object`)
    assert.equal(pick(config, 'vendor'), 'claude')
    assert.equal(pick(config, 'plan'), 'max20x')
    assert.equal(pickWindows(config).h5, true)
    assert.equal(pickWindows(config).d7, true)
    assert.equal(configValue(config, 'enforce'), true)
    assert.equal(configValue(config, 'countAuxiliary'), true)
    assert.equal(typeof configValue(config, 'stateFile'), 'string')
    const cards = pickCards(config)
    assert.equal(cards.initialHeld, 2)
    assert.equal(cards.maxHeld, 9)
    assert.equal(cards.claimCooldownSeconds, 10)
    assert.equal(cards.claimBatch, 1)
  }
})

test('normalizeConfig keeps valid partial input and fills the rest', () => {
  const config = plans.normalizeConfig({ vendor: 'openai', plan: 'go', windows: { h5: false, d7: true } })
  assert.equal(pick(config, 'vendor'), 'openai')
  assert.equal(pick(config, 'plan'), 'go')
  assert.equal(pickWindows(config).h5, false, 'a single enabled window is a valid start state')
  assert.equal(pickWindows(config).d7, true)

  const claude = plans.normalizeConfig({ vendor: 'claude', plan: 'max5x' })
  assert.equal(pick(claude, 'vendor'), 'claude')
  assert.equal(pick(claude, 'plan'), 'max5x')

  const onlyD7 = plans.normalizeConfig({ windows: { h5: false } })
  assert.equal(pickWindows(onlyD7).h5, false, 'an explicit h5:false starts a d7-only configuration')
  assert.equal(pickWindows(onlyD7).d7, true, 'unspecified d7 keeps its default')

  const onlyH5 = plans.normalizeConfig({ windows: { d7: false } })
  assert.equal(pickWindows(onlyH5).h5, true)
  assert.equal(pickWindows(onlyH5).d7, false, 'the 5-hour window can also run alone')

  const noEnforce = plans.normalizeConfig({ enforce: false, countAuxiliary: false })
  assert.equal(configValue(noEnforce, 'enforce'), false)
  assert.equal(configValue(noEnforce, 'countAuxiliary'), false)

  const customCards = plans.normalizeConfig({ cards: { initialHeld: 5, maxHeld: 7 } })
  assert.equal(pickCards(customCards).initialHeld, 5)
  assert.equal(pickCards(customCards).maxHeld, 7)
  assert.equal(pickCards(customCards).claimCooldownSeconds, 10, 'unspecified card fields keep defaults')
})

test('normalizeConfig repairs invalid input instead of throwing (never an invalid vendor/plan pair)', () => {
  const config = plans.normalizeConfig({
    vendor: 'enterprise',
    plan: 'enterprise',
    windows: { h5: false, d7: false },
    enforce: 'yes-please',
    countAuxiliary: 0,
    cards: { initialHeld: -2, maxHeld: -3, claimCooldownSeconds: -1, claimBatch: 0 },
    stateFile: 42,
  })
  assert.ok(['claude', 'openai'].includes(pick(config, 'vendor')), 'invalid vendor falls back to a known vendor')
  assert.equal(pick(config, 'vendor'), 'claude', 'invalid vendor falls back to DEFAULT_VENDOR')
  assert.equal(pick(config, 'plan'), 'max20x', 'invalid plan falls back to DEFAULT_PLAN')
  const windows = pickWindows(config)
  assert.equal(typeof windows.h5, 'boolean')
  assert.equal(typeof windows.d7, 'boolean')
  assert.ok(windows.h5 || windows.d7, 'normalized config must keep at least one window enabled')
  assert.equal(typeof configValue(config, 'enforce'), 'boolean')
  assert.equal(typeof configValue(config, 'countAuxiliary'), 'boolean')
  assert.equal(typeof configValue(config, 'stateFile'), 'string')

  const cards = pickCards(config)
  for (const key of ['initialHeld', 'maxHeld', 'claimCooldownSeconds', 'claimBatch']) {
    assert.equal(typeof cards[key], 'number', `cards.${key} must be normalized to a number`)
    assert.ok(Number.isFinite(cards[key]), `cards.${key} must be finite`)
    assert.ok(cards[key] >= 0, `cards.${key} must not be negative`)
  }
  assert.ok(cards.maxHeld <= 99, 'card inventory stays bounded')
  assert.ok(cards.initialHeld <= cards.maxHeld, 'held cards can never exceed maxHeld')
  assert.ok(cards.claimBatch >= 1, 'one claim always grants at least one card')

  // Non-numeric values fall back to the documented defaults instead of becoming 0.
  const numericFallback = plans.normalizeConfig({ cards: { maxHeld: 'lots', claimBatch: null } })
  assert.equal(pickCards(numericFallback).maxHeld, 9)
  assert.equal(pickCards(numericFallback).claimBatch, 1)

  // Every non-custom config must resolve to an existing (vendor, plan) pair.
  for (const raw of [{}, { plan: 'plus' }, { vendor: 'openai' }, { vendor: 'claude', plan: 'plus' }]) {
    const normalized = plans.normalizeConfig(raw)
    const vendor = pick(normalized, 'vendor')
    const plan = pick(normalized, 'plan')
    if (plan !== 'custom') {
      assert.ok(plans.findPlan(vendor, plan), `normalizeConfig(${JSON.stringify(raw)}) must not produce ${vendor}/${plan}`)
    }
  }
})

test('normalizeConfig is stable when applied twice', () => {
  const once = plans.normalizeConfig({ vendor: 'openai', plan: 'go', windows: { d7: true }, enforce: false })
  const twice = plans.normalizeConfig(once)
  assert.equal(pick(twice, 'vendor'), pick(once, 'vendor'))
  assert.equal(pick(twice, 'plan'), pick(once, 'plan'))
  assert.deepEqual(pickWindows(twice), pickWindows(once))
  assert.equal(configValue(twice, 'enforce'), configValue(once, 'enforce'))
  assert.deepEqual(pickCards(twice), pickCards(once))
})

test('formatTokens renders compact human-readable counts', () => {
  const formatTokens = plans.formatTokens
  assert.equal(typeof formatTokens, 'function', 'formatTokens must be exported by plans.js')
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_500), '1.5K')
  assert.equal(formatTokens(200_000), '200.0K')
  assert.equal(formatTokens(1_500_000), '1.50M')
  assert.equal(formatTokens(30_000_000), '30.00M')
  assert.equal(formatTokens(300_000_000), '300.00M')
  assert.equal(formatTokens(1_000_000_000), '1.00B')
  for (const value of [0, 1, 999, 1000, 1_500_000, 30_000_000, 300_000_000, 2_000_000_000]) {
    const rendered = formatTokens(value)
    assert.ok(rendered.length > 0)
    assert.ok(!/NaN|undefined|null/.test(rendered), `formatTokens(${value}) rendered "${rendered}"`)
  }
})

test('documented constants match CONTRACT section 2', () => {
  assert.equal(plans.MINUTE_MS, 60_000)
  assert.equal(plans.PRUNE_AGE_MS, plans.WINDOW_MS.d7 + 3_600_000)
  assert.equal(plans.MAX_LIMIT_TOKENS, 2_000_000_000)
  assert.equal(plans.MAX_EVENTS, 30)
  assert.deepEqual(plans.EVENT_KINDS, [
    'usage',
    'claim',
    'redeem',
    'plan',
    'windows',
    'settings',
    'reset',
    'blocked',
  ])
})

test('minuteKey/bucketStart convert minute buckets to and from epoch ms', () => {
  const t0 = 1_800_000_000_000 // minute-aligned
  assert.equal(plans.minuteKey(t0), String(t0 / plans.MINUTE_MS))
  assert.equal(plans.minuteKey(t0 + 59_999), String(t0 / plans.MINUTE_MS), 'same minute bucket')
  assert.equal(plans.minuteKey(t0 + 60_000), String(t0 / plans.MINUTE_MS + 1), 'next minute bucket')
  assert.equal(plans.bucketStart(plans.minuteKey(t0)), t0)
  assert.equal(plans.bucketStart('not-a-number'), null)
  assert.equal(plans.bucketStart(-5), null, 'negative epoch minutes are invalid')
})

test('emptyBucket starts all counters at zero', () => {
  assert.deepEqual(plans.emptyBucket(), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    calls: 0,
  })
})

test('sumWindow implements the strict rolling-window cutoff', () => {
  const t0 = 1_800_000_000_000
  const buckets = {
    [plans.minuteKey(t0)]: { ...plans.emptyBucket(), tokens: 150 },
    [plans.minuteKey(t0 - plans.WINDOW_MS.h5 + plans.MINUTE_MS)]: { tokens: 10 },
    [plans.minuteKey(t0 - plans.WINDOW_MS.h5)]: { tokens: 999 }, // exactly 5h old → outside
    [plans.minuteKey(t0 - plans.WINDOW_MS.d7)]: { tokens: 777 }, // exactly 7d old → outside
    bogus: { tokens: 5 },
  }
  const h5 = plans.sumWindow(buckets, 'h5', t0)
  assert.equal(h5.tokens, 160, 'only minute buckets strictly newer than now-5h count')
  assert.equal(h5.oldestStart, t0 - plans.WINDOW_MS.h5 + plans.MINUTE_MS)
  const d7 = plans.sumWindow(buckets, 'd7', t0)
  assert.equal(d7.tokens, 150 + 10 + 999)
  assert.equal(d7.oldestStart, t0 - plans.WINDOW_MS.h5)

  assert.deepEqual(plans.sumWindow({}, 'h5', t0), { tokens: 0, oldestStart: null })
  assert.deepEqual(plans.sumWindow(null, 'd7', t0), { tokens: 0, oldestStart: null })
  const dirty = { [plans.minuteKey(t0)]: { tokens: -50 }, [plans.minuteKey(t0 + 60_000)]: { tokens: NaN } }
  assert.equal(plans.sumWindow(dirty, 'h5', t0).tokens, 0, 'negative/NaN tokens never count')
})

test('pruneBuckets deletes only buckets at or older than 7d + 1h', () => {
  const t0 = 1_800_000_000_000
  const cutoffKey = plans.minuteKey(t0 - plans.PRUNE_AGE_MS)
  const keptKey = plans.minuteKey(t0 - plans.PRUNE_AGE_MS + plans.MINUTE_MS)
  const nowKey = plans.minuteKey(t0)
  const buckets = { [cutoffKey]: { tokens: 1 }, [keptKey]: { tokens: 2 }, [nowKey]: { tokens: 3 }, bogus: { tokens: 4 } }
  plans.pruneBuckets(buckets, t0)
  assert.deepEqual(Object.keys(buckets).sort(), [keptKey, nowKey].sort())
})

test('ratioPercent and isExhausted match the documented derivations', () => {
  assert.equal(plans.ratioPercent(251, 1000), 25.1)
  assert.equal(plans.ratioPercent(1051, 1000), 105.1)
  assert.equal(plans.ratioPercent(1, 3), 33.3)
  assert.equal(plans.ratioPercent(0, 100), 0)
  assert.equal(plans.ratioPercent(0, 0), 0)
  assert.equal(plans.ratioPercent(5, 0), 100, 'a non-positive limit reads as exhausted when used')
  assert.equal(plans.ratioPercent(0, -10), 0)

  assert.equal(plans.isExhausted(100, 100), true, 'used >= limit is exhausted')
  assert.equal(plans.isExhausted(99, 100), false)
  assert.equal(plans.isExhausted(0, 0), true, 'a non-positive limit is always exhausted')
  assert.equal(plans.isExhausted(5, -1), true)
})

test('resetInFor computes the oldest bucket deadline', () => {
  const t0 = 1_800_000_000_000
  assert.equal(plans.resetInFor(t0, 'h5', t0 + 60_000), plans.WINDOW_MS.h5 - 60_000)
  assert.equal(plans.resetInFor(t0, 'd7', t0), plans.WINDOW_MS.d7)
  assert.equal(plans.resetInFor(null, 'h5', t0), null)
  assert.equal(plans.resetInFor(undefined, 'd7', t0), null)
})

test('normalizeBucket drops malformed and empty buckets', () => {
  assert.equal(plans.normalizeBucket(null), null)
  assert.equal(plans.normalizeBucket('x'), null)
  assert.equal(plans.normalizeBucket({ tokens: 0, calls: 0 }), null, 'empty buckets are not persisted')
  assert.deepEqual(plans.normalizeBucket({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tokens: 5, calls: 1 }), {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    tokens: 5,
    calls: 1,
  })
})

test('plans.js exposes the documented pure helper surface (v2)', () => {
  for (const name of [
    'VENDORS',
    'WINDOW_MS',
    'DEFAULT_CONFIG',
    'DEFAULT_VENDOR',
    'DEFAULT_PLAN',
    'CUSTOM_PLAN',
    'normalizeConfig',
    'formatTokens',
    'vendorById',
    'findPlan',
    'effectiveLimits',
    'planDescriptor',
  ]) {
    assert.ok(name in plans, `plans.js must export ${name} (CONTRACT sections 6/10)`)
  }
  const helperNames = Object.keys(plans).filter((name) => typeof plans[name] === 'function')
  assert.ok(helperNames.length >= 8, `expected the pure window helpers too, found: ${helperNames.join(', ') || '(none)'}`)
})
