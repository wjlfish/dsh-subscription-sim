/**
 * Subscription simulator engine — the durable, testable core.
 *
 * Owns one JSON state file: vendor + plan, rolling-window minute buckets,
 * lifetime counters, reset cards, the last blocked hit, and a bounded event
 * log. Version-2 state is vendor-scoped: the same plan id can exist in both
 * catalogs (CONTRACT section 10), so every limit lookup goes through
 * `effectiveLimits(vendor, plan, customLimits)`.
 *
 * Design constraints:
 * - All time comes from an injectable `now()` so unit tests can time-travel.
 * - Usage recording is synchronous in memory and persists fire-and-forget;
 *   it never awaits disk inside the model stream.
 * - Mutating user actions await the serialized save and surface storage
 *   failures as `storage_failure`.
 * - Loading never throws: a corrupt file is quarantined and a fresh state is
 *   used instead. A version-1 state file is migrated in place (CONTRACT
 *   section 11): vendor is inferred from the legacy plan id and buckets,
 *   lifetime, cards, windows, settings, customLimits, events and lastHit are
 *   preserved.
 *
 * Uses only node builtins and sibling pure modules.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_PLAN,
  DEFAULT_VENDOR,
  EVENT_KINDS,
  MAX_EVENTS,
  MAX_LIMIT_TOKENS,
  PRUNE_AGE_MS,
  WINDOW_IDS,
  WINDOW_MS,
  bucketStart,
  effectiveLimits,
  emptyBucket,
  findPlan,
  isExhausted,
  isVendorId,
  minuteKey,
  normalizeBucket,
  normalizeConfig,
  planDescriptor,
  pruneBuckets,
  ratioPercent,
  resetInFor,
  sumWindow,
  vendorById,
  vendorList,
} from './plans.js'
import { buildBlockedMessage, formatCount, formatDurationEn, formatDurationZh } from './format.js'

/** Default state file: `$DSH_HOME/plugin-data/dsh-subscription-sim/state.json`. */
export function defaultStateFile() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'dsh-subscription-sim', 'state.json')
}

/** Resolve a configured/overridden state file path; blank means the default. */
function resolveStateFile(candidate) {
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    return path.resolve(candidate.trim())
  }
  return defaultStateFile()
}

/** Default logger, prefixed for the Host log. */
function defaultLog(level, message) {
  const line = `[subscription-sim] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** Render an unknown thrown value as one line. */
function describeError(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

/** A non-negative integer, else 0. */
function nonNegativeInt(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** True when options classify this call as an auxiliary model call. */
function isAuxiliaryCall(options) {
  return options !== null && typeof options === 'object' && options.purpose !== undefined && options.purpose !== null
}

/** An expected action failure carrying a contract error code. */
export class EngineError extends Error {
  /**
   * @param {string} code contract error code
   * @param {string} message bilingual user-facing hint
   */
  constructor(code, message) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/**
 * Resolve one vendor/plan pair, falling back to the default pair when the
 * pairing is not in the catalogs. `custom` is valid under either vendor.
 * @param {unknown} vendorId
 * @param {unknown} planId
 * @returns {{ vendor: string, plan: string }}
 */
function resolveIdentity(vendorId, planId) {
  const vendor = isVendorId(vendorId) ? vendorId : DEFAULT_VENDOR
  if (planId === 'custom') return { vendor, plan: 'custom' }
  if (findPlan(vendor, planId) !== undefined) return { vendor, plan: planId }
  return { vendor: DEFAULT_VENDOR, plan: DEFAULT_PLAN }
}

/**
 * Infer a vendor for a version-1 state record that has no `vendor` field
 * (CONTRACT section 11). Ambiguous ids prefer Claude: `free`/`pro` exist in
 * both catalogs, while `plus`/`go` are OpenAI-only and `max5x`/`max20x` are
 * Claude-only.
 * @param {unknown} legacyPlan
 * @returns {string}
 */
function inferVendorFromLegacyPlan(legacyPlan) {
  switch (legacyPlan) {
    case 'max5x':
    case 'max20x':
    case 'free':
    case 'pro':
    case 'custom':
      return 'claude'
    case 'plus':
    case 'go':
      return 'openai'
    default:
      return DEFAULT_VENDOR
  }
}

/**
 * Resolve the persisted (possibly version-1) identity of one state record.
 * A valid stored vendor wins; otherwise the vendor is inferred from the
 * legacy plan id. The plan must then exist in the resolved vendor (or be
 * `custom`), else the default `{claude, max20x}` pair is used.
 * @param {{ vendor?: unknown, plan?: unknown }} raw
 * @returns {{ vendor: string, plan: string }}
 */
function resolvePersistedIdentity(raw) {
  const legacyPlan = typeof raw.plan === 'string' ? raw.plan : ''
  const vendor = isVendorId(raw.vendor) ? raw.vendor : inferVendorFromLegacyPlan(legacyPlan)
  if (legacyPlan === 'custom') return { vendor, plan: 'custom' }
  if (findPlan(vendor, legacyPlan) !== undefined) return { vendor, plan: legacyPlan }
  return { vendor: DEFAULT_VENDOR, plan: DEFAULT_PLAN }
}

/**
 * Limits seeded into `customLimits` when a state file carries no usable ones:
 * the resolved plan's limits, or the default plan's limits for `custom`.
 * @param {{ vendor: string, plan: string }} identity
 * @returns {{ h5: number, d7: number }}
 */
function seedLimitsFor(identity) {
  if (identity.plan === 'custom') return effectiveLimits(DEFAULT_VENDOR, DEFAULT_PLAN)
  return effectiveLimits(identity.vendor, identity.plan)
}

/** Fresh in-memory state for a missing/corrupt/absent state file. */
function freshState(config) {
  const identity = resolveIdentity(config.vendor, config.plan)
  const seedLimits = seedLimitsFor(identity)
  return {
    version: 2,
    vendor: identity.vendor,
    plan: identity.plan,
    customLimits: { h5: seedLimits.h5, d7: seedLimits.d7 },
    windows: { h5: config.windows.h5, d7: config.windows.d7 },
    settings: { enforce: config.enforce, countAuxiliary: config.countAuxiliary },
    buckets: {},
    lifetime: { tokens: 0, input: 0, output: 0, calls: 0, since: 0 },
    cards: config.cards.initialHeld,
    claimAt: 0,
    lastHit: null,
    simulateBlock: false,
    events: [],
  }
}

/** Normalize a persisted `lastHit` entry. */
function normalizeLastHit(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (!WINDOW_IDS.includes(raw.window)) return null
  const at = Number.isFinite(raw.at) ? Math.max(0, Math.trunc(raw.at)) : 0
  const seq = Number.isFinite(raw.seq) ? Math.max(0, Math.trunc(raw.seq)) : 0
  return { window: raw.window, at, seq }
}

/** Normalize the persisted event list (newest first, bounded). */
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) return []
  const events = []
  for (const entry of raw) {
    if (events.length >= MAX_EVENTS) break
    if (entry === null || typeof entry !== 'object') continue
    if (typeof entry.kind !== 'string' || !EVENT_KINDS.includes(entry.kind)) continue
    const event = {
      at: Number.isFinite(entry.at) ? Math.max(0, Math.trunc(entry.at)) : 0,
      kind: entry.kind,
    }
    if (WINDOW_IDS.includes(entry.window)) event.window = entry.window
    if (Number.isFinite(entry.tokens)) event.tokens = Math.max(0, Math.trunc(entry.tokens))
    if (typeof entry.message === 'string' && entry.message !== '') {
      event.message = entry.message.slice(0, 200)
    }
    events.push(event)
  }
  return events
}

/** Normalize persisted buckets, dropping malformed and pruned keys. */
function normalizeBuckets(raw, now) {
  const buckets = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return buckets
  const cutoff = now - PRUNE_AGE_MS
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(key)) continue
    const start = bucketStart(key)
    if (start === null || start <= cutoff) continue
    const bucket = normalizeBucket(value)
    if (bucket === null) continue
    buckets[key] = bucket
  }
  return buckets
}

/**
 * Normalize one persisted state object into the version-2 in-memory shape,
 * migrating a version-1 record per CONTRACT section 11. Every other field is
 * kept exactly as before: limits are pure functions of the new catalog, so a
 * bigger Max 20× window limit takes effect on reload without touching the
 * recorded usage. Never throws for malformed input (each field is defaulted).
 */
function normalizeState(raw, config, now) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return freshState(config)
  }
  const identity = resolvePersistedIdentity(raw)
  const seedLimits = seedLimitsFor(identity)
  const customSource =
    raw.customLimits !== null && typeof raw.customLimits === 'object' ? raw.customLimits : {}
  const windowsRaw =
    raw.windows !== null && typeof raw.windows === 'object' ? raw.windows : {}
  const settingsRaw =
    raw.settings !== null && typeof raw.settings === 'object' ? raw.settings : {}
  const lifetimeRaw =
    raw.lifetime !== null && typeof raw.lifetime === 'object' ? raw.lifetime : {}

  const windows = {
    h5: typeof windowsRaw.h5 === 'boolean' ? windowsRaw.h5 : config.windows.h5,
    d7: typeof windowsRaw.d7 === 'boolean' ? windowsRaw.d7 : config.windows.d7,
  }
  if (!windows.h5 && !windows.d7) {
    windows.h5 = true
    windows.d7 = true
  }

  const loadedCards = Number.isFinite(raw.cards) ? Math.trunc(raw.cards) : config.cards.initialHeld
  return {
    version: 2,
    vendor: identity.vendor,
    plan: identity.plan,
    customLimits: {
      h5: nonNegativeInt(customSource.h5) || seedLimits.h5,
      d7: nonNegativeInt(customSource.d7) || seedLimits.d7,
    },
    windows,
    settings: {
      enforce: typeof settingsRaw.enforce === 'boolean' ? settingsRaw.enforce : config.enforce,
      countAuxiliary:
        typeof settingsRaw.countAuxiliary === 'boolean'
          ? settingsRaw.countAuxiliary
          : config.countAuxiliary,
    },
    buckets: normalizeBuckets(raw.buckets, now),
    lifetime: {
      tokens: nonNegativeInt(lifetimeRaw.tokens),
      input: nonNegativeInt(lifetimeRaw.input),
      output: nonNegativeInt(lifetimeRaw.output),
      calls: nonNegativeInt(lifetimeRaw.calls),
      since: nonNegativeInt(lifetimeRaw.since),
    },
    cards: Math.max(0, Math.min(config.cards.maxHeld, loadedCards)),
    claimAt: Number.isFinite(raw.claimAt) ? Math.max(0, Math.trunc(raw.claimAt)) : 0,
    lastHit: normalizeLastHit(raw.lastHit),
    simulateBlock: raw.simulateBlock === true,
    events: normalizeEvents(raw.events),
  }
}

/** Build the engine object; `createEngine` awaits `ready` before returning. */
function makeEngine(options) {
  const config = normalizeConfig(options.config)
  const nowFn = typeof options.now === 'function' ? options.now : Date.now
  const stateFile = resolveStateFile(options.stateFile ?? config.stateFile)
  const log = typeof options.log === 'function' ? options.log : defaultLog

  /** @type {ReturnType<typeof freshState>} */
  let state = freshState(config)
  let stateLoaded = false
  /** Last storage outcome surfaced in the snapshot. */
  let storage = { ok: true, lastError: null }
  /** Serialized atomic saves. */
  let saveChain = Promise.resolve()
  let saveSeq = 0
  /** In-memory change counter used to skip a redundant save on `close()`. */
  let stateVersion = 0
  /** Version captured by the last successful write; -1 forces the first save. */
  let persistedVersion = -1
  /**
   * True while `state.lastHit` came from the one-shot diagnostic
   * `arm-simulate-block` rather than real quota exhaustion. The flag is
   * intentionally not persisted: a restart treats a stored hit as a real one.
   */
  let lastHitSimulated = false

  const currentTime = () => {
    const value = nowFn()
    return Number.isFinite(value) ? value : Date.now()
  }

  /** Mark the in-memory state as changed (persistence is version-based). */
  function markDirty() {
    stateVersion += 1
  }

  // -------------------------------------------------------------------------
  // Window math over the in-memory state
  // -------------------------------------------------------------------------

  /** Effective per-window limits of the active vendor+plan; never non-positive (defensive). */
  function limitsOf() {
    const limits = effectiveLimits(state.vendor, state.plan, state.customLimits)
    const fallback = effectiveLimits(DEFAULT_VENDOR, DEFAULT_PLAN)
    return {
      h5: limits.h5 > 0 ? limits.h5 : fallback.h5,
      d7: limits.d7 > 0 ? limits.d7 : fallback.d7,
    }
  }

  /** The active vendor catalog entry (always resolvable; default is a fallback). */
  function currentVendor() {
    return vendorById(state.vendor) ?? vendorById(DEFAULT_VENDOR)
  }

  /** Usage facts of one window right now. */
  function windowUsage(windowId, now) {
    const limit = limitsOf()[windowId]
    const summed = sumWindow(state.buckets, windowId, now)
    return {
      used: summed.tokens,
      oldestStart: summed.oldestStart,
      limit,
      percent: ratioPercent(summed.tokens, limit),
      exhausted: isExhausted(summed.tokens, limit),
    }
  }

  /** One snapshot window row. */
  function windowSnapshot(windowId, now) {
    const usage = windowUsage(windowId, now)
    const resetAt =
      usage.used === 0 || usage.oldestStart === null
        ? null
        : usage.oldestStart + WINDOW_MS[windowId]
    return {
      enabled: state.windows[windowId] === true,
      windowMs: WINDOW_MS[windowId],
      used: usage.used,
      limit: usage.limit,
      remaining: Math.max(0, usage.limit - usage.used),
      percent: usage.percent,
      exhausted: usage.exhausted,
      resetAt,
      resetInMs: resetAt === null ? null : Math.max(0, resetAt - now),
    }
  }

  /** Enabled windows whose quota is exhausted, highest percentage first. */
  function blockingInfo(now) {
    const rows = []
    for (const windowId of WINDOW_IDS) {
      if (state.windows[windowId] !== true) continue
      const usage = windowUsage(windowId, now)
      if (!usage.exhausted) continue
      rows.push({ window: windowId, used: usage.used, limit: usage.limit, percent: usage.percent })
    }
    rows.sort((left, right) => right.percent - left.percent)
    return rows
  }

  /** True when at least one enabled window is exhausted. */
  function anyEnabledExhausted(now) {
    return blockingInfo(now).length > 0
  }

  /**
   * Drop a *real* `lastHit` once nothing blocks anymore (the exhausted banner
   * must disappear after quota ages out). A diagnostic simulated hit is kept
   * until the next successful request consumes it or the user dismisses it.
   */
  function refreshHit(now) {
    if (state.lastHit === null) {
      lastHitSimulated = false
      return
    }
    if (lastHitSimulated) return
    if (!anyEnabledExhausted(now)) state.lastHit = null
  }

  /** Clear `lastHit` (and its diagnostic marker); returns true when it changed. */
  function clearLastHit() {
    if (state.lastHit === null && lastHitSimulated === false) return false
    state.lastHit = null
    lastHitSimulated = false
    return true
  }

  /** Delete pruned minute buckets (7 days + 1 hour old). */
  function prune(now) {
    pruneBuckets(state.buckets, now)
  }

  /** Append one event, newest first, bounded. */
  function pushEvent(entry) {
    const event = {
      at: Number.isFinite(entry.at) ? Math.max(0, Math.trunc(entry.at)) : currentTime(),
      kind: entry.kind,
    }
    if (WINDOW_IDS.includes(entry.window)) event.window = entry.window
    if (Number.isFinite(entry.tokens)) event.tokens = Math.max(0, Math.trunc(entry.tokens))
    if (typeof entry.message === 'string' && entry.message !== '') {
      event.message = entry.message.slice(0, 200)
    }
    state.events.unshift(event)
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Persisted (version 2) shape of the current in-memory state. */
  function toPersistedState() {
    return {
      version: 2,
      vendor: state.vendor,
      plan: state.plan,
      customLimits: { h5: state.customLimits.h5, d7: state.customLimits.d7 },
      windows: { h5: state.windows.h5, d7: state.windows.d7 },
      settings: { enforce: state.settings.enforce, countAuxiliary: state.settings.countAuxiliary },
      buckets: state.buckets,
      lifetime: {
        tokens: state.lifetime.tokens,
        input: state.lifetime.input,
        output: state.lifetime.output,
        calls: state.lifetime.calls,
        since: state.lifetime.since,
      },
      cards: state.cards,
      claimAt: state.claimAt,
      lastHit: state.lastHit,
      simulateBlock: state.simulateBlock === true,
      events: state.events,
    }
  }

  /** One atomic write: temp file in the same directory, then rename. */
  async function writeStateOnce() {
    const versionAtWrite = stateVersion
    const payload = `${JSON.stringify(toPersistedState())}\n`
    const temporary = `${stateFile}.tmp-${process.pid}-${++saveSeq}`
    try {
      await fsp.mkdir(path.dirname(stateFile), { recursive: true })
      await fsp.writeFile(temporary, payload, 'utf8')
      await fsp.rename(temporary, stateFile)
      storage = { ok: true, lastError: null }
      persistedVersion = versionAtWrite
    } catch (error) {
      storage = { ok: false, lastError: describeError(error) }
      try {
        await fsp.unlink(temporary)
      } catch {
        // Best effort: the temp file may not exist.
      }
      log('warn', `failed to persist ${stateFile}: ${describeError(error)}`)
      throw new EngineError(
        'storage_failure',
        `状态保存失败：${describeError(error)}。改动已保留在内存中，重启后可能丢失。Failed to persist the subscription state; the change stays in memory and may be lost after restart.`,
      )
    }
  }

  /** Enqueue one serialized atomic save. */
  function enqueueSave() {
    const run = saveChain.then(() => writeStateOnce())
    saveChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Fire-and-forget save for usage recording and blocked hits. */
  function scheduleSave() {
    void enqueueSave().catch(() => {
      // writeStateOnce already logged and recorded the failure.
    })
  }

  /** Await the serialized save for a user action. */
  async function persistAction() {
    try {
      await enqueueSave()
    } catch (error) {
      if (error instanceof EngineError) throw error
      throw new EngineError(
        'storage_failure',
        `状态保存失败：${describeError(error)}。Failed to persist the subscription state.`,
      )
    }
  }

  // -------------------------------------------------------------------------
  // Load / quarantine
  // -------------------------------------------------------------------------

  /** Move a corrupt state file aside so the next write starts fresh. */
  async function quarantineCorrupt() {
    const target = `${stateFile}.corrupt-${Date.now()}`
    try {
      await fsp.rename(stateFile, target)
      log('warn', `corrupt state file was moved to ${target}; starting with fresh state`)
    } catch (error) {
      log('warn', `corrupt state file could not be moved aside: ${describeError(error)}`)
    }
  }

  /** Load the state file; never throws. */
  async function load() {
    let text
    try {
      text = await fsp.readFile(stateFile, 'utf8')
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      if (code !== 'ENOENT') {
        log('warn', `cannot read state file ${stateFile}: ${describeError(error)}; using defaults`)
      }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      await quarantineCorrupt()
      return
    }
    try {
      state = normalizeState(parsed, config, currentTime())
    } catch (error) {
      log('warn', `state file normalization failed: ${describeError(error)}; starting fresh`)
      await quarantineCorrupt()
      state = freshState(config)
      return
    }
    if (state.lastHit !== null && !anyEnabledExhausted(currentTime())) {
      state.lastHit = null
    }
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /** True when the configuration disables reset cards entirely. */
  function cardsDisabled() {
    return config.cards.maxHeld <= 0
  }

  /** Milliseconds of claim cooldown left at `now` (0 when claimable). */
  function cooldownRemainingMs(now) {
    const total = config.cards.claimCooldownSeconds * 1000
    if (total <= 0) return 0
    const elapsed = now - state.claimAt
    if (!Number.isFinite(elapsed) || elapsed >= total) return 0
    return Math.max(0, Math.min(total, total - Math.max(0, elapsed)))
  }

  /** Whether a claim would succeed right now. */
  function canClaim(now) {
    if (cardsDisabled()) return false
    if (state.cards >= config.cards.maxHeld) return false
    return cooldownRemainingMs(now) === 0
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  /** Window blamed for the simulated diagnostic block. */
  function simulatedTarget(now) {
    const preferred =
      state.lastHit !== null && WINDOW_IDS.includes(state.lastHit.window)
        ? state.lastHit.window
        : null
    if (preferred !== null && state.windows[preferred] === true) {
      const usage = windowUsage(preferred, now)
      return { window: preferred, used: usage.used, limit: usage.limit }
    }
    let best = null
    for (const windowId of WINDOW_IDS) {
      if (state.windows[windowId] !== true) continue
      const usage = windowUsage(windowId, now)
      if (best === null || usage.percent > best.percent) {
        best = { window: windowId, used: usage.used, limit: usage.limit, percent: usage.percent }
      }
    }
    if (best !== null) return { window: best.window, used: best.used, limit: best.limit }
    return { window: 'h5', used: 0, limit: limitsOf().h5 }
  }

  /** Bilingual `vendor · plan` label carried by the user-facing blocked message. */
  function planLabel() {
    const vendor = currentVendor()
    const plan = planDescriptor(state.vendor, state.plan, state.customLimits)
    return {
      zh: `${vendor.name.zh} · ${plan.name.zh}`,
      en: `${vendor.name.en} · ${plan.name.en}`,
    }
  }

  /** Record `lastHit` + blocked event, then return the decision object. */
  function blockWith(now, windowId, used, limit, simulated) {
    prune(now)
    const usage = windowUsage(windowId, now)
    const resetInMs = resetInFor(usage.oldestStart, windowId, now)
    const message = buildBlockedMessage({
      window: windowId,
      used,
      limit,
      resetInMs: resetInMs === null ? null : Math.max(0, resetInMs),
      cardsHeld: state.cards,
      simulated,
      planLabel: planLabel(),
    })
    const seq = (state.lastHit !== null ? state.lastHit.seq : 0) + 1
    state.lastHit = { window: windowId, at: now, seq }
    lastHitSimulated = simulated === true
    pushEvent({ at: now, kind: 'blocked', window: windowId, tokens: used })
    markDirty()
    scheduleSave()
    return { blocked: true, window: windowId, used, limit, message, simulated, seq }
  }

  /** Pure predicate: skip semantics of the enforcement gate (no mutation). */
  function shouldBlock(options) {
    try {
      if (!stateLoaded) return false
      if (state.settings.enforce === false) return false
      if (isAuxiliaryCall(options) && state.settings.countAuxiliary !== true) return false
      if (state.simulateBlock === true) return true
      return anyEnabledExhausted(currentTime())
    } catch (error) {
      log('warn', `block predicate failed: ${describeError(error)}`)
      return false
    }
  }

  /**
   * Atomically decide whether this request is blocked and, when it is, clear
   * the one-shot simulateBlock flag, record lastHit + a blocked event, and
   * schedule a fire-and-forget save. Never throws.
   */
  function consumeBlock(options) {
    try {
      if (!stateLoaded) return { blocked: false }
      if (state.settings.enforce === false) return { blocked: false }
      if (isAuxiliaryCall(options) && state.settings.countAuxiliary !== true) {
        return { blocked: false }
      }
      const now = currentTime()
      const blockedWindows = blockingInfo(now)
      if (blockedWindows.length > 0) {
        const target = blockedWindows[0]
        // A blocked request consumes the armed diagnostic flag as well: it did
        // block the next request, so it must not leak into a later one.
        if (state.simulateBlock === true) state.simulateBlock = false
        return blockWith(now, target.window, target.used, target.limit, false)
      }
      if (state.simulateBlock === true) {
        state.simulateBlock = false
        const target = simulatedTarget(now)
        return blockWith(now, target.window, target.used, target.limit, true)
      }
      // The request is not blocked. If quota aged out of its window, the
      // stale lastHit must not keep the Client's exhausted banner alive; a
      // diagnostic simulated hit is cleared by the first request that passes.
      const previousHit = state.lastHit
      refreshHit(now)
      if (lastHitSimulated) {
        clearLastHit()
        markDirty()
        scheduleSave()
      } else if (state.lastHit === null && previousHit !== null) {
        markDirty()
        scheduleSave()
      }
      return { blocked: false }
    } catch (error) {
      log('warn', `block decision failed open: ${describeError(error)}`)
      return { blocked: false }
    }
  }

  // -------------------------------------------------------------------------
  // Usage recording
  // -------------------------------------------------------------------------

  /**
   * Record one `usage` StreamChunk synchronously in memory, then schedule a
   * serialized save. Never awaits disk and never throws.
   */
  function recordUsage(usage, options) {
    try {
      if (!stateLoaded) return
      if (usage === null || typeof usage !== 'object') return
      if (isAuxiliaryCall(options) && state.settings.countAuxiliary !== true) return
      const now = currentTime()
      // A successful model request proves the window is usable again; clear a
      // stale banner hit if quota aged out since it was recorded.
      refreshHit(now)
      prune(now)
      const input = nonNegativeInt(usage.inputTokens)
      const output = nonNegativeInt(usage.outputTokens)
      const cacheRead = nonNegativeInt(usage.cacheReadTokens)
      const cacheWrite = nonNegativeInt(usage.cacheWriteTokens)
      const total = Number.isFinite(usage.totalTokens)
        ? Math.max(0, Math.trunc(usage.totalTokens))
        : input + output

      const key = minuteKey(now)
      const bucket = state.buckets[key] ?? emptyBucket()
      bucket.input += input
      bucket.output += output
      bucket.cacheRead += cacheRead
      bucket.cacheWrite += cacheWrite
      bucket.tokens += total
      bucket.calls += 1
      state.buckets[key] = bucket

      state.lifetime.tokens += total
      state.lifetime.input += input
      state.lifetime.output += output
      state.lifetime.calls += 1
      if (!(state.lifetime.since > 0)) state.lifetime.since = now

      pushEvent({ at: now, kind: 'usage', tokens: total })
      markDirty()
      scheduleSave()
    } catch (error) {
      log('warn', `usage recording failed: ${describeError(error)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /** Build the exact snapshot shape the Client consumes. */
  function snapshot() {
    const now = currentTime()
    // Self-heal a stale *real* banner hit: when usage has aged out of every
    // enabled window, nothing is blocked anymore and the Client must not keep
    // showing the exhausted banner (its poll reads this snapshot). A
    // diagnostic simulated hit is handled by the next passing request instead.
    if (state.lastHit !== null && !lastHitSimulated && !anyEnabledExhausted(now)) {
      clearLastHit()
      markDirty()
      scheduleSave()
    }
    const vendor = currentVendor()
    const plan = planDescriptor(state.vendor, state.plan, state.customLimits)
    const h5 = windowSnapshot('h5', now)
    const d7 = windowSnapshot('d7', now)
    const blockedWindows = []
    for (const [windowId, row] of [
      ['h5', h5],
      ['d7', d7],
    ]) {
      if (row.enabled && row.exhausted) {
        blockedWindows.push({ window: windowId, percent: row.percent })
      }
    }
    blockedWindows.sort((left, right) => right.percent - left.percent)
    return {
      ok: true,
      serverNow: now,
      version: 2,
      vendor: {
        id: vendor.id,
        name: { zh: vendor.name.zh, en: vendor.name.en },
        note: { zh: vendor.note.zh, en: vendor.note.en },
      },
      plan: {
        id: plan.id,
        name: { zh: plan.name.zh, en: plan.name.en },
        priceUSD: plan.priceUSD,
        limits: { h5: plan.limits.h5, d7: plan.limits.d7 },
        custom: plan.id === 'custom',
        vendorId: vendor.id,
        vendorName: { zh: vendor.name.zh, en: vendor.name.en },
      },
      vendors: vendorList(),
      windows: { h5, d7 },
      blocked: blockedWindows.length > 0,
      blockedWindow: blockedWindows.length > 0 ? blockedWindows[0].window : null,
      settings: {
        enforce: state.settings.enforce,
        countAuxiliary: state.settings.countAuxiliary,
        windows: { h5: state.windows.h5, d7: state.windows.d7 },
        cards: {
          maxHeld: config.cards.maxHeld,
          claimCooldownSeconds: config.cards.claimCooldownSeconds,
          claimBatch: config.cards.claimBatch,
          initialHeld: config.cards.initialHeld,
        },
      },
      cards: {
        held: state.cards,
        maxHeld: config.cards.maxHeld,
        canClaim: canClaim(now),
        cooldownRemainingMs: cooldownRemainingMs(now),
        claimBatch: config.cards.claimBatch,
      },
      lifetime: {
        tokens: state.lifetime.tokens,
        input: state.lifetime.input,
        output: state.lifetime.output,
        calls: state.lifetime.calls,
        since: state.lifetime.since,
      },
      lastHit: state.lastHit === null ? null : { ...state.lastHit },
      simulateBlock: state.simulateBlock === true,
      events: state.events.map((event) => ({
        at: event.at,
        kind: event.kind,
        window: event.window ?? null,
        tokens: event.tokens ?? null,
        message: event.message ?? null,
      })),
      storage: { stateFile, ok: storage.ok, lastError: storage.lastError },
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Self-issue reset card(s). */
  async function claimCard(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    if (cardsDisabled()) {
      throw new EngineError(
        'cards_disabled',
        '重置卡已在配置中禁用。Reset cards are disabled by configuration.',
      )
    }
    const now = currentTime()
    let requested
    if (source.count === undefined) {
      requested = config.cards.claimBatch
    } else {
      if (!Number.isInteger(source.count) || source.count < 1 || source.count > 9) {
        throw new EngineError(
          'invalid_body',
          'count 必须是 1 到 9 之间的整数。count must be an integer between 1 and 9.',
        )
      }
      requested = source.count
    }
    const available = config.cards.maxHeld - state.cards
    if (available <= 0) {
      throw new EngineError(
        'max_held',
        `重置卡已到上限：${state.cards}/${config.cards.maxHeld}。Reset card inventory is full (${state.cards}/${config.cards.maxHeld}).`,
      )
    }
    const remaining = cooldownRemainingMs(now)
    if (remaining > 0) {
      throw new EngineError(
        'claim_cooldown',
        `领取冷却中，还需等待 ${formatDurationZh(remaining)}。Claim cooldown active; retry in ${formatDurationEn(remaining)}.`,
      )
    }
    const grant = Math.min(requested, available)
    prune(now)
    state.cards += grant
    state.claimAt = now
    pushEvent({ at: now, kind: 'claim', message: `+${grant}` })
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Spend one held card to clear a window's usage buckets. */
  async function useCard(requestedWindow) {
    const requested =
      requestedWindow === undefined || requestedWindow === null ? 'auto' : requestedWindow
    if (requested !== 'auto' && requested !== 'h5' && requested !== 'd7') {
      throw new EngineError(
        'invalid_body',
        'window 必须是 h5、d7 或 auto。window must be "h5", "d7", or "auto".',
      )
    }
    if (cardsDisabled()) {
      throw new EngineError(
        'cards_disabled',
        '重置卡已在配置中禁用。Reset cards are disabled by configuration.',
      )
    }
    if (state.cards <= 0) {
      throw new EngineError(
        'no_cards',
        '没有可用的重置卡。No reset cards are held; claim one first.',
      )
    }
    const now = currentTime()
    prune(now)
    const target = requested === 'auto' ? resolveAutoCardWindow(now) : requested
    // Cards only clear the window's usage buckets; lifetime counters stay.
    const cutoff = now - WINDOW_MS[target]
    for (const key of Object.keys(state.buckets)) {
      const start = bucketStart(key)
      if (start !== null && start > cutoff) delete state.buckets[key]
    }
    state.cards -= 1
    pushEvent({ at: now, kind: 'redeem', window: target })
    if (!anyEnabledExhausted(now)) clearLastHit()
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Target window for `use-card` with `window: 'auto'`. */
  function resolveAutoCardWindow(now) {
    const hitWindow =
      state.lastHit !== null && WINDOW_IDS.includes(state.lastHit.window)
        ? state.lastHit.window
        : null
    if (hitWindow !== null && windowUsage(hitWindow, now).exhausted) return hitWindow
    let best = null
    for (const windowId of WINDOW_IDS) {
      if (state.windows[windowId] !== true) continue
      const usage = windowUsage(windowId, now)
      if (best === null || usage.percent > best.percent) {
        best = { window: windowId, percent: usage.percent }
      }
    }
    return best === null ? 'h5' : best.window
  }

  /**
   * Switch the simulated vendor + plan preset, keeping recorded usage
   * (CONTRACT section 12). The action body is `{ vendor, planId }`: both are
   * required and the plan must belong to that vendor. `custom` is reached
   * through `set-limit`, never through `set-plan`. Unknown selections fail
   * with `unknown_plan` and leave the state untouched.
   */
  async function setPlan(input) {
    const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
    const vendorId = typeof source.vendor === 'string' ? source.vendor : undefined
    const planId = typeof source.planId === 'string' ? source.planId : undefined
    if (
      vendorId === undefined ||
      planId === undefined ||
      !isVendorId(vendorId) ||
      planId === 'custom' ||
      findPlan(vendorId, planId) === undefined
    ) {
      const selection = `${String(source.vendor)}/${String(source.planId)}`
      throw new EngineError(
        'unknown_plan',
        `未知套餐：${selection}。Unknown vendor/plan selection: ${selection}.`,
      )
    }
    const now = currentTime()
    prune(now)
    state.vendor = vendorId
    state.plan = planId
    pushEvent({ at: now, kind: 'plan', message: `${vendorId}/${planId}` })
    refreshHit(now)
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Enable/disable the rolling windows; at least one must stay enabled. */
  async function setWindows(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const next = { h5: state.windows.h5, d7: state.windows.d7 }
    let changed = false
    for (const windowId of WINDOW_IDS) {
      if (source[windowId] === undefined) continue
      if (typeof source[windowId] !== 'boolean') {
        throw new EngineError(
          'invalid_body',
          `window.${windowId} 必须是布尔值。window.${windowId} must be a boolean.`,
        )
      }
      next[windowId] = source[windowId]
      changed = true
    }
    if (!changed) {
      throw new EngineError(
        'invalid_body',
        '至少提供 h5 或 d7 之一。Provide at least one of h5 / d7.',
      )
    }
    if (!next.h5 && !next.d7) {
      throw new EngineError(
        'both_windows_disabled',
        '5 小时窗口与 7 天窗口不能同时关闭。At least one rolling window must stay enabled.',
      )
    }
    const now = currentTime()
    prune(now)
    state.windows = next
    pushEvent({ at: now, kind: 'windows' })
    refreshHit(now)
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Update enforcement/settings toggles. */
  async function setSettings(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    const next = {
      enforce: state.settings.enforce,
      countAuxiliary: state.settings.countAuxiliary,
    }
    let changed = false
    for (const key of ['enforce', 'countAuxiliary']) {
      if (source[key] === undefined) continue
      if (typeof source[key] !== 'boolean') {
        throw new EngineError(
          'invalid_body',
          `settings.${key} 必须是布尔值。settings.${key} must be a boolean.`,
        )
      }
      next[key] = source[key]
      changed = true
    }
    if (!changed) {
      throw new EngineError(
        'invalid_body',
        '至少提供 enforce 或 countAuxiliary 之一。Provide at least one of enforce / countAuxiliary.',
      )
    }
    const now = currentTime()
    prune(now)
    state.settings = next
    pushEvent({ at: now, kind: 'settings' })
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Set one custom limit; switches the plan to `custom` and keeps the current vendor. */
  async function setLimit(input) {
    const source = input !== null && typeof input === 'object' ? input : {}
    if (source.window !== 'h5' && source.window !== 'd7') {
      throw new EngineError(
        'invalid_body',
        'window 必须是 h5 或 d7。window must be "h5" or "d7".',
      )
    }
    const tokens = source.tokens
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > MAX_LIMIT_TOKENS) {
      throw new EngineError(
        'invalid_limit',
        `额度必须是 1 到 ${formatCount(MAX_LIMIT_TOKENS)} 之间的整数。The limit must be an integer between 1 and ${formatCount(MAX_LIMIT_TOKENS)} tokens.`,
      )
    }
    const now = currentTime()
    prune(now)
    const current = limitsOf()
    const next = { h5: current.h5, d7: current.d7 }
    next[source.window] = tokens
    state.customLimits = next
    state.plan = 'custom'
    pushEvent({ at: now, kind: 'plan', message: 'custom' })
    refreshHit(now)
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Clear all simulated usage; keep plan/windows/settings. */
  async function resetAll() {
    const now = currentTime()
    state.buckets = {}
    state.lifetime = { tokens: 0, input: 0, output: 0, calls: 0, since: 0 }
    clearLastHit()
    state.simulateBlock = false
    state.events = []
    state.cards = Math.min(config.cards.initialHeld, config.cards.maxHeld)
    state.claimAt = 0
    pushEvent({ at: now, kind: 'reset' })
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Clear the banner's last hit; the quota stays exhausted. */
  async function dismissHit() {
    clearLastHit()
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Arm the one-shot diagnostic block. */
  async function armSimulateBlock() {
    state.simulateBlock = true
    markDirty()
    await persistAction()
    return snapshot()
  }

  /** Await a final save (only when needed) and release the engine (no timers are owned). */
  async function close() {
    try {
      await saveChain
      if (stateVersion !== persistedVersion) await enqueueSave()
    } catch {
      // A failed final save is already logged and surfaced via snapshot.storage.
    }
  }

  const ready = (async () => {
    await load()
    stateLoaded = true
    // Establish/refresh the durable file so a corrupt or missing file is
    // repaired at activation. A write failure keeps the engine in memory.
    try {
      await enqueueSave()
    } catch {
      // Recorded in snapshot.storage; activation must not throw.
    }
    return true
  })()

  return {
    ready,
    snapshot,
    recordUsage,
    shouldBlock,
    consumeBlock,
    claimCard,
    useCard,
    setPlan,
    setWindows,
    setSettings,
    setLimit,
    resetAll,
    dismissHit,
    armSimulateBlock,
    close,
    /** Resolved state file path (absolute). */
    get stateFile() {
      return stateFile
    },
  }
}

/**
 * Create the engine and wait for its state file to load.
 *
 * @param {object} [options]
 * @param {unknown} [options.config] raw or normalized plugin config
 * @param {string} [options.stateFile] absolute state file override
 * @param {() => number} [options.now] injectable clock (default `Date.now`)
 * @param {(level: string, message: string) => void} [options.log] logger
 * @returns {Promise<ReturnType<typeof makeEngine>>}
 */
export async function createEngine(options = {}) {
  const engine = makeEngine(options !== null && typeof options === 'object' ? options : {})
  await engine.ready
  return engine
}
