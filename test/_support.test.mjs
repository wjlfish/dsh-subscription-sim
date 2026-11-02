// Shared support for dsh-subscription-sim v2 unit tests (CONTRACT.md sections 10-14).
//
// This module is deliberately adaptation-friendly: the contract fixes the engine's
// method names but not every argument casing, so the few ambiguous call sites live
// here and every assertion itself stays contract-based.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createEngine } from '../lib/engine.js'
import { normalizeConfig } from '../lib/plans.js'

export const MINUTE = 60_000
export const HOUR = 3_600_000
export const DAY = 86_400_000
export const H5_MS = 18_000_000
export const D7_MS = 604_800_000

/** Minute-aligned base clock (buckets are epoch-minute keys, CONTRACT section 2). */
export const T0 = 1_800_000_000_000

/** CONTRACT section 10 catalog ids (order matters: display order). */
export const CLAUDE_PLAN_IDS = ['free', 'pro', 'max5x', 'max20x']
export const OPENAI_PLAN_IDS = ['free', 'go', 'plus', 'pro', 'promax']

/** Deterministic clock: `now()` is injected into the engine, tests move it by hand. */
export function makeClock(start = T0) {
  let current = start
  return {
    now: () => current,
    set: (value) => {
      current = value
    },
    advance: (ms) => {
      current += ms
    },
  }
}

/** Temp directory removed by node:test after the test (also removes its state file). */
export function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dss-verify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Read a normalized config field whether the implementation nests it under settings or not. */
export function configValue(config, key) {
  if (!config || typeof config !== 'object') return undefined
  if (key in config) return config[key]
  return config.settings?.[key]
}

/**
 * Create an engine against a temp state file with an injected clock.
 * Returns `{ engine, clock, stateFile, dir }`.
 */
export async function makeEngine(t, options = {}) {
  const dir = options.dir ?? makeTempDir(t)
  if (options.dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  const stateFile = options.stateFile ?? join(dir, 'state.json')
  const clock = options.clock ?? makeClock()
  const logCalls = []
  const log = options.log ?? ((...args) => logCalls.push(args))
  const rawConfig = options.rawConfig ?? {}
  const config = options.normalize === false ? rawConfig : normalizeConfig(rawConfig)
  // `createEngine` is async: it waits for the state file load before resolving.
  const engine = await createEngine({ now: clock.now, stateFile, config, log: log })
  t.after(async () => {
    try {
      await engine.close?.()
    } catch {
      /* close must not throw during cleanup */
    }
  })
  const result = { engine, clock, stateFile, dir, logCalls }
  result.snapshot = () => engine.snapshot()
  return result
}

/**
 * Boot an engine from a pre-existing state-file record (used by the migration matrix).
 * The record is written verbatim as JSON before activation.
 */
export async function bootFromState(t, record, options = {}) {
  const dir = options.dir ?? makeTempDir(t)
  const stateFile = options.stateFile ?? join(dir, 'state.json')
  mkdirSync(dirname(stateFile), { recursive: true })
  writeFileSync(stateFile, typeof record === 'string' ? record : JSON.stringify(record))
  return makeEngine(t, { ...options, dir, stateFile })
}

/** A syntactically complete version-1 record (CONTRACT section 2, pre-v2 layout). */
export function v1State(overrides = {}) {
  return {
    version: 1,
    plan: 'max20x',
    customLimits: { h5: 0, d7: 0 },
    windows: { h5: true, d7: true },
    settings: { enforce: true, countAuxiliary: true },
    buckets: {},
    lifetime: { tokens: 0, input: 0, output: 0, calls: 0, since: 0 },
    cards: 2,
    claimAt: 0,
    lastHit: null,
    simulateBlock: false,
    events: [],
    ...overrides,
  }
}

/** Snapshot v2 vendor-scoped plan selection (CONTRACT section 12). */
export function setPlanOn(engine, vendor, planId) {
  return engine.setPlan({ vendor, planId })
}

/** Drain the fire-and-forget save chain by awaiting a real mutation (save is serialized). */
export async function flush(engine) {
  if (typeof engine.flush === 'function') {
    await engine.flush()
    return
  }
  const snap = engine.snapshot()
  await engine.setWindows({ h5: snap.windows.h5.enabled, d7: snap.windows.d7.enabled })
}

/**
 * Invoke something that is expected to fail. Accepts both rejection styles allowed by
 * CONTRACT section 4: a thrown error carrying `.code`, or a resolved `{ok:false,error}`.
 */
export async function captureFailure(fn) {
  try {
    const value = await fn()
    if (value && typeof value === 'object' && value.ok === false) {
      return value.error ?? { code: undefined, message: 'ok:false without error object' }
    }
    if (value instanceof Error) return value
    return null
  } catch (error) {
    return error
  }
}

export function failureCode(failure) {
  if (!failure) return undefined
  if (typeof failure.code === 'string') return failure.code
  if (failure.error && typeof failure.error.code === 'string') return failure.error.code
  return undefined
}

/** Assert that `fn` rejects/returns failure and (when given) that its code matches. */
export async function assertFailure(fn, expectedCode, label) {
  const failure = await captureFailure(fn)
  assert.ok(failure, `${label}: expected a rejection/failure, but the call succeeded`)
  if (expectedCode !== undefined) {
    assert.equal(
      failureCode(failure),
      expectedCode,
      `${label}: expected failure code "${expectedCode}", got "${failureCode(failure)}" (${failure.message ?? failure})`,
    )
  }
  return failure
}

/** Normalize a blocked/not-blocked decision, which may be a boolean or `{blocked}`. */
export function blockedOf(decision) {
  if (typeof decision === 'boolean') return decision
  if (decision && typeof decision === 'object') return Boolean(decision.blocked)
  return Boolean(decision)
}

/** Assert one snapshot `vendor`/`vendors[]` entry has the CONTRACT section 12 shape. */
export function assertVendorShape(vendor, label = 'vendor') {
  assert.equal(typeof vendor, 'object', `${label} must be an object`)
  assert.equal(typeof vendor.id, 'string', `${label}.id`)
  assert.equal(typeof vendor.name?.zh, 'string', `${label}.name.zh`)
  assert.equal(typeof vendor.name?.en, 'string', `${label}.name.en`)
  assert.equal(typeof vendor.note?.zh, 'string', `${label}.note.zh`)
  assert.equal(typeof vendor.note?.en, 'string', `${label}.note.en`)
}

/** Assert one `vendors[].plans[]` entry has the CONTRACT section 12 shape. */
export function assertPlanShape(plan, label = 'plan') {
  assert.equal(typeof plan, 'object', `${label} must be an object`)
  assert.equal(typeof plan.id, 'string', `${label}.id`)
  assert.equal(typeof plan.name?.zh, 'string', `${label}.name.zh`)
  assert.equal(typeof plan.name?.en, 'string', `${label}.name.en`)
  assert.equal(typeof plan.priceUSD, 'number', `${label}.priceUSD`)
  assert.equal(typeof plan.limits?.h5, 'number', `${label}.limits.h5`)
  assert.equal(typeof plan.limits?.d7, 'number', `${label}.limits.d7`)
}

/** A full snapshot shape walker for CONTRACT v2 section 12 (all section 4 fields retained). */
export function assertSnapshotShape(snap) {
  assert.equal(typeof snap, 'object')
  assert.equal(snap.ok, true)
  assert.equal(typeof snap.serverNow, 'number')
  assert.equal(snap.version, 2, 'snapshot.version must be 2 (CONTRACT section 11/12)')

  // v2: vendor + vendor-scoped plan descriptor.
  assertVendorShape(snap.vendor, 'snapshot.vendor')
  assert.equal(typeof snap.plan?.id, 'string')
  assert.equal(typeof snap.plan?.name?.zh, 'string')
  assert.equal(typeof snap.plan?.name?.en, 'string')
  assert.equal(typeof snap.plan?.priceUSD, 'number')
  assert.equal(typeof snap.plan?.limits?.h5, 'number')
  assert.equal(typeof snap.plan?.limits?.d7, 'number')
  assert.equal(typeof snap.plan?.custom, 'boolean')
  assert.equal(snap.plan?.vendorId, snap.vendor?.id, 'snapshot.plan.vendorId must equal snapshot.vendor.id')
  assert.equal(typeof snap.plan?.vendorName?.zh, 'string', 'snapshot.plan.vendorName.zh')
  assert.equal(typeof snap.plan?.vendorName?.en, 'string', 'snapshot.plan.vendorName.en')

  // v2: full catalogs replace the old flat `plans` list.
  assert.ok(Array.isArray(snap.vendors), 'snapshot.vendors must be an array')
  assert.ok(snap.vendors.length >= 2, 'snapshot.vendors must list both vendor catalogs')
  for (const vendor of snap.vendors) {
    assertVendorShape(vendor, 'snapshot.vendors[]')
    assert.ok(Array.isArray(vendor.plans) && vendor.plans.length >= 1, `${vendor.id}: plans array`)
    for (const plan of vendor.plans) assertPlanShape(plan, `snapshot.vendors[${vendor.id}].plans[]`)
  }
  assert.equal(snap.plans, undefined, 'the old top-level snapshot.plans field is removed in v2')

  for (const w of ['h5', 'd7']) {
    const window = snap.windows?.[w]
    assert.ok(window, `snapshot.windows.${w} must exist`)
    assert.equal(typeof window.enabled, 'boolean')
    assert.equal(typeof window.windowMs, 'number')
    assert.equal(typeof window.used, 'number')
    assert.equal(typeof window.limit, 'number')
    assert.equal(typeof window.remaining, 'number')
    assert.equal(typeof window.percent, 'number')
    assert.equal(typeof window.exhausted, 'boolean')
    assert.ok(window.resetAt === null || typeof window.resetAt === 'number')
    assert.ok(window.resetInMs === null || typeof window.resetInMs === 'number')
  }

  assert.equal(typeof snap.blocked, 'boolean')
  assert.ok(snap.blockedWindow === null || snap.blockedWindow === 'h5' || snap.blockedWindow === 'd7')

  assert.equal(typeof snap.settings?.enforce, 'boolean')
  assert.equal(typeof snap.settings?.countAuxiliary, 'boolean')
  assert.equal(typeof snap.settings?.windows?.h5, 'boolean')
  assert.equal(typeof snap.settings?.windows?.d7, 'boolean')
  for (const key of ['maxHeld', 'claimCooldownSeconds', 'claimBatch', 'initialHeld']) {
    assert.equal(typeof snap.settings?.cards?.[key], 'number', `settings.cards.${key} must be a number`)
  }

  assert.equal(typeof snap.cards?.held, 'number')
  assert.equal(typeof snap.cards?.maxHeld, 'number')
  assert.equal(typeof snap.cards?.canClaim, 'boolean')
  assert.equal(typeof snap.cards?.cooldownRemainingMs, 'number')
  assert.equal(typeof snap.cards?.claimBatch, 'number')

  assert.equal(typeof snap.lifetime?.tokens, 'number')
  assert.equal(typeof snap.lifetime?.input, 'number')
  assert.equal(typeof snap.lifetime?.output, 'number')
  assert.equal(typeof snap.lifetime?.calls, 'number')
  assert.equal(typeof snap.lifetime?.since, 'number')

  assert.ok(snap.lastHit === null || (typeof snap.lastHit === 'object' && typeof snap.lastHit.window === 'string'))
  assert.equal(typeof snap.simulateBlock, 'boolean')
  assert.ok(Array.isArray(snap.events))
  assert.ok(snap.events.length <= 30, 'events log must be bounded to 30')
  for (const event of snap.events) {
    assert.equal(typeof event.at, 'number')
    assert.equal(typeof event.kind, 'string')
  }

  assert.equal(typeof snap.storage?.stateFile, 'string')
  assert.equal(typeof snap.storage?.ok, 'boolean')
  assert.ok(snap.storage?.lastError === null || typeof snap.storage?.lastError === 'string')
}

/** Persisted (on-disk) state file shape helper, CONTRACT sections 2/11 (v2). */
export function assertPersistedShape(state) {
  assert.equal(state.version, 2, 'persisted state version must be 2')
  assert.equal(typeof state.vendor, 'string', 'persisted state must carry the vendor id')
  assert.equal(typeof state.plan, 'string')
  assert.equal(typeof state.customLimits?.h5, 'number')
  assert.equal(typeof state.customLimits?.d7, 'number')
  assert.equal(typeof state.windows?.h5, 'boolean')
  assert.equal(typeof state.windows?.d7, 'boolean')
  assert.equal(typeof state.settings?.enforce, 'boolean')
  assert.equal(typeof state.settings?.countAuxiliary, 'boolean')
  assert.equal(typeof state.buckets, 'object')
  assert.equal(typeof state.lifetime?.tokens, 'number')
  assert.equal(typeof state.cards, 'number')
  assert.equal(typeof state.claimAt, 'number')
  assert.ok(state.lastHit === null || typeof state.lastHit === 'object')
  assert.equal(typeof state.simulateBlock, 'boolean')
  assert.ok(Array.isArray(state.events))
}

/** Collect every `{id, plan}` pair from a snapshot vendor catalog. */
export function vendorPlanPairs(vendors) {
  const pairs = []
  for (const vendor of vendors ?? []) {
    for (const plan of vendor.plans ?? []) pairs.push({ id: plan.id, vendor: vendor.id })
  }
  return pairs
}

export { existsSync, dirname, writeFileSync, readFileSync }
