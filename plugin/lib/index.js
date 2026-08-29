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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const OUTCOMES = new Set(['allowed-once', 'rejected'])
const MAX_BODY = 12 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_IMAGES = 20

export class DispatchService extends Service {
	static inject = ['webServer', 'apiProxy']

	static Config = z.object({
		token: z.string().default(''),
		/** Phone-reachable base for decision links, e.g. https://pc.example.ts.net (empty = log-only links). */
		publicBaseUrl: z.string().default(''),
		/** ntfy server base URL. Default is the public ntfy.sh over HTTP/80. */
		ntfyServerUrl: z.string().default('http://ntfy.sh'),
		ntfyTopic: z.string().default(''),
		/** Optional ntfy publish auth token. */
		ntfyToken: z.string().default(''),
		/** Master switch for push notifications (routes stay active either way). */
		pushEnabled: z.boolean().default(true),
		/** Mux reconnect delay after a stream error. */
		reconnectMs: z.natural().default(2000)
	})

	constructor(ctx, config) {
		super(ctx, 'dispatch')
		this.config = this.hydrateSecrets(config)
		this.log = (...a) => console.log('[dsh-dispatch]', ...a)
		/** rpcId → {sessionId, approvalId, toolName, reason?, at} */
		this.pending = new Map()
		/** 稳定键 `${sessionId}/${approvalId}` → rpcId（用于 resolved 清理与去重） */
		this.pendingByKey = new Map()
		/** question rpcId → {sessionId, questions, at}；与权限审批严格分离。 */
		this.pendingQuestions = new Map()
		/** Seen frame rpcIds (replay dedupe), capped FIFO. */
		this.seen = new Set()
		this.seenOrder = []
		/** Small diagnostic ring of recent decisions/pushes. */
		this.events = []
		this.muxAbort = null
		this.hostAbort = null
		/** sessionId → {snippet, at} for dispatched tasks awaiting a completion push. */
		this.trackedTasks = new Map()
		/** sessionId → latest completed turn summary, persisted for voice reads. */
		this.turnResults = this.loadTurnResults()
		this.sessionRunningState = new Map()
		this.client = new InProcessApiClient(toFetchHandler(this.ctx.apiProxy), 120000)
		this.start()
	}

	get pendingCount() { return this.pending.size }

	secretsPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-dispatch.json')
	}

	turnResultsPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-turn-results.json')
	}

	loadTurnResults() {
		try {
			const parsed = JSON.parse(readFileSync(this.turnResultsPath(), 'utf8') || '{}')
			return new Map(Object.entries(parsed.sessions || {}))
		} catch { return new Map() }
	}

	persistTurnResults() {
		try {
			const sessions = Object.fromEntries(this.turnResults)
			mkdirSync(dirname(this.turnResultsPath()), { recursive: true })
			writeFileSync(this.turnResultsPath(), JSON.stringify({ version: 1, updatedAt: Date.now(), sessions }, null, 2) + '\n', 'utf8')
		} catch (err) {
			this.log('could not persist turn results:', err?.message ?? err)
		}
	}

	hydrateSecrets(config) {
		const next = { ...config }
		const path = this.secretsPath()
		let stored = {}
		if (existsSync(path)) {
			try { stored = JSON.parse(readFileSync(path, 'utf8') || '{}') } catch { stored = {} }
		}
		if (!next.token) next.token = stored.token || randomBytes(16).toString('hex')
		if (!next.ntfyTopic) next.ntfyTopic = stored.ntfyTopic || ('dsh-dispatch-' + randomBytes(8).toString('hex'))
		if (!next.publicBaseUrl && stored.publicBaseUrl) next.publicBaseUrl = stored.publicBaseUrl
		const out = {
			token: next.token,
			ntfyTopic: next.ntfyTopic,
			publicBaseUrl: next.publicBaseUrl || '',
			ntfyServerUrl: next.ntfyServerUrl,
			pushEnabled: next.pushEnabled
		}
		try {
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
		} catch (err) {
			console.log('[dsh-dispatch] could not persist secrets:', err?.message ?? err)
		}
		return next
	}

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
		this.log(`active (push=${this.config.pushEnabled ? 'on' : 'off'}, topic=${this.config.ntfyTopic}, publicBase=${this.config.publicBaseUrl || '(none)'}, secrets=${this.secretsPath()})`)
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
					} else if (frame && frame.type === 'question/requested') {
						this.pendingQuestions.set(envelope.rpcId, { sessionId: frame.sessionId, questions: frame.questions, at: Date.now() })
						this.note('question-requested', { rpcId: envelope.rpcId, sessionId: frame.sessionId, count: frame.questions.length })
						this.log(`question requested session=${frame.sessionId} count=${frame.questions.length}`)
					} else if (frame && frame.type === 'question/resolved') {
						if (this.pendingQuestions.delete(frame.questionRpcId)) {
							this.note('question-resolved-elsewhere', { rpcId: frame.questionRpcId, sessionId: frame.sessionId, outcome: frame.outcome })
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
					if (frame.type === 'host/session-status') {
						const wasRunning = this.sessionRunningState.get(frame.sessionId) === true
						this.sessionRunningState.set(frame.sessionId, Boolean(frame.running))
						if (frame.running === false && wasRunning) void this.captureTurnResult(frame.sessionId)
					}
					if (frame.type === 'host/session-status' && frame.running === false && this.trackedTasks.has(frame.sessionId)) {
						const info = this.trackedTasks.get(frame.sessionId)
						this.trackedTasks.delete(frame.sessionId)
						this.log(`task turn finished → ${frame.sessionId}`)
						if (this.config.pushEnabled) void this.pushTurnDone(frame.sessionId, info, false)
					} else if (frame.type === 'host/agent-error' && this.trackedTasks.has(frame.sessionId)) {
						void this.captureTurnResult(frame.sessionId, { isError: true, error: frame.message })
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

	readRaw(req) {
		return new Promise((resolve, reject) => {
			let size = 0
			const chunks = []
			req.on('data', (chunk) => {
				size += chunk.length
				if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
				chunks.push(chunk)
			})
			req.on('end', () => resolve(Buffer.concat(chunks)))
			req.on('error', reject)
		})
	}

	readBody(req) {
		return this.readRaw(req).then((buf) => buf.toString('utf8'))
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

	blocksImages(blocks) {
		const images = []
		if (!Array.isArray(blocks)) return images
		for (const b of blocks) {
			if (!b || typeof b !== 'object') continue
			if (b.type !== 'image' && b.type !== 'image_url') continue
			const att = b.attachment && typeof b.attachment === 'object' ? b.attachment : null
			const mediaType = att?.mediaType || b.mediaType || b.media_type || 'image/jpeg'
			const attachmentId = att?.attachmentId || b.attachmentId
			if (attachmentId) images.push({ attachmentId, mediaType })
			else if (typeof b.data === 'string' && b.data) images.push({ data: b.data.replace(/^data:[^;]+;base64,/, ''), mediaType })
		}
		return images
	}

	imgPath(sessionId, attachmentId) {
		const qs = new URLSearchParams({ token: this.config.token })
		return `/dispatch/chat/${encodeURIComponent(sessionId)}/img/${encodeURIComponent(attachmentId)}?${qs.toString()}`
	}

	guessImageType(filename, declared) {
		const mt = String(declared || '').toLowerCase().split(';')[0].trim()
		if (IMAGE_TYPES.has(mt)) return mt
		const n = String(filename || '').toLowerCase()
		if (n.endsWith('.png')) return 'image/png'
		if (n.endsWith('.webp')) return 'image/webp'
		if (n.endsWith('.gif')) return 'image/gif'
		if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
		return ''
	}

	canonicalB64(raw) {
		const s = String(raw || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
		const buf = Buffer.from(s, 'base64')
		return buf.toString('base64')
	}

	formImages(fields) {
		const out = []
		if (Array.isArray(fields.images)) {
			for (const img of fields.images) {
				const mediaType = this.guessImageType(img?.name, img?.mediaType)
				const data = this.canonicalB64(img?.data)
				if (!mediaType || !data) continue
				out.push({ type: 'image', mediaType, data, name: img?.name || 'image.jpg' })
			}
		}
		for (const f of fields.files ?? []) {
			const mediaType = this.guessImageType(f.filename, f.mediaType)
			if (!mediaType || !f.data?.length) continue
			const data = Buffer.isBuffer(f.data) ? f.data.toString('base64') : this.canonicalB64(f.data)
			out.push({ type: 'image', mediaType, data, name: f.filename || 'image.jpg' })
		}
		return out.slice(0, MAX_IMAGES)
	}

	parseMultipart(buf, boundary) {
		const out = { files: [] }
		if (!boundary) return out
		const start = Buffer.from('--' + boundary + '\r\n')
		const delim = Buffer.from('\r\n--' + boundary)
		let i = buf.indexOf(start)
		if (i < 0) return out
		i += start.length
		while (i < buf.length) {
			const next = buf.indexOf(delim, i)
			const part = buf.subarray(i, next >= 0 ? next : buf.length)
			const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
			if (headerEnd >= 0) {
				const headers = part.subarray(0, headerEnd).toString('utf8')
				let body = part.subarray(headerEnd + 4)
				if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
					body = body.subarray(0, body.length - 2)
				}
				const nameM = headers.match(/name="([^"]+)"/i)
				const fileM = headers.match(/filename="([^"]*)"/i)
				const typeM = headers.match(/Content-Type:\s*([^\r\n]+)/i)
				const name = nameM?.[1]
				if (name && fileM) {
					out.files.push({ field: name, filename: fileM[1], mediaType: (typeM?.[1] || '').trim(), data: body })
				} else if (name) {
					out[name] = body.toString('utf8')
				}
			}
			if (next < 0) break
			i = next + delim.length
			if (buf[i] === 13 && buf[i + 1] === 10) i += 2
			if (buf[i] === 45 && buf[i + 1] === 45) break
		}
		return out
	}

	promptContent(text, images) {
		const content = []
		if (text) content.push({ type: 'text', text })
		else if (images.length) content.push({ type: 'text', text: '（图片）' })
		for (const img of images) content.push(img)
		return content
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
				const blocks = ev.data?.content ?? ev.data?.message?.content
				const text = this.blocksText(blocks)
				const images = this.blocksImages(blocks)
				if (text && text.startsWith('/permission ')) continue
				if (text || images.length) out.push({ role: 'user', text, images, time: ev.time })
			} else if (ev.type === 'assistant/message') {
				const blocks = ev.data?.message?.content ?? ev.data?.content
				const text = this.visibleAssistantText(this.blocksText(blocks))
				const images = this.blocksImages(blocks)
				if (text || images.length) out.push({ role: 'assistant', text, images, time: ev.time })
			}
		}
		return out
	}

	titleFromProjections(projections, fallback) {
		const v = projections?.values?.title
		if (typeof v === 'string' && v.trim()) return v.trim()
		if (v && typeof v === 'object') {
			const t = v.title ?? v.value ?? v.text
			if (typeof t === 'string' && t.trim()) return t.trim()
		}
		return fallback
	}

	sessionTitleOf(row) {
		return this.titleFromProjections(row?.projections, (row?.sessionId ?? 'session').slice(-12))
	}

	permissionLabel(id) {
		return ({
			'read-only': '只读',
			'workspace-write': '工作区可写（默认，越权要审批）',
			'danger-full-access': '完全权限（不再弹审批）'
		}[id] || id)
	}

	async listAgentPresets() {
		try {
			const listed = await this.client.agentPresets.list({})
			if (!listed.result.ok) return []
			return (listed.result.value.presets ?? []).filter((p) => !p.broken)
		} catch {
			return []
		}
	}

	async applyPermission(sessionId, preset) {
		const allowed = new Set(['read-only', 'workspace-write', 'danger-full-access'])
		if (!allowed.has(preset)) return
		const r = await this.client.sessions.prompt({
			sessionId,
			mode: 'queue',
			content: [{ type: 'text', text: `/permission ${preset}` }]
		})
		if (!r.result.ok) throw new Error(JSON.stringify(r.result.error))
		this.note('permission', { sessionId, preset })
	}

	async listHostModels() {
		try {
			const listed = await this.client.llm.models({})
			if (!listed.result.ok) return []
			return listed.result.value.groups ?? []
		} catch {
			return []
		}
	}

	modelOptionsHtml(groups, selectedKey = '') {
		const opts = ['<option value="">默认模型</option>']
		for (const g of groups ?? []) {
			for (const m of g.models ?? []) {
				const key = g.id + '|' + m.id
				const label = (g.name || g.id) + ' · ' + (m.name || m.id)
				opts.push('<option value="' + this.escHtml(key) + '"' + (key === selectedKey ? ' selected' : '') + '>' + this.escHtml(label) + '</option>')
			}
		}
		return opts.join('')
	}

	parseModelKey(raw) {
		const s = String(raw || '')
		const sep = s.indexOf('|')
		if (sep < 1) return null
		const provider = s.slice(0, sep)
		const model = s.slice(sep + 1)
		if (!provider || !model) return null
		return { provider, model }
	}

	async applyModel(sessionId, raw) {
		const parsed = this.parseModelKey(raw)
		if (!parsed) return
		const selected = await this.client.sessions.selectModel({ sessionId, provider: parsed.provider, model: parsed.model })
		if (!selected.result.ok) throw new Error(JSON.stringify(selected.result.error))
		this.note('model', { sessionId, ...parsed })
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

	isSyntheticTurnInstruction(text) {
		const value = String(text || '').trim()
		return !value
			|| /^System restart completed\. Continue the task that was interrupted/i.test(value)
			|| /^This is an automatically generated checkpoint/i.test(value)
			|| /^Current runtime context\./i.test(value)
			|| /^(继续|继续执行|继续吧|接着做)[。！!\s]*$/u.test(value)
	}

	resultSpeechSummary(raw) {
		return String(raw || '')
			.replace(/```[\s\S]*?```/g, ' ')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/^#{1,6}\s+/gm, '')
			.replace(/^\s*[-*+]\s+/gm, '')
			.replace(/^\s*\d+[.)]\s+/gm, '')
			.replace(/[>*_~|]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 500)
	}

	async captureTurnResult(sessionId, { isError = false, error = '' } = {}) {
		try {
			const hist = await this.client.sessions.history({ sessionId, maxMessages: 60 })
			if (!hist.result.ok) throw new Error(hist.result.error || 'history failed')
			const folded = this.foldHistory(hist.result.value.events)
			let assistantIndex = -1
			for (let i = folded.length - 1; i >= 0; i--) {
				if (folded[i].role === 'assistant' && folded[i].text?.trim()) { assistantIndex = i; break }
			}
			let userIndex = -1
			for (let i = assistantIndex - 1; i >= 0; i--) {
				if (folded[i].role === 'user' && !this.isSyntheticTurnInstruction(folded[i].text)) { userIndex = i; break }
			}
			const previous = this.turnResults.get(sessionId)
			const result = isError ? String(error || '任务执行失败') : String(folded[assistantIndex]?.text || '').trim()
			if (!result) return previous || null
			const record = {
				sessionId,
				completedAt: Date.now(),
				instruction: String(folded[userIndex]?.text || '').slice(0, 2000),
				result: result.slice(0, 12000),
				speechSummary: this.resultSpeechSummary(result),
				isError: Boolean(isError),
				history: [
					...(Array.isArray(previous?.history) ? previous.history : []),
					...(previous?.result ? [{ completedAt: previous.completedAt, instruction: previous.instruction, result: previous.result, isError: previous.isError }] : [])
				].slice(-4)
			}
			this.turnResults.set(sessionId, record)
			this.persistTurnResults()
			this.log(`turn result saved → ${sessionId} chars=${record.result.length}`)
			return record
		} catch (err) {
			this.log('turn result capture failed:', sessionId, err?.message ?? err)
			return this.turnResults.get(sessionId) || null
		}
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

	escJsonScript(s) {
		return String(s).replace(/</g, '\\u003c')
	}

	voicePanel(state) {
		return [
			'<script type="application/json" id="dsh-voice-state">' + this.escJsonScript(JSON.stringify(state || {})) + '</script>',
			'<button type="button" id="sts-voice-toggle" class="voice-fab" aria-label="打开语音助手">🎙 语音助手</button>',
			'<section id="sts-voice-panel" class="voice-float" hidden>',
			'<div class="voice-float-head"><strong>' + this.escHtml(state?.sessionId ? '当前对话助手' : '全部对话助手') + '</strong><button type="button" id="sts-voice-close" class="voice-close">关闭</button></div>',
			'<div class="voice-scope">' + this.escHtml(state?.sessionId ? ('默认：' + (state?.title || '当前对话') + '；可明确点名查看其他对话') : '范围：全部对话') + '</div>',
			'<iframe id="sts-voice-frame" title="悬浮语音助手" allow="microphone; autoplay"></iframe>',
			'</section>'
		].join('')
	}

	voiceJs() {
		return [
			'<script>(function(){',
			'var btn=document.getElementById("sts-voice-toggle");var panel=document.getElementById("sts-voice-panel");var close=document.getElementById("sts-voice-close");var frame=document.getElementById("sts-voice-frame");if(!btn||!panel||!frame)return;',
			'var state={sessionId:"",token:"",mode:"session"};try{var el=document.getElementById("dsh-voice-state");if(el)state=JSON.parse(el.textContent||"{}")}catch(e){}',
			'var base="https://"+location.hostname+":8443/";var q=new URLSearchParams({token:state.token||"",mode:state.mode||"session"});if(state.sessionId)q.set("sessionId",state.sessionId);if(state.title)q.set("title",state.title);var voiceUrl=base+"?"+q.toString();frame.src=voiceUrl;',
			'function closeVoice(){panel.hidden=true;window.__dshVoiceBusy=false;frame.src=voiceUrl}',
			'btn.addEventListener("click",function(){panel.hidden=false;window.__dshVoiceBusy=true});',
			'if(close)close.addEventListener("click",closeVoice);',
			'})()</script>'
		].join('')
	}

	sendJs() {
		return [
			'<script>(function(){',
			'function load(file){return new Promise(function(ok,bad){var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){ok(im)};im.onerror=bad;im.src=r.result};r.onerror=bad;r.readAsDataURL(file)})}',
			'function pack(file){return load(file).then(function(im){var max=1280,w=im.width,h=im.height;if(w>max||h>max){var s=Math.min(max/w,max/h);w=Math.round(w*s);h=Math.round(h*s)}var c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(im,0,0,w,h);var url=c.toDataURL("image/jpeg",0.72);return {name:((file.name||"image").replace(/\\.[^.]+$/,"")||"image")+".jpg",mediaType:"image/jpeg",data:url.replace(/^data:[^;]+;base64,/,"")}})}',
			'function keyOf(f){return (f.name||"")+"|"+f.size+"|"+(f.lastModified||0)}',
			'function hook(form){',
			'var input=form.querySelector("input[type=file]");if(!input)return;',
			'var box=form.querySelector(".thumbs");var hint=form.querySelector(".img-hint");',
			'var bag=[];',
			'function draw(){',
			'if(hint)hint.textContent=bag.length?("已选 "+bag.length+" 张 · 再选会追加 · 点图删除"):"点选图，再选会追加，最多 20 张";',
			'if(!box)return;box.innerHTML="";',
			'bag.forEach(function(f,i){var im=document.createElement("img");im.alt="删";im.title="点一下删除";im.src=URL.createObjectURL(f);im.onclick=function(){bag.splice(i,1);draw()};box.appendChild(im)})',
			'}',
			'input.addEventListener("change",function(){',
			'var extra=[].slice.call(input.files||[]);',
			'extra.forEach(function(f){if(bag.length>=20)return;var k=keyOf(f);if(bag.some(function(x){return keyOf(x)===k}))return;bag.push(f)});',
			'input.value="";draw()',
			'});',
			'draw();',
			'form.addEventListener("submit",function(ev){',
			'if(!bag.length)return;',
			'ev.preventDefault();',
			'var btn=ev.submitter||form.querySelector("button[type=submit]");var submitMode=(btn&&btn.name==="mode"&&btn.value)||"queue";',
			'if(btn){btn.disabled=true;btn.textContent="正在发送图片…"}',
			'form.classList.add("busy");',
			'Promise.all(bag.slice(0,20).map(function(f){return pack(f).catch(function(){return null})})).then(function(imgs){',
			'imgs=imgs.filter(Boolean);',
			'if(!imgs.length){alert("图片读不出来，换一张 jpg/png 再试");if(btn){btn.disabled=false;btn.textContent="发送"};form.classList.remove("busy");return}',
			'try{sessionStorage.removeItem("dsh-draft-"+location.pathname)}catch(e){}',
			'var body={text:(form.querySelector("textarea[name=text]")||{}).value||"",images:imgs,mode:submitMode};',
			'var ap=form.querySelector("[name=agentPreset]");if(ap&&ap.value)body.agentPreset=ap.value;',
			'var md=form.querySelector("[name=model]");if(md&&md.value)body.model=md.value;',
			'var pm=form.querySelector("[name=permission]");if(pm&&pm.value)body.permission=pm.value;',
			'return fetch(form.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),credentials:"same-origin"}).then(function(r){',
			'if(!r.ok) return r.text().then(function(t){throw new Error(t.slice(0,180)||("HTTP "+r.status))});',
			'var loc=r.url||form.action;',
			'if(loc.indexOf("/dispatch/chat")>=0 && loc.indexOf("sent=")<0) loc+=(loc.indexOf("?")>=0?"&":"?")+"sent=1";',
			'location.href=loc',
			'})})',
			'.catch(function(e){alert("发送失败："+(e&&e.message||e));if(btn){btn.disabled=false;btn.textContent="发送"};form.classList.remove("busy")})',
			'})}',
			'document.querySelectorAll("form.js-chat").forEach(hook)',
			'})()</script>'
		].join('')
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
			'header.chat-header{position:sticky;top:0;z-index:100;background:rgba(11,19,43,.96);backdrop-filter:blur(10px);box-sizing:border-box;box-shadow:0 4px 14px rgba(0,0,0,.28)}',
			'.msg{margin:10px 0;padding:10px 12px;border-radius:12px;white-space:pre-wrap;word-break:break-word;line-height:1.45}',
			'.pic{max-width:100%;border-radius:10px;margin-top:8px;display:block}',
			'.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}',
			'.thumbs img{width:64px;height:64px;object-fit:cover;border-radius:8px}',
			'input[type=file]{margin-top:8px;font:inherit;color:#8be9fd}',
			'.busy{opacity:.7}',
			'.user{background:#1c2541} .assistant{background:#193c3a}',
			'.meta{opacity:.55;font-size:12px;margin-bottom:4px}',
			'textarea,input[type=text],select{width:100%;box-sizing:border-box;background:#1c2541;color:#e6f1ff;border:1px solid #3a506b;border-radius:10px;padding:10px;font:inherit}',
			'button{background:#3a86ff;color:#fff;border:0;border-radius:10px;padding:10px 16px;font:inherit;margin-top:8px}',
			'.row{padding:12px 0;border-bottom:1px solid #1c2541}',
			'.muted{opacity:.65;font-size:13px}',
			'.banner{background:#3d2b1f;border:1px solid #e09f3e;border-radius:12px;padding:12px;margin:12px 0}',
			'.banner form{display:flex;gap:8px;padding:0;margin:8px 0 0}',
			'.banner button{margin:0}',
			'.question-banner{background:#132a3a;border:1px solid #3a86ff;border-radius:12px;padding:12px;margin:12px 0}',
			'.question-form{padding:0;margin-top:10px}',
			'.question-field{border:1px solid #3a506b;border-radius:10px;margin:10px 0;padding:10px}',
			'.question-field legend{color:#8be9fd;padding:0 6px}',
			'.question-text{font-weight:600;margin-bottom:8px;white-space:pre-wrap}',
			'.question-option{display:flex;align-items:flex-start;gap:9px;background:#111a33;border:1px solid #263b5e;border-radius:9px;padding:10px;margin:8px 0}',
			'.question-option input{width:20px;height:20px;flex:none;margin:1px 0 0}',
			'.question-option small{display:block;opacity:.65;margin-top:3px}',
			'.question-custom{display:block;margin-top:10px}.question-custom span{display:block;font-size:13px;opacity:.7;margin-bottom:5px}',
			'.deny{background:#6c757d}.composer-actions{display:flex;gap:8px;flex-wrap:wrap}.composer-actions .steer{background:#e09f3e;color:#111}',
			'#voice-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0 12px;padding:10px 12px;background:#111a33;border:1px solid #3a506b;border-radius:12px}',
			'#voice-bar button{margin:0}',
			'#voice-bar.live{border-color:#3a86ff}',
			'#voice-bar.listen{border-color:#22a06b}',
			'#voice-bar.speak{border-color:#e09f3e}',
			'#voice-status{flex:1;min-width:12em}',
			'.voice-fab{position:fixed;right:16px;bottom:max(16px,env(safe-area-inset-bottom));z-index:900;margin:0;border-radius:999px;box-shadow:0 8px 28px rgba(0,0,0,.45)}',
			'.voice-float{position:fixed;right:12px;bottom:76px;z-index:950;width:min(390px,calc(100vw - 24px));height:min(620px,72vh);background:#0b132b;border:1px solid #3a506b;border-radius:18px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.6)}',
			'.voice-float-head{height:46px;display:flex;align-items:center;gap:10px;padding:0 10px 0 14px;background:#111a33;border-bottom:1px solid #1c2541}',
			'.voice-float-head .voice-close{margin:0 0 0 auto;padding:7px 12px;background:#1c2541}',
			'.voice-scope{height:34px;box-sizing:border-box;padding:8px 12px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#8be9fd;background:#0e1832}',
			'.voice-float iframe{display:block;border:0;width:100%;height:calc(100% - 80px);background:#0b132b}',
			'@media(max-width:520px){.voice-float{left:8px;right:8px;bottom:72px;width:auto;height:72vh}.voice-fab{right:12px}}',
			'details.adv{margin:12px 0;border:1px solid #1c2541;border-radius:12px;padding:4px 12px 8px;background:#111a33}',
			'details.adv>summary{cursor:pointer;list-style:none;padding:10px 0;color:#8be9fd}',
			'details.adv>summary::-webkit-details-marker{display:none}',
			'details.adv form{padding:4px 0}',
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
				return this.sendJson(res, 200, { ok: true, pending: this.pending.size, pendingQuestions: this.pendingQuestions.size })
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
					pendingQuestions: [...this.pendingQuestions.entries()].map(([rpcId, e]) => ({ rpcId, sessionId: e.sessionId, questions: e.questions, at: e.at })),
					recent: this.events.slice(-20)
				})
			}
			const resultMatch = route.match(/^\/dispatch\/session-result\/([^/]+)$/)
			if (resultMatch && req.method === 'GET') {
				const sessionId = decodeURIComponent(resultMatch[1])
				let record = this.turnResults.get(sessionId)
				if (!record) {
					record = await this.captureTurnResult(sessionId)
					if (record) record = { ...record, backfilled: true }
				} else if (!record.speechSummary && record.result) {
					record = { ...record, speechSummary: this.resultSpeechSummary(record.result) }
					this.turnResults.set(sessionId, record)
					this.persistTurnResults()
				}
				let title = sessionId.slice(-12)
				try {
					const listed = await this.client.sessions.list({})
					const row = listed.result.ok ? (listed.result.value.items ?? []).find((s) => s.sessionId === sessionId) : null
					if (row) title = this.sessionTitleOf(row)
				} catch { /* fallback */ }
				return this.sendJson(res, 200, { ok: true, sessionId, title, result: record || null })
			}
			if (route === '/dispatch/sessions' && req.method === 'GET') {
				const listed = await this.client.sessions.list({})
				if (!listed.result.ok) return this.sendJson(res, 502, { ok: false, error: listed.result.error })
				let archived = new Set()
				try {
					const workspace = await this.client.workspace.list({})
					if (workspace.result.ok) archived = new Set(workspace.result.value.archivedSessionIds ?? [])
				} catch { /* optional */ }
				const parentBySid = new Map()
				for (const s of listed.result.value.items ?? []) {
					if (s.origin === 'subagent' && s.parentSessionId) parentBySid.set(s.sessionId, s.parentSessionId)
				}
				const rootOf = (sessionId) => {
					let id = sessionId
					const seen = new Set()
					while (parentBySid.has(id) && !seen.has(id)) { seen.add(id); id = parentBySid.get(id) }
					return id
				}
				const pendingByRoot = new Map()
				for (const [, e] of this.pending) {
					const root = rootOf(e.sessionId)
					pendingByRoot.set(root, (pendingByRoot.get(root) ?? 0) + 1)
				}
				const sessions = (listed.result.value.items ?? [])
					.filter((s) => !s.blank && s.origin !== 'subagent')
					.map((s) => ({
						sessionId: s.sessionId,
						title: this.sessionTitleOf(s),
						running: Boolean(s.running),
						pending: pendingByRoot.get(s.sessionId) ?? 0,
						archived: archived.has(s.sessionId),
						updatedAt: s.updatedAt ?? 0
					}))
				return this.sendJson(res, 200, { ok: true, sessions })
			}
			if (route === '/dispatch/decision') return await this.handleDecision(urlObj, res)
			if (route === '/dispatch/question' && req.method === 'POST') return await this.handleQuestion(req, urlObj, res)
			if (route === '/dispatch/task' && req.method === 'POST') return await this.handleTask(req, res)
			if (route === '/dispatch/chat' && req.method === 'GET') return await this.handleChatList(urlObj, res)
			if (route === '/dispatch/chat' && req.method === 'POST') return await this.handleChatNew(req, urlObj, res)
			const imgMatch = route.match(/^\/dispatch\/chat\/([^/]+)\/img\/([^/]+)$/)
			if (imgMatch && req.method === 'GET') {
				return await this.handleChatImage(decodeURIComponent(imgMatch[1]), decodeURIComponent(imgMatch[2]), res)
			}
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

	renderQuestionBanner(rpcId, entry, returnSessionId) {
		const fields = entry.questions.map((q, qi) => {
			const multi = q.multiSelect === true
			const type = multi ? 'checkbox' : 'radio'
			const options = (q.options ?? []).map((option, oi) => [
				'<label class="question-option">',
				'<input type="' + type + '" name="' + (multi ? `q${qi}o${oi}` : `q${qi}pick`) + '" value="' + (multi ? '1' : oi) + '">',
				'<span><strong>' + this.escHtml(option.label) + '</strong>',
				option.description ? '<small>' + this.escHtml(option.description) + '</small>' : '',
				'</span></label>'
			].join('')).join('')
			return [
				'<fieldset class="question-field"><legend>' + this.escHtml(q.header || `问题 ${qi + 1}`) + '</legend>',
				'<div class="question-text">' + this.escHtml(q.question) + '</div>',
				q.detail ? '<div class="muted">' + this.escHtml(q.detail) + '</div>' : '',
				options,
				'<label class="question-custom"><span>自定义回答</span><input type="text" name="q' + qi + 'custom" placeholder="也可以输入其他答案"></label>',
				'</fieldset>'
			].join('')
		}).join('')
		return [
			'<div class="question-banner"><strong>需要你回答</strong>',
			'<form class="question-form" method="post" action="/dispatch/question?token=' + encodeURIComponent(this.config.token) + '">',
			'<input type="hidden" name="rpcId" value="' + this.escHtml(rpcId) + '">',
			'<input type="hidden" name="returnSessionId" value="' + this.escHtml(returnSessionId) + '">',
			fields,
			'<button type="submit">提交回答</button></form></div>'
		].join('')
	}

	async handleQuestion(req, urlObj, res) {
		const fields = await this.readForm(req, urlObj)
		const rpcId = String(fields.rpcId || '')
		const returnSessionId = String(fields.returnSessionId || '')
		const entry = this.pendingQuestions.get(rpcId)
		if (!entry) {
			return this.sendResultPage(res, '⏳', '这个问题已经回答', '可能电脑端已经先行提交，无需重复操作。',
				returnSessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(returnSessionId))}" style="color:#8be9fd">返回会话</a></p>` : '')
		}
		const answers = entry.questions.map((q, qi) => {
			const selected = []
			if (q.multiSelect === true) {
				for (let oi = 0; oi < (q.options ?? []).length; oi += 1) {
					if (String(fields[`q${qi}o${oi}`] || '') === '1') selected.push(q.options[oi].label)
				}
			} else {
				const picked = Number(fields[`q${qi}pick`])
				if (Number.isInteger(picked) && picked >= 0 && picked < (q.options ?? []).length) selected.push(q.options[picked].label)
			}
			const custom = String(fields[`q${qi}custom`] || '').trim()
			if (q.multiSelect !== true && custom) selected.splice(0)
			return { id: q.id, selected, ...(custom ? { custom } : {}) }
		})
		if (answers.some((answer) => answer.selected.length === 0 && !answer.custom)) {
			return this.sendResultPage(res, '⚠️', '还有问题没有回答', '请为每一道题选择一个选项，或填写自定义回答。',
				returnSessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(returnSessionId))}" style="color:#8be9fd">返回继续填写</a></p>` : '')
		}
		const receipt = await this.client.respond({
			type: 'client-response', rpcId,
			result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers } } }
		})
		if (!receipt.accepted) {
			if (receipt.reason === 'not-pending') this.pendingQuestions.delete(rpcId)
			return this.sendResultPage(res, '⏳', '回答没有提交', receipt.reason === 'not-pending' ? '电脑端已经先行回答。' : `Harness 拒绝了回答：${receipt.reason || 'unknown'}`,
				returnSessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(returnSessionId))}" style="color:#8be9fd">返回会话</a></p>` : '')
		}
		this.pendingQuestions.delete(rpcId)
		this.note('question-answered', { rpcId, sessionId: entry.sessionId, answers })
		return this.redirect(res, this.chatPath(returnSessionId || entry.sessionId))
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

	async archivedIdSet() {
		try {
			const ws = await this.client.workspace.list({})
			if (!ws.result.ok) return new Set()
			return new Set(ws.result.value.archivedSessionIds ?? [])
		} catch {
			return new Set()
		}
	}

	async handleChatList(urlObj, res) {
		const listed = await this.client.sessions.list({})
		if (!listed.result.ok) return this.sendJson(res, 502, { ok: false, error: listed.result.error })
		const archived = await this.archivedIdSet()
		const showArchived = urlObj.searchParams.get('archived') === '1'
		const all = (listed.result.value.items ?? []).filter((s) => !s.blank && s.origin !== 'subagent')
		const live = all.filter((s) => !archived.has(s.sessionId))
		const archivedRows = all.filter((s) => archived.has(s.sessionId))
		const items = (showArchived ? archivedRows : live).slice(0, 40)
		const parentBySid = new Map()
		for (const s of listed.result.value.items ?? []) {
			if (s.origin === 'subagent' && s.parentSessionId) parentBySid.set(s.sessionId, s.parentSessionId)
		}
		const rootOf = (sessionId) => {
			let id = sessionId
			const seen = new Set()
			while (parentBySid.has(id) && !seen.has(id)) {
				seen.add(id)
				id = parentBySid.get(id)
			}
			return id
		}
		const pendingBySid = new Map()
		for (const [, e] of this.pending) {
			const root = rootOf(e.sessionId)
			pendingBySid.set(root, (pendingBySid.get(root) ?? 0) + 1)
		}
		const questionsBySid = new Map()
		for (const [, e] of this.pendingQuestions) {
			const root = rootOf(e.sessionId)
			questionsBySid.set(root, (questionsBySid.get(root) ?? 0) + 1)
		}
		const rows = items.map((s) => {
			const href = this.chatPath(s.sessionId)
			const title = this.escHtml(this.sessionTitleOf(s))
			const run = s.running ? ' 运行中' : ''
			const need = pendingBySid.get(s.sessionId) ? ' · 待审批' : ''
			const ask = questionsBySid.get(s.sessionId) ? ' · 待回答' : ''
			const cwd = s.cwd ? this.escHtml(s.cwd) : ''
			return `<div class="row"><a href="${this.escHtml(href)}">${title}</a><div class="muted">${this.escHtml(s.sessionId.slice(-12))}${run}${need}${ask}${cwd ? ' · ' + cwd : ''}</div></div>`
		}).join('')
		const nav = showArchived
			? `<p><a href="${this.escHtml(this.chatPath())}">← 进行中</a> · 已归档 ${archivedRows.length}</p>`
			: `<p><a href="${this.escHtml(this.chatPath() + '&archived=1')}">已归档（${archivedRows.length}）</a></p>`
		let presetOpts = ''
		if (!showArchived) {
			const presets = await this.listAgentPresets()
			if (presets.length) {
				presetOpts = '<label class="muted">模式（agent preset）</label><select name="agentPreset">'
					+ presets.map((p) => {
						const label = (p.name || p.id) + (p.isDefault ? '（默认）' : '') + (p.trust === 'user' ? ' · 用户' : '')
						return '<option value="' + this.escHtml(p.id) + '"' + (p.isDefault ? ' selected' : '') + '>' + this.escHtml(label) + '</option>'
					}).join('')
					+ '</select>'
			}
		}
		const permOpts = ['workspace-write', 'read-only', 'danger-full-access'].map((id) =>
			'<option value="' + id + '"' + (id === 'workspace-write' ? ' selected' : '') + '>' + this.escHtml(this.permissionLabel(id)) + '</option>'
		).join('')
		let modelOpts = ''
		if (!showArchived) {
			const groups = await this.listHostModels()
			if (groups.length) {
				modelOpts = '<label class="muted">模型</label><select name="model">' + this.modelOptionsHtml(groups) + '</select>'
			}
		}
		const composer = showArchived ? '' : [
			'<form class="js-chat" method="post" action="' + this.escHtml(this.chatPath()) + '" enctype="multipart/form-data">',
			'<textarea name="text" rows="3" placeholder="新开一个会话，说你要它干什么…"></textarea>',
			'<input type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple>',
			'<div class="thumbs"></div><p class="muted img-hint">点选图，再选会追加，最多 20 张</p>',
			'<div class="composer-actions"><button type="submit">发送</button></div>',
			'<details class="adv"><summary>高级 · 模型 / 模式 / 权限</summary>',
			modelOpts,
			presetOpts,
			'<label class="muted">权限</label><select name="permission">' + permOpts + '</select>',
			'</details></form>'
		].join('')
		const empty = showArchived ? '没有已归档会话' : '还没有会话'
		const heading = showArchived ? '已归档' : 'dsh 手机会话'
		const advJs = '<script>(function(){document.querySelectorAll("details.adv").forEach(function(d){var dk="dsh-adv-"+location.pathname;try{if(sessionStorage.getItem(dk)==="1")d.open=true}catch(e){}d.addEventListener("toggle",function(){try{sessionStorage.setItem(dk,d.open?"1":"0")}catch(e){}})})})()</script>'
		const body = [
			'<header><strong>' + heading + '</strong></header><main>',
			showArchived ? '' : this.voicePanel({ token: this.config.token, mode: 'global' }),
			nav, composer,
			rows || '<p class="muted">' + empty + '</p>',
			advJs, this.sendJs(), showArchived ? '' : this.voiceJs(),
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell(heading, body))
	}

	async handleChatNew(req, urlObj, res) {
		const fields = await this.readForm(req, urlObj)
		const text = (fields.text ?? '').trim()
		const images = this.formImages(fields)
		if (!text && !images.length) return this.sendHtml(res, this.pageShell('dsh', '<main><p>内容不能为空</p></main>'), 400)
		const createReq = {}
		const agentPreset = (fields.agentPreset ?? '').trim()
		if (agentPreset) createReq.agentPreset = agentPreset
		const created = await this.client.sessions.create(createReq)
		if (!created.result.ok) return this.sendJson(res, 502, { ok: false, stage: 'create', error: created.result.error })
		const sessionId = created.result.value.sessionId
		try { await this.applyModel(sessionId, fields.model) } catch (err) {
			this.log('model at create failed:', err)
		}
		const permission = (fields.permission ?? '').trim()
		if (permission && permission !== 'workspace-write') {
			try { await this.applyPermission(sessionId, permission) } catch (err) {
				this.log('permission at create failed:', err)
			}
		}
		const prompted = await this.client.sessions.prompt({
			sessionId,
			mode: 'queue',
			content: this.promptContent(text, images)
		})
		if (!prompted.result.ok) return this.sendJson(res, 502, { ok: false, stage: 'prompt', sessionId, error: prompted.result.error })
		this.note('task', { sessionId, mode: 'queue', text: (text || '（图片）').slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: (text || '（图片）').slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`chat dispatched → ${sessionId}`)
		this.redirect(res, this.chatPath(sessionId) + '&sent=1')
	}

	async sessionRunning(sessionId) {
		try {
			const listed = await this.client.sessions.list({})
			if (!listed.result.ok) return false
			return Boolean((listed.result.value.items ?? []).find((s) => s.sessionId === sessionId)?.running)
		} catch {
			return false
		}
	}

	async handleChatView(rawId, urlObj, res) {
		const sessionId = decodeURIComponent(rawId.split('?')[0])
		if (urlObj.searchParams.get('archive') === '1') {
			const archived = await this.client.workspace.archiveSession({ sessionId })
			if (!archived.result.ok) {
				return this.sendHtml(res, this.pageShell('归档失败', `<main><p>${this.escHtml(JSON.stringify(archived.result.error))}</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 502)
			}
			this.note('archived', { sessionId })
			this.log(`archived ${sessionId}`)
			return this.redirect(res, this.chatPath() + '&archived=1')
		}
		const decideRpc = urlObj.searchParams.get('decide')
		const decideOut = urlObj.searchParams.get('outcome')
		if (decideRpc && OUTCOMES.has(decideOut ?? '')) {
			const entry = this.pending.get(decideRpc)
			if (entry) await this.applyDecision(decideRpc, decideOut, entry.sessionId, entry.approvalId)
			return this.redirect(res, this.chatPath(sessionId))
		}
		const switchModel = urlObj.searchParams.get('switchModel')
		if (switchModel) {
			const sep = switchModel.indexOf('|')
			const provider = sep >= 0 ? switchModel.slice(0, sep) : ''
			const model = sep >= 0 ? switchModel.slice(sep + 1) : ''
			if (!provider || !model) {
				return this.sendHtml(res, this.pageShell('换模型失败', `<main><p>模型参数无效。</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 400)
			}
			const selected = await this.client.sessions.selectModel({ sessionId, provider, model })
			if (!selected.result.ok) {
				return this.sendHtml(res, this.pageShell('换模型失败', `<main><p>${this.escHtml(JSON.stringify(selected.result.error))}</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 502)
			}
			const applied = selected.result.value.selected
			let verified = false
			try {
				const reread = await this.client.sessions.models({ sessionId })
				verified = Boolean(reread.result.ok && reread.result.value.current?.provider === applied.provider && reread.result.value.current?.model === applied.model)
			} catch { /* report unverified below */ }
			this.note('model', { sessionId, requested: { provider, model }, applied, verified })
			const qs = new URLSearchParams({
				modelChanged: verified ? '1' : '0',
				modelProvider: applied.provider,
				modelName: applied.model
			})
			return this.redirect(res, this.chatPath(sessionId) + '&' + qs.toString())
		}
		const switchPerm = urlObj.searchParams.get('switchPermission')
		if (switchPerm) {
			try { await this.applyPermission(sessionId, switchPerm) } catch (err) {
				return this.sendHtml(res, this.pageShell('改权限失败', `<main><p>${this.escHtml(String(err?.message ?? err))}</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 502)
			}
			return this.redirect(res, this.chatPath(sessionId))
		}
		const hist = await this.client.sessions.history({ sessionId, maxMessages: 40 })
		if (!hist.result.ok) {
			return this.sendHtml(res, this.pageShell('会话', `<main><p>读历史失败：${this.escHtml(JSON.stringify(hist.result.error))}</p></main>`), 502)
		}
		const folded = this.foldHistory(hist.result.value.events)
		const msgs = folded.map((m) => {
			const who = m.role === 'user' ? '你' : '助手'
			const pics = (m.images ?? []).map((img) => {
				if (img.attachmentId) return `<img class="pic" alt="" src="${this.escHtml(this.imgPath(sessionId, img.attachmentId))}">`
				if (img.data) return `<img class="pic" alt="" src="data:${this.escHtml(img.mediaType || 'image/jpeg')};base64,${img.data}">`
				return ''
			}).join('')
			return `<div class="msg ${m.role}"><div class="meta">${who}</div>${this.escHtml(m.text || '')}${pics}</div>`
		}).join('') || '<p class="muted">还没有可见消息（可能还在跑工具）</p>'
		const listedForTree = await this.client.sessions.list({})
		const summaries = listedForTree.result.ok ? (listedForTree.result.value.items ?? []) : []
		const children = new Map()
		for (const s of summaries) {
			if (s.origin !== 'subagent' || !s.parentSessionId) continue
			const row = children.get(s.parentSessionId) ?? []
			row.push(s.sessionId)
			children.set(s.parentSessionId, row)
		}
		const sessionTree = new Set([sessionId])
		const queue = [sessionId]
		while (queue.length) {
			const parent = queue.shift()
			for (const child of children.get(parent) ?? []) {
				if (sessionTree.has(child)) continue
				sessionTree.add(child)
				queue.push(child)
			}
		}
		const summaryById = new Map(summaries.map((s) => [s.sessionId, s]))
		const pendingHere = [...this.pending.entries()].filter(([, e]) => sessionTree.has(e.sessionId))
		const banners = pendingHere.map(([rpcId, e]) => {
			const allow = this.chatPath(sessionId) + '&decide=' + encodeURIComponent(rpcId) + '&outcome=allowed-once'
			const deny = this.chatPath(sessionId) + '&decide=' + encodeURIComponent(rpcId) + '&outcome=rejected'
			const child = e.sessionId !== sessionId
			const source = child ? (this.sessionTitleOf(summaryById.get(e.sessionId)) || e.sessionId.slice(-12)) : '当前主会话'
			return [
				'<div class="banner"><strong>需要审批 · ' + this.escHtml(e.toolName) + '</strong>',
				'<div class="muted">来源：' + this.escHtml(source) + (child ? ' · 子任务' : '') + '</div>',
				'<div class="muted">' + this.escHtml((e.reason || '').slice(0, 400)) + '</div>',
				'<p style="margin:10px 0 0;display:flex;gap:8px;flex-wrap:wrap">',
				'<a href="' + this.escHtml(allow) + '" style="display:inline-block;background:#3a86ff;color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px">✅ 批准</a>',
				'<a href="' + this.escHtml(deny) + '" style="display:inline-block;background:#6c757d;color:#fff;text-decoration:none;border-radius:10px;padding:10px 16px">❌ 拒绝</a>',
				'</p></div>'
			].join('')
		}).join('')
		const questionsHere = [...this.pendingQuestions.entries()].filter(([, e]) => sessionTree.has(e.sessionId))
		const questionBanners = questionsHere.map(([rpcId, e]) => this.renderQuestionBanner(rpcId, e, sessionId)).join('')
		const running = await this.sessionRunning(sessionId)
		const last = folded[folded.length - 1]
		const awaitingReply = !last || last.role === 'user'
		const sent = Boolean(urlObj.searchParams.get('sent'))
		const waiting = pendingHere.length > 0 || questionsHere.length > 0 || running || (sent && awaitingReply)
		const steerNotice = urlObj.searchParams.get('steered') === '1'
			? '<div class="banner"><strong>⚡ 已插队</strong><div class="muted">消息已注入当前运行轮次。</div></div>'
			: urlObj.searchParams.get('steerFallback') === '1'
				? '<div class="banner"><strong>已转为普通续聊</strong><div class="muted">提交时当前轮次已不接受插队，消息没有丢失，已进入下一轮。</div></div>'
				: ''
		const changedModel = urlObj.searchParams.get('modelName')
		const modelNotice = changedModel
			? (urlObj.searchParams.get('modelChanged') === '1'
				? '<div class="banner"><strong>✅ 模型已切换</strong><div class="muted">当前选择：' + this.escHtml(urlObj.searchParams.get('modelProvider') || '') + ' / ' + this.escHtml(changedModel) + '。正在执行的模型调用不会倒带，后续模型调用使用新选择。</div></div>'
				: '<div class="banner"><strong>⚠️ 模型切换未能复读确认</strong><div class="muted">接口返回：' + this.escHtml(urlObj.searchParams.get('modelProvider') || '') + ' / ' + this.escHtml(changedModel) + '，但重新读取 current 未匹配，请刷新后检查当前模型。</div></div>')
			: ''
		const extra = modelNotice + steerNotice + (waiting
			? '<p class="muted">进行中……有回复、问题或审批变化后会自动刷新。正在打字或已选未发的图时会暂停刷新。</p>'
			: '')
		const draftJs = [
			'<script>(function(){',
			'var k="dsh-draft-"+location.pathname;',
			'var sk="dsh-scroll-"+location.pathname;',
			'var nk="dsh-nmsg-"+location.pathname;',
			'var ta=document.querySelector("textarea[name=text]");',
			'var n=document.querySelectorAll(".msg").length;',
			'var prevN=0;try{prevN=parseInt(sessionStorage.getItem(nk)||"0",10)||0}catch(e){}',
			'try{sessionStorage.setItem(nk,String(n))}catch(e){}',
			'function pinComposer(){var el=document.getElementById("composer")||ta;if(el)el.scrollIntoView({block:"end"})}',
			'function restore(){',
			waiting ? 'pinComposer();return;' : '',
			'  var grew=n>prevN;',
			'  if(grew){pinComposer();return}',
			'  try{var y=sessionStorage.getItem(sk);if(y)scrollTo(0,parseInt(y,10)||0)}catch(e){}',
			'}',
			'restore();setTimeout(restore,0);',
			'addEventListener("scroll",function(){try{sessionStorage.setItem(sk,String(scrollY))}catch(e){}});',
			'if(ta){',
			waiting ? '' : 'try{var s=sessionStorage.getItem(k);if(s)ta.value=s}catch(e){}',
			'ta.addEventListener("input",function(){try{sessionStorage.setItem(k,ta.value)}catch(e){}});',
			'}',
			'document.querySelectorAll("form").forEach(function(f){f.addEventListener("submit",function(){if(f.querySelector("textarea[name=text]"))try{sessionStorage.removeItem(k)}catch(e){}})});',
			'document.querySelectorAll("details.adv").forEach(function(d){var dk="dsh-adv-"+location.pathname;try{if(sessionStorage.getItem(dk)==="1")d.open=true}catch(e){}d.addEventListener("toggle",function(){try{sessionStorage.setItem(dk,d.open?"1":"0")}catch(e){}})});',
			waiting ? 'setTimeout(function tick(){var typing=ta&&document.activeElement===ta&&(ta.value||"").trim();var bag=document.querySelectorAll(".thumbs img").length;if(typing||bag||window.__dshVoiceBusy){setTimeout(tick,4000);return}location.reload()},4000);' : '',
			'})()</script>'
		].join('')
		const archivedSet = await this.archivedIdSet()
		const isArchived = archivedSet.has(sessionId)
		const archiveLink = isArchived
			? '<span class="muted">已归档 · 恢复请在电脑 GUI 操作</span>'
			: '<a href="' + this.escHtml(this.chatPath(sessionId) + '&archive=1') + '" onclick="return confirm(\'归档后会从进行中列表消失，日志还在。确定？\')">归档</a>'
		let modelForm = ''
		let modelLabel = ''
		try {
			const catalog = await this.client.sessions.models({ sessionId })
			if (catalog.result.ok) {
				const cur = catalog.result.value.current
				const curKey = (cur?.provider || '') + '|' + (cur?.model || '')
				modelLabel = [cur?.provider, cur?.model].filter(Boolean).join(' / ')
				const opts = []
				for (const g of catalog.result.value.groups ?? []) {
					for (const m of g.models ?? []) {
						const key = g.id + '|' + m.id
						const label = (g.name || g.id) + ' · ' + (m.name || m.id)
						opts.push('<option value="' + this.escHtml(key) + '"' + (key === curKey ? ' selected' : '') + '>' + this.escHtml(label) + '</option>')
					}
				}
				if (opts.length) {
					const routeWarning = catalog.result.value.routable === false ? '<div class="muted">⚠️ 当前 provider 暂无可用路由</div>' : ''
					const failures = (catalog.result.value.failures ?? []).map((f) => `${f.name || f.id}: ${f.message}`).join('；')
					modelForm = [
						'<form method="get" action="' + this.escHtml('/dispatch/chat/' + encodeURIComponent(sessionId)) + '">',
						'<input type="hidden" name="token" value="' + this.escHtml(this.config.token) + '">',
						'<label class="muted">模型 · 当前 ' + this.escHtml(modelLabel || '未知') + '</label>',
						routeWarning,
						failures ? '<div class="muted">部分目录加载失败：' + this.escHtml(failures) + '</div>' : '',
						'<select name="switchModel">' + opts.join('') + '</select>',
						'<button type="submit">切换并验证</button></form>'
					].join('')
				}
			}
		} catch { /* catalog optional */ }
		let permForm = ''
		const permNow = hist.result.value.projections?.values?.permissions
		const permCurrent = permNow?.currentValue || 'workspace-write'
		const permChoices = (permNow?.options?.length ? permNow.options.map((o) => o.value) : ['read-only', 'workspace-write', 'danger-full-access'])
			.filter((id) => id && id !== 'custom')
		if (permChoices.length) {
			permForm = [
				'<form method="get" action="' + this.escHtml('/dispatch/chat/' + encodeURIComponent(sessionId)) + '">',
				'<input type="hidden" name="token" value="' + this.escHtml(this.config.token) + '">',
				'<label class="muted">权限 · 当前 ' + this.escHtml(this.permissionLabel(permCurrent)) + '</label>',
				'<select name="switchPermission">',
				permChoices.map((id) => '<option value="' + this.escHtml(id) + '"' + (id === permCurrent ? ' selected' : '') + '>' + this.escHtml(this.permissionLabel(id)) + '</option>').join(''),
				'</select><button type="submit">应用权限</button></form>'
			].join('')
		}
		const currentTitle = this.titleFromProjections(hist.result.value.projections, sessionId.slice(-12))
		const renameForm = [
			'<form method="post" action="' + this.escHtml(this.chatPath(sessionId)) + '">',
			'<label class="muted">会话名</label>',
			'<input type="text" name="title" value="' + this.escHtml(currentTitle) + '" maxlength="80" required>',
			'<button type="submit">改名</button></form>'
		].join('')
		const lastAssistant = last?.role === 'assistant' ? String(last.text || '').slice(0, 2500) : ''
		const body = [
			'<header class="chat-header"><a href="' + this.escHtml(this.chatPath()) + '">← 会话列表</a><strong style="margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + this.escHtml(currentTitle) + '</strong></header>',
			'<main>', extra, banners, questionBanners,
			this.voicePanel({ sessionId, title: currentTitle, token: this.config.token, mode: 'session' }),
			msgs,
			'<form id="composer" class="js-chat" method="post" action="' + this.escHtml(this.chatPath(sessionId)) + '" enctype="multipart/form-data">',
			'<textarea name="text" rows="3" placeholder="继续说…"></textarea>',
			'<input type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple>',
			'<div class="thumbs"></div><p class="muted img-hint">点选图，再选会追加，最多 20 张</p>',
			'<div class="composer-actions"><button type="submit" name="mode" value="queue">发送续聊</button><button type="submit" name="mode" value="steer" class="steer">⚡ 插队发送</button></div>',
			'<p class="muted">插队会尽快注入当前运行轮次；当前轮次已结束时自动转为普通续聊。</p></form>',
			'<details class="adv"><summary>高级 · 模型 / 权限 / 改名</summary>',
			modelForm, permForm, renameForm,
			'<p class="muted">' + archiveLink + '</p>',
			'</details>',
			draftJs, this.sendJs(), this.voiceJs(),
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell(currentTitle, body))
	}

	async handleChatReply(rawId, req, urlObj, res) {
		const sessionId = decodeURIComponent(rawId.split('?')[0])
		const fields = await this.readForm(req, urlObj)
		const images = this.formImages(fields)
		const title = (fields.title ?? '').trim()
		if (title && !(fields.text ?? '').trim() && !images.length) {
			const renamed = await this.client.sessions.rename({ sessionId, title })
			if (!renamed.result.ok) {
				return this.sendHtml(res, this.pageShell('改名失败', `<main><p>${this.escHtml(JSON.stringify(renamed.result.error))}</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 502)
			}
			this.note('renamed', { sessionId, title: renamed.result.value.title ?? title })
			return this.redirect(res, this.chatPath(sessionId))
		}
		const text = (fields.text ?? '').trim()
		if (!text && !images.length) return this.redirect(res, this.chatPath(sessionId))
		const requestedMode = String(fields.mode || '') === 'steer' ? 'steer' : 'queue'
		const content = this.promptContent(text, images)
		let actualMode = requestedMode
		let prompted = await this.client.sessions.prompt({ sessionId, mode: actualMode, content })
		if (!prompted.result.ok && requestedMode === 'steer') {
			const code = String(prompted.result.error?.code || '')
			const reason = String(prompted.result.error?.details?.reason || '')
			if (code === 'agent-busy' || code === 'steer-unavailable' || /steer|running|current turn/i.test(reason)) {
				actualMode = 'queue'
				prompted = await this.client.sessions.prompt({ sessionId, mode: actualMode, content })
			}
		}
		if (!prompted.result.ok) {
			return this.sendHtml(res, this.pageShell('发送失败', `<main><p>${this.escHtml(JSON.stringify(prompted.result.error))}</p></main>`), 502)
		}
		this.note('task', { sessionId, mode: actualMode, requestedMode, text: (text || '（图片）').slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: (text || '（图片）').slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`chat reply → ${sessionId} mode=${actualMode} requested=${requestedMode}`)
		const flag = requestedMode === 'steer' ? (actualMode === 'steer' ? '&steered=1' : '&steerFallback=1') : '&sent=1'
		this.redirect(res, this.chatPath(sessionId) + flag)
	}

	async handleChatImage(sessionId, attachmentId, res) {
		const got = await this.client.sessions.attachment({ sessionId, attachmentId })
		if (!got.result.ok) return this.sendJson(res, 404, { ok: false, error: got.result.error })
		const media = got.result.value.attachment?.mediaType || 'image/jpeg'
		const data = got.result.value.data
		const buf = Buffer.from(typeof data === 'string' ? data : '', 'base64')
		res.writeHead(200, { 'Content-Type': media, 'Cache-Control': 'private, max-age=86400' })
		res.end(buf)
	}

	async readForm(req, urlObj) {
		const ctype = String(req.headers['content-type'] ?? '')
		const rawBuf = await this.readRaw(req)
		const out = { files: [] }
		const bound = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
		if (bound) {
			Object.assign(out, this.parseMultipart(rawBuf, (bound[1] || bound[2] || '').trim()))
			for (const [k, v] of urlObj.searchParams) if (out[k] === undefined) out[k] = v
			return out
		}
		const raw = rawBuf.toString('utf8')
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
