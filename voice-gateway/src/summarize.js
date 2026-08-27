const MAX = 400

export function summarizeForSpeech(raw) {
	let t = String(raw || '')
	t = t.replace(/```[\s\S]*?```/g, '（细节在会话页）')
	t = t.replace(/`([^`]+)`/g, '$1')
	t = t.replace(/https?:\/\/\S+/gi, '链接')
	t = t.replace(/!\[[^\]]*]\([^)]*\)/g, '')
	t = t.replace(/\[[^\]]*]\([^)]*\)/g, '$1')
	t = t.replace(/^#{1,6}\s+/gm, '')
	t = t.replace(/^\s*[-*+]\s+/gm, '')
	t = t.replace(/[*_~>#]+/g, '')
	t = t.replace(/\|/g, '，')
	t = t.replace(/&nbsp;/g, ' ')
	t = t.replace(/&amp;/g, '&')
	t = t.replace(/&lt;/g, '<')
	t = t.replace(/&gt;/g, '>')
	t = t.replace(/<[^>]+>/g, '')
	t = t.replace(/\s+/g, ' ').trim()
	if (t.length <= MAX) return t
	const cut = t.slice(0, MAX)
	const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('. '))
	if (idx >= 80) return cut.slice(0, idx + 1)
	return cut + '…'
}

export function looksLikeConfirmDispatch(text) {
	const t = String(text || '').trim()
	if (!t) return false
	return /去派单|派单吧|^派单[。！!]*$|开始派单|按这个做|按这个执行|可以去做了|确认执行|^确认(吧)?[。！!]*$|^确定(吧)?[。！!]*$|可以执行|就这么办|去让电脑做|交给电脑|开始执行|开工吧/.test(t)
		&& !/不要派|先别|还没|再改|先改/.test(t)
		&& !/(吗|么|嘛|要不要|是否|可不可以|能不能)[？?。！!]*$/u.test(t)
}

export function looksLikeWork(text) {
	const t = String(text || '').trim()
	if (!t) return false
	if (/^(你好|您好|在吗|嗨|哈喽|早上好|晚上好|谢谢|好的|嗯|哦|啊)$/u.test(t)) return false
	return /看|查|打开|标记|已读|改|修复|运行|帮我|任务|计划|进度|好了没|怎么样了|还在吗|卡了吗|运营|数据|日志|库存|费比|n8n|文件|网页|浏览器|拆|子任务|汇总|汇报|批准|审批/.test(t)
}

export function looksLikeSmallTalk(text) {
	return !looksLikeWork(text)
}
