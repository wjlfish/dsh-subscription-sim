// Mock-context integration tests for index.js (Host half) against CONTRACT.md sections 4-6.
//
// A minimal fake Cordis context models exactly the documented host contracts:
// ctx.effect / ctx.on('llm/stream') / ctx.tools.register / ctx.webServer.register /
// ctx.connection.requestRejection / ctx.llm.stream / ctx.agentDefaultModel.
// This is NOT a substitute for the live Phase B checks against the real Harness; it
// catches Host wiring defects before the install cycle (the enforcement path is the
// part that "must be exactly right", CONTRACT section 5).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'
import { assertSnapshotShape } from './_support.test.mjs'

const ROUTE = '/subscription-sim/api'

const DEFAULT_CHUNKS = () => [
  { type: 'text', delta: 'pong' },
  {
    type: 'usage',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    },
  },
  { type: 'finish', reason: { kind: 'stop' } },
]

function createRequest(method, body) {
  return {
    method,
    async *[Symbol.asyncIterator]() {
      if (body === undefined || body === null) return
      yield Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    },
  }
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    end(data) {
      this.body += data === undefined || data === null ? '' : String(data)
    },
  }
}

/** A minimal Node `http.IncomingMessage`-shaped async iterable + ServerResponse recorder. */
async function postJson(ctx, mock, body, options = {}) {
  const route = mock.routes.get(ROUTE)
  assert.ok(route, 'index.js must register the POST /subscription-sim/api route')
  assert.equal(route.kind, 'exact')
  const req = createRequest(options.method ?? 'POST', options.raw !== undefined ? options.raw : JSON.stringify(body))
  const res = createResponse()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json, text: res.body }
}

function createMockContext(options = {}) {
  const listeners = []
  const effects = []
  const tools = new Map()
  const routes = new Map()
  const state = {
    rejection: undefined,
    chunks: DEFAULT_CHUNKS(),
    providerCalls: 0,
    streamCalls: 0,
    lastStreamOptions: null,
  }

  const baseStream = async function* baseStream() {
    state.providerCalls += 1
    for (const chunk of state.chunks) yield chunk
  }

  const ctx = {
    effect(callback) {
      effects.push(callback())
      return () => {}
    },
    on(event, listener, options2) {
      listeners.push({ event, listener, options: options2 })
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    connection: {
      requestRejection() {
        return state.rejection
      },
    },
    llm: {
      stream(streamOptions) {
        state.streamCalls += 1
        state.lastStreamOptions = streamOptions
        const chain = listeners.filter((entry) => entry.event === 'llm/stream').map((entry) => entry.listener)
        let call = () => baseStream()
        for (let index = chain.length - 1; index >= 0; index -= 1) {
          const inner = call
          call = () => chain[index](streamOptions, inner)
        }
        return call()
      },
    },
    agentDefaultModel: {
      currentSelection() {
        return { provider: 'mock-provider', model: 'mock-model' }
      },
    },
  }

  const mock = {
    listeners,
    effects,
    tools,
    routes,
    state,
    async dispose() {
      for (let index = effects.length - 1; index >= 0; index -= 1) {
        if (typeof effects[index] === 'function') effects[index]()
      }
    },
  }
  return { ctx, mock }
}

async function setupPlugin(t, rawConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dss-host-'))
  const { ctx, mock } = createMockContext()
  await apply(ctx, { stateFile: join(dir, 'state.json'), ...rawConfig })
  t.after(async () => {
    await mock.dispose()
    // index.js releases the engine through a `void engine.close()` disposer; give the
    // serialized final save a moment to land before deleting the temp state file.
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(dir, { recursive: true, force: true })
  })
  return { ctx, mock, dir }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function readState(ctx, mock) {
  const response = await postJson(ctx, mock, { action: 'state' })
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.json.ok, true)
  return response.json.state
}

/** Record `tokens` of non-auxiliary usage through the real listener path. */
async function recordTokens(ctx, mock, tokens = 15) {
  mock.state.chunks = [
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: tokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  await collect(ctx.llm.stream({ provider: 'mock-provider', model: 'mock-model', messages: [] }))
}

test('host exports and registration shape (name/inject/listener/tool/route)', async (t) => {
  assert.equal(name, 'subscription-sim')
  assert.deepEqual(inject, ['tools', 'webServer', 'connection', 'llm', 'agentDefaultModel'])
  const { mock } = await setupPlugin(t)

  const streamListener = mock.listeners.filter((entry) => entry.event === 'llm/stream')
  assert.equal(streamListener.length, 1, 'exactly one llm/stream listener')
  assert.deepEqual(streamListener[0].options, { global: true, prepend: true })

  assert.equal(mock.routes.size, 1)
  assert.ok(mock.routes.has(ROUTE))
  assert.equal(mock.routes.get(ROUTE).kind, 'exact')

  const tool = mock.tools.get('subscription_status')
  assert.ok(tool, 'subscription_status tool must be registered')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.properties.verbose.type, 'boolean')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(mock.tools.size, 1, 'claim/redeem must not be exposed as tools')
})

test('state action returns the CONTRACT v2 snapshot (vendor catalogs, no flat plans)', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  const state = await readState(ctx, mock)
  assertSnapshotShape(state)
  assert.equal(state.version, 2)
  assert.equal(state.vendor.id, 'claude')
  assert.equal(state.vendor.name.zh, 'Anthropic Claude')
  assert.equal(state.plan.id, 'max20x')
  assert.equal(state.plan.vendorId, 'claude')
  assert.deepEqual(state.plan.limits, { h5: 30_000_000, d7: 300_000_000 })
  assert.equal('plans' in state, false, 'v2 snapshot must not carry the old top-level plans field')
  assert.deepEqual(
    state.vendors.map((vendor) => vendor.id),
    ['claude', 'openai'],
  )
  assert.deepEqual(
    state.vendors.map((vendor) => vendor.plans.map((plan) => plan.id)),
    [
      ['free', 'pro', 'max5x', 'max20x'],
      ['free', 'go', 'plus', 'pro', 'promax'],
    ],
  )
  assert.equal(state.vendors[1].plans.length, 5, 'ChatGPT catalog has five tiers in the live snapshot')
  assert.equal(
    state.vendors[1].plans.find((plan) => plan.id === 'promax').limits.h5,
    60_000_000,
    'Pro Max h5 limit is 60M',
  )
  assert.equal(state.windows.h5.enabled, true)
  assert.equal(state.windows.d7.enabled, true)
  assert.equal(state.windows.h5.limit, 30_000_000)
  assert.equal(state.settings.enforce, true)
  assert.equal(state.cards.held, 2)
  assert.equal(state.blocked, false)
  assert.equal(state.blockedWindow, null)
  assert.equal(state.lastHit, null)
  assert.equal(state.simulateBlock, false)
  assert.equal(typeof state.storage.stateFile, 'string')
  assert.ok(state.storage.stateFile.endsWith('state.json'))
  assert.equal(state.ok, true)
})

test('set-plan route takes {vendor, planId}, switches vendor+limits and preserves usage', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)

  const claudeFree = await postJson(ctx, mock, { action: 'set-plan', vendor: 'claude', planId: 'free' })
  assert.equal(claudeFree.json.ok, true)
  assert.equal(claudeFree.json.state.vendor.id, 'claude')
  assert.equal(claudeFree.json.state.plan.id, 'free')
  assert.equal(claudeFree.json.state.plan.vendorId, 'claude')
  assert.deepEqual(claudeFree.json.state.plan.limits, { h5: 150_000, d7: 1_000_000 })
  assert.equal(claudeFree.json.state.windows.h5.used, 15, 'plan switch keeps usage')
  assert.equal(claudeFree.json.state.events[0].message, 'claude/free')

  const openaiGo = await postJson(ctx, mock, { action: 'set-plan', vendor: 'openai', planId: 'go' })
  assert.equal(openaiGo.json.ok, true)
  assert.equal(openaiGo.json.state.vendor.id, 'openai')
  assert.deepEqual(openaiGo.json.state.vendor.name, { zh: 'OpenAI ChatGPT', en: 'OpenAI ChatGPT' })
  assert.equal(openaiGo.json.state.plan.id, 'go')
  assert.equal(openaiGo.json.state.plan.vendorId, 'openai')
  assert.deepEqual(openaiGo.json.state.plan.limits, { h5: 500_000, d7: 4_000_000 })
  assert.equal(openaiGo.json.state.windows.h5.used, 15, 'usage survives a vendor switch too')
  assert.equal(openaiGo.json.state.events[0].message, 'openai/go')

  // -> openai/promax: the $500 top tier, usage still preserved.
  const openaiProMax = await postJson(ctx, mock, { action: 'set-plan', vendor: 'openai', planId: 'promax' })
  assert.equal(openaiProMax.json.ok, true)
  assert.equal(openaiProMax.json.state.vendor.id, 'openai')
  assert.equal(openaiProMax.json.state.plan.id, 'promax')
  assert.equal(openaiProMax.json.state.plan.priceUSD, 500)
  assert.deepEqual(openaiProMax.json.state.plan.limits, { h5: 60_000_000, d7: 500_000_000 })
  assert.equal(openaiProMax.json.state.windows.h5.used, 15, 'usage preserved selecting Pro Max')
  assert.equal(openaiProMax.json.state.events[0].message, 'openai/promax')

  // The v1 HTTP body (planId only) is no longer accepted: vendor is required.
  for (const body of [
    { action: 'set-plan', planId: 'free' },
    { action: 'set-plan', vendor: 'claude' },
    { action: 'set-plan', vendor: 'claude', planId: 'plus' },
    { action: 'set-plan', vendor: 'openai', planId: 'max20x' },
    { action: 'set-plan', vendor: 'claude', planId: 'custom' },
    { action: 'set-plan', vendor: 'claude', planId: 'promax' },
    { action: 'set-plan', vendor: 'nope', planId: 'free' },
    { action: 'set-plan', vendor: 'claude', planId: 'enterprise' },
  ]) {
    const rejected = await postJson(ctx, mock, body)
    assert.equal(rejected.json.ok, false, `set-plan ${JSON.stringify(body)} must be rejected`)
    assert.equal(rejected.json.error.code, 'unknown_plan', `set-plan ${JSON.stringify(body)} error code`)
  }
  const unchanged = await readState(ctx, mock)
  assert.equal(unchanged.vendor.id, 'openai', 'rejected set-plan leaves the vendor untouched')
  assert.equal(unchanged.plan.id, 'promax', 'rejected set-plan leaves the plan untouched')
  assert.deepEqual(unchanged.plan.limits, { h5: 60_000_000, d7: 500_000_000 })
})

test('set-limit keeps the selected vendor through the API', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await postJson(ctx, mock, { action: 'set-plan', vendor: 'openai', planId: 'plus' })
  const limited = await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1234 })
  assert.equal(limited.json.ok, true)
  assert.equal(limited.json.state.vendor.id, 'openai')
  assert.equal(limited.json.state.plan.id, 'custom')
  assert.equal(limited.json.state.plan.vendorId, 'openai')
  assert.deepEqual(limited.json.state.plan.limits, { h5: 1234, d7: 20_000_000 })

  // Restoring a preset keeps that vendor as well.
  const restored = await postJson(ctx, mock, { action: 'set-plan', vendor: 'openai', planId: 'pro' })
  assert.equal(restored.json.ok, true)
  assert.equal(restored.json.state.vendor.id, 'openai')
  assert.deepEqual(restored.json.state.plan.limits, { h5: 30_000_000, d7: 250_000_000 })
})

test('healthy stream passes through and records usage (input+output tokens)', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  const chunks = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['text', 'usage', 'finish'],
  )
  assert.equal(mock.state.providerCalls, 1)

  const state = await readState(ctx, mock)
  assert.equal(state.windows.h5.used, 15)
  assert.equal(state.windows.d7.used, 15)
  assert.equal(state.lifetime.tokens, 15)
  assert.equal(state.lifetime.calls, 1)
})

test('exhausted h5 window short-circuits with a terminal SUBSCRIPTION_QUOTA finish chunk', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  const setLimit = await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })
  assert.equal(setLimit.json.ok, true)

  const providerCallsBefore = mock.state.providerCalls
  const chunks = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.equal(mock.state.providerCalls, providerCallsBefore, 'next() must NOT be called when blocked')
  assert.equal(chunks.length, 1, 'the blocked stream yields exactly one terminal chunk')
  const finish = chunks[0]
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'SUBSCRIPTION_QUOTA')
  assert.equal(finish.reason.failure.status, 429)
  assert.ok(finish.reason.failure.message.includes('订阅额度已用尽'))
  assert.ok(finish.reason.failure.message.includes('Subscription quota exhausted'))

  const state = await readState(ctx, mock)
  assert.equal(state.blocked, true)
  assert.equal(state.blockedWindow, 'h5')
  assert.equal(state.lastHit.window, 'h5')
  assert.equal(typeof state.lastHit.seq, 'number')
  assert.equal(state.events[0].kind, 'blocked')
})

test('enforce=false lets streams through while the quota stays reported as exhausted', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })
  await postJson(ctx, mock, { action: 'set-settings', enforce: false })

  const chunks = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['usage', 'finish'],
  )
  const state = await readState(ctx, mock)
  assert.equal(state.settings.enforce, false)
  assert.equal(state.windows.h5.exhausted, true)
  assert.equal(state.lastHit, null, 'nothing was blocked')
})

test('countAuxiliary=false neither counts nor blocks compaction/title calls', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  await postJson(ctx, mock, { action: 'set-settings', countAuxiliary: false })
  await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })
  const exhausted = await readState(ctx, mock)
  assert.equal(exhausted.windows.h5.exhausted, true)

  const before = (await readState(ctx, mock)).lifetime.tokens
  const auxChunks = await collect(
    ctx.llm.stream({ provider: 'p', model: 'm', messages: [], purpose: 'compaction' }),
  )
  assert.deepEqual(
    auxChunks.map((chunk) => chunk.type),
    ['usage', 'finish'],
    'auxiliary calls must not be blocked when countAuxiliary=false',
  )
  const afterAux = await readState(ctx, mock)
  assert.equal(afterAux.lifetime.tokens, before, 'auxiliary usage must not be counted when disabled')

  const normal = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [], purpose: undefined }))
  assert.equal(normal.length, 1, 'normal calls are still blocked while h5 is exhausted')
  assert.equal(normal[0].reason.failure.code, 'SUBSCRIPTION_QUOTA')
})

test('arm-simulate-block blocks exactly one request through the full listener', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await postJson(ctx, mock, { action: 'arm-simulate-block' })

  const providerCallsBefore = mock.state.providerCalls
  const blocked = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.equal(mock.state.providerCalls, providerCallsBefore, 'simulated block must not call next()')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].reason.failure.code, 'SUBSCRIPTION_QUOTA')
  assert.ok(blocked[0].reason.failure.message.includes('诊断性拦截'))

  const afterFirst = await readState(ctx, mock)
  assert.equal(afterFirst.simulateBlock, false, 'the flag is consumed by the first request')
  assert.equal(afterFirst.blocked, false, 'the diagnostic block does not fake exhaustion')
  assert.equal(afterFirst.lastHit?.window, 'h5', 'CONTRACT section 2: the blocked request is recorded as lastHit')
  assert.ok(
    afterFirst.events.some((event) => event.kind === 'blocked'),
    'the blocked event is recorded even though the quota is healthy',
  )
  // The Client shows the exhausted banner while lastHit is set; the next passing
  // request consumes the diagnostic hit.

  const normal = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.equal(mock.state.providerCalls, providerCallsBefore + 1, 'second request reaches the provider')
  assert.deepEqual(
    normal.map((chunk) => chunk.type),
    ['text', 'usage', 'finish'],
    'the next request streams normally again',
  )
  assert.equal((await readState(ctx, mock)).lastHit, null, 'the passing request clears the diagnostic banner hit')
})

test('a real blocked hit keeps lastHit across state polls until dismissed', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })

  const blocked = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.equal(blocked[0].reason.failure.code, 'SUBSCRIPTION_QUOTA')
  const first = await readState(ctx, mock)
  assert.equal(first.lastHit.window, 'h5')
  const second = await readState(ctx, mock)
  assert.equal(second.lastHit.window, 'h5', 'polling state must not lose the banner while quota is exhausted')

  const dismissed = await postJson(ctx, mock, { action: 'dismiss-hit' })
  assert.equal(dismissed.json.state.lastHit, null)
  assert.equal(dismissed.json.state.blocked, true, 'dismiss only clears the banner; quota stays exhausted')
  const afterDismiss = await readState(ctx, mock)
  assert.equal(afterDismiss.lastHit, null)

  // A dismissed banner comes back on the next real blocked request.
  const blockedAgain = await collect(ctx.llm.stream({ provider: 'p', model: 'm', messages: [] }))
  assert.equal(blockedAgain[0].reason.failure.code, 'SUBSCRIPTION_QUOTA')
  assert.equal((await readState(ctx, mock)).lastHit.window, 'h5')
})

test('probe action proves enforcement end-to-end (healthy)', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  const response = await postJson(ctx, mock, { action: 'probe' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.probe.blocked, false)
  assert.equal(response.json.probe.failure, null)
  assert.equal(response.json.probe.error, null)
  assert.equal(response.json.probe.usage.totalTokens, 15)
  assert.ok(response.json.probe.chunkTypes.includes('usage'))
  assert.equal(response.json.state.lifetime.tokens, 15, 'the probe is a real request and consumes quota')
  assert.equal(mock.state.lastStreamOptions.provider, 'mock-provider')
  assert.equal(mock.state.lastStreamOptions.model, 'mock-model')
})

test('probe action reports SUBSCRIPTION_QUOTA when an enabled window is exhausted', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })

  const providerCallsBefore = mock.state.providerCalls
  const response = await postJson(ctx, mock, { action: 'probe' })
  assert.equal(response.json.ok, true)
  assert.equal(response.json.probe.blocked, true)
  assert.equal(response.json.probe.failure.code, 'SUBSCRIPTION_QUOTA')
  assert.equal(response.json.probe.failure.status, 429)
  assert.ok(response.json.probe.failure.message.includes('订阅额度已用尽'))
  assert.ok(response.json.probe.failure.message.includes('Subscription quota exhausted'))
  assert.equal(response.json.probe.usage, null)
  assert.deepEqual(response.json.probe.chunkTypes, ['finish'])
  assert.equal(mock.state.providerCalls, providerCallsBefore, 'a blocked probe never reaches the provider')
})

test('reset-all + claude/max20x restores a healthy quota through the API', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await recordTokens(ctx, mock, 15)
  await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 1 })
  await postJson(ctx, mock, { action: 'set-plan', vendor: 'claude', planId: 'max20x' })

  const reset = await postJson(ctx, mock, { action: 'reset-all' })
  assert.equal(reset.json.ok, true)
  assert.equal(reset.json.state.lifetime.tokens, 0)
  assert.equal(reset.json.state.windows.h5.used, 0)
  assert.equal(reset.json.state.lastHit, null)
  assert.equal(reset.json.state.vendor.id, 'claude')
  assert.equal(reset.json.state.plan.id, 'max20x')
  assert.deepEqual(reset.json.state.plan.limits, { h5: 30_000_000, d7: 300_000_000 })
  assert.equal(reset.json.state.windows.h5.enabled, true)
  assert.equal(reset.json.state.windows.d7.enabled, true)

  const probe = await postJson(ctx, mock, { action: 'probe' })
  assert.equal(probe.json.probe.blocked, false)
})

test('route enforces method, auth, body and error-code semantics (CONTRACT section 4)', async (t) => {
  const { ctx, mock } = await setupPlugin(t)

  const get = await postJson(ctx, mock, undefined, { method: 'GET' })
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')
  assert.equal(get.json.ok, false)
  assert.equal(get.json.error.code, 'invalid_method')

  const forbidden = await postJson(ctx, mock, { action: 'state' })
  assert.equal(forbidden.json.ok, true)
  mock.state.rejection = { reason: 'not-admitted' }
  const rejected = await postJson(ctx, mock, { action: 'state' })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.json.ok, false)
  assert.equal(rejected.json.error.code, 'forbidden')
  mock.state.rejection = undefined

  for (const raw of ['{not json', '[]', 'null', '"string"']) {
    const bad = await postJson(ctx, mock, undefined, { raw })
    assert.equal(bad.status, 200)
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.error.code, 'invalid_body', `raw body ${raw}`)
    assert.ok(bad.json.error.message.includes('。'), 'error messages carry the zh + en hint')
  }

  const tooLarge = await postJson(ctx, mock, undefined, { raw: 'x'.repeat(65 * 1024) })
  assert.equal(tooLarge.json.ok, false)
  assert.equal(tooLarge.json.error.code, 'invalid_body')

  const unknownAction = await postJson(ctx, mock, { action: 'nope' })
  assert.equal(unknownAction.json.ok, false)
  assert.equal(unknownAction.json.error.code, 'invalid_action')

  const unknownPlan = await postJson(ctx, mock, { action: 'set-plan', vendor: 'claude', planId: 'enterprise' })
  assert.equal(unknownPlan.json.error.code, 'unknown_plan')

  const legacySetPlan = await postJson(ctx, mock, { action: 'set-plan', planId: 'free' })
  assert.equal(legacySetPlan.json.error.code, 'unknown_plan', 'v1 set-plan body without vendor is rejected')

  const bothOff = await postJson(ctx, mock, { action: 'set-windows', h5: false, d7: false })
  assert.equal(bothOff.json.error.code, 'both_windows_disabled')

  const badLimit = await postJson(ctx, mock, { action: 'set-limit', window: 'h5', tokens: 0 })
  assert.equal(badLimit.json.error.code, 'invalid_limit')

  const claim = await postJson(ctx, mock, { action: 'claim-card' })
  assert.equal(claim.json.ok, true)
  assert.equal(claim.json.state.cards.held, 3)
  const cooldown = await postJson(ctx, mock, { action: 'claim-card' })
  assert.equal(cooldown.json.error.code, 'claim_cooldown', 'the default config has a 10s claim cooldown')
})

test('reset-all restores cards but leaves vendor/plan/windows at their configured values', async (t) => {
  const { ctx, mock } = await setupPlugin(t)
  await postJson(ctx, mock, { action: 'set-plan', vendor: 'openai', planId: 'plus' })
  await postJson(ctx, mock, { action: 'set-windows', h5: true, d7: false })
  await postJson(ctx, mock, { action: 'claim-card' })
  const use = await postJson(ctx, mock, { action: 'use-card', window: 'h5' })
  assert.equal(use.json.state.cards.held, 2)

  const dismiss = await postJson(ctx, mock, { action: 'dismiss-hit' })
  assert.equal(dismiss.json.ok, true)
  assert.equal(dismiss.json.state.lastHit, null)

  const reset = await postJson(ctx, mock, { action: 'reset-all' })
  assert.equal(reset.json.state.cards.held, 2, 'cards return to initialHeld')
  assert.equal(reset.json.state.vendor.id, 'openai', 'reset does not change the vendor')
  assert.equal(reset.json.state.plan.id, 'plus', 'reset does not change the plan')
  assert.equal(reset.json.state.windows.d7.enabled, false, 'reset does not change window choices')
})

test('subscription_status tool is read-only, reports vendor+plan and points at the Settings page', async (t) => {
  const { mock } = await setupPlugin(t)
  const tool = mock.tools.get('subscription_status')
  const value = await tool.execute({})
  assert.equal(value.ok, true)
  assert.equal(value.simulated, true)
  assert.equal(value.vendor.id, 'claude', 'v2 tool reports the vendor')
  assert.equal(value.plan.id, 'max20x')
  assert.equal(value.plan.vendorId, 'claude')
  assert.equal(value.windows.h5.used, 0)
  assert.equal(value.windows.d7.limit, 300_000_000, 'limits follow the v2 claude/max20x catalog')
  assert.equal(value.cards.held, 2)
  assert.equal(value.enforce, true)
  assert.ok(value.note.includes('simulation'))
  assert.equal(value.events, undefined, 'events only appear in verbose mode')

  const verbose = await tool.execute({ verbose: true })
  assert.ok(Array.isArray(verbose.events))

  const rendered = tool.output.render({}, value)
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].type, 'text')
  const text = rendered[0].text
  assert.ok(text.includes('simulation'))
  assert.ok(text.includes('Anthropic Claude') || text.includes('Claude'), 'tool text names the vendor')
  assert.ok(text.includes('max20x'.replace('max', 'Max')) || text.includes('Max 20×'), 'tool text names the plan')
  assert.ok(text.includes('5-hour'))
  assert.ok(text.includes('7-day'))
  assert.ok(
    text.includes('设置') && text.includes('订阅额度'),
    'CONTRACT section 12: tool text must mention 设置 → 订阅额度 for plan/window settings',
  )
  assert.ok(/settings/i.test(text), 'tool text mentions the Settings page in English too')
})
