import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatchHostAdapter } from './index.mjs'
import { parseRemoteEventResult } from '@deepseek-ai/dsh-api-gateway/stream-protocol'

function fixture(options = {}) {
  const calls = [], frames = [], bodies = []
  let wake, signal, opens = 0, promoted = 0, closed = 0, serial = 0
  const events = [{ type: 'user/message', seq: 5, data: { content: [{ type: 'text', text: 'hello' }] } }]
  const ctx = {
    sessionController: {
      async list(req, sig) { calls.push(['list', req]); assert.ok(sig instanceof AbortSignal); return { items: [{ sessionId: 's', running: false }, { sessionId: 'child', origin: 'subagent', parentSessionId: 's' }] } },
      async create(r) { calls.push(['create', r]); return { sessionId: r.sessionId ?? 'new' } },
      async prompt(r, sig) { calls.push(['prompt', r]); assert.ok(sig instanceof AbortSignal); return { accepted: true } },
      async *follow(r, sig) { calls.push(['follow', r]); try { yield { type: 'snapshot', cursor: 5, header: { id: 's' }, projections: { asOfSeq: 5, values: { title: 'Title' } }, records: events.map(event => ({ type: 'event', event })), hasMore: true }; promoted++ } finally { closed++ } },
      async page(r) { calls.push(['page', r]); return { records: [{ type: 'event', event: { type: 'user/message', seq: 2, data: {} } }], hasMore: false } },
      async modelCatalog() { return { default: { provider: 'p', model: 'default' }, groups: [], failures: [], routableProviders: ['p'] } },
      async projections() { return { values: { modelSelection: { next: { provider: 'p', model: 'next' } } } } },
      async selectModel(r) { calls.push(['selectModel', r]); return { selected: r } },
      async search(r) { return { items: [], hasMore: false } },
      async rename(r) { return { title: r.title, seq: 6 } },
      async attachment(r) { return { attachment: { mediaType: 'image/png' }, data: 'AA==' } },
    },
    workspaceController: {
      async *follow(sig) { try { yield { type: 'baseline', value: { items: [], archivedSessionIds: ['old'], pinnedSessionIds: [] } } } finally { closed++ } },
      async archiveSession(r) { calls.push(['archiveSession', r]); if (r.sessionId === 'active') throw Object.assign(new Error('active'), { code: 'workspace/session-active', details: { activity: [] } }); return { archivedSessionIds: [r.sessionId] } },
    },
    agentPresets: { async remoteExportList() { return { presets: [{ id: 'default', isDefault: true }] } } },
    typertGateway: { wireStream: { async open(endpoint, payload, uplink, peer, sig) {
      opens++; signal = sig; assert.equal(endpoint, '$events'); assert.deepEqual(payload, { args: {} }); assert.equal(peer, undefined)
      return { async *[Symbol.asyncIterator]() {
        const abort = () => wake?.(); sig.addEventListener('abort', abort)
        try { yield { type: 'ready', clientId: `generation-${opens}` }; while (!sig.aborted) { if (frames.length) yield frames.shift(); else await new Promise(resolve => { wake = resolve }) } }
        finally { sig.removeEventListener('abort', abort) }
      } }
    } } },
    connection: { createSharedFetchHandler(channel) { assert.equal(channel, '/api'); return { async fetch(req) {
      const body = await req.json(); parseRemoteEventResult(body.payload.args); bodies.push(body); assert.equal(new URL(req.url).pathname, '/api/$events/result')
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
    } } } },
  }
  const adapter = createDispatchHostAdapter(ctx, { id: () => `id-${++serial}`, ...options })
  return { adapter, ctx, calls, bodies, push(frame) { frames.push(frame); wake?.() }, get opens() { return opens }, get promoted() { return promoted }, get closed() { return closed }, get aborted() { return signal?.aborted } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const approval = (id = 'e') => ({ type: 'waterfall', event: 'approval/request', eventId: id, agentId: 's', request: { toolName: 'pwsh', reason: 'test' } })
const answer = (id = 'e', sessionId = 's') => ({ type: 'client-response', rpcId: id, result: { ok: true, value: { sessionId, approvalId: id, outcome: 'allowed-once' } } })

test('legacy unary envelopes, validation and owner errors', async () => {
  const f = fixture(); const a = f.adapter
  assert.equal((await a.sessions.create({ cwd: 'x', workspaceId: 'w' })).result.error.code, 'adapter/bad-request')
  assert.equal((await a.sessions.create({ sessionId: 's' })).result.value.sessionId, 's')
  assert.equal((await a.sessions.rename({ sessionId: 's', title: 'T' })).result.value.title, 'T')
  assert.equal((await a.sessions.attachment({ sessionId: 's', attachmentId: 'i' })).result.value.data, 'AA==')
  assert.equal((await a.agentPresets.list()).result.value.presets[0].isDefault, true)
  assert.deepEqual((await a.workspace.list()).result.value.archivedSessionIds, ['old'])
  assert.equal((await a.workspace.archiveSession({ sessionId: 'active' })).result.error.code, 'workspace/session-active')
  assert.deepEqual(f.calls.at(-1), ['archiveSession', { sessionId: 'active' }])
  const models = (await a.sessions.models({ sessionId: 's' })).result.value
  assert.deepEqual(models.current, { provider: 'p', model: 'next' }); assert.equal(models.routable, true)
  await a.dispose()
})

test('prompt requestId explicit retries, same-object fallback, new intentional requests', async () => {
  const f = fixture(); const r = { sessionId: 's', mode: 'queue', content: [{ type: 'text', text: 'hi' }] }
  await f.adapter.sessions.prompt(r); await f.adapter.sessions.prompt(r); await f.adapter.sessions.prompt({ ...r })
  const ids = f.calls.filter(c => c[0] === 'prompt').map(c => c[1].requestId)
  assert.equal(ids[0], ids[1]); assert.notEqual(ids[0], ids[2])
  await f.adapter.sessions.prompt({ ...r, requestId: 'stable' }); assert.equal(f.calls.at(-1)[1].requestId, 'stable')
  assert.equal((await f.adapter.sessions.prompt({ ...r, mode: 'bad' })).result.ok, false)
  await f.adapter.dispose()
})

test('history returns raw events, stable cut, projections and never resumes snapshot generator', async () => {
  const f = fixture()
  const first = (await f.adapter.sessions.history({ sessionId: 's', maxMessages: 20 })).result.value
  assert.equal(first.events[0].seq, 5); assert.equal(first.projections.values.title, 'Title')
  assert.equal(f.promoted, 0); assert.equal(f.closed, 1)
  const next = (await f.adapter.sessions.history({ sessionId: 's', beforeSeq: 5, historyToken: first.historyToken })).result.value
  assert.equal(next.events[0].seq, 2); assert.equal(next.consistency, 'pinned-cut')
  assert.equal(f.calls.at(-1)[1].throughSeq, 5)
  assert.equal((await f.adapter.sessions.history({ sessionId: 'other', historyToken: first.historyToken })).result.ok, false)
  await f.adapter.sessions.history({ sessionId: 'child' }); assert.equal(f.calls.at(-1)[1].address.kind, 'subagent')
  await f.adapter.dispose()
})

test('history token expiry, strict paging and compatibility fresh-cut mode', async () => {
  let time = 0
  const f = fixture({ now: () => time, cursorTtlMs: 10, requireHistoryToken: true })
  const h = (await f.adapter.sessions.history({ sessionId: 's' })).result.value
  time = 11
  assert.equal((await f.adapter.sessions.history({ sessionId: 's', historyToken: h.historyToken })).result.error.code, 'adapter/history-cut-expired')
  assert.equal((await f.adapter.sessions.history({ sessionId: 's', beforeSeq: 5 })).result.error.code, 'adapter/history-token-required')
  await f.adapter.dispose()
  const g = fixture(); assert.equal((await g.adapter.sessions.history({ sessionId: 's', beforeSeq: 5 })).result.value.consistency, 'fresh-cut'); await g.adapter.dispose()
})

test('one shared event generation; approval result acknowledges submission not winner', async () => {
  const f = fixture(); const mux = f.adapter.events.mux()[Symbol.asyncIterator](); const host = f.adapter.events.host()[Symbol.asyncIterator]()
  const waiting = mux.next(); f.push(approval()); const opened = (await waiting).value
  assert.equal(f.opens, 1); assert.equal(opened.payload.approvalIdKind, 'adapter-event-id')
  assert.equal((await f.adapter.respond(answer('e', 'wrong'))).reason, 'bad-response'); assert.equal(f.bodies.length, 0)
  const receipt = await f.adapter.respond(answer())
  assert.equal(receipt.submitted, true); assert.equal(receipt.accepted, false); assert.equal(receipt.settlement, 'unconfirmed')
  assert.deepEqual(f.bodies[0].payload.args.outcome, { kind: 'result', value: 'allowed-once' })
  assert.equal(f.bodies[0].payload.args.clientId, 'generation-1')
  assert.equal((await mux.next()).value.payload.outcome, 'unknown')
  assert.equal((await f.adapter.respond(answer())).reason, 'not-pending')
  f.push({ type: 'emit', event: 'api-session/status', args: ['s', false] })
  assert.equal((await host.next()).value.payload.type, 'host/session-status')
  await f.adapter.dispose(); assert.equal(f.aborted, true); await mux.return(); await host.return()
})

test('GUI cancellation removes stale approval and never sends phone result', async () => {
  const f = fixture(); const it = f.adapter.events.mux()[Symbol.asyncIterator]()
  f.push(approval()); await it.next(); f.push({ type: 'cancel', eventId: 'e' })
  const removed = (await it.next()).value.payload
  assert.equal(removed.reason, 'settled-or-cancelled'); assert.equal(removed.outcome, 'unknown')
  assert.equal((await f.adapter.respond(answer())).reason, 'not-pending'); assert.equal(f.bodies.length, 0)
  await f.adapter.dispose(); await it.return()
})

test('unsupported timed/plan and unknown questions delegate next, not reject or claim', async () => {
  const f = fixture(); const stream = f.adapter.events.mux(); const it = stream[Symbol.asyncIterator]()
  f.push({ type: 'waterfall', event: 'user-questions/request', eventId: 'timed', agentId: 's', request: { questions: [], wait: { callId: 'call', timed: true } } })
  f.push({ type: 'waterfall', event: 'future/request', eventId: 'future', agentId: 's', request: {} })
  f.push({ type: 'waterfall', event: 'user-questions/request', eventId: 'plan', agentId: 's', request: { questions: [{ id: 'plan', detail: '# Review me', intent: { kind: 'plan-review' } }] } })
  f.push(approval('barrier'))
  for (const id of ['timed', 'future', 'plan']) {
    const notification = (await it.next()).value
    assert.equal(notification.rpcId, id)
    assert.equal(notification.payload.type, 'interaction/unsupported')
  }
  assert.equal((await it.next()).value.rpcId, 'barrier')
  assert.equal(f.bodies.length, 3); assert.ok(f.bodies.every(b => b.payload.args.outcome.kind === 'next'))
  assert.equal(f.adapter.capabilities.timedQuestions, false); assert.equal(f.adapter.capabilities.continuedQuestions, false)
  await f.adapter.dispose(); await it.return()
})

test('indefinite question validates ids/options and unwraps answer shape', async () => {
  const f = fixture(); const it = f.adapter.events.mux()[Symbol.asyncIterator]()
  f.push({ type: 'waterfall', event: 'user-questions/request', eventId: 'q', agentId: 's', request: { questions: [{ id: 'one', question: 'Which?', options: [{ label: 'A' }] }] } })
  await it.next()
  const response = selected => ({ type: 'client-response', rpcId: 'q', result: { ok: true, value: { sessionId: 's', answer: { answers: [{ id: 'one', selected }] } } } })
  assert.equal((await f.adapter.respond(response(['invented']))).reason, 'bad-response')
  assert.equal((await f.adapter.respond(response(['A']))).submitted, true)
  assert.deepEqual(f.bodies.at(-1).payload.args.outcome.value, { answers: [{ id: 'one', selected: ['A'] }] })
  await f.adapter.dispose(); await it.return()
})

test('disconnect/reconnect refreshes client id; disposal cleans generation', async () => {
  const f = fixture(); const abort = new AbortController(); const it = f.adapter.events.mux({}, abort.signal)[Symbol.asyncIterator]()
  f.push(approval()); await it.next(); abort.abort(); await tick(); await it.return(); await tick()
  assert.equal(f.adapter.getInteractionState().pending.length, 0)
  const again = f.adapter.events.mux()[Symbol.asyncIterator](); f.push(approval()); await again.next()
  assert.equal(f.opens, 2); await f.adapter.respond(answer()); assert.equal(f.bodies.at(-1).payload.args.clientId, 'generation-2')
  await f.adapter.dispose(); await again.return()
})

test('ack after GUI wins stays unconfirmed; broken transport is uncertain, never accepted', async () => {
  const f = fixture(); const it = f.adapter.events.mux()[Symbol.asyncIterator]()
  f.push(approval()); await it.next()
  const original = f.ctx.connection.createSharedFetchHandler
  let release
  f.ctx.connection.createSharedFetchHandler = channel => ({ async fetch(req) {
    await new Promise(resolve => { release = resolve })
    return original(channel).fetch(req)
  } })
  const submission = f.adapter.respond(answer()); await tick()
  f.push({ type: 'cancel', eventId: 'e' }); await it.next(); release()
  const result = await submission; assert.equal(result.accepted, false); assert.equal(result.settlement, 'unconfirmed')
  f.push(approval('e2')); await it.next()
  f.ctx.connection.createSharedFetchHandler = () => ({ async fetch() { throw new Error('network failure') } })
  const unknown = await f.adapter.respond(answer('e2')); assert.equal(unknown.reason, 'transport-uncertain'); assert.equal(unknown.accepted, false)
  await f.adapter.dispose(); await it.return()
})

test('host-only consumer declines interaction instead of retaining invisible approval', async () => {
  const f = fixture(); const it = f.adapter.events.host()[Symbol.asyncIterator]()
  f.push(approval()); f.push({ type: 'emit', event: 'api-session/status', args: ['s', true] }); await it.next()
  assert.equal(f.bodies[0].payload.args.outcome.kind, 'next'); assert.equal(f.adapter.getInteractionState().pending.length, 0)
  await f.adapter.dispose(); await it.return()
})

test('bounded stream overflow ends subscriber and drops pending generation', async () => {
  const f = fixture({ queueLimit: 1 }); const it = f.adapter.events.mux()[Symbol.asyncIterator]()
  f.push(approval('one')); f.push(approval('two')); await tick(); await tick()
  await assert.rejects(it.next(), { code: 'adapter/event-overflow' })
  await f.adapter.dispose(); assert.equal(f.adapter.getInteractionState().pending.length, 0)
})
