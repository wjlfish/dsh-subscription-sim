/**
 * Pure formatting helpers for the subscription simulator.
 *
 * Everything here is deterministic and unit-testable without a Harness: no
 * node builtins, no I/O, no `Intl` (the blocked message is built by hand for
 * byte-stable output that survives any locale environment).
 */

/** Stable machine code carried by the terminal quota finish chunk. */
export const QUOTA_CODE = 'SUBSCRIPTION_QUOTA'

/** Localized window labels used by the user-facing blocked message. */
export const WINDOW_LABELS = Object.freeze({
  h5: Object.freeze({ zh: '5 小时', en: '5-hour' }),
  d7: Object.freeze({ zh: '7 天', en: '7-day' }),
})

/**
 * Thousands-grouped integer, e.g. `1500000` -> `1,500,000`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  const number = Number.isFinite(value) ? Math.round(value) : 0
  const negative = number < 0
  const digits = String(Math.abs(number))
  let grouped = ''
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ','
    grouped += digits[index]
  }
  return negative ? `-${grouped}` : grouped
}

/**
 * Compact token count, e.g. `1_234_567` -> `1.23M`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatTokens(value) {
  const number = Number.isFinite(value) ? Math.round(value) : 0
  const absolute = Math.abs(number)
  if (absolute >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (absolute >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`
  if (absolute >= 1_000) return `${(number / 1_000).toFixed(1)}K`
  return String(number)
}

/** Split a non-negative millisecond duration into whole units (1s resolution). */
function durationParts(ms) {
  const totalMs = Number.isFinite(ms) && ms > 0 ? ms : 0
  const totalSeconds = Math.max(1, Math.ceil(totalMs / 1000))
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
  }
}

/**
 * Chinese duration, e.g. `2 小时 13 分`.
 * @param {unknown} ms
 * @returns {string}
 */
export function formatDurationZh(ms) {
  const parts = durationParts(ms)
  if (parts.days > 0) {
    return parts.hours > 0 ? `${parts.days} 天 ${parts.hours} 小时` : `${parts.days} 天`
  }
  if (parts.hours > 0) {
    return parts.minutes > 0 ? `${parts.hours} 小时 ${parts.minutes} 分` : `${parts.hours} 小时`
  }
  if (parts.minutes > 0) {
    return parts.seconds > 0 && parts.minutes < 10 ? `${parts.minutes} 分 ${parts.seconds} 秒` : `${parts.minutes} 分`
  }
  return `${parts.seconds} 秒`
}

/**
 * English duration, e.g. `2h 13m`.
 * @param {unknown} ms
 * @returns {string}
 */
export function formatDurationEn(ms) {
  const parts = durationParts(ms)
  if (parts.days > 0) return parts.hours > 0 ? `${parts.days}d ${parts.hours}h` : `${parts.days}d`
  if (parts.hours > 0) return parts.minutes > 0 ? `${parts.hours}h ${parts.minutes}m` : `${parts.hours}h`
  if (parts.minutes > 0) return `${parts.minutes}m`
  return `${parts.seconds}s`
}

/**
 * Sanitize an optional bilingual label (e.g. `vendor · plan`) for the
 * user-facing blocked message. Returns null when no usable label is supplied.
 * @param {unknown} value
 * @returns {{ zh: string, en: string } | null}
 */
function planLabelPart(value) {
  if (value === null || typeof value !== 'object') return null
  const zh = typeof value.zh === 'string' && value.zh !== '' ? value.zh.slice(0, 80) : ''
  const en = typeof value.en === 'string' && value.en !== '' ? value.en.slice(0, 80) : ''
  if (zh === '' && en === '') return null
  return { zh: zh === '' ? en : zh, en: en === '' ? zh : en }
}

/**
 * Build the bilingual user-facing message carried by the terminal quota
 * failure. Kept under roughly 500 characters so it renders in a turn error.
 *
 * @param {object} input
 * @param {'h5'|'d7'} input.window which window is blamed
 * @param {number} input.used counted tokens in that window
 * @param {number} input.limit current effective limit of that window
 * @param {number|null} [input.resetInMs] automatic release countdown
 * @param {number} [input.cardsHeld] reset cards held
 * @param {boolean} [input.simulated] true for the one-shot diagnostic block
 * @param {{ zh: string, en: string }} [input.planLabel] active vendor · plan label
 * @returns {string} Chinese first line, English second line
 */
export function buildBlockedMessage(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const windowId = source.window === 'd7' ? 'd7' : 'h5'
  const labelZh = WINDOW_LABELS[windowId].zh
  const labelEn = WINDOW_LABELS[windowId].en
  const used = Number.isFinite(source.used) ? Math.max(0, Math.round(source.used)) : 0
  const limit = Number.isFinite(source.limit) ? Math.max(0, Math.round(source.limit)) : 0
  const cardsHeld = Number.isFinite(source.cardsHeld) ? Math.max(0, Math.round(source.cardsHeld)) : 0
  const usage = `${formatCount(used)} / ${formatCount(limit)} tokens`
  const cardsZh =
    cardsHeld > 0
      ? `你还有 ${cardsHeld} 张重置卡，打开侧边栏「订阅」面板即可使用。`
      : '暂无可用的重置卡，可在侧边栏「订阅」面板领取。'
  const cardsEn =
    cardsHeld > 0
      ? `Use a reset card in the Subscription panel to continue (${cardsHeld} held).`
      : 'No reset cards are held; claim one in the Subscription panel.'
  const resetInMs = Number.isFinite(source.resetInMs) ? Math.max(0, source.resetInMs) : null
  const releaseZh = resetInMs === null ? '' : `额度也会在 ${formatDurationZh(resetInMs)}后自动释放。`
  const releaseEn = resetInMs === null ? '' : ` The window recovers automatically in ${formatDurationEn(resetInMs)}.`
  // Optional active-plan context; output is byte-identical to v1 without it.
  const plan = planLabelPart(source.planLabel)
  const planZh = plan === null ? '' : `（套餐：${plan.zh}）`
  const planZhHint = plan === null ? '' : `；套餐：${plan.zh}`
  const planEn = plan === null ? '' : ` Plan: ${plan.en}.`

  if (source.simulated === true) {
    return (
      `订阅额度模拟器：本次请求被诊断性拦截一次（模拟额度耗尽${planZhHint}）。${labelZh}窗口 ${usage}。${cardsZh}\n` +
      `Subscription simulator: this request was blocked once by the diagnostic simulation.${planEn} ${labelEn} window: ${usage}. ${cardsEn}${releaseEn}`
    )
  }
  return (
    `订阅额度已用尽${planZh}：${labelZh}窗口 ${usage}。请求已被「订阅额度模拟器」拦截。${cardsZh}${releaseZh}\n` +
    `Subscription quota exhausted (${labelEn} window): ${usage}.${planEn} Model requests are blocked by the subscription simulator. ${cardsEn}${releaseEn}`
  )
}

/**
 * Human-readable plan price, e.g. `$20/mo`; free plans render `$0/mo`.
 * @param {unknown} priceUSD
 * @returns {string}
 */
export function formatPrice(priceUSD) {
  const price = Number.isFinite(priceUSD) ? Math.max(0, priceUSD) : 0
  const digits = Number.isInteger(price) ? String(price) : price.toFixed(2)
  return `$${digits}/mo`
}
