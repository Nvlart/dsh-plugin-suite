/** Typed failures that cross the MCP boundary without leaking internals. */
export class BridgeError extends Error {
  /**
   * @param code - stable machine code the MCP layer reports verbatim
   * @param message - operator-facing sentence, never a stack trace
   * @param options - retryable tells the client whether a retry could help
   */
  constructor(code, message, { retryable = false, details, effect } = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.retryable = retryable
    this.details = details
    // 'none' — the host provably did not act; 'unknown' — it may have. Only
    // 'none' may ever be retried, because a retry can duplicate the work.
    this.effect = effect ?? 'unknown'
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, effect: this.effect, ...(this.details ? { details: this.details } : {}) }
  }
}

/** Normalize anything thrown into a BridgeError. Unknown causes stay unknown. */
export function toBridgeError(error) {
  if (error instanceof BridgeError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BridgeError('INTERNAL', message, { retryable: false, effect: 'unknown' })
}
