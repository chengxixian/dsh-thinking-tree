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

/** Services that must exist before this plugin activates. */
export const inject = ['skills', 'connection']

/** Cordis plugin name. */
export const name = 'thinking-tree'

/**
 * Register the skill provider and the file API.
 * @param ctx - Host context carrying the skill registry and the Connection route table.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => skillProvider), 'thinking-tree: skill provider')

  const routes = [
    { path: `${ROUTE_PREFIX}/tree`, methods: ['GET'], fetch: (request) => serveTree(ctx, request) },
    { path: `${ROUTE_PREFIX}/save`, methods: ['POST'], fetch: (request) => serveSave(ctx, request) },
    { path: `${ROUTE_PREFIX}/create`, methods: ['POST'], fetch: (request) => serveCreate(ctx, request) },
    { path: `${ROUTE_PREFIX}/status`, methods: ['POST'], fetch: (request) => serveStatus(ctx, request) },
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
    nodes.push({
      name,
      id: typeof data.id === 'string' && data.id !== '' ? data.id : fallback,
      parent: data.parent ?? '',
      order: Number.isFinite(Number(data.order)) ? Number(data.order) : (Number.isFinite(orderFromName) ? orderFromName : 999),
      title: (typeof data.title === 'string' && data.title !== '' ? data.title : firstHeading(body) || fallback),
      status: STATUSES.includes(data.status) ? data.status : 'pending',
      body: body.trimStart(),
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
  const visit = (node, depth, seen) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    node.depth = depth
    node.children.sort(compare)
    for (const child of node.children) visit(child, depth + 1, seen)
  }
  const seen = new Set()
  roots.sort(compare)
  for (const root of roots) visit(root, 0, seen)
  // A cycle leaves nodes unreached; show them as extra roots instead of losing them.
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    node.depth = 0
    roots.push(node)
    visit(node, 0, seen)
  }
  return { nodes, roots }
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
    const tree = await readTree(folder.dir)
    const shaped = shapeTree(tree.nodes)
    return json({
      ok: true,
      folder: FOLDER,
      absolute: folder.dir,
      exists: tree.exists,
      signature: tree.signature,
      nodes: shaped.nodes.map(node => ({
        name: node.name,
        id: node.id,
        parent: node.parent,
        order: node.order,
        title: node.title,
        status: node.status,
        body: node.body,
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
 * Write one node file exactly as given.
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
  if (input.content.length * 4 > MAX_FILE_BYTES * 4) return json({ ok: false, error: 'too-large' }, 413)
  const folder = folderOf(ctx, input.sessionId)
  if (folder.error !== undefined) return json({ ok: false, ...folder }, 400)
  try {
    await mkdir(folder.dir, { recursive: true })
    const path = join(folder.dir, name)
    if (relative(folder.dir, path).startsWith('..')) return json({ ok: false, error: 'bad-name' }, 400)
    await writeFile(path, writeField(input.content, 'updated', new Date().toISOString()), 'utf8')
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