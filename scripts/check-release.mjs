import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../lib/version.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.version, VERSION)
assert.equal(pkg.publishConfig.access, 'public')
assert.deepEqual(pkg.dependencies, {})
assert.match(read('CHANGELOG.md'), new RegExp(`^## v${VERSION.replaceAll('.', '\\.')}\\b`, 'm'))
assert.match(read('README.md'), new RegExp(`\\b${VERSION.replaceAll('.', '\\.')}\\b`))

const defaults = read('cordis.patch.yml')
const enabled = [...defaults.matchAll(/^\s+enabled:\s*(\S+)/gm)].map((m) => m[1])
assert.equal(enabled.length, 10, 'Review every published capability switch')
assert.ok(enabled.every((v) => v === 'false'), 'Published capabilities must stay disabled')
assert.match(defaults, /^\s+allTools:\s*false\b/m)
assert.match(defaults, /^\s+allowNonLoopback:\s*false\b/m)

const cache = mkdtempSync(join(tmpdir(), 'aitl-release-cache-'))
try {
  const output = execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [archive] = JSON.parse(output)
  assert.equal(archive.version, VERSION)
  const paths = archive.files.map((f) => f.path)
  const required = ['package.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'SKILL.md',
    'lib/index.js', 'lib/mcp.js', 'lib/version.js', 'lib/client.bundled.js']
  for (const path of required) assert.ok(paths.includes(path), `Missing ${path}`)
  for (const path of paths) {
    assert.ok(/^(lib\/[a-z0-9.-]+\.js|package\.json|cordis\.patch\.yml|README\.md|CHANGELOG\.md|LICENSE|SKILL\.md)$/.test(path), `Unexpected package file: ${path}`)
  }
  assert.equal(archive.bundled.length, 0, 'No bundled dependencies')
  process.stdout.write(`Release ${VERSION}: defaults disabled; ${paths.length} intended files; ${archive.size} packed bytes.\n`)
} finally {
  rmSync(cache, { recursive: true, force: true })
}
