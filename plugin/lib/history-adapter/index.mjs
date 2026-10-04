/** Read-only HUMAN transcript projection, not model-surface reconstruction.
 * Evidence and integration contract: README.md. No host/DOM/filesystem dependencies.
 */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const seq = x => Number.isSafeInteger(x) && x >= 0
const surfaces = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])
const logOnly = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'assistant/attempt', 'tool/call', 'request/header', 'request/context', 'session/end-seed'])
const raster = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const nonempty = x => typeof x === 'string' && x.length > 0
const commandTypes = new Set(['command/run', 'command/done'])

/** Separate display-only ledger: never a user/model message or executable action. */
function projectCommands(events, note, taintedIds) {
  const groups = new Map()
  for (const ev of events) {
    if (!commandTypes.has(ev.type)) continue
    const id = ev.data?.commandId
    if (!nonempty(id)) { note('invalid-command-id', ev); continue }
    const group = groups.get(id) ?? []
    group.push(ev)
    groups.set(id, group)
  }
  const records = []
  for (const [commandId, group] of groups) {
    const runs = group.filter(ev => ev.type === 'command/run')
    const outcomes = group.filter(ev => ev.type === 'command/done')
    if (taintedIds.has(commandId) || runs.length > 1 || outcomes.length > 1) {
      for (const ev of group) note('ambiguous-command-id', ev)
      continue
    }
    const run = runs[0], done = outcomes[0]
    if (!run) { note('command-run-not-in-window', done); continue }
    const data = run.data
    if (!seq(run.seq) || run.surfaceOp !== undefined || !nonempty(data.name) ||
        data.source?.kind !== 'user' || (data.args !== undefined && typeof data.args !== 'string')) {
      note('invalid-command-run', run); continue
    }
    const record = { kind: 'historical-command', commandId, seq: run.seq,
      ...(typeof run.time === 'number' && Number.isFinite(run.time) ? { time: run.time } : {}),
      name: data.name, inputRecorded: data.args !== undefined,
      ...(data.args !== undefined ? { args: data.args } : {}),
      status: 'outcome-not-in-window' }
    // Missing args are deliberately not reconstructed from arbitrary domain payloads.
    if (data.args === undefined) note('command-input-domain-owned', run)
    if (!done) note('command-outcome-not-in-window', run)
    else {
      const outcome = done.data
      const source = outcome.sourceEventSeq
      const referenced = source === undefined ? undefined : events.find(ev => ev.seq === source)
      if (!seq(done.seq) || done.surfaceOp !== undefined ||
          !['success', 'error'].includes(outcome.kind) ||
          (outcome.text !== undefined && typeof outcome.text !== 'string') ||
          (source !== undefined && (outcome.kind !== 'success' || !seq(source) || source >= done.seq ||
            (referenced && commandTypes.has(referenced.type))))) {
        record.status = 'invalid-outcome'
        note('invalid-command-outcome', done)
      } else if (done.seq <= run.seq) {
        record.status = 'invalid-outcome'
        note('command-outcome-before-run', done)
      } else {
        record.status = outcome.kind
        // Only schema-declared public UI outcome text; never spread event/raw data.
        record.outcome = { seq: done.seq, kind: outcome.kind,
          ...(typeof done.time === 'number' && Number.isFinite(done.time) ? { time: done.time } : {}),
          ...(outcome.text !== undefined ? { text: outcome.text } : {}),
          ...(source !== undefined ? { sourceEventSeq: source } : {}) }
        if (source !== undefined) note('command-domain-presentation-unprojected', done)
      }
    }
    records.push(record)
  }
  return records.sort((a, b) => a.seq - b.seq)
}
// Stable comparison for overlapping pages; object property order is not identity.
const canonical = x => JSON.stringify(x, function (key, value) {
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value
})

/**
 * Accept raw events or {type:'event',event} records from ONE session/cut.
 * Returns {messages, commandRecords, diagnostics, complete}. complete means no detected omissions,
 * NOT that the supplied history window covers the whole session.
 * options.legacy permits missing surfaceOp/seq and old nested user envelopes;
 * it must be chosen by the caller, never inferred from a malformed rc2 event.
 * Inputs must be JSON values. No event, block, stream, or projection is modified.
 */
export function normalizeHistory(entries, { legacy = false } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  const diagnostics = []
  let complete = true
  const note = (code, ev, omission = true) => {
    diagnostics.push({ code, ...(seq(ev?.seq) ? { seq: ev.seq } : {}) })
    if (omission) complete = false
  }
  const indexed = new Map(), unsequenced = [], conflicts = new Set(), taintedCommandIds = new Set()
  for (const entry of entries) {
    // Legacy callers historically wrapped events without a type discriminator.
    const ev = object(entry) && (entry.type === 'event' || (legacy && !entry.type && entry.event)) ? entry.event : entry
    if (!object(ev) || typeof ev.type !== 'string') { note('invalid-event', ev); continue }
    if (ev.type === 'assistant-stream') { note('live-stream-unsupported', ev); continue }
    if (!seq(ev.seq)) {
      if (legacy && ev.seq === undefined) unsequenced.push(ev)
      else note('invalid-seq', ev)
      continue
    }
    if (indexed.has(ev.seq)) {
      if (canonical(indexed.get(ev.seq)) !== canonical(ev)) {
        if (!conflicts.has(ev.seq)) note('conflicting-seq', ev)
        conflicts.add(ev.seq)
        for (const conflicting of [ev, indexed.get(ev.seq)]) {
          if (commandTypes.has(conflicting.type) && nonempty(conflicting.data?.commandId)) taintedCommandIds.add(conflicting.data.commandId)
        }
      }
    } else indexed.set(ev.seq, ev)
  }
  // Mixing sequenced and unsequenced legacy inputs has no safe chronological order.
  if (indexed.size && unsequenced.length) {
    note('mixed-sequence-domains', undefined)
    unsequenced.length = 0
  }
  const events = [...indexed.values()].filter(ev => !conflicts.has(ev.seq)).sort((a, b) => a.seq - b.seq).concat(unsequenced)
  const commandRecords = projectCommands(events, note, taintedCommandIds)
  const messages = []
  for (const ev of events) {
    if (commandTypes.has(ev.type)) continue
    if (!surfaces.has(ev.type)) {
      if (!logOnly.has(ev.type) && ev.ignorable !== true) note('unknown-required-event', ev)
      if (logOnly.has(ev.type) && ev.surfaceOp !== undefined) note('unexpected-surface-op', ev)
      continue
    }
    const op = ev.surfaceOp
    if (object(op) && op.op === 'replace') {
      // Transcript keeps originals; do NOT apply model-only compaction replacements.
      if (!seq(op.startSeq) || !seq(op.endSeq) || !seq(ev.seq) || op.startSeq >= ev.seq || op.endSeq >= ev.seq) note('invalid-replacement', ev)
      continue
    }
    if (op !== 'append' && !(legacy && op === undefined)) { note('missing-or-unknown-surface-op', ev); continue }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const role = ev.type === 'user/message' ? 'user' : 'assistant'
    const message = role === 'assistant' ? ev.data?.message ?? (legacy ? ev.data : undefined)
      : legacy ? ev.data?.message ?? ev.data : ev.data
    if (!object(message) || !Array.isArray(message.content)) { note('invalid-message', ev); continue }
    const source = message.source
    let kind = 'message'
    if (role === 'user') {
      if (source?.kind === 'user-question-reply') {
        if (!nonempty(source.callId) || source.outcome !== 'answered') { note('invalid-late-reply', ev); continue }
        kind = 'question-reply'
      } else if (source?.kind !== 'user') {
        if (!(legacy && source === undefined)) { note('non-human-source-omitted', ev, false); continue }
      }
    }
    const texts = [], images = [], files = []
    for (const block of message.content) {
      if (!object(block)) { note('invalid-content-block', ev); continue }
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      else if (['reasoning', 'thinking', 'redacted_thinking', 'tool-call'].includes(block.type)) continue
      else if (block.type === 'image' || (legacy && block.type === 'image_url')) {
        const attachment = object(block.attachment) ? block.attachment : legacy ? block : {}
        const mediaType = attachment.mediaType ?? (legacy ? block.media_type : undefined)
        const attachmentId = attachment.attachmentId
        if (!raster.has(mediaType)) { note('unsupported-image', ev); continue }
        if (nonempty(attachmentId)) images.push({ attachmentId, mediaType })
        else if (legacy && nonempty(block.data)) {
          const data = block.data.replace(/^data:[^;]+;base64,/, '')
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(data)) images.push({ data, mediaType })
          else note('unsupported-image', ev)
        } else note('unsupported-image', ev)
      } else if (block.type === 'file' && nonempty(block.attachment?.attachmentId)) {
        files.push(structuredClone(block.attachment))
      } else note('unsupported-content-block', ev)
    }
    const text = texts.join('\n').trim()
    if (!text && !images.length && !files.length) continue
    messages.push({ role, text, images, files, kind,
      ...(seq(ev.seq) ? { seq: ev.seq } : {}),
      ...(typeof ev.time === 'number' && Number.isFinite(ev.time) ? { time: ev.time } : {}),
      ...(nonempty(message.id) ? { messageId: message.id } : {}),
      ...(kind === 'question-reply' ? { callId: source.callId, outcome: 'answered' } : {}),
      ...(role === 'assistant' && ev.data?.interrupted === true ? { interrupted: true } : {}) })
  }
  return { messages, commandRecords, diagnostics, complete }
}

/** Compatibility row array; prefer normalizeHistory so diagnostics are not lost. */
export function foldHistory(entries, options) { return normalizeHistory(entries, options).messages }
