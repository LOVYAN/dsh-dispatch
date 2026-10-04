import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHistory, foldHistory } from './index.mjs'

const run = (seq, commandId = 'cmd-a', extra = {}) => ({ type: 'command/run', seq, time: seq * 10, data: { commandId, name: 'example', args: '  <input>\nverbatim', source: { kind: 'user' }, ...extra } })
const done = (seq, commandId = 'cmd-a', extra = {}) => ({ type: 'command/done', seq, time: seq * 10, data: { commandId, kind: 'success', text: '<outcome>\nfull result', ...extra } })
const codes = result => result.diagnostics.map(d => d.code)
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze) }; return value }

test('success and failure are distinct historical records, never fake chat or executable actions', () => {
  const result = normalizeHistory([run(1), done(2), run(3, 'cmd-b'), done(4, 'cmd-b', { kind: 'error', text: 'failed' })])
  assert.deepEqual(result.messages, [])
  assert.deepEqual(foldHistory([run(1), done(2)]), [])
  assert.equal(result.complete, true)
  assert.deepEqual(result.commandRecords.map(r => [r.kind, r.status, r.outcome.text]), [
    ['historical-command', 'success', '<outcome>\nfull result'], ['historical-command', 'error', 'failed'],
  ])
  assert.equal(result.commandRecords[0].args, '  <input>\nverbatim')
  assert.equal('role' in result.commandRecords[0], false)
})

test('IDs, not adjacency, correlate interleaved commands; reverse pages and overlap normalize once', () => {
  const entries = [done(8, 'b'), run(3, 'b'), done(9, 'a'), run(1, 'a')]
  const result = normalizeHistory([...entries, { type: 'event', event: run(1, 'a') }])
  assert.equal(result.complete, true)
  assert.deepEqual(result.commandRecords.map(r => [r.commandId, r.seq, r.outcome.seq]), [['a', 1, 9], ['b', 3, 8]])
})

test('missing run/outcome never guesses across IDs or claims currently running', () => {
  const result = normalizeHistory([run(1, 'a'), done(2, 'b')])
  assert.equal(result.complete, false)
  assert.equal(result.commandRecords.length, 1)
  assert.equal(result.commandRecords[0].status, 'outcome-not-in-window')
  assert.equal('outcome' in result.commandRecords[0], false)
  assert.deepEqual(codes(result), ['command-outcome-not-in-window', 'command-run-not-in-window'])
})

test('missing/invalid IDs are diagnosed without leaking event payloads', () => {
  for (const commandId of [undefined, null, '', 7]) {
    const result = normalizeHistory([run(1, commandId, { commandId }), done(2, commandId, { commandId })])
    assert.deepEqual(result.commandRecords, [])
    assert.deepEqual(result.diagnostics, [{ code: 'invalid-command-id', seq: 1 }, { code: 'invalid-command-id', seq: 2 }])
  }
})

test('duplicate run or done IDs at different sequences are ambiguous even with identical payloads', () => {
  for (const entries of [[run(1), run(2), done(3)], [run(1), done(2), done(3)]]) {
    const result = normalizeHistory(entries)
    assert.deepEqual(result.commandRecords, [])
    assert.equal(result.complete, false)
    assert.ok(codes(result).every(c => c === 'ambiguous-command-id'))
  }
})

test('conflicting-sequence copies taint both command IDs rather than attach a stray outcome', () => {
  const result = normalizeHistory([run(1, 'a'), run(1, 'b'), run(2, 'a'), done(3, 'a')])
  assert.deepEqual(result.commandRecords, [])
  assert.ok(codes(result).includes('conflicting-seq'))
  assert.ok(codes(result).includes('ambiguous-command-id'))
})

test('outcome before run is invalid, regardless of input array order', () => {
  const result = normalizeHistory([run(9), done(2)])
  assert.equal(result.commandRecords[0].status, 'invalid-outcome')
  assert.equal('outcome' in result.commandRecords[0], false)
  assert.deepEqual(codes(result), ['command-outcome-before-run'])
})

test('domain-owned input and richer presentation stay explicitly partial, never dereferenced', () => {
  const start = run(1); delete start.data.args
  const domain = { type: 'goal/change', seq: 2, data: { private: 'not exposed' } }
  const result = normalizeHistory([start, domain, done(3, 'cmd-a', { text: undefined, sourceEventSeq: 2 })])
  assert.equal(result.complete, false)
  const record = result.commandRecords[0]
  assert.equal(record.inputRecorded, false)
  assert.equal('args' in record, false)
  assert.deepEqual(record.outcome, { seq: 3, time: 30, kind: 'success', sourceEventSeq: 2 })
  assert.ok(codes(result).includes('command-input-domain-owned'))
  assert.ok(codes(result).includes('command-domain-presentation-unprojected'))
  assert.equal(JSON.stringify(result).includes('not exposed'), false)
  assert.ok(codes(normalizeHistory([run(1), done(3, 'cmd-a', { sourceEventSeq: 0 })])).includes('command-domain-presentation-unprojected'))
})

test('invalid public outcome shape and domain pointers never expose outcome text', () => {
  for (const extra of [{ kind: 'pending' }, { text: {} }, { sourceEventSeq: 3 }, { sourceEventSeq: -1 }, { sourceEventSeq: 1 }, { kind: 'error', sourceEventSeq: 0 }]) {
    const result = normalizeHistory([run(1), done(3, 'cmd-a', extra)])
    assert.equal(result.commandRecords[0].status, 'invalid-outcome')
    assert.equal('outcome' in result.commandRecords[0], false)
    assert.ok(codes(result).includes('invalid-command-outcome'))
  }
})

test('invalid/non-human command origins and surface markers fail closed, including legacy sequence gaps', () => {
  for (const ev of [run(1, 'a', { source: { kind: 'automation' } }), run(1, 'a', { name: '' }), run(1, 'a', { args: {} }), { ...run(1), surfaceOp: 'append' }]) {
    const result = normalizeHistory([ev])
    assert.deepEqual(result.commandRecords, [])
    assert.ok(codes(result).includes('invalid-command-run'))
  }
  const unsequenced = run(1); delete unsequenced.seq
  assert.deepEqual(normalizeHistory([unsequenced], { legacy: true }).commandRecords, [])
})

test('projection preserves original chat fold and never copies private metadata, inbox or reasoning', () => {
  const chat = { type: 'user/message', seq: 4, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'human' }] } }
  const reply = { type: 'assistant/message', seq: 5, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'PRIVATE' }] } } }
  const entries = freeze([run(1, 'a', { private: 'PRIVATE' }), done(3, 'a', { rawOutput: 'PRIVATE', reasoning: 'PRIVATE' }), chat, reply,
    { type: 'agent/inbox/spliced', seq: 6, data: { inserted: ['PRIVATE'] } },
    { type: 'compaction/summary', seq: 7, data: { rawOutput: 'PRIVATE' } }])
  const before = JSON.stringify(entries)
  const result = normalizeHistory(entries)
  assert.deepEqual(result.messages, normalizeHistory([chat, reply]).messages)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  result.commandRecords[0].outcome.text = 'changed'
  assert.equal(JSON.stringify(entries), before)
  assert.equal(result.complete, false)
})

test('synthetic distant sequences remain independent command records', () => {
  // Invented distant sequences, with no corpus-derived identifiers or content.
  const result = normalizeHistory([done(9002, 'example-9001'), run(9001, 'example-9001'), done(102, 'example-101'), run(101, 'example-101')])
  assert.deepEqual(result.commandRecords.map(r => r.seq), [101, 9001])
  assert.equal(result.complete, true)
})
