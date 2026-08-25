// dsh-dispatch v0.1.0 — phone dispatch + lock-screen approval bridge.
//
// Architecture (verified against DSH 0.1.0-rc.6 sources):
//   1. Approval bridge: an in-process API client (InProcessApiClient over
//      toFetchHandler(ctx.apiProxy)) subscribes to the mux downlink exactly like
//      a browser tab. `approval/requested` frames arrive with their stable rpcId,
//      so decisions can be answered through ctx respond() without touching the
//      approval waterfall — zero interference with the GUI answerer, no
//      listener-order sensitivity, first responder wins, replay on reconnect.
//   2. Push (optional): POST JSON to ntfy.sh (or a self-hosted ntfy). Android
//      action buttons call back /dispatch/decision. Approvals also render on
//      /dispatch/chat so ntfy is not required.
//   3. Dispatch: POST /dispatch/task or the chat form → sessions.create + prompt.
//      GET /dispatch/chat reads session.history for a phone-sized transcript.
//
// All HTTP surface lives under /dispatch/* on the main webserver and is guarded
// by a shared token. The /api trust fence does not cover these paths, so the
// token IS the auth.

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { createHash, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const OUTCOMES = new Set(['allowed-once', 'rejected'])
const MAX_BODY = 1024 * 1024

export class DispatchService extends Service {
	static inject = ['webServer', 'apiProxy']

	static Config = z.object({
		token: z.string().required(),
		/** Phone-reachable base for decision links, e.g. https://pc.example.ts.net (empty = log-only links). */
		publicBaseUrl: z.string().default(''),
		/** Co-located ntfy server base URL. */
		ntfyServerUrl: z.string().default('http://127.0.0.1:2586'),
		ntfyTopic: z.string().default('dsh-dispatch'),
		/** Optional ntfy publish auth token. */
		ntfyToken: z.string().default(''),
		/** Master switch for push notifications (routes stay active either way). */
		pushEnabled: z.boolean().default(false),
		/** Mux reconnect delay after a stream error. */
		reconnectMs: z.natural().default(2000)
	})

	constructor(ctx, config) {
		super(ctx, 'dispatch')
		this.config = config
		this.log = (...a) => console.log('[dsh-dispatch]', ...a)
		/** rpcId → {sessionId, approvalId, toolName, reason?, at} */
		this.pending = new Map()
		/** 稳定键 `${sessionId}/${approvalId}` → rpcId（用于 resolved 清理与去重） */
		this.pendingByKey = new Map()
		/** Seen frame rpcIds (replay dedupe), capped FIFO. */
		this.seen = new Set()
		this.seenOrder = []
		/** Small diagnostic ring of recent decisions/pushes. */
		this.events = []
		this.muxAbort = null
		this.hostAbort = null
		/** sessionId → {snippet, at} for dispatched tasks awaiting a completion push. */
		this.trackedTasks = new Map()
		this.client = new InProcessApiClient(toFetchHandler(this.ctx.apiProxy), 15000)
		this.start()
	}

	get pendingCount() { return this.pending.size }

	note(kind, data) {
		this.events.push({ at: new Date().toISOString(), kind, ...data })
		if (this.events.length > 100) this.events.shift()
	}

	markSeen(rpcId) {
		if (this.seen.has(rpcId)) return false
		this.seen.add(rpcId)
		this.seenOrder.push(rpcId)
		while (this.seenOrder.length > 500) this.seen.delete(this.seenOrder.shift())
		return true
	}

	checkToken(candidate) {
		if (typeof candidate !== 'string' || candidate.length === 0) return false
		const a = createHash('sha256').update(candidate).digest()
		const b = createHash('sha256').update(this.config.token).digest()
		return timingSafeEqual(a, b)
	}

	tokenFrom(req, urlObj) {
		const q = urlObj.searchParams.get('token')
		if (q) return q
		const auth = req.headers.authorization ?? ''
		return auth.startsWith('Bearer ') ? auth.slice(7) : ''
	}

	start() {
		// ── routes ──────────────────────────────────────────────────────────
		this.ctx.effect(() => this.ctx.webServer.register({
			kind: 'prefix',
			path: '/dispatch',
			handler: (req, res) => { void this.handle(req, res) }
		}), 'dsh-dispatch: routes')
		// ── approval bridge loop ───────────────────────────────────────────
		this.ctx.effect(() => {
			const controller = new AbortController()
			this.muxAbort = controller
			void this.muxLoop(controller)
			return () => controller.abort()
		}, 'dsh-dispatch: mux bridge')
		// ── completion-receipt loop (host stream) ─────────────────────────
		this.ctx.effect(() => {
			const controller = new AbortController()
			this.hostAbort = controller
			void this.hostLoop(controller)
			return () => controller.abort()
		}, 'dsh-dispatch: host bridge')
		this.log(`active (push=${this.config.pushEnabled ? 'on' : 'off'}, topic=${this.config.ntfyTopic}, publicBase=${this.config.publicBaseUrl || '(none)'})`)
	}

	async muxLoop(controller) {
		for (;;) {
			try {
				const stream = this.client.events.mux({}, controller.signal, () => this.log('mux stream open'))
				for await (const envelope of stream) {
					const frame = envelope?.payload
					if (frame && frame.type === 'approval/requested') this.onApprovalRequested(envelope.rpcId, frame)
					else if (frame && frame.type === 'approval/resolved') {
						// 别处（如网页端）已答复 —— 按稳定键清掉我们的挂起项
						const key = `${frame.sessionId}/${frame.approvalId}`
						const staleRpc = this.pendingByKey.get(key)
						if (staleRpc !== undefined) {
							this.pending.delete(staleRpc)
							this.pendingByKey.delete(key)
							this.note('resolved-elsewhere', { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: frame.outcome })
						}
					}
				}
				this.log('mux stream ended')
			} catch (err) {
				if (controller.signal.aborted) return
				this.log('mux error:', err?.message ?? err)
			}
			if (controller.signal.aborted) return
			await new Promise((resolve) => setTimeout(resolve, this.config.reconnectMs))
			if (controller.signal.aborted) return
		}
	}

	async hostLoop(controller) {
		for (;;) {
			try {
				const stream = this.client.events.host({}, controller.signal, () => this.log('host stream open'))
				for await (const envelope of stream) {
					const frame = envelope?.payload
					if (!frame) continue
					if (frame.type === 'host/session-status' && frame.running === false && this.trackedTasks.has(frame.sessionId)) {
						const info = this.trackedTasks.get(frame.sessionId)
						this.trackedTasks.delete(frame.sessionId)
						this.log(`task turn finished → ${frame.sessionId}`)
						if (this.config.pushEnabled) void this.pushTurnDone(frame.sessionId, info, false)
					} else if (frame.type === 'host/agent-error' && this.trackedTasks.has(frame.sessionId)) {
						const info = this.trackedTasks.get(frame.sessionId)
						this.trackedTasks.delete(frame.sessionId)
						if (this.config.pushEnabled) void this.pushTurnDone(frame.sessionId, info, true, frame.message)
					}
				}
				this.log('host stream ended')
			} catch (err) {
				if (controller.signal.aborted) return
				this.log('host error:', err?.message ?? err)
			}
			if (controller.signal.aborted) return
			await new Promise((resolve) => setTimeout(resolve, this.config.reconnectMs))
			if (controller.signal.aborted) return
		}
	}

	onApprovalRequested(rpcId, frame) {
		// 去重用稳定键：approvalId 是审计关联的确定派生，跨重放恒定；rpcId 理论上重放复用但不赌它
		const dedupeKey = `${frame.sessionId}/${frame.approvalId}`
		if (!this.markSeen(dedupeKey)) return // 重放帧，已推过
		const entry = {
			sessionId: frame.sessionId,
			approvalId: frame.approvalId,
			toolName: frame.toolName,
			reason: frame.reason ?? ''
		}
		this.pending.set(rpcId, entry)
		this.pendingByKey.set(dedupeKey, rpcId)
		this.note('approval-requested', { rpcId, ...entry })
		this.log(`approval requested session=${frame.sessionId} tool=${frame.toolName} reason=${entry.reason}`)
		if (this.config.pushEnabled) void this.notify(rpcId, entry)
	}

	buildDecisionUrl(rpcId, outcome) {
		const qs = new URLSearchParams({
			token: this.config.token,
			rpcId,
			sessionId: this.pending.get(rpcId)?.sessionId ?? '',
			approvalId: this.pending.get(rpcId)?.approvalId ?? '',
			outcome
		})
		return `${this.config.publicBaseUrl}/dispatch/decision?${qs.toString()}`
	}

	async notify(rpcId, entry) {
		const title = `🔐 审批请求 · ${entry.toolName}`
		const at = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
		const lines = [`发出：${at}`, `工具：${entry.toolName}`]
		if (entry.reason) lines.push(`原因：${entry.reason}`)
		lines.push(`会话：${entry.sessionId}`)
		let message = lines.join('\n')
		if (!this.config.publicBaseUrl) message += '\n(未配置 publicBaseUrl，按钮不可用)'
		const actions = [
			{ action: 'http', label: '✅ 批准', url: this.buildDecisionUrl(rpcId, 'allowed-once'), clear: true },
			{ action: 'http', label: '❌ 拒绝', url: this.buildDecisionUrl(rpcId, 'rejected'), clear: true },
			{ action: 'view', label: '打开会话', url: this.chatUrl(entry.sessionId), clear: false }
		].filter((a) => Boolean(this.config.publicBaseUrl))
		await this.push(title, message, actions, rpcId)
	}

	async push(title, message, actions = [], rpcIdForLog = '') {
		if (!this.config.pushEnabled) return
		const body = {
			topic: this.config.ntfyTopic,
			title,
			message,
			priority: 4, // 数字！经 http://ntfy.sh 的 80 端口时字符串 "high" 会被中间盒拒掉
			tags: ['key'],
			actions
		}
		try {
			await this.postJson(`${this.config.ntfyServerUrl}`, body, this.config.ntfyToken)
			this.note('pushed', { title, rpcId: rpcIdForLog })
		} catch (err) {
			this.note('push-failed', { title, rpcId: rpcIdForLog, error: String(err?.message ?? err) })
			this.log('ntfy push failed:', err?.message ?? err)
		}
	}

	postJson(base, body, bearer) {
		return new Promise((resolve, reject) => {
			// HTTP 明文过墙时多字节 UTF-8 会被中间盒损坏 → 全部转义成 \uXXXX（纯 ASCII 线上格式）
			const data = JSON.stringify(body).replace(/[\u0080-\uFFFF]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
			let url
			try { url = new URL(base) } catch { return reject(new Error(`bad url: ${base}`)) }
			const mod = url.protocol === 'https:' ? httpsRequest : httpRequest
			const req = mod(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(data),
					...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
				},
				timeout: 8000
			}, (res) => {
				const chunks = []
				res.on('data', (c) => chunks.push(c))
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8')
					if (res.statusCode >= 200 && res.statusCode < 300) resolve(text)
					else reject(new Error(`ntfy ${res.statusCode}: ${text.slice(0, 200)}`))
				})
			})
			req.on('timeout', () => req.destroy(new Error('ntfy timeout')))
			req.on('error', reject)
			req.end(data)
		})
	}

	readBody(req) {
		return new Promise((resolve, reject) => {
			let size = 0
			const chunks = []
			req.on('data', (chunk) => {
				size += chunk.length
				if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
				chunks.push(chunk)
			})
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
			req.on('error', reject)
		})
	}

	sendJson(res, status, obj) {
		const data = JSON.stringify(obj)
		res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
		res.end(data)
	}

	escHtml(s) {
		return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
	}

	sendHtml(res, html, status = 200) {
		res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
		res.end(html)
	}

	redirect(res, location) {
		res.writeHead(303, { Location: location })
		res.end()
	}

	chatUrl(sessionId) {
		const qs = new URLSearchParams({ token: this.config.token })
		if (!sessionId) return `${this.config.publicBaseUrl}/dispatch/chat?${qs.toString()}`
		return `${this.config.publicBaseUrl}/dispatch/chat/${encodeURIComponent(sessionId)}?${qs.toString()}`
	}

	chatPath(sessionId) {
		const qs = new URLSearchParams({ token: this.config.token })
		if (!sessionId) return `/dispatch/chat?${qs.toString()}`
		return `/dispatch/chat/${encodeURIComponent(sessionId)}?${qs.toString()}`
	}

	blocksText(blocks) {
		if (!Array.isArray(blocks)) return ''
		return blocks.map((b) => {
			if (!b || typeof b !== 'object') return ''
			if (b.type === 'thinking' || b.type === 'reasoning' || b.type === 'redacted_thinking') return ''
			if (typeof b.text === 'string') return b.text
			return ''
		}).filter(Boolean).join('\n').trim()
	}

	visibleAssistantText(raw) {
		const stripped = String(raw ?? '')
			.replace(/<think>[\s\S]*?<\/think>/gi, '')
			.replace(/The user [^\n]{20,}\n+/g, '')
			.trim()
		return stripped || String(raw ?? '').trim()
	}

	foldHistory(entries) {
		const out = []
		for (const entry of entries ?? []) {
			const ev = entry?.event ?? entry
			if (!ev || typeof ev !== 'object') continue
			if (ev.type === 'user/message') {
				const src = ev.data?.source ?? ev.data?.message?.source
				const kind = src?.kind
				if (kind && kind !== 'user') continue
				const text = this.blocksText(ev.data?.content ?? ev.data?.message?.content)
				if (text) out.push({ role: 'user', text, time: ev.time })
			} else if (ev.type === 'assistant/message') {
				const text = this.visibleAssistantText(this.blocksText(ev.data?.message?.content ?? ev.data?.content))
				if (text) out.push({ role: 'assistant', text, time: ev.time })
			}
		}
		return out
	}

	sessionTitleOf(row) {
		const v = row?.projections?.values?.title
		if (typeof v === 'string' && v.trim()) return v.trim()
		if (v && typeof v === 'object') {
			const t = v.title ?? v.value ?? v.text
			if (typeof t === 'string' && t.trim()) return t.trim()
		}
		return (row?.sessionId ?? 'session').slice(-12)
	}

	async lastAssistantText(sessionId) {
		try {
			const hist = await this.client.sessions.history({ sessionId, maxMessages: 16 })
			if (!hist.result.ok) return ''
			const folded = this.foldHistory(hist.result.value.events)
			for (let i = folded.length - 1; i >= 0; i--) {
				if (folded[i].role === 'assistant') return folded[i].text
			}
		} catch (err) {
			this.log('history peek failed:', err?.message ?? err)
		}
		return ''
	}

	async pushTurnDone(sessionId, info, isError, errMsg) {
		const reply = isError ? '' : await this.lastAssistantText(sessionId)
		const title = isError ? '⚠️ 任务出错' : '✅ 任务完成'
		const parts = []
		if (info?.snippet) parts.push(info.snippet)
		if (isError && errMsg) parts.push(String(errMsg).slice(0, 200))
		if (reply) parts.push(reply.slice(0, 500))
		parts.push('会话：' + sessionId)
		const actions = this.config.publicBaseUrl
			? [{ action: 'view', label: '打开会话', url: this.chatUrl(sessionId) }]
			: []
		await this.push(title, parts.join('\n\n'), actions, sessionId)
	}

	pageShell(title, body, extraHead = '') {
		return [
			'<!doctype html><html><head><meta charset="utf-8">',
			'<meta name="viewport" content="width=device-width,initial-scale=1">',
			'<title>' + this.escHtml(title) + '</title>',
			extraHead,
			'<style>',
			'body{margin:0;font-family:system-ui,sans-serif;background:#0b132b;color:#e6f1ff}',
			'a{color:#8be9fd} header,main,form{max-width:720px;margin:0 auto;padding:12px}',
			'header{display:flex;gap:12px;align-items:center;border-bottom:1px solid #1c2541}',
			'.msg{margin:10px 0;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45}',
			'.user{background:#1c2541} .assistant{background:#193c3a}',
			'.meta{opacity:.55;font-size:12px;margin-bottom:4px}',
			'textarea,input[type=text]{width:100%;box-sizing:border-box;background:#1c2541;color:#e6f1ff;border:1px solid #3a506b;border-radius:10px;padding:10px;font:inherit}',
			'button{background:#3a86ff;color:#fff;border:0;border-radius:10px;padding:10px 16px;font:inherit;margin-top:8px}',
			'.row{padding:12px 0;border-bottom:1px solid #1c2541}',
			'.muted{opacity:.65;font-size:13px}',
			'.banner{background:#3d2b1f;border:1px solid #e09f3e;border-radius:12px;padding:12px;margin:12px 0}',
			'.banner form{display:flex;gap:8px;padding:0;margin:8px 0 0}',
			'.banner button{margin:0}',
			'.deny{background:#6c757d}',
			'</style></head><body>',
			body,
			'</body></html>'
		].join('')
	}

	/** 手机按钮点按后的可视化结果页（比裸 JSON 友好得多）。 */
	sendResultPage(res, icon, headline, detail, extraHtml = '') {
		const html = [
			'<!doctype html><html><head><meta charset="utf-8">',
			'<meta name="viewport" content="width=device-width,initial-scale=1">',
			'<title>dsh-dispatch</title></head>',
			'<body style="margin:0;font-family:system-ui,sans-serif;background:#0b132b;color:#e6f1ff;',
			'display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:16px">',
			'<div><div style="font-size:72px;line-height:1">' + icon + '</div>',
			'<h2 style="margin:16px 0 8px">' + this.escHtml(headline) + '</h2>',
			'<p style="opacity:.65;font-size:13px;margin:0">' + this.escHtml(detail) + '</p>',
			extraHtml,
			'</div></body></html>'
		].join('')
		this.sendHtml(res, html)
	}

	async handle(req, res) {
		const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
		if (!urlObj.pathname.startsWith('/dispatch')) return this.sendJson(res, 404, { ok: false })
		try {
			const route = urlObj.pathname
			if (route === '/dispatch/health' && req.method === 'GET') {
				return this.sendJson(res, 200, { ok: true, pending: this.pending.size })
			}
			if (!this.checkToken(this.tokenFrom(req, urlObj))) {
				if (route.startsWith('/dispatch/chat') || route === '/dispatch/decision') {
					return this.sendResultPage(res, '🔒', '未授权', '链接里的 token 丢失或无效。请从带 token 的会话页重新打开，不要直接访问无参数地址。')
				}
				return this.sendJson(res, 401, { ok: false, error: 'unauthorized' })
			}
			if (route === '/dispatch/status' && req.method === 'GET') {
				return this.sendJson(res, 200, {
					ok: true,
					pending: [...this.pending.entries()].map(([rpcId, e]) => ({ rpcId, ...e })),
					recent: this.events.slice(-20)
				})
			}
			if (route === '/dispatch/decision') return await this.handleDecision(urlObj, res)
			if (route === '/dispatch/task' && req.method === 'POST') return await this.handleTask(req, res)
			if (route === '/dispatch/chat' && req.method === 'GET') return await this.handleChatList(urlObj, res)
			if (route === '/dispatch/chat' && req.method === 'POST') return await this.handleChatNew(req, urlObj, res)
			if (route.startsWith('/dispatch/chat/') && req.method === 'GET') {
				return await this.handleChatView(route.slice('/dispatch/chat/'.length), urlObj, res)
			}
			if (route.startsWith('/dispatch/chat/') && req.method === 'POST') {
				return await this.handleChatReply(route.slice('/dispatch/chat/'.length), req, urlObj, res)
			}
			return this.sendJson(res, 404, { ok: false, error: 'not-found' })
		} catch (err) {
			this.log('handler error:', err?.stack ?? err)
			if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
		}
	}

	async applyDecision(rpcId, outcome, sessionId, approvalId) {
		const receipt = await this.client.respond({
			type: 'client-response',
			rpcId,
			result: { ok: true, value: { sessionId, approvalId, outcome } }
		})
		this.pending.delete(rpcId)
		for (const [k, v] of this.pendingByKey) if (v === rpcId) { this.pendingByKey.delete(k); break }
		this.note('decided', { rpcId, outcome, receipt })
		this.log(`decision ${outcome} for ${sessionId}/${approvalId} → receipt=${JSON.stringify(receipt)}`)
		return receipt
	}

	async handleDecision(urlObj, res) {
		const rpcId = urlObj.searchParams.get('rpcId') ?? ''
		const outcome = urlObj.searchParams.get('outcome') ?? ''
		const sessionId = urlObj.searchParams.get('sessionId') ?? ''
		const approvalId = urlObj.searchParams.get('approvalId') ?? ''
		if (!OUTCOMES.has(outcome)) return this.sendJson(res, 400, { accepted: false, reason: 'bad-response' })
		if (!this.pending.has(rpcId)) {
			return this.sendResultPage(res, '⏳', '该审批已被处理', '可能电脑端已先行答复 —— 无需重复操作',
				sessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(sessionId))}" style="color:#8be9fd">打开会话</a></p>` : '')
		}
		const receipt = await this.applyDecision(rpcId, outcome, sessionId, approvalId)
		if (!receipt.accepted) {
			return this.sendResultPage(res, '⏳', '该审批已被处理', '电脑端已先行答复 —— 无需重复操作',
				sessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(sessionId))}" style="color:#8be9fd">打开会话</a></p>` : '')
		}
		this.sendResultPage(res,
			outcome === 'allowed-once' ? '✅' : '🚫',
			outcome === 'allowed-once' ? '已批准 · 会话继续' : '已拒绝',
			'session …' + sessionId.slice(-12),
			sessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(sessionId))}" style="color:#8be9fd">打开会话 · 看回复 / 续聊</a></p>` : '')
	}

	async handleChatList(_urlObj, res) {
		const listed = await this.client.sessions.list({})
		if (!listed.result.ok) return this.sendJson(res, 502, { ok: false, error: listed.result.error })
		const items = (listed.result.value.items ?? []).filter((s) => !s.blank).slice(0, 30)
		const pendingBySid = new Map()
		for (const [, e] of this.pending) {
			pendingBySid.set(e.sessionId, (pendingBySid.get(e.sessionId) ?? 0) + 1)
		}
		const rows = items.map((s) => {
			const href = this.chatPath(s.sessionId)
			const title = this.escHtml(this.sessionTitleOf(s))
			const run = s.running ? ' 运行中' : ''
			const need = pendingBySid.get(s.sessionId) ? ' · 待审批' : ''
			const cwd = s.cwd ? this.escHtml(s.cwd) : ''
			return `<div class="row"><a href="${this.escHtml(href)}">${title}</a><div class="muted">${this.escHtml(s.sessionId.slice(-12))}${run}${need}${cwd ? ' · ' + cwd : ''}</div></div>`
		}).join('')
		const body = [
			'<header><strong>dsh 手机会话</strong></header><main>',
			'<form method="post" action="' + this.escHtml(this.chatPath()) + '">',
			'<textarea name="text" rows="3" placeholder="新开一个会话，说你要它干什么…" required></textarea>',
			'<button type="submit">发送</button></form>',
			rows || '<p class="muted">还没有会话</p>',
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell('dsh 会话', body))
	}

	async handleChatNew(req, urlObj, res) {
		const fields = await this.readForm(req, urlObj)
		const text = (fields.text ?? '').trim()
		if (!text) return this.sendHtml(res, this.pageShell('dsh', '<main><p>内容不能为空</p></main>'), 400)
		const created = await this.client.sessions.create({})
		if (!created.result.ok) return this.sendJson(res, 502, { ok: false, stage: 'create', error: created.result.error })
		const sessionId = created.result.value.sessionId
		const prompted = await this.client.sessions.prompt({
			sessionId,
			mode: 'queue',
			content: [{ type: 'text', text }]
		})
		if (!prompted.result.ok) return this.sendJson(res, 502, { ok: false, stage: 'prompt', sessionId, error: prompted.result.error })
		this.note('task', { sessionId, mode: 'queue', text: text.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: text.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`chat dispatched → ${sessionId}`)
		this.redirect(res, this.chatPath(sessionId))
	}

	async handleChatView(rawId, urlObj, res) {
		const sessionId = decodeURIComponent(rawId.split('?')[0])
		const decideRpc = urlObj.searchParams.get('decide')
		const decideOut = urlObj.searchParams.get('outcome')
		if (decideRpc && OUTCOMES.has(decideOut ?? '')) {
			await this.applyDecision(decideRpc, decideOut, sessionId, this.pending.get(decideRpc)?.approvalId ?? '')
			return this.redirect(res, this.chatPath(sessionId))
		}
		const hist = await this.client.sessions.history({ sessionId, maxMessages: 40 })
		if (!hist.result.ok) {
			return this.sendHtml(res, this.pageShell('会话', `<main><p>读历史失败：${this.escHtml(JSON.stringify(hist.result.error))}</p></main>`), 502)
		}
		const folded = this.foldHistory(hist.result.value.events)
		const msgs = folded.map((m) => {
			const who = m.role === 'user' ? '你' : '助手'
			return `<div class="msg ${m.role}"><div class="meta">${who}</div>${this.escHtml(m.text)}</div>`
		}).join('') || '<p class="muted">还没有可见消息（可能还在跑工具）</p>'
		const pendingHere = [...this.pending.entries()].filter(([, e]) => e.sessionId === sessionId)
		const banners = pendingHere.map(([rpcId, e]) => {
			const allow = this.chatPath(sessionId) + '&decide=' + encodeURIComponent(rpcId) + '&outcome=allowed-once'
			const deny = this.chatPath(sessionId) + '&decide=' + encodeURIComponent(rpcId) + '&outcome=rejected'
			return [
				'<div class="banner"><strong>需要审批 · ' + this.escHtml(e.toolName) + '</strong>',
				'<div class="muted">' + this.escHtml((e.reason || '').slice(0, 400)) + '</div>',
				'<p style="margin:10px 0 0;display:flex;gap:8px;flex-wrap:wrap">',
				'<a href="' + this.escHtml(allow) + '" style="display:inline-block;background:#3a86ff;color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px">✅ 批准</a>',
				'<a href="' + this.escHtml(deny) + '" style="display:inline-block;background:#6c757d;color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px">❌ 拒绝</a>',
				'</p></div>'
			].join('')
		}).join('')
		const waiting = Boolean(urlObj.searchParams.get('sent')) || pendingHere.length > 0
		const extra = waiting
			? '<p class="muted">进行中……有回复或审批变化后会自动刷新。输入框里有字时不会刷新。</p>'
			: ''
		const draftJs = [
			'<script>(function(){',
			'var k="dsh-draft-"+location.pathname;',
			'var ta=document.querySelector("textarea[name=text]");',
			'if(!ta)return;',
			'try{var s=sessionStorage.getItem(k);if(s)ta.value=s}catch(e){}',
			'ta.addEventListener("input",function(){try{sessionStorage.setItem(k,ta.value)}catch(e){}});',
			'document.querySelectorAll("form").forEach(function(f){f.addEventListener("submit",function(){if(f.querySelector("textarea[name=text]"))try{sessionStorage.removeItem(k)}catch(e){}})});',
			waiting ? 'setTimeout(function tick(){if((ta.value||"").trim()){setTimeout(tick,4000);return}location.reload()},4000);' : '',
			'})()</script>'
		].join('')
		const body = [
			'<header><a href="' + this.escHtml(this.chatPath()) + '">← 会话列表</a><strong style="margin-left:auto">' + this.escHtml(sessionId.slice(-12)) + '</strong></header>',
			'<main>', extra, banners, msgs,
			'<form method="post" action="' + this.escHtml(this.chatPath(sessionId)) + '">',
			'<textarea name="text" rows="3" placeholder="继续说…" required></textarea>',
			'<button type="submit">发送续聊</button></form>',
			'<p class="muted">审批也可以直接在本页点。锁屏推送（ntfy）是可选项，不装也能用。</p>',
			draftJs,
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell('会话 ' + sessionId.slice(-12), body))
	}

	async handleChatReply(rawId, req, urlObj, res) {
		const sessionId = decodeURIComponent(rawId.split('?')[0])
		const fields = await this.readForm(req, urlObj)
		const text = (fields.text ?? '').trim()
		if (!text) return this.redirect(res, this.chatPath(sessionId))
		const prompted = await this.client.sessions.prompt({
			sessionId,
			mode: 'queue',
			content: [{ type: 'text', text }]
		})
		if (!prompted.result.ok) {
			return this.sendHtml(res, this.pageShell('发送失败', `<main><p>${this.escHtml(JSON.stringify(prompted.result.error))}</p></main>`), 502)
		}
		this.note('task', { sessionId, mode: 'queue', text: text.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: text.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`chat reply → ${sessionId}`)
		this.redirect(res, this.chatPath(sessionId) + '&sent=1')
	}

	async readForm(req, urlObj) {
		const ctype = String(req.headers['content-type'] ?? '')
		const raw = await this.readBody(req)
		const out = {}
		if (ctype.includes('application/json')) {
			try { Object.assign(out, JSON.parse(raw || '{}')) } catch { /* ignore */ }
			return out
		}
		const params = new URLSearchParams(raw)
		for (const [k, v] of params) out[k] = v
		for (const [k, v] of urlObj.searchParams) if (out[k] === undefined) out[k] = v
		return out
	}

	async handleTask(req, res) {
		const raw = await this.readBody(req)
		let body
		try { body = JSON.parse(raw || '{}') } catch { return this.sendJson(res, 400, { ok: false, error: 'invalid json' }) }
		const text = typeof body.text === 'string' ? body.text : ''
		if (!text.trim()) return this.sendJson(res, 400, { ok: false, error: 'text required' })
		const mode = body.mode === 'steer' ? 'steer' : 'queue'
		const createPayload = {}
		if (body.workspaceId) createPayload.workspaceId = body.workspaceId
		else if (body.cwd) createPayload.cwd = body.cwd
		if (body.agentPreset) createPayload.agentPreset = body.agentPreset
		if (body.sessionId) createPayload.sessionId = body.sessionId
		const created = await this.client.sessions.create(createPayload)
		if (!created.result.ok) {
			this.log('task create failed:', JSON.stringify(created.result.error))
			return this.sendJson(res, 502, { ok: false, stage: 'create', error: created.result.error })
		}
		const sessionId = created.result.value.sessionId
		const prompted = await this.client.sessions.prompt({
			sessionId,
			mode,
			content: [{ type: 'text', text }]
		})
		if (!prompted.result.ok) {
			this.log('task prompt failed:', JSON.stringify(prompted.result.error))
			return this.sendJson(res, 502, { ok: false, stage: 'prompt', sessionId, error: prompted.result.error })
		}
		this.note('task', { sessionId, mode, text: text.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: text.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`task dispatched → ${sessionId}`)
		this.sendJson(res, 200, { ok: true, sessionId })
	}
}

export default DispatchService
