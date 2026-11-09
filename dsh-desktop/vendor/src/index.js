/**
 * DSH plugin entry.
 *
 * Mounted inside the Web host it owns the native-session task queue and serves
 * the loopback control channel. It is a thin shell: all behaviour lives in
 * driver.js, registry.js and service.js, which are testable without a host.
 */
import { ConfigError, resolveConfig } from './config.js'
import { BridgeError } from './errors.js'
import { SessionDriver } from './driver.js'
import { TaskRegistry } from './registry.js'
import { Policy } from './policy.js'
import { BridgeService } from './service.js'
import { createControlServer } from './control-server.js'
import { PROTOCOL_VERSION, SERVER_INFO } from './mcp/server.js'

export const name = 'dsh-chatgpt-bridge'
// Cordis 4.1 treats declared dependencies as required. Optional Driver services
// are read through the documented ctx.get() lookup instead.
export const inject = ['agents', 'workspaceRegistry', 'agentDefaultModel']

/**
 * Build the bridge against a host context without touching the network.
 * Exported separately so tests can drive it with a fake host.
 */
export function createBridge(ctx, rawConfig = {}, options = {}) {
  const config = resolveConfig(rawConfig, options.env ?? process.env)
  if (!config.enabled) return { config, enabled: false, service: null, server: null, start: async () => {}, stop: async () => {} }
  if (!config.token) {
    throw new ConfigError('no control token: set "' + (config.tokenEnv ?? 'token') + '" in the environment or configure token directly')
  }

  const driver = new SessionDriver({ ctx, config, modules: options.modules, now: options.now })
  const registry = new TaskRegistry({ maxQueued: config.maxQueued, maxTasks: config.maxTasks, now: options.now })
  const service = new BridgeService({ driver, registry, policy: new Policy(config), config, now: options.now })
  const server = createControlServer({
    service,
    token: config.token,
    host: config.host,
    port: config.port,
    bodyLimit: config.requestBodyLimitBytes,
    logger: options.logger ?? console,
  })

  return {
    config,
    enabled: true,
    service,
    server,
    async start() {
      const address = await server.listen()
      return address
    },
    async stop() {
      await server.close()
    },
    describe() {
      return {
        plugin: name,
        protocol: PROTOCOL_VERSION,
        server: SERVER_INFO,
        control: 'http://' + config.host + ':' + config.port + '/bridge/v1',
        workspaceRoots: config.workspaceRoots,
        allowedPresets: config.allowedPresets,
        preset: config.preset ?? null,
        allowedOrigins: config.allowedOrigins,
        maxQueued: config.maxQueued,
      }
    },
  }
}

/** Cordis apply hook. */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig, process.env)
  if (!config.enabled) return
  if (!config.token) {
    throw new ConfigError('the dsh-chatgpt-bridge plugin needs a control token before it can listen: set ' + (config.tokenEnv ?? 'token'))
  }
  const bridge = createBridge(ctx, rawConfig)
  const logger = ctx.logger ?? console

  bridge.start().then((address) => {
    logger.info?.('[dsh-chatgpt-bridge] control channel on ' + JSON.stringify(address))
  }).catch((error) => {
    logger.error?.('[dsh-chatgpt-bridge] control channel failed to start: ' + (error instanceof Error ? error.message : String(error)))
  })

  const cleanup = () => { void bridge.stop().catch(() => {}) }
  if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
  else if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  return bridge
}

export { BridgeError, ConfigError }
