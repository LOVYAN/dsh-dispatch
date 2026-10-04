import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskOperation, submitTaskOperation } from '../src/task-operation.js'
import { dispatchIndependentTask } from '../src/foreman.js'
const cfg = { dispatchBase: 'https://dispatch.example.invalid', dispatchToken: 'fixture' }

test('logical operation ID is valid, immutable and distinct from another operation', () => {
  const a = createTaskOperation('same'), b = createTaskOperation('same')
  assert.match(a.requestId, /^[A-Za-z0-9_-]{8,128}$/)
  assert.notEqual(a.requestId, b.requestId)
  assert.equal(Object.isFrozen(a), true)
})
test('timeout never auto-repeats; explicit retry reuses entire original payload', async t => {
  const sent = [], timeouts = []
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return new AbortController().signal })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, cfg.dispatchBase + '/dispatch/task')
    sent.push(options.body)
    if (sent.length === 1) throw new Error('timeout after possible admission')
    return new Response(JSON.stringify({ ok: true, sessionId: 'dedup-session' }))
  })
  let uncertain
  try { await dispatchIndependentTask(cfg, 'do work') } catch (error) { uncertain = error }
  assert.equal(sent.length, 1)
  assert.equal(uncertain.uncertain, true)
  assert.equal(uncertain.requestId, uncertain.operation.requestId)
  const result = await submitTaskOperation(cfg, uncertain.operation)
  assert.equal(result.sessionId, 'dedup-session')
  assert.equal(sent[0], sent[1])
  assert.deepEqual(timeouts, [135000, 135000])
})
test('reserved409 preserves exact dispatch error code and original request without retry', async t => {
  const op = createTaskOperation('reserved task')
  const sent = []
  const code = 'submission-outcome-uncertain-do-not-retry'
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, cfg.dispatchBase + '/dispatch/task')
    sent.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ ok: false, error: code, sessionId: 'reserved-session', stage: 'prompt' }), { status: 409 })
  })
  await assert.rejects(submitTaskOperation(cfg, op), error => {
    assert.equal(error.code, code)
    assert.equal(error.uncertain, true)
    assert.equal(error.doNotRetry, true)
    assert.equal(error.operation, op)
    assert.equal(error.requestId, op.requestId)
    assert.equal(error.sessionId, 'reserved-session')
    assert.equal(error.stage, 'prompt')
    return true
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].requestId, op.requestId)
})
test('409 conflicts stop without retry or false success', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response(JSON.stringify({ ok: false }), { status: 409 }) })
  const op = createTaskOperation('original')
  await assert.rejects(submitTaskOperation(cfg, op), e => e.status === 409 && e.operation === op && e.uncertain && e.doNotRetry && /不要重试/.test(e.message))
  assert.equal(count, 1)
})
