import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHistory, foldHistory } from './index.mjs'
const text = text => ({ type: 'text', text })
const user = (seq, value, extra = {}) => ({ type: 'user/message', seq, time: seq * 100, surfaceOp: 'append', data: { id: `u${seq}`, role: 'user', source: { kind: 'user' }, content: [text(value)] }, ...extra })
const assistant = (seq, value, extra = {}) => ({ type: 'assistant/message', seq, time: seq * 100, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', source: { kind: 'model' }, content: [text(value)] }, stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [0, 2], texts: ['duplicate ', 'stream'] }] }, ...extra })
function freeze(x) { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(freeze) }; return x }

test('raw and record events, reversed pages, overlap, stable identity', () => {
  const u = user(4, 'hello'), a = assistant(9, 'world')
  const result = normalizeHistory([a, { type: 'event', event: u }, { ...u, data: { ...u.data } }])
  assert.deepEqual(result.messages.map(m => [m.seq, m.role, m.text]), [[4, 'user', 'hello'], [9, 'assistant', 'world']])
  assert.equal(result.complete, true)
  assert.equal(result.messages[1].messageId, 'a9')
})
test('durable assembled content wins; compact stream never duplicates or leaks reasoning', () => {
  const a = assistant(2, 'answer')
  a.data.stream.push({ type: 'reasoning-chunks', time0: 1, index: 1, dt: [0], texts: ['secret'] })
  a.data.message.content.push({ type: 'reasoning', text: 'private' }, { type: 'tool-call', arguments: 'private' })
  assert.equal(foldHistory([a])[0].text, 'answer')
})
test('attempts, even with visible compact text, are not committed replies', () => {
  assert.deepEqual(foldHistory([{ type: 'assistant/attempt', seq: 3, data: { stream: assistant(1, '').data.stream } }]), [])
})
test('missing assembled message never falls back to compact stream', () => {
  const a = assistant(2, 'x'); delete a.data.message
  const result = normalizeHistory([a]); assert.equal(result.messages.length, 0)
  assert.equal(result.complete, false)
})
test('replacement copies are model-only; originals remain visible even across page boundaries', () => {
  const replacement = user(15, 'compacted', { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 8 }, sourceEventSeqs: [2, 8] })
  assert.deepEqual(foldHistory([user(2, 'original'), assistant(8, 'reply'), replacement]).map(m => m.text), ['original', 'reply'])
  assert.deepEqual(foldHistory([replacement]), [])
})
test('unknown or absent surfaceOp fails closed by default', () => {
  const missing = user(1, 'x'); delete missing.surfaceOp
  for (const ev of [missing, user(2, 'y', { surfaceOp: { op: 'future' } })]) {
    const result = normalizeHistory([ev]); assert.equal(result.complete, false); assert.equal(result.messages.length, 0)
  }
})
test('explicit legacy mode supports old wrappers and missing sequences only', () => {
  const ev = { type: 'user/message', data: { message: { content: [text('old')] } } }
  assert.equal(foldHistory([{ event: ev }], { legacy: true })[0].text, 'old')
  assert.equal(foldHistory([ev]).length, 0)
  assert.equal(foldHistory([ev, user(1, 'new')], { legacy: true }).length, 1)
})
test('late replies are distinct user rows, preserving raw payload and call attribution', () => {
  const ev = user(4, '{"answers":[{"id":"a","selected":["Yes"]}]}')
  ev.data.source = { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' }
  const row = foldHistory([ev])[0]
  assert.equal(row.kind, 'question-reply'); assert.equal(row.callId, 'call-1'); assert.equal(row.text, ev.data.content[0].text)
  ev.data.content = [text('unreadable JSON')]
  assert.equal(foldHistory([ev])[0].text, 'unreadable JSON')
})
test('malformed late replies do not claim an answered question', () => {
  const ev = user(4, 'answer'); ev.data.source = { kind: 'user-question-reply', outcome: 'closed' }
  assert.equal(normalizeHistory([ev]).complete, false); assert.deepEqual(foldHistory([ev]), [])
})
test('synthetic and unknown user sources cannot masquerade as human prompts', () => {
  const ev = user(1, 'synthetic'); ev.data.source = { kind: 'goal' }
  assert.deepEqual(foldHistory([ev]), [])
  delete ev.data.source; assert.deepEqual(foldHistory([ev]), [])
})
test('interrupted messages preserve committed prefix without claiming completion', () => {
  const ev = assistant(3, 'prefix'); ev.data.interrupted = true
  assert.equal(foldHistory([ev])[0].interrupted, true)
})
test('only typed text is visible, no heuristic rewriting of real assistant prose', () => {
  const ev = assistant(1, 'The user legitimately said hello.\n<think>literal quoted markup</think>')
  ev.data.message.content.push({ type: 'future-private', text: 'not visible' })
  const result = normalizeHistory([ev])
  assert.equal(result.messages[0].text, ev.data.message.content[0].text)
  assert.equal(result.complete, false)
})
test('images/files retained detached; unsafe image MIME and remote image URLs not rendered', () => {
  const ev = user(1, '')
  ev.data.content = [
    { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png' } },
    { type: 'file', attachment: { attachmentId: 'file', name: 'notes.txt', byteSize: 3 } },
    { type: 'image', attachment: { attachmentId: 'svg', mediaType: 'image/svg+xml' } },
    { type: 'image_url', url: 'https://example.invalid/private' },
  ]
  const before = JSON.stringify(ev); freeze(ev)
  const result = normalizeHistory([ev])
  assert.deepEqual(result.messages[0].images, [{ attachmentId: 'img', mediaType: 'image/png' }])
  assert.equal(result.messages[0].files.length, 1)
  result.messages[0].files[0].name = 'changed'
  assert.equal(JSON.stringify(ev), before)
})
test('conflicting seqs excluded rather than selecting an arbitrary revision', () => {
  const result = normalizeHistory([user(1, 'first'), user(1, 'other'), assistant(2, 'ok')])
  assert.deepEqual(result.messages.map(m => m.seq), [2])
  assert.equal(result.diagnostics[0].code, 'conflicting-seq')
})
test('unknown required events flag partial transcript; ignorable events remain opaque', () => {
  const result = normalizeHistory([{ type: 'future/rewrite', seq: 1, data: {} }, user(2, 'ok')])
  assert.equal(result.complete, false); assert.equal(result.messages.length, 1)
  assert.equal(normalizeHistory([{ type: 'future/rewrite', seq: 1, ignorable: true, surfaceOp: 'opaque', data: {} }]).complete, true)
})
test('live assistant frames never synthesized into durable history', () => {
  const result = normalizeHistory([{ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text', text: 'live' } } }])
  assert.equal(result.diagnostics[0].code, 'live-stream-unsupported'); assert.deepEqual(result.messages, [])
})
test('invalid outer input rejected; durable human permission text is never silently filtered', () => {
  assert.throws(() => normalizeHistory({ events: [] }), TypeError)
  assert.equal(normalizeHistory([null]).complete, false)
  const result = normalizeHistory([user(1, '/permission danger-full-access')])
  assert.equal(result.complete, true)
  assert.equal(result.messages[0].text, '/permission danger-full-access')
})
test('permission text is retained only through human append origin, never request or system injection', () => {
  const value = '/permission danger-full-access'
  const synthetic = user(5, value); synthetic.data.source = { kind: 'runtime-context' }
  const result = normalizeHistory([
    user(1, value),
    { type: 'request/header', seq: 2, data: { content: [text(value)] } },
    { type: 'system/message', seq: 3, surfaceOp: 'append', data: { content: [text(value)] } },
    { type: 'developer/message', seq: 4, surfaceOp: 'append', data: { content: [text(value)] } },
    synthetic,
    user(6, value, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
  ])
  assert.deepEqual(result.messages.map(m => [m.seq, m.role, m.text]), [[1, 'user', value]])
  assert.equal(result.complete, true)
  assert.deepEqual(result.diagnostics, [{ code: 'non-human-source-omitted', seq: 5 }])
})
test('deferred provenance handling remains opaque and diagnosed, never synthesizing human text', () => {
  const types = ['compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune', 'llm/retry', 'llm/retry-started', 'session/title-llm-request']
  for (const type of types) {
    const event = { type, seq: 1, data: { summary: [text('private')], rawOutput: [{ type: 'reasoning', text: 'secret' }], messages: [user(2, 'duplicate')] } }
    const result = normalizeHistory([event, user(3, 'visible')])
    assert.equal(result.complete, false)
    assert.deepEqual(result.diagnostics, [{ code: 'unknown-required-event', seq: 1 }])
    assert.deepEqual(result.messages.map(m => m.text), ['visible'])
    assert.equal(normalizeHistory([{ ...event, surfaceOp: 'append' }]).complete, false)
  }
})
test('human-bearing inbox and command/domain records must not be mislabeled safe internal events', () => {
  for (const type of ['agent/inbox/spliced', 'goal/change', 'compaction/future']) {
    const result = normalizeHistory([{ type, seq: 1, data: { inserted: [user(2, 'queued').data], source: { kind: 'user' }, args: 'human command input' } }])
    assert.equal(result.complete, false)
    assert.equal(result.diagnostics[0].code, 'unknown-required-event')
    assert.deepEqual(result.messages, [])
  }
})
