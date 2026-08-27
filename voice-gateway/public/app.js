const params = new URLSearchParams(location.search)
const token = params.get('token') || ''
const targetSessionId = params.get('sessionId') || ''
const assistantMode = params.get('mode') === 'global' ? 'global' : 'session'
const targetTitle = params.get('title') || ''
const autoStart = params.get('autostart') === '1'
const stateEl = document.getElementById('state')
const previewEl = document.getElementById('preview')
const callBtn = document.getElementById('call')
const hangBtn = document.getElementById('hang')
const healthEl = document.getElementById('health')
const dbgEl = document.getElementById('dbg')
const meterBar = document.getElementById('meterBar')
const bindingEl = document.getElementById('binding')
if (bindingEl) {
	bindingEl.textContent = assistantMode === 'global'
		? '手机总助手 · 可查看全部对话并跨会话读取结果'
		: ('当前对话：' + (targetTitle || targetSessionId.slice(-8)) + ' · 默认读取本对话，也可点名其他对话')
}

let ws
let media
let proc
let ctxIn
let ctxOut
let playTime = 0
let sessionReady = false
let hung = false
let sentFrames = 0
let recvFrames = 0
let remoteSpeaking = false
let bargeFrames = 0
let lastCancelAt = 0
let thinkingTimer = null
let connectTimer = null
let readyTimer = null
let connectAttempt = 0
let pendingPlaybackSegment = null
let playbackEpoch = 0
let playbackDrainTimer = null
const playingSources = new Set()

function setState(s, extra) {
	stateEl.textContent = s
	if (extra) previewEl.textContent = extra
}

function clearConnectTimers() {
	if (connectTimer) clearTimeout(connectTimer)
	if (readyTimer) clearTimeout(readyTimer)
	connectTimer = null
	readyTimer = null
}

function reportClient(stage, detail) {
	try {
		if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'client_log', stage, detail: String(detail || '') }))
	} catch { /* ignore */ }
}

function micErrorText(err) {
	const name = String(err?.name || '')
	if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '麦克风权限被拒绝。请在 Chrome 地址栏的网站设置中允许麦克风。'
	if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '手机没有找到可用麦克风。'
	if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风正被其他应用占用。请关闭微信通话、录音或其他语音页面后重试。'
	if (name === 'SecurityError') return '当前页面不是安全连接，浏览器不允许使用麦克风。'
	return '麦克风启动失败：' + String(err?.message || err || '未知错误')
}

async function loadHealth() {
	try {
		const h = await fetch('/health').then((r) => r.json())
		const bits = []
		bits.push(h.dsh ? 'DSH 在线' : 'DSH 不在')
		bits.push(h.volcConfigured ? '火山 Key 已配' : '还没有火山 Key')
		if (h.foremanSessionId) bits.push('工头 ' + h.foremanSessionId.slice(-8))
		healthEl.textContent = bits.join(' · ')
	} catch {
		healthEl.textContent = '网关 health 失败'
	}
}

function downsampleTo16k(float32, fromRate) {
	if (fromRate === 16000) return float32
	const ratio = fromRate / 16000
	const outLen = Math.floor(float32.length / ratio)
	const out = new Float32Array(outLen)
	for (let i = 0; i < outLen; i++) out[i] = float32[Math.floor(i * ratio)] || 0
	return out
}

function floatTo16(f32) {
	const buf = new ArrayBuffer(f32.length * 2)
	const view = new DataView(buf)
	for (let i = 0; i < f32.length; i++) {
		const s = Math.max(-1, Math.min(1, f32[i]))
		view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
	}
	return buf
}

async function ensureOut() {
	if (!ctxOut) ctxOut = new AudioContext()
	if (ctxOut.state === 'suspended') await ctxOut.resume()
	return ctxOut
}

function playPcm24k(raw) {
	if (hung || !ctxOut) return
	if (ctxOut.state === 'suspended') ctxOut.resume()
	const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
	const even = bytes.byteLength - (bytes.byteLength % 4)
	if (even < 4) return
	const copy = bytes.slice(0, even)
	const samples = new Float32Array(copy.buffer, copy.byteOffset, even / 4)
	const srcRate = 24000
	const dstRate = ctxOut.sampleRate || 24000
	let f32
	if (Math.abs(dstRate - srcRate) < 1) {
		f32 = samples
	} else {
		const ratio = srcRate / dstRate
		const outLen = Math.max(1, Math.floor(samples.length / ratio))
		f32 = new Float32Array(outLen)
		for (let i = 0; i < outLen; i++) {
			const srcIndex = Math.min(samples.length - 1, Math.floor(i * ratio))
			f32[i] = samples[srcIndex]
		}
	}
	const node = ctxOut.createBuffer(1, f32.length, dstRate)
	node.copyToChannel(f32, 0)
	const src = ctxOut.createBufferSource()
	src.buffer = node
	src.connect(ctxOut.destination)
	playingSources.add(src)
	src.onended = () => playingSources.delete(src)
	const now = ctxOut.currentTime
	if (!Number.isFinite(playTime) || playTime < now) playTime = now + 0.03
	const scheduledAt = playTime
	if (pendingPlaybackSegment && !pendingPlaybackSegment.scheduled) {
		pendingPlaybackSegment.scheduled = true
		const segment = pendingPlaybackSegment
		const epoch = playbackEpoch
		const waitMs = Math.max(0, (scheduledAt - now) * 1000)
		setTimeout(() => {
			if (hung || segment.canceled || epoch !== playbackEpoch) return
			stateEl.textContent = '在说'
			previewEl.textContent = '它：' + segment.text
			reportClient('playback_segment_started', segment.id)
		}, waitMs)
	}
	// 严格串行排队：绝不为了追实时把 playTime 拉回当前时间，否则会和已排队语音重叠。
	src.start(scheduledAt)
	playTime += node.duration
	if (playbackDrainTimer) clearTimeout(playbackDrainTimer)
	playbackDrainTimer = setTimeout(() => {
		if (hung) return
		remoteSpeaking = false
		reportClient('playback_drained', Math.round(playTime * 1000))
	}, Math.max(0, (playTime - ctxOut.currentTime) * 1000 + 80))
	recvFrames += 1
	if (dbgEl) dbgEl.textContent = '上行 ' + sentFrames + ' 帧 · 下行 ' + recvFrames + ' 块'
}

function cancelPlayback() {
	playbackEpoch += 1
	if (pendingPlaybackSegment) pendingPlaybackSegment.canceled = true
	pendingPlaybackSegment = null
	if (playbackDrainTimer) clearTimeout(playbackDrainTimer)
	playbackDrainTimer = null
	for (const src of playingSources) {
		try { src.stop() } catch { /* ignore */ }
	}
	playingSources.clear()
	playTime = ctxOut?.currentTime || 0
}

async function startMic() {
	media = await navigator.mediaDevices.getUserMedia({
		audio: {
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: false,
			channelCount: 1
		}
	})
	ctxIn = new AudioContext()
	const src = ctxIn.createMediaStreamSource(media)
	const bufferSize = 4096
	proc = ctxIn.createScriptProcessor(bufferSize, 1, 1)
	let pcm16kPending = new Float32Array(0)
	proc.onaudioprocess = (ev) => {
		const input = ev.inputBuffer.getChannelData(0)
		let peak = 0
		for (let i = 0; i < input.length; i++) {
			const a = Math.abs(input[i])
			if (a > peak) peak = a
		}
		if (meterBar) meterBar.style.width = Math.min(100, peak * 220) + '%'
		if (!ws || ws.readyState !== 1 || !sessionReady) return
		// 不再根据手机本地音量峰值直接打断。扬声器回声和环境碰撞声会误触发。
		// 麦克风保持全双工上传，由服务端在识别到明确且非回声的文字后决定是否打断。
		const down = downsampleTo16k(input, ctxIn.sampleRate)
		const merged16k = new Float32Array(pcm16kPending.length + down.length)
		merged16k.set(pcm16kPending)
		merged16k.set(down, pcm16kPending.length)
		const frameSamples = 320
		let off = 0
		while (off + frameSamples <= merged16k.length) {
			ws.send(floatTo16(merged16k.subarray(off, off + frameSamples)))
			sentFrames += 1
			off += frameSamples
		}
		if (dbgEl && sentFrames % 20 === 0) dbgEl.textContent = '上行 ' + sentFrames + ' 帧 · 下行 ' + recvFrames + ' 块'
		pcm16kPending = merged16k.slice(off)
	}
	src.connect(proc)
	const silent = ctxIn.createGain()
	silent.gain.value = 0
	proc.connect(silent)
	silent.connect(ctxIn.destination)
}

function stopMic() {
	cancelPlayback()
	remoteSpeaking = false
	bargeFrames = 0
	try { proc?.disconnect() } catch { /* ignore */ }
	try { ctxIn?.close() } catch { /* ignore */ }
	media?.getTracks().forEach((t) => t.stop())
	proc = null
	ctxIn = null
	media = null
}

async function connect({ retry = false } = {}) {
	if (!token) {
		setState('缺少 token', '请从手机会话页重新打开语音助手。')
		return
	}
	if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
	clearConnectTimers()
	callBtn.disabled = true
	hung = false
	sentFrames = 0
	recvFrames = 0
	connectAttempt += 1
	setState(retry ? '正在自动重试…' : '正在连接语音网关…', '连接阶段 1/3')
	try {
		await ensureOut()
	} catch (err) {
		callBtn.disabled = false
		setState('音频初始化失败', String(err?.message || err))
		return
	}
	const proto = location.protocol === 'https:' ? 'wss' : 'ws'
	const qs = new URLSearchParams({ token, mode: assistantMode })
	if (targetSessionId) qs.set('sessionId', targetSessionId)
	if (targetTitle) qs.set('title', targetTitle)
	ws = new WebSocket(`${proto}://${location.host}/call?${qs.toString()}`)
	connectTimer = setTimeout(() => {
		if (ws?.readyState !== 1) {
			setState('语音网关连接超时', '请确认手机 Tailscale 在线，然后点接通重试。')
			try { ws?.close() } catch { /* ignore */ }
			callBtn.disabled = false
		}
	}, 8000)
	ws.binaryType = 'arraybuffer'
	ws.onmessage = (ev) => {
		if (typeof ev.data !== 'string') {
			playPcm24k(new Uint8Array(ev.data))
			return
		}
		let msg
		try { msg = JSON.parse(ev.data) } catch { return }
		if (msg.type === 'status') {
			if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null }
			if (msg.state === 'listening' || msg.state === 'speaking') {
				sessionReady = true
				clearConnectTimers()
				connectAttempt = 0
			}
			if (msg.state === 'connected') sessionReady = false
			remoteSpeaking = msg.state === 'speaking'
			if (msg.state === 'listening' || msg.state === 'ended') bargeFrames = 0
			const map = {
				connected: '已连火山，请等它说完',
				listening: '在听，可以说话',
				waiting_foreman: '电脑在干活',
				thinking: '它在想',
				speaking: '在说',
				ended: '已结束'
			}
			setState(map[msg.state] || msg.state, msg.preview)
			if (msg.state === 'thinking') {
				thinkingTimer = setTimeout(() => {
					stateEl.textContent = '仍在读取'
					previewEl.textContent = '读取时间较长，但麦克风仍可继续使用。'
					thinkingTimer = setTimeout(() => {
						stateEl.textContent = '在听，可以继续说'
						previewEl.textContent = '这次读取超时了。请缩小范围，或直接说具体对话名称。'
						thinkingTimer = null
					}, 6000)
				}, 6000)
			}
		} else if (msg.type === 'user_text') {
			previewEl.textContent = '你：' + msg.text
		} else if (msg.type === 'user_partial') {
			previewEl.textContent = '听到… ' + msg.text
		} else if (msg.type === 'playback_segment') {
			pendingPlaybackSegment = { id: String(msg.id || ''), text: String(msg.text || ''), scheduled: false, canceled: false }
			remoteSpeaking = true
		} else if (msg.type === 'assistant_text') {
			// 非队列语音兼容；队列阅读文字由 playback_segment 在真实播放时显示。
			if (!msg.queued) {
				stateEl.textContent = '在说'
				previewEl.textContent = '它：' + msg.text
			}
		} else if (msg.type === 'cancel_playback') {
			cancelPlayback()
			remoteSpeaking = false
		} else if (msg.type === 'error') {
			if (msg.code === 'audio_tts_timeout') stateEl.textContent = '语音合成超时'
			previewEl.textContent = msg.message
		}
	}
	ws.onopen = async () => {
		if (connectTimer) clearTimeout(connectTimer)
		connectTimer = null
		hangBtn.disabled = false
		playTime = 0
		recvFrames = 0
		sessionReady = false
		setState('网关已连接，正在连接火山…', '连接阶段 2/3')
		reportClient('ws_open', location.host)
		readyTimer = setTimeout(() => {
			if (!sessionReady) {
				setState('火山会话建立超时', '网关已连接，但火山语音没有就绪。请挂断后重试。')
				reportClient('volc_ready_timeout', '10s')
				callBtn.disabled = false
			}
		}, 10000)
		try {
			setState('正在启用麦克风…', '连接阶段 3/3')
			await startMic()
			reportClient('mic_ready', ctxIn?.sampleRate || '')
		} catch (err) {
			const detail = micErrorText(err)
			setState('麦克风不可用', detail)
			reportClient('mic_error', `${err?.name || ''}: ${err?.message || err}`)
			callBtn.disabled = false
		}
	}
	ws.onclose = (ev) => {
		clearConnectTimers()
		const shouldRetry = !hung && !sessionReady && connectAttempt < 2
		sessionReady = false
		stopMic()
		try { ctxOut?.close() } catch { /* ignore */ }
		ctxOut = null
		playTime = 0
		callBtn.disabled = false
		hangBtn.disabled = true
		if (shouldRetry) {
			setState('首次连接失败，正在重试…', `连接关闭：${ev.code || 0}`)
			setTimeout(() => void connect({ retry: true }), 600)
		} else {
			setState('未接通', ev.code && ev.code !== 1000 ? `连接关闭：${ev.code}` : '')
		}
	}
	ws.onerror = () => {
		setState('语音连接出错', '正在等待自动重试。')
		reportClient('ws_error', location.host)
	}
}

function hangup() {
	hung = true
	clearConnectTimers()
	connectAttempt = 0
	sessionReady = false
	try { ws?.send(JSON.stringify({ type: 'hangup' })) } catch { /* ignore */ }
	try { ws?.close() } catch { /* ignore */ }
	stopMic()
	try { ctxOut?.close() } catch { /* ignore */ }
	ctxOut = null
	playTime = 0
}

callBtn.addEventListener('click', () => void connect())
hangBtn.addEventListener('click', hangup)
loadHealth()
if (!token) setState('缺少 token', '打开 /?token=派单token')
else if (autoStart) {
	callBtn.textContent = '正在自动接通…'
	void connect().catch((err) => {
		callBtn.disabled = false
		callBtn.textContent = '重新接通'
		setState('自动接通失败', String(err?.message ?? err))
	})
}
