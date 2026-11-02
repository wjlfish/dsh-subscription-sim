// Client-half v2 verification (CONTRACT.md sections 13/14): slot registrations, locale
// dictionary parity, and *mock-rendered* React trees.
//
// The client is a plain `window.__ModuleLoader__` module whose only import is `react`.
// This harness evaluates it inside a `node:vm` sandbox with a fake module loader, a fake
// React runtime (function components rendered depth-first with hook slots), a fake DOM
// and a recording `fetch` that echoes a CONTRACT v2 snapshot. Nothing here touches a
// browser or the running Harness: the assertions are static/mock-render evidence only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const CLIENT_SOURCE = readFileSync(join(PKG, 'client.js'), 'utf8')
const T0 = 1_800_000_000_000

const CLAUDE_PLANS = [
  { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 150_000, d7: 1_000_000 } },
  { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 20, limits: { h5: 2_000_000, d7: 20_000_000 } },
  { id: 'max5x', name: { zh: 'Max 5×', en: 'Max 5×' }, priceUSD: 100, limits: { h5: 8_000_000, d7: 80_000_000 } },
  { id: 'max20x', name: { zh: 'Max 20×', en: 'Max 20×' }, priceUSD: 200, limits: { h5: 30_000_000, d7: 300_000_000 } },
]
const OPENAI_PLANS = [
  { id: 'free', name: { zh: 'Free', en: 'Free' }, priceUSD: 0, limits: { h5: 100_000, d7: 800_000 } },
  { id: 'go', name: { zh: 'Go', en: 'Go' }, priceUSD: 8, limits: { h5: 500_000, d7: 4_000_000 } },
  { id: 'plus', name: { zh: 'Plus', en: 'Plus' }, priceUSD: 20, limits: { h5: 2_500_000, d7: 20_000_000 } },
  { id: 'pro', name: { zh: 'Pro', en: 'Pro' }, priceUSD: 200, limits: { h5: 30_000_000, d7: 250_000_000 } },
  { id: 'promax', name: { zh: 'Pro Max', en: 'Pro Max' }, priceUSD: 500, limits: { h5: 60_000_000, d7: 500_000_000 } },
]
const VENDORS = [
  {
    id: 'claude',
    name: { zh: 'Anthropic Claude', en: 'Anthropic Claude' },
    note: { zh: '5 小时会话额度 + 每周额度', en: '5-hour session limit + weekly limit' },
    plans: CLAUDE_PLANS,
  },
  {
    id: 'openai',
    name: { zh: 'OpenAI ChatGPT', en: 'OpenAI ChatGPT' },
    note: {
      zh: '滚动窗口消息额度（Free / Go / Plus / Pro / Pro Max，按 tokens 模拟）',
      en: 'Rolling message caps (Free / Go / Plus / Pro / Pro Max, simulated as tokens)',
    },
    plans: OPENAI_PLANS,
  },
]
const ALL_PLAN_PAIRS = VENDORS.flatMap((vendor) => vendor.plans.map((plan) => `${vendor.id}/${plan.id}`)).sort()

function vendorById(id) {
  return VENDORS.find((vendor) => vendor.id === id)
}

function makePlan(vendorId, planId, customLimits) {
  const vendor = vendorById(vendorId)
  if (planId === 'custom') {
    return {
      id: 'custom',
      name: { zh: '自定义', en: 'Custom' },
      priceUSD: 0,
      limits: { ...customLimits },
      custom: true,
      vendorId: vendor.id,
      vendorName: { ...vendor.name },
    }
  }
  const preset = vendor.plans.find((plan) => plan.id === planId)
  return { ...preset, custom: false, vendorId: vendor.id, vendorName: { ...vendor.name } }
}

function makeWindow(limit, used, windowMs) {
  return {
    enabled: true,
    windowMs,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent: Math.round((used / limit) * 1000) / 10,
    exhausted: used >= limit,
    resetAt: used > 0 ? T0 + windowMs : null,
    resetInMs: used > 0 ? windowMs : null,
  }
}

/** A structurally complete CONTRACT v2 snapshot fixture (all fields the client reads). */
function makeV2Snapshot(options = {}) {
  const vendorId = options.vendorId ?? 'claude'
  const planId = options.planId ?? 'max20x'
  const customLimits = options.customLimits ?? { h5: 1234, d7: 5678 }
  const plan = makePlan(vendorId, planId, customLimits)
  const vendor = vendorById(vendorId)
  const h5Limit = plan.limits.h5
  const d7Limit = plan.limits.d7
  return {
    ok: true,
    serverNow: T0,
    version: 2,
    vendor: { id: vendor.id, name: { ...vendor.name }, note: { ...vendor.note } },
    plan,
    vendors: VENDORS.map((entry) => ({
      id: entry.id,
      name: { ...entry.name },
      note: { ...entry.note },
      plans: entry.plans.map((preset) => ({ ...preset, limits: { ...preset.limits } })),
    })),
    windows: {
      h5: makeWindow(h5Limit, 1_000_000, 18_000_000),
      d7: makeWindow(d7Limit, 1_000_000, 604_800_000),
    },
    blocked: false,
    blockedWindow: null,
    settings: {
      enforce: true,
      countAuxiliary: true,
      windows: { h5: true, d7: true },
      cards: { maxHeld: 9, claimCooldownSeconds: 10, claimBatch: 1, initialHeld: 2 },
    },
    cards: { held: 2, maxHeld: 9, canClaim: true, cooldownRemainingMs: 0, claimBatch: 1 },
    lifetime: { tokens: 1_000_000, input: 600_000, output: 400_000, calls: 3, since: T0 - 100_000 },
    lastHit: null,
    simulateBlock: false,
    events: [
      { at: T0 - 1000, kind: 'claim' },
      { at: T0 - 5000, kind: 'usage', tokens: 1234 },
    ],
    storage: { stateFile: '/tmp/dss-verify/state.json', ok: true, lastError: null },
  }
}

/** A v1 (pre-vendor) snapshot: the v2 client must render it without throwing. */
function makeV1Snapshot() {
  return {
    ok: true,
    serverNow: T0,
    version: 1,
    plan: makePlan('claude', 'max20x', { h5: 0, d7: 0 }),
    plans: [...CLAUDE_PLANS, { id: 'custom', name: { zh: '自定义', en: 'Custom' }, priceUSD: 0, limits: { h5: 0, d7: 0 } }],
    windows: {
      h5: makeWindow(18_000_000, 1_000_000, 18_000_000),
      d7: makeWindow(160_000_000, 1_000_000, 604_800_000),
    },
    blocked: false,
    blockedWindow: null,
    settings: {
      enforce: true,
      countAuxiliary: true,
      windows: { h5: true, d7: true },
      cards: { maxHeld: 9, claimCooldownSeconds: 10, claimBatch: 1, initialHeld: 2 },
    },
    cards: { held: 2, maxHeld: 9, canClaim: true, cooldownRemainingMs: 0, claimBatch: 1 },
    lifetime: { tokens: 1_000_000, input: 600_000, output: 400_000, calls: 3, since: T0 - 100_000 },
    lastHit: null,
    simulateBlock: false,
    events: [],
    storage: { stateFile: '/tmp/dss-verify/state.json', ok: true, lastError: null },
  }
}

// ---------------------------------------------------------------------------
// Fake React runtime: plain element objects + a single-pass hook dispatcher
// ---------------------------------------------------------------------------

function createReactRuntime() {
  const Fragment = Symbol('Fragment')
  let current = null

  function hookSlot(initial) {
    if (current === null) throw new Error('hook used outside a component render')
    const index = current.index
    current.index += 1
    if (!(index in current.hooks)) current.hooks[index] = initial
    return current.hooks[index]
  }

  const React = {
    Fragment,
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { $$element: true, type, props: merged }
    },
    useState(initial) {
      const box = hookSlot({ value: typeof initial === 'function' ? initial() : initial })
      return [
        box.value,
        (next) => {
          box.value = typeof next === 'function' ? next(box.value) : next
        },
      ]
    },
    useReducer(reducer, initial) {
      const box = hookSlot({ value: typeof initial === 'function' ? initial() : initial })
      return [box.value, (action) => { box.value = reducer(box.value, action) }]
    },
    useRef(initial) {
      return hookSlot({ current: initial })
    },
    useEffect() {},
    useLayoutEffect() {},
    useInsertionEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
    useId() {
      return 'dss-test-id'
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    memo(component) {
      return component
    },
    forwardRef(component) {
      return component
    },
    createContext(defaultValue) {
      return { _dssDefault: defaultValue, Provider: ({ children }) => children, Consumer: () => null }
    },
    isValidElement(value) {
      return Boolean(value && typeof value === 'object' && value.$$element === true)
    },
    Children: {
      toArray(children) {
        if (children === undefined || children === null) return []
        return Array.isArray(children) ? children.flat(Infinity) : [children]
      },
    },
  }

  const instances = new Map()
  function begin(component) {
    let hooks = instances.get(component)
    if (!hooks) {
      hooks = []
      instances.set(component, hooks)
    }
    current = { hooks, index: 0 }
    return current
  }
  function end() {
    current = null
  }
  return { React, begin, end, instances }
}

// ---------------------------------------------------------------------------
// Fake loader environment + recursive renderer
// ---------------------------------------------------------------------------

function makeFetchResponse(state) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async json() {
      return { ok: true, state }
    },
    async text() {
      return JSON.stringify({ ok: true, state })
    },
  }
}

function loadClient(options = {}) {
  const snapshotState = { current: options.snapshot ?? makeV2Snapshot() }
  const runtime = createReactRuntime()
  const captured = {
    definition: null,
    registrations: [],
    dicts: {},
    fetchLog: [],
    css: '',
    requireSpecs: [],
    effects: [],
    snapshotState,
  }
  const lang = { active: options.lang ?? 'zh' }

  function translate(key, vars) {
    const dict = captured.dicts['subscription-sim']?.[lang.active] ?? captured.dicts['subscription-sim']?.en ?? {}
    let text = dict[key] !== undefined ? dict[key] : key
    if (vars && typeof vars === 'object') {
      text = String(text).replace(/\{(\w+)\}/g, (_match, name) => (name in vars ? String(vars[name]) : `{${name}}`))
    }
    return String(text)
  }

  const fakeWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured.definition = definition
      },
    },
    document: null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const documentObj = {
    visibilityState: 'visible',
    activeElement: null,
    head: {
      appendChild(node) {
        captured.css += String(node.textContent ?? '')
      },
    },
    createElement(tag) {
      return { tagName: tag, textContent: '', dataset: {}, appendChild() {}, removeChild() {}, setAttribute() {} }
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
  }
  fakeWindow.document = documentObj

  const fetch = async (url, init = {}) => {
    let body = null
    try {
      body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null
    } catch {
      body = null
    }
    captured.fetchLog.push({ url, body })
    return makeFetchResponse(snapshotState.current)
  }

  const sandbox = {
    window: fakeWindow,
    document: documentObj,
    fetch,
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    queueMicrotask,
    URL,
    Intl,
    TextEncoder,
    TextDecoder,
    HTMLElement: class HTMLElement {},
    Element: class Element {},
    Node: class Node {},
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })

  assert.ok(captured.definition, 'client.js must call window.__ModuleLoader__.load(...)')
  assert.equal(captured.definition.id ?? captured.definition.moduleId, '@local/dsh-subscription-sim')

  const requireSpy = (id) => {
    captured.requireSpecs.push(id)
    if (id === 'react') return runtime.React
    throw new Error(`unexpected require("${id}") in client.js`)
  }
  const plugin = captured.definition.factory(requireSpy)
  assert.ok(plugin && typeof plugin.apply === 'function', 'client factory must return { inject, apply }')
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots'], 'client must inject slots + locale')

  const ctx = {
    effect(callback) {
      const disposer = callback()
      captured.effects.push(disposer)
      return disposer
    },
    slots: {
      inject(slot, callback) {
        assert.equal(typeof slot, 'string')
        callback()
        return () => {}
      },
      register(registration, component) {
        captured.registrations.push({ slot: registration.name, registration, component })
        return () => {}
      },
    },
    locale: {
      register(namespace, dict) {
        captured.dicts[namespace] = dict
        return () => {}
      },
      subscribe() {
        return () => {}
      },
      getLocale() {
        return { active: lang.active }
      },
      bind(namespace) {
        return (key, vars) => translate(key, vars)
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(captured.requireSpecs.filter((id) => id !== 'react').length, 0, 'client may only require "react"')

  // ---- renderer ---------------------------------------------------------
  function resolveNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
    if (Array.isArray(node)) {
      return node.flatMap((child) => {
        const resolved = resolveNode(child)
        if (resolved === null) return []
        return Array.isArray(resolved) ? resolved : [resolved]
      })
    }
    if (typeof node !== 'object') return null
    if (node.$$element === true) {
      if (node.type === runtime.React.Fragment) return resolveNode(node.props.children)
      if (typeof node.type === 'function') {
        runtime.begin(node.type)
        let rendered
        try {
          rendered = node.type(node.props ?? {})
        } finally {
          runtime.end()
        }
        return resolveNode(rendered)
      }
      const children = resolveNode(node.props?.children)
      return {
        kind: 'host',
        type: node.type,
        props: node.props ?? {},
        children: children === null ? [] : Array.isArray(children) ? children : [children],
      }
    }
    return null
  }

  function render(componentOrSlot, props = {}) {
    const component =
      typeof componentOrSlot === 'string'
        ? captured.registrations.find((entry) => entry.slot === componentOrSlot)?.component
        : componentOrSlot
    assert.ok(component, `no client component registered for ${String(componentOrSlot)}`)
    return resolveNode(runtime.React.createElement(component, props))
  }

  function flatten(node, out = []) {
    if (node === null || node === undefined) return out
    if (Array.isArray(node)) {
      for (const child of node) flatten(child, out)
      return out
    }
    out.push(node)
    if (node.kind === 'host') for (const child of node.children) flatten(child, out)
    return out
  }

  function hosts(tree) {
    return flatten(tree).filter((node) => node.kind === 'host')
  }

  function text(tree) {
    return flatten(tree)
      .filter((node) => node.kind === 'text')
      .map((node) => node.text)
      .join(' ')
  }

  function clickables(tree) {
    return hosts(tree).filter((node) => typeof node.props.onClick === 'function' && node.props.disabled !== true)
  }

  const client = {
    captured,
    runtime,
    render,
    hosts,
    text,
    clickables,
    get registrations() {
      return captured.registrations
    },
    get fetchLog() {
      return captured.fetchLog
    },
    setSnapshot(snapshot) {
      snapshotState.current = snapshot
    },
    actions() {
      return captured.fetchLog.map((entry) => entry.body).filter((body) => body && typeof body.action === 'string')
    },
    mutationActions() {
      return this.actions().filter((body) => body.action !== 'state')
    },
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
    async click(node) {
      node.props.onClick({
        preventDefault() {},
        stopPropagation() {},
        currentTarget: {},
        target: { value: '' },
      })
      await client.settle()
    },
    async loadInitialSnapshot() {
      await client.settle()
      return snapshotState.current
    },
    close() {
      for (const disposer of [...captured.effects].reverse()) {
        if (typeof disposer === 'function') {
          try {
            disposer()
          } catch {
            /* cleanup must not throw */
          }
        }
      }
    },
  }
  return client
}

/** Strip inline SVG artwork (`h('svg', ...)` calls) so literal colors are only allowed there. */
function maskSvgArtwork(source) {
  const masked = source.split('')
  let index = 0
  while (index < source.length) {
    const match = /h\(\s*['"]svg['"]/.exec(source.slice(index))
    if (match === null) break
    const start = index + match.index
    const openParen = source.indexOf('(', start)
    let depth = 0
    let quote = null
    let end = -1
    for (let i = openParen; i < source.length; i += 1) {
      const char = source[i]
      if (quote !== null) {
        if (char === '\\') i += 1
        else if (char === quote) quote = null
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        continue
      }
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    assert.ok(end > openParen, 'SVG artwork masker must find the closing h() call')
    for (let i = start; i <= end; i += 1) if (masked[i] !== '\n') masked[i] = ' '
    index = end + 1
  }
  return masked.join('')
}

// ---------------------------------------------------------------------------
// Slot registrations
// ---------------------------------------------------------------------------

test('client registers all four v2 slots with the documented ids, orders and label thunks', async () => {
  const client = loadClient()
  await client.loadInitialSnapshot()

  const expected = [
    ['sidebar.footer.action', 3],
    ['conversation.composer.dock', 6],
    ['shell.overlay', 30],
    ['settings.section', 12],
  ]
  assert.equal(client.registrations.length, 4, 'v2 registers exactly four slots')
  assert.deepEqual(
    client.registrations.map((entry) => entry.slot),
    expected.map(([slot]) => slot),
    'slot registration order must follow CONTRACT section 13',
  )
  for (const [slot, order] of expected) {
    const entry = client.registrations.find((candidate) => candidate.slot === slot)
    assert.ok(entry, `client must register ${slot}`)
    assert.equal(entry.registration.name, slot)
    assert.equal(entry.registration.id, 'subscription-sim', `${slot}: id`)
    assert.equal(entry.registration.order, order, `${slot}: order`)
    assert.equal(typeof entry.registration.label, 'function', `${slot}: label must be a localized thunk`)
    const label = entry.registration.label()
    assert.equal(typeof label, 'string', `${slot}: label() returns a string`)
    assert.ok(label.trim().length > 0, `${slot}: label() is non-empty`)
  }
  const settingsEntry = client.registrations.find((entry) => entry.slot === 'settings.section')
  assert.equal(typeof settingsEntry.registration.label, 'function', 'settings.section label is the t() thunk')
  assert.equal(
    settingsEntry.registration.label(),
    client.captured.dicts['subscription-sim'].zh.settingsLabel,
    "settings.section label thunk resolves t('settingsLabel')",
  )
  client.close()
})

// ---------------------------------------------------------------------------
// Locale dictionaries + styling constraints
// ---------------------------------------------------------------------------

test('ZH/EN dictionaries have identical key sets and every label thunk is localized', async () => {
  const client = loadClient()
  await client.loadInitialSnapshot()
  const dict = client.captured.dicts['subscription-sim']
  assert.ok(dict, 'client must register the subscription-sim locale namespace')
  assert.ok(dict.zh && typeof dict.zh === 'object', 'ZH dictionary')
  assert.ok(dict.en && typeof dict.en === 'object', 'EN dictionary')
  const zhKeys = Object.keys(dict.zh).sort()
  const enKeys = Object.keys(dict.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'ZH/EN dictionary key parity (CONTRACT section 13)')
  assert.ok(zhKeys.length > 20, `expected a substantive dictionary, found ${zhKeys.length} keys`)
  for (const key of zhKeys) {
    assert.equal(typeof dict.zh[key], 'string', `zh.${key} must be a string`)
    assert.equal(typeof dict.en[key], 'string', `en.${key} must be a string`)
    assert.ok(dict.en[key].trim().length > 0, `en.${key} must not be empty`)
  }
  // settingsLabel is required by the settings.section label thunk.
  assert.ok('settingsLabel' in dict.zh, 'dictionary must define settingsLabel (CONTRACT section 13)')
  client.close()
})

test('client.js has no literal colors outside inline SVG artwork and uses no fixed settings-page chrome', async () => {
  const masked = maskSvgArtwork(CLIENT_SOURCE)
  const colorLiterals = masked.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g) ?? []
  assert.deepEqual(colorLiterals.slice(0, 5), [], 'no literal colors outside SVG (theme tokens only)')
  assert.ok(CLIENT_SOURCE.includes('--dsw-alias-'), 'client styles use theme tokens')

  // The settings page must be normal-flow content: no fixed positioning / backdrop / modal
  // class rules for the classes it actually renders.
  const settingsPageStart = CLIENT_SOURCE.indexOf('function SettingsPage')
  const settingsSectionStart = CLIENT_SOURCE.indexOf('function SettingsSection')
  assert.ok(
    settingsPageStart >= 0 || settingsSectionStart >= 0,
    'client must define the settings-page component (CONTRACT section 13)',
  )

  const client = loadClient({ snapshot: makeV2Snapshot({ planId: 'custom' }) })
  await client.loadInitialSnapshot()
  const tree = client.render('settings.section', { close() {} })
  const nodes = client.hosts(tree)
  const classNames = new Set()
  for (const node of nodes) {
    const className = node.props.className
    if (typeof className === 'string') for (const name of className.split(/\s+/)) if (name) classNames.add(name)
    const style = node.props.style
    if (style && typeof style === 'object') {
      assert.notEqual(style.position, 'fixed', `settings page element ${node.type} must not use position:fixed`)
    } else if (typeof style === 'string') {
      assert.ok(!/position\s*:\s*fixed/.test(style), `settings page element ${node.type} must not use fixed positioning`)
    }
    assert.ok(!/backdrop|modal/i.test(String(className ?? '')), 'settings page must not render backdrop/modal classes')
  }
  assert.ok(classNames.size > 0, 'settings page renders classes')

  // No CSS rule for a settings-page class may use fixed positioning or a backdrop.
  for (const name of classNames) {
    const pattern = new RegExp(`\\.${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b[^{}]*\\{([^}]*)\\}`, 'g')
    for (const rule of CLIENT_SOURCE.matchAll(pattern)) {
      const body = rule[1]
      assert.ok(!/position\s*:\s*fixed/.test(body), `.${name} (settings page) must not use position:fixed`)
      assert.ok(!/backdrop/i.test(body), `.${name} (settings page) must not use backdrop styles`)
    }
  }
  client.close()
})

// ---------------------------------------------------------------------------
// Main panel: status + reset cards only (no configuration controls)
// ---------------------------------------------------------------------------

test('main Panel renders status + cards and contains no configuration controls', async () => {
  const client = loadClient({ snapshot: makeV2Snapshot() })
  await client.loadInitialSnapshot()

  const chipTree = client.render('sidebar.footer.action', { wide: true })
  const chipClickable = client.clickables(chipTree)[0]
  assert.ok(chipClickable, 'sidebar chip must be clickable to open the panel')
  await client.click(chipClickable)

  const panelTree = client.render('shell.overlay', {})
  assert.ok(panelTree, 'overlay must render the open panel')
  const panelText = client.text(panelTree)
  assert.ok(panelText.includes('订阅额度') || /subscription/i.test(panelText), 'panel title present')

  const panelHosts = client.hosts(panelTree)
  assert.equal(
    panelHosts.filter((node) => node.props.role === 'switch').length,
    0,
    'Panel must not contain window/enforcement switch toggles',
  )
  assert.equal(
    panelHosts.filter((node) => node.type === 'input').length,
    0,
    'Panel must not contain custom-limit inputs',
  )
  assert.equal(
    panelHosts.filter((node) => /dss-planRow|dss-customInputs|dss-dangerZone|dss-toggleRow/.test(String(node.props.className ?? '')))
      .length,
    0,
    'Panel must not contain plan rows / custom inputs / reset zone / toggle rows',
  )

  // Behavioral proof: clicking every control in the panel must never send a configuration action.
  const beforeActions = client.mutationActions().length
  for (let pass = 0; pass < 2; pass += 1) {
    const tree = client.render('shell.overlay', {})
    for (const node of client.clickables(tree)) {
      await client.click(node)
    }
  }
  const configActions = client
    .mutationActions()
    .slice(beforeActions)
    .filter((body) => ['set-plan', 'set-windows', 'set-settings', 'set-limit', 'reset-all'].includes(body.action))
  assert.deepEqual(configActions, [], 'the main panel must never send plan/window/settings/reset actions')

  // The footer must point the operator at the Settings page (CONTRACT section 13).
  assert.ok(panelText.includes('设置'), 'Panel footer hint mentions 设置')
  assert.ok(panelText.includes('订阅额度'), 'Panel footer hint mentions 订阅额度')

  // Panel still has its status/card content: header shows vendor + plan, footer the state file.
  assert.ok(panelText.includes('Anthropic Claude'), 'Panel header shows the vendor name from the snapshot')
  assert.ok(panelText.includes('Max 20×'), 'Panel header shows the plan name from the snapshot')
  assert.ok(panelText.includes('/tmp/dss-verify/state.json'), 'Panel footer shows the state-file path')
  assert.ok(/重置卡/.test(panelText), 'Panel keeps the reset-card section')
  assert.ok(/额度用量|已用|tokens/.test(panelText), 'Panel keeps the usage section')
  assert.ok(/5 小时|7 天/.test(panelText), 'Panel keeps both usage windows')
  client.close()
})

// ---------------------------------------------------------------------------
// Settings page: the only configuration surface
// ---------------------------------------------------------------------------

test('SettingsPage renders both vendors, all 9 plans, 4 switches, custom inputs and reset-all', async () => {
  const client = loadClient({ snapshot: makeV2Snapshot({ planId: 'custom', customLimits: { h5: 1111, d7: 2222 } }) })
  await client.loadInitialSnapshot()
  const tree = client.render('settings.section', { close() {} })
  assert.ok(tree, 'settings.section must render normal-flow content')
  const text = client.text(tree)
  const hosts = client.hosts(tree)

  // Both vendor groups with their host-provided bilingual names + notes.
  assert.ok(text.includes('Anthropic Claude'), 'settings page renders the Claude vendor name')
  assert.ok(text.includes('OpenAI ChatGPT'), 'settings page renders the ChatGPT vendor name')
  for (const vendor of VENDORS) {
    assert.ok(text.includes(vendor.note.zh), `settings page renders the ${vendor.id} vendor note`)
  }

  // The rendered tree carries all nine (vendor, plan) rows and every settings section.
  const planRows = hosts.filter((node) => node.type === 'button' && typeof node.props['data-plan-id'] === 'string')
  assert.deepEqual(
    planRows.map((node) => `${node.props['data-vendor-id']}/${node.props['data-plan-id']}`).sort(),
    ALL_PLAN_PAIRS,
    'settings page renders a plan row for every plan of both vendors',
  )
  assert.ok(text.includes('Pro Max'), 'settings page renders the new ChatGPT Pro Max tier')
  assert.ok(/\$500/.test(text), 'settings page renders the Pro Max $500/月 price')
  const dict = client.captured.dicts['subscription-sim'].zh
  for (const key of [
    'settingsTitle',
    'settingsIntro',
    'plansSection',
    'windowsSection',
    'enforcementSection',
    'customLimitsSection',
    'dangerSection',
    'storageSection',
    'resetAll',
    'save',
  ]) {
    assert.ok(dict[key], `dictionary key ${key} exists`)
    assert.ok(text.includes(dict[key]), `settings page renders ${key} (${dict[key]})`)
  }
  // Storage section shows the state-file path from the snapshot.
  assert.ok(text.includes('/tmp/dss-verify/state.json'), 'settings page shows the state-file path')

  // Four switches: h5, d7, enforce, countAuxiliary.
  const switches = hosts.filter((node) => node.props.role === 'switch')
  assert.equal(switches.length, 4, 'settings page renders exactly the four configuration switches')
  assert.ok(switches.every((node) => typeof node.props.onClick === 'function'), 'switches are interactive')

  // Two custom-limit number inputs.
  const inputs = hosts.filter((node) => node.type === 'input' && node.props.type === 'number')
  assert.equal(inputs.length, 2, 'settings page renders the two custom-limit number inputs')

  // No reset-all in the main panel but there is one here.
  assert.ok(/重置/.test(text), 'settings page renders the reset-all danger zone')

  // Behavior: clicking plan rows must send set-plan {vendor, planId} for both vendor catalogs.
  const seen = new Set()
  for (let pass = 0; pass < 2 && seen.size < ALL_PLAN_PAIRS.length; pass += 1) {
    const currentTree = client.render('settings.section', { close() {} })
    for (const node of client.clickables(currentTree)) {
      await client.click(node)
    }
    for (const body of client.mutationActions()) {
      if (body.action === 'set-plan' && typeof body.vendor === 'string' && typeof body.planId === 'string') {
        seen.add(`${body.vendor}/${body.planId}`)
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ALL_PLAN_PAIRS,
    'every plan row must send set-plan {vendor, planId} (both vendors, all 9 plans)',
  )

  // Behavior: the switches send window/settings actions.
  const switchActions = client.mutationActions().map((body) => body.action)
  assert.ok(switchActions.includes('set-windows'), 'window switches send set-windows')
  assert.ok(switchActions.includes('set-settings'), 'enforcement switches send set-settings')

  // Behavior: editing both numbers + save sends set-limit per changed window.
  const beforeCustom = client.mutationActions().length
  let customTree = client.render('settings.section', { close() {} })
  const customInputs = client.hosts(customTree).filter((node) => node.type === 'input' && node.props.type === 'number')
  for (const input of customInputs) {
    const handler = input.props.onChange
    assert.equal(typeof handler, 'function', 'custom-limit inputs are controlled')
    handler({ target: { value: '31337' }, currentTarget: { value: '31337' } })
  }
  await client.settle()
  customTree = client.render('settings.section', { close() {} })
  const saveButton = client
    .clickables(customTree)
    .find((node) => /保存|save/i.test(client.text(node)) && node.props.disabled !== true)
  assert.ok(saveButton, 'settings page renders a working save button for custom limits')
  await client.click(saveButton)
  const limitActions = client
    .mutationActions()
    .slice(beforeCustom)
    .filter((body) => body.action === 'set-limit')
  assert.ok(limitActions.length >= 1, 'saving custom limits sends set-limit')
  assert.ok(limitActions.every((body) => body.tokens === 31337), 'set-limit carries the edited token count')
  assert.deepEqual(
    limitActions.map((body) => body.window).sort(),
    ['d7', 'h5'],
    'both edited windows are saved with one set-limit each',
  )

  // Behavior: reset-all is two-step but reachable by repeating the click on the same control.
  const beforeReset = client.mutationActions().length
  let resetFired = false
  for (let pass = 0; pass < 3 && !resetFired; pass += 1) {
    const currentTree = client.render('settings.section', { close() {} })
    for (const node of client.clickables(currentTree)) {
      await client.click(node)
      if (client.mutationActions().slice(beforeReset).some((body) => body.action === 'reset-all')) {
        resetFired = true
        break
      }
    }
  }
  assert.equal(resetFired, true, 'the settings-page danger zone sends reset-all after inline confirmation')
  client.close()
})

test('settings page source has no fixed-position/backdrop/modal chrome of its own', async () => {
  const start = Math.max(CLIENT_SOURCE.indexOf('function SettingsPage'), CLIENT_SOURCE.indexOf('function SettingsSection'))
  assert.ok(start >= 0, 'settings page component must exist')
  const rest = CLIENT_SOURCE.slice(start)
  const nextModuleFunction = /\n {4}function [A-Z]/.exec(rest.slice(1))
  const snippet = nextModuleFunction === null ? rest.slice(0, 20000) : rest.slice(0, nextModuleFunction.index + 1)
  assert.ok(!/position\s*:\s*['"]?fixed/i.test(snippet), 'settings page component must not use fixed positioning')
  assert.ok(!/backdrop/i.test(snippet), 'settings page component must not render a backdrop')
  assert.ok(!/\bmodal\b/i.test(snippet), 'settings page component must not render a modal')
  assert.ok(!/document\.body/.test(snippet), 'settings page component must not write document.body')

  const client = loadClient({ snapshot: makeV2Snapshot({ planId: 'custom' }) })
  await client.loadInitialSnapshot()
  const tree = client.render('settings.section', { close() {} })
  const dialogNodes = client.hosts(tree).filter(
    (node) =>
      node.props.role === 'dialog' ||
      /backdrop|modal/i.test(String(node.props.className ?? '')),
  )
  assert.deepEqual(dialogNodes.map((node) => node.type), [], 'settings page renders no dialog/backdrop/modal nodes')
  client.close()
})

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

test('v1 snapshot (no vendor/vendors fields) renders without throwing in every slot', async () => {
  const client = loadClient({ snapshot: makeV1Snapshot() })
  await client.loadInitialSnapshot()

  const chip = client.render('sidebar.footer.action', { wide: true })
  assert.ok(chip, 'chip renders against a v1 snapshot')
  const strip = client.render('conversation.composer.dock', {})
  assert.ok(strip, 'composer strip renders against a v1 snapshot')

  const chipClickable = client.clickables(chip)[0]
  assert.ok(chipClickable, 'chip is clickable')
  await client.click(chipClickable)
  const overlay = client.render('shell.overlay', {})
  assert.ok(overlay, 'overlay renders against a v1 snapshot')

  const settings = client.render('settings.section', { close() {} })
  assert.ok(settings, 'settings page renders against a v1 snapshot without throwing')
  assert.ok(client.text(settings).length > 0, 'settings page still renders text')
  client.close()
})

test('client poll/actions target the documented host route', async () => {
  const client = loadClient()
  await client.loadInitialSnapshot()
  assert.ok(client.fetchLog.length >= 1, 'client polls the host on activation')
  for (const entry of client.fetchLog) {
    assert.equal(entry.url, '/subscription-sim/api', 'client only talks to /subscription-sim/api')
  }
  assert.ok(
    client.actions().every((body) => typeof body.action === 'string'),
    'every request carries a JSON action body',
  )
  client.close()
})
