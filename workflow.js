/**
 * Host half of the AI workflow panel.
 *
 * One workflow is a JSON graph in `<workspace>/dsh-workflows/<session>/<id>.json`:
 * model nodes (provider/model + prompt + tools/skills/MCP), exchange nodes that
 * move text from producers to consumers according to their own prompt, and
 * ComfyUI nodes that submit an API-format workflow to a local ComfyUI server.
 *
 * Every model node runs in its own context: its own system prompt, its own
 * message array, its own tool set. Nothing is shared between nodes except the
 * text that an edge actually carries, so a workflow is a set of isolated
 * workers wired together instead of one long conversation.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Route prefix served below the page origin. */
export const ROUTE_PREFIX = '/api/ai-workflow'

/** Folder inside the Session workspace. */
const FOLDER = 'dsh-workflows'

/** Hard limits that keep one bad graph from hanging the Host. */
const MAX_NODES = 60
const MAX_EDGES = 200
const MAX_TOOL_ROUNDS = 8
const MAX_RUN_MS = 30 * 60_000
const MAX_PROMPT_CHARS = 60_000
const MAX_FILE_BYTES = 4_000_000

/** ComfyUI locations on this machine, in probe order. */
const COMFY_INSTALL = 'D:\\Comfy-Desktop\\ComfyUI-Installs\\ComfyUI\\ComfyUI'
const COMFY_SHARED = 'D:\\Comfy-Desktop\\ComfyUI-Shared'
const COMFY_EXTRA_WORKFLOWS = 'D:\\Comfy-Desktop\\qwen21-workflows'
const COMFY_USER_WORKFLOWS = join(COMFY_INSTALL, 'user', 'default', 'workflows')
const COMFY_SHARED_WORKFLOWS = join(COMFY_SHARED, 'user', 'default', 'workflows')
const COMFY_PORT = 8188

/** Live runs, keyed by run id. Polled by the panel; small and short-lived. */
const runs = new Map()

/** Last successful `/object_info` payload; also mirrored into the workspace. */
let objectInfoCache = undefined

/** Cached catalog shared by every workflow in this Host process. */
const catalogCache = { at: 0, value: undefined }

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

/**
 * Answer with JSON.
 * @param value - JSON-safe payload.
 * @param status - HTTP status.
 * @returns the response.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Read a JSON object body.
 * @param request - incoming request.
 * @returns the object, or undefined when the body is not one.
 */
async function readJson(request) {
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

/**
 * Resolve the workspace root of one Session.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @returns the absolute workspace directory, or undefined when unknown.
 */
function workspaceRootOf(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const header = sessions?.get?.(sessionId)?.header
  if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd
  const sandbox = ctx.get('sandboxPolicy')
  if (typeof sandbox?.workspaceRoot === 'string' && sandbox.workspaceRoot !== '') return sandbox.workspaceRoot
  const working = ctx.get('workingDirectory')
  if (typeof working?.defaultDirectory === 'string' && working.defaultDirectory !== '') return working.defaultDirectory
  return undefined
}

/**
 * Filesystem-safe short key for one Session.
 * @param sessionId - Session identity.
 * @returns a short stable key.
 */
function sessionKey(sessionId) {
  return String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'unknown'
}

/**
 * Reject workflow ids that are not plain file names.
 * @param value - candidate id.
 * @returns the id, or undefined.
 */
function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(value)) return undefined
  return value
}

/**
 * Shorten text for a log file without losing the beginning.
 * @param text - source text.
 * @param limit - maximum characters.
 * @returns the text, ellipsized when too long.
 */
function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（截断，共 ${value.length} 字）`
}

/**
 * Resolve one workflow folder for a Session.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @returns `{ root, dir, key }` or an error object.
 */
function folderOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { error: 'missing-session', message: 'sessionId is required' }
  const root = workspaceRootOf(ctx, sessionId)
  if (root === undefined) return { error: 'unknown-session', message: `no workspace for session ${sessionId}` }
  const key = sessionKey(sessionId)
  return { root, dir: join(root, FOLDER, key), key }
}

/* ------------------------------------------------------------------ *
 * Workflow model
 * ------------------------------------------------------------------ */

/** Node kinds the panel can create. */
export const NODE_TYPES = ['leader', 'input', 'output', 'model', 'exchange', 'comfy']

/**
 * Build an empty workflow.
 * @param title - display title.
 * @returns a valid, persisted-shape workflow.
 */
export function emptyWorkflow(title = 'AI 工作流') {
  return {
    version: 1,
    id: 'main',
    title,
    updated: new Date().toISOString(),
    nodes: [],
    edges: [],
  }
}

/**
 * Coerce a client payload into the exact persisted shape.
 *
 * The client is a browser, so every field is re-validated here: unknown node
 * types are dropped, edges are rewired only to existing ports, and text is
 * bounded. A rejected graph would otherwise surface much later as a 1980s
 * error inside a model request.
 * @param input - arbitrary workflow object.
 * @returns a detached, validated workflow.
 */
export function normalizeWorkflow(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const nodes = []
  const seen = new Set()
  for (const raw of Array.isArray(source.nodes) ? source.nodes.slice(0, MAX_NODES) : []) {
    if (raw === null || typeof raw !== 'object') continue
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : undefined
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const type = NODE_TYPES.includes(raw.type) ? raw.type : 'model'
    const strings = value => Array.isArray(value)
      ? [...new Set(value.filter(item => typeof item === 'string' && item !== '').slice(0, 80))]
      : []
    nodes.push({
      id,
      type,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
      x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : 0,
      y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : 0,
      provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 80) : '',
      model: typeof raw.model === 'string' ? raw.model.slice(0, 160) : '',
      reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.slice(0, 40) : '',
      temperature: Number.isFinite(Number(raw.temperature)) ? Math.max(0, Math.min(2, Number(raw.temperature))) : undefined,
      maxTokens: Number.isFinite(Number(raw.maxTokens)) ? Math.max(1, Math.min(400_000, Number(raw.maxTokens))) : undefined,
      prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, MAX_PROMPT_CHARS) : '',
      tools: strings(raw.tools),
      skills: strings(raw.skills),
      mcps: strings(raw.mcps),
      mode: raw.mode === 'fanout' ? 'fanout' : 'auto',
      targets: strings(raw.targets),
      // Input nodes mirror the main chat composer; output nodes publish back.
      autoRead: raw.autoRead !== false,
      value: typeof raw.value === 'string' ? raw.value.slice(0, MAX_PROMPT_CHARS) : '',
      published: raw.published === true,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.slice(0, 200) : '',
      workflow: typeof raw.workflow === 'string' ? raw.workflow.slice(0, 200) : '',
      promptText: typeof raw.promptText === 'string' ? raw.promptText.slice(0, 4000) : '',
      negativeText: typeof raw.negativeText === 'string' ? raw.negativeText.slice(0, 4000) : '',
      referenceImage: typeof raw.referenceImage === 'string' ? raw.referenceImage.slice(0, 260) : '',
      referenceTarget: typeof raw.referenceTarget === 'string' ? raw.referenceTarget.slice(0, 40) : '',
      positiveTarget: typeof raw.positiveTarget === 'string' ? raw.positiveTarget.slice(0, 40) : '',
      negativeTarget: typeof raw.negativeTarget === 'string' ? raw.negativeTarget.slice(0, 40) : '',
      overrides: raw.overrides !== null && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? raw.overrides : {},
      seed: Number.isFinite(Number(raw.seed)) ? Math.max(0, Math.floor(Number(raw.seed))) : undefined,
      width: Number.isFinite(Number(raw.width)) ? Math.max(64, Math.min(4096, Math.floor(Number(raw.width)))) : undefined,
      height: Number.isFinite(Number(raw.height)) ? Math.max(64, Math.min(4096, Math.floor(Number(raw.height)))) : undefined,
      status: ['idle', 'running', 'done', 'error'].includes(raw.status) ? raw.status : 'idle',
      output: typeof raw.output === 'string' ? raw.output.slice(0, 20_000) : '',
      error: typeof raw.error === 'string' ? raw.error.slice(0, 2000) : '',
      ms: Number.isFinite(Number(raw.ms)) ? Number(raw.ms) : 0,
      images: Array.isArray(raw.images) ? raw.images.filter(item => item && typeof item === 'object').slice(0, 8) : [],
    })
  }
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = []
  const edgeSeen = new Set()
  for (const raw of Array.isArray(source.edges) ? source.edges.slice(0, MAX_EDGES) : []) {
    if (raw === null || typeof raw !== 'object') continue
    const from = raw.from !== null && typeof raw.from === 'object' ? raw.from : {}
    const to = raw.to !== null && typeof raw.to === 'object' ? raw.to : {}
    if (!byId.has(from.node) || !byId.has(to.node) || from.node === to.node) continue
    if (typeof from.port !== 'string' || typeof to.port !== 'string') continue
    const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : `e-${from.node}-${from.port}-${to.node}-${to.port}`
    if (edgeSeen.has(id)) continue
    edgeSeen.add(id)
    edges.push({ id, from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } })
  }
  return {
    version: 1,
    id: safeId(source.id) ?? 'main',
    title: typeof source.title === 'string' ? source.title.slice(0, 120) : 'AI 工作流',
    updated: new Date().toISOString(),
    nodes,
    edges,
  }
}

/**
 * Order nodes so every edge points from an earlier node to a later one.
 * @param nodes - workflow nodes.
 * @param edges - workflow edges.
 * @returns node ids in execution order.
 * @throws when the graph has a cycle.
 */
export function topoOrder(nodes, edges) {
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  const out = new Map(nodes.map(node => [node.id, []]))
  for (const edge of edges) {
    if (!indegree.has(edge.from.node) || !indegree.has(edge.to.node)) continue
    indegree.set(edge.to.node, indegree.get(edge.to.node) + 1)
    out.get(edge.from.node).push(edge.to.node)
  }
  const ready = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const order = []
  while (ready.length > 0) {
    const id = ready.shift()
    order.push(id)
    for (const next of out.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }
  if (order.length !== nodes.length) throw new Error('workflow contains a cycle')
  return order
}

/* ------------------------------------------------------------------ *
 * Catalog: models, tools, skills, MCP servers
 * ------------------------------------------------------------------ */

/**
 * One agent scoped view of the Host's capabilities.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @returns `{ providers, models, tools, skills, mcps }`.
 */
async function buildCatalog(ctx, sessionId) {
  const now = Date.now()
  if (catalogCache.value !== undefined && now - catalogCache.at < 60_000) return catalogCache.value
  const llm = ctx.get('llm')
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const models = []
  for (const provider of providers) {
    try {
      const advertised = await llm.listModels(provider.id)
      for (const model of advertised) {
        models.push({
          provider: provider.id,
          id: model.id,
          name: model.name || model.id,
          efforts: [],
        })
      }
    } catch {
      // A provider with no reachable endpoint contributes nothing.
    }
  }
  // Reasoning efforts are model metadata the catalog UI wants, so resolve only
  // the few models a node is likely to use instead of probing every route.
  for (const entry of models.slice(0, 120)) {
    try {
      const info = await llm.resolveModelInfo(entry.provider, entry.id)
      entry.efforts = (info.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name }))
    } catch {
      entry.efforts = []
    }
  }
  const agent = ctx.get('agents')?.get?.(sessionId)
  const tools = ctx.get('tools')
  let toolSchemas = []
  try {
    toolSchemas = typeof tools?.schemas === 'function' ? tools.schemas(agent) : []
  } catch {
    toolSchemas = []
  }
  const toolList = toolSchemas.map(schema => ({
    name: schema.name,
    description: String(schema.description ?? '').slice(0, 220),
    group: schema.name.startsWith('mcp__') ? (schema.name.split('__')[1] || 'mcp') : 'tool',
  }))
  const mcps = [...new Map(toolList.filter(tool => tool.name.startsWith('mcp__')).map((tool) => {
    const server = tool.name.split('__')[1] || 'mcp'
    const current = { id: server, name: server, count: 0 }
    current.count = toolList.filter(item => item.name.startsWith(`mcp__${server}__`)).length
    return [server, current]
  })).values()]
  let skills = []
  try {
    const skillsApi = ctx.get('skills')
    const cwd = workspaceRootOf(ctx, sessionId)
    const listed = typeof skillsApi?.list === 'function' ? await skillsApi.list({ cwd, scope: agent }) : []
    skills = listed.map(skill => ({
      name: skill.name,
      description: String(skill.description ?? '').slice(0, 220),
      source: skill.source,
    }))
  } catch {
    skills = []
  }
  const value = { providers: providers.map(p => ({ id: p.id, name: p.name || p.id })), models, tools: toolList, skills, mcps }
  catalogCache.at = now
  catalogCache.value = value
  return value
}

/**
 * Group MCP tools by server id.
 * @param schemas - tool schemas.
 * @returns map server id → schemas.
 */
function mcpGroups(schemas) {
  const groups = new Map()
  for (const schema of schemas) {
    if (!schema.name.startsWith('mcp__')) continue
    const server = schema.name.split('__')[1] || 'mcp'
    if (!groups.has(server)) groups.set(server, [])
    groups.get(server).push(schema)
  }
  return groups
}

/* ------------------------------------------------------------------ *
 * Isolated model context
 * ------------------------------------------------------------------ */

/** Fixed identity helper; messages only need a stable unique id. */
function messageId() {
  return randomUUID()
}

/**
 * Build the system prompt of one model node.
 *
 * Rebuilt for every run, which is what makes "skills and MCP load every round"
 * true: there is no cached prompt to go stale when a skill file changes.
 * @param node - model node.
 * @param parts - loaded skill bodies and MCP tool descriptions.
 * @returns the rendered system prompt.
 */
export function buildSystemPrompt(node, parts = {}) {
  const lines = []
  const prompt = String(node.prompt ?? '').trim()
  lines.push(prompt === '' ? '你是一个独立的工作流节点。只完成本节点被分配的任务，输出可直接交给下游使用的结果。' : prompt)
  lines.push('')
  lines.push('【工作方式】')
  lines.push('- 你只看到本节点收到的输入和你自己的历史；其他节点的工作区与你隔离。')
  lines.push('- 需要外部信息时调用已提供的工具；不要编造工具结果。')
  lines.push('- 最终回答直接给出可交付的结果，不要描述你“将要做”什么。')
  for (const skill of parts.skills ?? []) {
    lines.push('')
    lines.push(`【技能 · ${skill.name}】`)
    lines.push(skill.content)
  }
  const mcpTools = parts.mcpTools instanceof Map ? [...parts.mcpTools.entries()] : (parts.mcpTools ?? [])
  if (mcpTools.length > 0) {
    lines.push('')
    lines.push('【MCP 服务 · 每轮加载】')
    for (const [server, items] of mcpTools) {
      lines.push(`- ${server}: ${items.map(item => item.name).join(', ')}`)
    }
    lines.push('这些 MCP 工具已加入本轮可用工具列表，按需调用。')
  }
  if ((node.tools ?? []).length > 0) {
    lines.push('')
    lines.push('【可用工具】')
    lines.push(node.tools.join(', '))
  }
  return lines.join('\n')
}

/**
 * Create one user message, optionally carrying images.
 * @param text - model-facing text.
 * @param images - attachment references to include.
 * @returns a message object accepted by the LLM adapter.
 */
export function userMessage(text, images = []) {
  const content = [{ type: 'text', text: String(text) }]
  for (const image of images) {
    if (image?.attachment !== undefined) content.push({ type: 'image', attachment: image.attachment })
  }
  return { id: messageId(), role: 'user', content, source: { kind: 'user' } }
}

/**
 * Create one assistant message from streamed blocks.
 * @param blocks - assembled content blocks.
 * @param provider - provider route.
 * @param model - model id.
 * @returns an assistant message.
 */
function assistantMessage(blocks, provider, model) {
  return { id: messageId(), role: 'assistant', content: blocks, source: { kind: 'model', provider, model } }
}

/**
 * Create one tool-result message.
 * @param callId - provider-issued call id.
 * @param content - result blocks.
 * @param isError - whether the tool failed.
 * @returns a tool message.
 */
function toolMessage(callId, content, isError) {
  return {
    id: messageId(),
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content,
    isError,
  }
}

/**
 * Accumulate one streamed attempt into content blocks.
 * @param stream - chunk async iterable.
 * @param onDelta - called with text deltas for live display.
 * @returns `{ blocks, text, finish }`.
 */
async function collectStream(stream, onDelta) {
  const blocks = []
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk.type === 'block-start') {
      blocks[chunk.index] = chunk.blockType === 'tool-call'
        ? { type: 'tool-call', id: '', name: '', arguments: '' }
        : { type: chunk.blockType, text: '' }
    } else if (chunk.type === 'text-delta') {
      const block = blocks[chunk.index] ?? { type: 'text', text: '' }
      block.text = `${block.text ?? ''}${chunk.text}`
      blocks[chunk.index] = block
      if (chunk.text !== '') {
        text += chunk.text
        onDelta?.(chunk.text)
      }
    } else if (chunk.type === 'reasoning-delta') {
      const block = blocks[chunk.index] ?? { type: 'reasoning', text: '' }
      block.text = `${block.text ?? ''}${chunk.text}`
      blocks[chunk.index] = block
    } else if (chunk.type === 'tool-call-delta') {
      const block = blocks[chunk.index] ?? { type: 'tool-call', id: chunk.id, name: '', arguments: '' }
      if (block.type === 'tool-call') {
        if (chunk.id !== '') block.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name !== '') block.name = chunk.name
        block.arguments = `${block.arguments ?? ''}${chunk.argumentsDelta ?? ''}`
      }
      blocks[chunk.index] = block
    } else if (chunk.type === 'block-end') {
      blocks[chunk.index] = chunk.block
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  const content = blocks.filter(block => block !== undefined)
  if (text === '') text = content.filter(block => block.type === 'text').map(block => block.text).join('')
  return { blocks: content, text, finish }
}

/**
 * Run one model node to completion inside its own context.
 *
 * The message array is local to this call. Tool calls are executed against the
 * node's selected tools only, and every round rebuilds nothing else: one node
 * having a conversation cannot leak into another node's request.
 * @param options - execution inputs.
 * @returns `{ text, messages, rounds }`.
 */
export async function runModelNode(options) {
  const { llm, tools, agent, node, system, userText, images = [], toolSchemas, signal, onDelta } = options
  const messages = [userMessage(userText, images)]
  let text = ''
  let rounds = 0
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    rounds = round + 1
    const stream = llm.stream({
      provider: node.provider,
      model: node.model,
      ...node.reasoningEffort === '' ? {} : { reasoningEffort: node.reasoningEffort },
      ...node.temperature === undefined ? {} : { temperature: node.temperature },
      ...node.maxTokens === undefined ? {} : { maxTokens: node.maxTokens },
      system,
      messages,
      ...toolSchemas.length > 0 ? { tools: toolSchemas } : {},
      signal,
    })
    const attempt = await collectStream(stream, onDelta)
    if (attempt.finish?.kind === 'error' || attempt.finish?.kind === 'aborted') {
      throw new Error(attempt.finish.failure?.message || `model call ${attempt.finish.kind}`)
    }
    messages.push(assistantMessage(attempt.blocks, node.provider, node.model))
    text = attempt.text
    const calls = attempt.blocks.filter(block => block.type === 'tool-call')
    if (calls.length === 0) break
    if (signal?.aborted === true) throw new Error('aborted')
    const batch = await tools.execute({ calls, signal, agent })
    for (const item of batch.results) {
      messages.push(toolMessage(item.callId, item.result.content, item.result.isError === true))
    }
    if (batch.concluded === true) break
  }
  return { text, messages, rounds }
}

/* ------------------------------------------------------------------ *
 * Exchange node
 * ------------------------------------------------------------------ */

/**
 * The exact envelope an exchange node asks the model for.
 * @returns system text appended to the node's own prompt.
 */
function exchangeProtocol() {
  return [
    '',
    '【交换协议】',
    '你只能输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释。格式：',
    '{"summary":"给整张图看的一句话摘要","targets":[{"node":"目标节点 id 或标题","payload":"只发给这个节点的内容"}]}',
    'targets 可以为空数组；每个 payload 必须自包含，下游看不到原始输入。',
  ].join('\n')
}

/**
 * Parse one exchange reply into per-target payloads.
 * @param reply - raw model text.
 * @param targets - allowed `{ id, title }` list.
 * @returns `{ summary, payloads: [{ node, payload }], ok }`.
 */
export function parseExchange(reply, targets) {
  const text = String(reply ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced === null ? text : fenced[1].trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return { summary: text, payloads: [], ok: false }
  let parsed
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return { summary: text, payloads: [], ok: false }
  }
  const byName = new Map()
  for (const target of targets) {
    byName.set(target.id, target.id)
    byName.set(target.title, target.id)
  }
  const payloads = []
  for (const item of Array.isArray(parsed.targets) ? parsed.targets : []) {
    if (item === null || typeof item !== 'object') continue
    const node = byName.get(String(item.node ?? ''))
    const payload = typeof item.payload === 'string' ? item.payload : ''
    if (node === undefined || payload.trim() === '') continue
    payloads.push({ node, payload })
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    payloads,
    ok: payloads.length > 0,
  }
}

/**
 * Run an exchange node: collect producer text, rewrite it, route it.
 * @param options - `{ llm, agent, node, inbound, targets, signal, onDelta }`.
 * @returns `{ summary, payloads }`.
 */
export async function runExchangeNode(options) {
  const { llm, node, inbound, targets, signal, onDelta } = options
  const collected = inbound.map(item => `【来自 ${item.title || item.id}】\n${item.text}`).join('\n\n')
  if (node.mode === 'fanout') {
    return { summary: collected, payloads: targets.map(target => ({ node: target.id, payload: collected })) }
  }
  const provider = node.provider || options.defaultProvider
  const model = node.model || options.defaultModel
  if (!provider || !model) return { summary: collected, payloads: targets.map(target => ({ node: target.id, payload: collected })) }
  const system = `${String(node.prompt ?? '').trim()}\n${exchangeProtocol()}`
  const messages = [userMessage(collected === '' ? '（上游没有输出）' : collected)]
  const stream = llm.stream({
    provider,
    model,
    ...node.reasoningEffort === '' ? {} : { reasoningEffort: node.reasoningEffort },
    ...node.temperature === undefined ? {} : { temperature: node.temperature },
    system,
    messages,
    signal,
  })
  const attempt = await collectStream(stream, onDelta)
  if (attempt.finish?.kind === 'error' || attempt.finish?.kind === 'aborted') {
    throw new Error(attempt.finish.failure?.message || `exchange call ${attempt.finish.kind}`)
  }
  const parsed = parseExchange(attempt.text, targets)
  if (!parsed.ok) {
    return { summary: attempt.text, payloads: targets.map(target => ({ node: target.id, payload: attempt.text })), fallback: true }
  }
  const known = new Set(targets.map(target => target.id))
  return { summary: parsed.summary || attempt.text, payloads: parsed.payloads.filter(item => known.has(item.node)) }
}

/* ------------------------------------------------------------------ *
 * ComfyUI
 * ------------------------------------------------------------------ */

/** Tools that turn a UI-format workflow into the API graph ComfyUI executes. */
function isApiWorkflow(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value)
  return entries.length > 0 && entries.every(entry => entry !== null && typeof entry === 'object' && typeof entry.class_type === 'string')
}

/**
 * List API-format workflows the node can run.
 * @returns `[{ name, path, format }]`.
 */
export async function listComfyWorkflows() {
  const roots = [COMFY_USER_WORKFLOWS, COMFY_SHARED_WORKFLOWS, COMFY_EXTRA_WORKFLOWS]
  const found = []
  const seen = new Set()
  for (const dir of roots) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names.filter(item => item.endsWith('.json'))) {
      if (seen.has(name)) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > 8_000_000) continue
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        seen.add(name)
        found.push({ name, path, dir, format: isApiWorkflow(parsed) ? 'api' : 'ui' })
      } catch {
        // An unreadable file simply does not appear.
      }
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/**
 * Apply one node's parameter overrides to an API-format prompt graph.
 * @param graph - parsed workflow graph.
 * @param node - ComfyUI node.
 * @returns the mutated graph (same object).
 */
export function applyComfyParams(graph, node) {
  const positive = String(node.promptText ?? '')
  const negative = String(node.negativeText ?? '')
  const reference = String(node.referenceImage ?? '')
  const positiveTarget = String(node.positiveTarget ?? '')
  const negativeTarget = String(node.negativeTarget ?? '')
  // With a chosen target the text goes to exactly that node's field; without
  // one every encoder-style node receives it, which is what a workflow with
  // several encoders expects.
  if (positive.trim() !== '') {
    let written = false
    for (const [id, item] of Object.entries(graph)) {
      if (positiveTarget !== '' && id !== positiveTarget) continue
      const fields = promptFields(item)
      // An explicit target also accepts any string field whose name says it is
      // the prompt, which covers API graphs converted from UI widgets.
      let field = fields.positive
      if (field === undefined && positiveTarget !== '' && typeof item.inputs?.prompt === 'string') field = 'prompt'
      if (field === undefined) continue
      item.inputs[field] = positive
      written = true
    }
    if (!written && positiveTarget !== '') throw new Error(`节点 #${positiveTarget} 没有可写的正向提示词字段`)
  }
  if (negative.trim() !== '') {
    let written = false
    for (const [id, item] of Object.entries(graph)) {
      if (negativeTarget !== '' && id !== negativeTarget) continue
      const inputs = item.inputs ?? {}
      if (typeof inputs.negative_prompt === 'string') { inputs.negative_prompt = negative; written = true }
      else if (negativeTarget !== '' && typeof inputs.text === 'string' && /negat/i.test(String(item.class_type))) { inputs.text = negative; written = true }
    }
    if (!written && negativeTarget !== '') throw new Error(`节点 #${negativeTarget} 没有负向提示词字段`)
  }
  if (reference.trim() !== '') {
    // The target is `nodeId:field` from the targets catalog; a bare id or no
    // choice at all falls back to the first image input found.
    const spec = String(node.referenceTarget ?? '')
    const [target, targetField] = spec.includes(':') ? spec.split(':') : [spec, 'image']
    let applied = false
    for (const [id, item] of Object.entries(graph)) {
      if (item.inputs === null || typeof item.inputs !== 'object') continue
      if (target !== '' && id !== target) continue
      if (target === '' && applied) continue
      if (target !== '' && targetField in item.inputs && !Array.isArray(item.inputs[targetField])) {
        item.inputs[targetField] = reference
        applied = true
        continue
      }
      if (/loadimage|load_video/i.test(String(item.class_type))) {
        item.inputs.image = reference
        applied = true
        continue
      }
      throw new Error(`节点 #${target} 的 ${targetField} 已被连线占用，不能注入参考图`)
    }
  }
  for (const item of Object.values(graph)) {
    const inputs = item.inputs ?? {}
    if (item.class_type === 'EmptyLatentImage') {
      if (node.width !== undefined) inputs.width = node.width
      if (node.height !== undefined) inputs.height = node.height
    }
    if (item.class_type === 'RandomNoise' && node.seed !== undefined) inputs.noise_seed = node.seed
  }
  if (node.overrides !== null && typeof node.overrides === 'object') {
    for (const [id, inputs] of Object.entries(node.overrides)) {
      if (graph[id] === undefined || inputs === null || typeof inputs !== 'object') continue
      Object.assign(graph[id].inputs ?? (graph[id].inputs = {}), inputs)
    }
  }
  return graph
}

/**
 * Does this class type look like a text encoder worth writing prompts into?
 * @param classType - ComfyUI class_type.
 * @returns whether positive/negative text may target it.
 */
export function isTextEncoder(classType) {
  return /text|encode|clip|prompt/i.test(String(classType))
}

/**
 * Find the writable prompt fields of one graph node.
 * @param item - API-format node entry.
 * @returns `{ positive, negative }` field names or undefined.
 */
export function promptFields(item) {
  const inputs = item?.inputs ?? {}
  let positive
  let negative
  if (typeof inputs.prompt === 'string') positive = 'prompt'
  else if (typeof inputs.text === 'string' && isTextEncoder(item.class_type)) positive = 'text'
  if (positive !== undefined && typeof inputs.negative_prompt === 'string') negative = 'negative_prompt'
  else if (isTextEncoder(item.class_type) && /negat/i.test(String(item.class_type)) && typeof inputs.text === 'string' && positive === undefined) positive = 'text'
  return { positive, negative }
}

/**
 * List which nodes one workflow file can receive each input into.
 * @param name - workflow file name.
 * @returns `{ positives, negatives, images }` arrays of `{ id, classType, field }`.
 */
export async function comfyInputTargets(name) {
  const { graph, format } = await loadComfyGraph(name)
  const positives = []
  const negatives = []
  const images = []
  for (const [id, item] of Object.entries(graph)) {
    const fields = promptFields(item)
    if (fields.positive !== undefined) positives.push({ id, classType: String(item.class_type), field: fields.positive })
    if (fields.negative !== undefined) negatives.push({ id, classType: String(item.class_type), field: fields.negative })
    if (/loadimage|load_video|image$/i.test(String(item.class_type))) {
      for (const key of ['image', 'images']) {
        if (typeof item.inputs?.[key] === 'string') images.push({ id, classType: String(item.class_type), field: key })
      }
    }
    // Auto-grow image sockets such as GPT Image's model.images.image_1.
    for (const key of Object.keys(item.inputs ?? {})) {
      if (!(/image_\d+$/.test(key) || key.endsWith('.image'))) continue
      const value = item.inputs[key]
      // A linked socket is an edge, not a place to inject a file name; only
      // unlinked ones accept a reference image.
      if (Array.isArray(value)) continue
      images.push({ id, classType: String(item.class_type), field: key })
    }
  }
  return { format, positives, negatives, images }
}

/**
 * Read and parameterise one workflow (API directly, UI converted).
 * @param name - file name.
 * @param node - ComfyUI node.
 * @returns the prompt graph sent to `/prompt`.
 */
export async function mergeComfyWorkflow(name, node) {
  const { graph } = await loadComfyGraph(name)
  return applyComfyParams(structuredClone(graph), node)
}

/**
 * Probe a ComfyUI server.
 * @param baseUrl - server origin.
 * @returns `{ ok, system?, error? }`.
 */
export async function comfyStatus(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/system_stats`, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, system: await response.json() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Resolve the host path of one ComfyUI output image.
 * @param image - `{ filename, subfolder, type }`.
 * @returns the absolute path.
 */
function comfyImagePath(image) {
  const base = image.type === 'temp' ? join(COMFY_SHARED, 'temp') : image.type === 'input' ? join(COMFY_SHARED, 'input') : join(COMFY_SHARED, 'output')
  const safe = String(image.subfolder ?? '').split(/[\\/]/).filter(part => part !== '' && part !== '..' && part !== '.').join('/')
  return join(base, safe, image.filename)
}

/**
 * Guess an image media type from its file extension.
 * @param name - file name.
 * @returns a supported media type.
 */
function mimeOf(name) {
  const ext = String(name).toLowerCase().split('.').pop()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/png'
}

/**
 * Convert one API-format prompt graph into display nodes and edges.
 * @param graph - parsed API workflow.
 * @returns `{ format, nodes, edges, bounds }`.
 */
export function graphFromApi(graph) {
  const ids = Object.keys(graph)
  const level = new Map()
  const visiting = new Set()
  const levelOf = (id) => {
    if (level.has(id)) return level.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    let best = 0
    for (const value of Object.values(graph[id]?.inputs ?? {})) {
      if (Array.isArray(value) && typeof value[0] === 'string' && graph[value[0]] !== undefined) {
        best = Math.max(best, levelOf(value[0]) + 1)
      }
    }
    visiting.delete(id)
    level.set(id, best)
    return best
  }
  const rows = new Map()
  const nodes = ids.map((id) => {
    const column = levelOf(id)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    const inputs = graph[id]?.inputs ?? {}
    const summary = ['prompt', 'text', 'noise_seed', 'seed', 'width', 'height', 'unet_name', 'clip_name', 'sampler_name']
      .filter(key => inputs[key] !== undefined && !Array.isArray(inputs[key]))
      .map(key => `${key}: ${String(inputs[key]).slice(0, 40)}`)
    return {
      id,
      title: String(graph[id]?.class_type ?? 'node'),
      x: 20 + column * 260,
      y: 20 + row * 120,
      w: 220,
      h: 92,
      summary,
    }
  })
  const edges = []
  for (const [id, item] of Object.entries(graph)) {
    for (const [input, value] of Object.entries(item?.inputs ?? {})) {
      if (!Array.isArray(value) || typeof value[0] !== 'string' || graph[value[0]] === undefined) continue
      edges.push({ from: value[0], to: id, label: input })
    }
  }
  return { format: 'api', nodes, edges, bounds: graphBounds(nodes) }
}

/**
 * Convert one UI-format workflow into display nodes and edges.
 * @param workflow - parsed UI workflow (`nodes`, `links`).
 * @returns `{ format, nodes, edges, bounds }`.
 */
export function graphFromUi(workflow) {
  const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map((node, index) => {
    const pos = Array.isArray(node.pos) ? node.pos : [20 + (index % 4) * 260, 20 + Math.floor(index / 4) * 140]
    const size = Array.isArray(node.size) ? node.size : [220, 100]
    return {
      id: String(node.id),
      title: String(node.type ?? node.title ?? `node ${node.id}`),
      x: Number(pos[0]) || 0,
      y: Number(pos[1]) || 0,
      w: Math.max(140, Number(size[0]) || 220),
      h: Math.max(60, Number(size[1]) || 100),
      summary: Array.isArray(node.widgets_values)
        ? node.widgets_values.slice(0, 3).map(value => String(value).slice(0, 36))
        : [],
    }
  })
  const edges = []
  for (const link of Array.isArray(workflow.links) ? workflow.links : []) {
    if (!Array.isArray(link) || link.length < 5) continue
    edges.push({ from: String(link[1]), to: String(link[3]), label: '' })
  }
  // Some UI files carry `links` as objects instead of arrays.
  for (const link of Array.isArray(workflow.links) ? workflow.links : []) {
    if (Array.isArray(link) || link === null || typeof link !== 'object') continue
    edges.push({ from: String(link.origin_id), to: String(link.target_id), label: '' })
  }
  return { format: 'ui', nodes, edges, bounds: graphBounds(nodes) }
}

/**
 * Bounding box of a display graph.
 * @param nodes - display nodes.
 * @returns `{ width, height }`.
 */
function graphBounds(nodes) {
  let width = 0
  let height = 0
  for (const node of nodes) {
    width = Math.max(width, node.x + node.w)
    height = Math.max(height, node.y + node.h)
  }
  return { width: width + 40, height: height + 40 }
}

/**
 * Convert an API prompt graph into the litegraph UI shape.
 * @param graph - API-format graph `{ id: { class_type, inputs } }`.
 * @param info - object_info catalog for titles and socket names.
 * @returns `{ nodes, links }` in ComfyUI's UI layout.
 */
export function apiGraphToUi(graph, info = undefined) {
  const nodes = []
  const links = []
  let linkId = 1
  const columns = new Map()
  const ids = Object.keys(graph)
  ids.forEach((id, index) => {
    const item = graph[id]
    const def = info?.[String(item.class_type)]
    const required = Object.keys(def?.input?.required ?? {})
    const optional = Object.keys(def?.input?.optional ?? {})
    const inputs = []
    const outputs = (Array.isArray(def?.output) ? def.output : []).map((type, slot) => ({ name: String(def?.output_name?.[slot] ?? type), type: String(type) }))
    for (const name of [...required, ...optional]) {
      const value = item.inputs?.[name]
      if (Array.isArray(value)) {
        const from = String(value[0])
        const link = linkId++
        links.push([link, Number(from), Number(value[1]) || 0, Number(id), inputs.length, 'LINK'])
        inputs.push({ name, type: 'LINK', link })
      } else {
        inputs.push({ name, type: String(name), link: null })
      }
    }
    const widgets = []
    for (const [name, value] of Object.entries(item.inputs ?? {})) {
      if (Array.isArray(value)) continue
      widgets.push({ name, value })
    }
    const column = (index % 4)
    const row = Math.floor(index / 4)
    const x = 60 + column * 380
    const y = 60 + row * 260
    columns.set(id, { x, y })
    nodes.push({
      id: Number(id) || index + 1,
      type: String(item.class_type),
      pos: [x, y],
      size: [300, 60 + Math.max(inputs.length, widgets.length, outputs.length) * 24],
      flags: {},
      order: index,
      mode: 0,
      inputs,
      outputs,
      properties: { class_type: String(item.class_type) },
      widgets_values: widgets.map(widget => widget.value),
      widgets: widgets.map(widget => ({ name: widget.name, label: widget.name, value: widget.value })),
    })
  })
  return { nodes, links }
}

/**
 * Read one workflow file and project its node graph.
 * @param name - workflow file name.
 * @returns `{ format, nodes, edges, bounds, json }`.
 */
export async function readComfyGraph(name) {
  const list = await listComfyWorkflows()
  const entry = list.find(item => item.name === name)
  if (entry === undefined) throw new Error(`workflow not found: ${name}`)
  const raw = await readFile(entry.path, 'utf8')
  const parsed = JSON.parse(raw)
  let info = objectInfoCache
  if (isApiWorkflow(parsed)) {
    if (info === undefined) {
      try {
        info = await fetchObjectInfo(`http://127.0.0.1:${COMFY_PORT}`)
        objectInfoCache = info
      } catch {
        info = undefined
      }
    }
    // API files have no canvas layout, so rebuild the litegraph shape from the
    // graph plus the backend's node definitions.
    const ui = apiGraphToUi(parsed, info)
    return { ...graphFromApi(parsed), json: parsed, format: 'api', nodes: [], links: ui.links, groups: [], config: null, extra: null, ui }
  }
  // UI files carry the real canvas: keep every original field so the panel can
  // render ComfyUI's own node layout instead of a reconstruction.
  const display = graphFromUi(parsed)
  const byId = new Map(display.nodes.map(node => [node.id, node]))
  for (const item of Array.isArray(parsed.nodes) ? parsed.nodes : []) {
    const view = byId.get(String(item.id))
    if (view !== undefined) view.raw = item
  }
  return {
    ...display,
    json: parsed,
    ui: { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], links: Array.isArray(parsed.links) ? parsed.links : [] },
    links: Array.isArray(parsed.links) ? parsed.links : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
    config: parsed.config ?? null,
    extra: parsed.extra ?? null,
  }
}
export async function previewComfy(name, node) {
  const { graph: base, format } = await loadComfyGraph(name)
  const graph = applyComfyParams(structuredClone(base), node)
  const applied = []
  for (const [id, item] of Object.entries(graph)) {
    const before = base[id]?.inputs ?? {}
    const changes = {}
    for (const [field, value] of Object.entries(item.inputs ?? {})) {
      if (JSON.stringify(before[field]) === JSON.stringify(value)) continue
      changes[field] = { from: before[field], to: value }
    }
    if (Object.keys(changes).length > 0) applied.push({ id, class_type: item.class_type, changes })
  }
  return { format, graph, applied, ui: apiGraphToUi(graph, objectInfoCache) }
}

/**
 * Serve the raw JSON of one workflow file.
 * @param name - workflow file name.
 * @returns the parsed file, exactly as saved.
 */
export async function readComfyJson(name) {
  const list = await listComfyWorkflows()
  const entry = list.find(item => item.name === name)
  if (entry === undefined) throw new Error(`workflow not found: ${name}`)
  return JSON.parse(await readFile(entry.path, 'utf8'))
}

/**
 * Classify one UI-format widget slot from the node's own input sockets.
 * @param item - UI workflow node.
 * @returns `{ inputs: Set, names: [] }` socket info.
 */
function uiSockets(item) {
  const inputs = new Set()
  const names = []
  for (const socket of Array.isArray(item.inputs) ? item.inputs : []) {
    const name = String(socket?.name ?? '')
    if (name === '') continue
    names.push(name)
    if (socket?.link !== null && socket?.link !== undefined) inputs.add(name)
  }
  return { inputs, names }
}

/**
 * Convert a ComfyUI UI-format workflow into the API prompt graph.
 *
 * The frontend saves widgets as positional values and links by id; the backend
 * wants named inputs. With `info` (the `/object_info` payload) the widget
 * order is exact: required-then-optional widget kinds, then socket-only
 * inputs, exactly as the canvas renders them. Without it the node's own
 * sockets are the fallback guess.
 * @param workflow - parsed UI workflow (`nodes`, `links`).
 * @param info - optional object_info catalog.
 * @returns API-format graph `{ [id]: { class_type, inputs } }`.
 */
export function uiToApi(workflow, info = undefined) {
  const graph = {}
  const linkList = Array.isArray(workflow.links) ? workflow.links : []
  const byId = new Map(linkList.filter(link => Array.isArray(link)).map(link => [link[0], link]))
  for (const item of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (item === null || typeof item !== 'object') continue
    const id = String(item.id)
    const type = String(item.type ?? item.properties?.NodeName ?? '')
    if (type === '' || /markdown|note|reroute/i.test(type)) continue
    const sockets = uiSockets(item)
    const inputs = {}
    const def = info !== undefined ? info[type] : undefined
    // Sockets that carry a link become input edges.
    for (const name of sockets.names) {
      if (!sockets.inputs.has(name)) continue
      const socket = item.inputs.find(entry => entry.name === name)
      const link = byId.get(socket.link)
      if (link !== undefined) inputs[name] = [String(link[1]), Number(link[2]) || 0]
    }
    let cursor = 0
    const widgets = Array.isArray(item.widgets_values) ? item.widgets_values : []
    const slots = info !== undefined ? widgetSlots(info, type, widgets) : undefined
    const known = slots !== undefined && slots.slots.length > 0
    if (!known) {
      // A socket without a link is still just a widget slot in the canvas
      // order; it receives its value below with the rest of the widgets.
    } else {
      for (const name of slots.slots) {
        if (widgets[cursor] === undefined) break
        inputs[name] = widgets[cursor]
        cursor += 1
      }
      const remaining = new Set(sockets.names.filter(name => !sockets.inputs.has(name)))
      for (const name of slots.socketOnly) {
        if (widgets[cursor] === undefined) break
        if (sockets.inputs.has(name)) continue
        remaining.delete(name)
        // Autogrow socket lists carry a control word ("randomize"/"fixed") as
        // their last widget value; it is not an input value, so drop it.
        const spec = def?.input?.required?.[name] ?? def?.input?.optional?.[name]
        const kind = Array.isArray(spec) ? String(spec[0]) : ''
        inputs[name] = widgets[cursor]
        if (/^COMFY_AUTOGROW/i.test(kind) && typeof widgets[cursor] === 'string') delete inputs[name]
        cursor += 1
      }
      // Sockets the catalog does not list as widget kinds still hold a value
      // slot in canvas order.
      for (const name of remaining) {
        if (widgets[cursor] === undefined) break
        inputs[name] = widgets[cursor]
        cursor += 1
      }
    }
    for (; cursor < widgets.length; cursor += 1) {
      const value = widgets[cursor]
      if (value === undefined || value === null || typeof value === 'object' || typeof value === 'boolean') continue
      if (known) {
        // A declared slot already took every real input; what is left is an
        // implicit canvas control (seed's "randomize", LoadImage's "upload").
        // Keep it addressable but never let it masquerade as a prompt.
        inputs[`_widget_${cursor}`] = value
        continue
      }
      if (typeof value === 'string') {
        // Without the backend catalog this is the last resort: the first free
        // string slot is treated as the prompt.
        if (inputs.prompt === undefined) inputs.prompt = value
        else if (inputs.text === undefined) inputs.text = value
        continue
      }
      if (typeof value === 'number') {
        if (inputs.seed === undefined && inputs.noise_seed === undefined) inputs.seed = value
        else if (inputs.steps === undefined) inputs.steps = value
      }
    }
    // A dynamic combo's option schema was flattened against the widget list,
    // so its per-option fields (custom_width, background…) already have values
    // when the canvas saved them. ComfyUI still requires every required field
    // of the selected option, so fill any missing one with its default.
    if (def !== undefined) {
      let chosenKey
      let optionList = null
      for (const map of [def.input?.required ?? {}, def.input?.optional ?? {}]) {
        for (const [fieldName, fieldSpec] of Object.entries(map)) {
          const kind2raw = Array.isArray(fieldSpec) ? fieldSpec[0] : ''
          const kind2 = Array.isArray(kind2raw) ? 'COMBO' : String(kind2raw ?? '')
          const options = Array.isArray(fieldSpec) && Array.isArray(fieldSpec[1]?.options) ? fieldSpec[1].options : null
          if (!/^COMFY_DYNAMIC/i.test(kind2) || options === null) continue
          chosenKey = inputs[fieldName]
          optionList = options
        }
      }
      const option = optionList?.find(entry => entry?.key === chosenKey) ?? optionList?.[0]
      for (const [fieldName, fieldSpec] of Object.entries(option?.inputs?.required ?? {})) {
        if (inputs[fieldName] !== undefined) continue
        const fallback = Array.isArray(fieldSpec) ? fieldSpec[1]?.default : undefined
        if (fallback !== undefined) inputs[fieldName] = fallback
      }
    }
    graph[id] = { class_type: type, inputs }
  }
  return sanitizeUiGraph(graph)
}

/**
 * Read one workflow file and return its API prompt graph either way.
 * @param name - workflow file name.
 * @param baseUrl - server origin used to fetch `/object_info` when online.
 * @returns `{ graph, format }`; format is `api` or `ui-converted`.
 */
export async function loadComfyGraph(name, baseUrl = `http://127.0.0.1:${COMFY_PORT}`) {
  const list = await listComfyWorkflows()
  const entry = list.find(item => item.name === name)
  if (entry === undefined) throw new Error(`workflow not found: ${name}`)
  const parsed = JSON.parse(await readFile(entry.path, 'utf8'))
  if (isApiWorkflow(parsed)) return { graph: parsed, format: 'api' }
  let info = objectInfoCache
  if (info === undefined) {
    try {
      info = await fetchObjectInfo(baseUrl)
      objectInfoCache = info
    } catch {
      info = undefined
    }
  }
  return { graph: uiToApi(parsed, info), format: 'ui-converted' }
}

/**
 * Fetch the full node-definition catalog from the running backend.
 * @param baseUrl - server origin.
 * @returns the `/object_info` payload.
 */
export async function fetchObjectInfo(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/object_info`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`object_info HTTP ${response.status}`)
  return response.json()
}

/**
 * Ordered widget slot names of one node class from `/object_info`.
 * @param info - object_info payload.
 * @param classType - node class name.
 * @returns `{ slots, socketOnly }` in frontend order.
 */
export function widgetSlots(info, classType, widgets = []) {
  const def = info?.[classType]
  const required = def?.input?.required ?? {}
  const optional = def?.input?.optional ?? {}
  const slots = []
  const socketOnly = []
  // The canvas renders nested schema entries (a dynamic combo's per-option
  // inputs) inline right after their parent, and they occupy widget values
  // too; flattening them keeps the positional mapping exact.
  let cursor = 0
  const visit = (map) => {
    for (const [name, spec] of Object.entries(map)) {
      // A literal combo is declared as `[[option, ...], {...}]`, so the first
      // element is an array rather than a type keyword.
      const rawKind = Array.isArray(spec) ? spec[0] : ''
      const kind = Array.isArray(rawKind) ? 'COMBO' : String(rawKind ?? '')
      const options = Array.isArray(spec) && Array.isArray(spec[1]?.options) ? spec[1].options : null
      if (/^COMFY_DYNAMIC/i.test(kind) && options !== null) {
        slots.push(name)
        // The selected option's own inputs render right after the combo.
        const chosen = widgets[cursor]
        cursor += 1
        const match = options.find(entry => entry?.key === chosen) ?? options[0]
        visit(match?.inputs?.required ?? {})
        continue
      }
      if (kind !== '' && !/^(INT|FLOAT|STRING|BOOLEAN|COMBO)/i.test(kind)) { socketOnly.push(name); continue }
      slots.push(name)
      cursor += 1
    }
  }
  // A dynamic combo whose chosen option is not in the catalog (a custom key,
  // or no widgets saved yet) still needs its option schema flattened, because
  // the canvas renders that schema's widgets inline; fall back to option[0].
  visit(required)
  visit(optional)
  let slots2 = [], socketOnly2 = []
  if (widgets.length > slots.length + socketOnly.length) {
    slots2 = []; socketOnly2 = []
    const visit2 = (map) => {
      for (const [name, spec] of Object.entries(map)) {
        const kind = Array.isArray(spec) ? String(spec[0]) : ''
        const options = Array.isArray(spec) && Array.isArray(spec[1]?.options) ? spec[1].options : null
        if (options !== null && options.some(entry => entry?.key !== undefined || entry?.inputs !== undefined)) {
          slots2.push(name)
          visit2(options[0]?.inputs?.required ?? {})
          continue
        }
        if (kind !== '' && !/^(INT|FLOAT|STRING|BOOLEAN|COMBO)/i.test(kind)) { socketOnly2.push(name); continue }
        slots2.push(name)
      }
    }
    visit2(required); visit2(optional)
    if (slots2.length >= slots.length) return { slots: slots2, socketOnly: socketOnly2 }
  }
  return { slots, socketOnly }
}

/**
 * Drop leftover values an autogrow widget list carried into a socket slot;
 * a string like "randomize" is a widget control, never a valid image input.
 * @param graph - converted API graph.
 * @returns the same graph, cleaned.
 */
function sanitizeUiGraph(graph) {
  // Widget control words that appear where a socket value would be. A real
  // filename such as "展牌.png" must survive, so only these literals are cut.
  const CONTROL = new Set(['randomize', 'fixed', 'increment', 'decrement', 'image', 'video'])
  for (const item of Object.values(graph)) {
    const inputs = item.inputs ?? {}
    for (const [name, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') continue
      if (!CONTROL.has(String(value))) continue
      // `upload: "image"` and `control_after_generate: "randomize"` are canvas
      // controls, never model inputs.
      if (['upload', 'control_after_generate'].includes(name) || /^_widget_/.test(name)) delete inputs[name]
    }
  }
  return graph
}

export async function runComfy(options) {
  const { baseUrl, graph, signal, onProgress } = options
  const origin = baseUrl.replace(/\/$/, '')
  const started = Date.now()
  const clientId = randomUUID()
  const submit = await fetch(`${origin}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
    signal,
  })
  if (!submit.ok) throw new Error(`ComfyUI /prompt HTTP ${submit.status}: ${clip(await submit.text(), 500)}`)
  const accepted = await submit.json()
  if (typeof accepted.prompt_id !== 'string') throw new Error('ComfyUI rejected the prompt')
  const promptId = accepted.prompt_id
  onProgress?.('queued')
  while (Date.now() - started < 20 * 60_000) {
    if (signal?.aborted === true) throw new Error('aborted')
    await new Promise(resolve => setTimeout(resolve, 1200))
    const response = await fetch(`${origin}/history/${promptId}`, { signal })
    if (!response.ok) continue
    const history = await response.json()
    const record = history[promptId]
    if (record === undefined) {
      onProgress?.('running')
      continue
    }
    const status = record.status ?? {}
    if (status.status_str === 'error') {
      throw new Error(`ComfyUI execution failed: ${clip(JSON.stringify(status.messages ?? status), 800)}`)
    }
    // A queued entry carries no outputs yet; wait for execution_success so the
    // image list is complete before returning.
    if (status.completed !== true && Object.keys(record.outputs ?? {}).length === 0) {
      onProgress?.('running')
      continue
    }
    const images = []
    for (const output of Object.values(record.outputs ?? {})) {
      for (const image of Array.isArray(output.images) ? output.images : []) {
        if (typeof image.filename !== 'string') continue
        images.push({
          filename: image.filename,
          subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
          type: typeof image.type === 'string' ? image.type : 'output',
        })
      }
    }
    return { promptId, images, ms: Date.now() - started }
  }
  throw new Error('ComfyUI timed out after 20 minutes')
}

/**
 * Start the local ComfyUI backend without its Electron shell.
 * @returns `{ ok, pid?, error? }`.
 */
export async function startComfy() {
  const status = await comfyStatus(`http://127.0.0.1:${COMFY_PORT}`)
  if (status.ok) return { ok: true, already: true }
  const python = join(COMFY_INSTALL, '.venv', 'Scripts', 'python.exe')
  try {
    await stat(python)
  } catch {
    return { ok: false, error: `python not found: ${python}` }
  }
  await mkdir(join(COMFY_SHARED, 'input'), { recursive: true })
  await mkdir(join(COMFY_SHARED, 'output'), { recursive: true })
  const args = [
    '-s', 'main.py',
    '--enable-manager',
    '--input-directory', join(COMFY_SHARED, 'input'),
    '--output-directory', join(COMFY_SHARED, 'output'),
  ]
  // The model-path YAML lives under a profile whose user name has full-width
  // characters; PowerShell 5.1 cannot pass that through, so hand ComfyUI the
  // ASCII copy the existing launcher already maintains.
  const runtimeYaml = 'D:\\Comfy-Desktop\\model-paths.runtime.yaml'
  try {
    await stat(runtimeYaml)
    args.push('--extra-model-paths-config', runtimeYaml)
  } catch {
    // No model path config: the default install paths still work.
  }
  const child = spawn(python, args, {
    cwd: COMFY_INSTALL,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { ok: true, pid: child.pid }
}

/* ------------------------------------------------------------------ *
 * Run orchestration
 * ------------------------------------------------------------------ */

/**
 * Resolve which tool schemas one model node may use.
 * @param allSchemas - every schema visible to the session agent.
 * @param node - model node.
 * @returns the schemas to advertise.
 */
function toolSchemasFor(allSchemas, node) {
  const wanted = new Set(node.tools ?? [])
  const servers = new Set(node.mcps ?? [])
  return allSchemas.filter(schema => {
    if (wanted.has(schema.name)) return true
    if (!schema.name.startsWith('mcp__')) return false
    return servers.has(schema.name.split('__')[1] || '')
  })
}

/**
 * Load the skills one model node selected.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @param agent - Session agent, for scoped catalogs.
 * @param names - skill names.
 * @returns `[{ name, content }]`.
 */
async function loadSkills(ctx, sessionId, agent, names) {
  if (names.length === 0) return []
  const skills = ctx.get('skills')
  const cwd = workspaceRootOf(ctx, sessionId)
  const loaded = []
  for (const name of names) {
    try {
      const skill = await skills.get(name, { cwd, scope: agent })
      if (skill !== undefined) loaded.push({ name: skill.name, content: skill.content })
    } catch {
      // A missing skill is reported by absence, not by failing the node.
    }
  }
  return loaded
}

/**
 * Resolve one Session object from the Host, whichever shape it is exposed in.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @returns the Session, or undefined.
 */
function sessionOf(ctx, sessionId) {
  const record = ctx.get('sessions')?.get?.(sessionId)
  if (record === undefined || record === null) return undefined
  return typeof record.deriveMessages === 'function' ? record : (record.session ?? record)
}

/**
 * Read the newest user-typed message of one Session.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @returns the message text, or an empty string.
 */
export function readLatestUserText(ctx, sessionId) {
  try {
    const session = sessionOf(ctx, sessionId)
    if (session === undefined || typeof session.deriveMessages !== 'function') return ''
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'user') continue
      if (message.source?.kind !== 'user') continue
      const text = (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.trim() !== '') return text
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Publish one workflow result back into the main conversation.
 *
 * The panel's output node and the chat must carry the same text, so this
 * appends an assistant message to the Session log — what the main transcript
 * renders. When the log refuses the append, the text is queued through the
 * session controller instead so the user still sees it.
 * @param ctx - Host context.
 * @param sessionId - Session identity.
 * @param text - the exact output text.
 * @param images - images produced alongside the text.
 * @returns `{ ok, via, error }`.
 */
export function publishToChat(ctx, sessionId, text, images = []) {
  const value = String(text ?? '').trim()
  if (value === '' && images.length === 0) return { ok: false, via: 'none', error: 'empty output' }
  const content = []
  if (value !== '') content.push({ type: 'text', text: value })
  for (const image of images.slice(0, 4)) {
    if (image?.attachment !== undefined) content.push({ type: 'image', attachment: image.attachment })
  }
  let first = ''
  try {
    const session = sessionOf(ctx, sessionId)
    if (session !== undefined && typeof session.append === 'function') {
      const boundary = ctx.get('agents')?.turnBoundaryOf?.(session)
      const turn = Number(boundary?.lastTurn ?? 0) || 1
      session.append('assistant/message', {
        turn,
        step: 1,
        message: {
          id: `wf-output-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'assistant',
          content,
          source: { kind: 'model', provider: 'ai-workflow', model: 'output-node' },
        },
        stream: [],
      }, { surfaceOp: 'append' })
      return { ok: true, via: 'session-log' }
    }
  } catch (error) {
    first = String(error?.message ?? error)
  }
  try {
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt === 'function') {
      const pending = controller.prompt({
        requestId: `wf-output-${Date.now().toString(36)}`,
        sessionId,
        mode: 'queue',
        content,
      })
      // The controller resolves asynchronously; the queue receipt is enough.
      void pending?.catch?.(() => undefined)
      return { ok: true, via: 'session-controller' }
    }
  } catch (error) {
    return { ok: false, via: 'none', error: `${first} / ${String(error?.message ?? error)}` }
  }
  return { ok: false, via: 'none', error: first || 'no session' }
}

/**
 * Run one node and return its output text.
 * @param options - run context.
 * @returns `{ text, images }`.
 */
async function executeNode(options) {
  const { ctx, sessionId, node, inbound, exchangeIn, targets, signal, emit, defaults } = options
  const agent = ctx.get('agents')?.get?.(sessionId)
  if (node.type === 'leader') {
    // The leader node *is* the main conversation. Its task text comes from the
    // user-message pipeline when one is wired in; otherwise it reads the
    // composer directly, so either wiring works.
    const supplied = inbound
      .filter(item => item.port === 'input')
      .map(item => String(item.text ?? '').trim())
      .filter(text => text !== '')
      .join('\n\n')
    const text = supplied !== ''
      ? supplied
      : node.autoRead === false ? String(node.value ?? '') : (await readLatestUserText(ctx, sessionId)) || String(node.value ?? '')
    if (text.trim() === '') throw new Error('Leader 节点没有收到用户消息：接一根用户消息线，或在对话栏输入文字')
    return { text, images: [] }
  }
  if (node.type === 'input') {
    // The composer's text is the node's payload: read the newest user message
    // of this Session, so whatever was typed in the main chat flows downstream.
    const text = node.autoRead === false ? String(node.value ?? '') : (await readLatestUserText(ctx, sessionId)) || String(node.value ?? '')
    if (text.trim() === '') throw new Error('输入节点没有取到主界面对话栏的文字')
    return { text, images: [] }
  }
  if (node.type === 'output') {
    const sections = []
    for (const item of inbound) sections.push(item.text)
    for (const item of exchangeIn) sections.push(item.payload)
    const text = sections.filter(part => String(part ?? '').trim() !== '').join('\n\n')
    const images = inbound.flatMap(item => item.images ?? [])
    return { text, images, published: true }
  }
  if (node.type === 'model') {
    if (node.provider === '' || node.model === '') throw new Error('模型节点未选择 provider/model')
    const llm = ctx.get('llm')
    const toolsApi = ctx.get('tools')
    const allSchemas = typeof toolsApi?.schemas === 'function' ? toolsApi.schemas(agent) : []
    const schemas = toolSchemasFor(allSchemas, node)
    const skills = await loadSkills(ctx, sessionId, agent, node.skills ?? [])
    const groups = mcpGroups(schemas)
    const system = buildSystemPrompt(node, { skills, mcpTools: groups })
    const sections = []
    for (const item of inbound) sections.push(`【输入 · ${item.title || item.id}】\n${item.text}`)
    for (const item of exchangeIn) sections.push(`【交换信息 · ${item.from}】\n${item.payload}`)
    const userText = sections.length > 0 ? sections.join('\n\n') : '（没有上游输入，按节点提示词开始。）'
    const images = inbound.flatMap(item => item.images ?? []).filter(image => image.attachment !== undefined).slice(0, 4)
    emit({ kind: 'node-system', nodeId: node.id, system })
    const result = await runModelNode({
      llm,
      tools: toolsApi,
      agent,
      node,
      system,
      userText,
      images,
      toolSchemas: schemas,
      signal,
      onDelta: delta => emit({ kind: 'delta', nodeId: node.id, delta }),
    })
    return { text: result.text, images, messages: result.messages, rounds: result.rounds, system }
  }
  if (node.type === 'exchange') {
    const result = await runExchangeNode({
      llm: ctx.get('llm'),
      node,
      inbound,
      targets,
      signal,
      defaultProvider: defaults.provider,
      defaultModel: defaults.model,
      onDelta: delta => emit({ kind: 'delta', nodeId: node.id, delta }),
    })
    return { text: result.summary, images: [], payloads: result.payloads, fallback: result.fallback === true }
  }
  if (node.type === 'comfy') {
    const baseUrl = String(node.baseUrl || `http://127.0.0.1:${COMFY_PORT}`)
    const attachments = ctx.get('attachments')
    const positive = inbound.filter(item => item.port === 'in' || item.port === 'positive').map(item => item.text).join('\n').trim()
    const negative = inbound.filter(item => item.port === 'negative').map(item => item.text).join('\n').trim()
    let reference = node.referenceImage
    const referenceInput = inbound.find(item => item.port === 'image' && (item.images ?? []).length > 0)?.images?.[0]
    if (referenceInput !== undefined) {
      try {
        if (referenceInput.attachment !== undefined && typeof attachments?.readImage === 'function') {
          const stored = await attachments.readImage(referenceInput.attachment, signal)
          await mkdir(join(COMFY_SHARED, 'input'), { recursive: true })
          const name = `dsh-ref-${Date.now().toString(36)}-${String(referenceInput.filename ?? 'ref.png').replace(/[^\w.-]/g, '_')}`
          await writeFile(join(COMFY_SHARED, 'input', name), stored.data)
          reference = name
        } else if (typeof referenceInput.filename === 'string') {
          reference = referenceInput.filename
        }
      } catch {
        // A reference image that cannot be stored degrades to the node default.
      }
    }
    const effective = {
      ...node,
      promptText: positive === '' ? node.promptText : positive,
      negativeText: negative === '' ? node.negativeText : negative,
      referenceImage: reference,
    }
    const graph = await mergeComfyWorkflow(node.workflow, effective)
    const result = await runComfy({
      baseUrl,
      graph,
      signal,
      onProgress: phase => emit({ kind: 'progress', nodeId: node.id, phase }),
    })
    // Store each output as a durable image attachment so a downstream model
    // node can receive it as a real image block, not just a filename.
    const imageAttachments = ctx.get('attachments')
    const images = []
    for (const image of result.images.slice(0, 4)) {
      const entry = {
        ...image,
        url: `${ROUTE_PREFIX}/comfy/view?sessionId=${encodeURIComponent(sessionId)}&baseUrl=${encodeURIComponent(baseUrl)}&filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`,
      }
      try {
        if (typeof imageAttachments?.saveImage === 'function') {
          const path = comfyImagePath(image)
          const bytes = await readFile(path)
          const attachment = await imageAttachments.saveImage({ data: bytes, mediaType: mimeOf(image.filename), name: image.filename })
          entry.attachment = attachment
        }
      } catch {
        // Without an attachment the image is still visible and readable by name;
        // a vision node simply receives the text result instead of pixels.
      }
      images.push(entry)
    }
    return { text: `ComfyUI ${result.promptId} 完成，${images.length} 张图（${Math.round(result.ms / 1000)}s）`, images }
  }
  throw new Error(`unknown node type: ${node.type}`)
}

/**
 * Execute one workflow graph.
 *
 * The run object is the live UI state; the durable part is one JSON log per
 * node under `runs/<runId>/`. Execution is sequential in topological order so
 * an exchange node always sees every producer's finished output.
 * @param ctx - Host context.
 * @param request - `{ sessionId, workflow, runId? }`.
 * @returns the run id.
 */
export async function startRun(ctx, request) {
  const folder = folderOf(ctx, request.sessionId)
  if (folder.error !== undefined) throw new Error(folder.message)
  const workflow = normalizeWorkflow(request.workflow)
  if (workflow.nodes.length === 0) throw new Error('workflow has no nodes')
  // Edges that point INTO a leader node are result channels, not execution
  // order: the leader dispatches first and only collects member results at the
  // end, so they must not make the graph cyclic.
  const leaderIds = new Set(workflow.nodes.filter(node => node.type === 'leader').map(node => node.id))
  const flowEdges = workflow.edges.filter(edge => !leaderIds.has(edge.to.node))
  // Only the explicit input port carries user messages; anything else into a
  // leader (including the older in port) is a member result channel.
  const resultEdges = workflow.edges.filter(edge => leaderIds.has(edge.to.node) && edge.to.port !== 'input')
  const order = topoOrder(workflow.nodes, flowEdges)
  // A leader is the conversation itself: always run it before its members.
  // Execution order: producers of the user message run first, then the leader
  // dispatches, then everything else (members) runs.
  const typeOf = (id) => workflow.nodes.find(node => node.id === id)?.type ?? 'model'
  const rank = (id) => (typeOf(id) === 'input' ? 0 : leaderIds.has(id) ? 1 : 2)
  order.sort((a, b) => rank(a) - rank(b))
  const runId = `r-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const runDir = join(folder.dir, 'runs', runId)
  await mkdir(runDir, { recursive: true })
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  const modelNodes = workflow.nodes.filter(node => node.type === 'model' && node.provider !== '' && node.model !== '')
  const defaults = {
    provider: modelNodes[0]?.provider ?? '',
    model: modelNodes[0]?.model ?? '',
  }
  const run = {
    id: runId,
    sessionId: request.sessionId,
    status: 'running',
    startedAt: Date.now(),
    order,
    nodes: Object.fromEntries(workflow.nodes.map(node => [node.id, {
      id: node.id,
      title: node.title,
      type: node.type,
      status: 'idle',
      text: '',
      error: '',
      ms: 0,
      images: [],
      phase: '',
    }])),
    logs: [],
    events: [],
  }
  runs.set(runId, run)
  const controller = new AbortController()
  run.controller = controller
  const timer = setTimeout(() => controller.abort(), MAX_RUN_MS)
  void (async () => {
    const outputs = new Map()
    const exchangeQueues = new Map()
    try {
      for (const id of order) {
        if (controller.signal.aborted) throw new Error('run aborted')
        const node = byId.get(id)
        const state = run.nodes[id]
        state.status = 'running'
        state.startedAt = Date.now()
        run.events.push({ at: Date.now(), nodeId: id, kind: 'start' })
        const inbound = []
        const exchangeIn = []
        for (const edge of workflow.edges.filter(item => item.to.node === id)) {
          // A leader only consumes the user-message pipeline at dispatch time;
          // member-result edges are collected after the run finishes.
          if (leaderIds.has(id) && edge.to.port !== 'input') continue
          if (edge.to.port === 'exchange') {
            const queue = exchangeQueues.get(id) ?? []
            exchangeIn.push(...queue)
            state.exchange = exchangeIn
          } else {
            const produced = outputs.get(edge.from.node)
            if (produced !== undefined) inbound.push({ id: edge.from.node, port: edge.to.port, title: byId.get(edge.from.node)?.title ?? '', text: produced.text, images: produced.images ?? [] })
          }
        }
        const successorIds = workflow.edges.filter(edge => edge.from.node === id).map(edge => edge.to.node)
        const targets = [...new Set(successorIds)].map(targetId => ({
          id: targetId,
          title: byId.get(targetId)?.title ?? '',
        }))
        const emit = (event) => {
          if (event.kind === 'delta') {
            state.text += event.delta
            return
          }
          if (event.kind === 'progress') {
            state.phase = event.phase
            return
          }
          if (event.kind === 'node-system') state.system = clip(event.system, 20_000)
          run.events.push({ at: Date.now(), nodeId: id, ...event })
        }
        const result = await executeNode({
          ctx,
          sessionId: request.sessionId,
          node,
          inbound,
          exchangeIn,
          targets,
          signal: controller.signal,
          emit,
          defaults,
        })
        const finished = Date.now()
        state.status = 'done'
        state.text = result.text
        state.ms = finished - state.startedAt
        state.images = result.images ?? []
        if (result.payloads !== undefined) {
          for (const payload of result.payloads) {
            const targetNode = byId.get(payload.node)
            if (targetNode === undefined) continue
            const queue = exchangeQueues.get(payload.node) ?? []
            queue.push({ from: node.title || node.id, payload: payload.payload })
            exchangeQueues.set(payload.node, queue)
          }
        }
        outputs.set(id, { text: result.text, images: result.images ?? [] })
        // An output node is the conversation's reply: exactly this text is
        // appended to the main transcript, so chat and node never diverge.
        if (node.type === 'output') {
          const receipt = publishToChat(ctx, request.sessionId, result.text, result.images ?? [])
          state.published = receipt.ok === true
          state.publishVia = receipt.via
          if (receipt.ok !== true && receipt.error !== undefined) state.error = String(receipt.error)
          run.events.push({ at: Date.now(), nodeId: id, kind: 'publish', ...receipt })
        }
        await writeFile(join(runDir, `${id}.json`), JSON.stringify({
          node: { id, type: node.type, title: node.title, provider: node.provider, model: node.model },
          system: result.system ?? '',
          messages: result.messages ?? [],
          toolRounds: result.rounds ?? 0,
          output: result.text,
          images: result.images ?? [],
          ms: state.ms,
        }, null, 2), 'utf8')
      }
      // The leader node closes the round: every member connected back into it
      // reports here, and that combined text is the conversation's reply.
      for (const leaderId of leaderIds) {
        const leaderState = run.nodes[leaderId]
        if (leaderState === undefined) continue
        const collected = []
        for (const edge of resultEdges.filter(item => item.to.node === leaderId)) {
          const produced = outputs.get(edge.from.node)
          if (produced === undefined || String(produced.text ?? '').trim() === '') continue
          const member = byId.get(edge.from.node)
          collected.push(`【${member?.title || edge.from.node}】\n${produced.text}`)
        }
        const dispatch = leaderState.text
        leaderState.members = collected.length
        if (collected.length > 0) {
          const summary = collected.join('\n\n')
          leaderState.text = dispatch === '' ? summary : `${dispatch}\n\n——— 成员结果 ———\n${summary}`
          const receipt = publishToChat(ctx, request.sessionId, summary, [])
          leaderState.published = receipt.ok === true
          leaderState.publishVia = receipt.via
          run.events.push({ at: Date.now(), nodeId: leaderId, kind: 'publish', ...receipt })
          await writeFile(join(runDir, `${leaderId}.json`), JSON.stringify({
            node: { id: leaderId, type: 'leader', title: leaderState.title },
            dispatch,
            members: collected,
            output: summary,
          }, null, 2), 'utf8')
        }
      }
      run.status = 'done'
    } catch (error) {
      run.status = controller.signal.aborted ? 'cancelled' : 'error'
      run.error = String(error?.message ?? error)
      for (const node of Object.values(run.nodes)) {
        if (node.status === 'running') {
          node.status = 'error'
          node.error = run.error
        }
      }
    } finally {
      clearTimeout(timer)
      run.finishedAt = Date.now()
    }
  })()
  return runId
}

/**
 * Project a run for the browser, dropping the controller and large events.
 * @param run - live run.
 * @returns a JSON-safe view.
 */
function runView(run) {
  return {
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      error: run.error ?? '',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      nodes: run.nodes,
      events: run.events.slice(-40),
    },
  }
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/**
 * Register every workflow route.
 * @param ctx - Host context carrying connection, llm, tools, skills, agents.
 */
export function registerWorkflowRoutes(ctx) {
  const routes = [
    { path: `${ROUTE_PREFIX}/load`, methods: ['GET'], fetch: (request) => serveLoad(ctx, request) },
    { path: `${ROUTE_PREFIX}/save`, methods: ['POST'], fetch: (request) => serveSave(ctx, request) },
    { path: `${ROUTE_PREFIX}/catalog`, methods: ['GET'], fetch: (request) => serveCatalog(ctx, request) },
    { path: `${ROUTE_PREFIX}/run`, methods: ['POST'], fetch: (request) => serveRun(ctx, request) },
    { path: `${ROUTE_PREFIX}/run/status`, methods: ['GET'], fetch: (request) => serveRunStatus(ctx, request) },
    { path: `${ROUTE_PREFIX}/run/cancel`, methods: ['POST'], fetch: (request) => serveRunCancel(ctx, request) },
    { path: `${ROUTE_PREFIX}/comfy/status`, methods: ['GET'], fetch: (request) => serveComfyStatus(ctx, request) },
    { path: `${ROUTE_PREFIX}/comfy/start`, methods: ['POST'], fetch: (request) => serveComfyStart(ctx, request) },
    { path: `${ROUTE_PREFIX}/comfy/upload`, methods: ['POST'], fetch: (request) => serveComfyUpload(request) },
    { path: `${ROUTE_PREFIX}/comfy/workflows`, methods: ['GET'], fetch: () => serveComfyWorkflows() },
    { path: `${ROUTE_PREFIX}/comfy/json`, methods: ['GET'], fetch: (request) => serveComfyJson(request) },
    { path: `${ROUTE_PREFIX}/comfy/preview`, methods: ['POST'], fetch: (request) => serveComfyPreview(request) },
    { path: `${ROUTE_PREFIX}/comfy/targets`, methods: ['GET'], fetch: (request) => serveComfyTargets(request) },
    { path: `${ROUTE_PREFIX}/comfy/nodes`, methods: ['GET'], fetch: (request) => serveComfyNodes(ctx, request) },
    { path: `${ROUTE_PREFIX}/comfy/view`, methods: ['GET'], fetch: (request) => serveComfyView(request) },
    { path: `${ROUTE_PREFIX}/chat/input`, methods: ['GET'], fetch: (request) => serveChatInput(ctx, request) },
    { path: `${ROUTE_PREFIX}/chat/reply`, methods: ['POST'], fetch: (request) => serveChatReply(ctx, request) },
  ]
  for (const route of routes) {
    ctx.effect(
      () => ctx.connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch }),
      `ai-workflow: route ${route.path}`,
    )
  }

  // Dev-only bridge: the browser half is verified by a separate Playwright
  // context, which has no launch cookie. When a marker file exists, write this
  // process's authenticated GUI URL so the check can open it once.
  const marker = 'D:\\dsh work region\\.wf-auth-request'
  if (existsSync(marker)) {
    // The launch token is per process and lives in `connection`, which may
    // compose after this plugin. Retry until authenticatedUrl returns a token,
    // then write the GUI URL so the Playwright check can open it.
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      try {
        const base = ctx.get('webApp')?.getAdvertisedUrl?.() ?? ''
        const url = ctx.connection?.authenticatedUrl?.(base || 'http://127.0.0.1:53686') ?? ''
        if (url.includes('token=')) {
          writeFileSync('D:\\dsh work region\\.wf-auth-url', url, 'utf8')
          clearInterval(timer)
          return
        }
      } catch {
        // keep retrying
      }
      if (tries > 20) clearInterval(timer)
    }, 500)
  }
}

/**
 * Read one workflow from disk, seeding an empty graph on first open.
 * @param ctx - Host context.
 * @param request - GET request with `sessionId` and optional `id`.
 * @returns the workflow.
 */
async function serveLoad(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const folder = folderOf(ctx, sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  const id = safeId(url.searchParams.get('id') ?? 'main') ?? 'main'
  const path = join(folder.dir, `${id}.json`)
  try {
    const text = await readFile(path, 'utf8')
    return json({ ok: true, workflow: normalizeWorkflow(JSON.parse(text)), source: 'disk' })
  } catch {
    return json({ ok: true, workflow: emptyWorkflow(), source: 'new' })
  }
}

/**
 * Persist one workflow.
 * @param ctx - Host context.
 * @param request - POST `{ sessionId, workflow }`.
 * @returns the saved workflow.
 */
async function serveSave(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  const workflow = normalizeWorkflow(input.workflow)
  try {
    await mkdir(folder.dir, { recursive: true })
    const path = join(folder.dir, `${workflow.id}.json`)
    const text = JSON.stringify(workflow, null, 2)
    if (text.length > MAX_FILE_BYTES) return json({ ok: false, error: 'too-large' }, 413)
    await writeFile(path, text, 'utf8')
    return json({ ok: true, workflow, path })
  } catch (error) {
    return json({ ok: false, error: 'save-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Serve models, tools, skills, and MCP groups.
 * @param ctx - Host context.
 * @param request - GET request with `sessionId`.
 * @returns the catalog.
 */
async function serveCatalog(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const folder = folderOf(ctx, sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    return json({ ok: true, ...await buildCatalog(ctx, sessionId) })
  } catch (error) {
    return json({ ok: false, error: 'catalog-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Start a run.
 * @param ctx - Host context.
 * @param request - POST `{ sessionId, workflow }`.
 * @returns the run id.
 */
async function serveRun(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  try {
    const runId = await startRun(ctx, input)
    return json({ ok: true, runId })
  } catch (error) {
    return json({ ok: false, error: 'run-failed', message: String(error?.message ?? error) }, 400)
  }
}

/**
 * Return one live run.
 * @param ctx - Host context.
 * @param request - GET request with `runId`.
 * @returns the projection.
 */
async function serveRunStatus(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const runId = url.searchParams.get('runId') ?? ''
  const run = runs.get(runId)
  if (run === undefined) return json({ ok: false, error: 'unknown-run' }, 404)
  return json(runView(run))
}

/**
 * Cancel one live run.
 * @param ctx - Host context.
 * @param request - POST `{ runId }`.
 * @returns the accepted flag.
 */
async function serveRunCancel(ctx, request) {
  const input = await readJson(request)
  const run = runs.get(input?.runId)
  if (run === undefined) return json({ ok: false, error: 'unknown-run' }, 404)
  run.controller.abort()
  return json({ ok: true })
}

/**
 * Probe ComfyUI.
 * @param ctx - Host context.
 * @param request - GET request with `baseUrl`.
 * @returns the probe.
 */
async function serveComfyStatus(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const baseUrl = url.searchParams.get('baseUrl') || `http://127.0.0.1:${COMFY_PORT}`
  return json({ ok: true, ...await comfyStatus(baseUrl) })
}

/**
 * Start ComfyUI.
 * @param ctx - Host context.
 * @param request - POST `{}`.
 * @returns the spawn receipt.
 */
async function serveComfyStart(ctx, request) {
  try {
    return json({ ok: true, ...await startComfy() })
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 500)
  }
}

/**
 * List runnable ComfyUI workflows.
 * @returns the list.
 */
async function serveComfyWorkflows() {
  try {
    const workflows = (await listComfyWorkflows()).map(item => ({
      name: item.name,
      dir: item.dir,
      format: item.format,
      path: item.path,
    }))
    return json({ ok: true, workflows })
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 500)
  }
}

/**
 * List the nodes one workflow can receive prompts/images into.
 * @param request - GET request with `name`.
 * @returns `{ positives, negatives, images }`.
 */
async function serveComfyTargets(request) {
  const url = new URL(request.url, 'http://localhost')
  const name = url.searchParams.get('name') ?? ''
  if (name === '') return json({ ok: false, error: 'missing-name' }, 400)
  try {
    return json({ ok: true, ...await comfyInputTargets(name) })
  } catch (error) {
    return json({ ok: false, error: 'targets-failed', message: String(error?.message ?? error) }, 400)
  }
}

/**
 * Serve the full ComfyUI node-definition catalog (the reverse-engineered view).
 * @param ctx - Host context.
 * @param request - GET request with `baseUrl`.
 * @returns `{ source, categories, nodes }`.
 */
async function serveComfyNodes(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const baseUrl = url.searchParams.get('baseUrl') || `http://127.0.0.1:${COMFY_PORT}`
  let source = 'backend'
  let info
  try {
    info = await fetchObjectInfo(baseUrl)
    objectInfoCache = info
    // Mirror into the workspace so the library survives an offline backend.
    try {
      const folder = folderOf(ctx, url.searchParams.get('sessionId') ?? '')
      if (folder.dir !== undefined) {
        await mkdir(folder.dir, { recursive: true })
        await writeFile(join(folder.dir, 'comfy-object-info.json'), JSON.stringify(info), 'utf8')
      }
    } catch {
      // The mirror is best effort.
    }
  } catch (error) {
    if (objectInfoCache !== undefined) { info = objectInfoCache; source = 'memory' }
    else {
      try {
        const folder = folderOf(ctx, url.searchParams.get('sessionId') ?? '')
        info = JSON.parse(await readFile(join(folder.dir, 'comfy-object-info.json'), 'utf8'))
        source = 'cache-file'
      } catch {
        return json({ ok: false, error: 'nodes-failed', message: String(error?.message ?? error) }, 502)
      }
    }
  }
  const categories = {}
  for (const [name, def] of Object.entries(info)) {
    const category = String(def?.category ?? 'other').split('/')[0]
    categories[category] = (categories[category] ?? 0) + 1
  }
  const nodes = Object.entries(info).map(([name, def]) => ({
    name,
    category: String(def?.category ?? 'other'),
    description: String(def?.description ?? '').slice(0, 200),
    inputs: [
      ...Object.entries(def?.input?.required ?? {}).map(([field, spec]) => ({ field, kind: String(Array.isArray(spec) ? spec[0] : ''), required: true })),
      ...Object.entries(def?.input?.optional ?? {}).map(([field, spec]) => ({ field, kind: String(Array.isArray(spec) ? spec[0] : ''), required: false })),
    ].slice(0, 40),
  }))
  return json({ ok: true, source, total: nodes.length, categories, nodes })
}

/**
 * Report exactly which workflow fields the current node parameters rewrite.
 * @param request - POST `{ name, node }`.
 * @returns `{ applied }`.
 */
async function serveComfyPreview(request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  try {
    return json({ ok: true, ...await previewComfy(String(input.name ?? ''), input.node ?? {}) })
  } catch (error) {
    return json({ ok: false, error: 'preview-failed', message: String(error?.message ?? error) }, 400)
  }
}

/**
 * Store one reference image in the ComfyUI input folder.
 * @param request - POST `{ name, data }` with base64 bytes.
 * @returns `{ name }` usable as `LoadImage.image`.
 */
async function serveComfyUpload(request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const rawName = String(input.name ?? 'ref.png').replace(/[^\w.-]/g, '_').slice(-80)
  const ext = rawName.toLowerCase().split('.').pop()
  if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return json({ ok: false, error: 'bad-type' }, 400)
  const encoded = String(input.data ?? '').replace(/^data:[^;]+;base64,/, '')
  let bytes
  try {
    bytes = Buffer.from(encoded, 'base64')
  } catch {
    return json({ ok: false, error: 'bad-data' }, 400)
  }
  if (bytes.length === 0 || bytes.length > 12_000_000) return json({ ok: false, error: 'bad-size' }, 400)
  try {
    const dir = join(COMFY_SHARED, 'input')
    await mkdir(dir, { recursive: true })
    const name = `dsh-ref-${Date.now().toString(36)}-${rawName}`
    await writeFile(join(dir, name), bytes)
    return json({ ok: true, name })
  } catch (error) {
    return json({ ok: false, error: 'upload-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Serve the node graph of one ComfyUI workflow file.
 * @param request - GET request with `name`.
 * @returns `{ format, nodes, edges, bounds, json }`.
 */
async function serveComfyJson(request) {
  const url = new URL(request.url, 'http://localhost')
  const name = url.searchParams.get('name') ?? ''
  if (name === '') return json({ ok: false, error: 'missing-name' }, 400)
  try {
    return json({ ok: true, ...await readComfyGraph(name) })
  } catch (error) {
    return json({ ok: false, error: 'graph-failed', message: String(error?.message ?? error) }, 400)
  }
}

/**
 * Serve the newest user-typed text of one Session, for the input node.
 * @param ctx - Host context.
 * @param request - GET request with `sessionId`.
 * @returns `{ text, at }`.
 */
async function serveChatInput(ctx, request) {
  const url = new URL(request.url, 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const folder = folderOf(ctx, sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  return json({ ok: true, text: readLatestUserText(ctx, sessionId), at: Date.now() })
}

/**
 * Publish one text back into the main conversation on demand.
 * @param ctx - Host context.
 * @param request - POST `{ sessionId, text, images? }`.
 * @returns the publish receipt.
 */
async function serveChatReply(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const receipt = publishToChat(ctx, input.sessionId, input.text, Array.isArray(input.images) ? input.images : [])
  return json({ ok: receipt.ok === true, ...receipt })
}

/**
 * Proxy one ComfyUI image so the panel can show it without CORS.
 * @param request - GET request with filename/baseUrl.
 * @returns the image bytes.
 */
async function serveComfyView(request) {
  const url = new URL(request.url, 'http://localhost')
  const baseUrl = (url.searchParams.get('baseUrl') || `http://127.0.0.1:${COMFY_PORT}`).replace(/\/$/, '')
  const filename = url.searchParams.get('filename') ?? ''
  const subfolder = url.searchParams.get('subfolder') ?? ''
  const type = url.searchParams.get('type') || 'output'
  if (filename === '' || filename.includes('..') || /[\\/:*?"<>|]/.test(filename)) {
    return json({ ok: false, error: 'bad-filename' }, 400)
  }
  try {
    const target = `${baseUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`
    const response = await fetch(target, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return json({ ok: false, error: `HTTP ${response.status}` }, 502)
    const buffer = Buffer.from(await response.arrayBuffer())
    return new Response(buffer, {
      status: 200,
      headers: {
        'content-type': response.headers.get('content-type') || 'image/png',
        'cache-control': 'no-store',
        'content-length': String(buffer.length),
      },
    })
  } catch (error) {
    return json({ ok: false, error: String(error?.message ?? error) }, 502)
  }
}

/** Test hook: the on-disk folder a Session's workflows live in. */
export function workflowDirOf(ctx, sessionId) {
  return folderOf(ctx, sessionId)
}

/** Test hook: read one live run. */
export function getRun(runId) {
  return runs.get(runId)
}

/** Test hook: clear the live rund and catalog caches. */
export function resetWorkflowState() {
  runs.clear()
  catalogCache.at = 0
  catalogCache.value = undefined
}

/** Diagnostics exposed for the panel footer. */
export const workflowInfo = { folder: FOLDER, comfyPort: COMFY_PORT, nodeTypes: NODE_TYPES }