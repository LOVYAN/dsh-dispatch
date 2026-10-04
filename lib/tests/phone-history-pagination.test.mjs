import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'
import { createDispatchHostAdapter } from '../dispatch-adapter/index.mjs'

const ok = value => ({ result: { ok: true, value } })
const sid = 'session/<private>"'
const auth = 'dispatch-secret<&"'
const cut = 'snapshot<&"'
const event = seq => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `record-${String(seq).padStart(3, '0')} <script>"&` }] } })
function host(history) {
  return Object.assign(Object.create(DispatchService.prototype), {
    config: { token: auth }, pending: new Map(), pendingQuestions: new Map(),
    client: { sessions: { history, list: async () => ok({ items: [] }), models: async () => ok({ groups: [] }) } },
    note() {}, sessionRunning: async () => true, archivedIdSet: async () => new Set(),
    renderHistoryCards: () => '', voicePanel: () => '', voiceJs: () => '', sendAttachmentJs: () => '',
  })
}
async function render(h, path = h.chatPath(sid)) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(html) { this.html = html } }
  await h.handleChatView(encodeURIComponent(sid), new URL(path, 'http://offline.invalid'), res)
  return res
}
function link(html, text) {
  const match = [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].find(m => m[2] === text)
  return match?.[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
}
function ids(html) { return [...html.matchAll(/record-(\d+)/g)].map(m => Number(m[1])) }

test('phone navigates >40 records through actual pinned adapter, preserving chronological pages and private links', async () => {
  let now = 100, follows = 0
  const records = Array.from({ length: 95 }, (_, seq) => event(seq))
  const pages = [], calls = []
  const controller = {
    list: async () => ({ items: [] }),
    async *follow({ maxMessages }) { follows++; const cursor = records.at(-1).seq; yield { type: 'snapshot', cursor, records: records.slice(-maxMessages).map(event => ({ type: 'event', event })), hasMore: records.length > maxMessages, projections: { values: {} } } },
    async page(request) {
      pages.push(request)
      const eligible = records.filter(e => e.seq <= request.throughSeq && (request.beforeSeq === undefined || e.seq < request.beforeSeq))
      return { records: eligible.slice(-request.maxMessages).map(event => ({ type: 'event', event })), hasMore: eligible.length > request.maxMessages }
    },
  }
  const adapter = createDispatchHostAdapter({ sessionController: controller, workspaceController: {}, typertGateway: {}, connection: {} }, { now: () => now, id: () => cut, requireHistoryToken: true, cursorTtlMs: 100 })
  try {
    const h = host(request => { calls.push(request); return adapter.sessions.history(request) })
    const first = await render(h)
    assert.equal(first.status, 200)
    assert.deepEqual(ids(first.html), Array.from({ length: 40 }, (_, i) => i + 55))
    assert.deepEqual(calls[0], { sessionId: sid, maxMessages: 40 })
    assert.equal(first.headers['Cache-Control'], 'private, no-store')
    assert.equal(first.headers['Referrer-Policy'], 'no-referrer')
    assert.ok(!first.html.includes(auth)); assert.ok(!first.html.includes(cut))
    assert.ok(first.html.includes('&amp;beforeSeq=55&amp;historyToken='))
    assert.ok(first.html.includes('&lt;script&gt;&quot;&amp;'))
    assert.ok(first.html.includes('页面不代表全部交互事件'))
    const older = link(first.html, '更早记录')
    const params = new URL(older, 'http://offline.invalid').searchParams
    assert.equal(params.get('token'), auth); assert.equal(params.get('historyToken'), cut)
    records.push(event(95)) // New messages must not shift the existing snapshot.
    const second = await render(h, older)
    assert.deepEqual(ids(second.html), Array.from({ length: 40 }, (_, i) => i + 15))
    assert.deepEqual(calls[1], { sessionId: sid, maxMessages: 40, beforeSeq: 55, historyToken: cut })
    assert.ok(!second.html.includes('location.reload()'))
    const third = await render(h, link(second.html, '更早记录'))
    assert.deepEqual(ids(third.html), Array.from({ length: 15 }, (_, i) => i))
    assert.equal(link(third.html, '更早记录'), undefined)
    assert.ok(third.html.includes('已到此快照的最早聊天记录'))
    assert.equal(follows, 1); assert.ok(pages.every(p => p.throughSeq === 94))
    const latest = link(third.html, '返回最新记录')
    assert.equal(latest, h.chatPath(sid))
    const refreshed = await render(h, latest)
    assert.equal(ids(refreshed.html).at(-1), 95); assert.equal(follows, 2)
    now = 201
    const expired = await render(h, older)
    assert.equal(expired.status, 410); assert.ok(expired.html.includes('历史快照已过期'))
    assert.equal(link(expired.html, '返回最新记录'), h.chatPath(sid))
    assert.ok(!expired.html.includes('最早聊天记录')); assert.equal(follows, 2)
  } finally { await adapter.dispose() }
})

test('phone rejects malformed, unbounded or ambiguous cursor/token without reading history', async () => {
  let calls = 0
  const h = host(async () => { calls++; return ok({ events: [], hasMore: false }) })
  const invalid = [
    'beforeSeq=', 'beforeSeq=1', 'beforeSeq=-1&historyToken=x', 'beforeSeq=1.5&historyToken=x',
    'beforeSeq=1e3&historyToken=x', 'beforeSeq=0x10&historyToken=x', 'beforeSeq=%201&historyToken=x',
    'beforeSeq=9007199254740992&historyToken=x', 'beforeSeq=01&historyToken=x',
    'beforeSeq=1&beforeSeq=2&historyToken=x', 'historyToken=', 'historyToken=x&historyToken=y',
    'historyToken=%0A', 'historyToken=%00', 'historyToken=%20', `historyToken=${'x'.repeat(513)}`,
  ]
  for (const query of invalid) {
    const res = await render(h, `${h.chatPath(sid)}&${query}`)
    assert.equal(res.status, 400, query)
    assert.equal(link(res.html, '返回最新记录'), h.chatPath(sid))
  }
  assert.equal(calls, 0)
})

test('zero and maximum safe cursor are preserved; token-only page stays pinned; page size cannot be enlarged', async () => {
  const calls = []
  const h = host(async request => { calls.push(request); return ok({ events: [], hasMore: false }) })
  for (const beforeSeq of ['0', String(Number.MAX_SAFE_INTEGER)]) {
    await render(h, `${h.chatPath(sid)}&beforeSeq=${beforeSeq}&historyToken=cut&maxMessages=1000000`)
    assert.deepEqual(calls.at(-1), { sessionId: sid, maxMessages: 40, beforeSeq: Number(beforeSeq), historyToken: 'cut' })
  }
  await render(h, `${h.chatPath(sid)}&historyToken=cut`)
  assert.deepEqual(calls.at(-1), { sessionId: sid, maxMessages: 40, historyToken: 'cut' })
})

test('nonprogressing or missing pagination metadata never claims all records and always offers recovery', async () => {
  for (const value of [
    { events: [], historyToken: cut },
    { events: [event(9)], historyToken: '' },
    { events: [event(9)], historyToken: 'x'.repeat(513) },
    { events: [event(20)], historyToken: cut },
    { events: [event(-1)], historyToken: cut },
  ]) {
    const h = host(async () => ok({ ...value, hasMore: true }))
    const res = await render(h, `${h.chatPath(sid)}&beforeSeq=20&historyToken=cut`)
    assert.equal(link(res.html, '更早记录'), undefined)
    assert.ok(res.html.includes('更早记录暂不可用'))
    assert.ok(!res.html.includes('已到此快照的最早聊天记录'))
    assert.equal(link(res.html, '返回最新记录'), h.chatPath(sid))
  }
})

test('minimum raw event sequence drives cursor while normalization retains chronological rendering', async () => {
  const h = host(async () => ok({ events: [event(8), event(4), { seq: 2, type: 'turn/start' }, event(6)], hasMore: true, historyToken: cut }))
  const res = await render(h)
  assert.deepEqual(ids(res.html), [4, 6, 8])
  assert.equal(new URL(link(res.html, '更早记录'), 'http://offline.invalid').searchParams.get('beforeSeq'), '2')
})

test('transport and structured errors do not expose tokens or silently reset snapshot', async () => {
  for (const history of [async () => { throw Error(auth) }, async () => ({ result: { ok: false, error: { code: 'other', message: auth } } })]) {
    const h = host(history)
    const res = await render(h, `${h.chatPath(sid)}&beforeSeq=20&historyToken=cut`)
    assert.equal(res.status, 502); assert.ok(!res.html.includes(auth))
    assert.equal(link(res.html, '返回最新记录'), h.chatPath(sid))
  }
})
