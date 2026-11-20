/**
 * Host half of the thinking-tree bundle.
 *
 * Two responsibilities:
 *
 * 1. The `thinking-tree` skill, registered as a bundled skill provider, so the
 *    agent knows the on-disk contract and maintains the chain while it works.
 * 2. A small JSON file API over `<workspace>/thinking-tree`, which the browser
 *    half calls to render the live tree and to persist the user's edits.
 *
 * Every node is one Markdown file with YAML front matter. The folder is the
 * single source of truth for both the panel and the agent: nothing is cached
 * here, each request re-reads the directory.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The skill's identifier. */
const SKILL_NAME = 'thinking-tree'

/** Folder inside the Session workspace that holds every node file. */
const FOLDER = 'thinking-tree'

/** Bytes accepted from one node file. */
const MAX_FILE_BYTES = 200_000

/** Node files read from one folder. */
const MAX_NODES = 200

/** Route prefix. The Connection layer serves `/api` below the page's origin. */
const ROUTE_PREFIX = '/api/thinking-tree'

/** Node statuses the panel cycles through. */
const STATUSES = ['pending', 'active', 'done', 'blocked']

const SKILL_BODY_URL = new URL('./assets/thinking-tree/SKILL.md', import.meta.url)
const SELF_CHECK_SKILL_NAME = 'thinking-tree-selfcheck'
const SELF_CHECK_BODY_URL = new URL('./assets/thinking-tree-selfcheck/SKILL.md', import.meta.url)
const BREAKDOWN_SKILL_NAME = 'requirement-breakdown'
const BREAKDOWN_BODY_URL = new URL('./assets/requirement-breakdown/SKILL.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./assets/thinking-tree/', import.meta.url)),
}

const SKILL_DESCRIPTION = 'Maintain a tree-shaped chain of thought for the current task: the user\'s goal at the top, the approach and technical route in the middle, concrete steps at the bottom. Use at the start of any multi-step task, and keep updating it while working. The chain is stored as Markdown files in the workspace\'s thinking-tree folder and rendered live in the DeepSeek Harness right sidebar.'

const CANDIDATE = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  invocation: { modelInvocable: true, userInvocable: true },
  provider: 'thinking-tree',
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: 600,
  locator: SKILL_BODY_URL,
}

const skillProvider = {
  name: 'thinking-tree',
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

const SELF_CHECK_DESCRIPTION = 'Run one self-check round for the tree-shaped chain of thought: verify every requirement on the thinking-tree against evidence, finish whatever is still unfinished, and only then declare the goal passed. Invoked by the panel\'s self-check button.'

/**
 * Build a bundled skill provider for one Markdown body.
 * @param name - skill identifier.
 * @param bodyUrl - `file:` URL of the skill body.
 * @param description - one-line catalog description.
 * @param resourceDir - directory exposed as the skill's resources.
 * @returns a provider object `{ name, list, get }`.
 */
function makeSkillProvider(name, bodyUrl, description, resourceDir) {
  const candidate = {
    name,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: name,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: resourceDir },
    rank: 600,
    locator: bodyUrl,
  }
  return {
    name,
    list: () => Promise.resolve([candidate]),
    async get() {
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        resourceBase: candidate.resourceBase,
        content: await readFile(bodyUrl, 'utf8'),
      }
    },
  }
}

/** Services that must exist before this plugin activates. */
export const inject = ['skills', 'connection']

/** Cordis plugin name. */
export const name = 'thinking-tree'

/**
 * Register the skill provider and the file API.
 * @param ctx - Host context carrying the skill registry and the Connection route table.
 */
/** Set once the standing prompt reminder is registered; reported through diagnostics. */
let reminderRegistered = false

/** Set once the decomposition mandate is registered; reported through diagnostics. */
let breakdownRegistered = false

/** The reminder that puts the chain back in front of the model on every step. */
const REMINDER_TEXT = [
  '【思考链 · 每轮都要看】',
  '这个会话的思考链在 `thinking-tree/`（工作区里的一个文件夹，一个节点一个 md 文件）。',
  '',
  '每轮开始：读 `00-goal.md` 和第二层每一条要求，再看当前唯一 `active` 的那条链——不要凭记忆接着做。',
  '每轮结束：检查并更新节点。做过的节点改 `status`，正文补一行结果 + 证据（文件路径、命令输出、接口返回）；没做的保持原状，不要标 done。',
  '每做一步就更新，不要攒到最后一起写。',
  '',
  '节点正文要详细：写清用什么做、分几步、关键参数/命令/接口、做完长什么样、怎么验证。一句话的节点等于没写——面板默认只显示标题和一行摘要，点开才展开正文，所以正文写得越具体越有用。',
  '',
  '用户提了新要求：先在第二层加一个节点，再动手。',
  '收尾前：状态写进文件，不要只放在记忆里——被压缩之后只剩磁盘上的东西。',
  '自检：`00-goal.md` 的 `selfcheck: on` 时，每轮结束都会收到「开始自检 · 第 N 轮」，按 `thinking-tree-selfcheck` 技能执行。',
].join('\n')

/** The mandate that every requirement gets decomposed before any work starts. */
const BREAKDOWN_MANDATE = [
  '【收到要求先拆解 · 每轮生效】',
  '用户在对话里提出要求时，动手之前必须拆开，五问缺一不可：',
  '1. 要什么：一句话，去掉形容词，只留动词和名词。',
  '2. 做成什么样：验收标准，必须能测（哪个文件、哪条命令、什么行为）。',
  '3. 拆成几块：互不重叠，每块一个交付物。',
  '4. 每块怎么做：步骤 + 工具 + 技术路线。',
  '5. 每块怎么验证：跑什么、看什么、预期结果是什么。',
  '拆完写进 thinking-tree：第二层=要求（正文写「做成什么样 / 怎么验证」），第三层=方案（写「怎么做」），第四层=动作。',
  '禁止用「优化一下」「完善一下」「处理一下」这类无法验收的说法；出现「并且/然后」就说明该拆成两个节点。',
  '详细方法见 requirement-breakdown 技能——规则本身已在系统提示里，不依赖激活技能。',
].join('\n')

/**
 * Register the standing reminder in the system prompt, so the chain stays in the
 * model's view every step instead of relying on it remembering to look.
 * @param ctx - Host context.
 */
function registerPromptReminder(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') return
  ctx.effect(
    () => {
      const dispose = systemPrompt.context({ name: 'thinking-tree', order: 950, text: REMINDER_TEXT })
      reminderRegistered = true
      return () => {
        reminderRegistered = false
        dispose()
      }
    },
    'thinking-tree: prompt reminder',
  )
  // The decomposition mandate rides the same channel on purpose: a rule that only
  // applies when a model chooses to load a skill is a rule that sometimes does
  // not apply, and this one has to hold for every requirement.
  ctx.effect(
    () => {
      const dispose = systemPrompt.context({ name: 'requirement-breakdown', order: 940, text: BREAKDOWN_MANDATE })
      breakdownRegistered = true
      return () => {
        breakdownRegistered = false
        dispose()
      }
    },
    'thinking-tree: decomposition mandate',
  )
}

/**
 * Register the skill provider and the file API.
 * @param ctx - Host context carrying the skill registry and the Connection route table.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => skillProvider), 'thinking-tree: skill provider')
  registerPromptReminder(ctx)
  ctx.effect(
    () => ctx.skills.registerProvider(() => makeSkillProvider(
      BREAKDOWN_SKILL_NAME,
      BREAKDOWN_BODY_URL,
      'Decompose a requirement before starting: what it is, what "done" looks like, which independent pieces it splits into, how each piece is built and how each is verified. The mandate is always in the system prompt; this skill is the detailed manual.',
      fileURLToPath(new URL('./assets/requirement-breakdown/', import.meta.url)),
    )),
    'thinking-tree: breakdown skill provider',
  )
  ctx.effect(
    () => ctx.skills.registerProvider(() => makeSkillProvider(
      SELF_CHECK_SKILL_NAME,
      SELF_CHECK_BODY_URL,
      SELF_CHECK_DESCRIPTION,
      fileURLToPath(new URL('./assets/thinking-tree-selfcheck/', import.meta.url)),
    )),
    'thinking-tree: self-check skill provider',
  )

  // The self-check loop: while the goal node says `selfcheck: on`, every turn
  // that ends starts the next verification round.
  ctx.effect(
    () => ctx.on('turn/end', (payload) => { void selfCheckAfterTurn(ctx, payload) }),
    'thinking-tree: self-check loop',
  )

  const routes = [
    { path: `${ROUTE_PREFIX}/tree`, methods: ['GET'], fetch: (request) => serveTree(ctx, request) },
    { path: `${ROUTE_PREFIX}/save`, methods: ['POST'], fetch: (request) => serveSave(ctx, request) },
    { path: `${ROUTE_PREFIX}/create`, methods: ['POST'], fetch: (request) => serveCreate(ctx, request) },
    { path: `${ROUTE_PREFIX}/status`, methods: ['POST'], fetch: (request) => serveStatus(ctx, request) },
    { path: `${ROUTE_PREFIX}/title`, methods: ['POST'], fetch: (request) => serveTitle(ctx, request) },
    { path: `${ROUTE_PREFIX}/model`, methods: ['POST'], fetch: (request) => serveModel(ctx, request) },
    { path: `${ROUTE_PREFIX}/models`, methods: ['GET'], fetch: () => serveModels(ctx) },
    { path: `${ROUTE_PREFIX}/selfcheck`, methods: ['POST'], fetch: (request) => serveSelfCheck(ctx, request) },
    { path: `${ROUTE_PREFIX}/position`, methods: ['POST'], fetch: (request) => servePosition(ctx, request) },
    { path: `${ROUTE_PREFIX}/arrange`, methods: ['POST'], fetch: (request) => serveArrange(ctx, request) },
    { path: `${ROUTE_PREFIX}/diag`, methods: ['POST'], fetch: (request) => serveDiag(ctx, request) },
    { path: `${ROUTE_PREFIX}/sessions`, methods: ['GET'], fetch: () => serveSessions(ctx) },
    { path: `${ROUTE_PREFIX}/delete`, methods: ['POST'], fetch: (request) => serveDelete(ctx, request) },
  ]
  for (const route of routes) {
    ctx.effect(
      () => ctx.connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch }),
      `thinking-tree: route ${route.path}`,
    )
  }
}

/* ------------------------------------------------------------------ *
 * Workspace resolution
 * ------------------------------------------------------------------ */

/**
 * Read every node file in one folder and assemble the tree. Exported for tests.
 * @param dir - the `thinking-tree` folder.
 * @returns the flat node list, whether the folder exists, and a change signature.
 */
export { folderOf, parseFrontMatter, readTree, safeName, shapeTree, writeField }
export {
  serveArrange, serveCreate, serveDelete, serveModel, servePosition, serveSave, serveSelfCheck, serveStatus, serveTitle, serveTree,
}

/**
 * Resolve the workspace root of one Session.
 * @param ctx - Host context.
 * @param sessionId - Session identity received over the route.
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
 * Resolve a request to its folder.
 * @param ctx - Host context.
 * @param sessionId - Session identity from the query or body.
 * @returns `{ root, dir }` or a failure reason.
 */
function folderOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { error: 'missing-session', message: 'sessionId is required' }
  const root = workspaceRootOf(ctx, sessionId)
  if (root === undefined) return { error: 'unknown-session', message: `no workspace for session ${sessionId}` }
  return { root, dir: join(root, FOLDER) }
}

/* ------------------------------------------------------------------ *
 * Front matter
 * ------------------------------------------------------------------ */

/**
 * Choose the model that implements one node, or clear it to inherit.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, model }`; `provider/id` or empty.
 * @returns the model receipt.
 */
async function serveModel(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name' }, 400)
  const model = typeof input.model === 'string' ? input.model.trim().slice(0, 160) : ''
  if (model !== '' && !model.includes('/')) return json({ ok: false, error: 'bad-model', message: 'expects provider/model' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const path = join(folder.dir, name)
    let text = await readFile(path, 'utf8')
    text = writeField(text, 'model', model)
    text = writeField(text, 'updated', new Date().toISOString())
    await writeFile(path, text, 'utf8')
    return json({ ok: true, model })
  } catch (error) {
    return json({ ok: false, error: 'model-failed', message: String(error?.message ?? error) }, 500)
  }
}

/** Catalog cached for one minute: provider listing is not free. */
const modelCache = { at: 0, value: undefined }

/**
 * List the model routes this Host can dispatch to.
 * @param ctx - Host context.
 * @returns providers and their advertised models.
 */
async function serveModels(ctx) {
  const now = Date.now()
  if (modelCache.value !== undefined && now - modelCache.at < 60_000) return json({ ok: true, ...modelCache.value })
  const llm = ctx.get('llm')
  const providers = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  const models = []
  for (const provider of providers) {
    try {
      const advertised = await llm.listModels(provider.id)
      for (const model of advertised) models.push({ provider: provider.id, id: model.id, name: model.name || model.id })
    } catch {
      // A provider with no reachable endpoint simply contributes nothing.
    }
  }
  const value = { providers: providers.map(provider => ({ id: provider.id, name: provider.name || provider.id })), models }
  modelCache.at = now
  modelCache.value = value
  return json({ ok: true, ...value })
}

/** Rounds the self-check loop may run before it gives up and asks for a human. */
const MAX_SELF_CHECK_ROUNDS = 40

/**
 * The instruction a self-check round hands back to the agent.
 * @param {string} goalTitle - the goal node's title.
 * @param {number} round - this round's number.
 * @returns the prompt text.
 */
function selfCheckPrompt(goalTitle, round, pending) {
  // Kept short on purpose: this text is the user bubble the panel shows in the
  // conversation, so the procedure itself lives in the skill it names.
  const left = Number.isFinite(pending) && pending > 0 ? `（还有 ${pending} 条要求未完成）` : ''
  return [`开始自检 · 第 ${round} 轮${left}`, `用 ${SELF_CHECK_SKILL_NAME} 技能执行。目标：${goalTitle || '（见 00-goal.md）'}`].join('\n')
}

/**
 * Count the requirements that are not finished yet.
 * @param shaped - result of `shapeTree`.
 * @returns the number of depth-1 nodes whose status is not `done`.
 */
function countPending(shaped) {
  let pending = 0
  for (const node of shaped.nodes) {
    if (node.depth === 1 && node.status !== 'done') pending += 1
  }
  return pending
}

/**
 * Wake the agent so a self-check actually starts.
 *
 * `sessionController.prompt` takes a `SessionPromptRequest`: a request id, the
 * session, a delivery mode and prompt content. Passing any other shape rejects
 * silently, which is why an earlier version never started anything.
 * @param ctx - Host context.
 * @param sessionId - Session to wake.
 * @param goalTitle - goal text for the reminder.
 * @param round - self-check round number.
 * @returns `{ ok, error }`.
 */
async function pokeSelfCheck(ctx, sessionId, goalTitle, round, pending) {
  const text = selfCheckPrompt(goalTitle, round, pending)
  const controller = ctx.get('sessionController')
  if (controller !== undefined && controller !== null && typeof controller.prompt === 'function') {
    try {
      await controller.prompt({
        requestId: `selfcheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      return { ok: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      const agents = ctx.get('agents')
      const agent = agents === undefined || agents === null ? undefined : agents.get?.(sessionId)
      if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
        try {
          await agent.followup({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
          return { ok: true }
        } catch (nested) {
          return { ok: false, error: `${message} / ${String(nested?.message ?? nested)}` }
        }
      }
      return { ok: false, error: message }
    }
  }
  return { ok: false, error: 'no session controller' }
}

/**
 * Switch the self-check loop on or off for one Session.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, mode? }`; `mode` is `on`, `off`, `pass`, or omitted to toggle.
 * @returns the resulting state, whether the agent was woken, and why not.
 */
async function serveSelfCheck(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const { shaped } = await readScopedTree(folder, input.sessionId)
    const goal = shaped.roots[0]
    if (goal === undefined) return json({ ok: false, error: 'no-goal', message: 'create the goal node first' }, 400)
    // `off` means "stop asking", never "passed": only the agent's own verdict
    // may mark the goal passed, or a stop click would fake a success.
    const wanted = input.mode === 'on'
      ? 'on'
      : input.mode === 'off'
        ? 'off'
        : input.mode === 'pass'
          ? 'passed'
          : (goal.selfcheck === 'on' ? 'off' : 'on')
    const path = join(folder.dir, goal.name)
    let text = await readFile(path, 'utf8')
    text = writeField(text, 'selfcheck', wanted)
    if (wanted === 'on') text = writeField(text, 'selfcheck-round', 1)
    text = writeField(text, 'updated', new Date().toISOString())
    await writeFile(path, text, 'utf8')
    let poked = false
    let pokeError = ''
    if (wanted === 'on') {
      const pending = countPending(shaped)
      const result = await pokeSelfCheck(ctx, input.sessionId, goal.title, 1, pending)
      poked = result.ok === true
      pokeError = result.error || ''
    }
    return json({ ok: true, selfcheck: wanted, poked, pokeError })
  } catch (error) {
    return json({ ok: false, error: 'selfcheck-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Continue the self-check loop after a turn ends, while the goal still asks for it.
 * @param ctx - Host context.
 * @param payload - the `turn/end` payload.
 */
async function selfCheckAfterTurn(ctx, payload) {
  try {
    const session = payload?.session ?? payload?.agent?.session ?? (payload?.header !== undefined ? payload : undefined)
    const root = session?.header?.cwd
    const sessionId = session?.id
    if (typeof root !== 'string' || typeof sessionId !== 'string') return
    const tree = await readTree(join(root, FOLDER))
    if (!tree.exists) return
    const { shaped } = await readScopedTree({ dir: join(root, FOLDER) }, sessionId)
    const goal = shaped.roots[0]
    if (goal === undefined || goal.selfcheck !== 'on') return
    const round = Number(goal.selfcheckRound ?? 0) + 1
    const path = join(root, FOLDER, goal.name)
    let text = await readFile(path, 'utf8')
    if (round > MAX_SELF_CHECK_ROUNDS) {
      // Stop looping and hand the decision back with the reason on the node.
      text = writeField(text, 'selfcheck', 'stopped')
      text = writeField(text, 'updated', new Date().toISOString())
      await writeFile(path, text, 'utf8')
      return
    }
    text = writeField(text, 'selfcheck-round', round)
    text = writeField(text, 'updated', new Date().toISOString())
    await writeFile(path, text, 'utf8')
    setTimeout(() => { void pokeSelfCheck(ctx, sessionId, goal.title, round, countPending(shaped)) }, 600)
  } catch {
    // The loop must never break a turn.
  }
}

/**
 * Read a front matter number, treating blanks as "not pinned".
 * @param {string} value - raw scalar.
 * @returns {number|undefined} the number, or undefined.
 */
function finiteOrUndefined(value) {
  const text = String(value ?? '').trim()
  if (text === '' || text === 'null' || text === '~') return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the leading YAML block of a node file.
 * @param text - complete file contents.
 * @returns the flat key/value map and the Markdown body after the block.
 */
function parseFrontMatter(text) {
  const content = text.replace(/^\uFEFF/, '')
  if (!content.startsWith('---')) return { data: {}, body: content }
  const end = content.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: content }
  const data = {}
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    data[match[1]] = unquote(match[2])
  }
  let body = content.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { data, body }
}

/**
 * Strip YAML scalar quoting.
 * @param value - raw scalar text.
 * @returns the value without quotes.
 */
function unquote(value) {
  const text = value.trim()
  if (text === '' || text === '~' || text === 'null') return ''
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

/**
 * Render one YAML scalar, quoting only what needs it.
 * @param value - string or number to render.
 * @returns the scalar text.
 */
function quote(value) {
  if (typeof value === 'number') return String(value)
  const text = String(value ?? '')
  if (text === '') return '""'
  if (/^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .\-/()]*$/.test(text)) return text
  return JSON.stringify(text)
}

/**
 * Replace or insert one front matter field, preserving every other line.
 * @param text - the whole node file.
 * @param key - field name.
 * @param value - new value.
 * @returns the rewritten file.
 */
function writeField(text, key, value) {
  if (!text.startsWith('---')) return `---\n${key}: ${quote(value)}\n---\n\n${text}`
  const end = text.indexOf('\n---', 3)
  if (end < 0) return `---\n${key}: ${quote(value)}\n---\n\n${text}`
  const lines = text.slice(4, end).split('\n')
  let found = false
  const next = lines.map((line) => {
    const match = /^(\s*)([A-Za-z][\w-]*)\s*:/.exec(line)
    if (match === null || match[2] !== key) return line
    found = true
    return `${match[1]}${key}: ${quote(value)}`
  })
  if (!found) next.push(`${key}: ${quote(value)}`)
  return `---\n${next.join('\n')}${text.slice(end)}`
}

/* ------------------------------------------------------------------ *
 * Reading the folder
 * ------------------------------------------------------------------ */

/**
 * Reject a name that is not a plain Markdown file name in the folder.
 * @param value - candidate name.
 * @returns the name, or undefined when it is refused.
 */
function safeName(value) {
  if (typeof value !== 'string' || value === '' || value.length > 120) return undefined
  if (!value.endsWith('.md')) return undefined
  if (value.startsWith('_')) return undefined
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) return undefined
  if (value.includes('..')) return undefined
  return value
}

/**
 * Read every node file in one folder and assemble the tree.
 * @param dir - the `thinking-tree` folder.
 * @returns the flat node list, the roots, and a change signature.
 */
async function readTree(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, nodes: [], signature: 'absent' }
    throw error
  }
  const files = names.filter(name => name.endsWith('.md') && !name.startsWith('_')).sort().slice(0, MAX_NODES)
  const nodes = []
  const parts = []
  for (const name of files) {
    const path = join(dir, name)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue
    parts.push(`${name}:${info.mtimeMs}:${info.size}`)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseFrontMatter(text)
    const fallback = name.replace(/\.md$/, '')
    const orderFromName = Number.parseInt(/^(\d+)/.exec(name)?.[1] ?? '', 10)
    const pinnedX = finiteOrUndefined(data.x)
    const pinnedY = finiteOrUndefined(data.y)
    nodes.push({
      name,
      id: typeof data.id === 'string' && data.id !== '' ? data.id : fallback,
      parent: data.parent ?? '',
      order: Number.isFinite(Number(data.order)) ? Number(data.order) : (Number.isFinite(orderFromName) ? orderFromName : 999),
      title: (typeof data.title === 'string' && data.title !== '' ? data.title : firstHeading(body) || fallback),
      status: STATUSES.includes(data.status) ? data.status : 'pending',
      body: body.trimStart(),
      session: typeof data.session === 'string' ? data.session : '',
      model: typeof data.model === 'string' ? data.model : '',
      selfcheck: typeof data.selfcheck === 'string' ? data.selfcheck : '',
      selfcheckRound: Number.isFinite(Number(data['selfcheck-round'])) ? Number(data['selfcheck-round']) : 0,
      x: pinnedX,
      y: pinnedY,
      mtime: info.mtimeMs,
    })
  }
  const signature = createHash('sha1').update(parts.join('|')).digest('hex')
  return { exists: true, nodes, signature }
}

/**
 * Find the first Markdown heading in a body.
 * @param body - Markdown text.
 * @returns the heading text, or an empty string.
 */
function firstHeading(body) {
  const match = /^#{1,6}\s+(.+)$/m.exec(body)
  return match === null ? '' : match[1].trim()
}

/**
 * Link nodes by parent and compute depth and children.
 * @param nodes - flat nodes in file order.
 * @returns the flat nodes with `depth` and `children`, plus the roots.
 */
function shapeTree(nodes) {
  const byId = new Map()
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node)
  for (const node of nodes) node.children = []
  const roots = []
  for (const node of nodes) {
    const parent = node.parent === '' || node.parent === 'null' || node.parent === ':root' ? undefined : byId.get(node.parent)
    if (parent === undefined || parent === node) roots.push(node)
    else parent.children.push(node)
  }
  const compare = (a, b) => (a.order === b.order ? a.name.localeCompare(b.name) : a.order - b.order)
  const visit = (node, depth, seen, inherited) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    node.depth = depth
    // A node without its own session belongs to whichever root owns the chain.
    node.session = node.session || inherited
    node.children.sort(compare)
    for (const child of node.children) visit(child, depth + 1, seen, node.session)
  }
  const seen = new Set()
  roots.sort(compare)
  for (const root of roots) visit(root, 0, seen, '')
  // A cycle leaves nodes unreached; show them as extra roots instead of losing them.
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    node.depth = 0
    roots.push(node)
    visit(node, 0, seen, '')
  }
  return { nodes, roots }
}

/**
 * A filesystem- and front-matter-safe handle for one Session's tree.
 * @param sessionId - Session identity.
 * @returns a short stable key.
 */
function sessionKey(sessionId) {
  return String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'unknown'
}

/**
 * Read the tree that belongs to one Session.
 *
 * The folder is shared, so a root node records which Session owns its chain and
 * every descendant inherits that. Roots written before this existed are adopted
 * by the first Session that opens them, so an old tree keeps working.
 * @param folder - resolved workspace folder.
 * @param sessionId - Session identity.
 * @returns `{ tree, shaped }` scoped to the Session.
 */
async function readScopedTree(folder, sessionId) {
  const key = sessionKey(sessionId)
  const tree = await readTree(folder.dir)
  const all = shapeTree(tree.nodes)
  let adopted = false
  for (const root of all.roots) {
    if (root.session !== '') continue
    root.session = key
    adopted = true
    try {
      const path = join(folder.dir, root.name)
      let text = await readFile(path, 'utf8')
      text = writeField(text, 'session', key)
      await writeFile(path, text, 'utf8')
    } catch {
      // Adoption is best effort; the in-memory value still scopes this response.
    }
  }
  const keep = new Set()
  const walk = node => {
    keep.add(node.id)
    for (const child of node.children) walk(child)
  }
  for (const root of all.roots) if (root.session === key) walk(root)
  const nodes = tree.nodes.filter(node => keep.has(node.id))
  return { tree: { exists: tree.exists, signature: adopted ? `${tree.signature}-adopted` : tree.signature, nodes }, shaped: shapeTree(nodes) }
}

/* ------------------------------------------------------------------ *
 * Routes
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
 * Report the live Session list, so an outside observer can tell which Session a
 * running window belongs to without guessing.
 * @param ctx - Host context.
 * @returns the compact Session rows.
 */
async function serveSessions(ctx) {
  try {
    const controller = ctx.get('sessionController')
    if (controller === undefined || controller === null || typeof controller.list !== 'function') {
      return json({ ok: false, error: 'no-session-controller' }, 500)
    }
    const listed = await controller.list({}, new AbortController().signal)
    return json({
      ok: true,
      items: (listed?.items ?? []).map(item => ({
        id: item.sessionId,
        cwd: item.cwd ?? '',
        running: item.running === true,
        updatedAt: item.updatedAt ?? 0,
        blank: item.blank === true,
      })),
    })
  } catch (error) {
    return json({ ok: false, error: 'list-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Serve the whole tree of one Session.
 * @param ctx - Host context.
 * @param request - `GET` with `sessionId`.
 * @returns the tree payload.
 */
async function serveTree(ctx, request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  const folder = folderOf(ctx, sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const { tree, shaped } = await readScopedTree(folder, sessionId)
    return json({
      ok: true,
      folder: FOLDER,
      absolute: folder.dir,
      exists: tree.exists,
      signature: tree.signature,
      selfcheck: shaped.roots[0]?.selfcheck ?? '',
      selfcheckRound: shaped.roots[0]?.selfcheckRound ?? 0,
      nodes: shaped.nodes.map(node => ({
        name: node.name,
        id: node.id,
        parent: node.parent,
        order: node.order,
        title: node.title,
        status: node.status,
        body: node.body,
        model: node.model,
        selfcheck: node.selfcheck,
        selfcheckRound: node.selfcheckRound,
        depth: node.depth,
        children: node.children.map(child => child.id),
        mtime: node.mtime,
      })),
      roots: shaped.roots.map(root => root.id),
    })
  } catch (error) {
    return json({ ok: false, error: 'read-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Replace a node's body while keeping its front matter byte for byte.
 *
 * The panel sends only the Markdown body, so writing it as the whole file would
 * drop `id`, `parent`, `order`, the pinned `x`/`y`, the `model` route, and the
 * self-check flag — which silently detaches the node and loses its position.
 * @param existing - the current file contents, or an empty string.
 * @param body - the new Markdown body.
 * @returns the merged file contents.
 */
export function mergeBody(existing, body) {
  const text = String(existing ?? '')
  const content = String(body ?? '').replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return content
  const end = text.indexOf('\n---', 3)
  if (end < 0) return content
  const head = text.slice(0, end + 4)
  return `${head}\n${content}`
}

/**
 * Write one node file, keeping the front matter the panel did not send.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, content }`.
 * @returns the write receipt.
 */
async function serveSave(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name', message: 'not a node file name' }, 400)
  if (typeof input.content !== 'string') return json({ ok: false, error: 'bad-content' }, 400)
  if (input.content.length > MAX_FILE_BYTES) return json({ ok: false, error: 'too-large' }, 413)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    await mkdir(folder.dir, { recursive: true })
    const path = join(folder.dir, name)
    if (relative(folder.dir, path).startsWith('..')) return json({ ok: false, error: 'bad-name' }, 400)
    // The body arrives without its front matter, so the existing block is kept
    // byte for byte: replacing the whole file would drop id, parent, order, the
    // pinned position, and the model route.
    let existing = ''
    try {
      existing = await readFile(path, 'utf8')
    } catch {
      // A new file simply starts with the body.
    }
    const merged = mergeBody(existing, input.content)
    await writeFile(path, writeField(merged, 'updated', new Date().toISOString()), 'utf8')
    return json({ ok: true, name })
  } catch (error) {
    return json({ ok: false, error: 'write-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Create one child node under a parent.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, parent, title }`.
 * @returns the created node name.
 */
async function serveCreate(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim().slice(0, 120) : 'New node'
  const parent = typeof input.parent === 'string' ? input.parent : ''
  try {
    const tree = await readTree(folder.dir)
    const siblings = tree.nodes.filter(node => node.parent === parent)
    const order = siblings.length === 0 ? 0 : Math.max(...siblings.map(node => node.order)) + 1
    const depth = parent === '' ? 0 : 1
    const base = `${String(order).padStart(2, '0')}-${slug(title)}`
    const taken = new Set(tree.nodes.map(node => node.name))
    let name = `${base}.md`
    for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}.md`
    const id = name.replace(/\.md$/, '')
    const content = [
      '---',
      `id: ${quote(id)}`,
      `parent: ${quote(parent)}`,
      `order: ${order}`,
      `title: ${quote(title)}`,
      // A new root claims the chain for this Session; children inherit it.
      ...(parent === '' ? [`session: ${quote(sessionKey(input.sessionId))}`] : []),
      'status: pending',
      'level: ' + (depth === 0 ? 'goal' : 'step'),
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${title}`,
      '',
      '',
    ].join('\n')
    await mkdir(folder.dir, { recursive: true })
    await writeFile(join(folder.dir, name), content, 'utf8')
    return json({ ok: true, name, id })
  } catch (error) {
    return json({ ok: false, error: 'create-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Change one node's status in place.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, status }`.
 * @returns the status receipt.
 */
async function serveStatus(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name' }, 400)
  if (!STATUSES.includes(input.status)) return json({ ok: false, error: 'bad-status' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const path = join(folder.dir, name)
    const text = await readFile(path, 'utf8')
    await writeFile(path, writeField(writeField(text, 'status', input.status), 'updated', new Date().toISOString()), 'utf8')
    return json({ ok: true, status: input.status })
  } catch (error) {
    return json({ ok: false, error: 'status-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Rename one node: front matter `title` only, body untouched.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, title }`.
 * @returns the rename receipt.
 */
async function serveTitle(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name' }, 400)
  if (typeof input.title !== 'string' || input.title.trim() === '') return json({ ok: false, error: 'bad-title' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const path = join(folder.dir, name)
    const text = await readFile(path, 'utf8')
    const title = input.title.trim().slice(0, 160)
    await writeFile(path, writeField(writeField(text, 'title', title), 'updated', new Date().toISOString()), 'utf8')
    return json({ ok: true, title })
  } catch (error) {
    return json({ ok: false, error: 'title-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Pin or unpin one node's canvas position: front matter `x` / `y` only.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, x, y }`; a blank coordinate unpins it.
 * @returns the position receipt.
 */
async function servePosition(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  const x = input.x
  const y = input.y
  const pinned = typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
  try {
    const path = join(folder.dir, name)
    let text = await readFile(path, 'utf8')
    text = writeField(text, 'x', pinned ? Math.round(x) : '')
    text = writeField(text, 'y', pinned ? Math.round(y) : '')
    text = writeField(text, 'updated', new Date().toISOString())
    await writeFile(path, text, 'utf8')
    return json({ ok: true, pinned })
  } catch (error) {
    return json({ ok: false, error: 'position-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Clear every pinned position so the whole map goes back to automatic layout.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId }`.
 * @returns the number of nodes unpinned.
 */
async function serveArrange(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const tree = await readTree(folder.dir)
    let cleared = 0
    for (const node of tree.nodes) {
      if (node.x === undefined && node.y === undefined) continue
      const path = join(folder.dir, node.name)
      let text = await readFile(path, 'utf8')
      text = writeField(text, 'x', '')
      text = writeField(text, 'y', '')
      await writeFile(path, text, 'utf8')
      cleared += 1
    }
    return json({ ok: true, cleared })
  } catch (error) {
    return json({ ok: false, error: 'arrange-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Store a browser-side diagnostic snapshot in the temp directory.
 *
 * The client cannot log to the Host's stdout, so this is how a rendering
 * failure is observed from outside: the browser posts what it measured and the
 * payload lands in a file a shell can read.
 * @param request - `POST` with any JSON body.
 * @returns the stored path.
 */
async function serveDiag(ctx, request) {
  const text = await request.text()
  const path = join(tmpdir(), 'thinking-tree-diag.json')
  try {
    let payload = {}
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
    payload.reminder = reminderRegistered
    payload.breakdown = breakdownRegistered
    // Always attach the live Session list: it is how an outside observer can
    // tell which Session a window belongs to without guessing.
    try {
      const controller = ctx.get('sessionController')
      if (controller !== undefined && controller !== null && typeof controller.list === 'function') {
        const listed = await controller.list({}, new AbortController().signal)
        payload.sessions = (listed?.items ?? []).map(item => ({
          id: item.sessionId,
          cwd: item.cwd ?? '',
          running: item.running === true,
          updatedAt: item.updatedAt ?? 0,
        }))
      }
    } catch (error) {
      payload.sessionsError = String(error?.message ?? error)
    }
    // Merge instead of replacing: several self-reports arrive close together and
      // the last writer would otherwise hide the others.
      let merged = payload
      try {
        const previous = JSON.parse(await readFile(path, 'utf8'))
        merged = { ...previous, ...payload }
        // Keep one slot per report stage so nothing is lost to write order.
        const reports = { ...(previous.reports ?? {}) }
        if (typeof payload.stage === 'string') reports[payload.stage] = payload
        merged.reports = reports
      } catch {
        merged = { ...payload, reports: typeof payload.stage === 'string' ? { [payload.stage]: payload } : {} }
      }
      await writeFile(path, JSON.stringify(merged), 'utf8')
    return json({ ok: true, path })
  } catch (error) {
    return json({ ok: false, error: 'diag-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Delete one node and, when asked, its descendants.
 * @param ctx - Host context.
 * @param request - `POST` `{ sessionId, name, cascade }`.
 * @returns the deleted file names.
 */
async function serveDelete(ctx, request) {
  const input = await readJson(request)
  if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
  const name = safeName(input.name)
  if (name === undefined) return json({ ok: false, error: 'bad-name' }, 400)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    const tree = await readTree(folder.dir)
    const shaped = shapeTree(tree.nodes)
    const start = shaped.nodes.find(node => node.name === name)
    const targets = new Set([name])
    if (input.cascade === true && start !== undefined) {
      const byId = new Map(shaped.nodes.map(node => [node.id, node]))
      const visited = new Set()
      const walk = (node) => {
        if (visited.has(node.id)) return
        visited.add(node.id)
        targets.add(node.name)
        for (const childId of node.children.map(child => child.id)) {
          const child = byId.get(childId)
          if (child !== undefined) walk(child)
        }
      }
      walk(start)
    }
    const deleted = []
    for (const target of targets) {
      try {
        await unlink(join(folder.dir, target))
        deleted.push(target)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return json({ ok: true, deleted })
  } catch (error) {
    return json({ ok: false, error: 'delete-failed', message: String(error?.message ?? error) }, 500)
  }
}

/**
 * Turn a title into a file-name segment.
 * @param title - node title.
 * @returns a lowercase kebab-case segment.
 */
function slug(title) {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii === '' ? 'node' : ascii
}