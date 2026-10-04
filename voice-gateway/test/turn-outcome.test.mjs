import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyTurnOutcome } from '../src/turn-outcome.js'
import { waitForTurnOutcome, handleBoundSessionUtterance, waitUntilIdle } from '../src/foreman.js'
const cfg = { dispatchBase: 'https://dispatch.example.invalid', dispatchToken: 'fixture-only' }
const record = { sessionId: 's1', sourceSeq: 20, isError: false, result: 'partial synthetic reply' }
function network(t, records) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const path = new URL(url).pathname
    calls.push({ path, method: opts.method || 'GET' })
    let body
    if (path === '/dispatch/status') body = { pending: [], pendingQuestions: [] }
    else if (path === '/dispatch/sessions') body = { sessions: [{ sessionId: 's1', running: false }] }
    else if (path === '/dispatch/session-result/s1') {
      assert.ok(records.length, 'unexpected result poll')
      const next = records.shift()
      if (next instanceof Error) throw next
      body = { ok: true, sessionId: 's1', result: next }
    } else if (path === '/dispatch/chat/s1' && opts.method === 'POST') return new Response('', { status: 303 })
    else throw new Error('unexpected mocked URL')
    return Response.json(body)
  })
  return calls
}
for (const text of ['任务受阻，缺少权限。', '只完成一部分，剩余未执行。', '执行失败。', 'All done.']) {
  test('normal terminal reply never proves semantic success: ' + text, () => {
    const result = classifyTurnOutcome({ ...record, result: text }, { sessionId: 's1', previousSourceSeq: 10 })
    assert.equal(result.outcome, 'reply')
    assert.match(result.notice, /尚不能据此确认/)
    assert.doesNotMatch(result.notice, /^任务完成/)
  })
}
for (const patch of [null, { sourceSeq: 10 }, { sourceSeq: 9 }, { sourceSeq: undefined }, { sourceSeq: '20' }, { isError: undefined }, { isError: 'false' }, { sessionId: 'other' }, { result: '' }]) {
  test('malformed/stale result stays unknown: ' + JSON.stringify(patch), () => {
    assert.equal(classifyTurnOutcome(patch === null ? null : { ...record, ...patch }, { sessionId: 's1', previousSourceSeq: 10 }).outcome, 'unknown')
  })
}
for (const kind of ['error', 'blocked', 'cancelled', 'aborted']) {
  test('persisted terminal failure does not need changed assistant HTML: ' + kind, async t => {
    network(t, [{ ...record, isError: true, result: '任务未完成：' + kind }])
    const result = await waitForTurnOutcome(cfg, 's1', { previousSourceSeq: 10 })
    assert.equal(result.outcome, 'error')
    assert.match(result.notice, /未正常完成/)
    assert.match(result.raw, new RegExp(kind))
  })
}
test('missing baseline stays uncertain even with a later-looking reply', () => {
  assert.equal(classifyTurnOutcome(record, { sessionId: 's1' }).outcome, 'unknown')
})
for (const next of [null, record, new Error('offline transport failure')]) {
  test('continuation preserves unknown baseline and submits once: ' + String(next), async t => {
    const calls = network(t, [null, next])
    const result = await handleBoundSessionUtterance(cfg, 's1', 'synthetic fixture')
    assert.equal(result.outcome, 'unknown')
    assert.equal(result.raw, '')
    assert.equal(calls.filter(x => x.method === 'POST').length, 1)
  })
}
test('newer persisted outcome replaces stale HTML completion heuristic', async t => {
  const calls = network(t, [{ ...record, sourceSeq: 10 }, record])
  const result = await handleBoundSessionUtterance(cfg, 's1', 'synthetic fixture')
  assert.equal(result.outcome, 'reply')
  assert.equal(result.sourceSeq, 20)
  assert.equal(calls.filter(x => x.path === '/dispatch/chat/s1' && x.method === 'GET').length, 0)
})
test('legacy idle heuristic demonstrably accepts a changed partial/error reply', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    const path = new URL(url).pathname
    if (path === '/dispatch/chat/s1') return new Response('<div class="msg assistant"><div class="meta">助手</div>Blocked: only partial work performed</div>')
    if (path === '/dispatch/status') return Response.json({ pending: [], pendingQuestions: [] })
    if (path === '/dispatch/sessions') return Response.json({ sessions: [{ sessionId: 's1', running: false }] })
    throw new Error('unexpected mocked URL')
  })
  const result = await waitUntilIdle(cfg, 's1', { previousText: 'old answer' })
  assert.match(result.text, /Blocked/)
})
test('call never converts fulfilled observation promise into task success', () => {
  const source = readFileSync(new URL('../src/call.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /const notice = '任务完成了/)
  assert.match(source, /taskSuccess: 'unknown'/)
  assert.match(source, /const notice = result.notice/)
})
