import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Optional host integration check, invoked explicitly with the installed
// upstream package path; no private configuration or existing memories read.
const root = process.env.DSH_TEST_MEMORY_PACKAGE
assert.ok(root, 'Set DSH_TEST_MEMORY_PACKAGE to the auto-memory package directory')
const source = readFileSync(path.join(root, 'lib/index.js'), 'utf8').replaceAll('\r\n', '\n')
const { applyAnchorsPre } = await import(pathToFileURL(path.join(root, 'lib/wb-sidecar.js')))
function method(name, args) {
  const start = source.indexOf('  async ' + name + '(')
  assert.ok(start >= 0, 'upstream method exists: ' + name)
  const bodyStart = source.indexOf('{', start)
  const end = source.indexOf('\n  }', bodyStart)
  const body = source.slice(bodyStart + 1, end)
  return new Function('path', 'readdir', 'existsSync', 'handoffStamp', 'nowHm', 'applyAnchorsPre',
    'return async function(' + args + ') {' + body + '\n}')(
    path, readdir, existsSync, () => '20261010-195500', () => '19:55', applyAnchorsPre)
}
const write = method('writeHandoffLedger', 'projectDir, content, opts')
const list = method('listHandoffLedgers', 'dir, limit = 12')
const search = method('searchHandoffCorpus', 'terms, limit, p')

for (const enabled of [false, true]) {
  test('explicit handoff write and search round-trip with generation enabled=' + enabled, async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), 'aitl-memory-recall-'))
    const engine = {
      config: { handoffEnabled: enabled, boardMode: 'off' },
      memToday: () => '2026-10-10',
      checkMutationPre: () => ({ ok: true }), // Gate behavior is outside this regression.
      wbWsKeyPre: () => projectDir,
      writeFullRaw: async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text) },
      writeSidecarEntryPre: async () => {},
      readTextSafe: async (file) => { try { return await readFile(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return ''; throw e } },
      listHandoffLedgers: list,
    }
    const content = '# Recall regression\n## 任务状态\nHANDOFF-ROUNDTRIP-1010 is pending verification.\n'
      + '## 目标\nFind the exact handoff marker through explicit recall.\n'
      + '## 已试方案与失败原因\nDisabled generation previously hid a successful explicit write.\n'
      + '## 进度与下一步\nRead the saved artifact without enabling generation.\n'
    assert.equal((await write.call(engine, projectDir, content)).ok, true)
    assert.equal((await write.call(engine, projectDir, content)).ok, true)
    const p = { projectDir, handoffDir: path.join(projectDir, 'handoff') }
    const hits = await search.call(engine, ['handoff-roundtrip-1010'], 8, p)
    assert.equal(hits.length, 2, 'including timestamp collision suffix')
    assert.ok(hits.every((hit) => hit.matches.some((line) => line.includes('HANDOFF-ROUNDTRIP-1010'))))
    assert.equal((await search.call(engine, ['absent-marker'], 8, p)).length, 0)
    assert.equal(engine.config.handoffEnabled, enabled, 'retrieval does not change generation policy')
  })
}

test('explicit all-scope retrieval and expansion contain no generation gate', () => {
  const recall = source.slice(source.indexOf('  async recall('), source.indexOf('  async expandMemoryRecordPre('))
  const expandStart = source.indexOf('  async expandMemoryRecordPre(')
  const expand = source.slice(expandStart, source.indexOf('\n  }', expandStart))
  assert.equal(recall.includes('handoffEnabled'), false)
  assert.equal(expand.includes('handoffEnabled'), false)
  assert.ok(source.includes("this.config.handoffEnabled === false) return { ok: true, skipped: 'handoff-disabled' }"),
    'automatic generation remains gated')
})
