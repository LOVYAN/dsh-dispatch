import { WebSocket } from 'ws'
import { looksLikeConfirmDispatch, looksLikeWork, summarizeForSpeech } from './summarize.js'
import { normalizeHarnessSpeech } from './semantic.js'
import { dispatchIndependentTask, handleBoundSessionUtterance, handleUserUtterance, inspectBoundSession, listDispatchSessions, matchDispatchSessions, summarizeActiveSessions } from './foreman.js'
import {
	connectVolc,
	sessionCreatePayload,
	sendJson,
	appendPcm16k,
	mute,
	unmute,
	greet,
	speakExact,
	cancelResponse,
	closeSession,
	toolResult
} from './sts.js'

function sendPhone(phoneWs, obj) {
	if (phoneWs.readyState === WebSocket.OPEN) phoneWs.send(JSON.stringify(obj))
}

function sendPhoneBin(phoneWs, buf) {
	if (phoneWs.readyState === WebSocket.OPEN) phoneWs.send(buf)
}

function isJsonText(buf) {
	if (!buf.length) return false
	const c = buf[0]
	return c === 0x7b || c === 0x5b
}

function transcriptOf(ev) {
	const c = ev?.item?.content
	const fromContent = Array.isArray(c)
		? c.map((x) => x?.transcript || x?.text || '').join('')
		: ''
	return String(
		ev?.transcript
		|| ev?.text
		|| ev?.delta
		|| ev?.item?.transcript
		|| fromContent
		|| ''
	).trim()
}

function pcmRms(buf) {
	const n = Math.floor(buf.length / 2)
	if (n <= 0) return 0
	let sum = 0
	for (let i = 0; i < n; i++) {
		const v = buf.readInt16LE(i * 2)
		sum += v * v
	}
	return Math.sqrt(sum / n)
}

export function attachCall(cfg, phoneWs, log, { targetSessionId = '', targetTitle = '', assistantMode = 'session' } = {}) {
	let volcWs = null
	let closed = false
	let busy = false
	let sessionReady = false
	let botSpeaking = false
	let greetDone = false
	let turnAbort = null
	let upFrames = 0
	let assistantText = ''
	let lastSpokenText = '在，你说。'
	let taskUtterances = []
	let taskCaptureStarted = false
	let correctionPending = false
	let lastDispatchedInstruction = ''
	let lastCompletedSpeech = ''
	let lastCompletedRaw = ''
	let pendingExactSpeech = ''
	let exactSpeechChunks = []
	let pendingExactTimer = null
	let cancelPhoneOnNextFlush = false
	let exactResponseActive = false
	let exactAudioStarted = false
	let exactAudioBytes = 0
	let exactCurrentText = ''
	let exactRetryCount = 0
	let phonePlaybackActive = false
	let playbackSegmentSeq = 0
	let currentPhonePlaybackText = ''
	const playbackSegmentTexts = new Map()
	let reportState = null
	let readingState = null
	const handledTranscriptItems = new Set()
	const pendingFc = new Map()
	const USER_EVENT = new Set([
		'conversation.item.input_audio_transcription.delta',
		'conversation.item.input_audio_transcription.completed',
		'conversation.item.input_audio_transcription.failed',
		'response.output_text.delta',
		'response.output_text.done',
		'session.created',
		'error'
	])

	const end = (why) => {
		if (closed) return
		closed = true
		try { turnAbort?.abort() } catch { /* ignore */ }
		try { if (volcWs) closeSession(volcWs) } catch { /* ignore */ }
		try { volcWs?.close() } catch { /* ignore */ }
		try { phoneWs.close() } catch { /* ignore */ }
		log('call ended', why || '')
	}

	const splitSpeech = (text, max = 280) => {
		const raw = String(text || '').trim()
		if (!raw) return []
		const sentences = raw.split(/(?<=[。！？!?])/)
		const chunks = []
		let current = ''
		for (const sentence of sentences) {
			if (current && (current + sentence).length > max) { chunks.push(current); current = sentence }
			else current += sentence
		}
		if (current) chunks.push(current)
		return chunks.flatMap((chunk) => chunk.length <= max ? [chunk] : Array.from({ length: Math.ceil(chunk.length / max) }, (_, i) => chunk.slice(i * max, (i + 1) * max)))
	}

	const flushExactSpeech = () => {
		if (!pendingExactSpeech || closed || !volcWs) return
		const text = pendingExactSpeech
		pendingExactSpeech = ''
		if (pendingExactTimer) clearTimeout(pendingExactTimer)
		pendingExactTimer = null
		assistantText = ''
		if (cancelPhoneOnNextFlush) {
			sendPhone(phoneWs, { type: 'cancel_playback' })
			cancelPhoneOnNextFlush = false
		}
		// 段间只追加音频，不能清空手机播放队列；火山生成速度远快于手机实时播放。
		lastSpokenText = text
		const segmentId = String(++playbackSegmentSeq)
		playbackSegmentTexts.set(segmentId, text)
		if (playbackSegmentTexts.size > 40) playbackSegmentTexts.delete(playbackSegmentTexts.keys().next().value)
		sendPhone(phoneWs, { type: 'playback_segment', id: segmentId, text })
		sendPhone(phoneWs, { type: 'assistant_text', text, queued: true })
		exactResponseActive = true
		exactAudioStarted = false
		exactAudioBytes = 0
		exactCurrentText = text
		// 独立正文使用普通 speech_text_buffer.commit。replacement 只适合替换活动回答，
		// 在上一轮 response.done 后连续调用会被火山静默忽略。
		greet(volcWs, text)
		// 文字由手机在该段真实开始播放时更新，不能按火山生成进度提前切换。
		sendPhone(phoneWs, { type: 'status', state: 'speaking' })
	}

	const queueExactSpeech = (text) => {
		exactSpeechChunks = splitSpeech(text)
		pendingExactSpeech = exactSpeechChunks.shift() || ''
		if (!pendingExactSpeech) return
		if (pendingExactTimer) clearTimeout(pendingExactTimer)
		cancelResponse(volcWs)
		pendingExactTimer = setTimeout(flushExactSpeech, 900)
	}

	const compactReportSummary = (text, max = 180) => {
		const value = summarizeForSpeech(text)
		if (value.length <= max) return value
		const cut = value.slice(0, max)
		const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'))
		return (at >= 60 ? cut.slice(0, at + 1) : cut + '…')
	}

	const speakNextReportItem = () => {
		if (!reportState || reportState.paused || exactResponseActive || pendingExactSpeech) return
		if (reportState.cursor >= reportState.items.length) {
			reportState.completed = true
			log('report generation completed', reportState.items.length, 'items; phone queue will drain in order')
			sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: `全部${reportState.items.length}个对话已生成，正在按顺序播放完毕。` + (reportState.tailNotice || '') })
			return
		}
		const index = reportState.cursor
		const item = reportState.items[index]
		reportState.activeIndex = index
		log('report item', index + 1, '/', reportState.items.length, item.title)
		pendingExactSpeech = `第${index + 1}个，共${reportState.items.length}个。${item.speech}`
		flushExactSpeech()
	}

	const speakNextReadingChunk = () => {
		if (!readingState || readingState.paused || readingState.completed || exactResponseActive || pendingExactSpeech) return
		if (readingState.cursor >= readingState.chunks.length) {
			readingState.completed = true
			log('reading generation completed', readingState.chunks.length, 'chunks; phone queue will drain in order')
			sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: '正文已全部生成，正在按顺序播放完毕' })
			return
		}
		readingState.activeIndex = readingState.cursor
		pendingExactSpeech = readingState.chunks[readingState.cursor]
		log('reading chunk', readingState.cursor + 1, '/', readingState.chunks.length)
		flushExactSpeech()
	}

	const startResultReading = (text) => {
		const chunks = splitSpeech(text, 90)
		if (pendingExactTimer) clearTimeout(pendingExactTimer)
		readingState = { chunks, cursor: 0, paused: false, completed: false }
		reportState = null
		cancelPhoneOnNextFlush = true
		exactSpeechChunks = []
		pendingExactSpeech = ''
		exactRetryCount = 0
		exactResponseActive = false
		exactAudioStarted = false
		cancelResponse(volcWs)
		pendingExactTimer = setTimeout(speakNextReadingChunk, 900)
	}

	const resumeReading = ({ restart = false } = {}) => {
		if (readingState) {
			if (restart) { readingState.cursor = 0; readingState.completed = false }
			if (readingState.completed && !restart) { queueExactSpeech('刚才的当前对话结果已经读完。'); return }
			readingState.paused = false
			delete readingState.activeIndex
			exactResponseActive = false
			exactAudioStarted = false
			pendingExactSpeech = ''
			log('reading resume', readingState.cursor, '/', readingState.chunks.length)
			cancelResponse(volcWs)
			setTimeout(speakNextReadingChunk, 450)
			return
		}
		if (reportState) {
			if (restart) { reportState.cursor = 0; reportState.completed = false }
			if (reportState.completed && !restart) { queueExactSpeech('刚才的全部对话报告已经读完。'); return }
			reportState.paused = false
			delete reportState.activeIndex
			exactResponseActive = false
			exactAudioStarted = false
			pendingExactSpeech = ''
			log('report resume', reportState.cursor, '/', reportState.items.length)
			cancelResponse(volcWs)
			setTimeout(speakNextReportItem, 450)
			return
		}
		queueExactSpeech('现在没有暂停的结果或报告。请先说读取当前结果，或者总结所有对话。')
	}

	const readCurrentTurnResult = (preview = '正在读取当前对话结果') => {
		if (!targetSessionId) {
			queueExactSpeech('当前没有绑定具体的 Harness 会话。')
			return
		}
		sendPhone(phoneWs, { type: 'status', state: 'thinking', preview })
		void inspectBoundSession(cfg, targetSessionId).then((state) => {
			const title = targetTitle || state.turnResult?.title || '当前对话'
			let speech = state.turnResult?.speechSummary || (state.turnResult?.result ? summarizeForSpeech(state.turnResult.result) : '')
			if (speech) speech = `我读取的是 Harness 当前页面，${title}。最近一轮完成结果是：${speech}` + (state.running ? '。当前还有新一轮正在运行。' : '')
			else speech = state.running ? `我读取的是 Harness 当前页面，${title}。它正在运行，但还没有完成小结。` : `我读取的是 Harness 当前页面，${title}。目前还没有可读取的完成小结。`
			startResultReading(speech)
		}).catch((err) => {
			log('current result read failed', err?.message ?? err)
			queueExactSpeech('当前 Harness 对话结果读取失败，请稍后再试。')
		})
	}

	const splitExplicitGlobalTasks = (taskBody) => {
		const text = String(taskBody || '').replace(/\s+/g, ' ').trim()
		if (!/(两个|两项|2个|2项)任务/.test(text)) return []
		const headerAt = text.search(/(两个|两项|2个|2项)任务/)
		const afterHeader = text.slice(headerAt).replace(/^(两个|两项|2个|2项)任务[，。；;：:\s]*/, '')
		const firstMarker = afterHeader.match(/^(?:第)?一[、，。：:\s]?/)
		if (!firstMarker) return []
		const tail = afterHeader.slice(firstMarker[0].length)
		const secondMatch = tail.match(/(?:[，。；;：:\s](?:第)?二[、，。：:\s]?|(?:第)?二(?=我|需要|请|帮|查|看|打开|检查|读取|修改))/)
		if (!secondMatch || secondMatch.index === undefined) return []
		const first = tail.slice(0, secondMatch.index).trim().replace(/[，。；;]+$/g, '')
		const second = tail.slice(secondMatch.index + secondMatch[0].length).trim().replace(/[，。；;]+$/g, '')
		if (first.length < 4 || second.length < 4) return []
		return [first, second]
	}

	const independentInstruction = (task, index, total) => `用户已经在语音通话中确认执行。这是明确拆分出的第${index + 1}个任务，共${total}个；请只执行本任务，不要等待再次确认，也不要处理其他任务。\n\n审批协议：语音不能批准工具权限。需要审批时必须在本 Harness 会话中发起显式 UI 审批并等待用户点击。\n\n任务内容：\n${task}`

	const dispatchGlobalTasks = (tasks) => {
		busy = true
		sendPhone(phoneWs, { type: 'status', state: 'listening', preview: `正在分别创建${tasks.length}个 Harness 会话` })
		void Promise.allSettled(tasks.map((task, index) => dispatchIndependentTask(cfg, independentInstruction(task, index, tasks.length))))
			.then((results) => {
				const succeeded = results.filter((x) => x.status === 'fulfilled')
				const failed = results.length - succeeded.length
				log('independent tasks dispatched', 'success', succeeded.length, 'failed', failed, results.map((x) => x.status === 'fulfilled' ? x.value.sessionId : String(x.reason?.message || x.reason)))
				const speech = failed === 0
					? `已经分别创建${succeeded.length}个 Harness 会话并提交。`
					: succeeded.length ? `已成功提交${succeeded.length}个任务，另有${failed}个创建失败。` : `这${failed}个任务都没有提交成功。`
				queueExactSpeech(speech)
			})
			.finally(() => { busy = false })
	}

	const dispatchCapturedTask = (sourceText = '') => {
		const taskBody = taskUtterances.join('\n').trim()
		if (!taskBody) {
			queueExactSpeech('还没有整理到任务，请先说明要电脑做什么。')
			return false
		}
		const explicitTasks = assistantMode === 'global' ? splitExplicitGlobalTasks(taskBody) : []
		const instruction = `用户已在语音通话中听完计划并明确确认派单。请直接执行，不要再次等待确认。\n\n审批协议：delegated subagent 的审批被禁用。子任务若遇到权限不足，必须把所需工具、完整参数、理由和影响返回主会话；主会话亲自重放该操作并发起审批，让用户在当前手机会话页批准。禁止子任务绕过审批或因为不能审批就结束整个任务。\n\n完整任务上下文：\n${taskBody}`
		const dispatchKey = explicitTasks.length === 2 ? `global-split:${taskBody}` : instruction
		if (dispatchKey === lastDispatchedInstruction) {
			sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '这个任务已经交给电脑了，仍可继续说' })
			return false
		}
		lastDispatchedInstruction = dispatchKey
		taskUtterances = []
		taskCaptureStarted = false
		log('confirmed dispatch', sourceText, explicitTasks.length === 2 ? JSON.stringify(explicitTasks) : instruction.slice(0, 500))
		cancelResponse(volcWs)
		if (explicitTasks.length === 2) dispatchGlobalTasks(explicitTasks)
		else {
			runForeman(instruction)
			queueExactSpeech(targetSessionId ? '好，已经交给当前 Harness 对话。' : '好，已经交给电脑。')
		}
		return true
	}

	const runForeman = (instruction, { fromTool, callId } = {}) => {
		if (busy) log('another background dispatch already running; DSH queue will serialize if needed')
		busy = true
		sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '任务已交给电脑，语音仍可继续使用' })
		turnAbort = new AbortController()
		const work = targetSessionId
			? handleBoundSessionUtterance(cfg, targetSessionId, instruction, { signal: turnAbort.signal })
			: handleUserUtterance(cfg, instruction, { signal: turnAbort.signal })

		void work.then((result) => {
			if (fromTool && callId && volcWs) toolResult(volcWs, callId, JSON.stringify({ ok: true, sessionId: result.sessionId }))
			lastCompletedSpeech = result.speech || ''
			lastCompletedRaw = result.raw || ''
			const notice = '任务完成了。需要的话，对我说读结果。'
			if (volcWs && !closed) speakExact(volcWs, notice)
			sendPhone(phoneWs, { type: 'status', state: 'speaking', sessionId: result.sessionId, preview: notice })
		}).catch((err) => {
			const msg = '电脑没接上：' + String(err?.message ?? err)
			log(msg)
			if (fromTool && callId && volcWs) toolResult(volcWs, callId, JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
			if (!closed && volcWs) speakExact(volcWs, '电脑这边没接上，过会儿再说。')
			sendPhone(phoneWs, { type: 'error', message: msg })
		}).finally(() => {
			busy = false
		})
	}

	const onVolc = (ev) => {
		const type = ev?.type
		if (type !== 'response.output_audio.delta' && type !== 'input_audio_buffer.committed') {
			log('volc', type || JSON.stringify(ev).slice(0, 180))
		}
		if (USER_EVENT.has(type)) sendPhone(phoneWs, { type: 'volc', event: type })
		if (type === 'session.created' || type === 'session.updated') {
			sessionReady = true
			sendPhone(phoneWs, { type: 'status', state: 'connected', sessionId: ev.session?.id || '' })
			if (type === 'session.created') {
				mute(volcWs)
				greet(volcWs, '在，你说。')
			}
			return
		}
		if (type === 'response.output_text.delta') {
			const piece = String(ev.delta || ev.text || ev.transcript || ev.output_text || '')
			if (!assistantText) log('output_text.delta', JSON.stringify(ev).slice(0, 300))
			assistantText += piece
			if (assistantText.trim()) sendPhone(phoneWs, { type: 'assistant_text', text: assistantText })
			return
		}
		if (type === 'response.output_text.done') {
			const done = String(ev.text || assistantText || '').trim()
			assistantText = ''
			if (done) {
				lastSpokenText = done
				sendPhone(phoneWs, { type: 'assistant_text', text: done })
			}
			return
		}
		if (type === 'conversation.item.input_audio_transcription.started') {
			// 仅表示检测到可能的声音，可能只是噪声。不要在没有识别文字时打断播报。
			log('transcript start', JSON.stringify(ev).slice(0, 400))
			if (!botSpeaking) sendPhone(phoneWs, { type: 'status', state: 'thinking' })
			return
		}
		if (type === 'response.output_audio.started') {
			botSpeaking = true
			if (exactResponseActive) exactAudioStarted = true
			sendPhone(phoneWs, { type: 'status', state: 'speaking' })
			return
		}
		if (type === 'response.output_audio.delta') {
			const b64 = ev.delta || ev.audio || ev.data
			if (!b64) return
			try {
				const audio = Buffer.from(String(b64), 'base64')
				if (exactResponseActive) exactAudioBytes += audio.length
				// 保留火山原始音频块。拆成大量小 WebSocket 帧会让手机调度抖动，造成重叠播放。
				sendPhoneBin(phoneWs, audio)
			} catch { /* ignore */ }
			return
		}
		if (type === 'response.output_audio.done') {
			botSpeaking = false
			greetDone = true
			// 只在初始问候结束后取消静音；之后保持真正的持续全双工上行。
			unmute(volcWs)
			// 下一段不能在 audio.done 立即提交；火山上一轮 response 尚未结算，会静默吞掉新 TTS。
			if (!exactResponseActive) sendPhone(phoneWs, { type: 'status', state: 'listening' })
			return
		}
		if (type === 'conversation.item.input_audio_transcription.delta') {
			log('transcript delta', JSON.stringify(ev).slice(0, 300))
			const text = transcriptOf(ev)
			const meaningful = text.replace(/[\s，。！？、,.!?嗯啊哦呃]/g, '')
			const spokenClean = (currentPhonePlaybackText || lastSpokenText).replace(/[\s，。！？、,.!?]/g, '')
			const likelyEcho = meaningful.length >= 4 && spokenClean.includes(meaningful)
			const assistantAudible = botSpeaking || phonePlaybackActive
			if (assistantAudible && meaningful.length >= 4 && !likelyEcho) {
				if (readingState && !readingState.completed) {
					readingState.paused = true
					delete readingState.activeIndex
				}
				if (reportState && !reportState.completed) {
					reportState.paused = true
					delete reportState.activeIndex
				}
				exactSpeechChunks = []
				pendingExactSpeech = ''
				exactResponseActive = false
				exactAudioStarted = false
				cancelResponse(volcWs)
				botSpeaking = false
				phonePlaybackActive = false
				currentPhonePlaybackText = ''
				assistantText = ''
				sendPhone(phoneWs, { type: 'cancel_playback' })
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '听到你插话了' })
			}
			if (text) sendPhone(phoneWs, { type: 'user_partial', text })
			const itemId = String(ev.item_id || ev.itemId || '')
			const quickCurrentResult = assistantMode === 'session' && targetSessionId
				&& /^(读|念|说|讲|汇报|总结|复述|查看|读取)?(一下|一下子)?(当前|这个|本次|我们)?(对话|会话|聊天)?的?(执行)?(结果|结论|小结)[。！？，,]?$/u.test(text.trim())
			const quickContinue = /^(继续|继续读|接着读|往下读|继续汇报|接着汇报)[。！？，,]?$/u.test(text.trim())
			const deltaNormalized = normalizeHarnessSpeech(text, { assistantMode, hasBoundSession: Boolean(targetSessionId) }).text
			const quickConfirmDispatch = /^(确认|确认吧|确定|确定吧|可以执行|开始执行|开工吧)[。！！，,]?$/u.test(deltaNormalized.trim())
			if (quickConfirmDispatch && itemId && !handledTranscriptItems.has(itemId)) {
				handledTranscriptItems.add(itemId)
				if (handledTranscriptItems.size > 40) handledTranscriptItems.delete(handledTranscriptItems.values().next().value)
				log('route=confirm-dispatch-early-delta', itemId, text, '=>', deltaNormalized)
				dispatchCapturedTask(deltaNormalized)
			} else if (quickContinue && itemId && !handledTranscriptItems.has(itemId)) {
				handledTranscriptItems.add(itemId)
				if (handledTranscriptItems.size > 40) handledTranscriptItems.delete(handledTranscriptItems.values().next().value)
				log('route=continue-reading-early-delta', itemId, text)
				cancelResponse(volcWs)
				resumeReading()
			} else if (quickCurrentResult && itemId && !handledTranscriptItems.has(itemId)) {
				handledTranscriptItems.add(itemId)
				if (handledTranscriptItems.size > 40) handledTranscriptItems.delete(handledTranscriptItems.values().next().value)
				log('route=current-result-early-delta', itemId, text)
				cancelResponse(volcWs)
				readCurrentTurnResult('已识别短命令，正在读取 Harness 当前页面结果')
			}
			return
		}
		if (type === 'conversation.item.input_audio_transcription.completed') {
			log('transcript done', JSON.stringify(ev).slice(0, 400))
			const text = transcriptOf(ev)
			const itemId = String(ev.item_id || ev.itemId || '')
			if (text) sendPhone(phoneWs, { type: 'user_text', text })
			if (!text) return
			if (itemId && handledTranscriptItems.has(itemId)) {
				log('ignored completed transcript already routed from delta', itemId)
				return
			}

			const semantic = normalizeHarnessSpeech(text, { assistantMode, hasBoundSession: Boolean(targetSessionId) })
			const normalizedText = semantic.text
			if (semantic.changed) log('semantic normalized', JSON.stringify({ from: semantic.original, to: semantic.text }))
			const asksContinueReport = /继续读|接着读|往下读|继续汇报|接着汇报|从刚才继续|继续刚才/.test(normalizedText)
			const asksRestartReport = /从头读|重新读|重头读|从第一个开始/.test(normalizedText)
			if (asksContinueReport || asksRestartReport || /^继续[。！？，,]?$/u.test(normalizedText)) {
				resumeReading({ restart: asksRestartReport })
				return
			}
			const asksProgress = /进度怎么样|进展怎么样|做到哪|做完了没|好了没|任务状态|查进度|什么进度/.test(normalizedText)
			const asksListSessions = /有哪些(对话|会话|任务)|全部(对话|会话)|列出(对话|会话)|哪些(对话|会话).{0,6}(运行|执行|审批|完成)|总览/.test(normalizedText)
			const asksAllSessionResults = /(所有|全部|这几个|现行|未归档).{0,8}(对话|会话|聊天).{0,12}(执行结果|结果|结论|总结|汇总)|(总结|汇总|报告).{0,10}(所有|全部|这几个|现行|未归档).{0,6}(对话|会话|聊天)/.test(normalizedText)
			const asksSummarizeSession = /(总结|概括|汇总|查看|读取|识别|复述|汇报).{0,12}(当前|这个|本次|我们)?(对话|会话|聊天)|(当前|这个|本次|我们)(对话|会话|聊天).{0,12}(执行结果|结果|结论|总结|怎么样)|(对话|会话|聊天)的(执行结果|结果|结论|总结).{0,8}(怎么样|是什么|读一下|说一下|复述一下)?/.test(normalizedText)
			const asksReadResult = /读结果|读给我听|念结果|念给我听|汇报结果|告诉我结果|说一下结果|^结果[。！？，,]?$/u.test(normalizedText)
			const asksGenericResult = /(总结|概括|汇总|查看|读取|识别|复述|汇报|读|念|说).{0,16}(执行结果|任务结果|完成结果|结果|结论|小结)/.test(normalizedText)

			const explicitlyCurrent = /(当前|这个|本次|我们)(对话|会话|聊天)|(对话|会话|聊天)的(结果|进度|结论)/.test(normalizedText)
			const asksCrossSession = assistantMode === 'session'
				&& !explicitlyCurrent
				&& (asksProgress || asksSummarizeSession || asksReadResult)
				&& /(查看|读取|总结|汇总|进度|结果|结论|那个|另一个|其他)/.test(text)

			if (asksAllSessionResults) {
				log('route=all-session-results', normalizedText)
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '正在汇总全部未归档对话，最多等待九秒' })
				void Promise.race([
					listDispatchSessions(cfg).then((sessions) => summarizeActiveSessions(cfg, sessions)),
					new Promise((_, reject) => setTimeout(() => reject(new Error('all sessions summary timeout')), 9000))
				]).then(({ rows, total }) => {
					const items = rows.map((row) => {
						const state = row.approvalCount ? `${row.approvalCount}项待审批` : (row.running ? '运行中' : '已结束')
						return { title: row.title, speech: `${row.title}，${state}。${compactReportSummary(row.summary)}` }
					})
					if (pendingExactTimer) clearTimeout(pendingExactTimer)
					readingState = null
					exactRetryCount = 0
					cancelPhoneOnNextFlush = true
					reportState = { items, cursor: 0, total, paused: false, completed: false }
					log('report prepared', items.length, 'of', total)
					queueExactSpeech(`未归档对话共${total}个。这次按顺序读${items.length}个。每个对话读完会自动继续。`)
					if (total > items.length) reportState.tailNotice = `另外还有${total - items.length}个较早对话，需要时可以点名读取。`
				}).catch((err) => {
					log('all sessions summary failed', err?.message ?? err)
					queueExactSpeech('全部对话汇总超时了，没有继续卡住。你可以先问哪些对话正在运行，或者点名读取一个对话。')
				})
				return
			}

			if (assistantMode === 'session' && targetSessionId && asksGenericResult && !asksAllSessionResults && !asksCrossSession) {
				log('route=current-result-by-page-default', normalizedText)
				readCurrentTurnResult('正在读取 Harness 当前页面：' + (targetTitle || targetSessionId.slice(-8)))
				return
			}

			if (assistantMode === 'global' && asksListSessions) {
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '正在读取全部手机会话' })
				void listDispatchSessions(cfg).then((sessions) => {
					const active = sessions.filter((s) => s.running)
					const approvals = sessions.filter((s) => s.pending)
					const recent = [...sessions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 5)
					let speech = `现在共有${sessions.length}个对话，${active.length}个正在运行，${approvals.length}个待审批。`
					if (recent.length) speech += '最近的对话有：' + recent.map((s) => s.title + (s.running ? '，运行中' : '') + (s.pending ? `，${s.pending}项待审批` : '')).join('；') + '。'
					queueExactSpeech(speech)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: speech.slice(0, 140) })
				}).catch((err) => sendPhone(phoneWs, { type: 'error', message: '读取会话目录失败：' + String(err?.message ?? err) }))
				return
			}

			if ((assistantMode === 'global' || asksCrossSession) && (asksProgress || asksSummarizeSession || asksReadResult)) {
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '正在查找你说的对话' })
				void listDispatchSessions(cfg).then(async (sessions) => {
					const matches = matchDispatchSessions(sessions, text)
					if (!matches.length) {
						const recent = [...sessions].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 4)
						const speech = recent.length ? '请说具体对话名称。最近有：' + recent.map((s) => s.title).join('；') + '。' : '现在还没有可读取的对话。'
						queueExactSpeech(speech)
						return
					}
					if (matches.length > 1) {
						const first = matches[0]
						const second = matches[1]
						const speech = `我找到多个接近的对话：${first.title}；${second.title}。请再说完整一点。`
						queueExactSpeech(speech)
						return
					}
					const chosen = matches[0]
					log('route=cross-session', chosen.sessionId, chosen.title)
					const state = await inspectBoundSession(cfg, chosen.sessionId)
					let speech
					if (asksProgress && !asksSummarizeSession && !asksReadResult) {
						if (state.approvalCount) speech = `${chosen.title}有${state.approvalCount}项待审批。`
						else speech = `${chosen.title}${state.running ? '还在运行。' : '已经结束运行。'}`
					} else {
						speech = state.recentSummary || state.lastAssistant || '这个对话还没有可读取的执行结果。'
						if (state.running) speech = `${chosen.title}还在运行。现有结果是：` + speech
						else speech = `${chosen.title}的结果是：` + speech
					}
					queueExactSpeech(speech)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: speech.slice(0, 140) })
				}).catch((err) => {
					queueExactSpeech('跨对话读取失败，请稍后再试。')
					sendPhone(phoneWs, { type: 'error', message: '跨对话读取失败：' + String(err?.message ?? err) })
				})
				return
			}

			if (asksProgress) {
				if (!targetSessionId) {
					queueExactSpeech(busy ? '电脑还在做。' : '当前没有绑定具体会话。')
					return
				}
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '正在读取当前会话真实进度' })
				void inspectBoundSession(cfg, targetSessionId).then((state) => {
					let speech
					if (state.approvalCount) speech = `当前有${state.approvalCount}项审批等待你在手机会话页处理。`
					else if (state.running || busy) speech = '当前会话还在执行。语音仍可继续使用。'
					else if (lastCompletedSpeech || state.lastAssistant) speech = '当前会话已经结束运行。你可以说读结果。'
					else speech = '当前会话没有正在执行的任务。'
					queueExactSpeech(speech)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: speech })
				}).catch((err) => sendPhone(phoneWs, { type: 'error', message: '读取进度失败：' + String(err?.message ?? err) }))
				return
			}

			if (asksSummarizeSession) {
				log('route=current-session-summary', targetSessionId, targetTitle)
				if (!targetSessionId) {
					queueExactSpeech('当前没有绑定具体的 Harness 会话。')
					return
				}
				sendPhone(phoneWs, { type: 'status', state: 'thinking', preview: '正在读取当前对话：' + (targetTitle || targetSessionId.slice(-8)) })
				void inspectBoundSession(cfg, targetSessionId).then((state) => {
					const title = targetTitle || state.turnResult?.title || '当前对话'
					let speech = state.turnResult?.speechSummary || (state.turnResult?.result ? summarizeForSpeech(state.turnResult.result) : '')
					if (speech) speech = `我读取的是 Harness 当前页面，${title}。最近一轮完成结果是：${speech}` + (state.running ? '。当前还有新一轮正在运行。' : '')
					else speech = state.running ? `我读取的是 Harness 当前页面，${title}。它正在运行，但还没有完成小结。` : `我读取的是 Harness 当前页面，${title}。目前还没有可读取的完成小结。`
					queueExactSpeech(speech)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: speech.slice(0, 120) })
				}).catch((err) => {
					const message = '读取当前会话失败：' + String(err?.message ?? err)
					queueExactSpeech('当前会话暂时读取失败，请稍后再试。')
					sendPhone(phoneWs, { type: 'error', message })
				})
				return
			}

			if (asksReadResult) {
				const cached = lastCompletedSpeech || lastCompletedRaw
				if (cached) {
					queueExactSpeech(cached)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: cached.slice(0, 100) })
					return
				}
				if (!targetSessionId) {
					queueExactSpeech('目前没有可读的任务结果。')
					return
				}
				void inspectBoundSession(cfg, targetSessionId).then((state) => {
					const title = targetTitle || state.turnResult?.title || '当前对话'
					let speech = state.turnResult?.speechSummary || (state.turnResult?.result ? summarizeForSpeech(state.turnResult.result) : '')
					if (speech) speech = `${title}最近一轮完成结果是：${speech}` + (state.running ? '。当前还有新一轮正在运行。' : '')
					else speech = state.running ? `${title}正在运行，但还没有可读取的已完成小结。` : `${title}目前没有可读的任务结果。`
					queueExactSpeech(speech)
					sendPhone(phoneWs, { type: 'status', state: 'speaking', preview: speech.slice(0, 100) })
				}).catch((err) => sendPhone(phoneWs, { type: 'error', message: '读取结果失败：' + String(err?.message ?? err) }))
				return
			}

			const isCorrection = /听错了|你听错|识别错|不对|不是这个|不是不是|我重新说|我重说|重新来/.test(text)
			if (isCorrection) {
				if (taskUtterances.length) taskUtterances.pop()
				correctionPending = true
				log('correction requested, task turns now', taskUtterances.length)
				queueExactSpeech('好，刚才听错了。请重新说完整一点。')
				sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '已撤回上一条，请重新说' })
				return
			}

			if (looksLikeConfirmDispatch(normalizedText)) {
				dispatchCapturedTask(normalizedText)
				return
			}

			// 保存本通电话中已经完整听写的任务描述，确认词和“要派单吗”之类确认疑问不进入任务。
			const dispatchQuestion = /(派单|拍单|排单).{0,4}(吗|么|嘛|？|\?)|要不要.{0,4}(派单|拍单|排单)/.test(text)
			if (!taskCaptureStarted && (looksLikeWork(text) || correctionPending) && !dispatchQuestion) taskCaptureStarted = true
			if (taskCaptureStarted && !dispatchQuestion && !/^(你好|您好|在吗|谢谢|好的|嗯|哦|啊)$/u.test(text)) {
				taskUtterances.push(text)
				correctionPending = false
				while (taskUtterances.length > 8 || taskUtterances.join('\n').length > 1600) taskUtterances.shift()
				log('task context turns', taskUtterances.length, 'chars', taskUtterances.join('\n').length)
			}
			return
		}
		if (type === 'conversation.item.input_audio_transcription.failed') {
			sendPhone(phoneWs, { type: 'error', message: '没听清，再说一遍' })
			sendPhone(phoneWs, { type: 'status', state: 'listening' })
			return
		}
		if (type === 'response.done') {
			if (exactResponseActive && exactAudioStarted) {
				const minBytes = Math.min(48000, Math.max(10000, exactCurrentText.length * 1100))
				const tooShort = exactCurrentText.length >= 12 && exactAudioBytes < minBytes
				log('exact response done', 'chars', exactCurrentText.length, 'audioBytes', exactAudioBytes, 'minBytes', minBytes, 'tooShort', tooShort)
				exactResponseActive = false
				exactAudioStarted = false
				if (tooShort) {
					if (exactRetryCount < 1) {
						exactRetryCount += 1
						cancelPhoneOnNextFlush = true
						pendingExactSpeech = exactCurrentText
						log('retry short exact audio', exactRetryCount)
						setTimeout(flushExactSpeech, 350)
					} else {
						exactRetryCount = 0
						if (readingState) { readingState.paused = true; delete readingState.activeIndex }
						if (reportState) { reportState.paused = true; delete reportState.activeIndex }
						sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '这一段语音合成不完整。说继续，会从这一段重试。' })
					}
					return
				}
				exactRetryCount = 0
				if (readingState?.activeIndex !== undefined) {
					readingState.cursor = readingState.activeIndex + 1
					delete readingState.activeIndex
				}
				if (reportState?.activeIndex !== undefined) {
					reportState.cursor = reportState.activeIndex + 1
					delete reportState.activeIndex
				}
				if (exactSpeechChunks.length) {
					pendingExactSpeech = exactSpeechChunks.shift()
					setTimeout(flushExactSpeech, 250)
				} else if (readingState && !readingState.paused && !readingState.completed) {
					setTimeout(speakNextReadingChunk, 250)
				} else if (reportState && !reportState.paused && !reportState.completed) {
					setTimeout(speakNextReportItem, 250)
				} else {
					sendPhone(phoneWs, { type: 'status', state: 'listening', preview: (readingState?.paused || reportState?.paused) ? '阅读已暂停，说继续可以接着听' : '' })
				}
			}
			return
		}
		if (type === 'response.canceled' || type === 'response.cancelled') {
			botSpeaking = false
			assistantText = ''
			sendPhone(phoneWs, { type: 'cancel_playback' })
			if (pendingExactSpeech) {
				flushExactSpeech()
			} else {
				sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '已打断，请继续说' })
			}
			return
		}
		if (type === 'response.function_call_arguments.done') {
			// 兼容旧会话日志。新会话不再把派单决定交给 STS 工具选择，避免普通问句误调用。
			log('ignored sts tool call', JSON.stringify(ev).slice(0, 600))
			return
		}
		if (type === 'error') {
			const raw = ev.error?.message || ev.message || JSON.stringify(ev)
			const isTtsTimeout = /52000016|AudioTTSIdleTimeoutError/i.test(raw)
			const msg = isTtsTimeout
				? '火山语音合成超时，这通语音会话已中断；任务尚未派出，请重新接通后再说'
				: raw
			log('volc error', raw)
			sendPhone(phoneWs, { type: 'error', message: msg, code: isTtsTimeout ? 'audio_tts_timeout' : 'volc_error' })
			if (isTtsTimeout) sendPhone(phoneWs, { type: 'status', state: 'ended', preview: msg })
			return
		}
		if (type === 'session.closed') end('volc closed')
	}

	try {
		volcWs = connectVolc(cfg, {
			onJson: onVolc,
			onClose: (code, reason) => {
				sendPhone(phoneWs, { type: 'status', state: 'ended', code, reason })
				end('volc ws ' + code)
			},
			onError: (err) => {
				sendPhone(phoneWs, { type: 'error', message: String(err?.message ?? err) })
			}
		})
	} catch (err) {
		sendPhone(phoneWs, { type: 'error', message: String(err?.message ?? err) })
		end('no volc')
		return
	}

	volcWs.on('open', () => {
		log('volc ws open, creating session')
		sendJson(volcWs, sessionCreatePayload(cfg))
		sendPhone(phoneWs, { type: 'status', state: 'connected' })
	})

	phoneWs.on('message', (data, isBinary) => {
		if (closed) return
		const asBuf = Buffer.isBuffer(data) ? data : Buffer.from(data)
		const looksPcm = isBinary || (asBuf.length >= 2 && asBuf.length % 2 === 0 && asBuf[0] !== 0x7b)
		if (looksPcm && !isJsonText(asBuf)) {
			if (!sessionReady || !greetDone) return
			if (asBuf.length && volcWs) {
				// 纯 STS 全双工实验：不做本地 VAD、不缓存、不 commit、不因模型说话而停上行。
				appendPcm16k(volcWs, asBuf)
				upFrames += 1
				if (upFrames === 1 || upFrames % 50 === 0) {
					log('full-duplex pcm frames', upFrames, 'bytes', asBuf.length, 'rms', pcmRms(asBuf), 'botSpeaking', botSpeaking)
				}
			}
			return
		}
		let msg
		try { msg = JSON.parse(asBuf.toString('utf8')) } catch { return }
		if (msg.type === 'mute') mute(volcWs)
		else if (msg.type === 'unmute') unmute(volcWs)
		else if (msg.type === 'cancel') {
			cancelResponse(volcWs)
			botSpeaking = false
			assistantText = ''
			sendPhone(phoneWs, { type: 'status', state: 'listening', preview: '已打断，请继续说' })
		}
		else if (msg.type === 'hangup') end('hangup')
		else if (msg.type === 'client_log') {
			const stage = String(msg.stage || 'event')
			const detail = String(msg.detail || '')
			if (stage === 'playback_segment_started') {
				phonePlaybackActive = true
				currentPhonePlaybackText = playbackSegmentTexts.get(detail) || currentPhonePlaybackText
				log('phone playback started', detail, currentPhonePlaybackText.slice(0, 80))
			} else if (stage === 'playback_drained') {
				phonePlaybackActive = false
				currentPhonePlaybackText = ''
				log('phone playback drained', detail)
			} else {
				log('phone client', stage, detail.slice(0, 300))
			}
		}
		else if (msg.type === 'text' && msg.text) {
			speakExact(volcWs, '好，我让电脑处理。')
			void runForeman(String(msg.text))
		}
	})

	phoneWs.on('close', () => end('phone closed'))
	phoneWs.on('error', () => end('phone error'))
}
