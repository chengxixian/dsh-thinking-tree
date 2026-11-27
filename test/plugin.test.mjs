/**
 * The bundle must survive a real `apply()` against a Host-shaped context.
 *
 * This is the cheapest way to catch a registration mistake (a wrong `ctx.effect`
 * shape, a missing service lookup, a duplicated route) without restarting the
 * running Harness.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'
import { json, readJson } from './helpers.mjs'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const root = mkdtempSync(join(tmpdir(), 'thinking-tree-plugin-'))
const sessionId = 'session-plugin-test'

/** A Host-shaped fake: every service the bundle may look up. */
function fakeHost() {
  const registered = { tools: [], routes: [], providers: [] }
  const listeners = new Map()
  const effects = []
  // Injected services are context properties in Cordis; optional ones go through get().
  const skills = { registerProvider: factory => { registered.providers.push(factory({ signal: new AbortController().signal, invalidate: () => undefined })); return () => undefined } }
  const connection = { fetch: { register: route => { registered.routes.push(route); return () => undefined } } }
  const ctx = {
    skills,
    connection,
    get(key) {
      if (key === 'skills') return skills
      if (key === 'connection') return connection
      if (key === 'tools') return { register: definition => { registered.tools.push(definition); return () => undefined } }
      if (key === 'sessions') return { get: id => (id === sessionId ? { id, header: { cwd: root } } : undefined) }
      if (key === 'sandboxPolicy') return { workspaceRoot: root }
      if (key === 'workingDirectory') return { defaultDirectory: root }
      if (key === 'systemPrompt') return { context: () => () => undefined }
      if (key === 'llm') return { listProviders: () => [], listModels: async () => [] }
      if (key === 'mcpManager') return { register: () => () => undefined }
      return undefined
    },
    on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event) },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => undefined
    },
  }
  return { ctx, registered, listeners, effects }
}

let failure = ''
try {
  const host = fakeHost()
  apply(host.ctx)
  check('apply() registers without throwing', true, null)
  check('the bundle keeps its Cordis identity', name === 'thinking-tree' && inject.includes('skills'), { name, inject })
  check('both tool families are registered', ['thinking_tree', 'memory', 'mcp_library', 'skill_library'].every(tool => host.registered.tools.some(definition => definition.name === tool)), {
    tools: host.registered.tools.map(tool => tool.name),
  })
  check('only the chain gate listens; nothing is injected', host.listeners.has('tools/pre-execute') && !host.listeners.has('agent/pre-step'), {
    events: [...host.listeners.keys()],
  })
  check('the tree routes still exist', host.registered.routes.some(route => route.path.endsWith('/thinking-tree/tree')), {
    routes: host.registered.routes.length,
  })
  check('the memory routes exist', host.registered.routes.some(route => route.path.endsWith('/memory')), null)
  check('the library routes exist', host.registered.routes.some(route => route.path.endsWith('/library')), null)
  check('the skill providers are registered', host.registered.providers.length >= 3, { providers: host.registered.providers.length })

  // The seeded goal is readable through the real route handler.
  const treeRoute = host.registered.routes.find(route => route.path.endsWith('/thinking-tree/tree'))
  const payload = await (await treeRoute.fetch(new Request(`http://local/api/thinking-tree/tree?sessionId=${sessionId}`))).json()
  check('the live tree route seeds a fresh conversation', payload.ok === true && payload.nodes.length === 1, { nodes: payload.nodes?.length })

  // The summary reads that tree, but only when asked.
  const treeToolForDigest = host.registered.tools.find(definition => definition.name === 'thinking_tree')
  const onDemand = await treeToolForDigest.execute({ action: 'digest' }, { agent: { id: sessionId } })
  const digest = String(onDemand.text ?? '')
  check('the digest is built from the seeded chain on demand', digest.includes('[[tree-digest]]') && digest.includes('门禁'), { head: digest.split('\n')[0] })

  // The gate refuses a normal tool while that chain is still a placeholder.
  const gate = host.listeners.get('tools/pre-execute')
  const denied = await gate({ name: 'bash', agent: { id: sessionId } }, async () => ({ kind: 'allow' }))
  check('the gate refuses tools before the chain is written', denied.kind === 'deny', { kind: denied.kind })

  // Clearing the gate through the tool makes the same call pass.
  const treeTool = host.registered.tools.find(definition => definition.name === 'thinking_tree')
  await treeTool.execute({ action: 'init', title: '插件自检目标', requirements: [{ title: '要求一' }] }, { agent: { id: sessionId } })
  const allowed = await gate({ name: 'bash', agent: { id: sessionId } }, async () => ({ kind: 'allow' }))
  check('writing the chain makes the same call pass', allowed.kind === 'allow', { kind: allowed.kind })

  const memoryTool = host.registered.tools.find(definition => definition.name === 'memory')
  const recorded = await memoryTool.execute({ action: 'record', kind: 'decision', title: '插件自检写入', body: 'ok' }, { agent: { id: sessionId } })
  check('the memory tool writes into the conversation folder', recorded.ok === true, recorded)
} catch (error) {
  failure = String(error?.stack ?? error)
  check('apply() registers without throwing', false, { failure })
}

for (const disposer of []) disposer?.()
const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, failure, results: failed }, null, 1))
rmSync(root, { recursive: true, force: true })
process.exitCode = failed.length === 0 ? 0 : 1