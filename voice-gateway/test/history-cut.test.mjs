import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchDispatchHistory } from '../src/foreman.js'
const cfg = { dispatchBase: 'https://dispatch.example.invalid', dispatchToken: 'fixture' }
const opening = { ok: true, sessionId: 's', messages: [], historyToken: 'fixture-cut', throughSeq: 30, consistency: 'opening-cut', hasMore: true, nextBeforeSeq: 20 }
const older = { ...opening, consistency: 'pinned-cut', hasMore: false, nextBeforeSeq: undefined }
function mocked(t, pages) {
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(new URL(url))
    assert.equal(urls.at(-1).origin, cfg.dispatchBase)
    assert.ok(pages.length, 'unexpected fetch: no real networking allowed')
    const { status = 200, ...body } = pages.shift()
    return new Response(JSON.stringify(body), { status })
  })
  return urls
}
test('updated HTTP contract returns pinned cut metadata', async t => {
  const urls = mocked(t, [opening, older])
  const result = await fetchDispatchHistory(cfg, 's')
  assert.equal(result.throughSeq, 30)
  assert.equal(result.consistency, 'pinned-cut')
  assert.equal(urls[1].searchParams.get('historyToken'), 'fixture-cut')
})
for (const override of [{ throughSeq: 31 }, { throughSeq: undefined }, { consistency: 'fresh-cut' }, { throughSeq: '30' }]) {
  test('rejects incompatible backward cut ' + JSON.stringify(override), async t => {
    mocked(t, [opening, { ...older, ...override }])
    await assert.rejects(fetchDispatchHistory(cfg, 's'), /cut|throughSeq/)
  })
}
test('expired token HTTP failure never auto-reopens snapshot', async t => {
  const urls = mocked(t, [opening, { status: 410, ok: false }])
  await assert.rejects(fetchDispatchHistory(cfg, 's'), /http 410/)
  assert.equal(urls.length, 2)
})
test('opening empty complete cut succeeds', async t => {
  mocked(t, [{ ...opening, throughSeq: 0, hasMore: false }])
  const result = await fetchDispatchHistory(cfg, 's')
  assert.deepEqual(result.messages, [])
  assert.equal(result.truncated, false)
  assert.equal(result.consistency, 'opening-cut')
})
