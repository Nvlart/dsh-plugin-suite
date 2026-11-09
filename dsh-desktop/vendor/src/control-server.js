import {traceStage,traceSync,traceAsync} from './stage-diagnostics.js';
/**
 * Loopback control channel for a DSH host plugin.
 *
 * This is what the standalone MCP process talks to. It is not the MCP
 * endpoint: it answers three fixed operations, refuses everything else, and
 * accepts only loopback peers that present the configured bearer token.
 */
import { timingSafeEqual, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { BridgeError, toBridgeError } from './errors.js'

const ROUTES = new Map([
  ['/bridge/v1/send', 'send'],
  ['/bridge/v1/status', 'status'],
  ['/bridge/v1/result', 'result'],
  // operator-only: lifts the queue quarantine left by an unconfirmed dispatch
  ['/bridge/v1/acknowledge', 'acknowledge'],
])

const STATUS_CODES = {
  TASK_NOT_FOUND: 404,
  RESULT_NOT_READY: 409,
  RESULT_UNAVAILABLE: 409,
  QUEUE_FULL: 429,
  TASK_REGISTRY_FULL: 429,
  QUARANTINE_ACTIVE: 409,
  QUARANTINE_NOT_ACTIVE: 409,
  QUARANTINE_TASK_MISMATCH: 409,
  WORKSPACE_FORBIDDEN: 403,
  PRESET_FORBIDDEN: 403,
  PRESET_NOT_CONFIGURED: 403,
  INVALID_PROMPT: 400,
  INVALID_ARGUMENT: 400,
  SESSION_NOT_LIVE: 503,
  HOST_SERVICE_MISSING: 503,
  HOST_API_MISMATCH: 503,
  CONTROL_UNAVAILABLE: 503,
  UNAUTHORIZED: 401,
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new BridgeError('INVALID_ARGUMENT', 'request body exceeds ' + limit + ' bytes'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new BridgeError('INVALID_ARGUMENT', 'request body must be a JSON object'))
        }
        resolve(parsed)
      } catch {
        reject(new BridgeError('INVALID_ARGUMENT', 'request body is not valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * @param service - BridgeService
 * @param token - shared secret; absent means the server refuses to start
 */
export function createControlServer({ service, token, host = '127.0.0.1', port = 3461, bodyLimit = 1_048_576, logger = console }) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new BridgeError('UNAUTHORIZED', 'the control channel needs a token of at least 16 characters')
  }
  const expected = digest(token)

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopback(request.socket?.remoteAddress)) {
        send(response, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'the control channel accepts loopback peers only', retryable: false } })
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/bridge/v1/health') {
        if (!authorized(request, expected)) return unauthorized(response)
        send(response, 200, { ok: true, data: service.health() })
        return
      }
      const operation = ROUTES.get(url.pathname)
      if (!operation) {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such control operation', retryable: false } })
        return
      }
      if (request.method !== 'POST') {
        send(response, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST', retryable: false } })
        return
      }
      if (!authorized(request, expected)) return unauthorized(response)
      const body = await readJson(request, bodyLimit)
      const data = await handle(service, operation, body)
      traceSync('control.response',()=>send(response, 200, { ok: true, data }))
    } catch (error) {
      traceStage('control.error','error',error)
      const failure = toBridgeError(error)
      const status = STATUS_CODES[failure.code] ?? 500
      if (status === 500) logger.error?.('[dsh-chatgpt-bridge] control failure', failure.code, failure.message)
      send(response, status, { ok: false, error: failure.toJSON() })
    }
  })

  return {
    server,
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

function authorized(request, expected) {
  const header = request.headers?.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = digest(header.slice(7).trim())
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function unauthorized(response) {
  send(response, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid bridge token', retryable: false } })
}

function requireString(body, field) {
  const value = body[field]
  if (typeof value !== 'string' || !value.trim()) throw new BridgeError('INVALID_ARGUMENT', field + ' is required')
  return value.trim()
}

async function handle(service, operation, body) {
  switch (operation) {
    case 'send': {
      const result = await traceAsync('control.service.send',()=>service.sendTask({
        prompt: requireString(body, 'prompt'),
        workspace: typeof body.workspace === 'string' ? body.workspace : undefined,
        preset: typeof body.preset === 'string' ? body.preset : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined,
        repeat: body.repeat === true,
      }))
      return result
    }
    case 'status':
      return service.getStatus(requireString(body, 'task_id'))
    case 'result':
      return service.getResult(requireString(body, 'task_id'))
    case 'acknowledge':
      return service.acknowledgeUncertain(requireString(body, 'task_id'), {
        note: typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : undefined,
      })
    default:
      throw new BridgeError('NOT_FOUND', 'unsupported control operation')
  }
}
