import { randomUUID } from 'node:crypto'

export const REQUIRED_HOST_SERVICES = Object.freeze(['sessionController', 'workspaceController', 'typertGateway', 'connection'])
export class AdapterError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'AdapterError'; this.code = code; this.details = details }
}
const fail = (code, message) => { throw new AdapterError(code, message) }
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const text = (x, name) => typeof x === 'string' && x.trim() ? x : fail('adapter/bad-request', `${name} must be a nonempty string`)
const sid = r => text(r?.sessionId, 'sessionId')
const integer = (x, min, name) => Number.isSafeInteger(x) && x >= min ? x : fail('adapter/bad-request', `${name} is invalid`)
const empty = { async *[Symbol.asyncIterator]() {} }
function safeError(error) {
  // Only structured, owner-declared failures are exposed. Never serialize arbitrary Error objects/stacks.
  return typeof error?.code === 'string'
    ? { code: error.code, message: String(error.message || error.code), details: object(error.details) ? error.details : {} }
    : { code: 'adapter/internal', message: 'Host operation failed', details: {} }
}
function fields(request, allowed) {
  if (!object(request)) fail('adapter/bad-request', 'request must be an object')
  const result = {}
  for (const key of allowed) if (request[key] !== undefined) result[key] = request[key]
  return result
}

/** Dependency-injected host facade. This module never starts a server or reads configuration files.
 * Call dispose() from the owning plugin effect; authenticate BEFORE calling any method.
 * options: timeoutMs, queueLimit, maxPending, cursorLimit, cursorTtlMs, requireHistoryToken,
 * allowPlanReviewQuestions (default false), onDiagnostic({code}), now(), id().
 */
export function createDispatchHostAdapter(ctx, options = {}) {
  for (const name of REQUIRED_HOST_SERVICES) if (!ctx?.[name]) fail('adapter/service-unavailable', `Missing host service: ${name}`)
  const lifetime = new AbortController()
  const id = options.id ?? randomUUID
  const now = options.now ?? Date.now
  const timeoutMs = integer(options.timeoutMs ?? 120000, 1, 'timeoutMs')
  const cursorLimit = integer(options.cursorLimit ?? 128, 1, 'cursorLimit')
  const cursorTtlMs = integer(options.cursorTtlMs ?? 300000, 1, 'cursorTtlMs')
  const queueLimit = integer(options.queueLimit ?? 256, 1, 'queueLimit')
  const maxPending = integer(options.maxPending ?? 256, 1, 'maxPending')
  const controller = ctx.sessionController
  const cursors = new Map()
  const promptIds = new WeakMap()
  const pending = new Map()
  // Bounded diagnostic tombstones, never answer authority. Clear on generation loss.
  const unsupportedInteractions = new Map()
  const subscribers = new Set()
  const tasks = new Set()
  let generation
  const diagnostic = code => { try { options.onDiagnostic?.({ code }) } catch {} }

  function signalFor(signal) {
    lifetime.signal.throwIfAborted()
    return AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  }
  async function legacy(fn, signal) {
    const rpcId = id()
    try {
      const callSignal = signalFor(signal)
      callSignal.throwIfAborted()
      return { type: 'server-response', rpcId, result: { ok: true, value: await fn(callSignal) } }
    } catch (error) { return { type: 'server-response', rpcId, result: { ok: false, error: safeError(error) } } }
  }
  async function first(stream, signal, expected) {
    const iterator = stream[Symbol.asyncIterator]()
    try {
      signal.throwIfAborted()
      const next = await iterator.next()
      signal.throwIfAborted()
      if (next.done || next.value?.type !== expected) fail('adapter/protocol', `Expected ${expected} opening frame`)
      return next.value
    } finally {
      // Direct one-pull follow: do not resume after snapshot yield (rc2 would promote a cold Agent).
      await iterator.return?.()
    }
  }
  function pruneCursors() {
    for (const [key, cut] of cursors) if (cut.expires <= now()) cursors.delete(key)
    while (cursors.size >= cursorLimit) cursors.delete(cursors.keys().next().value)
  }
  async function addressFor(request, signal) {
    const sessionId = sid(request)
    if (request.address) {
      const a = request.address
      if (a.kind === 'session' && a.sessionId === sessionId) return { kind: 'session', sessionId }
      if (a.kind === 'subagent' && a.childSessionId === sessionId && ['unknown', 'one-shot', 'continuable'].includes(a.mode)) {
        return { kind: 'subagent', parentSessionId: text(a.parentSessionId, 'parentSessionId'), childSessionId: sessionId, mode: a.mode }
      }
      fail('adapter/bad-request', 'address does not match sessionId')
    }
    const row = (await controller.list({}, signal)).items.find(row => row.sessionId === sessionId)
    return row?.origin === 'subagent'
      ? { kind: 'subagent', parentSessionId: text(row.parentSessionId, 'parentSessionId'), childSessionId: sessionId, mode: 'unknown' }
      : { kind: 'session', sessionId }
  }
  async function history(request, signal) {
    const sessionId = sid(request)
    const maxMessages = integer(request.maxMessages ?? 50, 1, 'maxMessages')
    if (maxMessages > 1000) fail('adapter/bad-request', 'maxMessages exceeds adapter bound')
    const beforeSeq = request.beforeSeq === undefined ? undefined : integer(request.beforeSeq, 0, 'beforeSeq')
    let token = request.historyToken
    let cut, snapshot
    if (token !== undefined) {
      text(token, 'historyToken')
      cut = cursors.get(token)
      if (!cut || cut.expires <= now() || cut.sessionId !== sessionId) fail('adapter/history-cut-expired', 'History token is expired or belongs to another session')
      if (request.address && JSON.stringify(request.address) !== JSON.stringify(cut.address)) fail('adapter/bad-request', 'History address changed')
    } else {
      if (beforeSeq !== undefined && options.requireHistoryToken) fail('adapter/history-token-required', 'Backward pagination requires historyToken from its opening page')
      const address = await addressFor(request, signal)
      const local = new AbortController()
      const readSignal = AbortSignal.any([signal, local.signal])
      try { snapshot = await first(controller.follow({ address, maxMessages }, readSignal), readSignal, 'snapshot') }
      finally { local.abort() }
      cut = { sessionId, address, cursor: snapshot.cursor, header: snapshot.header, projections: snapshot.projections, expires: now() + cursorTtlMs }
      pruneCursors(); token = id(); cursors.set(token, cut)
      if (beforeSeq !== undefined) diagnostic('adapter/history-fresh-cut')
    }
    const page = snapshot && beforeSeq === undefined ? snapshot
      : await controller.page({ address: cut.address, throughSeq: cut.cursor, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages }, signal)
    const events = page.records.map(record => {
      if (record.type !== 'event' || !object(record.event)) fail('adapter/protocol', 'Invalid history record')
      return record.event
    })
    return { events, hasMore: page.hasMore, projections: cut.projections, header: cut.header, throughSeq: cut.cursor,
      historyToken: token, consistency: request.historyToken ? 'pinned-cut' : beforeSeq === undefined ? 'opening-cut' : 'fresh-cut',
      nextBeforeSeq: events.length ? Math.min(...events.map(e => e.seq)) : undefined }
  }
  function promptRequest(request) {
    sid(request)
    if (!['queue', 'steer'].includes(request.mode)) fail('adapter/bad-request', 'mode must be queue or steer')
    if (!Array.isArray(request.content) || !request.content.length) fail('adapter/bad-request', 'content must not be empty')
    const content = request.content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
      if (part?.type === 'image' && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(part.mediaType)) {
        return { type: 'image', mediaType: part.mediaType, data: text(part.data, 'image.data'), ...(part.name === undefined ? {} : { name: text(part.name, 'image.name') }) }
      }
      if (part?.type === 'file') return { type: 'file', receiptId: text(part.receiptId, 'receiptId') }
      fail('adapter/bad-request', 'Unsupported content part')
    })
    if (!content.some(p => p.type !== 'text' || p.text.trim())) fail('adapter/bad-request', 'content must not be blank')
    let requestId = request.requestId
    if (requestId === undefined) {
      if (options.requireRequestId) fail('adapter/request-id-required', 'A stable requestId is required for each logical submission')
      requestId = promptIds.get(request)
      if (!requestId) { requestId = id(); promptIds.set(request, requestId); diagnostic('adapter/generated-request-id') }
    }
    return { ...fields(request, ['sessionId', 'mode', 'clientTimeZone']), content, requestId: text(requestId, 'requestId') }
  }

  const sessions = {
    list: (r = {}, s) => legacy(signal => controller.list(fields(r, ['cursor']), signal), s),
    search: (r, s) => legacy(signal => controller.search({ query: text(r?.query, 'query') }, signal), s),
    create: (r = {}, s) => legacy(() => {
      const req = fields(r, ['workspaceId', 'cwd', 'sessionId', 'agentPreset'])
      for (const key of Object.keys(req)) text(req[key], key)
      if (req.workspaceId !== undefined && req.cwd !== undefined) fail('adapter/bad-request', 'workspaceId and cwd are mutually exclusive')
      return controller.create(req)
    }, s),
    prompt: (r, s) => legacy(signal => controller.prompt(promptRequest(r), signal), s),
    history: (r, s) => legacy(signal => history(r, signal), s),
    rename: (r, s) => legacy(() => controller.rename({ sessionId: sid(r), title: text(r.title, 'title') }), s),
    attachment: (r, s) => legacy(() => controller.attachment({ sessionId: sid(r), attachmentId: text(r.attachmentId, 'attachmentId') }), s),
    selectModel: (r, s) => legacy(() => controller.selectModel({ sessionId: sid(r), provider: text(r.provider, 'provider'), model: text(r.model, 'model'), ...(r.reasoningEffort === undefined ? {} : { reasoningEffort: text(r.reasoningEffort, 'reasoningEffort') }) }), s),
    models: (r, s) => legacy(async signal => {
      const sessionId = sid(r)
      const [catalog, projections] = await Promise.all([controller.modelCatalog(), controller.projections({ sessionId }, signal)])
      if (!projections) fail('session/not-found', 'Session does not exist')
      const current = projections.values.modelSelection?.next ?? catalog.default
      return { ...catalog, current, routable: catalog.routableProviders.includes(current.provider) }
    }, s),
  }

  function resolved(entry, reason) {
    return { rpcId: entry.eventId, payload: entry.kind === 'approval'
      ? { type: 'approval/resolved', sessionId: entry.agentId, approvalId: entry.eventId, outcome: 'unknown', reason }
      : { type: 'question/resolved', sessionId: entry.agentId, questionRpcId: entry.eventId, outcome: 'unknown', reason } }
  }
  function requested(entry) {
    return { rpcId: entry.eventId, payload: entry.kind === 'approval'
      ? { type: 'approval/requested', sessionId: entry.agentId, approvalId: entry.eventId, approvalIdKind: 'adapter-event-id', toolName: entry.request.toolName, reason: entry.request.reason, callId: entry.request.callId }
      : { type: 'question/requested', sessionId: entry.agentId, questions: structuredClone(entry.request.questions) } }
  }
  function publish(channel, frame) {
    for (const sub of [...subscribers]) if (sub.channel === channel) sub.push(structuredClone(frame))
  }
  async function resultRpc(gen, eventId, outcome) {
    if (gen !== generation || !gen.clientId || gen.abort.signal.aborted) fail('adapter/disconnected', 'Interaction generation is no longer active')
    const rpcId = id()
    const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://dsh-inprocess.invalid/api/$events/result', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: signalFor(gen.abort.signal),
      body: JSON.stringify({ type: 'client-request', rpcId, method: '$events/result', payload: { args: { clientId: gen.clientId, eventId, outcome } } }),
    }))
    if (!response.ok) fail('adapter/transport', 'Interaction response transport failed')
    const reply = await response.json()
    if (reply.type !== 'server-response' || reply.rpcId !== rpcId || typeof reply.result?.ok !== 'boolean') fail('adapter/protocol', 'Invalid interaction response envelope')
    if (!reply.result.ok) throw new AdapterError(reply.result.error?.code ?? 'adapter/response-rejected', reply.result.error?.message ?? 'Interaction response rejected')
    // Intentionally no accepted:true. rc2 treats stale results as successful no-ops.
    return { accepted: false, submitted: true, settlement: 'unconfirmed', reason: 'winner-unconfirmed' }
  }
  async function frame(gen, value) {
    if (value?.type === 'ready') {
      if (gen.clientId) fail('adapter/protocol', 'Duplicate event ready frame')
      gen.clientId = text(value.clientId, 'clientId')
      for (const sub of subscribers) sub.open()
      return
    }
    if (!gen.clientId) fail('adapter/protocol', 'Event arrived before ready')
    if (value?.type === 'emit') {
      if (value.event === 'api-session/status') {
        const [sessionId, running] = value.args
        publish('host', { payload: { type: 'host/session-status', sessionId, running } })
      } else if (value.event === 'api-session/error') {
        const [sessionId, message] = value.args
        publish('host', { payload: { type: 'host/agent-error', sessionId, message } })
      }
      return
    }
    if (value?.type === 'cancel') {
      unsupportedInteractions.delete(value.eventId)
      const entry = pending.get(value.eventId)
      if (entry) { pending.delete(value.eventId); publish('mux', resolved(entry, 'settled-or-cancelled')) }
      return
    }
    if (value?.type !== 'waterfall') fail('adapter/protocol', 'Unknown event frame')
    const { eventId, agentId, request } = value
    text(eventId, 'eventId'); text(agentId, 'agentId')
    if (!object(request)) fail('adapter/protocol', 'Invalid waterfall request')
    const kind = value.event === 'approval/request' ? 'approval' : value.event === 'user-questions/request' ? 'question' : undefined
    const unsupported = !kind ? 'unsupported-event'
      : kind === 'question' && request.wait !== undefined ? 'unsupported-question-wait'
      : kind === 'question' && (!Array.isArray(request.questions) || !request.questions.length
        || request.questions.some(q => !object(q) || typeof q.id !== 'string' || !q.id.trim())) ? 'unsupported-question-shape'
      : kind === 'question' && !options.allowPlanReviewQuestions && request.questions.some(q => q.intent?.kind === 'plan-review') ? 'unsupported-plan-review'
      : undefined
    if (unsupported || ![...subscribers].some(sub => sub.channel === 'mux')) {
      diagnostic(unsupported ? 'adapter/unsupported-interaction' : 'adapter/no-interaction-consumer')
      if (unsupported) {
        while (unsupportedInteractions.size >= maxPending) unsupportedInteractions.delete(unsupportedInteractions.keys().next().value)
        unsupportedInteractions.set(eventId, { sessionId: agentId, reason: unsupported })
        publish('mux', { rpcId: eventId, payload: { type: 'interaction/unsupported', sessionId: agentId, reason: unsupported } })
      }
      await resultRpc(gen, eventId, { kind: 'next' }); return
    }
    if (pending.has(eventId)) return
    if (pending.size >= maxPending) { diagnostic('adapter/pending-overflow'); await resultRpc(gen, eventId, { kind: 'next' }); return }
    const entry = { kind, eventId, agentId, request: structuredClone(request), gen, submitting: false }
    pending.set(eventId, entry); publish('mux', requested(entry))
  }
  function ensurePump() {
    if (generation || lifetime.signal.aborted) return
    const gen = { abort: new AbortController(), clientId: undefined }
    generation = gen
    const task = (async () => {
      let failure
      try {
        const signal = AbortSignal.any([lifetime.signal, gen.abort.signal])
        const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, empty, undefined, signal)
        for await (const value of stream) { if (signal.aborted) break; await frame(gen, value) }
      } catch (error) { if (!gen.abort.signal.aborted && !lifetime.signal.aborted) failure = new AdapterError('adapter/event-stream', 'Host event stream failed') }
      finally {
        gen.abort.abort()
        if (generation === gen) {
          for (const entry of pending.values()) publish('mux', resolved(entry, 'disconnected'))
          pending.clear(); unsupportedInteractions.clear(); generation = undefined
          for (const sub of [...subscribers]) sub.finish(failure)
        }
      }
    })()
    tasks.add(task); void task.finally(() => tasks.delete(task))
  }
  function subscribe(channel, signal, onOpen) {
    if (lifetime.signal.aborted || signal?.aborted) return empty
    let queue = [], waiter, closed = false, error, opened = false
    const wake = () => { waiter?.(); waiter = undefined }
    const remove = () => {
      subscribers.delete(sub); signal?.removeEventListener('abort', abort)
      if (!subscribers.size || (channel === 'mux' && ![...subscribers].some(item => item.channel === 'mux'))) generation?.abort.abort()
    }
    const sub = {
      channel,
      push(value) {
        if (closed) return
        if (queue.length >= queueLimit) { queue = []; sub.finish(new AdapterError('adapter/event-overflow', 'Consumer must reconnect and reconcile state')); return }
        queue.push(value); wake()
      },
      open() { if (!opened && !closed) { opened = true; try { onOpen?.() } catch { diagnostic('adapter/open-callback-failed') } } },
      finish(reason) { if (closed) return; closed = true; error = reason; remove(); wake() },
    }
    const abort = () => { queue = []; sub.finish() }
    signal?.addEventListener('abort', abort, { once: true })
    subscribers.add(sub)
    if (generation?.clientId) sub.open()
    if (channel === 'mux') for (const entry of pending.values()) sub.push(requested(entry))
    ensurePump()
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            while (queue.length) yield queue.shift()
            if (closed) { if (error) throw error; return }
            await new Promise(resolve => { waiter = resolve })
          }
        } finally { abort() }
      },
    }
  }
  async function respond(response) {
    const unsupported = unsupportedInteractions.get(response?.rpcId)
    if (unsupported) return { accepted: false, submitted: false, reason: unsupported.reason, settlement: 'unsupported' }
    // A continued answer has no Gateway waterfall to settle. Do not confuse it with stale approval.
    if (response?.result?.value?.callId !== undefined) return { accepted: false, submitted: false, reason: 'unsupported-continued-question', settlement: 'unsupported' }
    const entry = pending.get(response?.rpcId)
    if (!entry) return { accepted: false, submitted: false, reason: 'not-pending', settlement: 'unknown' }
    if (entry.submitting) return { accepted: false, submitted: false, reason: 'submission-in-flight', settlement: 'unknown' }
    const value = response?.result?.value
    if (response.type !== 'client-response' || response.result?.ok !== true || !object(value) || value.sessionId !== entry.agentId) {
      return { accepted: false, submitted: false, reason: 'bad-response', settlement: 'unknown' }
    }
    let outcome
    if (entry.kind === 'approval') {
      if (value.approvalId !== entry.eventId || !['allowed-once', 'rejected'].includes(value.outcome)) return { accepted: false, submitted: false, reason: 'bad-response', settlement: 'unknown' }
      outcome = value.outcome
    } else {
      const answers = value.answer?.answers
      const questions = entry.request.questions
      const ids = new Set(Array.isArray(answers) ? answers.map(a => a?.id) : [])
      if (!Array.isArray(answers) || ids.size !== answers.length || answers.length !== questions.length
        || !questions.every(q => ids.has(q.id)) || !answers.every(a => {
          const q = questions.find(q => q.id === a?.id)
          return q && Array.isArray(a.selected) && a.selected.every(v => typeof v === 'string' && (q.options ?? []).some(o => o.label === v))
            && new Set(a.selected).size === a.selected.length && (q.multiSelect === true || a.selected.length <= 1)
            && (a.custom === undefined || typeof a.custom === 'string')
            && (q.multiSelect === true || !a.custom?.trim() || a.selected.length === 0)
            && (a.selected.length > 0 || a.custom?.trim())
        })) return { accepted: false, submitted: false, reason: 'bad-response', settlement: 'unknown' }
      outcome = { answers: answers.map(a => ({ id: a.id, selected: [...a.selected], ...(a.custom === undefined ? {} : { custom: a.custom }) })) }
    }
    entry.submitting = true
    try {
      const receipt = await resultRpc(entry.gen, entry.eventId, { kind: 'result', value: outcome })
      if (pending.get(entry.eventId) === entry) { pending.delete(entry.eventId); publish('mux', resolved(entry, 'submitted-unconfirmed')) }
      return receipt
    } catch {
      diagnostic('adapter/interaction-submit-uncertain')
      return { accepted: false, submitted: false, reason: 'transport-uncertain', settlement: 'unknown' }
    } finally { entry.submitting = false }
  }
  return {
    sessions,
    llm: { models: (_r = {}, s) => legacy(() => controller.modelCatalog(), s) },
    agentPresets: { list: (_r = {}, s) => legacy(() => {
      if (!ctx.agentPresets?.remoteExportList) fail('adapter/service-unavailable', 'Agent preset roster is unavailable')
      return ctx.agentPresets.remoteExportList()
    }, s) },
    permissionPresets: {
      catalog: (_r = {}, s) => legacy(() => {
        if (!ctx.permissionPresets?.catalog) fail('adapter/service-unavailable', 'Permission catalog is unavailable')
        return ctx.permissionPresets.catalog()
      }, s),
      current: (r, s) => legacy(async signal => {
        const projection = await controller.projections({ sessionId: sid(r) }, signal)
        if (!projection) fail('session/not-found', 'Session does not exist')
        if (!projection.values.permissions) fail('adapter/service-unavailable', 'Session has no permissions projection')
        return projection.values.permissions
      }, s),
      select: (r, s) => legacy(async signal => {
        const sessionId = sid(r); const preset = text(r.preset, 'preset')
        if (!ctx.permissionPresets?.catalog) fail('adapter/service-unavailable', 'Permission catalog is unavailable')
        const catalog = await ctx.permissionPresets.catalog()
        if (!catalog.options.some(option => option.value === preset) || /[\r\n]/.test(preset)) fail('adapter/bad-request', 'Preset is not selectable')
        // Preserve the owner's human command path and its approval-policy notification.
        // Direct permissionPresets.set(session,preset) is not the live command path.
        const admitted = await controller.prompt(promptRequest({ sessionId, mode: 'queue', requestId: r.requestId,
          content: [{ type: 'text', text: `/permission ${preset}` }] }), signal)
        return { ...admitted, requestedPreset: preset, applied: false, verification: 'pending-command' }
      }, s),
    },
    workspace: {
      list: (_r = {}, s) => legacy(async signal => {
        const local = new AbortController(); const joined = AbortSignal.any([signal, local.signal])
        try { return (await first(ctx.workspaceController.follow(joined), joined, 'baseline')).value }
        finally { local.abort() }
      }, s),
      unarchiveSession: (r, s) => legacy(() => ctx.workspaceController.unarchiveSession({sessionId:sid(r)}), s),
      archiveSession: (r, s) => legacy(() => {
        if (r.stopActivity !== undefined && typeof r.stopActivity !== 'boolean') fail('adapter/bad-request', 'stopActivity must be boolean')
        return ctx.workspaceController.archiveSession({ sessionId: sid(r), ...(r.stopActivity === undefined ? {} : { stopActivity: r.stopActivity }) })
      }, s),
    },
    events: { mux: (_r = {}, signal, onOpen) => subscribe('mux', signal, onOpen), host: (_r = {}, signal, onOpen) => subscribe('host', signal, onOpen) },
    respond,
    capabilities: Object.freeze({ authoritativeInteractionReceipt: false, timedQuestions: false, continuedQuestions: false, rawCurrentFormatHistory: true }),
    newRequestId: () => id(),
    getInteractionState: () => ({ connected: Boolean(generation?.clientId), pending: [...pending.values()].map(e => ({ eventId: e.eventId, sessionId: e.agentId, kind: e.kind })) }),
    async dispose() { lifetime.abort(); generation?.abort.abort(); for (const sub of [...subscribers]) sub.finish(); await Promise.allSettled([...tasks]); pending.clear(); cursors.clear() },
  }
}
export default createDispatchHostAdapter
