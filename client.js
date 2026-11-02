window.__ModuleLoader__.load({
  id: 'dsh-subscription-sim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useEffect, useRef, useState, useSyncExternalStore } = React

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    /** Host HTTP route shared with the Host half of this bundle. */
    const ROUTE = '/subscription-sim/api'
    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'subscription-sim'
    /** Poll cadence while the tab is visible. */
    const POLL_MS = 4000
    /** Stable id of the style tag this plugin owns. */
    const STYLE_ID = 'dsh-subscription-sim/client.css'
    /** Element id used by aria-labelledby for the panel dialog. */
    const PANEL_TITLE_ID = 'dss-panel-title'
    /** The two simulated rolling windows, in display order. */
    const WINDOW_KEYS = ['h5', 'd7']
    /** How many recent events the panel lists. */
    const MAX_EVENTS = 8
    /** Upper bound accepted by the host's `set-limit` action. */
    const MAX_LIMIT = 2000000000
    /** Action scopes whose host error is rendered inline inside the settings page. */
    const SETTINGS_SCOPES = ['set-plan', 'set-windows', 'set-settings', 'set-limit', 'reset-all']

    // -------------------------------------------------------------------
    // Localized dictionaries (ZH is the operator-facing source of truth)
    // -------------------------------------------------------------------
    const ZH = {
      sidebarLabel: '订阅',
      stripLabel: '订阅额度',
      panelLabel: '订阅',
      panelTitle: '订阅额度',
      settingsLabel: '订阅额度',
      settingsTitle: '订阅额度',
      settingsIntro: '本地模拟：额度、价格与拦截行为都只用于演示，与真实计费无关。',
      settingsLoading: '正在读取模拟器状态…',
      hostMismatch: '宿主版本不匹配，请重启 dsh 并刷新页面后重试。',
      simBadge: '模拟订阅',
      simBadgeHint: '所有额度均为本机模拟，不影响 DeepSeek 的真实计费',
      close: '关闭',
      closePanel: '关闭订阅面板',
      refresh: '刷新',
      currentPlan: '当前套餐',
      pricePerMonth: '{price}/月',
      priceFree: '免费',
      priceCustom: '自定义额度',
      usageSection: '额度用量',
      windowH5: '5 小时窗口',
      windowD7: '7 天窗口',
      windowH5Short: '5 小时',
      windowD7Short: '7 天',
      usedOfLimit: '已用 {used} / {limit} tokens',
      autoRelease: '额度将在 {duration}后自动释放',
      noUsage: '暂无消耗',
      exhausted: '已用尽',
      notEnabled: '未启用',
      lifetimeLine: '累计 {tokens} tokens · {calls} 次请求',
      blockedHint: '额度已用尽，下一次模型请求会被拦截；使用重置卡或等待自动释放即可继续。',
      windowMeta: '{window}：已用 {percent}',
      cardsSection: '重置卡',
      cardsHeld: '持有 {n} 张',
      cardsHeldNone: '还没有重置卡，先领一张吧',
      cardsMeta: '上限 {max} 张 · 每次 +{batch}',
      claimCard: '+ 领取重置卡',
      claimCooldown: '{seconds} 秒后可领取',
      claimMax: '已达持有上限',
      useCard: '使用重置卡',
      useCardHint: '使用一张重置卡，立刻清空一个窗口的已用额度',
      useCardTarget: '将清空{window}的已用额度',
      plansSection: '订阅方案',
      plansSectionHint: '选择档位后立即生效；额度与价格均为模拟数据。',
      planSwitchAria: '切换到 {plan}',
      planLimits: '5 小时 {h5} · 7 天 {d7}',
      limitH5: '5 小时额度',
      limitD7: '7 天额度',
      save: '保存',
      invalidLimit: '额度需为 1 到 2,000,000,000 之间的整数',
      windowsSection: '额度窗口',
      windowsSectionHint: '至少保留一个窗口开启；对两家供应商同时生效。',
      windowsBothDisabledError: '至少需要保留一个额度窗口',
      enforcementSection: '拦截设置',
      customLimitsSection: '自定义额度',
      customLimitsHint: '保存后会保留当前供应商，并把当前套餐切换为自定义额度。',
      customActive: '当前生效',
      dangerSection: '危险区域',
      storageSection: '存储',
      storageHint: '模拟数据只保存在本机，不会上传到任何服务器。',
      storageSaved: '已保存到本机',
      toggleH5: '启用 5 小时窗口',
      toggleD7: '启用 7 天窗口',
      toggleWindowsHint: '至少保留一个窗口开启',
      toggleEnforce: '拦截请求',
      toggleEnforceHint: '额度用尽时真的拦截模型请求',
      toggleAux: '统计压缩 / 标题调用',
      toggleAuxHint: '关闭后，压缩与标题生成不消耗额度、也不会被拦截',
      resetAll: '重置全部模拟数据',
      resetAllHint: '清空用量、事件与重置卡，保留套餐与设置',
      confirmResetYes: '确认重置',
      cancel: '取消',
      eventsSection: '最近事件',
      eventsEmpty: '还没有事件',
      eventUsage: '消耗 {tokens} tokens',
      eventClaim: '领取了重置卡',
      eventRedeem: '使用重置卡（{window}）',
      eventPlan: '切换了套餐',
      eventWindows: '更新了窗口开关',
      eventSettings: '更新了设置',
      eventReset: '重置了模拟数据',
      eventBlocked: '请求被额度拦截（{window}）',
      footerSim: '额度为本地模拟数据，不改变 DeepSeek 的真实计费。',
      footerFile: '数据文件：{path}',
      settingsHint: '在 设置 → 订阅额度 中调整档位、窗口与拦截开关',
      offline: '无法连接模拟器，显示的是上次数据',
      offlineShort: '离线：操作可能失败',
      updated: '更新于 {time}',
      errorNetwork: '网络异常，请稍后重试',
      errorGeneric: '操作失败，请重试',
      storageError: '数据保存异常：{message}',
      bannerTitle: '额度已用尽',
      bannerBlockedWindow: '{window}额度已用尽（{used} / {limit} tokens）',
      bannerAutoRelease: '额度将在 {duration}后自动释放',
      bannerUseCard: '使用重置卡（剩 {n} 张）',
      bannerClaim: '领取重置卡',
      bannerLater: '稍后',
      chipAria: '打开订阅面板：{plan}，已用 {percent}',
      chipExhaustedAria: '打开订阅面板：{plan}，额度已用尽',
      chipTitle: '订阅 · {plan} · 已用 {percent} · 重置卡 {cards} 张',
      stripAria: '打开订阅面板',
      stripTitle: '订阅额度：{plan} · 已用 {percent}',
      stripCards: '{n} 张重置卡',
      durationDays: '{n} 天',
      durationHours: '{n} 小时',
      durationMinutes: '{n} 分',
      durationSeconds: '{n} 秒',
      durationNone: '片刻',
      none: '—',
    }

    const EN = {
      sidebarLabel: 'Subscription',
      stripLabel: 'Subscription quota',
      panelLabel: 'Subscription',
      panelTitle: 'Subscription quota',
      settingsLabel: 'Subscription quota',
      settingsTitle: 'Subscription quota',
      settingsIntro: 'Local simulation: quotas, prices and enforcement are only for demonstration and never affect real billing.',
      settingsLoading: 'Reading simulator state…',
      hostMismatch: 'Host version mismatch — restart dsh and refresh this page.',
      simBadge: 'Simulated',
      simBadgeHint: 'All quotas are simulated locally and never affect real billing',
      close: 'Close',
      closePanel: 'Close the subscription panel',
      refresh: 'Refresh',
      currentPlan: 'Current plan',
      pricePerMonth: '{price}/mo',
      priceFree: 'Free',
      priceCustom: 'Custom limits',
      usageSection: 'Usage',
      windowH5: '5-hour window',
      windowD7: '7-day window',
      windowH5Short: '5h',
      windowD7Short: '7d',
      usedOfLimit: '{used} / {limit} tokens used',
      autoRelease: 'Auto-releases in {duration}',
      noUsage: 'No usage yet',
      exhausted: 'Exhausted',
      notEnabled: 'Disabled',
      lifetimeLine: '{tokens} tokens · {calls} requests all time',
      blockedHint: 'Quota is exhausted, so the next model request will be blocked. Use a reset card or wait for the auto-release to continue.',
      windowMeta: '{window}: {percent} used',
      cardsSection: 'Reset cards',
      cardsHeld: '{n} held',
      cardsHeldNone: 'No cards yet — claim one below',
      cardsMeta: 'max {max} · +{batch} per claim',
      claimCard: '+ Claim a reset card',
      claimCooldown: 'Claimable in {seconds}s',
      claimMax: 'At the held limit',
      useCard: 'Use a reset card',
      useCardHint: 'Spend one card to clear the used tokens of one window immediately',
      useCardTarget: 'Clears the {window}',
      plansSection: 'Subscription plans',
      plansSectionHint: 'The selected plan applies immediately; quotas and prices are simulated.',
      planSwitchAria: 'Switch to {plan}',
      planLimits: '5h {h5} · 7d {d7}',
      limitH5: '5-hour limit',
      limitD7: '7-day limit',
      save: 'Save',
      invalidLimit: 'Limit must be an integer between 1 and 2,000,000,000',
      windowsSection: 'Quota windows',
      windowsSectionHint: 'At least one window must stay enabled; applies to both vendors.',
      windowsBothDisabledError: 'At least one quota window must stay enabled',
      enforcementSection: 'Enforcement',
      customLimitsSection: 'Custom limits',
      customLimitsHint: 'Saving keeps the current vendor and switches the plan to custom limits.',
      customActive: 'Active',
      dangerSection: 'Danger zone',
      storageSection: 'Storage',
      storageHint: 'Simulated data is stored on this machine only and is never uploaded.',
      storageSaved: 'Saved locally',
      toggleH5: 'Enable the 5-hour window',
      toggleD7: 'Enable the 7-day window',
      toggleWindowsHint: 'At least one window must stay enabled',
      toggleEnforce: 'Block requests',
      toggleEnforceHint: 'Really block model requests when quota is exhausted',
      toggleAux: 'Count compaction / title calls',
      toggleAuxHint: 'When off, compaction and session-title calls are free and never blocked',
      resetAll: 'Reset all simulated data',
      resetAllHint: 'Clears usage, events and cards; plan and settings are kept',
      confirmResetYes: 'Yes, reset everything',
      cancel: 'Cancel',
      eventsSection: 'Recent events',
      eventsEmpty: 'No events yet',
      eventUsage: 'Used {tokens} tokens',
      eventClaim: 'Claimed a reset card',
      eventRedeem: 'Used a reset card ({window})',
      eventPlan: 'Switched plan',
      eventWindows: 'Updated window toggles',
      eventSettings: 'Updated settings',
      eventReset: 'Reset simulated data',
      eventBlocked: 'Request blocked by quota ({window})',
      footerSim: 'Quota is simulated locally and never changes DeepSeek billing.',
      footerFile: 'Data file: {path}',
      settingsHint: 'Adjust plan, windows and enforcement in Settings → Subscription quota',
      offline: 'Cannot reach the simulator; showing the last known data',
      offlineShort: 'Offline: actions may fail',
      updated: 'Updated {time}',
      errorNetwork: 'Network error; try again shortly',
      errorGeneric: 'Action failed; try again',
      storageError: 'Storage error: {message}',
      bannerTitle: 'Quota exhausted',
      bannerBlockedWindow: '{window} quota exhausted ({used} / {limit} tokens)',
      bannerAutoRelease: 'Quota auto-releases in {duration}',
      bannerUseCard: 'Use a reset card ({n} left)',
      bannerClaim: 'Claim a reset card',
      bannerLater: 'Later',
      chipAria: 'Open the subscription panel: {plan}, {percent} used',
      chipExhaustedAria: 'Open the subscription panel: {plan}, quota exhausted',
      chipTitle: 'Subscription · {plan} · {percent} used · {cards} cards',
      stripAria: 'Open the subscription panel',
      stripTitle: 'Subscription quota: {plan} · {percent} used',
      stripCards: '{n} cards',
      durationDays: '{n}d',
      durationHours: '{n}h',
      durationMinutes: '{n}m',
      durationSeconds: '{n}s',
      durationNone: 'soon',
      none: '—',
    }

    // -------------------------------------------------------------------
    // Module-level external store shared by all four slots
    // -------------------------------------------------------------------
    let state = {
      /** Last successful host snapshot; null until the first successful call. */
      snapshot: null,
      /** Whether the subscription panel is open. */
      open: false,
      /** Action key currently in flight, or null. */
      busy: null,
      /** True after a failed fetch; the last snapshot is kept. */
      offline: false,
      /** Last host-reported or network error, localized message. */
      lastError: null,
      /** Host error code of `lastError`, or null (network/refresh errors). */
      lastErrorCode: null,
      /** Action scope that produced `lastError`, or null for page-level errors. */
      lastErrorScope: null,
      /** Client clock of the last successful snapshot application. */
      lastSyncedAt: 0,
      /** Bumped when the active locale changes so every surface re-renders. */
      localeRev: 0,
      /** Window picked for the next "use reset card" call. */
      windowChoice: null,
    }

    const listeners = new Set()
    const getState = () => state
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const setState = (patch) => {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    }
    function useStore() {
      return useSyncExternalStore(subscribe, getState, getState)
    }

    // -------------------------------------------------------------------
    // Locale runtime and translation
    // -------------------------------------------------------------------
    /** Locale runtime captured at apply time (for Intl-aware formatting). */
    let localeRuntime = null
    /** Bound translate function; replaced when the plugin activates. */
    let t = (key) => key

    function activeLocale() {
      try {
        const id = localeRuntime === null ? null : localeRuntime.getLocale().active
        if (typeof id === 'string' && id !== '') return id
      } catch {
        // fall through to the safe default
      }
      return 'en'
    }

    function localeKey() {
      return activeLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    function numberFormat(options) {
      try {
        return new Intl.NumberFormat(activeLocale(), options)
      } catch {
        return null
      }
    }

    /** Grouped integer formatting, locale-aware. */
    function num(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('none')
      const format = numberFormat({ maximumFractionDigits: 0 })
      return format === null ? String(Math.round(value)) : format.format(value)
    }

    /** Compact token count for tight surfaces, locale-aware. */
    function compactNum(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('none')
      const format = numberFormat({ notation: 'compact', maximumFractionDigits: 1 })
      return format === null ? String(Math.round(value)) : format.format(value)
    }

    /** USD price formatting, locale-aware, narrow symbol so ZH still reads $20. */
    function money(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return t('none')
      const format = numberFormat({
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumFractionDigits: 0,
      })
      if (format === null) return '$' + Math.round(value)
      return format.format(value)
    }

    /** One-decimal-free locale percent formatting. */
    function percentText(value) {
      const percent = typeof value === 'number' && Number.isFinite(value) ? value : 0
      const format = numberFormat({ style: 'percent', maximumFractionDigits: 0 })
      return format === null ? String(Math.round(percent)) + '%' : format.format(percent / 100)
    }

    /** Locale-aware "time until release" text built from dictionary templates. */
    function durationText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return t('durationNone')
      let seconds = Math.round(ms / 1000)
      const days = Math.floor(seconds / 86400)
      seconds -= days * 86400
      const hours = Math.floor(seconds / 3600)
      seconds -= hours * 3600
      const minutes = Math.floor(seconds / 60)
      seconds -= minutes * 60
      const parts = []
      if (days > 0) parts.push(t('durationDays', { n: num(days) }))
      if (hours > 0) parts.push(t('durationHours', { n: num(hours) }))
      if (minutes > 0) parts.push(t('durationMinutes', { n: num(minutes) }))
      if (parts.length === 0 && seconds > 0) parts.push(t('durationSeconds', { n: num(seconds) }))
      return parts.length === 0 ? t('durationNone') : parts.slice(0, 2).join(' ')
    }

    /** Locale-aware relative time via Intl.RelativeTimeFormat. */
    function relativeTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      const diff = at - Date.now()
      const abs = Math.abs(diff)
      let unit = 'second'
      let value = Math.round(diff / 1000)
      if (abs >= 86400000) {
        unit = 'day'
        value = Math.round(diff / 86400000)
      } else if (abs >= 3600000) {
        unit = 'hour'
        value = Math.round(diff / 3600000)
      } else if (abs >= 60000) {
        unit = 'minute'
        value = Math.round(diff / 60000)
      }
      try {
        return new Intl.RelativeTimeFormat(activeLocale(), { numeric: 'auto' }).format(value, unit)
      } catch {
        return ''
      }
    }

    /** Locale-aware wall clock for event tooltips and the updated-at line. */
    function clockTime(at) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return ''
      try {
        return new Intl.DateTimeFormat(activeLocale(), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(at))
      } catch {
        return ''
      }
    }

    // -------------------------------------------------------------------
    // Snapshot helpers (defensive: never throw during render)
    // -------------------------------------------------------------------
    function clampPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0
      return Math.max(0, Math.min(100, value))
    }

    function cardCount(snapshot) {
      const cards = snapshot === null ? null : snapshot.cards
      const held = cards === null || cards === undefined ? 0 : cards.held
      return typeof held === 'number' && Number.isFinite(held) ? held : 0
    }

    function windowEntries(snapshot) {
      const windows = snapshot === null || snapshot === undefined ? null : snapshot.windows
      if (windows === null || windows === undefined) return []
      return WINDOW_KEYS.filter((key) => windows[key] !== null && windows[key] !== undefined).map((key) => ({
        key,
        win: windows[key],
      }))
    }

    function enabledWindowEntries(snapshot) {
      return windowEntries(snapshot).filter((entry) => entry.win.enabled === true)
    }

    function worstEnabled(snapshot) {
      let worst = null
      for (const entry of enabledWindowEntries(snapshot)) {
        if (worst === null || (entry.win.percent ?? 0) > (worst.win.percent ?? 0)) worst = entry
      }
      return worst
    }

    function windowTone(win) {
      if (win === null || win === undefined) return 'brand'
      if (win.exhausted === true) return 'error'
      const percent = typeof win.percent === 'number' ? win.percent : 0
      if (percent >= 80) return 'warn'
      return 'brand'
    }

    function fillModifier(tone) {
      if (tone === 'error') return ' dss-fillError'
      if (tone === 'warn') return ' dss-fillWarn'
      return ''
    }

    function bothWindowsEnabled(snapshot) {
      const windows = snapshot === null || snapshot === undefined ? null : snapshot.windows
      if (windows === null || windows === undefined) return false
      return windows.h5?.enabled === true && windows.d7?.enabled === true
    }

    /** Window the next `use-card` action should clear. */
    function useCardTargetWindow(snapshot) {
      const blocked = snapshot === null || snapshot === undefined ? null : snapshot.blockedWindow
      if (blocked === 'h5' || blocked === 'd7') return blocked
      const enabled = enabledWindowEntries(snapshot)
      if (enabled.length === 0) return 'h5'
      let target = enabled[0]
      for (const entry of enabled) {
        if ((entry.win.percent ?? 0) > (target.win.percent ?? 0)) target = entry
      }
      return target.key
    }

    function lastHitWindow(snapshot) {
      const hit = snapshot === null || snapshot === undefined ? null : snapshot.lastHit
      if (hit !== null && hit !== undefined && (hit.window === 'h5' || hit.window === 'd7')) return hit.window
      const blocked = snapshot === null || snapshot === undefined ? null : snapshot.blockedWindow
      if (blocked === 'h5' || blocked === 'd7') return blocked
      return null
    }

    /** Pick the active-locale entry of a host-provided `{ zh, en }` label. */
    function localizedName(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value !== 'object') return ''
      const preferred = value[localeKey()]
      if (typeof preferred === 'string' && preferred !== '') return preferred
      if (typeof value.en === 'string' && value.en !== '') return value.en
      if (typeof value.zh === 'string' && value.zh !== '') return value.zh
      return ''
    }

    function localizedPlanName(plan) {
      if (plan === null || plan === undefined) return ''
      const name = localizedName(plan.name)
      if (name !== '') return name
      return typeof plan.id === 'string' ? plan.id : ''
    }

    /** Vendor catalog from the v2 snapshot; empty on a v1 host (graceful fallback). */
    function vendorList(snapshot) {
      if (snapshot === null || snapshot === undefined) return []
      const vendors = snapshot.vendors
      if (!Array.isArray(vendors)) return []
      return vendors.filter((vendor) => vendor !== null && vendor !== undefined && typeof vendor.id === 'string')
    }

    /** Vendor id of the active plan, v2 field first with a v1-safe fallback. */
    function activeVendorId(snapshot) {
      const plan = snapshot === null || snapshot === undefined ? null : snapshot.plan
      if (plan !== null && plan !== undefined && typeof plan.vendorId === 'string') return plan.vendorId
      const vendor = snapshot === null || snapshot === undefined ? null : snapshot.vendor
      if (vendor !== null && vendor !== undefined && typeof vendor.id === 'string') return vendor.id
      return ''
    }

    /** Vendor display name for the panel header; empty on a v1 snapshot. */
    function planVendorName(snapshot) {
      const plan = snapshot === null || snapshot === undefined ? null : snapshot.plan
      const fromPlan = plan === null || plan === undefined ? '' : localizedName(plan.vendorName)
      if (fromPlan !== '') return fromPlan
      const vendor = snapshot === null || snapshot === undefined ? null : snapshot.vendor
      return vendor === null || vendor === undefined ? '' : localizedName(vendor.name)
    }

    function planPriceText(plan) {
      if (plan === null || plan === undefined) return ''
      if (plan.custom === true) return t('priceCustom')
      const price = typeof plan.priceUSD === 'number' && Number.isFinite(plan.priceUSD) ? plan.priceUSD : 0
      if (price <= 0) return t('priceFree')
      return t('pricePerMonth', { price: money(price) })
    }

    function planLimitsText(plan) {
      const limits = plan === null || plan === undefined || plan.limits === null || plan.limits === undefined ? {} : plan.limits
      return t('planLimits', {
        h5: compactNum(typeof limits.h5 === 'number' ? limits.h5 : 0),
        d7: compactNum(typeof limits.d7 === 'number' ? limits.d7 : 0),
      })
    }

    function windowLabel(key) {
      return t(key === 'h5' ? 'windowH5' : 'windowD7')
    }

    function shortWindowLabel(key) {
      return t(key === 'h5' ? 'windowH5Short' : 'windowD7Short')
    }

    function parseLimit(value) {
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      if (trimmed === '' || !/^\d+$/.test(trimmed)) return null
      const number = Number(trimmed)
      if (!Number.isInteger(number) || number < 1 || number > MAX_LIMIT) return null
      return number
    }

    function eventText(event) {
      const kind = event === null || event === undefined ? null : event.kind
      if (kind === null || kind === undefined) return ''
      const window =
        event.window === 'h5' || event.window === 'd7' ? windowLabel(event.window) : t('none')
      switch (kind) {
        case 'usage':
          return t('eventUsage', { tokens: num(typeof event.tokens === 'number' ? event.tokens : 0) })
        case 'claim':
          return t('eventClaim')
        case 'redeem':
          return t('eventRedeem', { window })
        case 'plan':
          return t('eventPlan')
        case 'windows':
          return t('eventWindows')
        case 'settings':
          return t('eventSettings')
        case 'reset':
          return t('eventReset')
        case 'blocked':
          return t('eventBlocked', { window })
        default:
          return String(kind)
      }
    }

    function eventDotClass(event) {
      const kind = event === null || event === undefined ? null : event.kind
      if (kind === 'blocked') return ' dss-dotError'
      if (kind === 'claim' || kind === 'redeem') return ' dss-dotSuccess'
      if (kind === 'plan' || kind === 'windows' || kind === 'settings') return ' dss-dotBrand'
      if (kind === 'reset') return ' dss-dotWarn'
      return ''
    }

    // -------------------------------------------------------------------
    // HTTP transport + store mutations
    // -------------------------------------------------------------------
    let inflight = null
    let disposed = false

    async function post(body) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) throw new Error('HTTP ' + response.status)
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return payload
    }

    function errorText(payload, fallback) {
      const error = payload === null || payload === undefined ? null : payload.error
      if (error !== null && error !== undefined) {
        if (typeof error.message === 'string' && error.message !== '') return error.message
        if (typeof error.code === 'string' && error.code !== '') return fallback + ' (' + error.code + ')'
      }
      return fallback
    }

    function applySnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return
      setState({
        snapshot,
        offline: false,
        lastError: null,
        lastErrorCode: null,
        lastErrorScope: null,
        lastSyncedAt: Date.now(),
      })
    }

    /** Poll one read-only snapshot; coalesces concurrent callers. */
    function refresh() {
      if (inflight !== null) return inflight
      inflight = (async () => {
        try {
          const payload = await post({ action: 'state' })
          if (payload.ok === true && payload.state !== null && typeof payload.state === 'object') {
            applySnapshot(payload.state)
          } else {
            if (!disposed) {
              const error = payload.error ?? null
              setState({
                offline: true,
                lastError: errorText(payload, t('errorGeneric')),
                lastErrorCode: error !== null && typeof error.code === 'string' ? error.code : null,
                lastErrorScope: 'refresh',
              })
            }
          }
        } catch {
          if (!disposed) setState({ offline: true })
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    /**
     * Run one or more mutation actions sequentially, applying each returned
     * snapshot. Resolves false on the first failure; never throws.
     */
    async function runActions(actions, busyKey) {
      if (state.busy !== null) return false
      setState({ busy: busyKey, lastError: null, lastErrorCode: null, lastErrorScope: null })
      try {
        for (const item of actions) {
          const payload = await post({ action: item.action, ...(item.payload ?? {}) })
          if (payload.ok !== true) {
            if (!disposed) {
              const error = payload.error ?? null
              const code = error !== null && typeof error.code === 'string' ? error.code : null
              setState({
                lastError: code === 'both_windows_disabled' ? t('windowsBothDisabledError') : errorText(payload, t('errorGeneric')),
                lastErrorCode: code,
                lastErrorScope: busyKey,
              })
            }
            return false
          }
          if (payload.state !== null && typeof payload.state === 'object') applySnapshot(payload.state)
        }
        return true
      } catch {
        if (!disposed) setState({ offline: true, lastError: t('errorNetwork'), lastErrorCode: null, lastErrorScope: busyKey })
        return false
      } finally {
        if (!disposed) setState({ busy: null })
      }
    }

    function claimCard() {
      void runActions([{ action: 'claim-card' }], 'claim')
    }

    function redeemCard(windowKey) {
      void runActions([{ action: 'use-card', payload: { window: windowKey } }], 'use-card').then((ok) => {
        if (ok) setState({ windowChoice: null })
      })
    }

    function dismissHit() {
      void runActions([{ action: 'dismiss-hit' }], 'dismiss-hit')
    }

    // -------------------------------------------------------------------
    // Panel focus management (restore on close, Tab trap while focused)
    // -------------------------------------------------------------------
    let focusReturn = null

    function openPanel() {
      if (state.open) return
      if (typeof document !== 'undefined') {
        const active = document.activeElement
        focusReturn = active instanceof HTMLElement ? active : null
      }
      setState({ open: true })
      if (state.snapshot === null) void refresh()
    }

    function closePanel() {
      if (!state.open) return
      setState({ open: false })
      const target = focusReturn
      focusReturn = null
      if (target !== null && target.isConnected) {
        window.setTimeout(() => {
          try {
            target.focus()
          } catch {
            // the surface may have been removed by then; nothing to restore
          }
        }, 0)
      }
    }

    function togglePanel() {
      if (state.open) closePanel()
      else openPanel()
    }

    // -------------------------------------------------------------------
    // Visibility-aware polling
    // -------------------------------------------------------------------
    function startPolling() {
      let timer = null
      const stop = () => {
        if (timer !== null) {
          window.clearInterval(timer)
          timer = null
        }
      }
      const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
      const start = () => {
        stop()
        if (!visible()) return
        timer = window.setInterval(() => {
          if (visible()) void refresh()
        }, POLL_MS)
      }
      const onVisibility = () => {
        if (visible()) {
          void refresh()
          start()
        } else {
          stop()
        }
      }
      void refresh()
      start()
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
      return () => {
        stop()
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    // -------------------------------------------------------------------
    // Styles (one tag, owned by ctx.effect, removed on dispose)
    // -------------------------------------------------------------------
    const CSS = `
      .dss-glyph{display:block;flex:none}
      .dss-chip{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:36px;margin:0 0 4px;padding:0 8px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
      .dss-chip:hover{background:var(--dsw-alias-bg-layer-2)}
      .dss-chip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}
      .dss-chipGlyph{display:grid;place-items:center;width:18px;height:18px;flex:none;color:var(--dsw-alias-brand-primary)}
      .dss-chipBlocked .dss-chipGlyph{color:var(--dsw-alias-state-error-primary)}
      .dss-chipBody{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
      .dss-chipTop{display:flex;align-items:baseline;gap:6px;min-width:0}
      .dss-chipLabel{font-size:12px;line-height:14px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .dss-chipValue{margin-left:auto;font-size:12px;line-height:14px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
      .dss-chipBlocked .dss-chipValue{color:var(--dsw-alias-state-error-primary)}
      .dss-chipTrack{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .dss-chipFill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
      .dss-chipCards{position:absolute;top:-3px;right:-2px;box-sizing:border-box;min-width:14px;height:14px;padding:0 3px;display:grid;place-items:center;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:9px;line-height:1;font-weight:600;font-variant-numeric:tabular-nums;pointer-events:none}
      .dss-chipRail{width:36px;height:36px;margin:0;padding:0;flex-direction:column;justify-content:center;gap:0}
      .dss-chipRail .dss-chipGlyph{width:16px;height:16px}
      .dss-chipRailPct{max-width:34px;font-size:9px;line-height:11px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden}
      .dss-chipBlocked .dss-chipRailPct{color:var(--dsw-alias-state-error-primary)}
      .dss-strip{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;max-width:100%;min-width:0;height:24px;padding:0 10px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;white-space:nowrap;cursor:pointer}
      .dss-strip:hover{background:var(--dsw-alias-bg-layer-2)}
      .dss-strip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
      .dss-stripGlyph{display:grid;place-items:center;flex:none;color:var(--dsw-alias-brand-primary)}
      .dss-stripBlocked{border-color:var(--dsw-alias-state-error-primary)}
      .dss-stripBlocked .dss-stripGlyph{color:var(--dsw-alias-state-error-primary)}
      .dss-stripOffline{border-style:dashed}
      .dss-stripPlan{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:var(--dsw-alias-label-primary)}
      .dss-stripWin{display:inline-flex;align-items:center;gap:4px;flex:none}
      .dss-stripWinLabel{font-size:10px;color:var(--dsw-alias-label-secondary)}
      .dss-stripBar{width:26px;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;flex:none}
      .dss-stripFill{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary)}
      .dss-stripPct{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
      .dss-stripCards{display:inline-flex;align-items:center;gap:3px;flex:none;color:var(--dsw-alias-label-secondary)}
      .dss-chipFill.dss-fillWarn,.dss-stripFill.dss-fillWarn,.dss-barFill.dss-fillWarn{background:var(--dsw-alias-state-warn-primary)}
      .dss-chipFill.dss-fillError,.dss-stripFill.dss-fillError,.dss-barFill.dss-fillError{background:var(--dsw-alias-state-error-primary)}
      .dss-panel{position:fixed;z-index:31;top:12px;right:12px;bottom:12px;box-sizing:border-box;width:min(400px,calc(100vw - 24px));display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
      .dss-panelHeader{flex:none;display:flex;flex-direction:column;gap:6px;padding:12px 14px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
      .dss-panelHeadRow{display:flex;align-items:center;gap:8px;min-width:0}
      .dss-panelTitle{margin:0;flex:none;font-size:15px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .dss-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;white-space:nowrap}
      .dss-panelActions{margin-left:auto;display:flex;align-items:center;gap:2px;flex:none}
      .dss-iconBtn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
      .dss-iconBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .dss-iconBtn:disabled{opacity:.5;cursor:default}
      .dss-iconBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
      .dss-panelPlan{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:12px;line-height:16px}
      .dss-planCaption{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
      .dss-planVendor{flex:none;max-width:42%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .dss-planSep{flex:none;color:var(--dsw-alias-label-tertiary)}
      .dss-planName{min-width:0;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dss-planPrice{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
      .dss-panelBody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:14px;padding:12px 14px 14px}
      .dss-section{display:flex;flex-direction:column;gap:7px;min-width:0}
      .dss-sectionHead{display:flex;align-items:center;gap:8px;min-width:0}
      .dss-sectionTitle{margin:0;font-size:12px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
      .dss-sectionMeta{margin-left:auto;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dss-inlineError,.dss-inlineWarn{font-size:11px;line-height:1.5;padding:7px 9px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      .dss-inlineError{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .dss-errorText{color:var(--dsw-alias-state-error-primary)}
      .dss-warnText{color:var(--dsw-alias-state-warn-primary)}
      .dss-usageCard{box-sizing:border-box;display:flex;flex-direction:column;gap:7px;padding:10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
      .dss-usageCardError{border-color:var(--dsw-alias-state-error-primary)}
      .dss-usageHead{display:flex;align-items:baseline;gap:8px;min-width:0}
      .dss-usageTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
      .dss-usagePct{margin-left:auto;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .dss-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .dss-barFill{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
      .dss-usageMeta{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
      .dss-usageMeta > span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dss-disabledList{display:flex;flex-direction:column;gap:3px}
      .dss-disabledRow{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
      .dss-idleDot{flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}
      .dss-rowHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      .dss-tickets{display:flex;flex-wrap:wrap;gap:4px;min-height:16px;color:var(--dsw-alias-brand-primary)}
      .dss-ticket{display:block;flex:none}
      .dss-cardActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .dss-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer}
      .dss-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
      .dss-btn:disabled{opacity:.55;cursor:default}
      .dss-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
      .dss-btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .dss-btnGhost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
      .dss-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
      .dss-segBtn{height:24px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer}
      .dss-segBtn[aria-pressed=true]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .dss-segBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-1px}
      .dss-planRow{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}
      .dss-planRow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dss-planRow:disabled{cursor:default}
      .dss-planRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
      .dss-planActive{border-color:var(--dsw-alias-brand-primary)}
      .dss-planActive .dss-planName{color:var(--dsw-alias-brand-primary)}
      .dss-planRowMain{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1}
      .dss-planLimits{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
      .dss-planMark{display:grid;place-items:center;flex:none;color:var(--dsw-alias-brand-primary)}
      .dss-customInputs{display:flex;flex-wrap:wrap;gap:12px;min-width:0}
      .dss-field{display:flex;flex-direction:column;gap:6px;flex:1 1 200px;min-width:160px}
      .dss-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
      .dss-input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
      .dss-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
      .dss-input:disabled{opacity:.6;cursor:default}
      .dss-toggleRow{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
      .dss-toggleRow:last-child{border-bottom:none;padding-bottom:0}
      .dss-toggleText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
      .dss-toggleLabel{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dss-toggleHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dss-switch{position:relative;flex:none;box-sizing:border-box;width:32px;height:18px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);font:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease}
      .dss-switchOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
      .dss-switch:disabled{opacity:.5;cursor:default}
      .dss-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
      .dss-switchKnob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}
      .dss-switchOn .dss-switchKnob{transform:translateX(14px);background:var(--dsw-alias-bg-base)}
      .dss-events{list-style:none;display:flex;flex-direction:column;gap:5px;margin:0;padding:0}
      .dss-event{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:11px;line-height:1.45}
      .dss-dot{flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}
      .dss-dotBrand{background:var(--dsw-alias-brand-primary)}
      .dss-dotSuccess{background:var(--dsw-alias-state-success-primary)}
      .dss-dotWarn{background:var(--dsw-alias-state-warn-primary)}
      .dss-dotError{background:var(--dsw-alias-state-error-primary)}
      .dss-eventLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
      .dss-eventTime{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .dss-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0}
      .dss-panelFoot{flex:none;display:flex;flex-direction:column;gap:4px;padding:9px 14px 11px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:10px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
      .dss-footLine{display:flex;align-items:baseline;gap:6px;min-width:0}
      .dss-path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,monospace);font-size:10px}
      .dss-footHint{color:var(--dsw-alias-label-tertiary)}
      .dss-settings{box-sizing:border-box;display:flex;flex-direction:column;gap:24px;width:100%;max-width:720px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
      .dss-settingsHead{display:flex;flex-direction:column;gap:6px;min-width:0}
      .dss-settingsTitle{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
      .dss-settingsIntro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
      .dss-settingsLoading{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
      .dss-settingsGroup{display:flex;flex-direction:column;gap:10px;min-width:0;padding-top:20px;border-top:.5px solid var(--dsw-alias-border-l2)}
      .dss-settingsHead + .dss-settingsGroup{border-top:none;padding-top:0}
      .dss-settingsGroupHead{display:flex;align-items:baseline;gap:8px;min-width:0}
      .dss-settingsGroupTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dss-settingsGroupHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dss-settingsMeta{margin-left:auto;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dss-settingsBadge{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
      .dss-settingsActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
      .dss-settingsStatus{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dss-settingsBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
      .dss-settingsBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dss-settingsBtn:disabled{opacity:.4;cursor:default}
      .dss-settingsBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
      .dss-settingsBtnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
      .dss-settingsBtnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dss-settingsBtnDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
      .dss-settingsBtnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-secondary)}
      .dss-settingsBtnDangerOutline{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
      .dss-settingsBtnDangerOutline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
      .dss-vendorCards{display:flex;flex-direction:column;gap:10px;min-width:0}
      .dss-vendorCard{display:flex;flex-direction:column;gap:8px;min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
      .dss-vendorHead{display:flex;align-items:baseline;gap:8px;min-width:0}
      .dss-vendorName{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
      .dss-vendorNote{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dss-vendorPlans{display:flex;flex-direction:column;gap:6px;min-width:0;margin-top:2px}
      .dss-planFallback{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
      .dss-storageRow{display:flex;align-items:baseline;gap:8px;min-width:0}
      .dss-settings .dss-inlineError,.dss-settings .dss-inlineWarn{font-size:12px;line-height:18px}
      .dss-banner{position:fixed;z-index:30;left:50%;bottom:96px;transform:translateX(-50%);box-sizing:border-box;width:min(520px,calc(100vw - 24px));display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-state-error-primary);border-left-width:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5}
      .dss-bannerTop{display:flex;align-items:flex-start;gap:10px}
      .dss-bannerGlyph{display:grid;place-items:center;flex:none;margin-top:1px;color:var(--dsw-alias-state-error-primary)}
      .dss-bannerBody{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
      .dss-bannerTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
      .dss-bannerText{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
      .dss-bannerSub{font-size:11px;color:var(--dsw-alias-label-secondary)}
      .dss-bannerActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
      @media (max-width:520px){.dss-panel{top:8px;right:8px;bottom:8px;width:calc(100vw - 16px)}}
      @media (prefers-reduced-motion:reduce){.dss-chipFill,.dss-barFill,.dss-switch,.dss-switchKnob{transition:none}}
    `

    function injectStyles() {
      if (typeof document === 'undefined' || document.head === null || document.head === undefined) {
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-subscription-sim'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode !== null && tag.parentNode !== undefined) tag.parentNode.removeChild(tag)
      }
    }

    // -------------------------------------------------------------------
    // Inline SVG artwork (currentColor only; no literal colors)
    // -------------------------------------------------------------------
    function svgRoot(size, children) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          focusable: 'false',
          'aria-hidden': true,
          className: 'dss-glyph',
        },
        children,
      )
    }

    /** Admission-ticket glyph used for reset cards and the plugin entries. */
    function ticketIcon(size) {
      return svgRoot(size, [
        h('path', {
          key: 'body',
          d: 'M3 4.5h10a.9.9 0 0 1 .9.9v1.35a2.25 2.25 0 0 0 0 4.5v1.35a.9.9 0 0 1-.9.9H3a.9.9 0 0 1-.9-.9v-1.35a2.25 2.25 0 0 0 0-4.5V5.4a.9.9 0 0 1 .9-.9z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'perforation',
          d: 'M9.8 5.5v5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeDasharray: '1.2 1.2',
        }),
      ])
    }

    /** Exhausted/blocked glyph: circled exclamation mark. */
    function alertIcon(size) {
      return svgRoot(size, [
        h('circle', {
          key: 'ring',
          cx: 8,
          cy: 8,
          r: 6.2,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
        }),
        h('path', {
          key: 'stem',
          d: 'M8 4.8v4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
        h('circle', { key: 'dot', cx: 8, cy: 11.4, r: 0.75, fill: 'currentColor' }),
      ])
    }

    function closeIcon(size) {
      return svgRoot(size, [
        h('path', {
          key: 'x',
          d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ])
    }

    function refreshIcon(size) {
      return svgRoot(size, [
        h('path', {
          key: 'arrow',
          d: 'M12.6 8a4.6 4.6 0 1 1-1.4-3.3M12.6 2.9v3.2H9.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    function checkIcon(size) {
      return svgRoot(size, [
        h('path', {
          key: 'check',
          d: 'M3.4 8.4l3 3 6.2-6.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      ])
    }

    /** Progress bar with progressbar semantics. */
    function UsageBar({ percent, tone, label }) {
      const width = clampPercent(percent)
      return h(
        'div',
        {
          className: 'dss-bar',
          role: 'progressbar',
          'aria-label': label,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': Math.round(width),
        },
        h('span', { className: 'dss-barFill' + fillModifier(tone), style: { width: width + '%' } }),
      )
    }

    // -------------------------------------------------------------------
    // Sidebar footer action: compact subscription chip
    // -------------------------------------------------------------------
    function SidebarChip({ wide }) {
      const snap = useStore()
      useEffect(() => {
        void refresh()
      }, [])

      const snapshot = snap.snapshot
      if (snapshot === null) return null

      const worst = worstEnabled(snapshot)
      const worstWindow = worst === null ? null : worst.win
      const tone = windowTone(worstWindow)
      const percent = worstWindow === null ? 0 : worstWindow.percent
      const blocked = snapshot.blocked === true
      const held = cardCount(snapshot)
      const planName = localizedPlanName(snapshot.plan)
      const percentString = percentText(percent)
      const title = t('chipTitle', { plan: planName, percent: percentString, cards: num(held) })
      const ariaLabel = blocked
        ? t('chipExhaustedAria', { plan: planName })
        : t('chipAria', { plan: planName, percent: percentString })
      const className = 'dss-chip' + (wide ? '' : ' dss-chipRail') + (blocked ? ' dss-chipBlocked' : '')

      return h(
        'button',
        {
          type: 'button',
          className,
          title,
          'aria-label': ariaLabel,
          'aria-haspopup': 'dialog',
          'aria-expanded': snap.open,
          onClick: togglePanel,
          'data-subscription-sim-surface': true,
        },
        h('span', { className: 'dss-chipGlyph', 'aria-hidden': true }, blocked ? alertIcon(16) : ticketIcon(16)),
        wide
          ? h(
              'span',
              { className: 'dss-chipBody' },
              h(
                'span',
                { className: 'dss-chipTop' },
                h('span', { className: 'dss-chipLabel' }, t('sidebarLabel')),
                h('span', { className: 'dss-chipValue' }, blocked ? '!' : percentString),
              ),
              h(
                'span',
                { className: 'dss-chipTrack' },
                h('span', {
                  className: 'dss-chipFill' + fillModifier(tone),
                  style: { width: clampPercent(percent) + '%' },
                }),
              ),
            )
          : h('span', { className: 'dss-chipRailPct', 'aria-hidden': true }, blocked ? '!' : percentString),
        held > 0 ? h('span', { className: 'dss-chipCards', 'aria-hidden': true }, num(held)) : null,
      )
    }

    // -------------------------------------------------------------------
    // Composer dock: thin ambient strip below the composer card
    // -------------------------------------------------------------------
    function ComposerStrip() {
      const snap = useStore()
      useEffect(() => {
        void refresh()
      }, [])

      const snapshot = snap.snapshot
      if (snapshot === null) return null

      const entries = enabledWindowEntries(snapshot)
      const blocked = snapshot.blocked === true
      const held = cardCount(snapshot)
      const planName = localizedPlanName(snapshot.plan)
      const worst = worstEnabled(snapshot)
      const worstPercent = worst === null ? 0 : worst.win.percent
      const className =
        'dss-strip' + (blocked ? ' dss-stripBlocked' : '') + (snap.offline ? ' dss-stripOffline' : '')

      return h(
        'button',
        {
          type: 'button',
          className,
          title: t('stripTitle', { plan: planName, percent: percentText(worstPercent) }),
          'aria-label': t('stripAria'),
          'aria-haspopup': 'dialog',
          'aria-expanded': snap.open,
          onClick: togglePanel,
          'data-subscription-sim-surface': true,
        },
        h('span', { className: 'dss-stripGlyph', 'aria-hidden': true }, blocked ? alertIcon(13) : ticketIcon(13)),
        h('span', { className: 'dss-stripPlan' }, planName),
        entries.map((entry) =>
          h(
            'span',
            {
              key: entry.key,
              className: 'dss-stripWin',
              title: t('windowMeta', { window: windowLabel(entry.key), percent: percentText(entry.win.percent) }),
            },
            h('span', { className: 'dss-stripWinLabel' }, shortWindowLabel(entry.key)),
            h(
              'span',
              { className: 'dss-stripBar' },
              h('span', {
                className: 'dss-stripFill' + fillModifier(windowTone(entry.win)),
                style: { width: clampPercent(entry.win.percent) + '%' },
              }),
            ),
            h('span', { className: 'dss-stripPct' }, percentText(entry.win.percent)),
          ),
        ),
        held > 0
          ? h(
              'span',
              { className: 'dss-stripCards', title: t('cardsHeld', { n: num(held) }) },
              ticketIcon(11),
              h('span', null, t('stripCards', { n: num(held) })),
            )
          : null,
      )
    }

    // -------------------------------------------------------------------
    // Panel: usage section
    // -------------------------------------------------------------------
    function UsageCard({ windowKey, win }) {
      const tone = windowTone(win)
      const percent = typeof win.percent === 'number' ? win.percent : 0
      const used = typeof win.used === 'number' ? win.used : 0
      const limit = typeof win.limit === 'number' ? win.limit : 0
      const exhausted = win.exhausted === true
      const status = exhausted
        ? t('exhausted')
        : used === 0
          ? t('noUsage')
          : typeof win.resetInMs === 'number'
            ? t('autoRelease', { duration: durationText(win.resetInMs) })
            : t('noUsage')
      return h(
        'div',
        { className: 'dss-usageCard' + (exhausted ? ' dss-usageCardError' : '') },
        h(
          'div',
          { className: 'dss-usageHead' },
          h('span', { className: 'dss-usageTitle' }, windowLabel(windowKey)),
          h(
            'span',
            {
              className:
                'dss-usagePct' +
                (tone === 'error' ? ' dss-errorText' : tone === 'warn' ? ' dss-warnText' : ''),
            },
            percentText(percent),
          ),
        ),
        h(UsageBar, { percent, tone, label: windowLabel(windowKey) }),
        h(
          'div',
          { className: 'dss-usageMeta' },
          h('span', null, t('usedOfLimit', { used: num(used), limit: num(limit) })),
          h('span', { className: exhausted ? 'dss-errorText' : '' }, status),
        ),
      )
    }

    function UsageSection({ snapshot }) {
      const entries = enabledWindowEntries(snapshot)
      const disabled = windowEntries(snapshot).filter((entry) => entry.win.enabled !== true)
      const blocked = snapshot.blocked === true
      const lifetime = snapshot.lifetime ?? {}
      return h(
        'section',
        { className: 'dss-section' },
        h('div', { className: 'dss-sectionHead' }, h('h3', { className: 'dss-sectionTitle' }, t('usageSection'))),
        blocked ? h('div', { className: 'dss-inlineError' }, t('blockedHint')) : null,
        entries.map((entry) => h(UsageCard, { key: entry.key, windowKey: entry.key, win: entry.win })),
        disabled.length > 0
          ? h(
              'div',
              { className: 'dss-disabledList' },
              disabled.map((entry) =>
                h(
                  'div',
                  { key: entry.key, className: 'dss-disabledRow' },
                  h('span', { className: 'dss-idleDot', 'aria-hidden': true }),
                  h('span', null, windowLabel(entry.key)),
                  h('span', { className: 'dss-sectionMeta' }, t('notEnabled')),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dss-rowHint' },
          t('lifetimeLine', {
            tokens: num(typeof lifetime.tokens === 'number' ? lifetime.tokens : 0),
            calls: num(typeof lifetime.calls === 'number' ? lifetime.calls : 0),
          }),
        ),
      )
    }

    // -------------------------------------------------------------------
    // Panel: reset cards section
    // -------------------------------------------------------------------
    function CardsSection({ snap, snapshot }) {
      const cards = snapshot.cards ?? {}
      const held = typeof cards.held === 'number' ? cards.held : 0
      const maxHeld = typeof cards.maxHeld === 'number' ? cards.maxHeld : 0
      const batch = typeof cards.claimBatch === 'number' ? cards.claimBatch : 1
      const cooldownMs = typeof cards.cooldownRemainingMs === 'number' ? cards.cooldownRemainingMs : 0
      const both = bothWindowsEnabled(snapshot)
      const choice = snap.windowChoice
      const target = both && (choice === 'h5' || choice === 'd7') ? choice : useCardTargetWindow(snapshot)
      const canClaim = cards.canClaim === true && held < maxHeld
      const busy = snap.busy !== null
      const claimLabel =
        held >= maxHeld
          ? t('claimMax')
          : cooldownMs > 0
            ? t('claimCooldown', { seconds: num(Math.ceil(cooldownMs / 1000)) })
            : t('claimCard')
      const tickets = []
      for (let index = 0; index < Math.min(held, 9); index += 1) {
        tickets.push(h('span', { key: index, className: 'dss-ticket' }, ticketIcon(13)))
      }
      const metaText = t('cardsMeta', { max: num(maxHeld), batch: num(batch) })
      return h(
        'section',
        { className: 'dss-section' },
        h(
          'div',
          { className: 'dss-sectionHead' },
          h('h3', { className: 'dss-sectionTitle' }, t('cardsSection')),
          h('span', { className: 'dss-sectionMeta' }, held > 0 ? t('cardsHeld', { n: num(held) }) : t('cardsHeldNone')),
        ),
        tickets.length > 0 ? h('div', { className: 'dss-tickets', 'aria-hidden': true }, tickets) : null,
        h(
          'div',
          { className: 'dss-cardActions' },
          h(
            'button',
            { type: 'button', className: 'dss-btn', disabled: busy || !canClaim, onClick: claimCard, title: metaText },
            claimLabel,
          ),
          h('span', { className: 'dss-rowHint' }, metaText),
        ),
        h(
          'div',
          { className: 'dss-cardActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dss-btn dss-btnPrimary',
              disabled: busy || held < 1,
              onClick: () => redeemCard(target),
            },
            t('useCard'),
          ),
          both
            ? h(
                'div',
                { className: 'dss-seg', role: 'group', 'aria-label': t('useCard') },
                WINDOW_KEYS.map((key) =>
                  h(
                    'button',
                    {
                      key,
                      type: 'button',
                      className: 'dss-segBtn',
                      'aria-pressed': target === key,
                      onClick: () => setState({ windowChoice: key }),
                    },
                    shortWindowLabel(key),
                  ),
                ),
              )
            : null,
        ),
        h('div', { className: 'dss-rowHint' }, both ? t('useCardTarget', { window: windowLabel(target) }) : t('useCardHint')),
      )
    }

    // -------------------------------------------------------------------
    // Settings page: the only configuration surface (normal-flow content)
    // -------------------------------------------------------------------
    function ToggleRow({ label, hint, checked, disabled, onToggle }) {
      const hintNode = hint === null || hint === undefined ? null : h('span', { className: 'dss-toggleHint' }, hint)
      return h(
        'div',
        { className: 'dss-toggleRow' },
        h(
          'span',
          { className: 'dss-toggleText' },
          h('span', { className: 'dss-toggleLabel' }, label),
          hintNode,
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked,
            'aria-label': label,
            className: 'dss-switch' + (checked ? ' dss-switchOn' : ''),
            disabled,
            title: label,
            onClick: onToggle,
          },
          h('span', { className: 'dss-switchKnob', 'aria-hidden': true }),
        ),
      )
    }

    /**
     * Independent settings page registered on `settings.section`. Renders
     * normal-flow content only inside the settings shell's content column: no
     * fixed positioning, no backdrop/modal, no close button and no header
     * chrome of its own. Every configuration control lives here; the main
     * panel is status-only.
     */
    function SettingsPage() {
      const snap = useStore()
      useEffect(() => {
        void refresh()
      }, [])

      const snapshot = snap.snapshot
      const plan = snapshot === null || snapshot === undefined ? {} : snapshot.plan ?? {}
      const windows = snapshot === null || snapshot === undefined ? {} : snapshot.windows ?? {}
      const settings = snapshot === null || snapshot === undefined ? {} : snapshot.settings ?? {}
      const storage = snapshot === null || snapshot === undefined ? {} : snapshot.storage ?? {}
      const vendors = vendorList(snapshot)
      const outdated = snapshot !== null && snapshot !== undefined && vendors.length === 0
      const vendorId = activeVendorId(snapshot)
      const planCustom = plan.custom === true || plan.id === 'custom'
      const effectiveLimits = plan.limits ?? {}
      const currentH5 = typeof effectiveLimits.h5 === 'number' ? effectiveLimits.h5 : 0
      const currentD7 = typeof effectiveLimits.d7 === 'number' ? effectiveLimits.d7 : 0
      const planKey = [vendorId, plan.id ?? '', currentH5, currentD7].join(':')

      // Draft values for the custom-limit inputs, resynced whenever the
      // effective plan/limits change (including external changes from polling).
      const [h5Value, setH5Value] = useState(String(currentH5))
      const [d7Value, setD7Value] = useState(String(currentD7))
      const [limitError, setLimitError] = useState(null)
      const [confirmingReset, setConfirmingReset] = useState(false)

      useEffect(() => {
        setH5Value(String(currentH5))
        setD7Value(String(currentD7))
        setLimitError(null)
      }, [planKey])

      // The inline two-step confirmation resets itself after a short delay.
      useEffect(() => {
        if (!confirmingReset) return undefined
        const timer = window.setTimeout(() => setConfirmingReset(false), 5000)
        return () => window.clearTimeout(timer)
      }, [confirmingReset])

      const busy = snap.busy !== null
      const h5Enabled = windows.h5?.enabled === true
      const d7Enabled = windows.d7?.enabled === true
      const enforce = settings.enforce !== false
      const countAuxiliary = settings.countAuxiliary !== false
      const h5Number = parseLimit(h5Value)
      const d7Number = parseLimit(d7Value)
      const h5Dirty = h5Value.trim() !== String(currentH5)
      const d7Dirty = d7Value.trim() !== String(currentD7)
      const dirty = h5Dirty || d7Dirty
      const stateFile = typeof storage.stateFile === 'string' ? storage.stateFile : ''

      // Configuration mutations are owned by this page; the panel never calls
      // them, which keeps the main surface read-only.
      const setPlan = ({ vendor, planId }) => {
        void runActions([{ action: 'set-plan', payload: { vendor, planId } }], 'set-plan')
      }
      const setWindows = (windowKey, enabled) => {
        void runActions([{ action: 'set-windows', payload: { [windowKey]: enabled } }], 'set-windows')
      }
      const setSettings = (key, value) => {
        void runActions([{ action: 'set-settings', payload: { [key]: value } }], 'set-settings')
      }
      const setLimit = (actions) => runActions(actions, 'set-limit')
      const resetSimulation = () => {
        void runActions([{ action: 'reset-all' }], 'reset-all')
      }
      const saveLimits = () => {
        if (busy) return
        if ((h5Dirty && h5Number === null) || (d7Dirty && d7Number === null)) {
          setLimitError(t('invalidLimit'))
          return
        }
        const actions = []
        if (h5Dirty && h5Number !== null && h5Number !== currentH5) {
          actions.push({ action: 'set-limit', payload: { window: 'h5', tokens: h5Number } })
        }
        if (d7Dirty && d7Number !== null && d7Number !== currentD7) {
          actions.push({ action: 'set-limit', payload: { window: 'd7', tokens: d7Number } })
        }
        if (actions.length === 0) return
        setLimitError(null)
        void setLimit(actions)
      }

      const scopeError = (scope) => (snap.lastError !== null && snap.lastErrorScope === scope ? snap.lastError : null)
      const globalError = snap.lastError !== null && !SETTINGS_SCOPES.includes(snap.lastErrorScope) ? snap.lastError : null
      const planError = scopeError('set-plan')
      const windowError = scopeError('set-windows')
      const enforcementError = scopeError('set-settings')
      const limitHostError = scopeError('set-limit')
      const resetError = scopeError('reset-all')

      const head = h(
        'div',
        { className: 'dss-settingsHead' },
        h('h2', { className: 'dss-settingsTitle' }, t('settingsTitle')),
        h('p', { className: 'dss-settingsIntro' }, t('settingsIntro')),
      )

      if (snapshot === null) {
        return h(
          'div',
          { className: 'dss-settings', 'data-subscription-sim-surface': true },
          head,
          h('div', { className: 'dss-settingsLoading' }, t('settingsLoading')),
        )
      }

      return h(
        'div',
        { className: 'dss-settings', 'data-subscription-sim-surface': true },
        head,
        snap.offline ? h('div', { className: 'dss-inlineWarn', role: 'status' }, t('offline')) : null,
        outdated ? h('div', { className: 'dss-inlineWarn', role: 'status' }, t('hostMismatch')) : null,
        globalError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, globalError) : null,
        // 订阅方案 / Subscription plans: two vendor catalogs from the snapshot.
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('plansSection') },
          h('h3', { className: 'dss-settingsGroupTitle' }, t('plansSection')),
          h('p', { className: 'dss-settingsGroupHint' }, t('plansSectionHint')),
          outdated
            ? h(
                'div',
                { className: 'dss-planFallback' },
                h('span', { className: 'dss-settingsMeta' }, t('currentPlan')),
                h(
                  'div',
                  { className: 'dss-planRowMain' },
                  h('span', { className: 'dss-planName' }, localizedPlanName(plan)),
                  h('span', { className: 'dss-planPrice' }, planPriceText({ ...plan, custom: planCustom })),
                  h('span', { className: 'dss-planLimits' }, planLimitsText(plan)),
                ),
              )
            : h(
                'div',
                { className: 'dss-vendorCards' },
                vendors.map((vendor) => {
                  const vendorName = localizedName(vendor.name)
                  const vendorNote = localizedName(vendor.note)
                  const vendorPlans = Array.isArray(vendor.plans)
                    ? vendor.plans.filter((item) => item !== null && item !== undefined && typeof item.id === 'string')
                    : []
                  return h(
                    'div',
                    { key: vendor.id, className: 'dss-vendorCard', 'data-vendor-id': vendor.id },
                    h('div', { className: 'dss-vendorHead' }, h('span', { className: 'dss-vendorName' }, vendorName === '' ? vendor.id : vendorName)),
                    vendorNote === '' ? null : h('p', { className: 'dss-vendorNote' }, vendorNote),
                    h(
                      'div',
                      { className: 'dss-vendorPlans' },
                      vendorPlans.map((item) => {
                        const active = vendorId === vendor.id && plan.id === item.id
                        const label = vendorName === '' ? localizedPlanName(item) : vendorName + ' · ' + localizedPlanName(item)
                        return h(
                          'button',
                          {
                            key: item.id,
                            type: 'button',
                            className: 'dss-planRow' + (active ? ' dss-planActive' : ''),
                            'aria-pressed': active,
                            'aria-label': active ? t('currentPlan') : t('planSwitchAria', { plan: label }),
                            'data-vendor-id': vendor.id,
                            'data-plan-id': item.id,
                            disabled: busy || active,
                            title: active ? t('currentPlan') : t('planSwitchAria', { plan: label }),
                            onClick: () => setPlan({ vendor: vendor.id, planId: item.id }),
                          },
                          h(
                            'span',
                            { className: 'dss-planRowMain' },
                            h('span', { className: 'dss-planName' }, localizedPlanName(item)),
                            h('span', { className: 'dss-planPrice' }, planPriceText(item)),
                          ),
                          h('span', { className: 'dss-planLimits' }, planLimitsText(item)),
                          active ? h('span', { className: 'dss-planMark', 'aria-hidden': true }, checkIcon(14)) : null,
                        )
                      }),
                    ),
                  )
                }),
              ),
          planError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, planError) : null,
        ),
        // 额度窗口 / Quota windows (global for both vendors).
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('windowsSection') },
          h('h3', { className: 'dss-settingsGroupTitle' }, t('windowsSection')),
          h('p', { className: 'dss-settingsGroupHint' }, t('windowsSectionHint')),
          h(ToggleRow, {
            label: t('toggleH5'),
            hint: h5Enabled && !d7Enabled ? t('toggleWindowsHint') : null,
            checked: h5Enabled,
            disabled: busy || (h5Enabled && !d7Enabled),
            onToggle: () => setWindows('h5', !h5Enabled),
          }),
          h(ToggleRow, {
            label: t('toggleD7'),
            hint: d7Enabled && !h5Enabled ? t('toggleWindowsHint') : null,
            checked: d7Enabled,
            disabled: busy || (d7Enabled && !h5Enabled),
            onToggle: () => setWindows('d7', !d7Enabled),
          }),
          windowError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, windowError) : null,
        ),
        // 拦截设置 / Enforcement.
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('enforcementSection') },
          h('h3', { className: 'dss-settingsGroupTitle' }, t('enforcementSection')),
          h(ToggleRow, {
            label: t('toggleEnforce'),
            hint: t('toggleEnforceHint'),
            checked: enforce,
            disabled: busy,
            onToggle: () => setSettings('enforce', !enforce),
          }),
          h(ToggleRow, {
            label: t('toggleAux'),
            hint: t('toggleAuxHint'),
            checked: countAuxiliary,
            disabled: busy,
            onToggle: () => setSettings('countAuxiliary', !countAuxiliary),
          }),
          enforcementError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, enforcementError) : null,
        ),
        // 自定义额度 / Custom limits: host switches the plan to custom.
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('customLimitsSection') },
          h(
            'div',
            { className: 'dss-settingsGroupHead' },
            h('h3', { className: 'dss-settingsGroupTitle' }, t('customLimitsSection')),
            planCustom ? h('span', { className: 'dss-settingsBadge' }, t('customActive')) : null,
          ),
          h('p', { className: 'dss-settingsGroupHint' }, t('customLimitsHint')),
          h(
            'div',
            { className: 'dss-customInputs' },
            h(
              'label',
              { className: 'dss-field' },
              h('span', { className: 'dss-fieldLabel' }, t('limitH5')),
              h('input', {
                className: 'dss-input',
                type: 'number',
                min: 1,
                max: MAX_LIMIT,
                step: 1,
                inputMode: 'numeric',
                value: h5Value,
                disabled: busy,
                onChange: (event) => {
                  setH5Value(event.target.value)
                  setLimitError(null)
                },
              }),
            ),
            h(
              'label',
              { className: 'dss-field' },
              h('span', { className: 'dss-fieldLabel' }, t('limitD7')),
              h('input', {
                className: 'dss-input',
                type: 'number',
                min: 1,
                max: MAX_LIMIT,
                step: 1,
                inputMode: 'numeric',
                value: d7Value,
                disabled: busy,
                onChange: (event) => {
                  setD7Value(event.target.value)
                  setLimitError(null)
                },
              }),
            ),
          ),
          h(
            'div',
            { className: 'dss-settingsActions' },
            h(
              'button',
              { type: 'button', className: 'dss-settingsBtnPrimary', disabled: busy || !dirty, onClick: saveLimits },
              t('save'),
            ),
            limitError !== null ? h('span', { className: 'dss-errorText' }, limitError) : null,
          ),
          limitHostError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, limitHostError) : null,
        ),
        // 危险区域 / Danger zone: inline two-step confirmation, no browser confirm.
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('dangerSection') },
          h('h3', { className: 'dss-settingsGroupTitle' }, t('dangerSection')),
          h('p', { className: 'dss-settingsGroupHint' }, t('resetAllHint')),
          h(
            'div',
            { className: 'dss-settingsActions' },
            confirmingReset
              ? h(
                  Fragment,
                  null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dss-settingsBtnDanger',
                      disabled: busy,
                      onClick: () => {
                        setConfirmingReset(false)
                        resetSimulation()
                      },
                    },
                    t('confirmResetYes'),
                  ),
                  h('button', { type: 'button', className: 'dss-settingsBtn', onClick: () => setConfirmingReset(false) }, t('cancel')),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dss-settingsBtnDangerOutline',
                    disabled: busy,
                    onClick: () => setConfirmingReset(true),
                  },
                  t('resetAll'),
                ),
          ),
          resetError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, resetError) : null,
        ),
        // 存储 / Storage: state-file path and last save status.
        h(
          'section',
          { className: 'dss-settingsGroup', 'aria-label': t('storageSection') },
          h('h3', { className: 'dss-settingsGroupTitle' }, t('storageSection')),
          h('p', { className: 'dss-settingsGroupHint' }, t('storageHint')),
          stateFile !== ''
            ? h(
                'div',
                { className: 'dss-storageRow' },
                h('code', { className: 'dss-path', title: stateFile }, t('footerFile', { path: stateFile })),
              )
            : null,
          storage.ok === false
            ? h(
                'div',
                { className: 'dss-inlineError', role: 'alert' },
                t('storageError', {
                  message:
                    typeof storage.lastError === 'string' && storage.lastError !== '' ? storage.lastError : t('none'),
                }),
              )
            : h('div', { className: 'dss-settingsStatus' }, t('storageSaved')),
          snap.lastSyncedAt > 0
            ? h('div', { className: 'dss-settingsStatus' }, t('updated', { time: clockTime(snap.lastSyncedAt) }))
            : null,
        ),
      )
    }

    // -------------------------------------------------------------------
    // Panel: recent events
    // -------------------------------------------------------------------
    function EventsSection({ events }) {
      return h(
        'section',
        { className: 'dss-section' },
        h('div', { className: 'dss-sectionHead' }, h('h3', { className: 'dss-sectionTitle' }, t('eventsSection'))),
        events.length === 0
          ? h('div', { className: 'dss-empty' }, t('eventsEmpty'))
          : h(
              'ul',
              { className: 'dss-events' },
              events.map((event, index) =>
                h(
                  'li',
                  { key: index + ':' + (event?.at ?? 0), className: 'dss-event' },
                  h('span', { className: 'dss-dot' + eventDotClass(event), 'aria-hidden': true }),
                  h('span', { className: 'dss-eventLabel' }, eventText(event)),
                  h('span', { className: 'dss-eventTime', title: clockTime(event?.at) }, relativeTime(event?.at)),
                ),
              ),
            ),
      )
    }

    // -------------------------------------------------------------------
    // Panel: dialog
    // -------------------------------------------------------------------
    function Panel({ snap, snapshot }) {
      const panelRef = useRef(null)
      const closeRef = useRef(null)
      useEffect(() => {
        void refresh()
      }, [])

      // Move focus into the dialog when it opens.
      useEffect(() => {
        const node = closeRef.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') {
          try {
            node.focus({ preventScroll: true })
          } catch {
            try {
              node.focus()
            } catch {
              // focus is best-effort only
            }
          }
        }
      }, [])

      // Escape closes; Tab cycles inside the dialog while focus is there.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            closePanel()
            return
          }
          if (event.key !== 'Tab') return
          const node = panelRef.current
          if (node === null || node === undefined) return
          const focused = document.activeElement
          if (focused === null || focused === undefined || !node.contains(focused)) return
          const found = node.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          )
          const items = Array.prototype.slice.call(found)
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && (focused === first || focused === node)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && focused === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [])

      const busy = snap.busy !== null
      const storage = snapshot.storage ?? {}
      const plan = snapshot.plan ?? {}
      const planName = localizedPlanName(plan)
      const vendorName = planVendorName(snapshot)
      const priceText = planPriceText({ ...plan, custom: plan.id === 'custom' })
      const events = Array.isArray(snapshot.events) ? snapshot.events.slice(0, MAX_EVENTS) : []
      const stateFile = typeof storage.stateFile === 'string' ? storage.stateFile : ''

      return h(
        'aside',
        {
          ref: panelRef,
          className: 'dss-panel',
          role: 'dialog',
          'aria-labelledby': PANEL_TITLE_ID,
          'data-subscription-sim-surface': true,
        },
        h(
          'header',
          { className: 'dss-panelHeader' },
          h(
            'div',
            { className: 'dss-panelHeadRow' },
            h('h2', { className: 'dss-panelTitle', id: PANEL_TITLE_ID }, t('panelTitle')),
            h('span', { className: 'dss-badge', title: t('simBadgeHint') }, t('simBadge')),
            h(
              'div',
              { className: 'dss-panelActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dss-iconBtn',
                  title: t('refresh'),
                  'aria-label': t('refresh'),
                  disabled: busy,
                  onClick: () => {
                    void refresh()
                  },
                },
                refreshIcon(14),
              ),
              h(
                'button',
                {
                  ref: closeRef,
                  type: 'button',
                  className: 'dss-iconBtn',
                  title: t('close'),
                  'aria-label': t('closePanel'),
                  onClick: closePanel,
                },
                closeIcon(14),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dss-panelPlan' },
            h('span', { className: 'dss-planCaption' }, t('currentPlan')),
            vendorName !== ''
              ? h(
                  Fragment,
                  null,
                  h('span', { className: 'dss-planVendor' }, vendorName),
                  h('span', { className: 'dss-planSep', 'aria-hidden': true }, '·'),
                )
              : null,
            h('span', { className: 'dss-planName' }, planName),
            h('span', { className: 'dss-planPrice' }, priceText),
          ),
        ),
        h(
          'div',
          { className: 'dss-panelBody' },
          snap.offline ? h('div', { className: 'dss-inlineWarn' }, t('offline')) : null,
          snap.lastError !== null ? h('div', { className: 'dss-inlineError', role: 'alert' }, snap.lastError) : null,
          h(UsageSection, { snapshot }),
          h(CardsSection, { snap, snapshot }),
          h(EventsSection, { events }),
        ),
        h(
          'footer',
          { className: 'dss-panelFoot' },
          h('div', { className: 'dss-footLine dss-footHint' }, t('settingsHint')),
          h('div', { className: 'dss-footLine' }, t('footerSim')),
          stateFile !== ''
            ? h(
                'div',
                { className: 'dss-footLine' },
                h('code', { className: 'dss-path', title: stateFile }, t('footerFile', { path: stateFile })),
              )
            : null,
          storage.ok === false
            ? h(
                'div',
                { className: 'dss-footLine dss-errorText' },
                t('storageError', {
                  message:
                    typeof storage.lastError === 'string' && storage.lastError !== '' ? storage.lastError : t('none'),
                }),
              )
            : null,
          h('div', { className: 'dss-footLine' }, t('updated', { time: clockTime(snap.lastSyncedAt) })),
        ),
      )
    }

    // -------------------------------------------------------------------
    // Overlay: exhausted banner (frame-wide, bottom-center)
    // -------------------------------------------------------------------
    function ExhaustedBanner({ snap, snapshot }) {
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            dismissHit()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [])

      const windows = snapshot.windows ?? {}
      const blockedWindow =
        snapshot.blockedWindow === 'h5' || snapshot.blockedWindow === 'd7' ? snapshot.blockedWindow : null
      const hitWindow = lastHitWindow(snapshot)
      // Prefer the live blocking window; lastHit may point at a window that the
      // host already released while another enabled window is still exhausted.
      const displayWindow =
        hitWindow !== null && windows[hitWindow] !== null && windows[hitWindow] !== undefined && windows[hitWindow].exhausted === true
          ? hitWindow
          : blockedWindow ?? hitWindow
      const win = displayWindow === null ? null : windows[displayWindow] ?? null
      const held = cardCount(snapshot)
      const canClaim = snapshot.cards?.canClaim === true
      const busy = snap.busy !== null
      const target = displayWindow === null ? useCardTargetWindow(snapshot) : displayWindow
      const used = win !== null && typeof win.used === 'number' ? win.used : 0
      const limit = win !== null && typeof win.limit === 'number' ? win.limit : 0
      const releaseText =
        win !== null && typeof win.resetInMs === 'number'
          ? t('bannerAutoRelease', { duration: durationText(win.resetInMs) })
          : null
      return h(
        'div',
        {
          className: 'dss-banner',
          role: 'alert',
          'aria-live': 'assertive',
          'data-subscription-sim-surface': true,
        },
        h(
          'div',
          { className: 'dss-bannerTop' },
          h('span', { className: 'dss-bannerGlyph', 'aria-hidden': true }, alertIcon(18)),
          h(
            'div',
            { className: 'dss-bannerBody' },
            h('div', { className: 'dss-bannerTitle' }, t('bannerTitle')),
            win !== null
              ? h(
                  'div',
                  { className: 'dss-bannerText' },
                  t('bannerBlockedWindow', {
                    window: displayWindow === null ? t('none') : windowLabel(displayWindow),
                    used: num(used),
                    limit: num(limit),
                  }),
                )
              : null,
            releaseText !== null ? h('div', { className: 'dss-bannerSub' }, releaseText) : null,
            snap.offline ? h('div', { className: 'dss-bannerSub' }, t('offlineShort')) : null,
            snap.lastError !== null
              ? h('div', { className: 'dss-bannerSub dss-errorText', role: 'alert' }, snap.lastError)
              : null,
          ),
        ),
        h(
          'div',
          { className: 'dss-bannerActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dss-btn dss-btnPrimary',
              disabled: busy || held < 1,
              onClick: () => redeemCard(target),
            },
            t('bannerUseCard', { n: num(held) }),
          ),
          canClaim
            ? h('button', { type: 'button', className: 'dss-btn', disabled: busy, onClick: claimCard }, t('bannerClaim'))
            : null,
          h(
            'button',
            { type: 'button', className: 'dss-btn dss-btnGhost', disabled: busy, onClick: dismissHit },
            t('bannerLater'),
          ),
        ),
      )
    }

    // -------------------------------------------------------------------
    // Overlay host: renders whichever frame-level surface is active
    // -------------------------------------------------------------------
    function OverlayRoot() {
      const snap = useStore()
      useEffect(() => {
        void refresh()
      }, [])

      const snapshot = snap.snapshot
      if (snapshot === null) return null
      if (snap.open) return h(Panel, { snap, snapshot })
      // Defense in depth: the host can briefly retain lastHit after the window
      // self-released (or after a stale state file load). `blocked` is live
      // window math, so only show the frame-wide banner while it is true.
      if (snapshot.lastHit !== null && snapshot.lastHit !== undefined && snapshot.blocked === true) {
        return h(ExhaustedBanner, { snap, snapshot })
      }
      return null
    }

    // -------------------------------------------------------------------
    // Plugin entry
    // -------------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        t = ctx.locale.bind(NS)
        localeRuntime = ctx.locale

        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh: ZH,
              en: EN,
            }),
          'subscription-sim: dictionaries',
        )

        ctx.effect(
          () =>
            ctx.locale.subscribe(() => {
              setState({ localeRev: state.localeRev + 1 })
            }),
          'subscription-sim: locale refresh',
        )

        ctx.effect(() => injectStyles(), 'subscription-sim: styles')

        ctx.effect(() => {
          disposed = false
          const stop = startPolling()
          return () => {
            disposed = true
            stop()
            setState({ open: false, busy: null, windowChoice: null })
          }
        }, 'subscription-sim: polling')

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'subscription-sim',
              order: 3,
              label: () => t('sidebarLabel'),
            },
            SidebarChip,
          ),
        )

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'subscription-sim',
              order: 6,
              label: () => t('stripLabel'),
            },
            ComposerStrip,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'subscription-sim',
              order: 30,
              label: () => t('panelLabel'),
            },
            OverlayRoot,
          ),
        )

        // Independent settings page: the settings shell renders this inside its
        // content column and passes `{ close }`; the page renders normal-flow
        // content only and ignores the shell's close affordance.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'subscription-sim',
              order: 12,
              label: () => t('settingsLabel'),
            },
            SettingsPage,
          ),
        )
      },
    }
  },
})
