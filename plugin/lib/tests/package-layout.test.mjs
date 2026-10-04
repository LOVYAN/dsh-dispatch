import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const json = file => JSON.parse(readFileSync(file, 'utf8'))

test('package targets the tested rc2 host and declares host-owned runtime peers', () => {
  const pkg = json(join(root, 'package.json'))
  assert.equal(pkg.engines.dsh, '0.2.0-rc.2')
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh'], pkg.engines.dsh)
  assert.equal(pkg.peerDependencies['@deepseek-ai/cordis'], '4.0.4')
  assert.equal(pkg.peerDependencies['@deepseek-ai/schemastery'], '3.18.4')
  assert.equal(pkg.dependencies, undefined)
})

test('root and plugin distributions preserve identical module trees and manifests', t => {
  const mirror = join(root, 'plugin')
  // A separately copied plugin distribution remains independently testable.
  if (!existsSync(join(mirror, 'package.json'))) return t.skip('Standalone plugin layout')
  assert.deepEqual(json(join(root, 'package.json')), json(join(mirror, 'package.json')))
  function compare(relative) {
    const entries = readdirSync(join(root, relative), { withFileTypes: true })
    assert.deepEqual(entries.map(e => e.name).sort(), readdirSync(join(mirror, relative)).sort())
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) compare(path)
      else assert.equal(readFileSync(join(root, path), 'utf8'), readFileSync(join(mirror, path), 'utf8'), path)
    }
  }
  compare('lib')
})
