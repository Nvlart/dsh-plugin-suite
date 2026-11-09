import {traceStage,traceSync,traceAsync} from './../stage-diagnostics.js';
/**
 * The MCP endpoint: Streamable HTTP, JSON-RPC 2.0, exactly three tools.
 *
 * Hand-written because @modelcontextprotocol/sdk is not installed here and the
 * installed @modelcontextprotocol/core publishes schemas only. The surface is
 * fixed: no resources, no prompts, no sampling, no dynamic tool registration.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { BridgeError } from '../errors.js'

// The one revision this endpoint implements end to end. 2025-03-26 also
// defines JSON-RPC batching, and 2024-11-05 requires the older HTTP+SSE
// transport with an endpoint event; neither is implemented here, so neither is
// advertised (a narrow true claim beats a broad false one).
export const PROTOCOL_VERSIONS = ['2025-06-18']
export const PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]
export const SERVER_INFO = { name: 'dsh-chatgpt-bridge', version: '0.1.0', title: 'DeepSeek Harness bridge' }

export const INSTRUCTIONS = [
  'This server exposes a local DeepSeek Harness (DSH) host to one ChatGPT conversation.',
  'send_task starts real work in a DSH session and returns immediately with a task_id; it does not wait.',
  'Poll get_status with that task_id. Only "completed" means the work finished; "unknown" means the state could not be confirmed and must not be reported as success or failure.',
  'get_result works only for completed tasks and returns the DSH final reply plus the file changes the session itself announced.',
  'While an earlier dispatch outcome is unconfirmed the host refuses new work with QUARANTINE_ACTIVE: an operator has to acknowledge that task inside DSH first, so do not retry in a loop.',
].join(' ')

const TASK_ID = { type: 'string', minLength: 8, maxLength: 200, description: 'The task_id returned by send_task.' }

export const TOOLS = [
  {
    name: 'send_task',
    title: 'Send a task to the local DSH host',
    description: 'Start one task in a native DeepSeek Harness session. Returns a task_id and the DSH session_id immediately; it does not wait for the work. Only one task runs at a time; extra tasks queue. Refused with QUARANTINE_ACTIVE while an earlier dispatch may still be running, and with PRESET_NOT_CONFIGURED when no preset is named and the host designated none.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 20_000, description: 'The task, written for a coding agent.' },
        workspace: { type: 'string', description: 'Absolute path inside an authorized workspace root. Defaults to the first authorized root.' },
        preset: { type: 'string', description: 'DSH agent preset id, only if the host authorizes it. Omitted means the preset the host designated for this bridge, never the host default.' },
        title: { type: 'string', maxLength: 200, description: 'Optional session title.' },
        idempotency_key: { type: 'string', maxLength: 200, description: 'Reuse to make a resend return the original task instead of starting a second one.' },
        repeat: { type: 'boolean', description: 'Send again even though an earlier task with the same prompt ended with an unconfirmed outcome. Defaults to false: that earlier task keeps the claim, because it may still be running.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_status',
    title: 'Read a task status',
    description: 'Report the observed state of a task: queued, running, approval_required, completed, failed, or unknown. A lost connection is never reported as completed or failed. When a dispatch outcome is unconfirmed the payload says which task is holding the queue.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID }, required: ['task_id'], additionalProperties: false },
  },
  {
    name: 'get_result',
    title: 'Read a completed task result',
    description: 'Return the final assistant reply of a completed task and the file changes the host computed. deliverables lists the paths the agent announced; it is not proof those files exist or hold what was meant, so every entry is marked unverified. Cannot read arbitrary files.',
    inputSchema: { type: 'object', properties: { task_id: TASK_ID }, required: ['task_id'], additionalProperties: false },
  },
]

/** Minimal JSON-Schema check: the subset these three schemas use. */
export function validateArguments(schema, value) {
  const errors = []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['arguments must be an object']
  const properties = schema.properties ?? {}
  for (const key of Object.keys(value)) {
    if (!(key in properties)) errors.push('unknown argument: ' + key)
  }
  for (const key of schema.required ?? []) {
    if (!(key in value) || value[key] === undefined) errors.push('missing required argument: ' + key)
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) continue
    const entry = value[key]
    if (spec.type === 'string') {
      if (typeof entry !== 'string') { errors.push(key + ' must be a string'); continue }
      if (spec.minLength !== undefined && entry.length < spec.minLength) errors.push(key + ' is shorter than ' + spec.minLength)
      if (spec.maxLength !== undefined && entry.length > spec.maxLength) errors.push(key + ' is longer than ' + spec.maxLength)
    } else if (spec.type === 'integer') {
      if (!Number.isInteger(entry)) errors.push(key + ' must be an integer')
    } else if (spec.type === 'boolean') {
      if (typeof entry !== 'boolean') errors.push(key + ' must be a boolean')
    }
  }
  return errors
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}

class HttpFailure extends Error {
  constructor(status, body) { super('http ' + status); this.status = status; this.body = body }
}

/**
 * @param controlUrl - base URL of the plugin control channel, e.g. http://127.0.0.1:3461/bridge/v1
 * @param controlToken - bearer token for that channel
 * @param mcpToken - bearer token this endpoint requires from its client
 */
export function createMcpServer({ controlUrl, controlToken, mcpToken, host = '127.0.0.1', port = 3460, bodyLimit = 1_048_576, allowedOrigins = [], fetchImpl = globalThis.fetch, logger = console }) {
  if (typeof mcpToken !== 'string' || mcpToken.length < 16) throw new BridgeError('UNAUTHORIZED', 'the MCP endpoint needs a token of at least 16 characters')
  if (typeof controlToken !== 'string' || controlToken.length < 16) throw new BridgeError('UNAUTHORIZED', 'the control channel token is missing')
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+\//.test(controlUrl)) throw new BridgeError('INVALID_ARGUMENT', 'controlUrl must be a loopback http URL')

  // Session ids this endpoint issued, with the revision each one negotiated.
  // A request that names any other id is not from a session we opened.
  const sessions = new Map()
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : []

  async function callControl(operation, payload) {
    let response
    try {
      traceStage('mcp.control.request','enter')
      response = await fetchImpl(controlUrl + '/' + operation, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + controlToken },
        body: JSON.stringify(payload),
      })
      traceStage('mcp.control.request','exit')
    } catch (error) {
      traceStage('mcp.control.request','error',error)
      throw new BridgeError('CONTROL_UNAVAILABLE', 'the DSH host control channel is unreachable: ' + (error instanceof Error ? error.message : String(error)), { retryable: true })
    }
    let body
    try { body = await traceAsync('mcp.control.decode',()=>response.json()) } catch { body = null }
    if (!body || typeof body !== 'object') {
      throw new BridgeError('CONTROL_UNAVAILABLE', 'the control channel answered with a non-JSON body', { retryable: true, details: { status: response.status } })
    }
    if (!response.ok || body.ok !== true) {
      const error = body.error ?? {}
      traceStage('mcp.control.error','error',{name:'BridgeError',code:error.code})
      throw new BridgeError(error.code ?? 'CONTROL_FAILED', error.message ?? 'the control channel rejected the request', { retryable: Boolean(error.retryable), details: error.details, effect: error.effect === 'none' ? 'none' : 'unknown' })
    }
    return body.data
  }

  async function invokeTool(name, args) {
    switch (name) {
      case 'send_task': {
        const data = await traceAsync('mcp.send.invoke',()=>callControl('send', {
          prompt: args.prompt,
          workspace: args.workspace,
          preset: args.preset,
          title: args.title,
          idempotency_key: args.idempotency_key,
          repeat: args.repeat === true,
        }))
        return traceSync('mcp.send.project',()=>{
        const task = data.task
        return {
          task_id: task.taskId,
          session_id: task.sessionId,
          state: task.state,
          duplicate: data.duplicate === true,
          ...(data.reason ? { note: data.reason } : {}),
          accepted_at: task.acceptedAt,
          queued_ahead: task.queuedAhead ?? 0,
          next: 'Poll get_status with this task_id. send_task does not wait for the work.',
        }
        })
      }
      case 'get_status': {
        const task = await callControl('status', { task_id: args.task_id })
        return project(task)
      }
      case 'get_result': {
        const result = await callControl('result', { task_id: args.task_id })
        return {
          task_id: result.taskId,
          session_id: result.sessionId,
          state: result.state,
          completed_at: result.completedAt,
          final_message: result.finalMessage,
          final_message_truncated: result.finalMessageTruncated,
          deliverables: result.deliverables,
          changed_files: result.changedFiles,
          diagnostics: result.diagnostics,
        }
      }
      default:
        throw new BridgeError('METHOD_NOT_FOUND', 'no such tool: ' + name)
    }
  }

  function project(task) {
    return {
      task_id: task.taskId,
      session_id: task.sessionId,
      state: task.state,
      accepted_at: task.acceptedAt,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
      ...(task.confidence ? { confidence: task.confidence } : {}),
      ...(task.note ? { note: task.note } : {}),
      ...(task.failure ? { failure: task.failure } : {}),
      ...(task.warning ? { warning: task.warning } : {}),
      turn: task.detail?.turn ?? null,
      pending_tool_call: task.detail?.pendingToolCall ?? null,
      queued_ahead: task.queuedAhead ?? 0,
      // while a dispatch outcome is unconfirmed the whole queue is held; the
      // caller needs to see which task is holding it
      ...(task.quarantine
        ? { quarantine: { task_id: task.quarantine.taskId, since: task.quarantine.since, mine: task.quarantine.mine } }
        : {}),
    }
  }

  async function dispatch(message) {
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    if (typeof method !== 'string') return isNotification ? null : rpcError(id, -32600, 'method is required')

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        // The reply names the revision this server implements, never an echo of
        // whatever the client asked for: a client asking for 2024-11-05 must
        // see that this endpoint does not speak it.
        const protocolVersion = PROTOCOL_VERSION
        const sessionId = randomUUID()
        sessions.set(sessionId, {
          protocolVersion,
          clientRequestedVersion: typeof requested === 'string' ? requested : null,
          createdAt: Date.now(),
          initialized: false,
          earlyCalls: 0,
        })
        return {
          message: rpcResult(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          }),
          sessionId,
        }
      }
      case 'notifications/initialized': {
        // marks the lifecycle stage; tools are answered either way, but a
        // client that never sends this is recorded rather than silently assumed
        return null
      }
      case 'notifications/cancelled':
        return null
      case 'ping':
        return { message: rpcResult(id, {}) }
      case 'tools/list':
        return { message: rpcResult(id, { tools: TOOLS }) }
      case 'tools/call': {
        const name = params?.name
        if (typeof name !== 'string') return { message: rpcError(id, -32602, 'tools/call requires a tool name') }
        const tool = TOOLS.find((candidate) => candidate.name === name)
        if (!tool) return { message: rpcError(id, -32602, 'unknown tool: ' + name) }
        const args = params?.arguments ?? {}
        const problems = validateArguments(tool.inputSchema, args)
        if (problems.length > 0) return { message: rpcError(id, -32602, 'invalid arguments: ' + problems.join('; '), { problems }) }
        try {
          const data = await invokeTool(name, args)
          return { message: rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: false }) }
        } catch (error) {
          traceStage('mcp.tool.error','error',error)
          const failure = error instanceof BridgeError ? error : new BridgeError('INTERNAL', error instanceof Error ? error.message : String(error))
          const payload = failure.toJSON()
          return {
            message: rpcResult(id, {
              content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
              structuredContent: payload,
              isError: true,
            }),
          }
        }
      }
      case 'resources/list':
        return { message: rpcResult(id, { resources: [] }) }
      case 'prompts/list':
        return { message: rpcResult(id, { prompts: [] }) }
      default:
        return isNotification ? null : { message: rpcError(id, -32601, 'method not found: ' + method) }
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/mcp') {
      respond(response, 404, { error: 'not_found', message: 'the MCP endpoint is /mcp' })
      return
    }
    const header = request.headers.authorization
    if (typeof header !== 'string' || header !== 'Bearer ' + mcpToken) {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    // A valid token is not the whole authorization: a browser page the
    // operator never allowed must not be able to drive this endpoint, and a
    // client must not pick a protocol revision or a session id we never issued.
    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== '' && !origins.includes(origin)) {
      transportError(response, 403, 'origin not allowed: ' + origin, { allowedOrigins: origins })
      return
    }
    // The header is checked after the body is read: on initialize it must name
    // a revision this server implements, and on later requests it must match
    // the one the session negotiated.
    let clientVersion = request.headers['mcp-protocol-version']
    if (typeof clientVersion !== 'string' || clientVersion === '') clientVersion = null
    let sessionHeader = request.headers['mcp-session-id']
    if (typeof sessionHeader !== 'string' || sessionHeader === '') sessionHeader = null
    if (sessionHeader && !sessions.has(sessionHeader)) {
      transportError(response, 404, 'unknown session id', { session: 'expired or never issued by this endpoint' })
      return
    }

    if (request.method === 'GET') {
      response.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' })
      response.end(JSON.stringify({ error: 'no server-initiated stream; use POST' }))
      return
    }
    if (request.method === 'DELETE') {
      if (!sessionHeader) {
        transportError(response, 400, 'DELETE requires the mcp-session-id header')
        return
      }
      sessions.delete(sessionHeader)
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' })
      response.end(JSON.stringify({ error: 'method_not_allowed' }))
      return
    }

    let raw
    try { raw = await readBody(request, bodyLimit) } catch (error) {
      respond(response, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: error.message } })
      return
    }
    let parsed
    try { parsed = JSON.parse(raw) } catch {
      respond(response, 200, rpcError(null, -32700, 'parse error'))
      return
    }
    if (Array.isArray(parsed)) {
      respond(response, 200, rpcError(null, -32600, 'batched requests are not supported'))
      return
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
      respond(response, 200, rpcError(parsed?.id, -32600, 'invalid request'))
      return
    }

    if (parsed.method === 'initialize' && clientVersion && !PROTOCOL_VERSIONS.includes(clientVersion)) {
      transportError(response, 400, 'unsupported MCP-Protocol-Version: ' + clientVersion, { supported: PROTOCOL_VERSIONS })
      return
    }

    // Everything except initialize belongs to a session that already exists.
    let session = null
    if (parsed.method !== 'initialize') {
      if (!sessionHeader) {
        transportError(response, 400, 'this request needs the mcp-session-id issued by initialize')
        return
      }
      session = sessions.get(sessionHeader)
      // A session speaks exactly the revision negotiated at initialize. A
      // request may omit the header (the session already identifies the
      // version); sending a different one — implemented here or not — is a
      // contradiction with this session, not a hint to switch.
      if (clientVersion && clientVersion !== session.protocolVersion) {
        transportError(
          response,
          400,
          'MCP-Protocol-Version ' + clientVersion + ' is not the revision this session negotiated (' + session.protocolVersion + ')',
          { negotiated: session.protocolVersion, supported: PROTOCOL_VERSIONS },
        )
        return
      }
      if (parsed.method === 'notifications/initialized') {
        session.initialized = true
        session.initializedAt = Date.now()
      } else if (!session.initialized && (parsed.method === 'tools/list' || parsed.method === 'tools/call')) {
        // accepted, but counted: the lifecycle stage is recorded instead of assumed
        session.earlyCalls += 1
      }
    }

    let outcome
    try {
      outcome = await dispatch(parsed)
    } catch (error) {
      logger.error?.('[dsh-chatgpt-bridge] dispatch failure', error)
      respond(response, 200, rpcError(parsed.id, -32603, 'internal error'))
      return
    }
    if (!outcome) {
      response.writeHead(202).end()
      return
    }
    const headers = {}
    if (outcome.sessionId) headers['mcp-session-id'] = outcome.sessionId
    respond(response, 200, outcome.message, headers)
  })

  return {
    server,
    /** Read-only view of issued sessions, for diagnostics and tests. */
    sessions() {
      return [...sessions.entries()].map(([id, record]) => ({ id, ...record }))
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Transport-level refusal: HTTP status plus a JSON-RPC error body. */
function transportError(response, status, message, data) {
  respond(response, status, { jsonrpc: '2.0', id: null, error: { code: -32000, message, ...(data ? { data } : {}) } })
}

function respond(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers })
  response.end(body)
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('request body too large')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}
