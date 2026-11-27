/**
 * The conversation memory bank.
 *
 * Every conversation gets its own folder of Markdown files under ONE shared
 * memory root (`~/.dsh/agent-memory/<session>/`), so the bank is easy to find,
 * survives compaction and restarts, and never leaks across conversations.
 *
 * The model decides what is worth remembering, through the `memory` tool. The
 * Host only re-injects the newest, most important lines into the turn-start
 * digest, so a long conversation does not carry its whole history forward.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { untilService } from './services.js'

/** Environment variable that relocates the memory root. */
export const MEMORY_ROOT_ENV = 'DSH_AGENT_MEMORY'

/** Legacy folder name inside a conversation's tree directory. */
export const MEMORY_FOLDER = 'memory'

/** Entries kept before the bank starts archiving the weakest ones. */
export const MAX_ENTRIES = 200

/** Entries kept by a default `prune` call. */
export const DEFAULT_KEEP = 120

/** Largest body accepted from one record call. */
const MAX_BODY = 12_000

/** Memory kinds the model may write. */
export const KINDS = ['failure', 'lesson', 'tool', 'decision', 'fact', 'done']

/** Digest entries returned by default. */
export const DIGEST_LIMIT = 6

/** Characters the memory part of the digest may take. */
export const DIGEST_MAX_CHARS = 1_200

/**
 * Resolve the one shared memory root.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} absolute memory root.
 */
export function memoryRoot(env = process.env) {
  const override = typeof env?.[MEMORY_ROOT_ENV] === 'string' ? env[MEMORY_ROOT_ENV].trim() : ''
  if (override !== '') return resolve(override)
  const home = env?.USERPROFILE || env?.HOME || homedir()
  return join(home, '.dsh', 'agent-memory')
}

/**
 * Folder name for one conversation. Session ids are already unique; this only
 * strips what a filesystem refuses.
 * @param {string} sessionKey - session id or its sanitized key.
 * @returns {string} a safe folder name, or `unknown`.
 */
export function safeMemoryKey(sessionKey) {
  const key = String(sessionKey ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
  return key === '' ? 'unknown' : key
}

/**
 * Resolve one conversation's memory folder.
 * @param {string} sessionKey - session id or its sanitized key.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} the folder holding this conversation's `.md` entries.
 */
export function memoryDirOf(sessionKey, env = process.env) {
  return join(memoryRoot(env), safeMemoryKey(sessionKey))
}

/**
 * Strip YAML scalar quoting from one front-matter value.
 * @param {string} value - raw scalar.
 * @returns {string} the unquoted value.
 */
function unquote(value) {
  const text = String(value ?? '').trim()
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
 * Read one file's front matter and body.
 * @param {string} text - complete file contents.
 * @returns {{data: Record<string, string>, body: string}} parsed parts.
 */
export function parseFrontMatter(text) {
  const content = String(text ?? '').replace(/^\uFEFF/, '')
  if (!content.startsWith('---')) return { data: {}, body: content }
  const end = content.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: content }
  const data = {}
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match !== null) data[match[1]] = unquote(match[2])
  }
  let body = content.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { data, body }
}

/**
 * Clamp one importance value into the 1-5 band.
 * @param {unknown} value - candidate importance.
 * @param {number} fallback - value used when the input is not a number.
 * @returns {number} the clamped importance.
 */
function clampImportance(value, fallback = 3) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(5, Math.max(1, Math.round(parsed)))
}

/**
 * Normalize a title for identity and search.
 * @param {string} value - raw title.
 * @returns {string} collapsed, trimmed, lowercase title.
 */
export function normalizeTitle(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Stable identity for one (kind, title) pair, so a repeated lesson updates the
 * existing file instead of appending a near-duplicate.
 * @param {string} kind - memory kind.
 * @param {string} title - memory title.
 * @returns {string} the entry id.
 */
export function entryId(kind, title) {
  return `m-${createHash('sha1').update(`${kind}\u0000${normalizeTitle(title)}`).digest('hex').slice(0, 12)}`
}

/**
 * Render one entry file.
 * @param {object} entry - entry fields.
 * @returns {string} the file contents.
 */
function renderEntry(entry) {
  const head = [
    '---',
    `id: ${entry.id}`,
    `kind: ${entry.kind}`,
    `title: ${JSON.stringify(entry.title)}`,
    `tags: ${entry.tags.join(',')}`,
    `importance: ${entry.importance}`,
    `hits: ${entry.hits}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    '---',
    '',
  ].join('\n')
  return `${head}${entry.body.trim()}\n`
}

/**
 * Read every entry of one memory folder, strongest first.
 * @param {string} dir - the conversation's memory folder.
 * @returns {Promise<{exists: boolean, entries: object[]}>} the bank contents.
 */
export async function readEntries(dir) {
  const folder = dir
  let names
  try {
    names = await readdir(folder)
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, entries: [] }
    throw error
  }
  const entries = []
  for (const name of names.filter(item => item.endsWith('.md') && !item.startsWith('_')).slice(0, MAX_ENTRIES * 2)) {
    const path = join(folder, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > 64_000) continue
      const { data, body } = parseFrontMatter(await readFile(path, 'utf8'))
      const title = data.title !== undefined && data.title !== '' ? data.title : body.split('\n')[0].replace(/^#\s*/, '')
      const kind = KINDS.includes(data.kind) ? data.kind : 'fact'
      entries.push({
        name,
        path,
        id: data.id !== undefined && data.id !== '' ? data.id : name.replace(/\.md$/, ''),
        kind,
        title: title.slice(0, 200),
        tags: String(data.tags ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
        importance: clampImportance(data.importance),
        hits: Number.isFinite(Number(data.hits)) ? Number(data.hits) : 1,
        created: data.created ?? '',
        updated: data.updated || data.created || '',
        body: body.trim(),
        mtime: info.mtimeMs,
      })
    } catch {
      // A half-written or hand-edited file is skipped, never fatal.
    }
  }
  entries.sort(compareEntries)
  return { exists: true, entries }
}

/**
 * Order entries by importance, then recency.
 * @param {object} a - first entry.
 * @param {object} b - second entry.
 * @returns {number} sort delta.
 */
export function compareEntries(a, b) {
  if (a.importance !== b.importance) return b.importance - a.importance
  return Date.parse(b.updated || '') - Date.parse(a.updated || '') || a.title.localeCompare(b.title)
}

/**
 * Write one entry file.
 * @param {string} dir - conversation tree directory.
 * @param {object} entry - entry fields.
 * @returns {Promise<string>} the file path.
 */
async function writeEntry(dir, entry) {
  const folder = dir
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${entry.id}.md`)
  await writeFile(path, renderEntry(entry), 'utf8')
  return path
}

/**
 * Record one memory, merging into the existing entry when the kind and title
 * match. Repeated lessons bump `hits` instead of piling up near-duplicates.
 * @param {string} dir - conversation tree directory.
 * @param {{kind?: string, title: string, body?: string, tags?: string[], importance?: number}} input - record request.
 * @returns {Promise<{entry: object, created: boolean, archived: string[]}>} the stored entry.
 */
export async function recordMemory(dir, input) {
  const kind = KINDS.includes(input?.kind) ? input.kind : 'fact'
  const title = String(input?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (title === '') throw new Error('memory record requires a non-empty title')
  const body = String(input?.body ?? '').trim().slice(0, MAX_BODY)
  const tags = Array.isArray(input?.tags)
    ? [...new Set(input.tags.map(tag => String(tag).trim()).filter(tag => tag !== ''))].slice(0, 12)
    : []
  const now = new Date().toISOString()
  const id = entryId(kind, title)
  const { entries } = await readEntries(dir)
  const previous = entries.find(entry => entry.id === id)
  const entry = previous === undefined
    ? {
        id,
        kind,
        title,
        tags,
        importance: clampImportance(input?.importance),
        hits: 1,
        created: now,
        updated: now,
        body,
      }
    : {
        ...previous,
        tags: [...new Set([...previous.tags, ...tags])].slice(0, 12),
        importance: input?.importance === undefined ? previous.importance : clampImportance(input.importance, previous.importance),
        hits: previous.hits + 1,
        updated: now,
        body: body === '' ? previous.body : body,
      }
  await writeEntry(dir, entry)
  const archived = entries.length >= MAX_ENTRIES ? await pruneMemory(dir, MAX_ENTRIES - 1) : []
  return { entry, created: previous === undefined, archived }
}

/**
 * Search the bank by substring across title, body, and tags.
 * @param {string} dir - conversation tree directory.
 * @param {string} query - free-text query.
 * @param {number} [limit] - maximum hits.
 * @returns {Promise<object[]>} matching entries, strongest first.
 */
export async function searchMemory(dir, query, limit = 20) {
  const needle = normalizeTitle(query)
  const { entries } = await readEntries(dir)
  if (needle === '') return entries.slice(0, limit)
  return entries.filter((entry) => {
    const haystack = `${normalizeTitle(entry.title)} ${normalizeTitle(entry.body)} ${normalizeTitle(entry.tags.join(' '))}`
    return haystack.includes(needle)
  }).slice(0, limit)
}

/**
 * Delete one entry, by id or by exact-ish title.
 * @param {string} dir - conversation tree directory.
 * @param {{id?: string, title?: string}} target - what to forget.
 * @returns {Promise<{removed: string[]}>} removed entry ids.
 */
export async function forgetMemory(dir, target) {
  const { entries } = await readEntries(dir)
  const id = String(target?.id ?? '').trim()
  const title = normalizeTitle(target?.title ?? '')
  const victims = entries.filter(entry => (id !== '' && entry.id === id) || (title !== '' && normalizeTitle(entry.title) === title))
  for (const entry of victims) {
    try {
      await unlink(entry.path)
    } catch {
      // Already gone: the bank is still consistent.
    }
  }
  return { removed: victims.map(entry => entry.id) }
}

/**
 * Move the weakest entries into `memory/_archive/` until `keep` remain.
 * @param {string} dir - conversation tree directory.
 * @param {number} [keep] - entries to keep.
 * @returns {Promise<string[]>} archived entry ids.
 */
export async function pruneMemory(dir, keep = DEFAULT_KEEP) {
  const wanted = Number.isFinite(Number(keep)) ? Math.max(0, Math.round(Number(keep))) : DEFAULT_KEEP
  const { entries } = await readEntries(dir)
  if (entries.length <= wanted) return []
  const archive = join(dir, '_archive')
  await mkdir(archive, { recursive: true })
  const archived = []
  for (const entry of entries.slice(wanted)) {
    const target = join(archive, entry.name)
    try {
      await rename(entry.path, target)
      archived.push(entry.id)
    } catch {
      // A failed move leaves the entry in place; the caller still sees the count.
    }
  }
  return archived
}

/**
 * Render the compact memory block injected into every step.
 *
 * The budget is the point: a long conversation must not re-send its whole
 * history, it re-sends the lessons that history produced.
 * @param {object[]} entries - memory entries, already sorted.
 * @param {number} [limit] - maximum lines.
 * @returns {string} the digest lines, or an empty string.
 */
export function renderMemoryDigest(entries, limit = DIGEST_LIMIT) {
  const lines = []
  let used = 0
  for (const entry of entries.slice(0, limit)) {
    const snippet = entry.body.replace(/\s+/g, ' ').trim().slice(0, 70)
    const line = `- [${entry.kind}] ${entry.title}${snippet === '' ? '' : ` :: ${snippet}`}`
    if (used + line.length > DIGEST_MAX_CHARS) break
    used += line.length
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Register memory routes and the `memory` tool.
 *
 * The model writes when it judges a fact worth keeping; nothing is captured
 * automatically, so the bank stays small and intentional.
 * @param {object} ctx - Host context.
 * @param {object} deps - Host helpers from `index.js`.
 * @param {(sessionId: string) => string} deps.memoryDirOfSession - this conversation's memory folder.
 * @param {(request: Request) => Promise<object|undefined>} deps.readJson - JSON body reader.
 * @param {(value: object, status?: number) => Response} deps.json - JSON responder.
 * @param {string} deps.routePrefix - route prefix owned by the plugin.
 * @returns {void}
 */
export function registerMemory(ctx, deps) {
  const { memoryDirOfSession, readJson, json, routePrefix } = deps

  /**
   * Resolve a request body to the conversation's memory folder.
   * @param {object} input - parsed body.
   * @returns {{dir?: string, error?: string}} resolution.
   */
  const dirOfBody = (input) => {
    const sessionId = input?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { error: 'missing-session' }
    return { dir: memoryDirOfSession(sessionId) }
  }

  const routes = [
    {
      path: `${routePrefix}/memory`,
      methods: ['GET'],
      fetch: async (request) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
        if (sessionId === '') return json({ ok: false, error: 'missing-session' }, 400)
        const { exists, entries } = await readEntries(memoryDirOfSession(sessionId))
        return json({ ok: true, exists, entries: entries.map(publicEntry) })
      },
    },
    {
      path: `${routePrefix}/memory/record`,
      methods: ['POST'],
      fetch: async (request) => {
        const input = await readJson(request)
        if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
        const { dir, error } = dirOfBody(input)
        if (error !== undefined) return json({ ok: false, error }, 400)
        try {
          const result = await recordMemory(dir, input)
          return json({ ok: true, created: result.created, entry: publicEntry(result.entry), archived: result.archived })
        } catch (failure) {
          return json({ ok: false, error: 'record-failed', message: String(failure?.message ?? failure) }, 500)
        }
      },
    },
    {
      path: `${routePrefix}/memory/forget`,
      methods: ['POST'],
      fetch: async (request) => {
        const input = await readJson(request)
        if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
        const { dir, error } = dirOfBody(input)
        if (error !== undefined) return json({ ok: false, error }, 400)
        const removed = await forgetMemory(dir, input)
        return json({ ok: true, removed })
      },
    },
    {
      path: `${routePrefix}/memory/prune`,
      methods: ['POST'],
      fetch: async (request) => {
        const input = await readJson(request)
        if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
        const { dir, error } = dirOfBody(input)
        if (error !== undefined) return json({ ok: false, error }, 400)
        const archived = await pruneMemory(dir, input.keep ?? DEFAULT_KEEP)
        const { entries } = await readEntries(dir)
        return json({ ok: true, archived, remaining: entries.length })
      },
    },
  ]
  for (const route of routes) {
    ctx.connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch })
  }

  untilService(ctx, 'tools', (tools) => {
    tools.register({
      name: 'memory',
      description: 'Conversation memory bank (思考链的记忆库): one Markdown file per memory under ~/.dsh/agent-memory/<session>/, isolated per conversation. Record a lesson, a failure cause, a decision, a key tool call, or what was finished — whenever YOU judge it worth keeping across compaction. Then search, list, forget, prune, or trim oversized tool results from this session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['record', 'search', 'list', 'forget', 'prune', 'digest', 'prune_context'],
            description: 'record = write one entry; search/list = read; forget = delete one; prune = archive the weakest beyond `keep`; digest = render the injected memory block; prune_context = trim oversized tool results in this session.',
          },
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'record only: failure | lesson | decision | fact | tool | done.',
          },
          title: { type: 'string', description: 'record/forget: one short line. Same title + kind updates the existing entry.' },
          body: { type: 'string', description: 'record: the detail worth keeping — cause, fix, evidence, file path.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'record: optional tags.' },
          importance: { type: 'integer', description: 'record: 1 (minor) to 5 (critical). Default 3.' },
          query: { type: 'string', description: 'search: substring over title, body, tags.' },
          id: { type: 'string', description: 'forget: entry id.' },
          keep: { type: 'integer', description: 'prune: entries to keep (default 120).' },
          confirm: { type: 'boolean', description: 'prune_context: must be true; it rewrites this session log.' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderToolText(value) }],
      },
      async execute(args, exec) {
        return await runMemoryAction(args ?? {}, exec)
      },
    })
  })

  /**
   * Execute one `memory` tool call.
   * @param {object} args - validated model arguments.
   * @param {object} exec - tool execution contract (carries the calling agent).
   * @returns {Promise<object>} JSON-safe result.
   */
  async function runMemoryAction(args, exec) {
    const sessionId = exec?.agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'memory needs an owning session' }
    const dir = memoryDirOfSession(sessionId)
    const action = String(args.action ?? '')
    if (action === 'record') {
      const result = await recordMemory(dir, args)
      return { ok: true, action, created: result.created, id: result.entry.id, title: result.entry.title, kind: result.entry.kind, hits: result.entry.hits, archived: result.archived }
    }
    if (action === 'search') {
      const found = await searchMemory(dir, String(args.query ?? ''), clampLimit(args.limit))
      return { ok: true, action, entries: found.map(publicEntry) }
    }
    if (action === 'list') {
      const { entries } = await readEntries(dir)
      const filtered = args.kind === undefined ? entries : entries.filter(entry => entry.kind === args.kind)
      return { ok: true, action, count: filtered.length, entries: filtered.map(publicEntry) }
    }
    if (action === 'forget') {
      const removed = await forgetMemory(dir, args)
      return { ok: true, action, removed: removed.removed }
    }
    if (action === 'prune') {
      const archived = await pruneMemory(dir, args.keep ?? DEFAULT_KEEP)
      const { entries } = await readEntries(dir)
      return { ok: true, action, archived, remaining: entries.length }
    }
    if (action === 'digest') {
      const { entries } = await readEntries(dir)
      return { ok: true, action, digest: renderMemoryDigest(entries), count: entries.length }
    }
    if (action === 'prune_context') {
      if (args.confirm !== true) return { ok: false, action, error: 'prune_context rewrites this session log; pass confirm: true' }
      const pruner = ctx.get('toolResultPruner')
      const session = exec?.agent?.session
      if (pruner === undefined || pruner === null || typeof pruner.pruneSession !== 'function' || session === undefined) {
        return { ok: false, action, error: 'tool-result pruner unavailable in this Host' }
      }
      const result = pruner.pruneSession(session)
      return { ok: true, action, pruned: result?.pruned ?? 0, savedTokens: result?.savedTokens ?? 0 }
    }
    return { ok: false, error: `unknown action ${action}` }
  }

  /**
   * Clamp a requested result limit.
   * @param {unknown} value - requested limit.
   * @returns {number} a safe limit.
   */
  function clampLimit(value) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return 20
    return Math.min(100, Math.max(1, Math.round(parsed)))
  }
}

/**
 * Model-facing projection of one entry.
 * @param {object} entry - stored entry.
 * @returns {object} JSON-safe entry.
 */
export function publicEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    tags: entry.tags,
    importance: entry.importance,
    hits: entry.hits,
    updated: entry.updated,
    body: entry.body.slice(0, 2_000),
  }
}

/**
 * Render one tool result as plain text for the model.
 * @param {object} value - tool result object.
 * @returns {string} the text.
 */
function renderToolText(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) return `memory: ${value.error ?? 'failed'}`
  const action = value.action ?? 'memory'
  if (action === 'record') return `memory record: ${value.created ? 'created' : 'updated'} ${value.kind} "${value.title}" (hits ${value.hits})`
  if (Array.isArray(value.entries)) {
    if (value.entries.length === 0) return `memory ${action}: no entries`
    const lines = value.entries.map(entry => `- ${entry.id} [${entry.kind}] ${entry.title}`)
    return `memory ${action} (${value.entries.length}):\n${lines.join('\n')}`
  }
  if (action === 'digest') return value.digest === '' ? 'memory digest: empty' : value.digest
  if (action === 'forget') return `memory forget: ${value.removed?.length ?? 0} removed`
  if (action === 'prune') return `memory prune: ${value.archived?.length ?? 0} archived, ${value.remaining ?? 0} remain`
  if (action === 'prune_context') return `memory prune_context: ${value.pruned ?? 0} tool results trimmed`
  return JSON.stringify(value)
}