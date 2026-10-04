import test from 'node:test'
import assert from 'node:assert/strict'
import { DispatchService } from '../index.js'

function fixture() {
  let calls = 0
  const service = Object.assign(Object.create(DispatchService.prototype), {
    config: { token: 'synthetic-auth-token' }, pending: new Map(), pendingQuestions: new Map(), events: [],
    handleTask() { calls++; }, handleChatList() { calls++; },
    log() {},
  })
  return { service, get calls() { return calls } }
}
async function request(service, url, method = 'GET', authorization) {
  const response = { writeHead(status, headers) { this.status = status; this.headers = headers }, end(body) { this.body = body } }
  await service.handle({ url, method, headers: { host: 'offline.invalid', ...(authorization ? { authorization } : {}) } }, response)
  return response
}

test('unauthenticated health is minimal and task/status routes are fenced', async () => {
  const f = fixture()
  assert.deepEqual(JSON.parse((await request(f.service, '/dispatch/health')).body), { ok: true, pending: 0, pendingQuestions: 0 })
  for (const [url, method] of [['/dispatch/task', 'POST'], ['/dispatch/status', 'GET'], ['/dispatch/session-history/synthetic-session', 'GET']]) {
    assert.equal((await request(f.service, url, method)).status, 401)
    assert.equal((await request(f.service, url + '?token=wrong', method)).status, 401)
  }
  assert.equal(f.calls, 0)
})

test('query and bearer auth admit requests, and a wrong query cannot override bearer fencing', async () => {
  const f = fixture()
  await request(f.service, '/dispatch/task?token=synthetic-auth-token', 'POST')
  await request(f.service, '/dispatch/task', 'POST', 'Bearer synthetic-auth-token')
  assert.equal(f.calls, 2)
  assert.equal((await request(f.service, '/dispatch/task?token=wrong', 'POST', 'Bearer synthetic-auth-token')).status, 401)
  assert.equal(f.calls, 2)
})

test('chat and decision unauthenticated requests render an authorization explanation without dispatching', async () => {
  const f = fixture()
  for (const path of ['/dispatch/chat', '/dispatch/decision']) {
    const response = await request(f.service, path)
    assert.ok(response.body.includes('未授权'))
    assert.ok(!response.body.includes(f.service.config.token))
  }
  assert.equal(f.calls, 0)
})
