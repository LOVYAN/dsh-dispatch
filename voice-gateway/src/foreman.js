import { saveForemanSessionId, saveSessionDigestWriterSessionId, saveSessionTagSelectorSessionId, saveHistoryEvidenceSummarizerSessionId } from './config.js'
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

export async function searchDispatchHistory(cfg, queries, preferredSessionId = '') {
	const r = await fetch(cfg.dispatchBase + '/dispatch/history-search', {
		method: 'POST', headers: headers(cfg),
		body: JSON.stringify({ stage: 'literal', queries, preferredSessionId, excludedSessionIds: [cfg.historyResearcherSessionId, cfg.foremanSessionId].filter(Boolean) }), signal: AbortSignal.timeout(120000)
	})
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('history search failed: ' + JSON.stringify(body))
	return body
}

export async function fetchPendingSessionDigests(cfg, limit = 5) {
	const exclude = [cfg.historyResearcherSessionId, cfg.sessionDigestWriterSessionId, cfg.sessionTagSelectorSessionId, cfg.historyEvidenceSummarizerSessionId, cfg.foremanSessionId].filter(Boolean).join(',')
	const r = await fetch(cfg.dispatchBase + '/dispatch/session-digests/pending?token=' + encodeURIComponent(cfg.dispatchToken) + '&limit=' + encodeURIComponent(limit) + '&exclude=' + encodeURIComponent(exclude), { signal: AbortSignal.timeout(120000) })
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('pending digests failed: ' + JSON.stringify(body))
	return body.items || []
}

export async function fetchSessionTagCatalog(cfg) {
	const r = await fetch(cfg.dispatchBase + '/dispatch/session-tag-catalog?token=' + encodeURIComponent(cfg.dispatchToken), { signal: AbortSignal.timeout(15000) })
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('tag catalog failed: ' + JSON.stringify(body))
	return body.catalog || {}
}

export async function saveSessionDigest(cfg, sessionId, digest, metadata) {
	const r = await fetch(cfg.dispatchBase + '/dispatch/session-digest', { method: 'POST', headers: headers(cfg), body: JSON.stringify({ sessionId, digest, metadata }), signal: AbortSignal.timeout(15000) })
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('save digest failed: ' + JSON.stringify(body))
	return body.digest
}

export async function searchDispatchTags(cfg, criteria, preferredSessionId = '') {
	const r = await fetch(cfg.dispatchBase + '/dispatch/history-search', { method: 'POST', headers: headers(cfg), body: JSON.stringify({ stage: 'tags', criteria, preferredSessionId }), signal: AbortSignal.timeout(15000) })
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('tag search failed: ' + JSON.stringify(body))
	return body
}

export async function fetchDispatchHistory(cfg, sessionId, { maxPages = 4, maxMessages = 60, maxChars = 90000 } = {}) {
	const messages = []
	let beforeSeq
	let title = ''
	for (let page = 0; page < maxPages; page += 1) {
		const qs = new URLSearchParams({ token: cfg.dispatchToken, maxMessages: String(maxMessages) })
		if (beforeSeq !== undefined) qs.set('beforeSeq', String(beforeSeq))
		const r = await fetch(cfg.dispatchBase + '/dispatch/session-history/' + encodeURIComponent(sessionId) + '?' + qs.toString(), { signal: AbortSignal.timeout(15000) })
		const body = await readBody(r)
		if (!r.ok || !body.ok) throw new Error('session history failed: ' + JSON.stringify(body))
		title ||= String(body.title || '')
		messages.unshift(...(body.messages || []))
		if (!body.hasMore || body.nextBeforeSeq === undefined) break
		beforeSeq = body.nextBeforeSeq
		const chars = messages.reduce((sum, message) => sum + String(message.text || '').length, 0)
		if (chars >= maxChars) break
	}
	return { sessionId, title, messages }
}

export async function saveDispatchHistoryCard(cfg, scope, card) {
	const r = await fetch(cfg.dispatchBase + '/dispatch/history-card', {
		method: 'POST', headers: headers(cfg), body: JSON.stringify({ scope, ...card }), signal: AbortSignal.timeout(10000)
	})
	const body = await readBody(r)
	if (!r.ok || !body.ok) throw new Error('history card failed: ' + JSON.stringify(body))
	return body.card
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
		let running = false
		try {
			const [st, sessions] = await Promise.all([dispatchStatus(cfg), listDispatchSessions(cfg)])
			pendingHere = (st.pending || []).some((p) => p.sessionId === sessionId)
				|| (st.pendingQuestions || []).some((p) => p.sessionId === sessionId)
			running = Boolean(sessions.find((s) => s.sessionId === sessionId)?.running)
		} catch {
			pendingHere = false
		}
		const waiting = running || pendingHere
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

function parseJsonObject(raw) {
	const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
	try { return JSON.parse(text) } catch { /* find object */ }
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start >= 0 && end > start) {
		try { return JSON.parse(text.slice(start, end + 1)) } catch { /* fallback */ }
	}
	return null
}

const SESSION_DIGEST_WRITER_PREAMBLE = `【会话摘要器】你只负责把所附真实会话证据压缩为结构化索引卡片，不执行任务，不修改会话，不补写证据中没有的事实。只输出严格 JSON：{"cards":[{"sessionId":"原ID","summary":"短摘要","topics":[],"subjects":[],"problems":[],"carriers":[],"outcomes":[],"keywords":[],"lastRelevantAt":0}]}。每个输入会话恰好一张卡片，sessionId原样返回。主题最多5个、主体8个、问题8个、载体6个、结论6个、关键词15个；标签短而具体。`
const SESSION_TAG_SELECTOR_PREAMBLE = `【历史标签选择器】你只负责把一个用户问题映射到系统提供的现有标签目录。只能逐字选择目录里已有的标签，禁止创造、改写或补充任何标签，禁止根据以前轮次记忆选择。只输出严格 JSON：{"topics":[],"subjects":[],"problems":[],"carriers":[],"outcomes":[],"keywords":[],"from":0,"to":0}。先把问题分成“检索动作”和“目标内容”：以前、之前、曾经、历史里、找一下、查一下、记录里只是检索动作或时间修饰语，绝不能据此选择历史检索、搜索功能、索引、摘要等系统元标签；除非用户明确询问这些系统本身。只根据目标内容选择直接描述主题、主体、问题和载体的少量标签。`
const HISTORY_EVIDENCE_SUMMARIZER_PREAMBLE = `【历史证据总结器】你只根据当前请求附带的来源会话、命中片段和历史消息回答用户问题。禁止引用以前轮次记忆，禁止输出JSON搜索计划，禁止执行任务或修改会话。先给结论，再说明来源、原因、处理方式和证据不足之处；适合中文语音朗读。`

async function runSessionDigestWriter(cfg, instruction, opts = {}) {
	let sessionId = cfg.sessionDigestWriterSessionId
	let previousText = ''
	if (sessionId) {
		try { previousText = lastAssistantFromHtml(await fetchChatHtml(cfg, sessionId)) } catch { /* empty */ }
	}
	if (!sessionId) {
		const r = await fetch(cfg.dispatchBase + '/dispatch/task', { method: 'POST', headers: headers(cfg), body: JSON.stringify({ text: SESSION_DIGEST_WRITER_PREAMBLE + '\n\n' + instruction, mode: 'queue' }), signal: AbortSignal.timeout(15000) })
		const body = await readBody(r)
		if (!r.ok || !body.ok || !body.sessionId) throw new Error('create digest writer failed: ' + JSON.stringify(body))
		sessionId = body.sessionId
		saveSessionDigestWriterSessionId(cfg, sessionId)
	} else await sayToForeman(cfg, sessionId, instruction)
	const done = await waitUntilIdle(cfg, sessionId, { ...opts, previousText, timeoutMs: opts.timeoutMs || 240000 })
	return { sessionId, raw: done.text }
}

export async function updatePendingSessionDigests(cfg, { limit = 4, signal } = {}) {
	const pending = await fetchPendingSessionDigests(cfg, limit)
	if (!pending.length) return []
	const sections = pending.map((item) => {
		const compact = String(item.compactionSummary || '').slice(0, 18000)
		const turn = item.turnResult ? `最近轮次：\n用户：${item.turnResult.instruction}\n结论：${item.turnResult.result}` : ''
		const recent = (item.messages || []).slice(-35).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.text || '').slice(0, 1200)}`).join('\n')
		return `会话ID：${item.sessionId}\n标题：${item.title}\n更新时间：${item.updatedAt}\n压缩摘要：\n${compact}\n${turn}\n最近消息：\n${recent}`
	})
	const done = await runSessionDigestWriter(cfg, `生成会话摘要卡片\n\n${sections.join('\n\n---\n\n')}`.slice(0, 100000), { signal, timeoutMs: 240000 })
	const parsed = parseJsonObject(done.raw) || {}
	const cards = Array.isArray(parsed.cards) ? parsed.cards : []
	const saved = []
	for (const item of pending) {
		const digest = cards.find((card) => String(card?.sessionId || '') === item.sessionId)
		if (!digest) continue
		saved.push(await saveSessionDigest(cfg, item.sessionId, digest, { title: item.title, updatedAt: item.updatedAt, sourceSeq: item.sourceSeq, compactionId: item.compactionId }))
	}
	return saved
}

async function runSessionTagSelector(cfg, instruction, opts = {}) {
	let sessionId = cfg.sessionTagSelectorSessionId
	let previousText = ''
	if (sessionId) {
		try { previousText = lastAssistantFromHtml(await fetchChatHtml(cfg, sessionId)) } catch { /* empty */ }
	}
	if (!sessionId) {
		const r = await fetch(cfg.dispatchBase + '/dispatch/task', { method: 'POST', headers: headers(cfg), body: JSON.stringify({ text: SESSION_TAG_SELECTOR_PREAMBLE + '\n\n' + instruction, mode: 'queue' }), signal: AbortSignal.timeout(15000) })
		const body = await readBody(r)
		if (!r.ok || !body.ok || !body.sessionId) throw new Error('create tag selector failed: ' + JSON.stringify(body))
		sessionId = body.sessionId
		saveSessionTagSelectorSessionId(cfg, sessionId)
	} else await sayToForeman(cfg, sessionId, instruction)
	const done = await waitUntilIdle(cfg, sessionId, { ...opts, previousText, timeoutMs: opts.timeoutMs || 180000 })
	return { sessionId, raw: done.text }
}

export async function planTagSearch(cfg, userText, catalog, opts = {}) {
	const instruction = `选择历史标签\n当前时间：${Date.now()}\n用户问题：${String(userText || '').slice(0, 1200)}\n可用标签目录：\n${JSON.stringify(catalog).slice(0, 50000)}`
	const done = await runSessionTagSelector(cfg, instruction, opts)
	const parsed = parseJsonObject(done.raw) || {}
	const result = { from: Number(parsed.from || 0), to: Number(parsed.to || 0) }
	for (const field of ['topics', 'subjects', 'problems', 'carriers', 'outcomes', 'keywords']) {
		const allowed = new Set((catalog[field] || []).map(String))
		result[field] = [...new Set((Array.isArray(parsed[field]) ? parsed[field] : []).map(String).filter((x) => allowed.has(x)))].slice(0, 12)
	}
	return result
}

async function runHistoryEvidenceSummarizer(cfg, instruction, opts = {}) {
	let sessionId = cfg.historyEvidenceSummarizerSessionId
	let previousText = ''
	if (sessionId) {
		try { previousText = lastAssistantFromHtml(await fetchChatHtml(cfg, sessionId)) } catch { /* empty */ }
	}
	if (!sessionId) {
		const r = await fetch(cfg.dispatchBase + '/dispatch/task', { method: 'POST', headers: headers(cfg), body: JSON.stringify({ text: HISTORY_EVIDENCE_SUMMARIZER_PREAMBLE + '\n\n' + instruction, mode: 'queue' }), signal: AbortSignal.timeout(15000) })
		const body = await readBody(r)
		if (!r.ok || !body.ok || !body.sessionId) throw new Error('create evidence summarizer failed: ' + JSON.stringify(body))
		sessionId = body.sessionId
		saveHistoryEvidenceSummarizerSessionId(cfg, sessionId)
	} else await sayToForeman(cfg, sessionId, instruction)
	const done = await waitUntilIdle(cfg, sessionId, { ...opts, previousText, timeoutMs: opts.timeoutMs || 180000 })
	return { sessionId, raw: done.text }
}

export async function summarizeHistoryEvidence(cfg, userText, evidence, opts = {}) {
	const compact = evidence.slice(0, 3).map((source, index) => {
		const messages = source.messages.slice(-120).map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.text || '').slice(0, 2500)}`).join('\n')
		return `来源${index + 1}：${source.title}\n命中片段：${(source.snippets || []).join('；')}\n历史消息：\n${messages}`
	}).join('\n\n')
	const instruction = `证据总结\n用户问题：${String(userText || '').slice(0, 1200)}\n\n${compact.slice(0, 80000)}`
	const done = await runHistoryEvidenceSummarizer(cfg, instruction, opts)
	return { raw: done.raw, speech: summarizeForSpeech(done.raw), researcherSessionId: done.sessionId }
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
