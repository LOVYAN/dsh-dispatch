// A settled assistant turn is not proof that the user's objective succeeded.
export function classifyTurnOutcome(record, { sessionId, previousSourceSeq } = {}) {
  const uncertain = { outcome: 'unknown', raw: '', speech: '', notice: '任务已确认提交，但暂时无法确认本次执行结果。请核查原会话，不要重复提交。' }
  if (!Number.isSafeInteger(previousSourceSeq) || previousSourceSeq < 0
    || record?.sessionId !== sessionId || !Number.isSafeInteger(record?.sourceSeq)
    || record.sourceSeq <= previousSourceSeq || typeof record.isError !== 'boolean'
    || typeof record.result !== 'string' || !record.result.trim()) return uncertain
  return {
    outcome: record.isError ? 'error' : 'reply',
    sourceSeq: record.sourceSeq,
    raw: record.result,
    notice: record.isError
      ? '电脑本轮执行未正常完成。可以对我说读结果；请核查原会话，不要重复提交。'
      : '电脑本轮有回复了，尚不能据此确认整个任务完成。需要的话，对我说读结果。'
  }
}
