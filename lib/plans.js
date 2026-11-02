/**
 * Vendor catalogs, vendor-scoped plan lookups, rolling-window math, and
 * configuration normalization for the subscription simulator.
 * Pure module: no node builtins, no I/O, no clock.
 *
 * Quotas are fictional and documented as simulated: they exist only in this
 * plugin's own JSON state file. Two vendor catalogs are simulated (CONTRACT
 * section 10): Anthropic Claude and OpenAI ChatGPT. Plan ids are only unique
 * within a vendor (`free`/`pro` exist in both), so every lookup is
 * vendor-scoped.
 */
import { formatTokens } from './format.js'

export { formatTokens }

/** Rolling window lengths in milliseconds (5 hours and 7 days). */
export const WINDOW_MS = Object.freeze({ h5: 18_000_000, d7: 604_800_000 })

/** Canonical window ids in display order. */
export const WINDOW_IDS = Object.freeze(['h5', 'd7'])

/** One minute in milliseconds; usage is aggregated into minute buckets. */
export const MINUTE_MS = 60_000

/** Buckets at or below `now - PRUNE_AGE_MS` are pruned on every mutation. */
export const PRUNE_AGE_MS = WINDOW_MS.d7 + 3_600_000

/** Largest limit `set-limit` accepts. */
export const MAX_LIMIT_TOKENS = 2_000_000_000

/** Bounded recent-event log length. */
export const MAX_EVENTS = 30

/** Allowed `events[].kind` values. */
export const EVENT_KINDS = Object.freeze([
  'usage',
  'claim',
  'redeem',
  'plan',
  'windows',
  'settings',
  'reset',
  'blocked',
])

/**
 * Simulated vendor catalogs (CONTRACT section 10). Names, prices and quotas
 * are copied from the consumer subscription tiers the simulation imitates;
 * every number here is fictional quota, not real billing.
 */
export const VENDORS = deepFreeze([
  {
    id: 'claude',
    name: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
    note: { zh: '5 小时会话额度 + 每周额度', en: '5-hour session limit + weekly limit' },
    plans: [
      { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 150_000, d7: 1_000_000 } },
      { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 20, limits: { h5: 2_000_000, d7: 20_000_000 } },
      { id: 'max5x', name: { zh: 'Max 5×', en: 'Max 5×' }, priceUSD: 100, limits: { h5: 8_000_000, d7: 80_000_000 } },
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
      { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 100_000, d7: 800_000 } },
      { id: 'go', name: { zh: 'Go', en: 'Go' }, priceUSD: 8, limits: { h5: 500_000, d7: 4_000_000 } },
      { id: 'plus', name: { zh: 'Plus', en: 'Plus' }, priceUSD: 20, limits: { h5: 2_500_000, d7: 20_000_000 } },
      { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 200, limits: { h5: 30_000_000, d7: 250_000_000 } },
      { id: 'promax', name: { zh: 'Pro Max', en: 'Pro Max' }, priceUSD: 500, limits: { h5: 60_000_000, d7: 500_000_000 } },
    ],
  },
])

/** Vendor used for fresh state/configuration and for legacy-state inference. */
export const DEFAULT_VENDOR = 'claude'

/** Preset plan used on a fresh install so activation cannot lock the operator out. */
export const DEFAULT_PLAN = 'max20x'

/** Legacy alias for {@link DEFAULT_PLAN} (the version-1 export name). */
export const DEFAULT_PLAN_ID = DEFAULT_PLAN

/**
 * The synthetic `custom` plan; its limits live in `state.customLimits`.
 * Selectable under either vendor and never via `set-plan` (only `set-limit`).
 */
export const CUSTOM_PLAN = deepFreeze({
  id: 'custom',
  name: { zh: '自定义', en: 'Custom' },
  priceUSD: 0,
})

/** Recursively freeze one plain object/array tree (internal helper). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** A finite number rounded to an integer inside [min, max], else fallback. */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/** A non-negative integer, else 0. */
function nonNegativeInt(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * True for one of the documented vendor ids.
 * @param {unknown} vendorId
 * @returns {boolean}
 */
export function isVendorId(vendorId) {
  return typeof vendorId === 'string' && VENDORS.some((vendor) => vendor.id === vendorId)
}

/**
 * One vendor catalog entry by id (undefined when unknown).
 * @param {unknown} vendorId
 * @returns {(typeof VENDORS)[number] | undefined}
 */
export function vendorById(vendorId) {
  return VENDORS.find((vendor) => vendor.id === vendorId)
}

/**
 * One preset plan inside one vendor (undefined when the pairing is unknown).
 * Plan ids are vendor-scoped: `findPlan('openai', 'go')` is the only way to
 * reach the OpenAI Go tier.
 * @param {unknown} vendorId
 * @param {unknown} planId
 * @returns {(typeof VENDORS)[number]['plans'][number] | undefined}
 */
export function findPlan(vendorId, planId) {
  const vendor = vendorById(vendorId)
  if (vendor === undefined || typeof planId !== 'string') return undefined
  return vendor.plans.find((plan) => plan.id === planId)
}

/**
 * Catalog limits of one vendor-scoped preset; the default plan's limits for
 * unknown pairings. `custom` is not a catalog plan (see `effectiveLimits`).
 * @param {unknown} vendorId
 * @param {unknown} planId
 * @returns {{ h5: number, d7: number }}
 */
function catalogLimits(vendorId, planId) {
  const plan = findPlan(vendorId, planId)
  if (plan !== undefined) return { h5: plan.limits.h5, d7: plan.limits.d7 }
  const fallback = findPlan(DEFAULT_VENDOR, DEFAULT_PLAN)
  return { h5: fallback.limits.h5, d7: fallback.limits.d7 }
}

/**
 * Resolve a call to the vendor-scoped helpers. The documented form is
 * `(vendorId, planId, customLimits?)`. The two-argument `(planId, customLimits)`
 * form is accepted only as a temporary compatibility shim for the version-1
 * engine (a hot reload can load the old engine against this module).
 * @param {unknown[]} args
 * @returns {{ vendorId: unknown, planId: unknown, customLimits: unknown }}
 */
function resolveVendorPlanCall(args) {
  if (args.length >= 3) {
    return { vendorId: args[0], planId: args[1], customLimits: args[2] }
  }
  if (isVendorId(args[0]) && typeof args[1] === 'string') {
    return { vendorId: args[0], planId: args[1], customLimits: args[2] }
  }
  return { vendorId: DEFAULT_VENDOR, planId: args[0], customLimits: args[1] }
}

/**
 * Effective per-window limits of a vendor-scoped plan: catalog limits for a
 * preset, `customLimits` for `custom`, and the default plan's limits for
 * unknown pairings.
 *
 * @param {unknown} vendorId
 * @param {unknown} planId
 * @param {{ h5?: number, d7?: number } | null | undefined} [customLimits]
 * @returns {{ h5: number, d7: number }}
 */
export function effectiveLimits(...args) {
  const call = resolveVendorPlanCall(args)
  if (call.planId === 'custom') {
    const source =
      call.customLimits !== null && typeof call.customLimits === 'object' ? call.customLimits : {}
    return { h5: nonNegativeInt(source.h5), d7: nonNegativeInt(source.d7) }
  }
  return catalogLimits(call.vendorId, call.planId)
}

/**
 * Snapshot descriptor of one vendor-scoped plan (the `custom` descriptor when
 * `planId === 'custom'`; otherwise the preset, falling back to the default
 * plan for unknown pairings).
 *
 * @param {unknown} vendorId
 * @param {unknown} planId
 * @param {{ h5?: number, d7?: number } | null | undefined} [customLimits]
 * @returns {{ id: string, name: { zh: string, en: string }, priceUSD: number, limits: { h5: number, d7: number } }}
 */
export function planDescriptor(...args) {
  const call = resolveVendorPlanCall(args)
  const vendor = vendorById(call.vendorId) ?? vendorById(DEFAULT_VENDOR)
  if (call.planId === 'custom') {
    return {
      id: 'custom',
      name: { zh: CUSTOM_PLAN.name.zh, en: CUSTOM_PLAN.name.en },
      priceUSD: 0,
      limits: effectiveLimits(vendor.id, 'custom', call.customLimits),
    }
  }
  const plan = findPlan(vendor.id, call.planId) ?? findPlan(DEFAULT_VENDOR, DEFAULT_PLAN)
  return {
    id: plan.id,
    name: { zh: plan.name.zh, en: plan.name.en },
    priceUSD: plan.priceUSD,
    limits: { h5: plan.limits.h5, d7: plan.limits.d7 },
  }
}

/**
 * Snapshot `vendors` list for the v2 Client: both catalogs with bilingual
 * names/notes and their four presets. Catalog plans only — the synthetic
 * `custom` plan is described by the top-level `plan` descriptor instead.
 * @returns {Array<{ id: string, name: { zh: string, en: string }, note: { zh: string, en: string }, plans: Array<{ id: string, name: { zh: string, en: string }, priceUSD: number, limits: { h5: number, d7: number } }> }>}
 */
export function vendorList() {
  return VENDORS.map((vendor) => ({
    id: vendor.id,
    name: { zh: vendor.name.zh, en: vendor.name.en },
    note: { zh: vendor.note.zh, en: vendor.note.en },
    plans: vendor.plans.map((plan) => ({
      id: plan.id,
      name: { zh: plan.name.zh, en: plan.name.en },
      priceUSD: plan.priceUSD,
      limits: { h5: plan.limits.h5, d7: plan.limits.d7 },
    })),
  }))
}

/**
 * True for any known plan id across all vendor catalogs, or `custom`.
 * Vendor-agnostic legacy helper: prefer `findPlan(vendorId, planId)`.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isPlanId(id) {
  if (typeof id !== 'string') return false
  if (id === 'custom') return true
  return VENDORS.some((vendor) => vendor.plans.some((plan) => plan.id === id))
}

/**
 * One preset by id from any catalog (first match: Claude wins ambiguous ids).
 * @deprecated vendor-scoped helper; use {@link findPlan}.
 * @param {unknown} id
 * @returns {(typeof VENDORS)[number]['plans'][number] | undefined}
 */
export function presetById(id) {
  for (const vendor of VENDORS) {
    const plan = vendor.plans.find((candidate) => candidate.id === id)
    if (plan !== undefined) return plan
  }
  return undefined
}

/**
 * Simulated limits of one Claude-scoped preset; default plan limits for
 * unknown ids.
 * @deprecated vendor-scoped helper; use {@link effectiveLimits}.
 * @param {unknown} id
 * @returns {{ h5: number, d7: number }}
 */
export function presetLimits(id) {
  return catalogLimits(DEFAULT_VENDOR, id)
}

/**
 * Version-1 snapshot `plans` list (Claude catalog + custom). Version-2
 * snapshots expose `vendors` instead; kept only so a hot reload of the old
 * engine against this module cannot crash.
 * @deprecated use {@link vendorList} and the snapshot `plan` descriptor.
 * @param {{ h5?: number, d7?: number } | null | undefined} customLimits
 * @returns {Array<{ id: string, name: { zh: string, en: string }, priceUSD: number, limits: { h5: number, d7: number } }>}
 */
export function planList(customLimits) {
  const vendor = vendorById(DEFAULT_VENDOR)
  const presets = vendor.plans.map((plan) => ({
    id: plan.id,
    name: { zh: plan.name.zh, en: plan.name.en },
    priceUSD: plan.priceUSD,
    limits: { h5: plan.limits.h5, d7: plan.limits.d7 },
  }))
  return [...presets, planDescriptor(DEFAULT_VENDOR, 'custom', customLimits)]
}

/**
 * Normalize the row's raw plugin config defensively. Every field is optional
 * and any malformed value falls back to the documented default. `vendor`
 * defaults to {@link DEFAULT_VENDOR}; the plan must exist in the resolved
 * vendor (or be `custom`), otherwise the default vendor/plan pair is used.
 * @param {unknown} raw
 * @returns {{
 *   vendor: string,
 *   plan: string,
 *   windows: { h5: boolean, d7: boolean },
 *   enforce: boolean,
 *   countAuxiliary: boolean,
 *   cards: { initialHeld: number, maxHeld: number, claimCooldownSeconds: number, claimBatch: number },
 *   stateFile: string
 * }}
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const windowsRaw = source.windows !== null && typeof source.windows === 'object' ? source.windows : {}
  const settingsRaw = source.settings !== null && typeof source.settings === 'object' ? source.settings : {}
  const cardsRaw = source.cards !== null && typeof source.cards === 'object' ? source.cards : {}

  const windows = {
    h5: typeof windowsRaw.h5 === 'boolean' ? windowsRaw.h5 : true,
    d7: typeof windowsRaw.d7 === 'boolean' ? windowsRaw.d7 : true,
  }
  // At least one window must stay enabled; never start fully disabled.
  if (!windows.h5 && !windows.d7) {
    windows.h5 = true
    windows.d7 = true
  }

  let vendor = isVendorId(source.vendor) ? source.vendor : DEFAULT_VENDOR
  let plan
  if (source.plan === 'custom' || (typeof source.plan === 'string' && findPlan(vendor, source.plan) !== undefined)) {
    plan = source.plan
  } else {
    vendor = DEFAULT_VENDOR
    plan = DEFAULT_PLAN
  }

  const maxHeld = clampInt(cardsRaw.maxHeld, 0, 99, 9)
  const enforceRaw = source.enforce !== undefined ? source.enforce : settingsRaw.enforce
  const countAuxiliaryRaw =
    source.countAuxiliary !== undefined ? source.countAuxiliary : settingsRaw.countAuxiliary

  return {
    vendor,
    plan,
    windows,
    enforce: enforceRaw !== false,
    countAuxiliary: countAuxiliaryRaw !== false,
    cards: {
      initialHeld: Math.min(clampInt(cardsRaw.initialHeld, 0, 99, 2), maxHeld),
      maxHeld,
      claimCooldownSeconds: clampInt(cardsRaw.claimCooldownSeconds, 0, 86_400, 10),
      claimBatch: clampInt(cardsRaw.claimBatch, 1, 9, 1),
    },
    stateFile:
      typeof source.stateFile === 'string' && source.stateFile.trim() !== ''
        ? source.stateFile.trim()
        : '',
  }
}

/** Documented defaults, produced by the same normalization code. */
export const DEFAULT_CONFIG = deepFreeze(normalizeConfig(undefined))

/**
 * Minute-bucket key for an epoch-ms timestamp: minutes since the epoch.
 * @param {number} now epoch ms
 * @returns {string}
 */
export function minuteKey(now) {
  const value = Number.isFinite(now) ? now : 0
  return String(Math.floor(value / MINUTE_MS))
}

/**
 * Bucket start (epoch ms) encoded by a minute key, or null when malformed.
 * @param {unknown} key
 * @returns {number | null}
 */
export function bucketStart(key) {
  const value = typeof key === 'string' ? Number(key) : NaN
  if (!Number.isFinite(value) || value < 0) return null
  return Math.trunc(value) * MINUTE_MS
}

/** A zeroed usage bucket. */
export function emptyBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, calls: 0 }
}

/**
 * Sum bucket tokens whose bucket start is strictly after `now - windowMs`.
 * @param {Record<string, { tokens?: number }>} buckets
 * @param {'h5'|'d7'} windowId
 * @param {number} now epoch ms
 * @returns {{ tokens: number, oldestStart: number | null }}
 */
export function sumWindow(buckets, windowId, now) {
  const windowMs = WINDOW_MS[windowId] ?? 0
  const cutoff = now - windowMs
  let tokens = 0
  let oldestStart = null
  if (buckets !== null && typeof buckets === 'object') {
    for (const key of Object.keys(buckets)) {
      const start = bucketStart(key)
      if (start === null || !(start > cutoff)) continue
      const bucket = buckets[key]
      const count = bucket !== null && typeof bucket === 'object' && Number.isFinite(bucket.tokens)
        ? Math.max(0, bucket.tokens)
        : 0
      tokens += count
      if (oldestStart === null || start < oldestStart) oldestStart = start
    }
  }
  return { tokens: Math.round(tokens), oldestStart }
}

/**
 * Delete buckets at or below `now - PRUNE_AGE_MS` (7 days + 1 hour) in place.
 * @param {Record<string, unknown>} buckets
 * @param {number} now epoch ms
 */
export function pruneBuckets(buckets, now) {
  if (buckets === null || typeof buckets !== 'object') return
  const cutoff = now - PRUNE_AGE_MS
  for (const key of Object.keys(buckets)) {
    const start = bucketStart(key)
    if (start === null || start <= cutoff) delete buckets[key]
  }
}

/**
 * Usage percentage of a limit, one decimal, may exceed 100.
 * A non-positive limit renders 100 when used, 0 otherwise.
 * @param {unknown} used
 * @param {unknown} limit
 * @returns {number}
 */
export function ratioPercent(used, limit) {
  const tokens = Number.isFinite(used) && used > 0 ? used : 0
  const quota = Number.isFinite(limit) ? limit : 0
  if (!(quota > 0)) return tokens > 0 ? 100 : 0
  return Math.round((tokens / quota) * 1000) / 10
}

/**
 * `used >= limit`, and always true for a non-positive limit.
 * @param {number} used
 * @param {number} limit
 * @returns {boolean}
 */
export function isExhausted(used, limit) {
  if (!(Number.isFinite(limit) && limit > 0)) return true
  return used >= limit
}

/**
 * Milliseconds until the oldest counted bucket leaves its window.
 * @param {number | null} oldestStart bucket start (epoch ms), null when empty
 * @param {'h5'|'d7'} windowId
 * @param {number} now epoch ms
 * @returns {number | null}
 */
export function resetInFor(oldestStart, windowId, now) {
  if (oldestStart === null || oldestStart === undefined) return null
  const windowMs = WINDOW_MS[windowId] ?? 0
  return oldestStart + windowMs - now
}

/**
 * Normalize one usage bucket from persisted state.
 * @param {unknown} raw
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number, tokens: number, calls: number } | null}
 */
export function normalizeBucket(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const bucket = {
    input: nonNegativeInt(raw.input),
    output: nonNegativeInt(raw.output),
    cacheRead: nonNegativeInt(raw.cacheRead),
    cacheWrite: nonNegativeInt(raw.cacheWrite),
    tokens: nonNegativeInt(raw.tokens),
    calls: nonNegativeInt(raw.calls),
  }
  if (bucket.tokens === 0 && bucket.calls === 0) return null
  return bucket
}
