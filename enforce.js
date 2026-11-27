/**
 * The hard rule half of the thinking chain.
 *
 * A rule that lives only in a prompt is a rule the model can forget: after a
 * compaction, after twenty tool calls, or after a subagent hands back a wall of
 * text. So this module enforces the chain mechanically instead:
 *
 * - `tools/pre-execute` denies every tool except the chain/memory/read-write
 *   ones while the goal node is still the seeded placeholder. The denial names
 *   the exact call that clears it.
 * - The `thinking_tree` tool gives the model one-call ways to initialize the
 *   chain, add a requirement, start a new goal chain, or pull the compact
 *   summary on demand.
 *
 * Nothing is injected into the conversation. `buildDigest` exists so the model
 * can ask for the summary itself; the Host never pushes a message of its own.
 */
import { createHash } from 'node:crypto'
import { DIGEST_LIMIT, renderMemoryDigest } from './memory.js'
import { untilService } from './services.js'

/** Text that marks the injected digest message. */
export const DIGEST_MARKER = '[[tree-digest]]'

/** Title the Host writes into a freshly seeded goal node. */
export const PLACEHOLDER_TITLE = '本对话的思考链'

/** Tools that stay usable while the chain is uninitialized. */
export const ALLOWED_BEFORE_INIT = new Set([
  'thinking_tree',
  'memory',
  'write',
  'edit',
  'read',
  'glob',
  'grep',
  'todo_write',
  'ask_user_question',
])

/** Node statuses the panel and this tool accept. */
const STATUSES = ['pending', 'active', 'done', 'blocked']

/**
 * Reduce a shaped tree to the facts the digest and the gate need.
 * @param {{roots?: object[]}} shaped - result of the tree shaper.
 * @returns {{goals: object[], initialized: boolean, placeholder: boolean, active: object[]}} chain state.
 */
export function treeState(shaped) {
  const roots = Array.isArray(shaped?.roots) ? shaped.roots : []
  const goals = roots.map((root) => {
    const children = Array.isArray(root.children) ? root.children : []
    return {
      id: root.id,
      name: root.name,
      title: root.title,
      done: children.filter(child => child.status === 'done').length,
      total: children.length,
    }
  })
  const placeholder = goals.length === 0 || (goals.length === 1 && goals[0].title === PLACEHOLDER_TITLE)
  const hasRequirement = goals.some(goal => goal.total > 0)
  const active = []
  const walk = (node) => {
    if (node.status === 'active') active.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  for (const root of roots) walk(root)
  return { goals, initialized: !placeholder && hasRequirement, placeholder, active }
}

/**
 * Render the digest injected before one step.
 *
 * Kept short on purpose: this text replaces a re-read of the whole chain, so it
 * must cost less than the context it saves.
 * @param {object} input - current chain and memory state.
 * @param {object} input.shaped - shaped tree of this conversation.
 * @param {object[]} [input.memory] - memory entries, strongest first.
 * @param {string} [input.folderLabel] - workspace-relative tree folder.
 * @returns {string} the digest text.
 */
export function buildDigest({ shaped, memory = [], folderLabel = 'thinking-tree/<session>' }) {
  const state = treeState(shaped)
  const lines = []
  lines.push(`${DIGEST_MARKER} 这是 thinking_tree {action:"digest"} 的按需摘要；宿主不会自动把它塞进对话。`)
  lines.push('')
  lines.push('【目标】')
  if (state.goals.length === 0) lines.push('- （尚无目标节点）')
  else for (const goal of state.goals.slice(0, 4)) lines.push(`- ${goal.title}（${goal.done}/${goal.total} 条要求完成）`)
  if (state.active.length > 0) {
    lines.push('')
    lines.push(`【当前节点】${state.active.slice(0, 3).map(node => node.title).join('；')}`)
  }
  lines.push('')
  lines.push('【记忆库】')
  const bank = renderMemoryDigest(memory, DIGEST_LIMIT)
  lines.push(bank === '' ? '- （空：把这一轮的第一条失败/教训/决定记进去）' : bank)
  lines.push('')
  lines.push('【硬性规定 · 每步生效】')
  lines.push(`1. 只有写进 ${folderLabel} 的东西算数：本轮的要求先在第二层建节点，再动手。`)
  lines.push('2. 用户提出与现有目标不同的新目标 → 用 thinking_tree {action:"add_goal"} 建新的目标链，不要塞进旧目标。')
  lines.push('3. 失败、教训、关键工具调用、做完的事 → 立刻 memory {action:"record"}，一条一行，别只写在回复里。')
  lines.push('4. 上下文被压缩后先读 00-goal.md 与记忆库，不要凭印象续做；工具结果过长时 memory {action:"prune_context", confirm:true}。')
  if (!state.initialized) {
    lines.push('')
    lines.push('【门禁】目标节点仍是占位或没有第二层要求：本步除 thinking_tree / memory / write / edit / read / glob / grep 以外，工具都会被拒绝。')
    lines.push('解除方式（一次调用）：thinking_tree {action:"init", title:"<本对话真正的目标>", requirements:[{"title":"<第一条要求>"}]}')
  }
  return lines.join('\n')
}

/**
 * Signature of the state a digest was built from. When it does not change
 * inside one turn, the digest is not injected twice.
 * @param {object} input - shaped tree and memory entries.
 * @returns {string} a short stable signature.
 */
export function digestSignature({ shaped, memory = [] }) {
  const nodes = []
  const walk = (node) => {
    nodes.push(`${node.id}:${node.status}:${node.title}`)
    for (const child of node.children ?? []) walk(child)
  }
  for (const root of shaped?.roots ?? []) walk(root)
  const memories = memory.slice(0, DIGEST_LIMIT).map(entry => `${entry.id}:${entry.updated}:${entry.hits}`)
  return createHash('sha1').update(`${nodes.join('|')}\n${memories.join('|')}`).digest('hex').slice(0, 16)
}

/**
 * Whether the messages entering one step carry a fresh user text (a turn start
 * or a steering message) instead of only tool results.
 * @param {object[]} messages - messages entering the step.
 * @returns {boolean} true when a user text that is not our own digest appears.
 */
export function hasFreshUserText(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      const text = block.text.trim()
      if (text === '' || text.startsWith(DIGEST_MARKER)) continue
      return true
    }
  }
  return false
}

/**
 * Build one user message carrying the digest.
 * @param {string} text - digest text.
 * @param {number} turn - turn number.
 * @param {number} step - step number.
 * @returns {object} a user message.
 */
export function digestMessage(text, turn, step) {
  return {
    id: `tree-digest-${turn ?? 0}-${step ?? 0}-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * The refusal text that tells the model exactly how to clear the gate.
 * @param {object} state - current chain state.
 * @returns {string} the denial reason.
 */
export function gateReason(state) {
  const goals = state?.goals ?? []
  const named = goals.length > 0 ? `当前目标节点标题仍是「${goals[0].title}」` : '当前没有目标节点'
  return [
    `【思考链门禁】${named}，或还没有第二层要求节点。`,
    '本步只能先用 thinking_tree / memory / write / edit / read / glob / grep。',
    '一次调用解除：thinking_tree {"action":"init","title":"<本对话真正的目标>","requirements":[{"title":"<第一条要求>"}]}',
    '（也可以直接 write thinking-tree 下的 00-goal.md 与其子节点文件。）',
  ].join('\n')
}

/**
 * Register the first-turn gate and the `thinking_tree` tool.
 *
 * Nothing is injected into the conversation: the chain is a file the model
 * reads, not a runtime message the Host keeps pushing. `thinking_tree
 * {action:"digest"}` returns the same compact summary on demand.
 * @param {object} ctx - Host context.
 * @param {object} deps - Host helpers.
 * @param {(sessionId: string) => Promise<object>} deps.stateOf - `{dir, exists, shaped, memory}`.
 * @param {(sessionId: string) => boolean} deps.isSubagent - whether the session is a child agent.
 * @param {(sessionId: string) => Promise<void>} deps.ensureSeed - write the placeholder goal once.
 * @param {(sessionId: string) => string} deps.folderLabel - workspace-relative tree folder.
 * @param {(sessionId: string, input: object) => Promise<object>} deps.createNode - create one node file.
 * @param {(sessionId: string, name: string, title: string) => Promise<void>} deps.setTitle - rename a node.
 * @param {(sessionId: string, name: string, body: string) => Promise<void>} deps.saveBody - replace a node body.
 * @param {(sessionId: string, name: string, text: string) => Promise<void>} deps.appendBody - append to a node body.
 * @param {(sessionId: string, name: string, status: string) => Promise<void>} deps.setStatus - set a node status.
 * @param {(sessionId: string, key: string) => Promise<object|undefined>} deps.findNode - node by file name, id, or title.
 * @param {(sessionId: string) => Promise<object>} deps.listNodes - shaped tree.
 * @returns {void}
 */
export function registerEnforcement(ctx, deps) {
  /** Sessions whose chain is known to be initialized; the gate stops reading disk. */
  const ready = new Map()

  // A chain write can remove the requirement that initialized the gate, so the
  // cache drops on the next write. This listener never touches the conversation.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'tool/call') return
      if (String(event.data?.name ?? '') !== 'thinking_tree') return
      const sessionId = session?.id
      if (typeof sessionId === 'string') ready.delete(sessionId)
    } catch {
      // Observation must never disturb the session feed.
    }
  }), 'thinking-tree: gate invalidation')

  const handlePreExecute = async (exec, next) => {
    const decision = await next()
    if (decision?.kind !== 'allow') return decision
    try {
      const agent = exec?.agent
      if (agent === undefined || agent === null) return decision
      if (ALLOWED_BEFORE_INIT.has(String(exec.name))) return decision
      if (deps.isSubagent(agent.id)) return decision
      // Once the chain is known initialized, the gate is a memory lookup: no
      // disk read per tool call.
      if (ready.has(agent.id)) return decision
      const state = await deps.stateOf(agent.id)
      if (state?.exists !== true) return decision
      const chain = treeState(state.shaped)
      if (chain.initialized) {
        ready.set(agent.id, true)
        return decision
      }
      return {
        kind: 'deny',
        reason: gateReason(chain),
        info: { name: 'thinking-tree', code: 'TREE_NOT_INITIALIZED', reason: 'chain-not-initialized' },
      }
    } catch {
      return decision
    }
  }

  ctx.effect(() => ctx.on('tools/pre-execute', handlePreExecute), 'thinking-tree: chain gate')

  untilService(ctx, 'tools', (tools) => {
    tools.register({
      name: 'thinking_tree',
      description: 'Maintain this conversation\'s thinking chain on disk: initialize the goal and its second-layer requirements, add a requirement, start a NEW goal chain when the user names a different objective, change a node status, append a note, or list the chain. Everything here is authoritative; a state the chain does not record is treated as forgotten.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['init', 'add_requirement', 'add_goal', 'status', 'note', 'list', 'digest'],
            description: 'init = rewrite the seeded goal + create its requirements (clears the first-turn gate); add_requirement = new child under the current goal; add_goal = new independent goal chain; status = set a node status; note = append evidence to a node; list = compact view; digest = the compact goal/progress/memory summary on demand (nothing is injected automatically).',
          },
          title: { type: 'string', description: 'init/add_requirement/add_goal: the node title.' },
          goal: { type: 'string', description: 'init: the objective paragraph written into the goal node body.' },
          requirements: {
            type: 'array',
            description: 'init/add_goal: second-layer requirements to create immediately.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['title'],
            },
          },
          parent: { type: 'string', description: 'add_requirement: parent node file name; omit for current goal.' },
          node: { type: 'string', description: 'status/note: node file name, id, or exact title.' },
          status: { type: 'string', enum: STATUSES, description: 'status: the new status.' },
          text: { type: 'string', description: 'note: the evidence line to append (file path, command output, result).' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderTreeText(value) }],
      },
      async execute(args, exec) {
        return await runTreeAction(args ?? {}, exec)
      },
    })
  })

  /**
   * Execute one `thinking_tree` call.
   * @param {object} args - model arguments.
   * @param {object} exec - execution contract.
   * @returns {Promise<object>} JSON-safe result.
   */
  async function runTreeAction(args, exec) {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string') return { ok: false, error: 'thinking_tree needs an owning session' }
    const action = String(args.action ?? '')
    const shaped = await deps.listNodes(sessionId)
    const goals = shaped?.roots ?? []
    const currentGoal = goals.find(root => root.title === PLACEHOLDER_TITLE) ?? goals[0]

    if (action === 'init') {
      const title = String(args.title ?? '').trim()
      if (title === '') return { ok: false, error: 'init requires a non-empty title' }
      let goalNode = currentGoal
      if (goalNode === undefined) {
        const created = await deps.createNode(sessionId, { parent: '', title, body: goalBody(title, args.goal) })
        goalNode = { name: created.name, id: created.id, title, status: 'pending' }
      } else {
        await deps.setTitle(sessionId, goalNode.name, title)
        await deps.saveBody(sessionId, goalNode.name, goalBody(title, args.goal))
        await deps.setStatus(sessionId, goalNode.name, 'active')
      }
      const created = []
      for (const requirement of Array.isArray(args.requirements) ? args.requirements : []) {
        const requirementTitle = String(requirement?.title ?? '').trim()
        if (requirementTitle === '') continue
        const node = await deps.createNode(sessionId, {
          parent: goalNode.id ?? String(goalNode.name ?? '').replace(/\.md$/, ''),
          title: requirementTitle,
          body: requirementBody(requirementTitle, requirement?.body),
        })
        created.push(node.name)
      }
      return { ok: true, action, goal: goalNode.name ?? goalNode.id, title, requirements: created }
    }

    if (action === 'add_goal') {
      const title = String(args.title ?? '').trim()
      if (title === '') return { ok: false, error: 'add_goal requires a non-empty title' }
      const node = await deps.createNode(sessionId, { parent: '', title, body: goalBody(title, args.goal) })
      const created = []
      for (const requirement of Array.isArray(args.requirements) ? args.requirements : []) {
        const requirementTitle = String(requirement?.title ?? '').trim()
        if (requirementTitle === '') continue
        const child = await deps.createNode(sessionId, {
          parent: node.id,
          title: requirementTitle,
          body: requirementBody(requirementTitle, requirement?.body),
        })
        created.push(child.name)
      }
      return { ok: true, action, goal: node.name, title, requirements: created }
    }

    if (action === 'add_requirement') {
      const title = String(args.title ?? '').trim()
      if (title === '') return { ok: false, error: 'add_requirement requires a non-empty title' }
      const parentKey = String(args.parent ?? '').trim()
      const parent = parentKey === '' ? currentGoal : await deps.findNode(sessionId, parentKey)
      if (parent === undefined) return { ok: false, error: `parent not found: ${parentKey}` }
      const node = await deps.createNode(sessionId, {
        parent: parent.id ?? String(parent.name ?? '').replace(/\.md$/, ''),
        title,
        body: requirementBody(title, args.body),
      })
      return { ok: true, action, node: node.name, parent: parent.name }
    }

    if (action === 'status') {
      const target = await deps.findNode(sessionId, String(args.node ?? ''))
      if (target === undefined) return { ok: false, error: `node not found: ${args.node}` }
      const status = String(args.status ?? '')
      if (!STATUSES.includes(status)) return { ok: false, error: `bad status ${status}` }
      await deps.setStatus(sessionId, target.name, status)
      return { ok: true, action, node: target.name, status }
    }

    if (action === 'note') {
      const target = await deps.findNode(sessionId, String(args.node ?? ''))
      if (target === undefined) return { ok: false, error: `node not found: ${args.node}` }
      const text = String(args.text ?? '').trim()
      if (text === '') return { ok: false, error: 'note requires text' }
      await deps.appendBody(sessionId, target.name, `- ${text}`)
      return { ok: true, action, node: target.name }
    }

    if (action === 'list') {
      return { ok: true, action, text: renderChain(shaped), goals: treeState(shaped).goals }
    }

    if (action === 'digest') {
      await deps.ensureSeed(sessionId)
      const state = await deps.stateOf(sessionId)
      const text = buildDigest({
        shaped: state?.shaped ?? shaped,
        memory: state?.memory ?? [],
        folderLabel: deps.folderLabel(sessionId),
      })
      return { ok: true, action, text, digest: text }
    }

    return { ok: false, error: `unknown action ${action}` }
  }
}

/**
 * Standard goal-node body.
 * @param {string} title - goal title.
 * @param {unknown} goal - objective paragraph.
 * @returns {string} Markdown body.
 */
function goalBody(title, goal) {
  const objective = String(goal ?? '').trim()
  return [
    `# ${title}`,
    '',
    '## 目标',
    objective === '' ? `待补：${title}` : objective,
    '',
    '## 做成什么样',
    '待补：可验收的行为/文件/命令。',
    '',
    '## 怎么验证',
    '待补：跑什么、看什么、预期结果。',
    '',
  ].join('\n')
}

/**
 * Standard requirement-node body.
 * @param {string} title - requirement title.
 * @param {unknown} body - optional detail.
 * @returns {string} Markdown body.
 */
function requirementBody(title, body) {
  const detail = String(body ?? '').trim()
  return [
    `# ${title}`,
    '',
    '## 做成什么样',
    detail === '' ? '待补。' : detail,
    '',
    '## 怎么验证',
    '待补。',
    '',
  ].join('\n')
}

/**
 * Render the whole chain as compact text.
 * @param {object} shaped - shaped tree.
 * @returns {string} the text.
 */
export function renderChain(shaped) {
  const lines = []
  const walk = (node, depth) => {
    const mark = node.status === 'done' ? 'x' : node.status === 'active' ? '>' : node.status === 'blocked' ? '!' : ' '
    lines.push(`${'  '.repeat(depth)}[${mark}] ${node.title} (${node.name})`)
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const root of shaped?.roots ?? []) walk(root, 0)
  return lines.length === 0 ? '（空）' : lines.join('\n')
}

/**
 * Render one tool result as plain text.
 * @param {object} value - tool result.
 * @returns {string} the text.
 */
function renderTreeText(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) return `thinking_tree: ${value.error ?? 'failed'}`
  if (typeof value.text === 'string') return value.text
  if (value.action === 'init') return `thinking_tree init: goal "${value.title}" (${value.requirements?.length ?? 0} requirements created)`
  if (value.action === 'add_goal') return `thinking_tree add_goal: "${value.title}" (${value.requirements?.length ?? 0} requirements created)`
  if (value.action === 'add_requirement') return `thinking_tree add_requirement: ${value.node}`
  if (value.action === 'status') return `thinking_tree status: ${value.node} → ${value.status}`
  if (value.action === 'note') return `thinking_tree note: appended to ${value.node}`
  return JSON.stringify(value)
}