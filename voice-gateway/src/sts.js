import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

export const STS_INSTRUCTIONS = `你是用户的实时语音助手，负责在通话中与用户自然对谈；真正执行任务的是 DeepSeek Harness。

必须遵守：
1. 每次都针对用户刚说的具体内容作答。禁止只说「我在听」「你慢慢说」「好的」「嗯嗯」等无信息套话。
2. 如果只听到残句或信息不完整，要复述已听到的关键词并问一个具体问题，例如「你刚提到星期六，是要安排星期六的任务吗？」不能泛泛地说继续讲。
3. 用户描述任务时，持续记住本轮对话内容，逐步整理目标、约束和步骤。合适时用两三句复述当前完整计划，请用户修改或确认。
4. 你只负责对谈、整理和确认。无论用户是否说了确认词，都禁止你声称“正在交给电脑”“已经派单”“已经开始执行”。
5. 派单确认词由外部网关拦截；只有网关真正启动 DeepSeek Harness 后，网关才会播报“已经交给电脑”。你不要对确认词生成派单状态答复。
6. 电脑返回后，外部网关只会提示任务完成。用户说「读结果」时由外部网关读取真实结果；你不要自行编造执行结果或进度。
7. “当前对话、这个对话、本对话、当前会话”永远指手机详情页绑定的 DeepSeek Harness 会话，不是本次语音通话。用户要求总结、识别、读取、复述或汇报其执行结果时，你禁止根据语音通话历史回答；外部网关会按页面 sessionId 读取结构化完成小结。
8. 不念代码、URL、Markdown。每轮回答简洁但必须有实际信息。
9. 禁止笑声、拟声词、拖长音，禁止用笑来回应听不清。听到明显残句时，只复述已听到的关键词并提出一个具体澄清问题。
10. 禁止声称“没有权限”“无法访问当前对话”“读取不到 Harness 会话”。页面绑定和结果读取由外部网关负责；如果你听到的命令不完整，只能澄清用户想读当前、全部还是某个具名对话。`

function eventId() {
	return randomUUID()
}

export function connectVolc(cfg, { onJson, onClose, onError }) {
	if (!cfg.volc.apiKey) throw new Error('缺少火山 API Key（.dsh-home/dsh-voice.json 的 apiKey 或 accessToken）')
	const headers = { 'X-Api-Key': cfg.volc.apiKey }
	if (cfg.volc.appId) headers['X-Api-App-Key'] = cfg.volc.appId
	if (cfg.volc.resourceId) headers['X-Api-Resource-Id'] = cfg.volc.resourceId
	const ws = new WebSocket(cfg.volc.wsUrl, { headers })
	ws.on('message', (data, isBinary) => {
		if (isBinary) return
		const text = data.toString('utf8')
		try { onJson(JSON.parse(text)) } catch { onJson({ type: 'raw', text }) }
	})
	ws.on('close', (code, reason) => onClose?.(code, String(reason)))
	ws.on('error', (err) => onError?.(err))
	return ws
}

export function sessionCreatePayload(cfg) {
	const session = {
		model: cfg.volc.model,
		instructions: STS_INSTRUCTIONS,
		audio: {
			input: { format: { type: 'pcm', rate: 16000 } },
			output: { format: { type: 'pcm', rate: 24000 }, voice: cfg.volc.voice || 'zh_female_vv_uranus_bigtts' }
		}
	}
	return { type: 'session.create', event_id: eventId(), session }
}

export function sendJson(ws, obj) {
	if (ws.readyState !== WebSocket.OPEN) return false
	ws.send(JSON.stringify(obj))
	return true
}

export function appendPcm16k(ws, pcmBuf) {
	return sendJson(ws, {
		type: 'input_audio_buffer.append',
		event_id: eventId(),
		audio: Buffer.from(pcmBuf).toString('base64')
	})
}

export function mute(ws) {
	return sendJson(ws, { type: 'input_audio_mute.commit', event_id: eventId() })
}

export function unmute(ws) {
	return sendJson(ws, { type: 'input_audio_unmute.commit', event_id: eventId() })
}

export function commitAudio(ws) {
	return sendJson(ws, { type: 'input_audio_buffer.commit', event_id: eventId() })
}

export function greet(ws, text) {
	return sendJson(ws, { type: 'speech_text_buffer.commit', event_id: eventId(), text })
}

export function speakExact(ws, text) {
	const id = eventId()
	sendJson(ws, { type: 'speech_text_buffer.replacement.append', event_id: id, text })
	return sendJson(ws, { type: 'speech_text_buffer.replacement.commit', event_id: eventId() })
}

export function cancelResponse(ws) {
	return sendJson(ws, { type: 'response.cancel', event_id: eventId() })
}

export function closeSession(ws) {
	return sendJson(ws, { type: 'session.close', event_id: eventId() })
}

export function toolResult(ws, callId, text) {
	return sendJson(ws, {
		type: 'conversation.item.create',
		event_id: eventId(),
		items: [
			{
				call_id: callId,
				role: 'tool',
				content: [{ type: 'input_text', text }]
			}
		]
	})
}

export function parseToolArgs(raw) {
	if (raw && typeof raw === 'object') return raw
	try { return JSON.parse(String(raw || '{}')) } catch { return { instruction: String(raw || '') } }
}
