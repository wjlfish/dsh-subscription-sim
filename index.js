/**
 * Subscription simulator — Host half.
 *
 * Pretends DeepSeek sells OpenAI/Anthropic-style subscription plans: two
 * rolling token windows (5 hours / 7 days), a genuine quota error when an
 * enabled window is exhausted (terminal `finish` chunk with code
 * `SUBSCRIPTION_QUOTA`), self-issued reset cards, and durable local state.
 *
 * The quota is a LOCAL SIMULATION: this plugin only counts the token usage
 * chunks of model requests in this Harness process and stores the numbers in
 * its own JSON state file. It never bills, contacts DeepSeek, or changes the
 * real model routing.
 *
 * Host responsibilities:
 * - `llm/stream` enforcement + usage recording (prepended, global).
 * - `subscription_status` read-only agent tool.
 * - `POST /subscription-sim/api` JSON route for the Client panel, including a
 *   `probe` action that makes one real tiny model call to prove enforcement.
 *
 * Zero `@deepseek-ai/*` imports and zero npm dependencies: plain workspace
 * bundles resolve only relative modules and node builtins reliably.
 */
import { normalizeConfig } from './lib/plans.js'
import { EngineError, createEngine } from './lib/engine.js'
import {
  QUOTA_CODE,
  formatCount,
  formatDurationEn,
  formatPrice,
  formatTokens,
} from './lib/format.js'

/** Cordis function-plugin name. */
export const name = 'subscription-sim'

/** Services this plugin needs: the stream waterfall, the tool registry, the route carrier, the fence, the model, the LLM runtime. */
export const inject = ['tools', 'webServer', 'connection', 'llm', 'agentDefaultModel']

/** Client ↔ Host JSON route. */
const ROUTE = '/subscription-sim/api'
/** Request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024
/** Probe cancellation budget. */
const PROBE_TIMEOUT_MS = 30_000
/** Probe output budget: one tiny completion. */
const PROBE_MAX_TOKENS = 16

/** Prefixed Host log line. */
function log(level, message) {
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

/** JSON response helper; every route outcome is JSON. */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method (JSON body). */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  sendJson(res, 405, {
    ok: false,
    error: {
      code: 'invalid_method',
      message: '仅支持 POST 请求。Only POST requests are supported by this route.',
    },
  })
}

/**
 * Read one bounded JSON request body. Returns null past the 64 KiB ceiling;
 * the remainder is drained so the response can still be written.
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  let tooLarge = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      tooLarge = true
      chunks.length = 0
      continue
    }
    chunks.push(buffer)
  }
  if (tooLarge) return null
  return Buffer.concat(chunks)
}

/** A JSON-safe non-negative integer. */
function nonNegativeInt(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/** Copy a `TokenUsage` from a stream chunk into a JSON-safe object. */
function usageCopy(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {}
  return {
    inputTokens: nonNegativeInt(source.inputTokens),
    outputTokens: nonNegativeInt(source.outputTokens),
    totalTokens: Number.isFinite(source.totalTokens) ? Math.trunc(source.totalTokens) : null,
  }
}

/** Model-facing tool value: a read-only summary of the simulation state. */
function buildToolValue(snapshot, verbose) {
  const windows = {}
  for (const windowId of ['h5', 'd7']) {
    const row = snapshot.windows[windowId]
    windows[windowId] = {
      enabled: row.enabled,
      windowMs: row.windowMs,
      used: row.used,
      limit: row.limit,
      remaining: row.remaining,
      percent: row.percent,
      exhausted: row.exhausted,
      resetAt: row.resetAt,
      resetInMs: row.resetInMs,
    }
  }
  const vendor =
    snapshot.vendor !== null && typeof snapshot.vendor === 'object' ? snapshot.vendor : null
  const vendorName = vendor === null ? { zh: '未知', en: 'Unknown' } : vendor.name
  const vendorNote = vendor === null ? { zh: '', en: '' } : vendor.note
  const value = {
    ok: true,
    simulated: true,
    vendor: {
      id: vendor === null ? null : vendor.id,
      name: vendorName.en,
      note: vendorNote.en,
    },
    plan: {
      id: snapshot.plan.id,
      name: snapshot.plan.name.en,
      priceUSD: snapshot.plan.priceUSD,
      limits: snapshot.plan.limits,
      custom: snapshot.plan.custom === true,
      vendorId: snapshot.plan.vendorId ?? (vendor === null ? null : vendor.id),
      vendorName: snapshot.plan.vendorName !== undefined ? snapshot.plan.vendorName.en : vendorName.en,
    },
    windows,
    blocked: snapshot.blocked,
    blockedWindow: snapshot.blockedWindow,
    enforce: snapshot.settings.enforce,
    countAuxiliary: snapshot.settings.countAuxiliary,
    cards: {
      held: snapshot.cards.held,
      maxHeld: snapshot.cards.maxHeld,
      canClaim: snapshot.cards.canClaim,
      cooldownRemainingMs: snapshot.cards.cooldownRemainingMs,
      claimBatch: snapshot.cards.claimBatch,
    },
    lifetime: snapshot.lifetime,
    lastHit: snapshot.lastHit,
    storage: {
      stateFile: snapshot.storage.stateFile,
      ok: snapshot.storage.ok,
      lastError: snapshot.storage.lastError,
    },
    note: 'Local simulation only: these quotas, plans, and reset cards exist in this Harness process. No real DeepSeek subscription or billing is involved. Plans come from two vendor catalogs (Anthropic Claude and OpenAI ChatGPT); the vendor, plan, quota windows and enforcement switches are changed in the Web Settings page (设置 → 订阅额度), not in the main panel. Claiming/redeeming cards is a user-only action in the Web side panel, not a tool action.',
  }
  if (verbose) value.events = snapshot.events.slice(0, 10)
  return value
}

/** Render the tool value as compact model-facing text. Never throws. */
function renderToolSummary(value) {
  try {
    if (value === null || typeof value !== 'object') {
      return 'Subscription quota simulator: no snapshot is available.'
    }
    const lines = []
    lines.push(
      'Subscription quota simulator (local simulation only; no real DeepSeek subscription or billing exists).',
    )
    if (value.vendor !== null && value.vendor !== undefined && value.vendor.name) {
      const note = value.vendor.note ? ` — ${value.vendor.note}` : ''
      lines.push(`Vendor: ${value.vendor.name} (id ${value.vendor.id})${note}.`)
    }
    lines.push(
      `Plan: ${value.plan.name} (id ${value.plan.id}, ${formatPrice(value.plan.priceUSD)} simulated) in ${value.plan.vendorName}.`,
    )
    for (const windowId of ['h5', 'd7']) {
      const row = value.windows[windowId]
      const label = windowId === 'h5' ? '5-hour' : '7-day'
      const status = row.exhausted ? 'EXHAUSTED' : `${row.percent.toFixed(1)}% used`
      const release =
        row.resetInMs === null
          ? 'no counted usage in the window'
          : `oldest usage leaves the window in ${formatDurationEn(row.resetInMs)}`
      lines.push(
        `- ${label} window [${row.enabled ? 'enabled' : 'disabled'}]: ${formatCount(row.used)} / ${formatCount(row.limit)} tokens, ${status}; ${release}.`,
      )
    }
    lines.push(
      `Enforcement: ${
        value.enforce
          ? 'enabled — the next model request fails with SUBSCRIPTION_QUOTA when an enabled window is exhausted'
          : 'disabled — no request is blocked'
      }; auxiliary compaction/session-title calls are ${value.countAuxiliary ? 'counted and blockable' : 'free and never blocked'}.`,
    )
    if (value.blocked === true) {
      lines.push(
        `Current status: BLOCKED by the ${value.blockedWindow} window; requests fail until quota is released or a reset card is used.`,
      )
    }
    if (value.lastHit !== null && value.lastHit !== undefined) {
      lines.push(
        `Last blocked request: ${value.lastHit.window} window at ${new Date(value.lastHit.at).toISOString()} (hit #${value.lastHit.seq}).`,
      )
    }
    let claimState = 'no'
    if (value.cards.canClaim === true) claimState = 'yes'
    else if (value.cards.cooldownRemainingMs > 0) {
      claimState = `no (cooldown ${formatDurationEn(value.cards.cooldownRemainingMs)})`
    } else if (value.cards.held >= value.cards.maxHeld) {
      claimState = 'no (inventory full)'
    }
    lines.push(
      `Reset cards: ${value.cards.held}/${value.cards.maxHeld} held; claimable now: ${claimState}. Reset cards are user-only actions in the side panel.`,
    )
    lines.push(
      `Lifetime: ${formatTokens(value.lifetime.tokens)} tokens (${formatTokens(value.lifetime.input)} input / ${formatTokens(value.lifetime.output)} output) across ${formatCount(value.lifetime.calls)} calls.`,
    )
    const storageSuffix =
      value.storage.ok === false ? ` (last save failed: ${String(value.storage.lastError)})` : ''
    lines.push(
      'Plan, vendor, quota windows and enforcement switches are changed in the Web Settings page (设置 → 订阅额度), not in the main panel; the main panel only shows status and reset cards.',
    )
    lines.push(`State file: ${value.storage.stateFile}${storageSuffix}`)
    if (Array.isArray(value.events) && value.events.length > 0) {
      lines.push('Recent events:')
      for (const event of value.events) {
        const parts = [String(event.kind)]
        if (event.window !== null && event.window !== undefined) parts.push(String(event.window))
        if (event.tokens !== null && event.tokens !== undefined) {
          parts.push(`${formatTokens(event.tokens)} tokens`)
        }
        parts.push(new Date(event.at).toISOString())
        lines.push(`- ${parts.join(' · ')}`)
      }
    }
    return lines.join('\n')
  } catch {
    return 'Subscription quota simulator: failed to render the snapshot summary.'
  }
}

/**
 * Resolve the model target for a probe: explicit body fields first, else the
 * composition's default model selection.
 */
function resolveProbeTarget(ctx, body) {
  let provider = typeof body.provider === 'string' ? body.provider.trim() : undefined
  let model = typeof body.model === 'string' ? body.model.trim() : undefined
  if (provider === '') provider = undefined
  if (model === '') model = undefined
  if (provider === undefined || model === undefined) {
    let selection
    try {
      selection = ctx.agentDefaultModel.currentSelection()
    } catch {
      selection = undefined
    }
    if (selection !== null && typeof selection === 'object') {
      if (provider === undefined && typeof selection.provider === 'string' && selection.provider !== '') {
        provider = selection.provider
      }
      if (model === undefined && typeof selection.model === 'string' && selection.model !== '') {
        model = selection.model
      }
    }
  }
  if (provider === undefined || model === undefined) return null
  return { provider, model }
}

/**
 * Make one real tiny model call through `ctx.llm.stream()` so the enforcement
 * listener runs end to end. A quota block becomes `blocked: true` instead of a
 * thrown error; provider/transport failures land in `error`.
 */
async function runProbe(ctx, engine, body) {
  const target = resolveProbeTarget(ctx, body)
  if (target === null) {
    return {
      ok: false,
      error: {
        code: 'invalid_body',
        message:
          '没有可用的默认模型（provider/model）。请在探测请求中显式提供 provider 与 model。No default model selection is available; pass "provider" and "model" in the probe request.',
      },
    }
  }
  /** @type {string[]} */
  const chunkTypes = []
  /** @type {object | null} */
  let usage = null
  let blocked = false
  /** @type {{ message: string, code: string, status?: number } | null} */
  let failure = null
  /** @type {{ message: string, code: string } | null} */
  let probeError = null

  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      // Aborting an already-settled controller is harmless.
    }
  }, PROBE_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()

  try {
    /** @type {any} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      maxTokens: PROBE_MAX_TOKENS,
      signal: controller.signal,
    }
    for await (const chunk of ctx.llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunkTypes.length < 64) chunkTypes.push(String(chunk.type))
      if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        usage = usageCopy(chunk.usage)
      }
      if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (
          reason !== null &&
          typeof reason === 'object' &&
          (reason.kind === 'error' || reason.kind === 'aborted') &&
          reason.failure !== null &&
          typeof reason.failure === 'object'
        ) {
          const info = {
            message: typeof reason.failure.message === 'string' ? reason.failure.message : '',
            code: typeof reason.failure.code === 'string' ? reason.failure.code : 'UNKNOWN',
          }
          if (Number.isFinite(reason.failure.status)) {
            info.status = Math.trunc(reason.failure.status)
          }
          if (reason.kind === 'error' && info.code === QUOTA_CODE) {
            blocked = true
            failure = info
          } else {
            probeError = info
          }
        }
        break
      }
    }
  } catch (error) {
    probeError = {
      code: typeof error?.code === 'string' ? error.code : 'probe_failed',
      message: describeError(error),
    }
  } finally {
    clearTimeout(timer)
  }

  return {
    ok: true,
    probe: { blocked, failure, chunkTypes, usage, error: probeError },
    state: engine.snapshot(),
  }
}

/**
 * Cordis plugin entry point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig raw row config (may be empty or partial)
 */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)

  let engine
  try {
    engine = await createEngine({
      config,
      stateFile: config.stateFile,
      now: () => Date.now(),
      log,
    })
  } catch (error) {
    // Activation must never throw: an unavailable engine leaves the plugin
    // inert (no enforcement, no panel data) instead of breaking the Harness.
    log('error', `engine initialization failed; subscription simulation is inert: ${describeError(error)}`)
    return
  }

  // Release the engine (flush the final save) when the plugin unloads.
  ctx.effect(() => () => {
    void engine.close()
  })

  // -----------------------------------------------------------------------
  // Enforcement: one prepended global wrapper around every model request.
  // Never throws synchronously; the blocked path yields one terminal finish
  // chunk and does not call next().
  // -----------------------------------------------------------------------
  ctx.on(
    'llm/stream',
    (options, next) => {
      return (async function* subscriptionSimStream() {
        // consumeBlock atomically performs the contract's shouldBlock decision
        // plus the lastHit / blocked-event / simulateBlock bookkeeping.
        const block = engine.consumeBlock(options)
        if (block.blocked === true) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: String(block.message),
                code: QUOTA_CODE,
                status: 429,
              },
            },
          }
          return
        }
        for await (const chunk of next()) {
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage) {
            // Synchronous in memory + fire-and-forget save: never await disk
            // inside a model stream.
            engine.recordUsage(chunk.usage, options)
          }
          yield chunk
        }
      })()
    },
    { global: true, prepend: true },
  )

  // -----------------------------------------------------------------------
  // Read-only agent tool. Claim/redeem stay user-only.
  // -----------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'subscription_status',
      description:
        'Report the local subscription-simulation token quota state for this Harness process. Simulated plans come from two vendor catalogs: Anthropic Claude (Free / Pro / Max 5× / Max 20×) and OpenAI ChatGPT (Free / Go / Plus / Pro); the active vendor and plan are reported. Returns the 5-hour and 7-day rolling-window usage (used/limit/percent and auto-release countdown), whether requests are currently blocked by an exhausted window, held reset cards, enforcement settings, lifetime token counters, and the state file path. IMPORTANT: this is a local simulation only — no real DeepSeek subscription or billing exists. This tool is read-only: plan/vendor, quota-window and enforcement settings are changed in the Web Settings page (设置 → 订阅额度), not here; claiming or redeeming reset cards is a user-only action in the Web side panel.',
      parameters: {
        type: 'object',
        properties: {
          verbose: {
            type: 'boolean',
            description: 'Include the recent event log (up to 10 events) in the result.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: renderToolSummary(value) }]
        },
      },
      async execute(args) {
        const source = args !== null && typeof args === 'object' ? args : {}
        return buildToolValue(engine.snapshot(), source.verbose === true)
      },
    }),
  )

  // -----------------------------------------------------------------------
  // HTTP route for the Client panel.
  // -----------------------------------------------------------------------
  /** Dispatch one body action to the engine. */
  const dispatch = async (body) => {
    const action = typeof body.action === 'string' ? body.action : ''
    switch (action) {
      case 'state':
        return { ok: true, state: engine.snapshot() }
      case 'claim-card':
        await engine.claimCard({ count: body.count })
        return { ok: true, state: engine.snapshot() }
      case 'use-card':
        await engine.useCard(body.window)
        return { ok: true, state: engine.snapshot() }
      case 'set-plan':
        // v2 body: { vendor, planId } — both required (CONTRACT section 12).
        await engine.setPlan({ vendor: body.vendor, planId: body.planId })
        return { ok: true, state: engine.snapshot() }
      case 'set-windows':
        await engine.setWindows({ h5: body.h5, d7: body.d7 })
        return { ok: true, state: engine.snapshot() }
      case 'set-settings':
        await engine.setSettings({ enforce: body.enforce, countAuxiliary: body.countAuxiliary })
        return { ok: true, state: engine.snapshot() }
      case 'set-limit':
        await engine.setLimit({ window: body.window, tokens: body.tokens })
        return { ok: true, state: engine.snapshot() }
      case 'reset-all':
        await engine.resetAll()
        return { ok: true, state: engine.snapshot() }
      case 'dismiss-hit':
        await engine.dismissHit()
        return { ok: true, state: engine.snapshot() }
      case 'arm-simulate-block':
        await engine.armSimulateBlock()
        return { ok: true, state: engine.snapshot() }
      case 'probe':
        return await runProbe(ctx, engine, body)
      default:
        return {
          ok: false,
          error: {
            code: 'invalid_action',
            message: `未知操作：${action === '' ? '(空)' : action}。Unknown subscription-sim action: ${action === '' ? '(empty)' : action}.`,
          },
        }
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
          let rejection
          try {
            rejection = ctx.connection.requestRejection(req)
          } catch (error) {
            log('warn', `connection fence failed closed: ${describeError(error)}`)
            rejection = 403
          }
          if (rejection !== undefined) {
            sendJson(res, 403, {
              ok: false,
              error: {
                code: 'forbidden',
                message:
                  '请求被拒绝：未通过本机连接鉴权。Request rejected: not admitted by the local connection fence.',
              },
            })
            return
          }
          if (req.method !== 'POST') {
            sendMethodNotAllowed(res, 'POST')
            return
          }
          try {
            const raw = await readBoundedBody(req)
            if (raw === null) {
              sendJson(res, 200, {
                ok: false,
                error: {
                  code: 'invalid_body',
                  message: '请求体超过 64 KiB 上限。Request body exceeds the 64 KiB limit.',
                },
              })
              return
            }
            let body
            try {
              body = JSON.parse(raw.toString('utf8'))
            } catch {
              sendJson(res, 200, {
                ok: false,
                error: {
                  code: 'invalid_body',
                  message: '请求体不是合法的 JSON。Request body is not valid JSON.',
                },
              })
              return
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
              sendJson(res, 200, {
                ok: false,
                error: {
                  code: 'invalid_body',
                  message: '请求体必须是 JSON 对象。Request body must be a JSON object.',
                },
              })
              return
            }
            sendJson(res, 200, await dispatch(body))
          } catch (error) {
            // Every route outcome is JSON; the response may already be gone
            // when the client aborted mid-body.
            if (res.headersSent) return
            if (error instanceof EngineError) {
              sendJson(res, 200, { ok: false, error: { code: error.code, message: error.message } })
              return
            }
            log('error', `subscription route failed: ${describeError(error)}`)
            sendJson(res, 500, {
              ok: false,
              error: {
                code: 'internal_error',
                message:
                  '服务器内部错误：订阅模拟器操作失败。Internal error while handling the subscription simulator action.',
              },
            })
          }
        },
      }),
    'subscription-sim: POST /subscription-sim/api',
  )
}
