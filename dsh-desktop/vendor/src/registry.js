/** In-memory task bookkeeping: one running task, a bounded queue, no disk. */
import { createHash, randomBytes } from 'node:crypto'
import { BridgeError } from './errors.js'

export const TERMINAL = new Set(['completed', 'failed', 'unknown'])

/** States whose outcome the bridge cannot rule out; never evicted, never reused. */
const UNSETTLED = new Set(['admitting', 'queued', 'running', 'unknown'])

function identifier() {
  return 'task_' + randomBytes(16).toString('base64url')
}

export class TaskRegistry {
  #tasks = new Map()
  #queue = []
  #running = null
  // fingerprint -> every task that made the same claim. A second task with the
  // same prompt (repeat:true) must not overwrite the first one's claim: that
  // first task may still be unconfirmed, and dropping its id would let an
  // ordinary resend start a third run without anyone repeating the order.
  #prompts = new Map()
  #idempotency = new Map()
  #maxQueued
  #maxTasks
  #now

  constructor({ maxQueued = 4, maxTasks = 200, now } = {}) {
    this.#maxQueued = maxQueued
    this.#maxTasks = maxTasks
    this.#now = now ?? (() => Date.now())
  }

  static fingerprint({ prompt, workspace, preset }) {
    return createHash('sha256').update([prompt, workspace ?? '', preset ?? ''].join('\u0000')).digest('hex')
  }

  /**
   * An unsettled task with identical content, if one exists.
   *
   * Every holder of the claim is examined, not just the newest one: a later
   * repeat:true task may have finished or been released while an older attempt
   * is still 'unknown'. 'unknown' keeps its claim; completed and failed do not.
   */
  findDuplicate(fields) {
    const fingerprint = TaskRegistry.fingerprint(fields)
    const holders = this.#prompts.get(fingerprint)
    if (!holders) return null
    let found = null
    for (const id of [...holders]) {
      const task = this.#tasks.get(id)
      if (!task || !UNSETTLED.has(task.state)) {
        holders.delete(id)
        continue
      }
      if (!found) found = task
    }
    if (holders.size === 0) this.#prompts.delete(fingerprint)
    return found
  }

  byIdempotencyKey(key) {
    if (!key) return null
    const id = this.#idempotency.get(key)
    return id ? this.#tasks.get(id) ?? null : null
  }

  /**
   * Admission in one synchronous step: idempotency, prompt fingerprint,
   * capacity and insertion happen with no await in between, so two concurrent
   * send_task calls cannot both pass the checks and create two tasks.
   *
   * Returns {task, duplicate, reason}; a duplicate is the task that already
   * owns that key or prompt, never a new one.
   */
  reserve({ prompt, workspace, preset, idempotencyKey, title, repeat = false } = {}) {
    const existing = this.lookup({ prompt, workspace, preset, idempotencyKey, repeat })
    if (existing) return { task: existing.task, duplicate: true, reason: existing.reason }
    const task = this.#create({ prompt, workspace, preset, idempotencyKey, title }, 'admitting')
    return { task, duplicate: false, reason: null }
  }

  /**
   * The same duplicate checks without changing anything.
   *
   * Admission uses this first so a request that will be refused (a standing
   * quarantine, a full queue) never inserts a reservation or touches a claim.
   */
  lookup({ prompt, workspace, preset, idempotencyKey, repeat = false } = {}) {
    const keyed = this.byIdempotencyKey(idempotencyKey)
    if (keyed) return { task: keyed, reason: 'idempotency_key' }
    if (repeat) return null
    const existing = this.findDuplicate({ prompt, workspace, preset })
    if (!existing) return null
    return { task: existing, reason: existing.state === 'unknown' ? 'unconfirmed_outcome' : 'identical_prompt' }
  }

  /** The session now exists: the task becomes claimable. */
  attach(id, sessionId) {
    const task = this.#tasks.get(id)
    if (!task) throw new BridgeError('TASK_NOT_FOUND', 'no such reservation: ' + id)
    task.sessionId = sessionId
    task.state = 'queued'
    if (!this.#queue.includes(id)) this.#queue.push(id)
    return task
  }

  /** Drop a reservation whose session could not be created. Nothing ran. */
  release(id) {
    const task = this.#tasks.get(id)
    if (!task) return null
    this.#forget(task)
    this.#tasks.delete(id)
    if (this.#running === id) this.#running = null
    this.#queue = this.#queue.filter((entry) => entry !== id)
    return task
  }

  /** Legacy direct insert used by the unit tests: no dedupe check, queued at once. */
  add({ prompt, sessionId, workspace, preset, idempotencyKey, title }) {
    const task = this.#create({ prompt, workspace, preset, idempotencyKey, title }, 'queued')
    task.sessionId = sessionId ?? null
    this.#queue.push(task.id)
    return task
  }

  get(id) {
    if (typeof id !== 'string' || !id) return null
    return this.#tasks.get(id) ?? null
  }

  list() {
    return [...this.#tasks.values()]
  }

  get runningId() { return this.#running }

  /** Take the next queued task when the slot is free; null otherwise. */
  claimNext() {
    if (this.#running) return null
    while (this.#queue.length > 0) {
      const id = this.#queue.shift()
      const task = this.#tasks.get(id)
      if (!task || task.state !== 'queued') continue
      task.state = 'running'
      task.startedAt = this.#now()
      task.attempts += 1
      this.#running = id
      return task
    }
    return null
  }

  /** Put a task back in line without losing its place at the head. */
  requeue(id, note) {
    const task = this.#tasks.get(id)
    if (!task || TERMINAL.has(task.state)) return task ?? null
    task.state = 'queued'
    if (note) task.detail = note
    if (this.#running === id) this.#running = null
    if (!this.#queue.includes(id)) this.#queue.unshift(id)
    return task
  }

  /** Record an observation without changing state. */
  observe(id, detail) {
    const task = this.#tasks.get(id)
    if (!task) return null
    task.detail = detail
    return task
  }

  finish(id, state, { failure, warning, detail } = {}) {
    const task = this.#tasks.get(id)
    if (!task) throw new BridgeError('TASK_NOT_FOUND', 'no such task: ' + id)
    if (TERMINAL.has(task.state)) return task
    task.state = state
    task.finishedAt = this.#now()
    task.failure = failure ?? null
    task.warning = warning
    task.detail = detail ?? task.detail
    if (this.#running === id) this.#running = null
    // only this task's own claim is released; an older identical prompt that
    // is still unsettled keeps its holder entry
    if (state !== 'unknown') this.#dropClaim(task)
    return task
  }

  /**
   * Replace an 'unknown' verdict with a state the host itself later confirmed.
   * Only that one transition is allowed, and only from 'unknown'.
   */
  settleUnknown(id, state, { failure, warning, detail } = {}) {
    const task = this.#tasks.get(id)
    if (!task) return null
    if (task.state !== 'unknown') return task
    if (state !== 'completed' && state !== 'failed') return task
    task.state = state
    task.finishedAt = this.#now()
    task.failure = failure ?? null
    task.warning = warning
    task.detail = { ...(task.detail ?? {}), ...(detail ?? {}), settledFrom: 'unknown' }
    // the outcome is confirmed now, so this task no longer claims the prompt
    this.#dropClaim(task)
    return task
  }

  pendingCount() { return this.#queue.length }

  #create({ prompt, workspace, preset, idempotencyKey, title }, state) {
    this.#makeRoom()
    const task = {
      id: identifier(),
      // held in memory only; the public projection never exposes it
      prompt,
      sessionId: null,
      workspace,
      preset,
      promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      promptChars: prompt.length,
      title: title ?? null,
      state,
      acceptedAt: this.#now(),
      startedAt: null,
      finishedAt: null,
      detail: null,
      failure: null,
      warning: undefined,
      attempts: 0,
    }
    this.#tasks.set(task.id, task)
    const fingerprint = TaskRegistry.fingerprint({ prompt, workspace, preset })
    const holders = this.#prompts.get(fingerprint) ?? new Set()
    holders.add(task.id)
    this.#prompts.set(fingerprint, holders)
    if (idempotencyKey) this.#idempotency.set(idempotencyKey, task.id)
    return task
  }

  /**
   * Make room for one more task, or refuse.
   *
   * Only a task with a confirmed outcome may be forgotten. An 'unknown' task
   * may still be running, and dropping it would also drop the dedupe claim
   * that keeps an identical prompt from starting a second run, so capacity
   * pressure is answered with an error rather than with silence.
   */
  #makeRoom() {
    if (this.#tasks.size < this.#maxTasks) return
    for (const task of [...this.#tasks.values()]) {
      if (UNSETTLED.has(task.state)) continue
      this.#forget(task)
      this.#tasks.delete(task.id)
      if (this.#tasks.size < this.#maxTasks) return
    }
    const unsettled = [...this.#tasks.values()].filter((task) => UNSETTLED.has(task.state)).length
    throw new BridgeError(
      'TASK_REGISTRY_FULL',
      'the task table holds ' + this.#tasks.size + ' of ' + this.#maxTasks + ' tasks and ' + unsettled + ' of them have an unsettled outcome; nothing was evicted, so no new task is accepted',
      { details: { maxTasks: this.#maxTasks, tasks: this.#tasks.size, unsettled } },
    )
  }

  /** Drop this task's prompt claim, leaving other holders of the same claim. */
  #dropClaim(task) {
    for (const [fingerprint, holders] of this.#prompts) {
      holders.delete(task.id)
      if (holders.size === 0) this.#prompts.delete(fingerprint)
    }
  }

  /** Drop every lookup entry that points at this task, and only this task. */
  #forget(task) {
    this.#dropClaim(task)
    for (const [key, id] of this.#idempotency) {
      if (id === task.id) this.#idempotency.delete(key)
    }
  }
}
