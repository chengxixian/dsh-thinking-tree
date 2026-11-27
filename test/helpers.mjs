/**
 * Tiny stand-ins for the two Host route helpers, so the route handlers can be
 * driven with plain `Request` objects outside a running Host.
 */

/**
 * Answer with JSON.
 * @param {object} value - JSON-safe payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} the response.
 */
export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Read a JSON object body.
 * @param {Request} request - incoming request.
 * @returns {Promise<object|undefined>} the parsed object.
 */
export async function readJson(request) {
  let text
  try {
    text = await request.text()
  } catch {
    return undefined
  }
  if (text === '') return undefined
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}