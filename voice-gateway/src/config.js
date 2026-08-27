import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_WS = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
const DEFAULT_MODEL = '1.2.6.1'

export function dshHome() {
	return process.env.DSH_HOME || join(homedir(), '.dsh-home')
}

function readJson(path) {
	if (!existsSync(path)) return null
	try {
		return JSON.parse(readFileSync(path, 'utf8') || '{}')
	} catch (err) {
		throw new Error(`无法解析 ${path}: ${err?.message ?? err}`)
	}
}

export function loadConfig() {
	const home = dshHome()
	const voicePath = join(home, 'dsh-voice.json')
	const dispatchPath = join(home, 'dsh-dispatch.json')
	const foremanPath = join(home, 'dsh-voice-foreman.json')

	if (!existsSync(voicePath)) {
		mkdirSync(home, { recursive: true })
		const stub = {
			appId: '',
			accessToken: '',
			apiKey: '',
			resourceId: '',
			cluster: '',
			wsUrl: DEFAULT_WS,
			model: DEFAULT_MODEL,
			voice: '',
			dispatchBase: 'http://127.0.0.1:3080',
			gatewayPort: 3091,
			gatewayHost: '127.0.0.1',
			priceNote: '打开 https://www.volcengine.com/docs/6561/1359370 后把实时语音单价贴在这里'
		}
		writeFileSync(voicePath, JSON.stringify(stub, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
	}

	const voice = readJson(voicePath) || {}
	const dispatch = readJson(dispatchPath) || {}
	const foreman = readJson(foremanPath) || {}

	const apiKey = String(voice.apiKey || voice.accessToken || '').trim()
	const token = String(dispatch.token || '').trim()
	if (!token) {
		throw new Error(`缺少派单 token：请确认 ${dispatchPath} 存在且含 token`)
	}

	return {
		home,
		voicePath,
		dispatchPath,
		foremanPath,
		dispatchBase: String(voice.dispatchBase || 'http://127.0.0.1:3080').replace(/\/$/, ''),
		dispatchToken: token,
		port: Number(voice.gatewayPort || 3091),
		host: String(voice.gatewayHost || '127.0.0.1'),
		volc: {
			appId: String(voice.appId || '').trim(),
			apiKey,
			resourceId: String(voice.resourceId || '').trim(),
			cluster: String(voice.cluster || '').trim(),
			wsUrl: String(voice.wsUrl || DEFAULT_WS).trim() || DEFAULT_WS,
			model: String(voice.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
			voice: String(voice.voice || '').trim()
		},
		foremanSessionId: String(foreman.sessionId || '').trim(),
		priceNote: String(voice.priceNote || '')
	}
}

export function volcReady(cfg) {
	return Boolean(cfg.volc.apiKey)
}

export function saveForemanSessionId(cfg, sessionId) {
	mkdirSync(dirname(cfg.foremanPath), { recursive: true })
	writeFileSync(cfg.foremanPath, JSON.stringify({ sessionId }, null, 2) + '\n', {
		encoding: 'utf8',
		mode: 0o600
	})
	cfg.foremanSessionId = sessionId
}
