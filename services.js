/**
 * Late-service lookup.
 *
 * A bundle's `apply` may run before an optional service is mounted (the tool
 * registry and the MCP manager are both optional here). Registering through this
 * helper keeps the feature working when the service arrives a moment later,
 * instead of silently disappearing because one `ctx.get` returned undefined.
 */

/**
 * Run `handler` with a service, waiting a bounded time for it to appear.
 * @param {object} ctx - Host context.
 * @param {string} name - service key.
 * @param {(service: object) => void} handler - called once with the service.
 * @param {{attempts?: number, delayMs?: number, maxDelayMs?: number}} [options] - retry budget.
 * @returns {void}
 */
export function untilService(ctx, name, handler, options = {}) {
  const attempts = Number.isFinite(Number(options.attempts)) ? Number(options.attempts) : 10
  const firstDelay = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 300
  const maxDelay = Number.isFinite(Number(options.maxDelayMs)) ? Number(options.maxDelayMs) : 3000
  const read = () => {
    try {
      return ctx?.get?.(name)
    } catch {
      return undefined
    }
  }
  const initial = read()
  if (initial !== undefined && initial !== null) {
    handler(initial)
    return
  }
  let tries = 0
  let delay = firstDelay
  const tick = () => {
    tries += 1
    const service = read()
    if (service !== undefined && service !== null) {
      handler(service)
      return
    }
    if (tries >= attempts) return
    delay = Math.min(maxDelay, delay * 2)
    arm()
  }
  const arm = () => {
    const timer = setTimeout(tick, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }
  arm()
}