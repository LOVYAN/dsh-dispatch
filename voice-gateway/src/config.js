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
	const historyResearcherPath = join(home, 'dsh-history-researcher.json')
	const sessionDigestWriterPath = join(home, 'dsh-session-digest-writer.json')
	const sessionTagSelectorPath = join(home, 'dsh-session-tag-selector.json')
	const historyEvidenceSummarizerPath = join(home, 'dsh-history-evidence-summarizer.json')

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
	const historyResearcher = readJson(historyResearcherPath) || {}
	const sessionDigestWriter = readJson(sessionDigestWriterPath) || {}
	const sessionTagSelector = readJson(sessionTagSelectorPath) || {}
	const historyEvidenceSummarizer = readJson(historyEvidenceSummarizerPath) || {}

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
		historyResearcherPath,
		sessionDigestWriterPath,
		sessionTagSelectorPath,
		historyEvidenceSummarizerPath,
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
		historyResearcherSessionId: String(historyResearcher.sessionId || '').trim(),
		sessionDigestWriterSessionId: String(sessionDigestWriter.sessionId || '').trim(),
		sessionTagSelectorSessionId: String(sessionTagSelector.sessionId || '').trim(),
		historyEvidenceSummarizerSessionId: String(historyEvidenceSummarizer.sessionId || '').trim(),
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

export function saveHistoryResearcherSessionId(cfg, sessionId) {
	mkdirSync(dirname(cfg.historyResearcherPath), { recursive: true })
	writeFileSync(cfg.historyResearcherPath, JSON.stringify({ sessionId }, null, 2) + '\n', {
		encoding: 'utf8', mode: 0o600
	})
	cfg.historyResearcherSessionId = sessionId
}

export function saveSessionDigestWriterSessionId(cfg, sessionId) {
	mkdirSync(dirname(cfg.sessionDigestWriterPath), { recursive: true })
	writeFileSync(cfg.sessionDigestWriterPath, JSON.stringify({ sessionId }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
	cfg.sessionDigestWriterSessionId = sessionId
}

export function saveSessionTagSelectorSessionId(cfg, sessionId) {
	mkdirSync(dirname(cfg.sessionTagSelectorPath), { recursive: true })
	writeFileSync(cfg.sessionTagSelectorPath, JSON.stringify({ sessionId }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
	cfg.sessionTagSelectorSessionId = sessionId
}

export function saveHistoryEvidenceSummarizerSessionId(cfg, sessionId) {
	mkdirSync(dirname(cfg.historyEvidenceSummarizerPath), { recursive: true })
	writeFileSync(cfg.historyEvidenceSummarizerPath, JSON.stringify({ sessionId }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
	cfg.historyEvidenceSummarizerSessionId = sessionId
}
