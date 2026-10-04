import { randomUUID } from 'node:crypto'

// Hold this object for any explicit retry: text, mode and identity must not change.
export function createTaskOperation(text) {
  return Object.freeze({ requestId: randomUUID(), text, mode: 'queue' })
}

export async function submitTaskOperation(cfg, operation) {
  if (!operation || !/^[A-Za-z0-9_-]{8,128}$/.test(operation.requestId) || typeof operation.text !== 'string' || operation.mode !== 'queue') throw new Error('invalid task operation')
  try {
    const response = await fetch(cfg.dispatchBase + '/dispatch/task', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.dispatchToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: operation.text, mode: operation.mode, requestId: operation.requestId }),
      signal: AbortSignal.timeout(135000)
    })
    let body
    try { body = JSON.parse(await response.text()) } catch { body = {} }
    if (!response.ok || !body?.ok || typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      const error = new Error('task failed (no confirmed session admission)')
      error.status = response.status
      error.code = typeof body?.error === 'string' ? body.error : undefined
      error.stage = body?.stage
      error.sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined
      throw error
    }
    return body
  } catch (cause) {
    const error = new Error(cause?.message || 'task transport uncertain', { cause })
    error.status = cause?.status
    error.code = cause?.code
    error.stage = cause?.stage
    error.sessionId = cause?.sessionId
    error.operation = operation
    error.requestId = operation.requestId
    error.uncertain = error.code === 'submission-outcome-uncertain-do-not-retry' || !error.status || error.status === 409 || error.status >= 500
    error.doNotRetry = true
    if (error.uncertain) error.message += '；任务提交结果未知，请核查原请求；不要重试或使用新请求编号重复提交。'
    // Never reissue automatically, including with a fresh ID. Reconcile original reservation first.
    throw error
  }
}
