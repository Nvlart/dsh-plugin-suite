/** Server-side limits. Every rule here is enforced on the host, never by the model. */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { BridgeError } from './errors.js'

export class Policy {
  #config

  constructor(config) {
    this.#config = config
  }

  /** Trimmed prompt, or a typed rejection. */
  prompt(text) {
    if (typeof text !== 'string') throw new BridgeError('INVALID_PROMPT', 'prompt must be a string')
    const value = text.trim()
    if (value.length < 1) throw new BridgeError('INVALID_PROMPT', 'prompt must not be empty')
    const max = this.#config.maxPromptChars
    if (value.length > max) throw new BridgeError('INVALID_PROMPT', 'prompt exceeds ' + max + ' characters', { details: { max } })
    return value
  }

  /**
   * Resolve a requested workspace against the allowlist.
   * With no roots configured the answer is no: the allowlist never widens itself.
   */
  workspace(requested) {
    const roots = this.#config.workspaceRoots
    if (roots.length === 0) {
      throw new BridgeError('WORKSPACE_FORBIDDEN', 'workspaceRoots is empty on this host; no workspace is authorized until an operator configures one')
    }
    if (requested === undefined || requested === null || requested === '') {
      return roots[0]
    }
    if (typeof requested !== 'string' || !requested.trim()) throw new BridgeError('WORKSPACE_FORBIDDEN', 'workspace must be a non-empty string')
    if (!isAbsolute(requested)) throw new BridgeError('WORKSPACE_FORBIDDEN', 'workspace must be an absolute path: ' + requested)
    const target = resolve(requested)
    for (const root of roots) {
      const rel = relative(root, target)
      if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) return target
    }
    throw new BridgeError('WORKSPACE_FORBIDDEN', 'workspace is outside the authorized roots: ' + target, { details: { roots } })
  }

  /**
   * Preset ids are closed, and there is no implicit default.
   *
   * A task that names no preset gets the one an operator designated in the
   * config; when none is designated the task is refused. Falling back to the
   * host's own default preset would run work under permissions nobody
   * confirmed for this bridge.
   */
  preset(requested) {
    const allowed = Array.isArray(this.#config.allowedPresets) ? this.#config.allowedPresets : []
    const designated = this.#config.preset
    if (requested === undefined || requested === null || requested === '') {
      if (!designated) {
        throw new BridgeError(
          'PRESET_NOT_CONFIGURED',
          'this bridge has no designated preset and the task named none; the host default preset is not used, because its permissions were never confirmed for this bridge',
          { details: { allowedPresets: allowed, fix: 'set "preset" (and add it to allowedPresets) in the bridge config' } },
        )
      }
      if (allowed.length > 0 && !allowed.includes(designated)) {
        throw new BridgeError('PRESET_FORBIDDEN', 'the designated preset is no longer in allowedPresets: ' + designated, { details: { allowed } })
      }
      return designated
    }
    if (typeof requested !== 'string') throw new BridgeError('PRESET_FORBIDDEN', 'preset must be a string')
    if (!allowed.includes(requested)) throw new BridgeError('PRESET_FORBIDDEN', 'preset is not authorized: ' + requested, { details: { allowed } })
    return requested
  }
}
