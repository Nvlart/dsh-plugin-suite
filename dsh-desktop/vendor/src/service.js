import {traceStage,traceSync,traceAsync} from './stage-diagnostics.js';
/**
 * Task service: admission control, the one-at-a-time queue, and status/result
 * reads. This is the whole host-side surface; it knows nothing about HTTP or MCP.
 *
 * Two invariants shape everything here:
 *   - admission is synchronous, so concurrent callers cannot both pass it;
 *   - a dispatch the host did not confirm puts the whole queue in quarantine,
 *     because the next task must not start while the previous one may still run.
 */
import { BridgeError, toBridgeError } from './errors.js'
import { Policy } from './policy.js'
import { TERMINAL, TaskRegistry } from './registry.js'

function clip(text, max) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

function describeDuplicate(reason) {
  if (reason === 'idempotency_key') return 'this idempotency key already owns a task'
  if (reason === 'unconfirmed_outcome') {
    return 'an earlier attempt with the same prompt ended with an unconfirmed outcome; it may still be running. Read it with get_status, or resend with repeat=true to start a separate run'
  }
  return 'identical task already accepted'
}

export class BridgeService {
  #driver
  #registry
  #policy
  #config
  #now
  #pumping = null
  /** This process's start time; the task table, idempotency index and quarantine live only after it. */
  #startedAt
  #coldStart = true
  /** {taskId, sessionId, since, reason} while a dispatch outcome is unconfirmed. */
  #quarantine = null

  constructor({ driver, registry, policy, config, now }) {
    this.#driver = driver
    this.#registry = registry ?? new TaskRegistry({ maxQueued: config.maxQueued, maxTasks: config.maxTasks, now })
    this.#policy = policy ?? new Policy(config)
    this.#config = config
    this.#now = now ?? (() => Date.now())
    this.#startedAt = this.#now()
  }

  get registry() { return this.#registry }
  get driver() { return this.#driver }
  get quarantine() { return this.#quarantine ? { ...this.#quarantine } : null }

  /**
   * Admit a task and return as soon as it is accepted, not finished.
   *
   * Everything from the duplicate checks to the reservation runs without an
   * await, so two identical calls arriving together cannot both get through:
   * the second one sees the first one's claim.
   */
  async sendTask({ prompt, workspace, preset, title, idempotencyKey, repeat = false } = {}) {
    const text = traceSync('service.prompt',()=>this.#policy.prompt(prompt))
    const workspacePath = traceSync('service.workspace',()=>this.#policy.workspace(workspace))
    const presetId = traceSync('service.preset',()=>this.#policy.preset(preset))

    const fields = { prompt: text, workspace: workspacePath, preset: presetId, idempotencyKey }
    // Read-only duplicate answer first: a resend of work already accepted gets
    // its task back even while a quarantine stands, because it starts nothing.
    const existing = traceSync('service.lookup',()=>this.#registry.lookup({ ...fields, repeat }))
    if (existing) return { task: this.#view(existing.task), duplicate: true, reason: describeDuplicate(existing.reason) }

    // Refusals come before any reservation exists, so a refused request leaves
    // no task behind and touches no prompt claim.
    if (this.#quarantine) {
      throw new BridgeError(
        'QUARANTINE_ACTIVE',
        'an earlier task (' + this.#quarantine.taskId + ') was dispatched without a confirmed outcome and may still be running, so no new task is started; an operator must acknowledge it on the control channel first',
        { retryable: false, details: { ...this.#quarantine, acknowledge: 'POST /bridge/v1/acknowledge {task_id}' } },
      )
    }
    if (this.#registry.pendingCount() >= this.#config.maxQueued) {
      throw new BridgeError('QUEUE_FULL', 'the queue already holds ' + this.#config.maxQueued + ' tasks', { retryable: true })
    }

    const reserved = traceSync('service.reserve',()=>this.#registry.reserve({ ...fields, title, repeat }))
    if (reserved.duplicate) {
      // only reachable if another call admitted the same work one tick earlier
      return { task: this.#view(reserved.task), duplicate: true, reason: describeDuplicate(reserved.reason) }
    }
    const task = reserved.task
    this.#coldStart = false

    let sessionId
    try {
      ({ sessionId } = await traceAsync('service.createSession',()=>this.#driver.createSession({ workspacePath, preset: presetId, title })))
    } catch (error) {
      this.#registry.release(task.id)
      throw error
    }
    traceSync('service.attach',()=>this.#registry.attach(task.id, sessionId))
    // Start the queue — but never make this admission wait on another task's
    // dispatch. Otherwise a task queued behind a slow or hanging dispatch
    // would not even get its identifiers back until that dispatch settled.
    if (this.#pumping) void this.#pump()
    else await traceAsync('service.pump',()=>this.#pump())
    return traceSync('service.project',()=>({ task: this.#view(this.#registry.get(task.id) ?? task), duplicate: false }))
  }

  /** Start the next queued task when nothing is running. Serialized. */
  #pump() {
    if (this.#pumping) return this.#pumping
    const run = (async () => {
      for (;;) {
        // quarantine is checked every round: a dispatch that ends unconfirmed
        // must not be followed by the next task, even in the same drain loop
        if (this.#quarantine) return
        const task = this.#registry.claimNext()
        if (!task) return
        const attemptedAt = this.#now()
        try {
          await traceAsync('service.dispatch',()=>this.#driver.dispatch(task.sessionId, task.prompt, (evidence) => {
            this.#registry.observe(task.id, { ...task.detail, dispatchMessageId: evidence.messageId })
          }))
          this.#registry.observe(task.id, { ...task.detail, phase: 'dispatched', dispatchedAt: this.#now(), dispatchAttemptedAt: attemptedAt })
          return
        } catch (error) {
          const failure = toBridgeError(error)
          if (failure.effect === 'none' && failure.retryable && task.attempts < 2) {
            this.#registry.requeue(task.id, { phase: 'retrying', lastError: failure.toJSON() })
            continue
          }
          if (failure.effect === 'none') {
            this.#registry.finish(task.id, 'failed', { failure: failure.toJSON() })
            continue
          }
          const detail = {
            ...task.detail,
            phase: 'dispatch',
            dispatchAttemptedAt: attemptedAt,
            note: 'the host did not confirm whether it accepted the message; this task is not retried automatically',
          }
          this.#registry.finish(task.id, 'unknown', { failure: failure.toJSON(), detail })
          this.#enterQuarantine(task, 'the dispatch outcome could not be confirmed')
          return
        }
      }
    })()
    // clear only after this promise settles: a drain that finishes without
    // await must not leave a resolved promise latched as the in-flight one
    run.then(
      () => { if (this.#pumping === run) this.#pumping = null },
      () => { if (this.#pumping === run) this.#pumping = null },
    )
    this.#pumping = run
    return run
  }

  #enterQuarantine(task, reason) {
    this.#quarantine = {
      taskId: task.id,
      sessionId: task.sessionId,
      since: this.#now(),
      reason,
    }
  }

  #releaseQuarantine(note) {
    const previous = this.#quarantine
    this.#quarantine = null
    if (previous) {
      this.#registry.observe(previous.taskId, {
        ...(this.#registry.get(previous.taskId)?.detail ?? {}),
        quarantine: { releasedAt: this.#now(), note },
      })
    }
    return previous
  }

  /**
   * Operator acknowledgement of an unconfirmed dispatch. It does not decide
   * what happened to the work: the task stays 'unknown' and keeps its claim on
   * the prompt. It only lifts the block on the queue, and only for the exact
   * task that caused it.
   */
  acknowledgeUncertain(taskId, { note } = {}) {
    if (!this.#quarantine) throw new BridgeError('QUARANTINE_NOT_ACTIVE', 'no task is waiting for an acknowledgement', { retryable: false })
    if (taskId !== this.#quarantine.taskId) {
      throw new BridgeError('QUARANTINE_TASK_MISMATCH', 'the standing quarantine belongs to ' + this.#quarantine.taskId + ', not ' + taskId, {
        retryable: false,
        details: { taskId: this.#quarantine.taskId },
      })
    }
    const released = this.#releaseQuarantine('acknowledged by the operator' + (note ? ': ' + note : ''))
    void this.#pump()
    return { quarantine: released, health: this.health() }
  }

  async getStatus(taskId) {
    let task = this.#registry.get(taskId)
    if (!task) throw new BridgeError('TASK_NOT_FOUND', 'no task with this identifier is known to the bridge')
    if (TERMINAL.has(task.state)) {
      // An 'unknown' verdict is provisional for every task that holds one, not
      // only for the task currently blocking the queue: the host log is the
      // evidence, and it may settle long after the quarantine was lifted.
      if (task.state === 'unknown') {
        const settled = await this.#recheckUnknown(task)
        if (settled) return settled
      }
      return this.#view(task)
    }

    if (task.state === 'queued' || task.state === 'admitting') {
      await this.#pump()
      task = this.#registry.get(taskId)
      if (!task) throw new BridgeError('TASK_NOT_FOUND', 'no task with this identifier is known to the bridge')
      if (task.state === 'queued' || task.state === 'admitting') return this.#view(task)
    }

    const snapshot = await this.#driver.snapshot(task.sessionId)
    const analysis = this.#driver.analyze(snapshot)
    return this.#settle(task, snapshot, analysis)
  }

  /**
   * Re-read a session whose earlier dispatch was unconfirmed. Null if the log
   * still does not prove what happened.
   *
   * Only a turn this task could have caused counts: a turn that ended before
   * the dispatch was attempted, or a turn other than the one this task was
   * watching, belongs to something else and is ignored.
   */
  async #recheckUnknown(task) {
    if (!task.sessionId) return null
    let snapshot
    try {
      snapshot = await this.#driver.snapshot(task.sessionId)
    } catch {
      return null
    }
    const analysis = this.#driver.analyze(snapshot)
    if (analysis.state !== 'completed' && analysis.state !== 'failed') return null
    if (!this.#evidenceBelongsTo(task, analysis, snapshot)) return null
    const settled = this.#registry.settleUnknown(task.id, analysis.state, {
      failure: analysis.failure,
      warning: analysis.warning,
      detail: { logSource: snapshot.source, confirmedBy: 'host log', turn: analysis.turn },
    })
    // lifting the block is a separate act from settling the task, and only
    // this task's own quarantine may be lifted here
    if (this.#quarantine?.taskId === task.id) {
      this.#releaseQuarantine('the host log showed a settled turn')
      void this.#pump()
    }
    return this.#view(settled, { confidence: 'observed' })
  }

  /** Does the settled turn in this log belong to this task? */
  #evidenceBelongsTo(task, analysis, snapshot) {
    const ended = analysis.lastTurnEnd
    const messageId = task.detail?.dispatchMessageId
    if (!ended || typeof messageId !== 'string' || !messageId) return false
    const watched = task.detail?.turn
    if (watched != null && ended.turn !== watched) return false
    const events = snapshot.events ?? []
    const end = events.filter((event) => event.type === 'turn/end').at(-1)
    // DSH stores UserMessage directly; older adapters wrap it with a turn.
    const payload = (event) => event.data?.message ?? event.data
    const messages = events.filter((event) => event.type === 'user/message' && payload(event)?.id === messageId)
    if (!end || messages.length !== 1) return false
    const message = messages[0]
    const messageIndex = events.indexOf(message), endIndex = events.indexOf(end)
    const start = events.slice(0, messageIndex).filter((event) => event.type === 'turn/start').at(-1)
    if (!start || !Number.isSafeInteger(start.data?.turn) || start.data.turn !== ended.turn) return false
    if (message.data?.turn != null && message.data.turn !== ended.turn) return false
    const native = (event) => Number.isSafeInteger(event.nativeSeq) && event.nativeSeq >= 0
    if (!native(start) || !native(message) || !native(end) ||
        start.nativeSeq >= message.nativeSeq || message.nativeSeq >= end.nativeSeq || messageIndex >= endIndex) return false
    if (events.slice(messageIndex + 1, endIndex).some((event) => event.type === 'turn/start' || event.type === 'turn/end')) return false
    // Runtime context injections may share the turn; another human input may not.
    if (events.slice(events.indexOf(start) + 1, endIndex).some((event) =>
      event.type === 'user/message' && event !== message && payload(event)?.source?.kind !== 'runtime-context')) return false
    const attemptedAt = task.detail?.dispatchAttemptedAt
    if (typeof end.time === 'number' && Number.isFinite(attemptedAt) && end.time < attemptedAt) return false
    return true
  }

  #settle(task, snapshot, analysis) {
    const staleness = analysis.lastActivityAt ? this.#now() - analysis.lastActivityAt : null
    const detail = {
      ...task.detail,
      turn: analysis.turn,
      turnOpen: analysis.turnOpen,
      pendingToolCall: analysis.pendingCalls[0]
        ? { name: analysis.pendingCalls[0].name, callId: analysis.pendingCalls[0].callId }
        : null,
      pendingToolCalls: analysis.pendingCalls.length,
      idleMs: staleness,
      logSource: snapshot.source,
      live: snapshot.live,
    }

    if (analysis.state === 'completed') {
      const finished = this.#registry.finish(task.id, 'completed', { warning: analysis.warning, detail })
      void this.#pump()
      return this.#view(finished, { warning: analysis.warning })
    }
    if (analysis.state === 'failed') {
      const finished = this.#registry.finish(task.id, 'failed', { failure: analysis.failure, detail })
      void this.#pump()
      return this.#view(finished)
    }
    if (analysis.state === 'unknown' && !analysis.turnOpen && analysis.lastTurnEnd) {
      // the host closed the turn with a reason this bridge cannot classify:
      // report it as unknown rather than inventing a verdict
      const finished = this.#registry.finish(task.id, 'unknown', { detail, failure: analysis.failure })
      void this.#pump()
      return this.#view(finished)
    }
    if (!snapshot.live && analysis.eventCount === 0) {
      this.#registry.observe(task.id, detail)
      return this.#view(task, { state: 'unknown', confidence: 'none', note: 'the session is not live and no log is readable; the state is unconfirmed' })
    }

    if (analysis.state === 'approval_required') {
      const ask = analysis.pendingApprovals[0]
      this.#registry.observe(task.id, { ...detail, pendingApproval: ask })
      return this.#view(task, {
        state: 'approval_required',
        confidence: 'observed',
        note: 'the host logged an undecided approval request for tool ' + (ask?.toolName ?? 'unknown'),
      })
    }

    const approval = analysis.approvalEvents === 0 ? this.#mayAwaitApproval(snapshot, analysis, task, staleness) : null
    this.#registry.observe(task.id, detail)
    if (approval) return this.#view(task, { state: 'approval_required', confidence: 'inferred', note: approval })
    return this.#view(task, {})
  }

  /**
   * Fallback only, for logs that carry no approval events at all: a live turn,
   * a tool call with no result, and no log activity for the grace period.
   * When the host does log approval/asked this never runs, because that is
   * evidence rather than a guess.
   */
  #mayAwaitApproval(snapshot, analysis, task, idleMs) {
    if (!snapshot.live || snapshot.agentStatus !== 'running') return null
    if (analysis.pendingCalls.length === 0) return null
    if (idleMs === null || idleMs < this.#config.approvalInferenceMs) return null
    const call = analysis.pendingCalls[0]
    return 'tool ' + call.name + ' has no result after ' + Math.round(idleMs) + 'ms of log silence; an approval prompt would look like this'
  }

  async getResult(taskId) {
    const task = this.#registry.get(taskId)
    if (!task) throw new BridgeError('TASK_NOT_FOUND', 'no task with this identifier is known to the bridge')
    if (task.state === 'queued' || task.state === 'running' || task.state === 'admitting') {
      throw new BridgeError('RESULT_NOT_READY', 'the task has not finished; its state is ' + this.#publicState(task), { retryable: true, details: { state: this.#publicState(task) } })
    }
    if (task.state !== 'completed') {
      throw new BridgeError('RESULT_UNAVAILABLE', 'the task ended as ' + task.state + ' and has no successful result', {
        details: { state: task.state, failure: task.failure ?? null },
      })
    }

    const snapshot = await this.#driver.snapshot(task.sessionId)
    const message = this.#driver.finalMessage(snapshot)
    const changes = await this.#driver.changes(task.sessionId, snapshot)
    const presented = this.#driver.deliverables(snapshot)
    const clipped = clip(message.text, this.#config.maxResultChars)
    return {
      taskId: task.id,
      sessionId: task.sessionId,
      state: 'completed',
      completedAt: task.finishedAt,
      finalMessage: clipped.text,
      finalMessageTruncated: clipped.truncated || message.truncated,
      finalMessageTurn: message.turn ?? null,
      changedFiles: changes,
      deliverables: presented,
      diagnostics: {
        logSource: snapshot.source,
        events: snapshot.events.length,
        warning: task.warning ?? null,
      },
    }
  }

  /** 'admitting' is an internal state; a caller never sees it as anything but queued. */
  #publicState(task) {
    return task.state === 'admitting' ? 'queued' : task.state
  }

  /** Public projection of a task. Never includes the prompt text. */
  #view(task, extra = {}) {
    return {
      taskId: task.id,
      sessionId: task.sessionId ?? null,
      state: this.#publicState(task),
      acceptedAt: task.acceptedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      workspace: task.workspace,
      preset: task.preset ?? null,
      queuedAhead: task.state === 'queued' ? Math.max(0, this.#registry.list().filter((other) => other.state === 'queued' && other.acceptedAt < task.acceptedAt).length) : 0,
      attempt: task.attempts ?? 0,
      detail: task.detail ?? null,
      failure: task.failure ?? null,
      warning: task.warning ?? null,
      ...(this.#quarantine ? { quarantine: { taskId: this.#quarantine.taskId, since: this.#quarantine.since, mine: this.#quarantine.taskId === task.id } } : {}),
      ...extra,
    }
  }

  health() {
    return {
      ok: true,
      running: this.#registry.runningId,
      queued: this.#registry.pendingCount(),
      tasks: this.#registry.list().length,
      quarantine: this.#quarantine ? { ...this.#quarantine } : null,
      // Everything the bridge knows is in memory. A restart loses the task
      // table, the prompt/idempotency index and any quarantine, so the
      // single-task guarantee holds only inside one process lifetime.
      startedAt: this.#startedAt,
      coldStart: this.#coldStart,
      observedAt: this.#now(),
    }
  }
}
