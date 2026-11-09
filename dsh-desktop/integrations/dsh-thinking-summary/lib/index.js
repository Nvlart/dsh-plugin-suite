/**
 * dsh-thinking-summary — Host half
 *
 * 在原生 "Deep diving" 状态右侧显示当前计划，并在每段思考下方生成中文摘要卡片：
 * - 数据源：session/event 日志（与 dsh-TUI 相同的确定性投影思路）
 * - 触发点：思考刚结束（推理块完成 / 首个工具或文本增量）即触发，命令执行前出计划
 * - 生成：使用配置的模型，优先关闭思考，失败自动重试
 * - 设置：settings 命名空间 dsh-thinking-summary（计划后缀开关、摘要卡片开关、计划长度）
 * - 通信：/thinking-summary/api/* webServer 路由（客户端 fetch 调用）
 */
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-thinking-summary'
export const inject = ['llm', 'webServer']

const NS = 'dsh-thinking-summary'
const RESULTS_LIMIT = 300
const CHUNK_ACC_LIMIT = 200
const DEFAULT_MAX_REASONING_CHARS = 14000

/** 用户可在设置页调整的偏好（settings 命名空间，写后即生效） */
export const Config = z.object({
  planSuffix: z.boolean().default(true).volatile(),
  flowCards: z.boolean().default(true).volatile(),
  planMaxChars: z.number().step(1).min(12).max(48).default(36).volatile(),
  providerId: z.string().default('').volatile(),
  modelId: z.string().default('').volatile(),
  maxOutputTokens: z.number().step(1).min(64).max(8192).default(500).volatile(),
  maxAttempts: z.number().step(1).min(1).max(5).default(2).volatile(),
})

const TOOL_LABELS = {
  bash: '正在执行命令',
  read: '正在读取文件',
  grep: '正在搜索内容',
  glob: '正在查找文件',
  write: '正在写入文件',
  edit: '正在编辑文件',
  todo_write: '正在更新任务清单',
  web_search: '正在网络搜索',
  web_fetch: '正在获取网页',
  skill: '正在加载技能',
  ask_user_question: '正在等待你的回答',
  subagent: '正在委派子任务',
  subagent_fork: '正在委派子任务',
}

function toolLabel(name) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(TOOL_LABELS, name)) return TOOL_LABELS[name]
  return typeof name === 'string' && name !== '' ? `正在运行 ${name}` : '正在执行工具'
}

/** 超长时按标点边界截断，避免把话砍在半截 */
function clipPlan(plan, max) {
  if (plan.length <= max) return plan
  let cut = plan.slice(0, max)
  const punctuation = '，、；。：,;: '
  let best = -1
  for (let i = cut.length - 1; i >= Math.floor(max / 2); i--) {
    if (punctuation.indexOf(cut[i]) !== -1) { best = i; break }
  }
  if (best !== -1) cut = cut.slice(0, best)
  return cut.replace(/[，、；。：,;:\s]+$/, '') + '…'
}

function stateFor(states, sid) {
  let state = states.get(sid)
  if (state === undefined) {
    state = { current: null, latestPlan: null, chunkAcc: new Map(), results: new Map() }
    states.set(sid, state)
  }
  return state
}

function storeResult(state, key, result) {
  state.results.set(key, result)
  while (state.results.size > RESULTS_LIMIT) {
    const oldest = state.results.keys().next().value
    state.results.delete(oldest)
  }
}

function extractReasoning(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  let reasoning = ''
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      reasoning += block.text + '\n'
    }
  }
  return reasoning.trim()
}

function toolNames(message) {
  const names = []
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return names
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.name === 'string' && names.indexOf(block.name) === -1) {
      names.push(block.name)
    }
  }
  return names
}

/** 从 assistant/chunk 流中提前还原思考文本：推理块结束或首个工具/文本增量到来即视为“思考结束” */
function reasoningFromChunks(events, turn, step) {
  let reasoning = ''
  const tools = []
  let thinkingStarted = false
  let thinkingEnded = false
  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') continue
    if (event.type !== 'assistant/chunk' || event.data.turn !== turn || event.data.step !== step) continue
    const chunk = event.data.chunk
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text
      thinkingStarted = true
    } else if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string') {
      reasoning = chunk.block.text
      thinkingStarted = true
      thinkingEnded = true
    } else if (chunk.type === 'tool-call-delta') {
      if (typeof chunk.name === 'string' && tools.indexOf(chunk.name) === -1) tools.push(chunk.name)
      if (thinkingStarted) thinkingEnded = true
    } else if (chunk.type === 'text-delta') {
      if (thinkingStarted) thinkingEnded = true
    }
  }
  return { reasoning: reasoning.trim(), tools, complete: thinkingEnded }
}

async function loadEvents(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessions.get === 'function') {
    const live = sessions.get(sessionId)
    if (live !== null && live !== undefined && typeof live.snapshotEvents === 'function') return live.snapshotEvents()
    if (live !== null && live !== undefined && Array.isArray(live.events)) return live.events
  }
  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery !== undefined && typeof sessionQuery.readSession === 'function') {
    const snapshot = await sessionQuery.readSession(sessionId)
    if (snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.events)) return snapshot.events
  }
  throw new Error('无法读取会话数据')
}

async function discoverFlashTarget(ctx) {
  const llm = ctx.llm
  if (llm === undefined || typeof llm.listProviders !== 'function') return null
  let providers = []
  try { providers = llm.listProviders() || [] } catch { providers = [] }
  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string') continue
    let models = []
    try { models = (await llm.listModels(provider.id)) || [] } catch { models = [] }
    for (const model of models) {
      if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
      if (model.id.toLowerCase().indexOf('flash') !== -1) return { provider: provider.id, model: model.id }
    }
  }
  for (const provider of providers) {
    if (provider !== null && typeof provider === 'object' && provider.id === 'deepseek-official') {
      return { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    }
  }
  return null
}

async function resolveTarget(ctx, selection) {
  if (!selection.providerId) {
    if (selection.modelId) throw new Error('请先选择提供商')
    const target = await discoverFlashTarget(ctx)
    if (!target) throw new Error('没有找到可用的 Flash 模型，请手动选择提供商和模型')
    return target
  }
  const providers = ctx.llm.listProviders()
  if (!providers.some((p) => p.id === selection.providerId)) throw new Error('所选提供商不可用，请重新选择')
  const models = await ctx.llm.listModels(selection.providerId)
  const model = selection.modelId ? models.find((m) => m.id === selection.modelId) : models.find((m) => /flash/i.test(m.id))
  if (!model) throw new Error(selection.modelId ? '所选模型不可用，请重新选择；不会自动切换到其他模型' : '该提供商没有 Flash 模型，请手动选择模型')
  return { provider: selection.providerId, model: model.id }
}

const supportsOff = (modelInfo) => modelInfo.reasoning?.efforts.some((effort) => effort.id === 'off') === true

async function callFlashOnce(ctx, target, userText, maxOutputTokens) {
  const call = await ctx.llm.prepareCall({ ...target, maxTokens: maxOutputTokens }, undefined, (controls, modelInfo) =>
    supportsOff(modelInfo) ? { ...controls, reasoningEffort: 'off' } : controls)
  const chunks = call.stream({
    ...call.config,
    system: '你是“思考过程中文摘要”助手。用户看不懂英文，请阅读编程助手某一步的英文思考过程，输出两行简体中文，不要 markdown、不要编号：第一行：用一句话（25 字以内）概括它接下来要做什么；不要写“助手准备/打算向用户”之类的主语铺垫，直接以动词开头，例如“排查编译错误”“对比三种摘要方案”。第二行：用 130 字以内总结它这段思考分析了什么、得出了哪些关键判断、准备执行什么操作。',
    messages: [{
      id: 'thinking-step-user',
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }],
  })
  let text = ''
  let failure = null
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason !== null && typeof chunk.reason === 'object' && chunk.reason.kind === 'error') {
      const f = chunk.reason.failure
      failure = f !== null && typeof f === 'object' && typeof f.message === 'string' ? f.message : '模型调用失败'
    }
  }
  if (failure !== null) throw new Error(failure)
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) throw new Error('摘要模型未返回内容')
  let plan = lines[0]
    .replace(/^(助手)?(准备|打算|计划)(向用户|接下来)?[，,:：]?\s*/, '')
    .replace(/^[0-9一二三四五六七八九十]+[.、)）:：]\s*/, '')
    .trim()
  const summary = lines.length > 1 ? lines.slice(1).join(' ') : plan
  return { status: 'ok', plan, summary }
}

async function generateStepResult(ctx, target, reasoning, tools, options) {
  const excerpt = reasoning.length > DEFAULT_MAX_REASONING_CHARS
    ? reasoning.slice(0, DEFAULT_MAX_REASONING_CHARS) + '\n…（思考内容过长已截断）'
    : reasoning
  const toolLine = tools.length > 0 ? `\n\n该步骤主模型调用了这些工具：${tools.join('、')}。` : ''
  const userText = `请总结以下思考过程：\n\n${excerpt}${toolLine}`
  let lastError = null
  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      const result = await callFlashOnce(ctx, target, userText, options.maxOutputTokens)
      result.plan = clipPlan(result.plan, options.planMaxChars)
      result.model = { provider: target.provider, model: target.model }
      return result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError !== null ? lastError : new Error('生成失败')
}

/** HTTP JSON 工具 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += String(chunk)
      if (raw.length > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy() }
    })
    req.on('end', () => {
      if (raw === '') { resolve(null); return }
      try { resolve(JSON.parse(raw)) } catch (error) { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, config = { planSuffix: true, flowCards: true, planMaxChars: 36 }) {
  const states = new Map()
  const watched = new Set()
  let queueTail = Promise.resolve()
  const startedAt = Date.now()

  // DSH 0.2.2 uses entry-owned volatile Config fields. The host updates this
  // object in place, so preferences change without losing session summaries.
  const readPreference = (key, fallback) => {
    const field = config[key]
    return field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field ?? fallback
  }
  const prefs = {
    get planSuffix() { return readPreference('planSuffix', true) },
    get flowCards() { return readPreference('flowCards', true) },
    get planMaxChars() { return readPreference('planMaxChars', 36) },
    get providerId() { return readPreference('providerId', '') },
    get modelId() { return readPreference('modelId', '') },
    get maxOutputTokens() { return readPreference('maxOutputTokens', 500) },
    get maxAttempts() { return readPreference('maxAttempts', 2) },
  }
  const settingsId = ctx.fiber?.entry?.options?.id ?? 'thinking-summary'
  let settingsService = null

  // 注册设置命名空间（写入后立即生效）
  ctx.inject(['settings'], (sctx) => {
    try {
      settingsService = sctx.settings
      sctx.effect(() => settingsService.configure({ auto: false }, ctx.fiber))
    } catch (error) {
      console.error(`[dsh-thinking-summary] 设置命名空间注册失败：${String(error)}`)
    }
  })

  const ensureWatched = (sid) => {
    if (!watched.has(sid)) watched.add(sid)
  }

  const scheduleGeneration = (sid, turn, step, reasoning, tools) => {
    if (!prefs.planSuffix && !prefs.flowCards) return
    const key = `${turn}#${step}`
    const run = queueTail.then(async () => {
      // Snapshot the current settings when this queued call actually starts.
      // A failed manual selection must never fall back to a different provider.
      const options = { providerId: prefs.providerId, modelId: prefs.modelId, maxOutputTokens: prefs.maxOutputTokens, maxAttempts: prefs.maxAttempts, planMaxChars: prefs.planMaxChars }
      const target = await resolveTarget(ctx, options)
      return generateStepResult(ctx, target, reasoning, tools, options)
    })
    queueTail = run.then(() => {}, () => {})
    run.then((result) => {
      const st = stateFor(states, sid)
      storeResult(st, key, result)
      if (result !== null && typeof result === 'object' && result.status === 'ok' && typeof result.plan === 'string') {
        st.latestPlan = { turn, step, plan: result.plan }
      }
    }).catch((error) => {
      const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
      ctx.logger?.warn(`[dsh-thinking-summary] 思考摘要生成失败：${message}`)
      storeResult(stateFor(states, sid), key, { status: 'error', message })
    })
  }

  /** 确保某一步的结果：优先 assistant/message（权威）；否则在思考刚结束时从 chunk 流提前取 */
  const ensureStepResult = async (sid, turn, step) => {
    const state = stateFor(states, sid)
    const key = `${turn}#${step}`
    const existing = state.results.get(key)
    if (existing !== undefined) return existing
    const events = await loadEvents(ctx, sid)
    const existing2 = state.results.get(key)
    if (existing2 !== undefined) return existing2
    let turnEndTime = null
    for (const event of events) {
      if (event !== null && typeof event === 'object' && event.type === 'turn/end' && event.data !== null && typeof event.data === 'object' && event.data.turn === turn && typeof event.time === 'number') {
        turnEndTime = event.time
        break
      }
    }
    if (turnEndTime !== null && turnEndTime < startedAt) {
      const result = { status: 'none' }
      storeResult(state, key, result)
      return result
    }
    let reasoning = ''
    let tools = []
    let hasFinalMessage = false
    for (const event of events) {
      if (event !== null && typeof event === 'object' && event.type === 'assistant/message' && event.data !== null && typeof event.data === 'object' && event.data.turn === turn && event.data.step === step) {
        hasFinalMessage = true
        reasoning = extractReasoning(event.data.message)
        tools = toolNames(event.data.message)
        break
      }
    }
    if (reasoning !== '') {
      state.results.set(key, 'computing')
      scheduleGeneration(sid, turn, step, reasoning, tools)
      return 'computing'
    }
    const fromChunks = reasoningFromChunks(events, turn, step)
    if (fromChunks.reasoning !== '' && fromChunks.complete) {
      state.results.set(key, 'computing')
      scheduleGeneration(sid, turn, step, fromChunks.reasoning, fromChunks.tools)
      return 'computing'
    }
    if (hasFinalMessage) {
      const result = { status: 'none' }
      storeResult(state, key, result)
      return result
    }
    return null
  }

  ctx.on('session/event', (session, event) => {
    if (session === null || typeof session !== 'object') return
    const sid = String(session.id)
    if (!watched.has(sid)) return
    if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') return
    const state = stateFor(states, sid)
    if (event.type === 'step/start') {
      state.current = { turn: event.data.turn, step: event.data.step }
      return
    }
    if (event.type === 'turn/end') {
      state.current = null
      state.latestPlan = null
      return
    }
    if (event.type === 'assistant/chunk') {
      const turn = event.data.turn
      const step = event.data.step
      const key = `${turn}#${step}`
      if (state.results.has(key)) return
      const chunk = event.data.chunk
      if (chunk === null || typeof chunk !== 'object') return
      let entry = state.chunkAcc.get(key)
      if (entry === undefined) {
        if (chunk.type !== 'reasoning-delta' && !(chunk.type === 'block-end' && chunk.block?.type === 'reasoning')) return
        entry = { reasoning: '', tools: [], started: false, triggered: false }
        state.chunkAcc.set(key, entry)
        while (state.chunkAcc.size > CHUNK_ACC_LIMIT) {
          const oldest = state.chunkAcc.keys().next().value
          state.chunkAcc.delete(oldest)
        }
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        entry.reasoning += chunk.text
        entry.started = true
        return
      }
      if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string') {
        entry.reasoning = chunk.block.text
        entry.started = true
        if (!entry.triggered && entry.reasoning.trim() !== '') {
          entry.triggered = true
          state.results.set(key, 'computing')
          scheduleGeneration(sid, turn, step, entry.reasoning.trim(), entry.tools)
        }
        return
      }
      if (chunk.type === 'tool-call-delta') {
        if (typeof chunk.name === 'string' && entry.tools.indexOf(chunk.name) === -1) entry.tools.push(chunk.name)
        if (entry.started && !entry.triggered && entry.reasoning.trim() !== '') {
          entry.triggered = true
          state.results.set(key, 'computing')
          scheduleGeneration(sid, turn, step, entry.reasoning.trim(), entry.tools)
        }
        return
      }
      if (chunk.type === 'text-delta') {
        if (entry.started && !entry.triggered && entry.reasoning.trim() !== '') {
          entry.triggered = true
          state.results.set(key, 'computing')
          scheduleGeneration(sid, turn, step, entry.reasoning.trim(), entry.tools)
        }
        return
      }
      return
    }
    if (event.type === 'assistant/message') {
      const key = `${event.data.turn}#${event.data.step}`
      state.chunkAcc.delete(key)
      const reasoning = extractReasoning(event.data.message)
      if (reasoning === '') return
      if (state.results.has(key)) return
      state.results.set(key, 'computing')
      scheduleGeneration(sid, event.data.turn, event.data.step, reasoning, toolNames(event.data.message))
    }
  })

  const liveStatus = async (args) => {
    const idle = { working: false, phase: 'idle', toolLabel: null, plan: null }
    if (args === null || typeof args !== 'object') return idle
    const sid = String(args.sessionId || '')
    if (sid === '') return idle
    ensureWatched(sid)
    const state = stateFor(states, sid)
    let events
    try {
      events = await loadEvents(ctx, sid)
    } catch {
      return idle
    }
    let startIndex = -1
    let startSeq = -1
    let endSeq = -1
    let currentTurn = null
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (event === null || typeof event !== 'object') continue
      if (event.type === 'turn/start') {
        startIndex = i
        startSeq = event.seq
        endSeq = -1
        currentTurn = event.data !== null && typeof event.data === 'object' ? event.data.turn : null
      } else if (event.type === 'turn/end') {
        endSeq = event.seq
      }
    }
    if (startIndex === -1 || endSeq > startSeq) return idle
    const finishedCalls = new Set()
    let lastStep = null
    for (let i = startIndex; i < events.length; i++) {
      const event = events[i]
      if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') continue
      if (event.type === 'tool/result') {
        const src = event.data.message !== null && typeof event.data.message === 'object' ? event.data.message.source : null
        if (src !== null && typeof src === 'object' && typeof src.callId === 'string') finishedCalls.add(src.callId)
      } else if (event.type === 'step/start') {
        lastStep = { turn: event.data.turn, step: event.data.step }
      }
    }
    let phase = 'thinking'
    let toolName = null
    for (let i = events.length - 1; i >= startIndex; i--) {
      const event = events[i]
      if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') continue
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'reasoning-delta') { phase = 'thinking'; break }
        if (chunk.type === 'text-delta') { phase = 'writing'; break }
        if (chunk.type === 'tool-call-delta') { phase = 'tool'; if (typeof chunk.name === 'string') toolName = chunk.name; break }
        continue
      }
      if (event.type === 'tool/call') {
        if (typeof event.data.callId !== 'string' || !finishedCalls.has(event.data.callId)) {
          phase = 'tool'
          toolName = typeof event.data.name === 'string' ? event.data.name : null
          break
        }
        continue
      }
      if (event.type === 'turn/start' || event.type === 'step/start') { phase = 'thinking'; break }
    }
    if (lastStep !== null && state.results.get(`${lastStep.turn}#${lastStep.step}`) === undefined) {
      try {
        await ensureStepResult(sid, lastStep.turn, lastStep.step)
      } catch { /* 计划缺失时返回 null */ }
    }
    let plan = null
    if (prefs.planSuffix) {
      const latest = state.latestPlan
      plan = latest !== null && latest.turn === currentTurn && typeof latest.plan === 'string' && latest.plan !== '' ? latest.plan : null
    }
    return { working: true, phase, toolLabel: phase === 'tool' ? toolLabel(toolName) : null, plan }
  }

  const stepSummary = async (args) => {
    if (args === null || typeof args !== 'object') return { status: 'error', message: '参数无效' }
    const sid = String(args.sessionId || '')
    const turn = typeof args.turn === 'number' ? args.turn : Number(args.turn)
    const step = typeof args.step === 'number' ? args.step : Number(args.step)
    if (sid === '' || !Number.isFinite(turn) || !Number.isFinite(step)) return { status: 'error', message: '参数无效' }
    ensureWatched(sid)
    let ensured
    try {
      ensured = await ensureStepResult(sid, turn, step)
    } catch (error) {
      return { status: 'error', message: String(error && error.message ? error.message : error) }
    }
    if (ensured === null) return { status: 'pending' }
    if (ensured === 'computing') return { status: 'computing' }
    if (ensured.status === 'ok') return ensured
    if (ensured.status === 'error') return { status: 'error', message: ensured.message || null }
    return { status: 'none' }
  }

  const settingsGet = () => {
    const descriptor = settingsService?.describe({ redactSecrets: true }).find((row) => row.ns === settingsId)
    return { value: { planSuffix: prefs.planSuffix, flowCards: prefs.flowCards, planMaxChars: prefs.planMaxChars, providerId: prefs.providerId, modelId: prefs.modelId, maxOutputTokens: prefs.maxOutputTokens, maxAttempts: prefs.maxAttempts }, revision: descriptor?.revision ?? 0, reasoningPolicy: 'auto' }
  }
  const settingsUpdate = async (args) => {
    if (settingsService === null) throw new Error('设置服务未挂载')
    const patch = args && typeof args === 'object' && args.patch !== null && typeof args.patch === 'object' && !Array.isArray(args.patch) ? args.patch : null
    if (patch === null) throw new Error('patch 必须是普通对象')
    const allowed = new Set(['planSuffix', 'flowCards', 'planMaxChars', 'providerId', 'modelId', 'maxOutputTokens', 'maxAttempts'])
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('不允许修改设置：' + key)
    for (const key of ['providerId', 'modelId']) if (key in patch && (typeof patch[key] !== 'string' || patch[key].length > 300)) throw new Error(key + ' 必须是有效的模型标识')
    for (const [key, min, max] of [['maxOutputTokens', 64, 8192], ['maxAttempts', 1, 5], ['planMaxChars', 12, 48]]) if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < min || patch[key] > max)) throw new Error(key + ' 必须是 ' + min + '–' + max + ' 的整数')
    await settingsService.update(settingsId, patch, args?.expectedRevision)
    return settingsGet()
  }

  // Return only public catalog labels/IDs, never provider configuration or keys.
  const providersList = () => ({ providers: ctx.llm.listProviders().map((p) => ({ id: p.id, name: typeof (p.name ?? p.label) === 'string' ? p.name ?? p.label : p.id })) })
  const modelsList = async (args) => {
    const provider = args?.providerId
    if (typeof provider !== 'string' || !ctx.llm.listProviders().some((p) => p.id === provider)) throw new Error('请选择有效的提供商')
    return { models: (await ctx.llm.listModels(provider)).map((m) => ({ id: m.id, name: typeof (m.name ?? m.label) === 'string' ? m.name ?? m.label : m.id })) }
  }
  const currentModel = async () => {
    try {
      const target = await resolveTarget(ctx, prefs)
      const modelInfo = await ctx.llm.resolveModelInfo(target.provider, target.model)
      const off = supportsOff(modelInfo)
      return { status: 'ok', ...target, reasoningPolicy: off ? 'off' : 'provider-default',
        reasoningEffort: off ? 'off' : modelInfo.reasoning?.defaultEffort ?? null,
        maxOutputTokens: prefs.maxOutputTokens, maxAttempts: prefs.maxAttempts }
    }
    catch (error) { return { status: 'error', message: error.message } }
  }

  // /thinking-summary/api/* 路由（客户端 fetch 调用）
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/thinking-summary/api',
      handler: async (req, res) => {
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
        // 同源防护：拒绝跨站请求
        const origin = req.headers.origin
        const host = req.headers.host
        if (typeof origin === 'string' && origin !== '' && origin !== 'null' && typeof host === 'string' && !origin.endsWith(`//${host}`)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const prefix = '/thinking-summary/api/'
        const method = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
        const handlers = {
          'live-status': liveStatus,
          'step-summary': stepSummary,
          'settings.get': settingsGet,
          'settings.update': settingsUpdate,
          'providers.list': providersList,
          'models.list': modelsList,
          'model.current': currentModel,
        }
        const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined
        if (handler === undefined) { writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知方法 "${method}"` } }); return }
        try {
          const payload = await readJsonBody(req)
          writeJson(res, 200, { ok: true, value: await handler(payload) })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    }), 'dsh-thinking-summary: /thinking-summary/api routes')
  } else {
    ctx.logger?.warn('[dsh-thinking-summary] webServer 服务不可用，客户端接口未注册')
  }
}
