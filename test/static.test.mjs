// Static / packaging checks for dsh-subscription-sim.
//
// These run without the running Harness and without importing host code with side
// effects: they validate package metadata, ESM syntax, import boundaries, locale
// files and the icon according to CONTRACT.md sections 6-7.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const pkgPath = join(PKG, 'package.json')

function read(rel) {
  return readFileSync(join(PKG, rel), 'utf8')
}

function assertNodeCheck(rel) {
  assert.ok(existsSync(join(PKG, rel)), `${rel} must exist`)
  const result = spawnSync(process.execPath, ['--check', join(PKG, rel)], { encoding: 'utf8' })
  assert.equal(result.status, 0, `node --check ${rel} failed:\n${result.stderr || result.stdout}`)
}

/** Strip comments so JSDoc `import('pkg').Type` annotations are not mistaken for imports. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1')
}

function importSpecifiers(source) {
  const code = stripComments(source)
  const specs = []
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*export\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specs.push(match[1])
  }
  return specs
}

/** Lightweight, dependency-free XML well-formedness check for the icon. */
function xmlWellFormed(text, label) {
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '')
  const betweenIsBlank = (fragment) =>
    fragment
      .replace(/<!DOCTYPE[\s\S]*?>/g, '')
      .replace(/<\?[\s\S]*?\?>/g, '')
      .trim()
  const tagPattern = /<(\/?)([A-Za-z_][A-Za-z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g
  const stack = []
  let roots = 0
  let index = 0
  let match
  while ((match = tagPattern.exec(stripped)) !== null) {
    const between = stripped.slice(index, match.index)
    assert.equal(betweenIsBlank(between), '', `${label}: unexpected text before ${match[0]}`)
    if (stack.length === 0) roots += 1
    index = tagPattern.lastIndex
    const [, closing, name, , selfClosing] = match
    if (closing) {
      assert.ok(stack.length > 0, `${label}: closing </${name}> without opener`)
      assert.equal(stack.pop(), name, `${label}: mismatched closing tag </${name}>`)
    } else if (!selfClosing) {
      stack.push(name)
    }
  }
  assert.equal(betweenIsBlank(stripped.slice(index)), '', `${label}: trailing text after root element`)
  assert.equal(stack.length, 0, `${label}: unclosed tags: ${stack.join(', ') || '(none)'}`)
  assert.equal(roots, 1, `${label}: expected exactly one root element, found ${roots}`)
}

test('package.json metadata', () => {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.name, '@local/dsh-subscription-sim')
  assert.equal(pkg.type, 'module', 'host + client are plain ESM; package must be type=module')
  assert.equal(pkg.private, true)
  assert.equal(typeof pkg.version, 'string')
  assert.equal(typeof pkg.description, 'string')
  assert.ok(pkg.description.length > 20)

  assert.equal(pkg.exports['.'], './index.js', 'exports["."] must point at the host entry')
  assert.equal(pkg.exports['./client'], './client.js', 'exports["./client"] must point at the client entry')
  assert.equal(pkg.exports['./icon'], './icon.svg')

  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(pkg.files.includes(entry), `files[] must ship ${entry}`)
  }
  assert.ok(pkg.files.includes('lib/*.js'), 'files[] must ship lib/*.js')
  assert.ok(pkg.files.includes('locale/*.json'), 'files[] must ship locale/*.json')

  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch must point at the patch file')
  assert.equal(pkg.dsh?.client?.platform, 'web', 'client half is a web plugin')
  assert.equal(pkg.dsh?.client?.immediately, true)
  assert.ok(Array.isArray(pkg.dsh?.client?.inject))
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'),
    'CONTRACT section 13: the client must inject the settings package that owns settings.section',
  )
})

test('host files are valid ESM (node --check)', () => {
  assertNodeCheck('index.js')
  assertNodeCheck('client.js')
  const libDir = join(PKG, 'lib')
  assert.ok(existsSync(libDir), 'lib/ directory must exist')
  const libFiles = readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()
  assert.deepEqual(libFiles, ['engine.js', 'format.js', 'plans.js'], 'lib/ must contain exactly engine.js, format.js, plans.js')
  for (const name of libFiles) assertNodeCheck(join('lib', name))
})

test('host half does not import Harness packages', () => {
  const hostFiles = ['index.js', ...readdirSync(join(PKG, 'lib')).filter((n) => n.endsWith('.js')).map((n) => join('lib', n))]
  for (const rel of hostFiles) {
    const specs = importSpecifiers(read(rel))
    for (const spec of specs) {
      assert.ok(
        !spec.startsWith('@deepseek-ai/'),
        `${rel} must not import Harness client/host packages (found "${spec}"); host half only touches ctx`,
      )
    }
  }
})

test('index.js exports name/inject/apply', async () => {
  const source = read('index.js')
  assert.match(source, /export\s+const\s+name\s*=/, 'index.js must export a name constant')
  assert.match(source, /export\s+const\s+inject\s*=/, 'index.js must export an inject list')
  assert.match(source, /export\s+(?:async\s+)?function\s+apply\s*\(/, 'index.js must export apply(ctx, config)')

  const mod = await import(new URL('../index.js', import.meta.url))
  assert.equal(typeof mod.name, 'string')
  assert.equal(mod.name, 'subscription-sim', 'plugin name should be the short plugin id')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject must be an array')
  for (const service of ['tools', 'webServer', 'connection', 'llm', 'agentDefaultModel']) {
    assert.ok(mod.inject.includes(service), `inject must include "${service}" (CONTRACT section 6)`)
  }
})

test('client.js is a plain web module (react-only) with all four v2 slots', () => {
  const source = read('client.js')
  const specs = importSpecifiers(source)
  assert.deepEqual([...new Set(specs)].sort(), ['react'], 'client.js may only require "react" (CONTRACT section 7)')
  assert.match(source, /window\.__ModuleLoader__\.load\s*\(/, 'client must register through window.__ModuleLoader__.load')
  assert.match(source, /['"]@local\/dsh-subscription-sim['"]/, 'client module id must be @local/dsh-subscription-sim')
  for (const slot of [
    'sidebar.footer.action',
    'conversation.composer.dock',
    'shell.overlay',
    'settings.section',
  ]) {
    assert.ok(source.includes(`'${slot}'`) || source.includes(`"${slot}"`), `client must register slot ${slot}`)
  }
  assert.ok(source.includes("'subscription-sim'") || source.includes('"subscription-sim"'), 'client must use the subscription-sim locale namespace')
  assert.match(source, /locale\.register\(/, 'client must register its locale dictionary')
  assert.match(source, /inject:\s*\[[^\]]*'slots'[^\]]*\]/, 'client plugin must inject the slots service')
  assert.match(source, /inject:\s*\[[^\]]*'locale'[^\]]*\]/, 'client plugin must inject the locale service')
  assert.match(source, /locale\.subscribe\(/, 'client must re-render when the locale changes')
  assert.ok(source.includes('dss-'), 'client styles must use the dss- class prefix')
  assert.ok(source.includes('/subscription-sim/api'), 'client must POST to /subscription-sim/api')
  assert.ok(source.includes('useSyncExternalStore'), 'client store should use useSyncExternalStore (CONTRACT section 7)')
})

test('locale files are valid JSON with meta title/description', () => {
  for (const lang of ['zh', 'en']) {
    const data = JSON.parse(read(`locale/${lang}.json`))
    assert.equal(typeof data.meta?.title, 'string', `locale/${lang}.json meta.title`)
    assert.equal(typeof data.meta?.description, 'string', `locale/${lang}.json meta.description`)
    assert.ok(data.meta.title.trim().length > 0)
    assert.ok(data.meta.description.trim().length > 20)
  }
  const zh = JSON.parse(read('locale/zh.json'))
  assert.match(zh.meta.title, /[\u4e00-\u9fff]/, 'zh title must contain Chinese text')
})

test('icon.svg is a single well-formed svg root', () => {
  const svg = read('icon.svg')
  xmlWellFormed(svg, 'icon.svg')
  const root = svg.match(/<svg\b([^>]*)>/)
  assert.ok(root, 'icon.svg must have an <svg> root')
  assert.match(root[1], /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/, 'svg must declare the SVG namespace')
  assert.match(root[1], /viewBox\s*=\s*["'][^"']+["']/, 'svg must declare a viewBox')
})

test('cordis.patch.yml inserts the plugin row with normalized v2 config', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^-\s*insert:\s*$/m, 'patch must be a top-level insert list')
  assert.match(patch, /id:\s*subscription-sim/m, 'patch row id must be subscription-sim')
  assert.match(patch, /name:\s*['"]@local\/dsh-subscription-sim['"]/m, 'patch row name must match package name')
  assert.match(patch, /plan:\s*max20x/m, 'default config plan must be max20x (cannot lock the operator out)')
  assert.match(patch, /vendor:\s*claude/m, 'CONTRACT section 10: the default vendor is claude')
  assert.match(patch, /h5:\s*true/m)
  assert.match(patch, /d7:\s*true/m)
  assert.match(patch, /enforce:\s*true/m)
})

test('client v2 does not rely on the removed top-level snapshot.plans field', () => {
  const source = read('client.js')
  assert.ok(!/\bsnapshot\.plans\b/.test(source), 'client must use snapshot.vendors (CONTRACT section 13)')
  assert.ok(/vendor\.plans/.test(source), 'vendor catalogs come from snapshot.vendors[].plans')
})
