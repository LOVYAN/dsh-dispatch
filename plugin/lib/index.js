// dsh-dispatch v0.2.0-rc.2.1 — phone dispatch + lock-screen approval bridge.
//
// Architecture (DeepSeek Harness 0.2.0-rc.2):
//   1. The local dispatch adapter uses injected host controllers and the shared
//      Typert event gateway. Approval receipts confirm submission, not who won.
//      Unsupported timed/plan interactions are delegated to the host UI.
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
import { createDispatchHostAdapter, REQUIRED_HOST_SERVICES } from './dispatch-adapter/index.mjs'
import { normalizeHistory } from './history-adapter/index.mjs'
import { taskIdentity } from './task-identity.mjs'
import { latestTurnResult } from './turn-result.mjs'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const OUTCOMES = new Set(['allowed-once', 'rejected'])
const MAX_BODY = 12 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const VIDEO_TYPES = new Map([['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']])
const MAX_IMAGES = 20
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const VIDEO_CHUNK_BYTES = 4 * 1024 * 1024
const VIDEO_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

export class DispatchService extends Service {
	static inject = ['webServer', ...REQUIRED_HOST_SERVICES]

	static Config = z.object({
		token: z.string().default(''),
		/** Phone-reachable base for decision links, e.g. https://pc.example.ts.net (empty = log-only links). */
		publicBaseUrl: z.string().default(''),
		/** Explicit independent voice origin; isolated tests must not use production 8443. */
		voiceBaseUrl: z.string().default(''),
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
		/** Page-scoped history research cards; stored outside Agent conversation context. */
		this.historyCards = this.loadHistoryCards()
		/** Literal message cache used only for first-pass keyword lookup. */
		this.historySearchIndex = this.loadHistorySearchIndex()
		/** Model-generated structured session digests used for semantic tag lookup. */
		this.sessionDigests = this.loadSessionDigests()
		this.sessionRunningState = new Map()
		this.client = createDispatchHostAdapter(this.ctx)
		this.ctx.effect(() => () => this.client.dispose())
		this.start()
	}

	get pendingCount() { return this.pending.size }

	secretsPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-dispatch.json')
	}

	videoUploadDir() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(dirname(home), '工作区', 'uploads', 'videos')
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

	historyCardsPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-history-search-results.json')
	}

	loadHistoryCards() {
		try {
			const parsed = JSON.parse(readFileSync(this.historyCardsPath(), 'utf8') || '{}')
			return new Map(Object.entries(parsed.scopes || {}).map(([key, rows]) => [key, Array.isArray(rows) ? rows : []]))
		} catch { return new Map() }
	}

	persistHistoryCards() {
		try {
			mkdirSync(dirname(this.historyCardsPath()), { recursive: true })
			writeFileSync(this.historyCardsPath(), JSON.stringify({ version: 1, updatedAt: Date.now(), scopes: Object.fromEntries(this.historyCards) }, null, 2) + '\n', 'utf8')
		} catch (err) {
			this.log('could not persist history cards:', err?.message ?? err)
		}
	}

	historySearchIndexPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-history-search-index.json')
	}

	loadHistorySearchIndex() {
		try {
			const parsed = JSON.parse(readFileSync(this.historySearchIndexPath(), 'utf8') || '{}')
			return new Map(Object.entries(parsed.sessions || {}))
		} catch { return new Map() }
	}

	persistHistorySearchIndex() {
		try {
			mkdirSync(dirname(this.historySearchIndexPath()), { recursive: true })
			writeFileSync(this.historySearchIndexPath(), JSON.stringify({ version: 1, updatedAt: Date.now(), sessions: Object.fromEntries(this.historySearchIndex) }) + '\n', 'utf8')
		} catch (err) {
			this.log('could not persist history search index:', err?.message ?? err)
		}
	}

	sessionDigestsPath() {
		const home = process.env.DSH_HOME || join(homedir(), '.dsh-home')
		return join(home, 'dsh-session-digests.json')
	}

	loadSessionDigests() {
		try {
			const parsed = JSON.parse(readFileSync(this.sessionDigestsPath(), 'utf8') || '{}')
			return new Map(Object.entries(parsed.sessions || {}))
		} catch { return new Map() }
	}

	persistSessionDigests() {
		try {
			mkdirSync(dirname(this.sessionDigestsPath()), { recursive: true })
			writeFileSync(this.sessionDigestsPath(), JSON.stringify({ version: 1, updatedAt: Date.now(), sessions: Object.fromEntries(this.sessionDigests) }, null, 2) + '\n', 'utf8')
		} catch (err) {
			this.log('could not persist session digests:', err?.message ?? err)
		}
	}

	normalizeDigest(sessionId, value, metadata = {}) {
		const list = (name, max) => [...new Set((Array.isArray(value?.[name]) ? value[name] : []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, max)
		return {
			sessionId,
			title: String(value?.title || metadata.title || sessionId.slice(-12)).slice(0, 200),
			summary: String(value?.summary || '').trim().slice(0, 5000),
			topics: list('topics', 5), subjects: list('subjects', 8), problems: list('problems', 8),
			carriers: list('carriers', 6), outcomes: list('outcomes', 6), keywords: list('keywords', 15),
			createdAt: Number(metadata.createdAt || value?.createdAt || 0), updatedAt: Number(metadata.updatedAt || value?.updatedAt || 0),
			lastRelevantAt: Number(value?.lastRelevantAt || metadata.updatedAt || 0), sourceSeq: Number(metadata.sourceSeq || value?.sourceSeq || 0),
			compactionId: String(metadata.compactionId || value?.compactionId || ''), indexedAt: Date.now()
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
		this.ctx.effect(() => {
			const timer = setInterval(() => {
				try { const removed = this.cleanVideoUploads(); if (removed) this.log(`cleaned ${removed} expired video upload files`) } catch (err) { this.log('video upload cleanup failed:', err) }
			}, 60 * 60 * 1000)
			return () => clearInterval(timer)
		}, 'dsh-dispatch: video upload cleanup')
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
		// rc2 approvalId is a synthetic event identity, not an audit correlation id.
		const dedupeKey = `${frame.sessionId}/${frame.approvalId}`
		const firstSeen = this.markSeen(dedupeKey) // Rebuild pending on replay; suppress only duplicate push.
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
		if (firstSeen && this.config.pushEnabled) void this.notify(rpcId, entry)
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

	videoUploadMetaPath(id) { return join(this.videoUploadDir(), String(id) + '.json') }
	videoUploadPartPath(id) { return join(this.videoUploadDir(), String(id) + '.part') }

	cleanVideoUploads() {
		const dir = this.videoUploadDir()
		if (!existsSync(dir)) return 0
		let removed = 0
		const cutoff = Date.now() - VIDEO_UPLOAD_TTL_MS
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.json') && !name.endsWith('.part') && !name.endsWith('.upload')) continue
			const path = join(dir, name)
			try { if (statSync(path).mtimeMs < cutoff) { unlinkSync(path); removed += 1 } } catch { /* ignore */ }
		}
		return removed
	}

	videoUploadFingerprint(value) {
		return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32)
	}

	readVideoUploadMeta(id) {
		if (!/^[a-f0-9]{32}$/.test(String(id || ''))) return null
		try { return JSON.parse(readFileSync(this.videoUploadMetaPath(id), 'utf8')) } catch { return null }
	}

	writeVideoUploadMeta(meta) {
		writeFileSync(this.videoUploadMetaPath(meta.id), JSON.stringify(meta, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
	}

	initVideoUpload(fields) {
		this.cleanVideoUploads()
		const mediaType = String(fields.mediaType || '').toLowerCase().split(';')[0].trim()
		const ext = VIDEO_TYPES.get(mediaType)
		const totalBytes = Number(fields.totalBytes || 0)
		if (!ext) throw Object.assign(new Error('unsupported video type'), { statusCode: 415 })
		if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_VIDEO_BYTES) throw Object.assign(new Error('invalid video size'), { statusCode: 413 })
		const originalName = String(fields.originalName || ('video' + ext)).replace(/[\r\n\\/]/g, '_').slice(0, 240)
		const lastModified = Number(fields.lastModified || 0)
		const fingerprint = String(fields.fingerprint || `${originalName}|${totalBytes}|${lastModified}|${mediaType}`)
		const id = this.videoUploadFingerprint(fingerprint)
		const dir = this.videoUploadDir()
		mkdirSync(dir, { recursive: true })
		let meta = this.readVideoUploadMeta(id)
		if (!meta || meta.totalBytes !== totalBytes || meta.mediaType !== mediaType || meta.completed) {
			meta = { id, originalName, mediaType, ext, totalBytes, lastModified, receivedBytes: 0, sessionId: String(fields.sessionId || '').slice(0, 160), createdAt: Date.now(), updatedAt: Date.now(), completed: false }
			try { unlinkSync(this.videoUploadPartPath(id)) } catch { /* ignore */ }
			this.writeVideoUploadMeta(meta)
		} else {
			try { meta.receivedBytes = Math.min(totalBytes, statSync(this.videoUploadPartPath(id)).size) } catch { meta.receivedBytes = 0 }
			meta.updatedAt = Date.now()
			this.writeVideoUploadMeta(meta)
		}
		return { uploadId: id, receivedBytes: meta.receivedBytes, totalBytes, chunkBytes: VIDEO_CHUNK_BYTES }
	}

	videoSignatureOk(path, mediaType) {
		let fd
		try {
			fd = openSync(path, 'r')
			const head = Buffer.alloc(16)
			const n = readSync(fd, head, 0, head.length, 0)
			if (mediaType === 'video/webm') return n >= 4 && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
			if (mediaType === 'video/mp4' || mediaType === 'video/quicktime') return n >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp'
			return false
		} catch { return false } finally { if (fd !== undefined) closeSync(fd) }
	}

	receiveVideoChunk(req, uploadId) {
		return new Promise((resolve, reject) => {
			const meta = this.readVideoUploadMeta(uploadId)
			if (!meta || meta.completed) return reject(Object.assign(new Error('upload not found'), { statusCode: 404 }))
			const offset = Number(req.headers['x-dsh-upload-offset'] || -1)
			const declaredLength = Number(req.headers['content-length'] || 0)
			if (!Number.isSafeInteger(offset) || offset !== meta.receivedBytes) return reject(Object.assign(new Error(`offset mismatch; expected ${meta.receivedBytes}`), { statusCode: 409, expectedOffset: meta.receivedBytes }))
			if (!declaredLength || declaredLength > VIDEO_CHUNK_BYTES || offset + declaredLength > meta.totalBytes) return reject(Object.assign(new Error('invalid chunk size'), { statusCode: 413 }))
			const path = this.videoUploadPartPath(uploadId)
			const stream = createWriteStream(path, { flags: offset === 0 ? 'w' : 'r+', start: offset, mode: 0o600 })
			let bytes = 0
			let settled = false
			const fail = (err) => {
				if (settled) return
				settled = true
				try { stream.destroy() } catch { /* ignore */ }
				try { if (existsSync(path)) truncateSync(path, offset) } catch { /* ignore */ }
				this.log(`video chunk failed id=${uploadId} offset=${offset} received=${bytes}: ${String(err?.message || err)}`)
				reject(err)
			}
			req.on('data', (chunk) => { bytes += chunk.length; if (bytes > declaredLength) fail(Object.assign(new Error('chunk larger than declared'), { statusCode: 400 })) })
			req.on('aborted', () => fail(Object.assign(new Error('chunk upload aborted'), { statusCode: 499 })))
			req.on('error', fail)
			stream.on('error', fail)
			stream.on('finish', () => {
				if (settled) return
				if (bytes !== declaredLength) return fail(Object.assign(new Error('incomplete chunk'), { statusCode: 400 }))
				meta.receivedBytes = offset + bytes
				meta.updatedAt = Date.now()
				try {
					this.writeVideoUploadMeta(meta)
					settled = true
					resolve({ uploadId, receivedBytes: meta.receivedBytes, totalBytes: meta.totalBytes, complete: meta.receivedBytes === meta.totalBytes })
				} catch (err) { fail(err) }
			})
			req.pipe(stream)
		})
	}

	completeVideoUpload(uploadId) {
		const meta = this.readVideoUploadMeta(uploadId)
		if (!meta || meta.completed) throw Object.assign(new Error('upload not found'), { statusCode: 404 })
		const partPath = this.videoUploadPartPath(uploadId)
		let bytes = 0
		try { bytes = statSync(partPath).size } catch { /* missing */ }
		if (bytes !== meta.totalBytes || meta.receivedBytes !== meta.totalBytes) throw Object.assign(new Error(`upload incomplete; received ${bytes} of ${meta.totalBytes}`), { statusCode: 409, expectedOffset: bytes })
		if (!this.videoSignatureOk(partPath, meta.mediaType)) throw Object.assign(new Error('video bytes do not match declared type'), { statusCode: 415 })
		const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + randomBytes(6).toString('hex')
		const finalPath = join(this.videoUploadDir(), id + meta.ext)
		renameSync(partPath, finalPath)
		meta.completed = true
		meta.finalPath = finalPath
		meta.updatedAt = Date.now()
		try { unlinkSync(this.videoUploadMetaPath(uploadId)) } catch { /* ignore */ }
		return { id, sessionId: meta.sessionId, originalName: meta.originalName, storedPath: finalPath, mediaType: meta.mediaType, bytes, uploadedAt: Date.now() }
	}

	formVideos(fields) {
		const rows = Array.isArray(fields.videos) ? fields.videos : []
		const root = resolve(this.videoUploadDir())
		const out = []
		for (const value of rows.slice(0, 1)) {
			const storedPath = resolve(String(value?.storedPath || ''))
			const mediaType = String(value?.mediaType || '').toLowerCase()
			if (!storedPath.startsWith(root + sep) || !VIDEO_TYPES.has(mediaType) || !existsSync(storedPath)) continue
			try {
				const stat = statSync(storedPath)
				const bytes = stat.size
				if (!stat.isFile() || !bytes || bytes > MAX_VIDEO_BYTES || !this.videoSignatureOk(storedPath, mediaType)) continue
				const originalName = String(value?.originalName || ('video' + extname(storedPath))).replace(/[\r\n\\/]/g, '_').slice(0, 240)
				out.push({ storedPath, mediaType, bytes, originalName })
			} catch { /* invalid upload reference */ }
		}
		return out
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

	videoPromptText(video) {
		if (!video || typeof video !== 'object' || !video.storedPath) return ''
		const bytes = Number(video.bytes || 0)
		const size = bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '未知大小'
		return [
			'【本地视频附件】',
			`原文件名：${String(video.originalName || 'video').slice(0, 240)}`,
			`媒体类型：${String(video.mediaType || 'video/mp4')}`,
			`文件大小：${size}`,
			`本机路径：${String(video.storedPath)}`,
			'请把这个路径视为用户本轮上传的视频。优先使用当前可用的视频理解能力或相关工具直接处理；若当前模型通道不能原生读取视频，则使用本机工具检查视频、抽取关键帧和音频后再分析。不要声称视频已直接进入 session.prompt 的原生附件协议。'
		].join('\n')
	}

	promptContent(text, images, video) {
		const content = []
		const videoText = this.videoPromptText(video)
		const combinedText = [text, videoText].filter(Boolean).join('\n\n')
		if (combinedText) content.push({ type: 'text', text: combinedText })
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
		const normalized = normalizeHistory(entries ?? [])
		for (const d of normalized.diagnostics) this.note('history-diagnostic', { code: d.code, seq: d.seq })
		return normalized.messages
	}

	// Display-only projection: command records never enter chat folding or run-state heuristics.
	renderHistoryProjection(projection, sessionId) {
		const rows = projection.messages.map((m) => {
			const who = m.role === 'user' ? '你' : '助手'
			const pics = (m.images ?? []).map((img) => {
				if (img.attachmentId) return `<img class="pic" alt="" src="${this.escHtml(this.imgPath(sessionId, img.attachmentId))}">`
				if (img.data) return `<img class="pic" alt="" src="data:${this.escHtml(img.mediaType || 'image/jpeg')};base64,${img.data}">`
				return ''
			}).join('')
			return { seq: m.seq, html: `<div class="msg ${m.role}"><div class="meta">${who}</div>${this.escHtml(m.text || '')}${pics}</div>` }
		})
		for (const command of projection.commandRecords) {
			const literal = '/' + command.name + (command.inputRecorded ? command.args : '')
			const gaps = []
			if (!command.inputRecorded) gaps.push('输入未记录；不从其他事件推断。')
			if (command.status === 'outcome-not-in-window') gaps.push('本页未包含此命令的回复；不能据此判断正在运行、失败或取消。')
			if (command.status === 'invalid-outcome') gaps.push('回复记录无效，未展示；不推断执行结果。')
			rows.push({ seq: command.seq, html: '<div class="msg historical-command"><div class="meta">历史命令（只读）</div>' + this.escHtml(literal) + (gaps.length ? '<div class="muted">' + gaps.join('\n') + '</div>' : '') + '</div>' })
			if (command.outcome) {
				const outcome = command.outcome
				rows.push({ seq: outcome.seq, html: '<div class="msg historical-command-reply"><div class="meta">历史命令回复（只读） · ' + this.escHtml('/' + command.name) + ' · ' + (outcome.kind === 'success' ? '记录为成功' : '记录为错误') + '</div>' + (outcome.text === undefined ? '<div class="muted">回复未记录文本。</div>' : this.escHtml(outcome.text)) + (outcome.sourceEventSeq !== undefined ? '<div class="muted">关联的领域展示未投影；不从引用推断内容。</div>' : '') + '</div>' })
			}
		}
		// Never manufacture chronology from timestamps or array positions when sequences are unsafe.
		const safeOrder = rows.every(row => Number.isSafeInteger(row.seq) && row.seq >= 0) && new Set(rows.map(row => row.seq)).size === rows.length
		if (safeOrder) rows.sort((a, b) => a.seq - b.seq)
		const partial = !projection.complete ? '<p class="muted" role="note">本页历史投影不完整；缺少配对记录或存在未展示事件。请查看其他历史页，不据此推断缺失内容或执行状态。</p>' : ''
		const orphanNote = projection.diagnostics.some(d => d.code === 'command-run-not-in-window') ? '<p class="muted" role="note">本页包含命令回复事件，但缺少对应的命令记录；未展示孤立回复，也未将其归属为助手消息。请查看其他历史页。</p>' : ''
		const orderNote = !safeOrder ? '<p class="muted" role="note">记录缺少唯一稳定序号，聊天与命令分组展示，不代表交错时间顺序。</p>' : ''
		return partial + orphanNote + orderNote + (rows.map(row => row.html).join('') || '<p class="muted">本页没有可展示的聊天消息或完整可识别的历史命令；不代表没有其他交互记录。</p>')
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
			const latest = latestTurnResult(hist.result.value.events, folded)
			const previous = this.turnResults.get(sessionId)
			if (!latest.settled) return null
			if (previous?.sourceSeq === latest.sourceSeq) return previous
			isError = latest.isError
			const result = latest.result
			const record = {
				sessionId,
				completedAt: Date.now(),
				instruction: String(latest.instruction || '').slice(0, 2000),
				sourceSeq: latest.sourceSeq,
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
			return null // Never turn unavailable current history into a stale success.
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
		let configuredBase = ''
		if (this.config.voiceBaseUrl) {
			const url = new URL(this.config.voiceBaseUrl)
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid voiceBaseUrl')
			configuredBase = url.href.replace(/\/$/, '') + '/'
		}
		const baseExpression = configuredBase ? JSON.stringify(configuredBase).replace(/</g, '\\u003c') : '"https://"+location.hostname+":8443/"'
		return [
			'<script>(function(){',
			'var btn=document.getElementById("sts-voice-toggle");var panel=document.getElementById("sts-voice-panel");var close=document.getElementById("sts-voice-close");var frame=document.getElementById("sts-voice-frame");if(!btn||!panel||!frame)return;',
			'var state={sessionId:"",token:"",mode:"session"};try{var el=document.getElementById("dsh-voice-state");if(el)state=JSON.parse(el.textContent||"{}")}catch(e){}',
			'var base=' + baseExpression + ';var q=new URLSearchParams({token:state.token||"",mode:state.mode||"session"});if(state.sessionId)q.set("sessionId",state.sessionId);if(state.title)q.set("title",state.title);var voiceUrl=base+"?"+q.toString();frame.src=voiceUrl;',
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

	sendAttachmentJs() {
		return [
			'<script>(function(){',
			'function load(f){return new Promise(function(ok,bad){var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){ok(im)};im.onerror=bad;im.src=r.result};r.onerror=bad;r.readAsDataURL(f)})}',
			'function pack(f){return load(f).then(function(im){var m=1280,w=im.width,h=im.height;if(w>m||h>m){var s=Math.min(m/w,m/h);w=Math.round(w*s);h=Math.round(h*s)}var c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(im,0,0,w,h);return{name:((f.name||"image").replace(/\\.[^.]+$/ ,"")||"image")+".jpg",mediaType:"image/jpeg",data:c.toDataURL("image/jpeg",.72).replace(/^data:[^;]+;base64,/,"")}})}',
			'function key(f){return(f.name||"")+"|"+f.size+"|"+(f.lastModified||0)}function human(n){return n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}',
			'function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}function requestJson(url,opt){return fetch(url,opt).then(function(r){return r.text().then(function(t){var b={};try{b=JSON.parse(t||"{}")}catch(e){}if(!r.ok||!b.ok){var x=new Error(b.error||("HTTP "+r.status));x.expectedOffset=b.expectedOffset;throw x}return b})})}',
			'function upload(f,form,hint){var a=new URL(form.action,location.href),m=a.pathname.match(/\\/dispatch\\/chat\\/([^/?]+)/),sid=m?decodeURIComponent(m[1]):"",token=encodeURIComponent(a.searchParams.get("token")||""),fingerprint=[f.name,f.size,f.lastModified||0,f.type].join("|");return requestJson("/dispatch/video-upload/init?token="+token,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({originalName:f.name,mediaType:f.type,totalBytes:f.size,lastModified:f.lastModified||0,fingerprint:fingerprint,sessionId:sid})}).then(async function(init){var id=init.uploadId,offset=init.receivedBytes||0,chunk=init.chunkBytes||4194304;if(hint&&offset)hint.textContent="已恢复到 "+Math.round(offset/f.size*100)+"%";while(offset<f.size){var end=Math.min(offset+chunk,f.size),blob=f.slice(offset,end),done=false,last;for(var attempt=1;attempt<=3&&!done;attempt++){try{var b=await requestJson("/dispatch/video-upload/"+id+"/chunk?token="+token,{method:"POST",headers:{"Content-Type":"application/octet-stream","X-DSH-Upload-Offset":String(offset)},body:blob});offset=b.receivedBytes;done=true;if(hint)hint.textContent="正在上传视频 "+Math.round(offset/f.size*100)+"%（"+human(offset)+" / "+human(f.size)+"）"}catch(e){last=e;var expected=Number(e.expectedOffset);if(Number.isFinite(expected)&&expected>=end){offset=expected;done=true;break}if(Number.isFinite(expected))offset=expected;if(attempt<3){if(hint)hint.textContent="网络波动，正在重试第 "+attempt+" 次…";await sleep(attempt*1200)}}}if(!done)throw last}if(hint)hint.textContent="正在校验视频…";return requestJson("/dispatch/video-upload/"+id+"/complete?token="+token,{method:"POST"}).then(function(b){return b.video})})}',
			'function hook(form){var input=form.querySelector("input[type=file]"),box=form.querySelector(".thumbs"),hint=form.querySelector(".img-hint"),bag=[];if(!input)return;function images(){return bag.filter(function(f){return f.type.indexOf("image/")===0})}function video(){return bag.find(function(f){return f.type.indexOf("video/")===0})}function draw(){if(!box)return;box.innerHTML="";var vid=video();if(hint)hint.textContent=(bag.length?("已选 "+images().length+" 张图片"+(vid?"、视频 "+vid.name+"（"+human(vid.size)+"）":"")+" · 点预览删除"):"可选图片或视频：最多20张图片、1个视频（最大200MB）");bag.forEach(function(f,i){if(f.type.indexOf("image/")===0){var im=document.createElement("img");im.alt="删";im.title="点一下删除";im.src=URL.createObjectURL(f);im.onclick=function(){bag.splice(i,1);draw()};box.appendChild(im)}else{var v=document.createElement("button");v.type="button";v.className="video-chip";v.textContent="🎬 "+f.name+" · "+human(f.size)+" · 点此删除";v.onclick=function(){bag.splice(i,1);draw()};box.appendChild(v)}})}',
			'input.addEventListener("change",function(){[].slice.call(input.files||[]).forEach(function(f){var im=f.type.indexOf("image/")===0,vi=f.type.indexOf("video/")===0;if(!im&&!vi)return;if(vi){if(f.size>209715200){alert("视频不能超过200MB");return}bag=bag.filter(function(x){return x.type.indexOf("video/")!==0})}else if(images().length>=20)return;if(!bag.some(function(x){return key(x)===key(f)}))bag.push(f)});input.value="";draw()});draw();',
			'form.addEventListener("submit",function(ev){if(!bag.length)return;ev.preventDefault();var btn=ev.submitter||form.querySelector("button[type=submit]"),old=btn&&btn.textContent,mode=(btn&&btn.name==="mode"&&btn.value)||"queue";if(btn){btn.disabled=true;btn.textContent="正在处理附件…"}form.classList.add("busy");var ims=images().slice(0,20),vid=video();Promise.all([Promise.all(ims.map(function(f){return pack(f).catch(function(){return null})})),vid?upload(vid,form,hint):Promise.resolve(null)]).then(function(p){var imgs=p[0].filter(Boolean),v=p[1];if(ims.length&&!imgs.length)throw new Error("图片读不出来，请换jpg/png再试");try{sessionStorage.removeItem("dsh-draft-"+location.pathname)}catch(e){}var body={text:(form.querySelector("textarea[name=text]")||{}).value||"",images:imgs,videos:v?[v]:[],mode:mode};["agentPreset","model","permission"].forEach(function(n){var e=form.querySelector("[name="+n+"]");if(e&&e.value)body[n]=e.value});if(btn)btn.textContent="正在提交到Harness…";return fetch(form.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),credentials:"same-origin"}).then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t.slice(0,180)||("HTTP "+r.status))});var loc=r.url||form.action;if(loc.indexOf("/dispatch/chat")>=0&&loc.indexOf("sent=")<0)loc+=(loc.indexOf("?")>=0?"&":"?")+"sent=1";location.href=loc})}).catch(function(e){alert("发送失败："+(e&&e.message||e));if(btn){btn.disabled=false;btn.textContent=old||"发送"}form.classList.remove("busy");draw()})})}',
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
			'.thumbs img{width:64px;height:64px;object-fit:cover;border-radius:8px}.video-chip{width:100%;text-align:left;background:#16253d;color:#e6f1ff;border:1px solid #355070;border-radius:9px;padding:10px}',
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
			'.question-overlay{position:fixed;inset:0;z-index:1000;background:rgba(4,9,24,.72);display:flex;align-items:flex-start;justify-content:center;padding:64px 12px 16px;box-sizing:border-box;backdrop-filter:blur(3px)}.question-overlay[hidden]{display:none}',
			'.question-modal{width:min(720px,100%);max-height:calc(100vh - 80px);background:#132a3a;border:1px solid #3a86ff;border-radius:14px;box-shadow:0 18px 55px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden}',
			'.question-modal-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid #31506d;background:#10283a;flex:none}.question-modal-head strong{font-size:17px}.question-count{font-size:13px;opacity:.7}.question-minimize{margin:0 0 0 auto;background:#33415c;padding:7px 11px}',
			'.question-scroll{overflow:auto;padding:0 14px 14px}.question-form{padding:0;margin-top:10px}.question-actions{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:0;background:#132a3a;padding:8px 0}.question-skip{background:#5c677d}',
			'.question-reminder{position:fixed;z-index:1001;top:52px;left:50%;transform:translateX(-50%);width:min(696px,calc(100% - 24px));box-sizing:border-box;background:#7a4d00;border:1px solid #ffb703;border-radius:0 0 12px 12px;padding:9px 12px;box-shadow:0 8px 22px rgba(0,0,0,.45);display:flex;align-items:center;gap:8px}.question-reminder[hidden]{display:none}.question-reminder button{margin:0 0 0 auto;padding:7px 11px}.question-open{overflow:hidden}',
			'.question-field{border:1px solid #3a506b;border-radius:10px;margin:10px 0;padding:10px}',
			'.question-field legend{color:#8be9fd;padding:0 6px}',
			'.question-text{font-weight:600;margin-bottom:8px;white-space:pre-wrap}',
			'.question-option{display:flex;align-items:flex-start;gap:9px;background:#111a33;border:1px solid #263b5e;border-radius:9px;padding:10px;margin:8px 0}',
			'.question-option input{width:20px;height:20px;flex:none;margin:1px 0 0}',
			'.question-option small{display:block;opacity:.65;margin-top:3px}',
			'.question-custom{display:block;margin-top:10px}.question-custom span{display:block;font-size:13px;opacity:.7;margin-bottom:5px}',
			'.history-cards{margin:12px 0}.history-cards h3{font-size:15px;color:#8be9fd}.history-card{background:#101f32;border:1px solid #355070;border-radius:10px;padding:8px 12px;margin:8px 0}.history-card summary{cursor:pointer;font-weight:600}.history-summary{white-space:pre-wrap;line-height:1.5;margin:10px 0}',
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
			if (route === '/dispatch/video-upload/init' && req.method === 'POST') {
				try {
					const fields = await this.readForm(req, urlObj)
					return this.sendJson(res, 200, { ok: true, ...this.initVideoUpload(fields) })
				} catch (err) { return this.sendJson(res, Number(err?.statusCode || 500), { ok: false, error: String(err?.message || err) }) }
			}
			const videoChunkMatch = route.match(/^\/dispatch\/video-upload\/([^/]+)\/chunk$/)
			if (videoChunkMatch && req.method === 'POST') {
				try { return this.sendJson(res, 200, { ok: true, ...(await this.receiveVideoChunk(req, videoChunkMatch[1])) }) }
				catch (err) { return this.sendJson(res, Number(err?.statusCode || 500), { ok: false, error: String(err?.message || err), expectedOffset: err?.expectedOffset }) }
			}
			const videoCompleteMatch = route.match(/^\/dispatch\/video-upload\/([^/]+)\/complete$/)
			if (videoCompleteMatch && req.method === 'POST') {
				try {
					const video = this.completeVideoUpload(videoCompleteMatch[1])
					this.note('video-uploaded', { sessionId: video.sessionId, mediaType: video.mediaType, bytes: video.bytes, storedPath: video.storedPath })
					return this.sendJson(res, 200, { ok: true, video })
				} catch (err) { return this.sendJson(res, Number(err?.statusCode || 500), { ok: false, error: String(err?.message || err), expectedOffset: err?.expectedOffset }) }
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
				// Persisted cache is historical evidence, not proof of the latest turn.
				let record = await this.captureTurnResult(sessionId)
				if (record && !record.speechSummary && record.result) {
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
			if (route === '/dispatch/history-search' && req.method === 'POST') {
				const fields = await this.readForm(req, urlObj)
				if (fields.stage === 'tags') {
					const listed = await this.client.sessions.list({})
					if (!listed.result.ok) return this.sendJson(res, 502, { ok: false, error: listed.result.error })
					const matches = this.searchSessionDigests(fields.criteria || {}, listed.result.value.items ?? [], String(fields.preferredSessionId || ''))
					return this.sendJson(res, 200, { ok: true, stage: 'tags', matches })
				}
				const queries = Array.isArray(fields.queries) ? fields.queries : [fields.query]
				const excludedSessionIds = Array.isArray(fields.excludedSessionIds) ? fields.excludedSessionIds.map(String) : []
				const result = await this.searchHistory(queries, String(fields.preferredSessionId || ''), excludedSessionIds)
				return this.sendJson(res, 200, { ok: true, stage: 'literal', ...result })
			}
			if (route === '/dispatch/session-digests/pending' && req.method === 'GET') {
				const excludedSessionIds = String(urlObj.searchParams.get('exclude') || '').split(',').filter(Boolean)
				const items = await this.pendingSessionDigests(urlObj.searchParams.get('limit'), excludedSessionIds)
				return this.sendJson(res, 200, { ok: true, items })
			}
			if (route === '/dispatch/session-tag-catalog' && req.method === 'GET') return this.sendJson(res, 200, { ok: true, catalog: this.tagCatalog() })
			if (route === '/dispatch/session-digest' && req.method === 'POST') {
				const fields = await this.readForm(req, urlObj)
				const sessionId = String(fields.sessionId || '')
				if (!sessionId) return this.sendJson(res, 400, { ok: false, error: 'sessionId-required' })
				const digest = this.normalizeDigest(sessionId, fields.digest || {}, fields.metadata || {})
				this.sessionDigests.set(sessionId, digest)
				this.persistSessionDigests()
				return this.sendJson(res, 200, { ok: true, digest })
			}
			const historyMatch = route.match(/^\/dispatch\/session-history\/([^/]+)$/)
			if (historyMatch && req.method === 'GET') {
				const sessionId = decodeURIComponent(historyMatch[1])
				const page = await this.sessionHistoryPage(sessionId, urlObj.searchParams.get('beforeSeq'), urlObj.searchParams.get('maxMessages'), urlObj.searchParams.get('historyToken'))
				let title = sessionId.slice(-12)
				try {
					const listed = await this.client.sessions.list({})
					const row = listed.result.ok ? (listed.result.value.items ?? []).find((s) => s.sessionId === sessionId) : null
					if (row) title = this.sessionTitleOf(row)
				} catch { /* fallback */ }
				return this.sendJson(res, 200, { ok: true, sessionId, title, ...page })
			}
			if (route === '/dispatch/history-card/delete' && req.method === 'GET') {
				const scope = String(urlObj.searchParams.get('scope') || '').slice(0, 200)
				const cardId = String(urlObj.searchParams.get('cardId') || '')
				if (scope && cardId) {
					const rows = (this.historyCards.get(scope) ?? []).filter((card) => card.id !== cardId)
					if (rows.length) this.historyCards.set(scope, rows)
					else this.historyCards.delete(scope)
					this.persistHistoryCards()
				}
				return this.redirect(res, scope && scope !== 'global' ? this.chatPath(scope) : this.chatPath())
			}
			if (route === '/dispatch/history-card' && req.method === 'POST') {
				const fields = await this.readForm(req, urlObj)
				const scope = String(fields.scope || 'global').slice(0, 200)
				const summary = String(fields.summary || '').trim().slice(0, 12000)
				if (!summary) return this.sendJson(res, 400, { ok: false, error: 'summary-required' })
				const sources = (Array.isArray(fields.sources) ? fields.sources : []).slice(0, 8).map((source) => ({
					sessionId: String(source?.sessionId || ''), title: String(source?.title || '').slice(0, 160), snippet: String(source?.snippet || '').slice(0, 1000)
				})).filter((source) => source.sessionId)
				const card = this.saveHistoryCard(scope, { query: String(fields.query || '').slice(0, 500), summary, sources })
				return this.sendJson(res, 200, { ok: true, card })
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

	renderQuestionModal(rpcId, entry, returnSessionId, position = 1, total = 1) {
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
		const count = total > 1 ? ` <span class="question-count">${position}/${total}</span>` : ''
		return [
			'<div class="question-reminder" hidden><strong>⚠️ 任务正在等待你的回答' + count + '</strong><button type="button" data-question-open>立即处理</button></div>',
			'<div class="question-overlay" role="dialog" aria-modal="true" aria-labelledby="question-title">',
			'<section class="question-modal"><div class="question-modal-head"><strong id="question-title">需要你回答' + count + '</strong><button type="button" class="question-minimize" data-question-minimize>暂时收起</button></div>',
			'<div class="question-scroll"><form class="question-form" method="post" action="/dispatch/question?token=' + encodeURIComponent(this.config.token) + '">',
			'<input type="hidden" name="rpcId" value="' + this.escHtml(rpcId) + '">',
			'<input type="hidden" name="returnSessionId" value="' + this.escHtml(returnSessionId) + '">',
			fields,
			'<div class="question-actions"><button type="submit" name="questionAction" value="answer">提交回答</button>',
			'<button type="submit" name="questionAction" value="skip" class="question-skip" formnovalidate>跳过本次并继续</button></div>',
			'<p class="muted">跳过会明确告知助手依据现有信息自行判断并继续，不是仅关闭窗口。</p>',
			'</form></div></section></div>',
			'<script>(function(){var o=document.querySelector(".question-overlay"),r=document.querySelector(".question-reminder"),a=document.querySelector("[data-question-minimize]"),b=document.querySelector("[data-question-open]");if(!o||!r)return;function set(open){o.hidden=!open;r.hidden=open;document.body.classList.toggle("question-open",open)}if(a)a.onclick=function(){set(false)};if(b)b.onclick=function(){set(true)};set(true)})()</script>'
		].join('')
	}

	async handleQuestion(req, urlObj, res) {
		const fields = await this.readForm(req, urlObj)
		const rpcId = String(fields.rpcId || '')
		const returnSessionId = String(fields.returnSessionId || '')
		const entry = this.pendingQuestions.get(rpcId)
		if (!entry) {
			return this.sendResultPage(res, '⏳', '问题已不在等待列表', '可能已被回答、取消或连接中断；请查看会话状态，不要据此认定回答成功。',
				returnSessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(returnSessionId))}" style="color:#8be9fd">返回会话</a></p>` : '')
		}
		const action = String(fields.questionAction || 'answer')
		const skipped = action === 'skip'
		const answers = entry.questions.map((q, qi) => {
			if (skipped) return { id: q.id, selected: [], custom: '用户选择跳过本题，请依据已有信息自行判断并继续。' }
			const selected = []
			if (q.multiSelect === true) {
				for (let oi = 0; oi < (q.options ?? []).length; oi += 1) {
					if (String(fields[`q${qi}o${oi}`] || '') === '1') selected.push(q.options[oi].label)
				}
			} else {
				const rawPick = fields[`q${qi}pick`]
				const picked = rawPick === null || rawPick === undefined || rawPick === '' ? NaN : Number(rawPick)
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
		if (receipt.submitted) {
			this.pendingQuestions.delete(rpcId)
			this.note('question-submitted-unconfirmed', { rpcId, sessionId: entry.sessionId })
			return this.sendResultPage(res, '⏳', '回答已发送，结果待确认', '系统已收到响应，但无法确认此答案是否被采纳；也可能已由其他客户端处理。请返回会话查看状态。', `<p><a href="${this.escHtml(this.chatPath(returnSessionId || entry.sessionId))}">返回会话</a></p>`)
		}
		if (!receipt.accepted) {
			if (receipt.reason === 'not-pending') this.pendingQuestions.delete(rpcId)
			return this.sendResultPage(res, '⏳', '回答没有提交', receipt.reason === 'not-pending' ? '电脑端已经先行回答。' : `Harness 拒绝了回答：${receipt.reason || 'unknown'}`,
				returnSessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(returnSessionId))}" style="color:#8be9fd">返回会话</a></p>` : '')
		}
		this.pendingQuestions.delete(rpcId)
		this.note(skipped ? 'question-skipped' : 'question-answered', { rpcId, sessionId: entry.sessionId, answers })
		return this.redirect(res, this.chatPath(returnSessionId || entry.sessionId))
	}

	async applyDecision(rpcId, outcome, sessionId, approvalId) {
		const receipt = await this.client.respond({
			type: 'client-response',
			rpcId,
			result: { ok: true, value: { sessionId, approvalId, outcome } }
		})
		if (receipt.submitted || receipt.accepted || receipt.reason === 'not-pending') {
			this.pending.delete(rpcId)
			for (const [k, v] of this.pendingByKey) if (v === rpcId) { this.pendingByKey.delete(k); break }
		}
		this.note('decision-response', { rpcId, outcome, receipt })
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
		if (receipt.submitted) {
			return this.sendResultPage(res, '⏳', '审批响应已发送，结果待确认', '系统已收到响应，但这不证明审批已生效。请查看会话状态，不要重复批准。', sessionId ? `<p><a href="${this.escHtml(this.chatPath(sessionId))}">打开会话</a></p>` : '')
		}
		if (!receipt.accepted) {
			return this.sendResultPage(res, '⏳', '审批状态未确认', receipt.reason === 'not-pending' ? '当前请求已不在等待列表中，可能已处理或取消。' : '未能确认响应结果，请查看会话状态，不要自动重试。',
				sessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(sessionId))}" style="color:#8be9fd">打开会话</a></p>` : '')
		}
		this.sendResultPage(res,
			outcome === 'allowed-once' ? '✅' : '🚫',
			outcome === 'allowed-once' ? '已批准 · 会话继续' : '已拒绝',
			'session …' + sessionId.slice(-12),
			sessionId ? `<p style="margin-top:20px"><a href="${this.escHtml(this.chatPath(sessionId))}" style="color:#8be9fd">打开会话 · 看回复 / 续聊</a></p>` : '')
	}

	normalizeSearchText(value) {
		return String(value || '').toLowerCase().replace(/[\s，。！？、,.!?“”"'：:；;（）()\[\]【】_-]+/g, '')
	}

	async rebuildFallbackHistoryIndex(summaries) {
		let changed = false
		for (const summary of summaries) {
			const cached = this.historySearchIndex.get(summary.sessionId)
			if (cached && Number(cached.sourceSeq || 0) > 0 && Object.hasOwn(cached, 'latestCompaction') && Number(cached.updatedAt || 0) === Number(summary.updatedAt || 0)) continue
			const allEvents = []
			let beforeSeq
			let historyToken
			for (let page = 0; page < 5; page += 1) {
				const request = { sessionId: summary.sessionId, maxMessages: 100 }
				if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
				if (historyToken) request.historyToken = historyToken
				const hist = await this.client.sessions.history(request)
				if (!hist.result.ok) break
				const events = hist.result.value.events ?? []
				historyToken = hist.result.value.historyToken
				allEvents.unshift(...events)
				let minSeq
				for (const entry of events) {
					const seq = Number(entry?.seq)
					if (Number.isInteger(seq) && (minSeq === undefined || seq < minSeq)) minSeq = seq
				}
				if (!hist.result.value.hasMore || minSeq === undefined) break
				beforeSeq = minSeq
			}
			const messages = this.foldHistory(allEvents).slice(-400).map((m) => ({ role: m.role, text: String(m.text || '').slice(0, 6000), time: m.time || 0 })).filter((m) => m.text)
			let latestCompaction = null
			let sourceSeq = 0
			for (const entry of allEvents) {
				const seq = Number(entry?.event?.seq || entry?.seq || 0)
				if (seq > sourceSeq) sourceSeq = seq
				const ev = entry?.event ?? entry
				if (ev?.type === 'compaction/summary') {
					latestCompaction = { compactionId: String(ev.data?.compactionId || ''), summary: this.blocksText(ev.data?.summary), seq }
				}
			}
			this.historySearchIndex.set(summary.sessionId, { updatedAt: summary.updatedAt ?? 0, sourceSeq, latestCompaction, messages })
			changed = true
		}
		const visible = new Set(summaries.map((s) => s.sessionId))
		for (const id of this.historySearchIndex.keys()) if (!visible.has(id)) { this.historySearchIndex.delete(id); changed = true }
		if (changed) this.persistHistorySearchIndex()
	}

	literalHistorySearch(cleanQueries, summaries, preferredSessionId) {
		const terms = [...new Set(cleanQueries.flatMap((query) => [query, ...String(query).split(/[\s，。！？、,.!?：:；;]+/)])
			.map((term) => this.normalizeSearchText(term)).filter((term) => term.length >= 2))]
		const results = []
		for (const summary of summaries) {
			const indexed = this.historySearchIndex.get(summary.sessionId)
			if (!indexed) continue
			const ranked = []
			for (const message of indexed.messages ?? []) {
				const normalized = this.normalizeSearchText(message.text)
				let score = 0
				for (const term of terms) if (normalized.includes(term)) score += term === this.normalizeSearchText(cleanQueries[0]) ? 30 : Math.min(12, term.length * 2)
				if (score > 0) ranked.push({ message, score })
			}
			ranked.sort((a, b) => b.score - a.score)
			if (!ranked.length) continue
			let score = ranked[0].score + (ranked[1]?.score || 0) * 0.2
			if (preferredSessionId && summary.sessionId === preferredSessionId) score += 8
			results.push({ sessionId: summary.sessionId, snippets: ranked.slice(0, 3).map((x) => String(x.message.text).replace(/\s+/g, ' ').slice(0, 700)), queries: cleanQueries, score: Math.round(score * 10) / 10 })
		}
		return results.sort((a, b) => b.score - a.score).slice(0, 12)
	}

	async searchHistory(queries, preferredSessionId = '', excludedSessionIds = []) {
		const cleanQueries = [...new Set((Array.isArray(queries) ? queries : [queries])
			.map((q) => String(q || '').trim().slice(0, 500)).filter(Boolean))].slice(0, 8)
		if (!cleanQueries.length) throw new Error('至少需要一个搜索词')
		const listed = await this.client.sessions.list({})
		if (!listed.result.ok) throw new Error(JSON.stringify(listed.result.error))
		const excluded = new Set(excludedSessionIds)
		const summaries = (listed.result.value.items ?? []).filter((s) => !excluded.has(s.sessionId))
		const byId = new Map(summaries.map((s) => [s.sessionId, s]))
		const archived = await this.archivedIdSet()
		const merged = new Map()
		let hasMore = false
		let officialDisabled = false
		for (const query of cleanQueries) {
			const found = await this.client.sessions.search({ query })
			if (!found.result.ok) {
				const detail = JSON.stringify(found.result.error)
				if (/session search is disabled|openAt.*never/i.test(detail)) { officialDisabled = true; break }
				throw new Error(detail)
			}
			hasMore ||= Boolean(found.result.value.hasMore)
			for (const hit of found.result.value.items ?? []) {
				const current = merged.get(hit.sessionId) ?? { sessionId: hit.sessionId, snippets: [], queries: [], score: 0 }
				if (!current.snippets.includes(hit.snippet)) current.snippets.push(hit.snippet)
				if (!current.queries.includes(query)) current.queries.push(query)
				current.score += 10 + Math.min(20, hit.snippet.length / 20)
				if (preferredSessionId && hit.sessionId === preferredSessionId) current.score += 60
				merged.set(hit.sessionId, current)
			}
		}
		if (officialDisabled) {
			await this.rebuildFallbackHistoryIndex(summaries)
			for (const row of this.literalHistorySearch(cleanQueries, summaries, preferredSessionId)) merged.set(row.sessionId, row)
		}
		const matches = [...merged.values()].map((row) => {
			const summary = byId.get(row.sessionId)
			return {
				...row,
				title: this.sessionTitleOf(summary) || row.sessionId.slice(-12),
				updatedAt: summary?.updatedAt ?? 0,
				archived: archived.has(row.sessionId),
				origin: summary?.origin || 'user',
				parentSessionId: summary?.parentSessionId || ''
			}
		}).sort((a, b) => b.score - a.score || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 12)
		return { queries: cleanQueries, matches, hasMore, searchBackend: officialDisabled ? 'local-history-index' : 'harness-session-search' }
	}

	searchSessionDigests(criteria, summaries, preferredSessionId = '') {
		const wanted = ['topics', 'subjects', 'problems', 'carriers', 'outcomes', 'keywords']
		const termsByField = Object.fromEntries(wanted.map((field) => [field, (Array.isArray(criteria?.[field]) ? criteria[field] : []).map((x) => this.normalizeSearchText(x)).filter((x) => x.length >= 2)]))
		const allTerms = wanted.flatMap((field) => termsByField[field])
		const from = Number(criteria?.from || 0)
		const to = Number(criteria?.to || 0)
		const byId = new Map(summaries.map((s) => [s.sessionId, s]))
		const matches = []
		for (const digest of this.sessionDigests.values()) {
			const updatedAt = Number(digest.lastRelevantAt || digest.updatedAt || 0)
			if (from && updatedAt < from) continue
			if (to && updatedAt > to) continue
			let score = 0
			const hits = []
			for (const field of wanted) {
				const weight = field === 'subjects' ? 35 : field === 'problems' ? 30 : field === 'topics' ? 24 : field === 'carriers' ? 18 : 14
				for (const value of digest[field] ?? []) {
					const normalized = this.normalizeSearchText(value)
					for (const term of termsByField[field]) if (normalized.includes(term) || term.includes(normalized)) { score += weight; hits.push(`${field}:${value}`); break }
				}
			}
			const haystack = this.normalizeSearchText([digest.title, digest.summary].join(' '))
			for (const term of allTerms) if (haystack.includes(term)) score += 6
			if (preferredSessionId && digest.sessionId === preferredSessionId && score > 0) score += 8
			if (score > 0 && hits.length > 0) {
				const summary = byId.get(digest.sessionId)
				matches.push({ sessionId: digest.sessionId, title: digest.title || this.sessionTitleOf(summary), score, snippets: [digest.summary], tagHits: [...new Set(hits)].slice(0, 12), updatedAt })
			}
		}
		return matches.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, 12)
	}

	async pendingSessionDigests(limit = 5, excludedSessionIds = []) {
		const listed = await this.client.sessions.list({})
		if (!listed.result.ok) throw new Error(JSON.stringify(listed.result.error))
		const excluded = new Set(excludedSessionIds)
		const summaries = (listed.result.value.items ?? []).filter((s) => !s.blank && !excluded.has(s.sessionId))
		await this.rebuildFallbackHistoryIndex(summaries)
		const pending = []
		for (const summary of summaries) {
			const source = this.historySearchIndex.get(summary.sessionId)
			const digest = this.sessionDigests.get(summary.sessionId)
			if (!source || (digest && Number(digest.sourceSeq || 0) >= Number(source.sourceSeq || 0) && Number(digest.updatedAt || 0) === Number(summary.updatedAt || 0))) continue
			const turn = this.turnResults.get(summary.sessionId)
			pending.push({
				sessionId: summary.sessionId, title: this.sessionTitleOf(summary), updatedAt: summary.updatedAt || 0,
				sourceSeq: source.sourceSeq || 0, compactionId: source.latestCompaction?.compactionId || '', compactionSummary: source.latestCompaction?.summary || '',
				turnResult: turn ? { instruction: turn.instruction || '', result: turn.result || '' } : null,
				messages: (source.messages || []).slice(-80)
			})
			if (pending.length >= Math.max(1, Math.min(20, Number(limit) || 5))) break
		}
		return pending
	}

	tagCatalog() {
		const out = { topics: [], subjects: [], problems: [], carriers: [], outcomes: [], keywords: [] }
		for (const digest of this.sessionDigests.values()) for (const key of Object.keys(out)) out[key].push(...(digest[key] || []))
		for (const key of Object.keys(out)) out[key] = [...new Set(out[key])].slice(0, 500)
		return out
	}

	async sessionHistoryPage(sessionId, beforeSeq, maxMessages = 60, historyToken) {
		const request = { sessionId, maxMessages: Math.max(1, Math.min(100, Number(maxMessages) || 60)) }
		if (historyToken) request.historyToken = String(historyToken)
		if (beforeSeq !== null && beforeSeq !== undefined && beforeSeq !== '' && Number.isInteger(Number(beforeSeq)) && Number(beforeSeq) >= 0) request.beforeSeq = Number(beforeSeq)
		const hist = await this.client.sessions.history(request)
		if (!hist.result.ok) throw new Error(JSON.stringify(hist.result.error))
		const events = hist.result.value.events ?? []
		const messages = this.foldHistory(events)
		const projection = normalizeHistory(events)
		let nextBeforeSeq
		for (const entry of events) {
			const seq = Number(entry?.seq)
			if (Number.isInteger(seq) && (nextBeforeSeq === undefined || seq < nextBeforeSeq)) nextBeforeSeq = seq
		}
		return { messages, commandRecords: projection.commandRecords, projectionComplete: projection.complete, projectionDiagnosticCodes: [...new Set(projection.diagnostics.map(d => d.code))], hasMore: Boolean(hist.result.value.hasMore), nextBeforeSeq,
			historyToken: hist.result.value.historyToken, throughSeq: hist.result.value.throughSeq, consistency: hist.result.value.consistency }
	}

	saveHistoryCard(scope, card) {
		const key = String(scope || 'global')
		const rows = this.historyCards.get(key) ?? []
		rows.unshift({ ...card, id: card.id || randomBytes(8).toString('hex'), createdAt: card.createdAt || Date.now() })
		this.historyCards.set(key, rows.slice(0, 20))
		this.persistHistoryCards()
		return rows[0]
	}

	renderHistoryCards(scope) {
		const rows = this.historyCards.get(String(scope || 'global')) ?? []
		if (!rows.length) return ''
		const key = String(scope || 'global')
		return '<details class="history-cards"><summary><strong>历史搜索结果（' + rows.length + '）</strong></summary>' + rows.slice(0, 5).map((card) => {
			const sources = (card.sources ?? []).map((source) => '<a href="' + this.escHtml(this.chatPath(source.sessionId)) + '">' + this.escHtml(source.title || source.sessionId.slice(-12)) + '</a>').join('；')
			const del = '<a class="muted" style="float:right" href="/dispatch/history-card/delete?scope=' + encodeURIComponent(key) + '&cardId=' + encodeURIComponent(card.id) + '&token=' + encodeURIComponent(this.config.token) + '" onclick="return confirm(\'清除这条历史搜索结果？\')">清除</a>'
			return '<details class="history-card"><summary>' + this.escHtml(card.query || '历史查询') + '</summary>' + del + '<div class="history-summary">' + this.escHtml(card.summary || '') + '</div>' + (sources ? '<div class="muted">来源：' + sources + '</div>' : '') + '</details>'
		}).join('') + '</details>'
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
		const items = showArchived ? archivedRows : live // Preserve access to every migrated conversation; no silent 40-row truncation.
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
			'<input type="file" name="attachments" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple>',
			'<div class="thumbs"></div><p class="muted img-hint">可选图片或视频：最多20张图片、1个视频（最大200MB）</p>',
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
			advJs, this.sendAttachmentJs(), showArchived ? '' : this.voiceJs(),
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell(heading, body))
	}

	async handleChatNew(req, urlObj, res) {
		const fields = await this.readForm(req, urlObj)
		const text = (fields.text ?? '').trim()
		const images = this.formImages(fields)
		const video = this.formVideos(fields)[0]
		if (!text && !images.length && !video) return this.sendHtml(res, this.pageShell('dsh', '<main><p>内容不能为空</p></main>'), 400)
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
			content: this.promptContent(text, images, video)
		})
		if (!prompted.result.ok) return this.sendJson(res, 502, { ok: false, stage: 'prompt', sessionId, error: prompted.result.error })
		const taskLabel = text || (video ? '（视频）' : '（图片）')
		this.note('task', { sessionId, mode: 'queue', text: taskLabel.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: taskLabel.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
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
		if (urlObj.searchParams.get('restore') === '1') {
			const restored = await this.client.workspace.unarchiveSession({ sessionId })
			if (!restored.result.ok) return this.sendJson(res, 502, { ok: false, error: restored.result.error })
			this.note('unarchived', { sessionId })
			return this.redirect(res, this.chatPath(sessionId))
		}
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
		// Pagination URLs contain private dispatch and snapshot tokens, never public cache/referrer data.
		res.setHeader('Cache-Control', 'private, no-store')
		res.setHeader('Referrer-Policy', 'no-referrer')
		const latestLink = '<a rel="noreferrer" href="' + this.escHtml(this.chatPath(sessionId)) + '">返回最新记录</a>'
		const beforeParam = urlObj.searchParams.get('beforeSeq')
		const historyToken = urlObj.searchParams.get('historyToken')
		const validToken = (token) => typeof token === 'string' && token.length > 0 && token.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(token)
		const validSeq = (seq) => Number.isSafeInteger(seq) && seq >= 0
		if (urlObj.searchParams.getAll('beforeSeq').length > 1 || urlObj.searchParams.getAll('historyToken').length > 1 ||
			(beforeParam !== null && (!/^(0|[1-9]\d*)$/.test(beforeParam) || !validSeq(Number(beforeParam)) || !validToken(historyToken))) ||
			(historyToken !== null && !validToken(historyToken))) {
			return this.sendHtml(res, this.pageShell('会话', '<main><p>历史分页参数无效，请返回最新记录重新浏览。</p><p>' + latestLink + '</p></main>'), 400)
		}
		const historyBrowsing = beforeParam !== null || historyToken !== null
		const request = { sessionId, maxMessages: 40 }
		if (beforeParam !== null) request.beforeSeq = Number(beforeParam)
		if (historyToken !== null) request.historyToken = historyToken
		let hist
		try { hist = await this.client.sessions.history(request) } catch {
			return this.sendHtml(res, this.pageShell('会话', '<main><p>读历史失败，请返回最新记录重试。</p><p>' + latestLink + '</p></main>'), 502)
		}
		if (!hist.result.ok) {
			const expired = hist.result.error?.code === 'adapter/history-cut-expired'
			return this.sendHtml(res, this.pageShell('会话', '<main><p>' + (expired ? '历史快照已过期或不可用，请返回最新记录重新浏览。' : '读历史失败，请返回最新记录重试。') + '</p><p>' + latestLink + '</p></main>'), expired ? 410 : 502)
		}
		const events = hist.result.value.events ?? []
		let nextBeforeSeq
		for (const event of events) {
			if (validSeq(event?.seq) && (nextBeforeSeq === undefined || event.seq < nextBeforeSeq)) nextBeforeSeq = event.seq
		}
		const nextToken = hist.result.value.historyToken
		const canPage = hist.result.value.hasMore && validToken(nextToken) && validSeq(nextBeforeSeq) &&
			(beforeParam === null || nextBeforeSeq < Number(beforeParam))
		const earlierLink = canPage
			? '<a rel="noreferrer" href="' + this.escHtml(this.chatPath(sessionId) + '&' + new URLSearchParams({ beforeSeq: String(nextBeforeSeq), historyToken: nextToken }).toString()) + '">更早记录</a>'
			: hist.result.value.hasMore ? '<span>更早记录暂不可用，请返回最新记录重试。</span>' : '<span>已到此快照的最早聊天记录。</span>'
		const historyNav = '<nav aria-label="历史分页"><p>' + earlierLink + ' · ' + latestLink + '</p>' +
			(historyBrowsing ? '<p class="muted">正在浏览历史快照，不会自动刷新；新消息请返回最新记录查看。</p>' : '') + '</nav>'
		const projection = normalizeHistory(events)
		for (const d of projection.diagnostics) this.note('history-diagnostic', { code: d.code, seq: d.seq })
		const folded = projection.messages
		const msgs = this.renderHistoryProjection(projection, sessionId)
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
		const questionsHere = [...this.pendingQuestions.entries()].filter(([, e]) => sessionTree.has(e.sessionId)).sort((a, b) => a[1].at - b[1].at)
		const questionModal = questionsHere.length ? this.renderQuestionModal(questionsHere[0][0], questionsHere[0][1], sessionId, 1, questionsHere.length) : ''
		const running = await this.sessionRunning(sessionId)
		const last = folded[folded.length - 1]
		const awaitingReply = !last || last.role === 'user'
		const sent = Boolean(urlObj.searchParams.get('sent'))
		const waiting = !historyBrowsing && (pendingHere.length > 0 || questionsHere.length > 0 || running || (sent && awaitingReply))
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
			historyBrowsing ? 'return;' : '',
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
			? '<a href="' + this.escHtml(this.chatPath(sessionId) + '&restore=1') + '">已归档 · 恢复会话</a>'
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
			questionModal,
			'<main>', extra, banners,
			'<p class="muted" role="note">历史展示说明：此页显示已提交的聊天消息及可识别的只读历史命令/回复；跨页命令配对、领域展示、审批及未提交的排队状态可能不完整。原始记录保留，页面不代表全部交互事件。</p>',
			this.renderHistoryCards(sessionId),
			this.voicePanel({ sessionId, title: currentTitle, token: this.config.token, mode: 'session' }),
			historyNav, msgs, historyNav,
			'<form id="composer" class="js-chat" method="post" action="' + this.escHtml(this.chatPath(sessionId)) + '" enctype="multipart/form-data">',
			'<textarea name="text" rows="3" placeholder="继续说…"></textarea>',
			'<input type="file" name="attachments" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime" multiple>',
			'<div class="thumbs"></div><p class="muted img-hint">可选图片或视频：最多20张图片、1个视频（最大200MB）</p>',
			'<div class="composer-actions"><button type="submit" name="mode" value="queue">发送续聊</button><button type="submit" name="mode" value="steer" class="steer">⚡ 插队发送</button></div>',
			'<p class="muted">插队会尽快注入当前运行轮次；当前轮次已结束时自动转为普通续聊。</p></form>',
			'<details class="adv"><summary>高级 · 模型 / 权限 / 改名</summary>',
			modelForm, permForm, renameForm,
			'<p class="muted">' + archiveLink + '</p>',
			'</details>',
			draftJs, this.sendAttachmentJs(), this.voiceJs(),
			'</main>'
		].join('')
		this.sendHtml(res, this.pageShell(currentTitle, body))
	}

	async handleChatReply(rawId, req, urlObj, res) {
		const sessionId = decodeURIComponent(rawId.split('?')[0])
		const fields = await this.readForm(req, urlObj)
		const images = this.formImages(fields)
		const video = this.formVideos(fields)[0]
		const title = (fields.title ?? '').trim()
		if (title && !(fields.text ?? '').trim() && !images.length && !video) {
			const renamed = await this.client.sessions.rename({ sessionId, title })
			if (!renamed.result.ok) {
				return this.sendHtml(res, this.pageShell('改名失败', `<main><p>${this.escHtml(JSON.stringify(renamed.result.error))}</p><p><a href="${this.escHtml(this.chatPath(sessionId))}">返回会话</a></p></main>`), 502)
			}
			this.note('renamed', { sessionId, title: renamed.result.value.title ?? title })
			return this.redirect(res, this.chatPath(sessionId))
		}
		const text = (fields.text ?? '').trim()
		if (!text && !images.length && !video) return this.redirect(res, this.chatPath(sessionId))
		const requestedMode = String(fields.mode || '') === 'steer' ? 'steer' : 'queue'
		const content = this.promptContent(text, images, video)
		const requestId = randomUUID()
		let actualMode = requestedMode
		let prompted = await this.client.sessions.prompt({ requestId, sessionId, mode: actualMode, content })
		if (!prompted.result.ok && requestedMode === 'steer') {
			const code = String(prompted.result.error?.code || '')
			const reason = String(prompted.result.error?.details?.reason || '')
			if (code === 'session/agent-busy' || code === 'session/steer-unavailable' || code === 'agent-busy' || code === 'steer-unavailable') {
				actualMode = 'queue'
				prompted = await this.client.sessions.prompt({ requestId, sessionId, mode: actualMode, content })
			}
		}
		if (!prompted.result.ok) {
			return this.sendHtml(res, this.pageShell('发送失败', `<main><p>${this.escHtml(JSON.stringify(prompted.result.error))}</p></main>`), 502)
		}
		const taskLabel = text || (video ? '（视频）' : '（图片）')
		this.note('task', { sessionId, mode: actualMode, requestedMode, text: taskLabel.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: taskLabel.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
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
		let identity
		try { identity = taskIdentity(dirname(this.secretsPath()), body) } catch (error) {
			return this.sendJson(res, error.statusCode || 500, { ok: false, error: error.statusCode ? error.message : 'request identity storage failed' })
		}
		if (identity.replay) return this.sendJson(res, identity.state === 'admitted' ? 200 : 409, { ok: identity.state === 'admitted', sessionId: identity.sessionId, requestId: identity.requestId, replay: true, ...(identity.state === 'admitted' ? {} : { error: 'submission-outcome-uncertain-do-not-retry' }) })
		const createPayload = {}
		if (body.workspaceId) createPayload.workspaceId = body.workspaceId
		else if (body.cwd) createPayload.cwd = body.cwd
		if (body.agentPreset) createPayload.agentPreset = body.agentPreset
		if (identity.sessionId) createPayload.sessionId = identity.sessionId
		const created = await this.client.sessions.create(createPayload)
		if (!created.result.ok) {
			this.log('task create failed:', JSON.stringify(created.result.error))
			return this.sendJson(res, 502, { ok: false, stage: 'create', error: created.result.error })
		}
		const sessionId = created.result.value.sessionId
		const prompted = await this.client.sessions.prompt({
			sessionId,
			mode,
			requestId: identity.requestId,
			content: [{ type: 'text', text }]
		})
		if (!prompted.result.ok) {
			this.log('task prompt failed:', JSON.stringify(prompted.result.error))
			return this.sendJson(res, 502, { ok: false, stage: 'prompt', sessionId, error: prompted.result.error })
		}
		identity.markAdmitted?.()
		this.note('task', { sessionId, mode, text: text.slice(0, 120) })
		this.trackedTasks.set(sessionId, { snippet: text.slice(0, 80).replace(/\s+/g, ' '), at: Date.now() })
		this.log(`task dispatched → ${sessionId}`)
		this.sendJson(res, 200, { ok: true, sessionId })
	}
}

export default DispatchService
