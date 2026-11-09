/** Bridge configuration and its validation. Every default is a closed choice. */
import { resolve } from 'node:path'

export const DEFAULTS = {
  enabled: true,
  // control channel between the MCP front end and this plugin
  host: '127.0.0.1',
  port: 3461,
  tokenEnv: 'DSH_CHATGPT_BRIDGE_CONTROL_TOKEN',
  token: undefined,
  // authorization of what a task is allowed to touch. workspaceRoots is an
  // authorization filter for task targets, NOT a filesystem sandbox: the
  // session itself runs with the DSH host's own permissions.
  workspaceRoots: [],
  allowedPresets: [],
  // the one preset a task may use when it does not name one. Left unset, a
  // task without an explicit preset is refused instead of falling back to the
  // host's default preset, whose permissions the operator never confirmed.
  preset: undefined,
  // browser origins accepted by the MCP endpoint. Empty means: no request
  // carrying an Origin header is accepted at all.
  allowedOrigins: [],
  // task admission
  maxQueued: 4,
  maxTasks: 200,
  // observation
  approvalInferenceMs: 3_000,
  maxPromptChars: 20_000,
  maxResultChars: 30_000,
  maxMessages: 20,
  requestBodyLimitBytes: 1_048_576,
}

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError' }
}

function absoluteList(value, field) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError(field + ' must be an array of absolute paths')
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new ConfigError(field + ' entries must be non-empty strings')
    if (!/^[a-zA-Z]:[\\/]|^\//.test(entry)) throw new ConfigError(field + ' entries must be absolute paths: ' + entry)
    return resolve(entry)
  })
}

function positiveInt(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new ConfigError(field + ' must be an integer ' + min + '-' + max)
  return number
}

/** The designated default preset, and it must be one the operator authorized. */
function presetId(value, allowedPresets) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError('preset must be a non-empty string when set')
  const id = value.trim()
  const list = Array.isArray(allowedPresets) ? allowedPresets : []
  if (!list.includes(id)) throw new ConfigError('preset "' + id + '" is not in allowedPresets; add it there or leave preset empty')
  return id
}

/** Origins are compared as exact strings; a wildcard would defeat the check. */
function originList(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigError('allowedOrigins must be an array of origins')
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new ConfigError('allowedOrigins entries must be non-empty strings')
    const origin = entry.trim()
    if (origin === '*' || origin.includes('*')) throw new ConfigError('allowedOrigins does not accept wildcards: ' + origin)
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) throw new ConfigError('allowedOrigins entries must look like https://host[:port]: ' + origin)
    return origin
  })
}

/**
 * Validate raw plugin config into the shape the rest of the bridge relies on.
 * A missing token is not defaulted: the bridge refuses to listen without one.
 */
export function resolveConfig(raw = {}, env = process.env) {
  const merged = { ...DEFAULTS, ...raw }
  if (typeof merged.host !== 'string' || !merged.host.trim()) throw new ConfigError('host must be a non-empty string')
  if (merged.host !== '127.0.0.1' && merged.host !== 'localhost' && merged.host !== '::1') {
    throw new ConfigError('host must be a loopback address; the bridge never listens on a public interface')
  }
  const token = typeof merged.token === 'string' && merged.token.length > 0
    ? merged.token
    : (merged.tokenEnv ? env[merged.tokenEnv] : undefined)
  const rootList = absoluteList(merged.workspaceRoots, 'workspaceRoots')
  return {
    enabled: merged.enabled !== false,
    host: merged.host === 'localhost' ? '127.0.0.1' : merged.host,
    port: positiveInt(merged.port, 'port', { max: 65_535 }),
    token: typeof token === 'string' && token.length > 0 ? token : undefined,
    tokenEnv: typeof merged.tokenEnv === 'string' ? merged.tokenEnv : undefined,
    workspaceRoots: rootList,
    allowedPresets: Array.isArray(merged.allowedPresets)
      ? merged.allowedPresets.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
      : (() => { throw new ConfigError('allowedPresets must be an array of strings') })(),
    preset: presetId(merged.preset, merged.allowedPresets),
    allowedOrigins: originList(merged.allowedOrigins),
    maxQueued: positiveInt(merged.maxQueued, 'maxQueued', { max: 64 }),
    maxTasks: positiveInt(merged.maxTasks, 'maxTasks', { max: 5_000 }),
    approvalInferenceMs: positiveInt(merged.approvalInferenceMs, 'approvalInferenceMs', { min: 0, max: 600_000 }),
    maxPromptChars: positiveInt(merged.maxPromptChars, 'maxPromptChars', { max: 200_000 }),
    maxResultChars: positiveInt(merged.maxResultChars, 'maxResultChars', { max: 1_000_000 }),
    maxMessages: positiveInt(merged.maxMessages, 'maxMessages', { max: 200 }),
    requestBodyLimitBytes: positiveInt(merged.requestBodyLimitBytes, 'requestBodyLimitBytes', { max: 16_777_216 }),
    modulesRoot: typeof merged.modulesRoot === 'string' && merged.modulesRoot ? resolve(merged.modulesRoot) : undefined,
  }
}
