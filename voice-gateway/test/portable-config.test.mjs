import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, loadConfig } from '../src/config.js'

test('home defaults to the current user and accepts an explicit portable directory', t => {
  const previous = process.env.DSH_HOME
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
  delete process.env.DSH_HOME
  assert.equal(dshHome(), join(homedir(), '.dsh-home'))
  // Keep all writes in this checkout; never load the real user configuration.
  const home = mkdtempSync(fileURLToPath(new URL('./tmp-portable-', import.meta.url)))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'dsh-dispatch.json'), JSON.stringify({ token: 'synthetic-token' }))
  const defaults = loadConfig()
  assert.equal(defaults.home, home)
  assert.equal(defaults.dispatchToken, 'synthetic-token')
  assert.equal(defaults.dispatchBase, 'http://127.0.0.1:3080')
  assert.equal(defaults.port, 3091)
  assert.equal(defaults.volc.apiKey, '')
  const voice = JSON.parse(readFileSync(defaults.voicePath, 'utf8'))
  writeFileSync(defaults.voicePath, JSON.stringify({ ...voice, apiKey: 'synthetic-key', dispatchBase: 'https://dispatch.example.invalid/', gatewayPort: 4567 }))
  const configured = loadConfig()
  assert.equal(configured.dispatchBase, 'https://dispatch.example.invalid')
  assert.equal(configured.port, 4567)
  assert.equal(configured.volc.apiKey, 'synthetic-key')
})

test('voice synthesis failure never asserts a task was not submitted', () => {
  const source = readFileSync(new URL('../src/call.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /任务尚未派出/)
  assert.match(source, /电脑任务状态未判定，请核查原会话，不要重复提交/)
})
