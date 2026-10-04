import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { handleBoundSessionUtterance, handleUserUtterance } from '../src/foreman.js'
import { submissionFailureNotice } from '../src/submission-notice.js'

const cfg = { dispatchBase: 'https://dispatch.example.invalid', dispatchToken: 'fixture-only-not-a-secret' }
const oldHtml = '<div class="msg assistant"><div class="meta">助手</div>old</div>'

for (const route of ['bound', 'existing', 'fresh']) {
  for (const accepted of [false, true]) {
    test(`${route}: no admission notice before response; accepted=${accepted}; hangup only stops observation`, async t => {
      const home = mkdtempSync(fileURLToPath(new URL('./tmp-notice-', import.meta.url)))
      t.after(() => rmSync(home, { recursive: true, force: true }))
      const config = { ...cfg, foremanSessionId: route === 'existing' ? 'fixture-session' : '', foremanPath: join(home, 'foreman.json') }
      const controller = new AbortController()
      let release
      const admission = new Promise(resolve => { release = resolve })
      const calls = []
      const notices = []
      t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
        const parsed = new URL(url)
        assert.equal(parsed.origin, cfg.dispatchBase, 'all fetch calls stay mocked')
        calls.push({ method: opts.method || 'GET', path: parsed.pathname })
        if (!opts.method) {
          assert.equal(calls.length, 1, 'after hangup no result polling starts')
          return new Response(oldHtml)
        }
        assert.equal(opts.method, 'POST')
        assert.notEqual(opts.signal, controller.signal, 'phone hangup must not cancel remote submission')
        await admission
        return new Response(route === 'fresh' ? JSON.stringify({ ok: accepted, sessionId: 'fixture-session' }) : '', { status: accepted ? (route === 'fresh' ? 200 : 303) : 502 })
      })
      const opts = { signal: controller.signal, onAdmitted: value => notices.push(value) }
      const work = route === 'bound'
        ? handleBoundSessionUtterance(config, 'fixture-session', 'synthetic fixture', opts)
        : handleUserUtterance(config, 'synthetic fixture', opts)
      // Observation already canceled; submission result is still explicitly reconciled.
      controller.abort()
      assert.deepEqual(notices, [], 'starting the async operation is not admission')
      release()
      await assert.rejects(work, accepted ? /aborted/ : /failed/)
      assert.equal(notices.length, accepted ? 1 : 0)
      if (accepted) assert.equal(notices[0].sessionId, 'fixture-session')
      assert.equal(calls.filter(x => x.method === 'POST').length, 1, 'no retry or remote cancellation')
      assert.equal(calls.some(x => /cancel|abort/.test(x.path)), false)
    })
  }
}

test('post-admission observation failure never claims failed submission or completed execution', () => {
  const notice = submissionFailureNotice({ admitted: true })
  assert.equal(notice.silent, false)
  assert.match(notice.message, /已确认提交/)
  assert.match(notice.message, /无法确认执行结果/)
  assert.doesNotMatch(notice.message, /没接上|任务完成/)
})
test('unknown admission never invites a duplicate retry', () => {
  const notice = submissionFailureNotice()
  assert.match(notice.message, /无法确认任务是否提交成功/)
  assert.match(notice.message, /不要重复提交/)
})
test('hangup is silent for both admitted and uncertain submissions', () => {
  for (const admitted of [true, false]) {
    const notice = submissionFailureNotice({ admitted, closed: true })
    assert.equal(notice.silent, true)
    assert.doesNotMatch(notice.message, /没接上|执行失败|任务完成/)
  }
})
test('call wiring keeps acknowledgement inside the admission callback and tracks every observer', () => {
  const source = readFileSync(new URL('../src/call.js', import.meta.url), 'utf8')
  const capture = source.slice(source.indexOf('const dispatchCapturedTask'), source.indexOf('const runForeman'))
  assert.doesNotMatch(capture, /已经交给/)
  const callback = source.slice(source.indexOf('const onAdmitted'), source.indexOf('const work = targetSessionId'))
  assert.match(callback, /if \(closed\) return/)
  assert.match(callback, /queueExactSpeech/)
  assert.match(callback, /已经交给电脑/)
  assert.match(source, /for \(const controller of turnAborts\) controller\.abort\(\)/)
  assert.match(source, /turnAborts\.delete\(turnAbort\)/)
  assert.match(source, /submissionFailureNotice\(\{ admitted, closed \}\)/)
  assert.doesNotMatch(source, /电脑没接上：/)
})
