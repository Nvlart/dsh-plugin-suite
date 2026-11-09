import {traceStage,traceSync,traceAsync} from './stage-diagnostics.js';
/**
 * Native-session driver for DSH 0.2.2-rc.1.
 *
 * Everything here goes through documented host services (agents,
 * sessionPersistence, workspaceRegistry, workspaceChanges). Nothing is read
 * from the filesystem, and no session is ever resumed or re-run implicitly.
 */
import { randomUUID } from 'node:crypto'
import { BridgeError } from './errors.js'
import { loadDshModules } from './dsh-modules.js'

const IDLE = 'idle'
const RUNNING = 'running'

/** TurnEndReason.kind values, mapped to the statuses this bridge may report. */
function classifyTurnEnd(reason) {
  const kind = typeof reason === 'string' ? reason : reason && reason.kind
  switch (kind) {
    case 'completed': return { state: 'completed' }
    case 'max-tokens': return { state: 'completed', warning: 'max-tokens' }
    case 'error': return { state: 'failed', failure: { kind: 'error', error: reason && reason.error } }
    case 'aborted': return { state: 'failed', failure: { kind: 'aborted', cause: reason && reason.reason } }
    case 'blocked': return { state: 'failed', failure: { kind: 'blocked' } }
    default: return { state: 'unknown', failure: { kind: kind === undefined ? 'unclassifiable' : kind } }
  }
}

function eventTime(event) {
  const raw = event && (event.time ?? event.at ?? event.timestamp ?? event.createdAt)
  // Host numeric times are Unix milliseconds. Never guess seconds or coerce strings.
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 100_000_000_000 && raw <= 8_640_000_000_000_000 ? raw : undefined
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Accept the several shapes a session log arrives in and return {seq,type,data}. */
export function normalizeEvents(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.events) ? raw.events : []
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const source = entry.event && entry.event.type ? entry.event : entry
    if (typeof source.type !== 'string') continue
    out.push({
      seq: Number.isFinite(Number(source.seq)) ? Number(source.seq) : out.length,
      // Only the host's original integer sequence may prove event ordering.
      nativeSeq: source.nativeSeq === null ? null : Number.isSafeInteger(source.seq) && source.seq >= 0 ? source.seq : null,
      type: source.type,
      data: source.data ?? {},
      time: eventTime(source),
    })
  }
  return out
}

function textOfMessage(message) {
  if (!message) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

export class SessionDriver {
  #ctx
  #config
  #modules
  #now

  constructor({ ctx, config, modules, now }) {
    this.#ctx = ctx
    this.#config = config
    this.#modules = modules ?? null
    this.#now = now ?? (() => Date.now())
  }

  get modules() {
    if (!this.#modules) this.#modules = loadDshModules(this.#config.modulesRoot)
    return this.#modules
  }

  #service(name) {
    const value = this.#ctx?.[name]
    if (!value) throw new BridgeError('HOST_SERVICE_MISSING', 'the DSH host does not expose ' + name, { details: { service: name } })
    return value
  }

  /** Cordis optional services do not belong in its required inject list. */
  #optionalService(name) {
    return typeof this.#ctx?.get === 'function' ? this.#ctx.get(name) : this.#ctx?.[name]
  }

  /** Create one native session and leave it idle; no turn runs until dispatch(). */
  async createSession({ workspacePath, workspaceTitle, preset, title } = {}) {
    const { SessionId } = traceSync('driver.modules',()=>this.modules)
    const agents = this.#service('agents')
    const sessionId = traceSync('driver.session.id',()=>SessionId('session-' + randomUUID()))
    const meta = {}
    if (workspacePath) meta.cwd = workspacePath
    if (preset) meta.agentPreset = preset

    let workspace
    if (workspacePath) {
      const registry = traceSync('driver.workspace.access',()=>this.#service('workspaceRegistry'))
      workspace = await traceAsync('driver.workspace.resolve',()=>registry.resolveByPath?.(workspacePath))
      if (!workspace && typeof registry.create === 'function') {
        workspace = await traceAsync('driver.workspace.create',()=>registry.create(workspacePath, workspaceTitle ?? workspacePath))
      }
    }

    // Native factory does not read the host default itself. Match the Web
    // Session Controller's live AgentOptions accessors (not Session metadata).
    const defaults = traceSync('driver.model.selection',()=>this.#service('agentDefaultModel'))
    const agentOptions = {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
    const handle = await traceAsync('driver.agents.create',()=>agents.create({ sessionId, meta, agentOptions,
      setup: async (agentCtx) => {
        this.modules.installModelSelection(agentCtx)
        const presets = agentCtx.get('agentPresets')
        if (preset && !presets) throw new BridgeError('HOST_SERVICE_MISSING', 'agentPresets service is required')
        if (preset) await presets.mount(agentCtx, preset)
      },
    }))
    const agent = handle?.agent ?? handle
    if (!agent || typeof agent.followup !== 'function') {
      throw new BridgeError('HOST_API_MISMATCH', 'agents.create did not return a usable agent handle')
    }
    traceSync('driver.workspace.attach',()=>workspace?.attachSession?.(sessionId))

    if (title && this.#optionalService('sessionTitle')?.rename && agent.session) {
      try { await this.#optionalService('sessionTitle').rename(agent.session, String(title).slice(0, 200)) } catch { /* a title is cosmetic */ }
    }
    return { sessionId: String(sessionId), agent }
  }

  /** Queue the task's single user message onto a live agent. */
  async dispatch(sessionId, prompt, recordEvidence = () => {}) {
    const { SessionId, createUserMessage } = this.modules
    const agents = this.#service('agents')
    const agent = agents.get(SessionId(sessionId))
    if (!agent) throw new BridgeError('SESSION_NOT_LIVE', 'the session is not live in this host', { retryable: true, effect: 'none' })
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    recordEvidence({ messageId: message.id })
    try {
      traceSync('driver.followup',()=>agent.followup(message))
    } catch (error) {
      // followup is not atomic from here: the host may have queued the turn
      // before it failed, so this failure has unknown effect and is never retried
      const cause = error instanceof Error ? error.message : String(error)
      throw new BridgeError('DISPATCH_FAILED', 'the host did not confirm the task message: ' + cause, { effect: 'unknown' })
    }
    return agent
  }

  /** Live agent for a session, when the host still has it loaded. */
  liveAgent(sessionId) {
    try { return this.#ctx?.agents?.get?.(this.modules.SessionId(sessionId)) ?? null } catch { return null }
  }

  async #liveEvents(session) {
    if (!session) return null
    try {
      if (Array.isArray(session.events)) return normalizeEvents(session.events)
      if (typeof session.read === 'function') return normalizeEvents(await session.read())
    } catch { /* fall through to persistence */ }
    return null
  }

  async #persistedEvents(sessionId) {
    const persistence = this.#optionalService('sessionPersistence')
    if (!persistence || typeof persistence.open !== 'function') return null
    let handle
    try {
      handle = await persistence.open(this.modules.SessionId(sessionId), 'read')
      const raw = typeof handle.read === 'function' ? await handle.read() : handle
      return normalizeEvents(raw)
    } catch {
      return null
    } finally {
      try { await handle?.close?.() } catch { /* closing is best effort */ }
    }
  }

  /** One observation of a session: liveness, log, and where the log came from. */
  async snapshot(sessionId) {
    const agent = this.liveAgent(sessionId)
    let events = await this.#liveEvents(agent?.session)
    let source = events ? 'live' : null
    if (!events) {
      events = await this.#persistedEvents(sessionId)
      source = events ? 'persisted' : null
    }
    return {
      live: Boolean(agent),
      agentStatus: agent?.status ?? null,
      agent,
      events: events ?? [],
      source,
      observedAt: this.#now(),
    }
  }

  /** Turn-level reading of a log. Pure: no host calls, no clock. */
  analyze(snapshot) {
    const events = snapshot.events ?? []
    const calls = new Map()
    const results = new Set()
    const asked = new Map()
    const decided = new Set()
    let openTurn = null
    let lastStart = null
    let lastEnd = null
    let approvalEvents = 0
    for (const event of events) {
      const data = event.data ?? {}
      if (event.type === 'turn/start') { openTurn = data.turn; lastStart = event }
      else if (event.type === 'turn/end') { if (openTurn === data.turn) openTurn = null; lastEnd = event }
      else if (event.type === 'tool/call') calls.set(String(data.callId), { name: data.name, turn: data.turn, seq: event.seq, time: event.time })
      else if (event.type === 'tool/result') results.add(String(data.callId))
      else if (event.type === 'approval/asked') {
        approvalEvents += 1
        asked.set(String(data.id), { requestId: String(data.id), toolName: data.toolName ?? null, callId: data.callId ?? null, reason: data.reason ?? null, seq: event.seq, time: event.time })
      } else if (event.type === 'approval/decided') {
        approvalEvents += 1
        decided.add(String(data.id))
      }
    }
    // an ask with no decision is an approval prompt the host is waiting on
    const pendingApprovals = [...asked.values()].filter((ask) => !decided.has(ask.requestId))
    const lastTurn = lastStart ? lastStart.data.turn : null
    const pending = [...calls.entries()]
      .filter(([callId]) => !results.has(callId))
      .map(([callId, call]) => ({ callId, ...call }))
      .filter((call) => call.turn === lastTurn)

    let state = 'queued'
    let failure
    let warning
    if (lastStart) {
      state = 'running'
      if (openTurn !== null && pendingApprovals.length > 0) state = 'approval_required'
      else if (!openTurn && lastEnd) {
        const verdict = classifyTurnEnd(lastEnd.data?.reason)
        state = verdict.state
        failure = verdict.failure
        warning = verdict.warning
      }
    }
    const times = events.map((event) => event.time).filter((value) => value !== undefined)
    return {
      state,
      turn: lastTurn,
      turnOpen: openTurn !== null,
      pendingCalls: pending,
      pendingApprovals,
      approvalEvents,
      lastTurnEnd: lastEnd ? { turn: lastEnd.data?.turn, reason: lastEnd.data?.reason, time: lastEnd.time } : null,
      lastActivityAt: times.length ? Math.max(...times) : undefined,
      failure,
      warning,
      eventCount: events.length,
    }
  }

  /** The agent's final visible reply of the last completed turn. */
  finalMessage(snapshot) {
    const events = snapshot.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'assistant/message') continue
      const text = textOfMessage(event.data?.message)
      if (text.trim()) return { text, turn: event.data?.turn, step: event.data?.step, truncated: false }
    }
    return { text: '', truncated: false }
  }

  /**
   * Files the agent explicitly presented.
   *
   * 'deliverables/presented' proves exactly one thing: the agent named these
   * paths for delivery. The bridge never opens or lists them, so their
   * existence, content and identity stay unverified — hence 'announced', not
   * 'verified'.
   */
  deliverables(snapshot) {
    const events = snapshot.events ?? []
    const files = []
    let turn = null
    for (const event of events) {
      if (event.type !== 'deliverables/presented') continue
      turn = event.data?.turn ?? turn
      for (const file of event.data?.files ?? []) {
        if (!file || typeof file.path !== 'string') continue
        files.push({ path: file.path, ...(typeof file.description === 'string' ? { description: file.description } : {}) })
      }
    }
    return {
      source: 'deliverables/presented',
      announced: files.length > 0,
      verification: files.length > 0 ? 'announced-by-agent' : 'none',
      turn,
      files: files.map((file) => ({ ...file, exists: 'unverified' })),
      note: files.length > 0
        ? 'these paths are what the agent announced; the bridge did not open them, so they are not verified'
        : 'the agent presented no deliverable file for this task',
    }
  }

  /**
   * Change summary announced by the session itself.
   * A summary that cannot be retrieved is reported as unverified rather than
   * reconstructed from the filesystem.
   */
  async changes(sessionId, snapshot) {
    const events = snapshot.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type !== 'workspace/changes') continue
      const inline = event.data?.files ? event.data : event.data?.summary
      if (inline && Array.isArray(inline.files)) {
        return { verified: Boolean(snapshot.live), source: 'workspace/changes', ...shape(inline) }
      }
      const changes = this.#optionalService('workspaceChanges')
      if (changes && typeof changes.summary === 'function') {
        try {
          const summary = await changes.summary(this.modules.SessionId(sessionId), event.seq)
          if (summary && Array.isArray(summary.files)) return { verified: true, source: 'workspaceChanges.summary', ...shape(summary) }
        } catch (error) {
          return { verified: false, source: 'workspaceChanges.summary', files: [], total: 0, note: 'summary unavailable: ' + (error instanceof Error ? error.message : String(error)) }
        }
      }
      return { verified: false, source: 'workspace/changes', files: [], total: 0, note: 'the announcement carried no retrievable file list' }
    }
    return { verified: false, source: 'none', files: [], total: 0, note: 'this session announced no workspace change summary' }
  }
}

function shape(summary) {
  const files = summary.files.map((file) => ({
    path: file.path,
    display: file.display ?? file.path,
    added: file.added ?? 0,
    deleted: file.deleted ?? 0,
    ...(file.binary ? { binary: true } : {}),
    ...(file.oversized ? { oversized: true } : {}),
  }))
  return { files, total: summary.total ?? files.length, added: summary.added ?? 0, deleted: summary.deleted ?? 0 }
}

export const AGENT_STATUS = { IDLE, RUNNING }
