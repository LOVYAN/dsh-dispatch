import { saveForemanSessionId } from './config.js'
import { summarizeForSpeech } from './summarize.js'

export const FOREMAN_PREAMBLE = `【语音工头】你是本机 DeepSeek Harness 的总控。用户通过电话跟你说话，回复要适合朗读：短句、先结论、不要代码块、不要 URL、不要 markdown 表格。

规则：
1. 用户一次丢多件事：先拆成清单，先讲打算怎么做、谁先谁后、要不要并行开子任务。等用户明确说「按这个做 / 可以 / 开始」再执行。
2. 需要隔离或并行时用 subagent 开子会话，不要让外部网关替你开。子任务互不依赖就并行。
3. 汇报时自己读取各 subagent 的最终结果或结算内容，汇总成口语。不要说「请到电脑上看完整日志」代替结论，除非结论确实需要看图/看表。
4. 查网页、运营数据系统、改文件必须用已有工具和 MCP，禁止编造「已经标已读 / 已经改好」。
5. delegated subagent 的审批被禁用。子任务若遇到权限不足，必须返回需要执行的工具、完整参数、理由和影响；你作为主会话亲自重放该操作来发起审批。审批会显示在当前手机会话页。不要让子任务自行越权、绕过或直接结束整个工作。
6. 主会话需要审批时，说明用户可在当前手机会话页点批准；你继续等待，不要假装已批准。
7. 用户问进度：只基于当前子任务真实状态回答，不要新开一串重复任务。

用户第一句话：`

function headers(cfg) {
	return {
		Authorization: 'Bearer ' + cfg.dispatchToken,
		'Content-Type': 'application/json'
	}
}

async function readBody(res) {
	const text = await res.text()
	try { return JSON.parse(text) } catch { return { raw: text } }
}

export async function dispatchHealth(cfg) {
	try {
		const r = await fetch(cfg.dispatchBase + '/dispatch/health', { signal: AbortSignal.timeout(4000) })
		if (!r.ok) return { ok: false, error: 'http ' + r.status }
		return await r.json()
	} catch (err) {
		return { ok: false, error: String(err?.message ?? err) }
	}
}

export async function dispatchStatus(cfg) {
	const r = await fetch(
		cfg.dispatchBase + '/dispatch/status?token=' + encodeURIComponent(cfg.dispatchToken),
		{ signal: AbortSignal.timeout(8000) }
	)
	if (!r.ok) throw new Error('status http ' + r.status)
	return r.json()
}

export async function listDispatchSessions(cfg) {
	const r = await fetch(
		cfg.dispatchBase + '/dispatch/sessions?token=' + encodeURIComponent(cfg.dispatchToken),
		{ signal: AbortSignal.timeout(10000) }
	)
	if (!r.ok) throw new Error('sessions http ' + r.status)
	const body = await r.json()
	return Array.isArray(body.sessions) ? body.sessions : []
}

export function matchDispatchSessions(sessions, spokenText, limit = 3) {
	const clean = (s) => String(s || '').toLowerCase()
		.replace(/(帮我|请|一下|这个|当前|本次|对话|会话|聊天|结果|结论|总结|查看|读取)/g, '')
		.replace(/[\s，。！？、,.!?“”"'：:；;]/g, '')
	const query = clean(spokenText)
	if (!query) return []
	const scored = sessions.map((session) => {
		const title = clean(session.title)
		let score = 0
		let exact = false
		if (title && query.includes(title)) { score += 100 + title.length; exact = true }
		if (query && title.includes(query)) score += 80 + query.length
		for (let n = Math.min(8, title.length); n >= 2; n--) {
			let hit = false
			for (let i = 0; i + n <= title.length; i++) {
				if (query.includes(title.slice(i, i + n))) { score += n * n; hit = true; break }
			}
			if (hit) break
		}
		return { session, score, exact }
	}).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
	if (!scored.length) return []
	if (scored[0].exact || !scored[1] || scored[0].score >= scored[1].score * 1.6) return [scored[0].session]
	return scored.slice(0, limit).map((x) => x.session)
}

export async function ensureForeman(cfg, firstUserText) {
	if (cfg.foremanSessionId) return cfg.foremanSessionId
	const boot = FOREMAN_PREAMBLE + '\n' + firstUserText
	const r = await fetch(cfg.dispatchBase + '/dispatch/task', {
		method: 'POST',
		headers: headers(cfg),
		body: JSON.stringify({ text: boot, mode: 'queue' })
	})
	const j = await readBody(r)
	if (!r.ok || !j.ok) throw new Error('create foreman: ' + JSON.stringify(j))
	saveForemanSessionId(cfg, j.sessionId)
	return j.sessionId
}

export async function dispatchIndependentTask(cfg, text) {
	const r = await fetch(cfg.dispatchBase + '/dispatch/task', {
		method: 'POST',
		headers: headers(cfg),
		body: JSON.stringify({ text, mode: 'queue' }),
		signal: AbortSignal.timeout(15000)
	})
	const body = await readBody(r)
	if (!r.ok || !body.ok || !body.sessionId) throw new Error('independent task create failed: ' + JSON.stringify(body))
	return { sessionId: body.sessionId }
}

export async function sayToForeman(cfg, sessionId, userText) {
	const r = await fetch(cfg.dispatchBase + '/dispatch/chat/' + encodeURIComponent(sessionId), {
		method: 'POST',
		headers: headers(cfg),
		body: JSON.stringify({ text: userText }),
		redirect: 'manual'
	})
	if (r.status >= 400) {
		const j = await readBody(r)
		throw new Error('prompt failed ' + r.status + ' ' + JSON.stringify(j))
	}
}

export function lastAssistantFromHtml(html) {
	const all = [...String(html).matchAll(/<div class="msg assistant"><div class="meta">助手<\/div>([\s\S]*?)<\/div>/g)]
	const raw = all.length ? all[all.length - 1][1] : ''
	return decodeEntities(stripTags(raw)).trim()
}

export function recentAssistantSummaryFromHtml(html, maxMessages = 10) {
	const all = [...String(html).matchAll(/<div class="msg assistant"><div class="meta">助手<\/div>([\s\S]*?)<\/div>/g)]
	const seen = new Set()
	const rows = all.slice(-maxMessages)
		.map((m) => decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.filter((text) => {
			if (/^(我会|我先|现在|接下来|开始|继续|正在|已开始|稍等|为了稳妥|我准备)/.test(text) && !/(完成|结果|结论|通过|失败|在线|已修复|已部署)/.test(text)) return false
			const key = text.replace(/[，。！？、\s]/g, '').slice(0, 80)
			if (!key || seen.has(key)) return false
			seen.add(key)
			return true
		})
	const scored = rows.map((text, index) => ({
		text,
		index,
		score: (/(结论|结果|完成|通过|失败|已修复|已部署|已验证|当前状态|原因)/.test(text) ? 3 : 0)
			+ (/(接下来|我会|我先|正在)/.test(text) ? -2 : 0)
			+ index / 100
	}))
	const picked = scored.sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.index - b.index)
	return summarizeForSpeech(picked.map((x) => x.text).join('\n'))
}

export function chatWaiting(html) {
	return /进行中/.test(html) || /自动刷新/.test(html)
}

function stripTags(s) {
	return String(s).replace(/<img[\s\S]*?>/g, '').replace(/<[^>]+>/g, '')
}

function decodeEntities(s) {
	return String(s)
		.replace(/&nbsp;/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

export async function fetchSessionResult(cfg, sessionId) {
	const r = await fetch(
		cfg.dispatchBase + '/dispatch/session-result/' + encodeURIComponent(sessionId)
			+ '?token=' + encodeURIComponent(cfg.dispatchToken),
		{ signal: AbortSignal.timeout(8000) }
	)
	if (!r.ok) throw new Error('session result http ' + r.status)
	const data = await readBody(r)
	return data?.result ? { ...data.result, title: data.title || '' } : null
}

export async function fetchChatHtml(cfg, sessionId) {
	const r = await fetch(
		cfg.dispatchBase + '/dispatch/chat/' + encodeURIComponent(sessionId)
			+ '?token=' + encodeURIComponent(cfg.dispatchToken),
		{ signal: AbortSignal.timeout(12000) }
	)
	if (!r.ok) throw new Error('chat html http ' + r.status)
	return r.text()
}

export async function inspectBoundSession(cfg, sessionId) {
	const html = await fetchChatHtml(cfg, sessionId)
	let pending = []
	try {
		const st = await dispatchStatus(cfg)
		pending = (st.pending || []).filter((p) => p.sessionId === sessionId)
	} catch { /* empty */ }
	const approvalBanners = (String(html).match(/<div class="banner"><strong>需要审批/g) || []).length
	let turnResult = null
	try { turnResult = await fetchSessionResult(cfg, sessionId) } catch { /* legacy fallback */ }
	return {
		sessionId,
		running: chatWaiting(html),
		pending,
		approvalCount: Math.max(pending.length, approvalBanners),
		turnResult,
		lastAssistant: lastAssistantFromHtml(html),
		recentSummary: turnResult?.result ? summarizeForSpeech(turnResult.result) : ''
	}
}

export async function summarizeActiveSessions(cfg, sessions, { limit = 8 } = {}) {
	const selected = [...sessions]
		.filter((s) => !s.archived)
		.sort((a, b) => Number(b.running) - Number(a.running) || Number(b.pending > 0) - Number(a.pending > 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
		.slice(0, limit)
	const rows = await Promise.all(selected.map(async (session) => {
		try {
			const state = await Promise.race([
				inspectBoundSession(cfg, session.sessionId),
				new Promise((_, reject) => setTimeout(() => reject(new Error('session summary timeout')), 6000))
			])
			const summary = state.recentSummary || state.lastAssistant || '暂无结果'
			return { ...session, summary, running: state.running, approvalCount: state.approvalCount }
		} catch {
			return { ...session, summary: '读取超时', approvalCount: session.pending || 0 }
		}
	}))
	return { rows, total: sessions.filter((s) => !s.archived).length }
}

export async function waitUntilIdle(cfg, sessionId, { timeoutMs = 15 * 60 * 1000, intervalMs = 4000, signal, previousText } = {}) {
	const t0 = Date.now()
	let sawRunning = false
	while (Date.now() - t0 < timeoutMs) {
		if (signal?.aborted) throw new Error('aborted')
		const html = await fetchChatHtml(cfg, sessionId)
		let pendingHere = false
		try {
			const st = await dispatchStatus(cfg)
			pendingHere = (st.pending || []).some((p) => p.sessionId === sessionId)
		} catch {
			pendingHere = false
		}
		const waiting = chatWaiting(html) || pendingHere
		if (waiting) sawRunning = true
		const text = lastAssistantFromHtml(html)
		const changed = previousText === undefined || text !== previousText
		if (!waiting && text && (sawRunning || changed)) {
			return { html, pendingHere, text }
		}
		await sleep(intervalMs, signal)
	}
	throw new Error('foreman timeout')
}

export async function handleBoundSessionUtterance(cfg, sessionId, userText, opts = {}) {
	let previousText = ''
	try { previousText = lastAssistantFromHtml(await fetchChatHtml(cfg, sessionId)) } catch { /* empty */ }
	await sayToForeman(cfg, sessionId, userText)
	const done = await waitUntilIdle(cfg, sessionId, { ...opts, previousText })
	let pendingNote = ''
	try {
		const st = await dispatchStatus(cfg)
		if ((st.pending || []).length) pendingNote = '需要你在当前手机会话页批准权限。'
	} catch { /* ignore */ }
	const speech = summarizeForSpeech(done.text)
	return {
		sessionId,
		speech: pendingNote ? (speech + ' ' + pendingNote) : speech,
		raw: done.text
	}
}

/** First user utterance: create includes the text; later ones only continue. */
export async function handleUserUtterance(cfg, userText, opts = {}) {
	const had = Boolean(cfg.foremanSessionId)
	let previousText
	if (had) {
		try { previousText = lastAssistantFromHtml(await fetchChatHtml(cfg, cfg.foremanSessionId)) } catch { previousText = '' }
	} else {
		previousText = ''
	}
	const sessionId = await ensureForeman(cfg, userText)
	if (had) await sayToForeman(cfg, sessionId, userText)
	const done = await waitUntilIdle(cfg, sessionId, { ...opts, previousText })
	let pendingNote = ''
	try {
		const st = await dispatchStatus(cfg)
		if ((st.pending || []).length) pendingNote = '需要你在手机会话页点批准。'
	} catch { /* ignore */ }
	const speech = summarizeForSpeech(done.text)
	return {
		sessionId,
		speech: pendingNote ? (speech + ' ' + pendingNote) : speech,
		raw: done.text
	}
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms)
		if (!signal) return
		const onAbort = () => {
			clearTimeout(t)
			reject(new Error('aborted'))
		}
		if (signal.aborted) return onAbort()
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

export async function resetForeman(cfg) {
	saveForemanSessionId(cfg, '')
}
