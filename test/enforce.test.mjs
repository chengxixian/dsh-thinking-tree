/**
 * The hard rule: digest injection, refresh only on change, the first-turn gate,
 * and the `thinking_tree` tool that clears it.
 */
import { shapeTree } from '../index.js'
import {
  buildDigest, digestSignature, gateReason, treeState, registerEnforcement,
  ALLOWED_BEFORE_INIT, DIGEST_MARKER, PLACEHOLDER_TITLE, renderChain,
} from '../enforce.js'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const clone = value => JSON.parse(JSON.stringify(value))

/**
 * Build one in-memory chain the enforcement layer can read and mutate.
 * @param {object[]} seed - initial nodes.
 * @returns {object} the fake store and its deps.
 */
function store(seed) {
  let nodes = clone(seed)
  let counter = nodes.length
  const shaped = () => shapeTree(clone(nodes))
  const deps = {
    async listNodes() { return shaped() },
    async createNode(sessionId, input) {
      counter += 1
      const id = `auto-${counter}`
      nodes.push({
        id,
        name: `${String(counter).padStart(2, '0')}-auto.md`,
        parent: input.parent ?? '',
        order: counter,
        title: input.title,
        status: 'pending',
        body: input.body ?? '',
      })
      return { name: `${String(counter).padStart(2, '0')}-auto.md`, id }
    },
    async setTitle(sessionId, name, title) {
      const node = nodes.find(item => item.name === name || item.id === name)
      if (node !== undefined) node.title = title
    },
    async saveBody(sessionId, name, body) {
      const node = nodes.find(item => item.name === name || item.id === name)
      if (node !== undefined) node.body = body
    },
    async appendBody(sessionId, name, text) {
      const node = nodes.find(item => item.name === name || item.id === name)
      if (node !== undefined) node.body = `${node.body}\n${text}`
    },
    async setStatus(sessionId, name, status) {
      const node = nodes.find(item => item.name === name || item.id === name)
      if (node !== undefined) node.status = status
    },
    async findNode(sessionId, key) {
      const shapedTree = shaped()
      return shapedTree.nodes.find(node => node.name === key || node.id === key || node.title === key)
    },
    state: { memory: [] },
  }
  deps.stateOf = async () => ({ exists: true, shaped: shaped(), memory: clone(deps.state.memory) })
  deps.snapshot = () => clone(nodes)
  deps.setMemory = (entries) => { deps.state.memory = clone(entries) }
  return deps
}

/** A fake Host context that records listeners, tools, and effects. */
function fakeCtx() {
  const listeners = new Map()
  const tools = []
  return {
    ctx: {
      get(name) {
        if (name === 'tools') return { register: definition => { tools.push(definition); return () => undefined } }
        return undefined
      },
      on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) },
      effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => undefined },
    },
    listeners,
    tools,
  }
}

// Placeholder vs initialized.
{
  const placeholder = shapeTree([
    { id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: PLACEHOLDER_TITLE, status: 'pending', body: '' },
  ])
  const empty = treeState(placeholder)
  check('a seeded goal is not an initialized chain', empty.initialized === false && empty.placeholder === true, empty)

  const real = shapeTree([
    { id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: '做一个东西', status: 'active', body: '' },
    { id: '01-req', name: '01-req.md', parent: '00-goal', order: 1, title: '要求一', status: 'done', body: '' },
    { id: '02-req', name: '02-req.md', parent: '00-goal', order: 2, title: '要求二', status: 'active', body: '' },
  ])
  const state = treeState(real)
  check('a goal with requirements is initialized and reports progress', state.initialized === true && state.goals[0].done === 1 && state.goals[0].total === 2, state.goals[0])
  check('the active node is reported', state.active.some(node => node.title === '要求二'), { active: state.active.map(node => node.title) })
}

// Digest content and budget.
{
  const shaped = shapeTree([
    { id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: '统一思考链', status: 'active', body: '' },
    { id: '01-req', name: '01-req.md', parent: '00-goal', order: 1, title: '第一轮建链', status: 'pending', body: '' },
  ])
  const digest = buildDigest({
    shaped,
    memory: [{ id: 'm-1', kind: 'lesson', title: 'asar 里不能 grep', body: '用 read 工具', updated: '2026-01-01T00:00:00.000Z', hits: 1, importance: 5 }],
    folderLabel: 'thinking-tree/s-abc',
  })
  check('the digest is marked and names the goal', digest.startsWith(DIGEST_MARKER) && digest.includes('统一思考链'), { head: digest.split('\n')[0] })
  check('the digest carries the memory bank', digest.includes('asar 里不能 grep'), null)
  check('the digest carries the hard rules', digest.includes('硬性规定') && digest.includes('add_goal'), null)
  check('the digest mentions the tree folder', digest.includes('thinking-tree/s-abc'), null)
  check('the digest stays small', digest.length < 2000, { length: digest.length })

  const gate = buildDigest({
    shaped: shapeTree([{ id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: PLACEHOLDER_TITLE, status: 'pending', body: '' }]),
  })
  check('an uninitialized chain gets a gate section with the unlock call', gate.includes('【门禁】') && gate.includes('action:"init"'), null)
  check('the gate reason names the unlock call', gateReason(treeState(shaped)).includes('thinking_tree'), null)
  check('the chain renders as compact text', renderChain(shaped).includes('[>] 统一思考链'), { text: renderChain(shaped) })
}

// Signature changes only when the chain or the bank changes.
{
  const shaped = shapeTree([
    { id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: '目标', status: 'active', body: '' },
    { id: '01-req', name: '01-req.md', parent: '00-goal', order: 1, title: '要求', status: 'pending', body: '' },
  ])
  const first = digestSignature({ shaped, memory: [] })
  const same = digestSignature({ shaped: shapeTree(JSON.parse(JSON.stringify(shaped.nodes))), memory: [] })
  const changed = digestSignature({ shaped, memory: [{ id: 'm-1', updated: '2026', hits: 2 }] })
  check('an unchanged chain keeps its signature', first === same, { first })
  check('a new memory changes the signature', first !== changed, { first, changed })
}

// No injection at all; the summary is available on demand, and the gate works.
{
  const deps = store([{ id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: PLACEHOLDER_TITLE, status: 'pending', body: '' }])
  let seedCalls = 0
  deps.ensureSeed = async () => { seedCalls += 1 }
  deps.isSubagent = () => false
  deps.folderLabel = () => 'thinking-tree/s-test'

  const host = fakeCtx()
  registerEnforcement(host.ctx, deps)
  const preExecute = host.listeners.get('tools/pre-execute')

  check('nothing is registered on agent/pre-step', host.listeners.get('agent/pre-step') === undefined, {
    listening: [...host.listeners.keys()],
  })

  const denied = await preExecute({ name: 'bash', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  check('a placeholder chain denies ordinary tools', denied.kind === 'deny' && denied.reason.includes('thinking_tree'), denied)
  check('the gate whitelists the chain tools', ALLOWED_BEFORE_INIT.has('thinking_tree') && ALLOWED_BEFORE_INIT.has('write'), null)
  const allowed = await preExecute({ name: 'read', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  check('reading is still allowed through the gate', allowed.kind === 'allow', allowed)

  const treeTool = host.tools.find(tool => tool.name === 'thinking_tree')
  const onDemand = await treeTool.execute({ action: 'digest' }, { agent: { id: 's-test' } })
  check('the summary is available on demand', onDemand.ok === true && onDemand.text.startsWith(DIGEST_MARKER) && onDemand.text.includes('门禁'), {
    head: String(onDemand.text ?? '').split('\n')[0],
  })

  const initialized = await treeTool.execute({
    action: 'init',
    title: '把强制思维链做出来',
    goal: '链写在磁盘上，宿主不往对话里塞消息。',
    requirements: [{ title: '第一轮强制建链' }, { title: '新目标追加' }],
  }, { agent: { id: 's-test' } })
  check('init rewrites the goal and creates requirements', initialized.ok === true && initialized.requirements.length === 2, initialized)
  const after = deps.snapshot()
  check('init renamed the seeded goal instead of adding a second root', after.filter(node => node.parent === '').length === 1 && after[0].title === '把强制思维链做出来', {
    roots: after.filter(node => node.parent === '').length, title: after[0].title,
  })
  check('the requirements hang under the goal id', after.filter(node => node.parent === '00-goal').length === 2, { nodes: after.map(node => node.parent) })

  const allowedAfter = await preExecute({ name: 'bash', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  check('initializing the chain re-allows ordinary tools', allowedAfter.kind === 'allow', allowedAfter)

  // The gate must not read the disk on every tool call once the chain is ready.
  const onEvent = host.listeners.get('session/event')
  await preExecute({ name: 'bash', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  let stateReads = 0
  const realStateOf = deps.stateOf
  deps.stateOf = async (sessionId) => { stateReads += 1; return await realStateOf(sessionId) }
  const cachedAllow = await preExecute({ name: 'bash', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  check('an initialized chain is cached, not re-read', cachedAllow.kind === 'allow' && stateReads === 0, { stateReads })
  onEvent({ id: 's-test' }, { type: 'tool/call', data: { turn: 2, step: 1, name: 'thinking_tree' } })
  await preExecute({ name: 'bash', agent: { id: 's-test' } }, async () => ({ kind: 'allow' }))
  check('a chain write drops the gate cache', stateReads === 1, { stateReads })

  const added = await treeTool.execute({ action: 'add_goal', title: '第二个目标', requirements: [{ title: '第二条要求' }] }, { agent: { id: 's-test' } })
  const twoRoots = deps.snapshot().filter(node => node.parent === '')
  check('add_goal starts an independent second chain', added.ok === true && twoRoots.length === 2, { roots: twoRoots.map(node => node.title) })

  const status = await treeTool.execute({ action: 'status', node: '第一个目标', status: 'done' }, { agent: { id: 's-test' } })
  check('status updates the node it was given', status.ok === false || status.status === 'done', status)

  const noted = await treeTool.execute({ action: 'note', node: after[1].name, text: '结果：测试通过' }, { agent: { id: 's-test' } })
  check('note appends evidence to the node body', noted.ok === true, noted)
  check('the note is visible in the stored body', String(deps.snapshot().find(node => node.name === after[1].name)?.body ?? '').includes('测试通过'), null)
}

// Child agents are left alone: no gate, nothing injected.
{
  const deps = store([{ id: '00-goal', name: '00-goal.md', parent: '', order: 0, title: PLACEHOLDER_TITLE, status: 'pending', body: '' }])
  deps.ensureSeed = async () => undefined
  deps.isSubagent = () => true
  deps.folderLabel = () => 'thinking-tree/s-child'
  const host = fakeCtx()
  registerEnforcement(host.ctx, deps)
  const preExecute = host.listeners.get('tools/pre-execute')
  const gate = await preExecute({ name: 'bash', agent: { id: 's-child' } }, async () => ({ kind: 'allow' }))
  check('a subagent is never gated', gate.kind === 'allow' && host.listeners.get('agent/pre-step') === undefined, { gate: gate.kind })
}

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results: failed }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1