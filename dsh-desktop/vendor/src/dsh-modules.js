/**
 * Resolve the DSH module tree that the running host was installed from.
 *
 * The bridge runs inside a DSH host, but its own files may live outside the
 * host's node_modules, so bare specifiers are not resolvable from here. The
 * host tree is located once and reached through createRequire, which is what
 * the DSH packages publish for CommonJS.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const MARKER = join('@deepseek-ai', 'dsh-session', 'package.json')

function isModuleRoot(dir) {
  try { return existsSync(join(dir, MARKER)) } catch { return false }
}

function ancestors(start) {
  const out = []
  let cur = resolve(start)
  for (;;) {
    out.push(cur)
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }
  return out
}

/** Candidate module roots, most specific first. */
export function candidateRoots() {
  const roots = []
  if (process.env.DSH_MODULES_ROOT) roots.push(resolve(process.env.DSH_MODULES_ROOT))
  for (const arg of [process.argv[1], process.cwd(), import.meta.filename ?? '.']) {
    if (typeof arg !== 'string' || !arg) continue
    for (const dir of ancestors(arg)) {
      roots.push(join(dir, 'node_modules'))
      roots.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
    }
  }
  return [...new Set(roots)]
}

export function findModuleRoot(explicit) {
  if (explicit) {
    if (!isModuleRoot(explicit)) throw new Error('DSH module root has no @deepseek-ai/dsh-session: ' + explicit)
    return explicit
  }
  for (const root of candidateRoots()) if (isModuleRoot(root)) return root
  throw new Error('cannot locate the DSH module tree; set DSH_MODULES_ROOT to the directory that contains @deepseek-ai/dsh-session')
}

/**
 * Load the DSH modules the bridge builds on.
 * @param root - module root, resolved from candidates when omitted.
 */
export function loadDshModules(root) {
  const dir = findModuleRoot(root)
  const req = createRequire(join(dir, 'noop.js'))
  const session = req('@deepseek-ai/dsh-session')
  const message = req('@deepseek-ai/dsh-llm/message')
  const agent = req('@deepseek-ai/dsh-agent')
  const title = req('@deepseek-ai/dsh-session-title')
  return {
    root: dir,
    SessionId: session.SessionId,
    KNOWN_SESSION_EVENT_TYPES: session.KNOWN_SESSION_EVENT_TYPES,
    createUserMessage: message.createUserMessage,
    installModelSelection: agent.installModelSelection,
    foldSessionTitle: title.foldSessionTitle,
  }
}
