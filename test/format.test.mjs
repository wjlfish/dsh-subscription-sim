// Unit tests for lib/format.js against CONTRACT.md section 5.
// The blocked message is user-facing: it must be bilingual, name the window, show
// used/limit, the reset ETA and the held cards, and stay short enough for a turn error.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as format from '../lib/format.js'
import * as plans from '../lib/plans.js'

const HOUR = 3_600_000
const MINUTE = 60_000
const ETA = 2 * HOUR + 13 * MINUTE

test('QUOTA_CODE is the stable machine code carried by the finish chunk', () => {
  assert.equal(format.QUOTA_CODE, 'SUBSCRIPTION_QUOTA')
})

test('WINDOW_LABELS carries both languages for both windows', () => {
  assert.deepEqual(format.WINDOW_LABELS.h5, { zh: '5 小时', en: '5-hour' })
  assert.deepEqual(format.WINDOW_LABELS.d7, { zh: '7 天', en: '7-day' })
})

test('formatCount groups thousands by hand (no Intl)', () => {
  assert.equal(format.formatCount(0), '0')
  assert.equal(format.formatCount(999), '999')
  assert.equal(format.formatCount(1_000), '1,000')
  assert.equal(format.formatCount(200_000), '200,000')
  assert.equal(format.formatCount(1_500_000), '1,500,000')
  assert.equal(format.formatCount(160_000_000), '160,000,000')
  assert.equal(format.formatCount(2_000_000_000), '2,000,000,000')
  assert.equal(format.formatCount(-1_234), '-1,234')
  assert.equal(format.formatCount(Number.NaN), '0')
  assert.equal(format.formatCount('nope'), '0')
})

test('formatTokens renders compact counts and is re-exported by plans.js', () => {
  assert.equal(format.formatTokens(0), '0')
  assert.equal(format.formatTokens(1_500), '1.5K')
  assert.equal(format.formatTokens(1_500_000), '1.50M')
  assert.equal(format.formatTokens(160_000_000), '160.00M')
  assert.equal(format.formatTokens(1_000_000_000), '1.00B')
  assert.equal(plans.formatTokens, format.formatTokens, 'plans.js must re-export the same formatter')
})

test('formatDurationZh renders readable Chinese durations', () => {
  assert.equal(format.formatDurationZh(ETA), '2 小时 13 分')
  assert.equal(format.formatDurationZh(2 * HOUR), '2 小时')
  assert.equal(format.formatDurationZh(45 * MINUTE), '45 分')
  assert.equal(format.formatDurationZh(3 * 24 * HOUR), '3 天')
  assert.equal(format.formatDurationZh(5 * 24 * HOUR + 6 * HOUR), '5 天 6 小时')
  assert.equal(format.formatDurationZh(0).endsWith('秒'), true, 'a zero duration still renders')
  assert.equal(format.formatDurationZh(Number.NaN).endsWith('秒'), true)
})

test('formatDurationEn renders readable English durations', () => {
  assert.equal(format.formatDurationEn(ETA), '2h 13m')
  assert.equal(format.formatDurationEn(2 * HOUR), '2h')
  assert.equal(format.formatDurationEn(45 * MINUTE), '45m')
  assert.equal(format.formatDurationEn(3 * 24 * HOUR), '3d')
  assert.equal(format.formatDurationEn(5 * 24 * HOUR + 6 * HOUR), '5d 6h')
  assert.equal(format.formatDurationEn(30_000), '30s')
})

test('buildBlockedMessage is bilingual and carries every required fact (h5)', () => {
  const message = format.buildBlockedMessage({
    window: 'h5',
    used: 1_500_000,
    limit: 1_500_000,
    resetInMs: ETA,
    cardsHeld: 2,
  })
  // Chinese line: window label, used/limit, held cards, auto-release ETA.
  assert.ok(message.includes('订阅额度已用尽'), 'zh exhaustion headline')
  assert.ok(message.includes('5 小时窗口'), 'zh window label')
  assert.ok(message.includes('1,500,000 / 1,500,000 tokens'), 'zh used/limit')
  assert.ok(message.includes('「订阅额度模拟器」'), 'zh simulator attribution')
  assert.ok(message.includes('2 张重置卡'), 'zh held card count')
  assert.ok(message.includes('2 小时 13 分后自动释放'), 'zh reset ETA')
  // English line: every matching fact.
  assert.ok(message.includes('\n'), 'message has a Chinese and an English line')
  assert.ok(message.includes('Subscription quota exhausted'), 'en exhaustion headline')
  assert.ok(message.includes('(5-hour window)'), 'en window label')
  assert.ok(message.includes('1,500,000 / 1,500,000 tokens'), 'en used/limit')
  assert.ok(message.includes('reset card'), 'en reset-card hint')
  assert.ok(message.includes('(2 held)'), 'en held card count')
  assert.ok(message.includes('2h 13m'), 'en reset ETA')
  // CONTRACT section 5: keep it under roughly 500 characters.
  assert.ok(message.length < 500, `blocked message must stay short, got ${message.length} chars`)
})

test('buildBlockedMessage names the 7-day window', () => {
  const message = format.buildBlockedMessage({
    window: 'd7',
    used: 12_000_000,
    limit: 12_000_000,
    resetInMs: 3 * 24 * HOUR,
    cardsHeld: 1,
  })
  assert.ok(message.includes('7 天窗口'))
  assert.ok(message.includes('(7-day window)'))
  assert.ok(message.includes('12,000,000 / 12,000,000 tokens'))
  assert.ok(message.includes('1 张重置卡'))
  assert.ok(message.includes('3 天后自动释放'))
})

test('buildBlockedMessage handles an empty card inventory and a missing ETA', () => {
  const message = format.buildBlockedMessage({ window: 'h5', used: 10, limit: 10, resetInMs: null, cardsHeld: 0 })
  assert.ok(message.includes('暂无可用的重置卡'))
  assert.ok(message.includes('No reset cards are held'))
  assert.ok(!message.includes('自动释放'), 'no auto-release sentence without a deadline')
  assert.ok(!message.includes('recovers automatically'))
})

test('buildBlockedMessage renders the diagnostic simulation variant distinctly', () => {
  const simulated = format.buildBlockedMessage({
    window: 'h5',
    used: 0,
    limit: 18_000_000,
    cardsHeld: 2,
    simulated: true,
  })
  assert.ok(simulated.includes('诊断性拦截'))
  assert.ok(simulated.includes('diagnostic simulation'))
  assert.ok(!simulated.includes('订阅额度已用尽'), 'the simulated block is not a real exhaustion')
  assert.ok(/0 \/ 18,000,000 tokens/.test(simulated))
})

test('buildBlockedMessage is deterministic and never throws on malformed input', () => {
  const input = { window: 'h5', used: 1, limit: 2, resetInMs: 1000, cardsHeld: 0 }
  assert.equal(format.buildBlockedMessage(input), format.buildBlockedMessage(input))
  assert.equal(typeof format.buildBlockedMessage(), 'string')
  assert.equal(typeof format.buildBlockedMessage({ window: 'bogus', used: 'x', limit: null }), 'string')
})

test('formatPrice renders the documented monthly price suffix', () => {
  assert.equal(format.formatPrice(0), '$0/mo')
  assert.equal(format.formatPrice(20), '$20/mo')
  assert.equal(format.formatPrice(200), '$200/mo')
  assert.equal(format.formatPrice(20.5), '$20.50/mo')
  assert.equal(format.formatPrice(Number.NaN), '$0/mo')
})
