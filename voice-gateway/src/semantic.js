const DOMAIN_REPLACEMENTS = [
	[/绘画/g, '对话'],
	[/对画/g, '对话'],
	[/会画/g, '会话'],
	[/当前规划(?=.{0,8}(执行)?结果)/g, '当前对话'],
	[/当前绘话/g, '当前对话'],
	[/死刑(?=结果|结论|小结)/g, '执行'],
	[/实刑(?=结果|结论|小结)/g, '执行'],
	[/执型(?=结果|结论|小结)/g, '执行'],
	[/(拍单|排单|派丹|拍丹)/g, '派单'],
	[/确+确认/g, '确认']
]

/**
 * 对 Harness 语音命令做保守的领域语义规范化。
 * 只修复在“会话/执行结果”语境中高频出现的同音错字，不自由改写普通对谈。
 */
export function normalizeHarnessSpeech(raw, { assistantMode = 'session', hasBoundSession = false } = {}) {
	const original = String(raw || '').trim()
	let text = original
	for (const [pattern, replacement] of DOMAIN_REPLACEMENTS) text = text.replace(pattern, replacement)

	const resultIntent = /(总结|概括|汇总|查看|读取|识别|复述|汇报|读|念|说).{0,18}(执行结果|任务结果|完成结果|结果|结论|小结)/.test(text)
	const allScope = /(所有|全部|这几个|现行|未归档).{0,8}(对话|会话|聊天)/.test(text)
	const namedOther = /(另一个|其他|那个).{0,8}(对话|会话|聊天)/.test(text)

	return {
		original,
		text,
		resultIntent,
		allScope,
		defaultCurrent: assistantMode === 'session' && hasBoundSession && resultIntent && !allScope && !namedOther,
		changed: text !== original
	}
}
