import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ensureForeman, sayToForeman, handleBoundSessionUtterance, fetchDispatchHistory, waitUntilIdle } from '../src/foreman.js'

const cfg = { dispatchBase: 'https://dispatch.example.invalid', dispatchToken: 'fixture-only-not-a-secret' }
const page = (changes = {}) => ({ ok: true, sessionId: 's1', title: 'fixture', historyToken: 'cut +/=?', messages: [{ role: 'assistant', text: 'new' }], hasMore: false, ...changes })
function mock(t, replies) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    assert.equal(new URL(url).origin, cfg.dispatchBase, 'unexpected network destination')
    calls.push({ url: new URL(url), opts })
    assert.ok(replies.length, 'unexpected network call (real fetch is never used)')
    const next = replies.shift()
    if (next instanceof Error) throw next
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status || 200 })
  })
  return calls
}
function state(t) {
  const home = mkdtempSync(fileURLToPath(new URL('./tmp-', import.meta.url)))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return { ...cfg, foremanSessionId: '', foremanPath: join(home, 'foreman.json') }
}
for (const id of [undefined, null, '', '   ', 42, {}, []]) {
  test('ensureForeman rejects invalid session ID ' + JSON.stringify(id), async (t) => {
    const c = state(t)
    const calls = mock(t, [{ body: { ok: true, sessionId: id } }])
    await assert.rejects(ensureForeman(c, 'hello'), /no confirmed session admission/)
    assert.equal(c.foremanSessionId, '')
    assert.equal(existsSync(c.foremanPath), false)
    assert.equal(calls.length, 1)
  })
}
test('ensureForeman saves only admitted fresh ID and reuses it', async (t) => {
  const c = state(t)
  const calls = mock(t, [{ body: { ok: true, sessionId: 'fresh-isolated' } }])
  assert.equal(await ensureForeman(c, 'hello'), 'fresh-isolated')
  assert.equal(await ensureForeman(c, 'again'), 'fresh-isolated')
  assert.equal(JSON.parse(readFileSync(c.foremanPath)).sessionId, 'fresh-isolated')
  assert.equal(calls.length, 1)
})
test('HTTP partial create failure retains reconciliation metadata but never saves or retries', async (t) => {
  const c = state(t)
  const calls = mock(t, [{ status: 502, body: { ok: false, stage: 'prompt', sessionId: 'orphan' } }])
  await assert.rejects(ensureForeman(c, 'hello'), e => e.status === 502 && e.stage === 'prompt' && e.sessionId === 'orphan')
  assert.equal(existsSync(c.foremanPath), false)
  assert.equal(calls.length, 1)
})
test('transport uncertainty never auto-retries creation', async (t) => {
  const c = state(t)
  const calls = mock(t, [new Error('timeout after admission')])
  await assert.rejects(ensureForeman(c, 'hello'), /timeout/)
  assert.equal(calls.length, 1)
  assert.equal(existsSync(c.foremanPath), false)
})
test('continuation redirect means submission only', async (t) => {
  const calls = mock(t, [{ status: 303, body: '' }])
  assert.equal(await sayToForeman(cfg, 's1', 'hello'), undefined)
  assert.equal(calls[0].opts.redirect, 'manual')
})
test('HTTP prompt failure cannot return speech or a false completion', async (t) => {
  const calls = mock(t, [
    { body: '<div class="msg assistant"><div class="meta">助手</div>old completion</div>' },
    { status: 502, body: { ok: false } }
  ])
  await assert.rejects(handleBoundSessionUtterance(cfg, 's1', 'hello'), /prompt failed 502/)
  assert.equal(calls.length, 2, 'must not poll completion after failed admission')
})
test('opening page omits cursor/token; every older page carries same encoded token', async (t) => {
  const calls = mock(t, [
    { body: page({ hasMore: true, nextBeforeSeq: 10 }) },
    { body: page({ hasMore: true, nextBeforeSeq: 0, messages: [{ role: 'user', text: 'middle' }] }) },
    { body: page({ messages: [{ role: 'user', text: 'old' }] }) }
  ])
  const result = await fetchDispatchHistory(cfg, 's1')
  assert.equal(calls[0].url.searchParams.has('beforeSeq'), false)
  assert.equal(calls[0].url.searchParams.has('historyToken'), false)
  for (const c of calls.slice(1)) assert.equal(c.url.searchParams.get('historyToken'), 'cut +/=?')
  assert.equal(calls[2].url.searchParams.get('beforeSeq'), '0')
  assert.deepEqual(result.messages.map(m => m.text), ['old', 'middle', 'new'])
  assert.equal(result.truncated, false)
})
for (const cursor of [undefined, null, '', -1, '10', 1.5]) {
  test('hasMore with invalid or missing cursor fails closed ' + JSON.stringify(cursor), async (t) => {
    const calls = mock(t, [{ body: page({ hasMore: true, nextBeforeSeq: cursor }) }])
    await assert.rejects(fetchDispatchHistory(cfg, 's1'), /cursor/)
    assert.equal(calls.length, 1)
  })
}
for (const change of [{ historyToken: undefined }, { sessionId: 'other' }, { messages: {} }, { hasMore: undefined }]) {
  test('malformed history fails closed ' + Object.keys(change), async (t) => {
    mock(t, [{ body: page(change) }])
    await assert.rejects(fetchDispatchHistory(cfg, 's1'))
  })
}
for (const change of [{ historyToken: 'different' }, { hasMore: true, nextBeforeSeq: 10 }]) {
  test('subsequent token or cursor drift rejects', async (t) => {
    mock(t, [{ body: page({ hasMore: true, nextBeforeSeq: 10 }) }, { body: page(change) }])
    await assert.rejects(fetchDispatchHistory(cfg, 's1'), /historyToken|cursor/)
  })
}
test('history HTTP failure never becomes empty successful evidence', async (t) => {
  mock(t, [{ status: 503, body: { ok: true } }])
  await assert.rejects(fetchDispatchHistory(cfg, 's1'), /http 503/)
})
for (const statusFails of [true, false]) {
  test('unknown status or missing session never confirms stale HTML: ' + statusFails, async (t) => {
    let ticks = 0
    t.mock.method(Date, 'now', () => ++ticks < 3 ? 0 : 100)
    mock(t, [
      { body: '<div class="msg assistant"><div class="meta">助手</div>completed</div>' },
      statusFails ? { status: 503, body: {} } : { body: { pending: [], pendingQuestions: [] } },
      { body: { sessions: [] } }
    ])
    await assert.rejects(waitUntilIdle(cfg, 's1', { timeoutMs: 10, intervalMs: 0 }), /foreman timeout/)
  })
}
test('page cap exposes truncation with pinned continuation cursor', async (t) => {
  mock(t, [{ body: page({ hasMore: true, nextBeforeSeq: 10 }) }])
  const result = await fetchDispatchHistory(cfg, 's1', { maxPages: 1 })
  assert.equal(result.truncated, true)
  assert.equal(result.nextBeforeSeq, 10)
  assert.equal(result.historyToken, 'cut +/=?')
})
