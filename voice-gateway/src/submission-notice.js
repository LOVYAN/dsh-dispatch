// Submission acknowledgement is not completion; observer cancellation is not task cancellation.
export function submissionFailureNotice({ admitted = false, closed = false } = {}) {
  if (closed) return { silent: true, message: '通话已结束；停止本地结果等待，电脑任务状态未判定。' }
  return {
    silent: false,
    message: admitted
      ? '任务已确认提交，但暂时无法确认执行结果。请核查原会话，不要重复提交。'
      : '暂时无法确认任务是否提交成功。请核查原请求，不要重复提交或换新请求编号重试。'
  }
}
