import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'
import { normalizeHistory } from '../history-adapter/index.mjs'

const ok = value => ({ result: { ok: true, value } })
const run = (seq = 2, args = '  invented input\nsecond line') => ({ seq, type: 'command/run', data: { commandId: 'synthetic-id<"', name: 'example', args, source: { kind: 'user' } } })
const done = (seq = 4, text = 'invented reply\nsecond line', kind = 'success') => ({ seq, type: 'command/done', data: { commandId: 'synthetic-id<"', kind, text } })
const message = (seq, role) => ({ seq, type: `${role}/message`, surfaceOp: 'append', data: role === 'user' ? { source: { kind: 'user' }, content: [{ type: 'text', text: 'human marker' }] } : { message: { content: [{ type: 'text', text: 'assistant marker' }] } } })
function host(events, hasMore = false) {
  const calls = [], diagnostics = []
  const h = Object.assign(Object.create(DispatchService.prototype), {
    config: { token: 'synthetic-token' }, pending: new Map(), pendingQuestions: new Map(),
    client: { sessions: {
      history: async request => { calls.push(request); return ok({ events, hasMore, historyToken: 'synthetic-cut' }) },
      list: async () => ok({ items: [] }), models: async () => ok({ groups: [] }),
    } },
    note: (_, data) => diagnostics.push(data), sessionRunning: async () => false, archivedIdSet: async () => new Set(),
    renderHistoryCards: () => '', voicePanel: () => '', voiceJs: () => '', sendAttachmentJs: () => '',
  })
  return { h, calls, diagnostics }
}
async function render(h, query = '') {
  const res = { setHeader() {}, writeHead(status) { this.status = status }, end(html) { this.html = html } }
  await h.handleChatView('synthetic-session', new URL(h.chatPath('synthetic-session') + query, 'http://offline.invalid'), res)
  assert.equal(res.status, 200)
  return res.html
}

test('phone merges separate command and reply positions by seq without impersonation or changing folding', async () => {
  const events = [done(), message(3, 'assistant'), run(), message(1, 'user')]
  const { h, calls } = host(events, true)
  const before = structuredClone(events)
  const html = await render(h)
  assert.ok(html.indexOf('human marker') < html.indexOf('/example'))
  assert.ok(html.indexOf('/example') < html.indexOf('assistant marker'))
  assert.ok(html.indexOf('assistant marker') < html.indexOf('invented reply'))
  assert.equal((html.match(/class="msg assistant"/g) || []).length, 1)
  assert.ok(html.includes('历史命令（只读）')); assert.ok(html.includes('历史命令回复（只读）'))
  assert.ok(html.includes('页面不代表全部交互事件')); assert.ok(html.includes('beforeSeq=1'))
  assert.deepEqual(h.foldHistory(events).map(m => m.role), ['user', 'assistant'])
  assert.deepEqual(events, before)
  assert.deepEqual(calls, [{ sessionId: 'synthetic-session', maxMessages: 40 }])
  const page = await h.sessionHistoryPage('synthetic-session')
  assert.equal(page.commandRecords.length, 1); assert.equal(page.messages.length, 2); assert.equal(page.projectionComplete, true)
})

test('full multiline args and outcomes are escaped without trimming or truncating; records contain no actions', async () => {
  const payload = '\n<script>alert("synthetic")</script><img src=x onerror=alert(1)>&\'\n' + 'z'.repeat(14000) + '\nEND  '
  const input = run(2, '  ' + payload); input.data.name = '<svg onload="synthetic">'
  const { h } = host([input, done(4, payload, 'error')])
  const html = await render(h)
  const cards = html.match(/<div class="msg historical-command[\s\S]*?(?=<nav aria-label="历史分页")/)?.[0]
  assert.ok(cards)
  assert.ok(cards.includes(h.escHtml('/' + input.data.name + input.data.args)))
  assert.ok(cards.includes(h.escHtml(payload)))
  assert.ok(cards.includes('记录为错误'))
  assert.ok(!cards.includes('<script>')); assert.ok(!cards.includes('<svg')); assert.ok(!cards.includes('<img'))
  assert.ok(!cards.includes('synthetic-id')); assert.doesNotMatch(cards, /<(?:a|button|form|input)\b|onclick=|data-command/)
})

test('run-only and outcome-only pinned pages are explicit partials, never fabricated completion or assistant replies', async () => {
  for (const events of [[run()], [done()]]) {
    const { h, calls } = host(events, true)
    const html = await render(h, '&beforeSeq=10&historyToken=synthetic-cut')
    assert.ok(html.includes('本页历史投影不完整')); assert.ok(html.includes('更早记录'))
    assert.ok(!html.includes('location.reload()')); assert.ok(!html.includes('可能还在跑工具'))
    assert.ok(!html.includes('class="msg assistant"')); assert.ok(!html.includes('记录为成功'))
    if (events[0].type === 'command/run') assert.ok(html.includes('不能据此判断正在运行、失败或取消'))
    else { assert.ok(html.includes('未展示孤立回复')); assert.ok(!html.includes('invented reply')) }
    assert.deepEqual(calls[0], { sessionId: 'synthetic-session', maxMessages: 40, beforeSeq: 10, historyToken: 'synthetic-cut' })
    assert.equal((await h.sessionHistoryPage('synthetic-session')).projectionComplete, false)
  }
})

test('missing input, invalid outcome and unprojected references disclose gaps without inferred content', async () => {
  const input = run(); delete input.data.args; input.data.privatePayload = 'DO-NOT-PROJECT'
  const { h } = host([input, done(1)])
  let html = await render(h)
  assert.ok(html.includes('输入未记录')); assert.ok(html.includes('回复记录无效'))
  assert.ok(!html.includes('DO-NOT-PROJECT')); assert.ok(!html.includes('invented reply'))
  const referenced = done(); referenced.data.sourceEventSeq = 1; delete referenced.data.text
  html = host([]).h.renderHistoryProjection(normalizeHistory([run(), referenced]), 'synthetic-session')
  assert.ok(html.includes('回复未记录文本')); assert.ok(html.includes('关联的领域展示未投影'))
})

test('unsafe or duplicate display sequences never assert interleaved chronology', () => {
  const { h } = host([])
  for (const seq of [undefined, 2]) {
    const projection = normalizeHistory([run(), done(), message(1, 'user')])
    projection.messages[0].seq = seq
    const html = h.renderHistoryProjection(projection, 'synthetic-session')
    assert.ok(html.includes('不代表交错时间顺序'))
    assert.ok(html.includes('human marker')); assert.ok(html.includes('/example'))
  }
})

test('command success never becomes assistant completion or causes historical command execution', async () => {
  const { h, calls, diagnostics } = host([message(1, 'user'), run(), done()])
  const html = await render(h, '&sent=1')
  assert.ok(html.includes('进行中……')) // unchanged human/assistant heuristic, not command success
  assert.deepEqual(h.foldHistory([run(), done()]), [])
  assert.equal(calls.length, 1)
  assert.ok(diagnostics.every(d => Object.keys(d).every(key => ['code', 'seq'].includes(key))))
})
