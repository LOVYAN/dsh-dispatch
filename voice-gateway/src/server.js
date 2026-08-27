import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { loadConfig, volcReady, saveForemanSessionId } from './config.js'
import { dispatchHealth } from './foreman.js'
import { attachCall } from './call.js'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const publicDir = join(root, 'public')

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon'
}

function tokenOk(cfg, candidate) {
	if (typeof candidate !== 'string' || !candidate) return false
	const a = createHash('sha256').update(candidate).digest()
	const b = createHash('sha256').update(cfg.dispatchToken).digest()
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

function tokenFrom(req, url) {
	const q = url.searchParams.get('token')
	if (q) return q
	const auth = req.headers.authorization ?? ''
	return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

function send(res, status, body, headers = {}) {
	const buf = Buffer.from(body)
	res.writeHead(status, { 'Content-Length': buf.length, ...headers })
	res.end(buf)
}

function sendJson(res, status, obj) {
	send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' })
}

function serveStatic(res, urlPath) {
	let rel = urlPath === '/' ? '/index.html' : urlPath
	if (rel.includes('..')) return send(res, 400, 'bad path')
	const file = join(publicDir, rel.replace(/^\//, ''))
	if (!existsSync(file)) return false
	const type = MIME[extname(file)] || 'application/octet-stream'
	send(res, 200, readFileSync(file), { 'Content-Type': type, 'Cache-Control': 'no-store' })
	return true
}

const cfg = loadConfig()
const log = (...a) => console.log('[dsh-voice]', ...a)

const server = createServer(async (req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
	if (url.pathname === '/health' && req.method === 'GET') {
		const dsh = await dispatchHealth(cfg)
		return sendJson(res, 200, {
			ok: true,
			dsh: Boolean(dsh.ok),
			dshDetail: dsh,
			volcConfigured: volcReady(cfg),
			voiceConfigured: Boolean(cfg.volc.voice),
			foremanSessionId: cfg.foremanSessionId || null,
			port: cfg.port
		})
	}
	if (url.pathname === '/reset-foreman' && req.method === 'POST') {
		if (!tokenOk(cfg, tokenFrom(req, url))) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
		saveForemanSessionId(cfg, '')
		return sendJson(res, 200, { ok: true, foremanSessionId: null })
	}
	if (serveStatic(res, url.pathname)) return
	sendJson(res, 404, { ok: false, error: 'not-found' })
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
	if (url.pathname !== '/call' || !tokenOk(cfg, tokenFrom(req, url))) {
		socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
		socket.destroy()
		return
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		const sessionId = String(url.searchParams.get('sessionId') || '').trim()
		const targetTitle = String(url.searchParams.get('title') || '').trim()
		const mode = url.searchParams.get('mode') === 'global' ? 'global' : 'session'
		log('phone connected', mode === 'global' ? 'global mobile assistant' : `session=${sessionId || 'missing'} title=${targetTitle || 'unknown'}`)
		attachCall(cfg, ws, log, { targetSessionId: sessionId, targetTitle, assistantMode: mode })
	})
})

server.listen(cfg.port, cfg.host, () => {
	log(`listening http://${cfg.host}:${cfg.port}`)
	log(`voice json ${cfg.voicePath}`)
	log(`volc ${volcReady(cfg) ? 'configured' : 'MISSING apiKey — 通话不可用，工头通道仍可测'}`)
	log(`open http://127.0.0.1:${cfg.port}/?token=<dispatch-token>`)
})
