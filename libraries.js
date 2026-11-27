/**
 * The shared MCP library and the shared skill library.
 *
 * Both live in ONE folder outside every conversation, so a server or a skill
 * downloaded once is available to every project and every conversation:
 *
 * ```
 * <library root>/
 *   mcp/<id>/mcp.json     one MCP server definition each
 *   mcp/<id>/packages/    npm-installed server packages, when installed here
 *   skills/<name>/SKILL.md one skill each (same format as the shipped skills)
 * ```
 *
 * The MCP half registers each enabled definition with `ctx.mcpManager`, which is
 * how a plugin-contributed server becomes `mcp__<id>__<tool>` for every agent.
 * The skill half registers one `skills.registerProvider`, so library skills sit
 * in the same catalog as the bundled ones.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { untilService } from './services.js'

/** Environment variable that relocates the library. */
export const LIBRARY_ENV = 'DSH_AGENT_LIBRARY'

/** Folder holding MCP definitions. */
const MCP_FOLDER = 'mcp'

/** Folder holding skills. */
const SKILL_FOLDER = 'skills'

/** Server ids share the MCP namespace syntax. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Skill folder names: no traversal, no separators. */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Resolve the library root, shared by every project and conversation.
 * @param {NodeJS.ProcessEnv} [env] - environment to read.
 * @returns {string} the absolute library root.
 */
export function libraryRoot(env = process.env) {
  const override = typeof env?.[LIBRARY_ENV] === 'string' ? env[LIBRARY_ENV].trim() : ''
  if (override !== '') return resolve(override)
  const home = env?.USERPROFILE || env?.HOME || homedir()
  return join(home, '.dsh', 'agent-library')
}

/**
 * The MCP folder of one library root.
 * @param {string} root - library root.
 * @returns {string} the folder.
 */
export function mcpFolderOf(root) {
  return join(root, MCP_FOLDER)
}

/**
 * The skill folder of one library root.
 * @param {string} root - library root.
 * @returns {string} the folder.
 */
export function skillFolderOf(root) {
  return join(root, SKILL_FOLDER)
}

/**
 * Create the library skeleton and its policy note.
 * @param {string} root - library root.
 * @returns {Promise<void>} resolves once the folders exist.
 */
export async function ensureLibrary(root) {
  await mkdir(mcpFolderOf(root), { recursive: true })
  await mkdir(skillFolderOf(root), { recursive: true })
  const readme = join(root, 'README.md')
  try {
    await stat(readme)
  } catch {
    await writeFile(readme, [
      '# DSH 统一库',
      '',
      '所有下载/使用过的 MCP 与 Skill 都放这里，与会话和项目无关：',
      '',
      '- `mcp/<id>/mcp.json`：一个 MCP 服务一个文件；插件启动时自动注册为 `mcp__<id>__<tool>`。',
      '- `mcp/<id>/packages/`：用 `mcp_library {action:"install"}` 安装的包落在这里。',
      '- `mcp/_npm-cache/`：npx/npm 的缓存也指向这里，避免散落到用户目录。',
      '- `skills/<name>/SKILL.md`：一个技能一个目录，和内置技能出现在同一个技能目录里。',
      '',
      '新增 MCP 用 `mcp_library`，新增技能用 `skill_library`；不要写进 profile 的 patch。',
      '',
    ].join('\n'), 'utf8')
  }
}

/* ------------------------------------------------------------------ *
 * MCP definitions
 * ------------------------------------------------------------------ */

/**
 * Validate one server id.
 * @param {unknown} value - candidate id.
 * @returns {string|undefined} the id, or undefined when invalid.
 */
function validId(value) {
  const id = String(value ?? '').trim()
  return ID_PATTERN.test(id) ? id : undefined
}

/**
 * Normalize one stored server definition.
 * @param {object} raw - parsed `mcp.json`.
 * @param {string} id - folder-derived id.
 * @returns {object} a normalized definition.
 */
function normalizeServer(raw, id) {
  const transport = raw?.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  return {
    id,
    name: String(raw?.name ?? id),
    transport,
    command: typeof raw?.command === 'string' ? raw.command : '',
    args: Array.isArray(raw?.args) ? raw.args.map(value => String(value)) : [],
    env: raw?.env !== null && typeof raw?.env === 'object' && !Array.isArray(raw.env)
      ? Object.fromEntries(Object.entries(raw.env).map(([key, value]) => [key, String(value)]))
      : {},
    url: typeof raw?.url === 'string' ? raw.url : '',
    cwd: typeof raw?.cwd === 'string' ? raw.cwd : '',
    toolCallTimeoutMs: Number.isFinite(Number(raw?.toolCallTimeoutMs)) ? Number(raw.toolCallTimeoutMs) : 120_000,
    enabled: raw?.enabled !== false,
    source: typeof raw?.source === 'string' ? raw.source : 'library',
    note: typeof raw?.note === 'string' ? raw.note : '',
  }
}

/**
 * Read every MCP definition in the library.
 * @param {string} root - library root.
 * @returns {Promise<object[]>} definitions, ordered by id.
 */
export async function readMcpServers(root) {
  const folder = mcpFolderOf(root)
  let names
  try {
    names = await readdir(folder)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const servers = []
  for (const name of names) {
    if (name.startsWith('_')) continue
    const path = join(folder, name, 'mcp.json')
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      const raw = JSON.parse(await readFile(path, 'utf8'))
      servers.push(normalizeServer(raw, validId(raw?.id ?? name) ?? name))
    } catch {
      // An unreadable definition is skipped; the rest of the library still loads.
    }
  }
  servers.sort((a, b) => a.id.localeCompare(b.id))
  return servers
}

/**
 * Write one MCP definition.
 * @param {string} root - library root.
 * @param {object} input - definition fields; `id` is required.
 * @returns {Promise<object>} the stored definition.
 */
export async function writeMcpServer(root, input) {
  const id = validId(input?.id ?? input?.name)
  if (id === undefined) throw new Error('mcp id must match [A-Za-z0-9_-]{1,32}')
  if (input?.transport === 'stdio' || input?.transport === undefined) {
    if (typeof input?.command !== 'string' || input.command.trim() === '') throw new Error('a stdio server needs a command')
  }
  const folder = join(mcpFolderOf(root), id)
  await mkdir(folder, { recursive: true })
  const definition = normalizeServer({ ...input, id }, id)
  await writeFile(join(folder, 'mcp.json'), `${JSON.stringify(definition, null, 2)}\n`, 'utf8')
  return definition
}

/**
 * Remove one MCP definition and its installed packages.
 * @param {string} root - library root.
 * @param {string} id - server id.
 * @returns {Promise<boolean>} whether something was removed.
 */
export async function removeMcpServer(root, id) {
  const safe = validId(id)
  if (safe === undefined) return false
  try {
    await rm(join(mcpFolderOf(root), safe), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Build the entry a `mcpManager.register` call expects.
 * @param {object} server - normalized definition.
 * @param {string} root - library root (for the npm cache).
 * @returns {object} the registration entry.
 */
export function mcpRegistrationEntry(server, root) {
  const cache = join(root, '_npm-cache')
  if (server.transport === 'streamable-http') {
    return {
      transport: 'streamable-http',
      serverName: server.id,
      url: server.url,
      headers: server.env,
      failOnStartupError: false,
    }
  }
  const env = { ...server.env, npm_config_cache: server.env.npm_config_cache ?? cache }
  return {
    transport: 'stdio',
    serverName: server.id,
    command: server.command,
    args: server.args,
    env,
    ...(server.cwd === '' ? {} : { cwd: server.cwd }),
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: false,
  }
}

/**
 * Mount every enabled library server on the MCP manager.
 * @param {object} ctx - Host context.
 * @param {string} root - library root.
 * @returns {Promise<{mounted: string[], failed: object[], disposers: Function[], skipped: string}>} mount result.
 */
export async function mountMcpLibrary(ctx, root) {
  const manager = ctx.get('mcpManager')
  const servers = await readMcpServers(root)
  const mounted = []
  const mirrored = []
  const failed = []
  const disposers = []
  if (manager === undefined || manager === null || typeof manager.register !== 'function') {
    return { mounted, mirrored, failed, disposers, skipped: 'mcpManager-unavailable' }
  }
  // A server the profile already configures owns its namespace. The library may
  // still hold a mirror of it, but registering that mirror would collide.
  const occupied = new Set()
  try {
    const listed = typeof manager.list === 'function' ? manager.list() : []
    for (const item of Array.isArray(listed) ? listed : []) {
      if (typeof item?.name === 'string') occupied.add(item.name)
    }
  } catch {
    // Without a listing we fall back to attempting every registration.
  }
  for (const server of servers) {
    if (!server.enabled) continue
    if (occupied.has(server.id)) {
      mirrored.push(server.id)
      continue
    }
    try {
      disposers.push(manager.register(server.id, mcpRegistrationEntry(server, root)))
      mounted.push(server.id)
    } catch (error) {
      failed.push({ id: server.id, message: String(error?.message ?? error) })
    }
  }
  return { mounted, mirrored, failed, disposers, skipped: '' }
}

/**
 * Mirror the profile's configured MCP rows into the library.
 *
 * Rows are read through `configEditor`, which is the live composition, so a
 * server added the "normal" way still ends up represented in the one folder.
 * @param {object} ctx - Host context.
 * @param {string} root - library root.
 * @returns {Promise<{written: string[], skipped: string[]}>} mirror result.
 */
export async function syncConfiguredMcp(ctx, root) {
  const editor = ctx.get('configEditor')
  const written = []
  const skipped = []
  if (editor === undefined || editor === null || typeof editor.configuration !== 'function') return { written, skipped }
  let configuration
  try {
    configuration = editor.configuration()
  } catch {
    return { written, skipped }
  }
  const existing = new Set((await readMcpServers(root)).map(server => server.id))
  for (const row of Array.isArray(configuration) ? configuration : []) {
    const entry = row?.entry ?? {}
    if (entry.name !== '@deepseek-ai/dsh-mcp-client') continue
    const config = { ...(row.inherited ?? {}), ...(row.override ?? {}) }
    const id = validId(config.serverName ?? entry.id)
    if (id === undefined || existing.has(id)) {
      skipped.push(id ?? String(entry.id ?? '?'))
      continue
    }
    try {
      await writeMcpServer(root, {
        id,
        name: id,
        transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: config.command ?? '',
        args: Array.isArray(config.args) ? config.args : [],
        env: config.env ?? {},
        url: config.url ?? '',
        cwd: config.cwd ?? '',
        toolCallTimeoutMs: config.toolCallTimeoutMs,
        enabled: true,
        source: 'profile',
        note: `mirrored from profile row ${entry.id ?? ''}`.trim(),
      })
      written.push(id)
    } catch {
      skipped.push(id)
    }
  }
  return { written, skipped }
}

/**
 * Reject a package spec that could smuggle shell syntax through npm.
 * @param {string} spec - model-supplied package.
 * @returns {boolean} whether the spec is safe to pass as one argument.
 */
export function isSafePackageSpec(spec) {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?(@[a-z0-9][a-z0-9.^~<>=|*.-]*)?$/i.test(spec.trim())
}

/**
 * Run npm once and collect its output.
 * @param {string[]} args - npm arguments.
 * @param {string} cwd - working directory.
 * @param {object} env - extra environment.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} the settled run.
 */
export function runNpm(args, cwd, env = {}) {
  return new Promise((resolvePromise) => {
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm'
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args
    let child
    try {
      child = spawn(command, argv, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', (error) => {
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error?.message ?? error)}` })
    })
    child.on('close', code => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

/**
 * Read one skill's front matter.
 * @param {string} text - SKILL.md contents.
 * @returns {{data: Record<string,string>, body: string}} parsed parts.
 */
export function parseSkill(text) {
  const content = String(text ?? '').replace(/^\uFEFF/, '')
  if (!content.startsWith('---')) return { data: {}, body: content }
  const end = content.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: content }
  const data = {}
  for (const line of content.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  let body = content.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { data, body }
}

/**
 * Read every skill in the library.
 * @param {string} root - library root.
 * @returns {Promise<object[]>} skills, ordered by name.
 */
export async function readSkills(root) {
  const folder = skillFolderOf(root)
  let names
  try {
    names = await readdir(folder)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const skills = []
  for (const name of names) {
    if (name.startsWith('_') || name.startsWith('.')) continue
    const path = join(folder, name, 'SKILL.md')
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      const text = await readFile(path, 'utf8')
      const { data, body } = parseSkill(text)
      const skillName = typeof data.name === 'string' && data.name !== '' ? data.name : name
      skills.push({
        name: skillName,
        folder: name,
        description: typeof data.description === 'string' && data.description !== '' ? data.description : firstLine(body),
        whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : '',
        path,
        body,
      })
    } catch {
      // A broken skill folder is skipped instead of breaking the catalog.
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/**
 * First non-empty line of a Markdown body.
 * @param {string} body - skill body.
 * @returns {string} a one-line summary.
 */
function firstLine(body) {
  const line = String(body ?? '').split('\n').map(item => item.trim()).find(item => item !== '' && !item.startsWith('#'))
  return (line ?? '').slice(0, 200)
}

/**
 * Write one skill into the library.
 * @param {string} root - library root.
 * @param {{name: string, description?: string, whenToUse?: string, body: string}} input - skill fields.
 * @returns {Promise<object>} the stored skill.
 */
export async function writeSkill(root, input) {
  const folderName = String(input?.folder ?? input?.name ?? '').trim()
  if (!SKILL_NAME_PATTERN.test(folderName)) throw new Error('skill folder must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}')
  const body = String(input?.body ?? '').trim()
  if (body === '') throw new Error('a skill needs a body')
  const folder = join(skillFolderOf(root), folderName)
  await mkdir(folder, { recursive: true })
  const description = String(input?.description ?? firstLine(body)).replace(/\s+/g, ' ').trim().slice(0, 300)
  const head = [
    '---',
    `name: ${JSON.stringify(String(input.name ?? folderName))}`,
    `description: ${JSON.stringify(description)}`,
    ...(String(input?.whenToUse ?? '').trim() === '' ? [] : [`whenToUse: ${JSON.stringify(String(input.whenToUse).trim())}`]),
    '---',
    '',
  ].join('\n')
  await writeFile(join(folder, 'SKILL.md'), `${head}${body}\n`, 'utf8')
  const skills = await readSkills(root)
  return skills.find(skill => skill.folder === folderName) ?? { name: folderName, folder: folderName, description, path: join(folder, 'SKILL.md'), body }
}

/**
 * Copy an existing skill folder into the library.
 * @param {string} root - library root.
 * @param {string} source - a `SKILL.md` path or the folder containing it.
 * @returns {Promise<object>} the imported skill.
 */
export async function importSkill(root, source) {
  const input = String(source ?? '').trim()
  if (input === '') throw new Error('import needs a path')
  let path = resolve(input)
  try {
    const info = await stat(path)
    if (info.isDirectory()) path = join(path, 'SKILL.md')
  } catch {
    throw new Error(`skill source not found: ${input}`)
  }
  const text = await readFile(path, 'utf8')
  const { data, body } = parseSkill(text)
  const name = String(data.name ?? '').trim()
  return await writeSkill(root, {
    name: name === '' ? path.split(/[\\/]/).slice(-2, -1)[0] : name,
    folder: (name === '' ? path.split(/[\\/]/).slice(-2, -1)[0] : name).replace(/[^A-Za-z0-9_-]/g, '-'),
    description: data.description ?? '',
    whenToUse: data.whenToUse ?? '',
    body,
  })
}

/**
 * Register one skill provider over the library folder.
 * @param {() => string} rootOf - resolves the current library root.
 * @returns {object} a `skills.registerProvider` factory result.
 */
export function createSkillProvider(rootOf) {
  const candidateOf = skill => ({
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse === '' ? undefined : skill.whenToUse,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'agent-library',
    source: 'custom',
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
    rank: 500,
    locator: skill.path,
  })
  return {
    name: 'agent-library',
    async list() {
      return (await readSkills(rootOf())).map(candidateOf)
    },
    async get(candidate) {
      const path = typeof candidate?.locator === 'string' ? candidate.locator : undefined
      if (path === undefined) return undefined
      const text = await readFile(path, 'utf8')
      const { data, body } = parseSkill(text)
      return {
        ...candidateOf({
          name: String(data.name ?? candidate.name),
          description: String(data.description ?? candidate.description ?? ''),
          whenToUse: typeof data.whenToUse === 'string' ? data.whenToUse : '',
          path,
        }),
        content: body,
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

/**
 * Register both libraries: mount MCP servers, expose the skill provider, and
 * register the two management tools plus their routes.
 * @param {object} ctx - Host context.
 * @param {object} deps - Host helpers.
 * @param {(request: Request) => Promise<object|undefined>} deps.readJson - JSON body reader.
 * @param {(value: object, status?: number) => Response} deps.json - JSON responder.
 * @param {string} deps.routePrefix - route prefix owned by the plugin.
 * @returns {void}
 */
export function registerLibraries(ctx, deps) {
  const { readJson, json, routePrefix } = deps
  const root = libraryRoot()
  const state = { root, mounted: [], mirrored: [], failed: [], skipped: '', ready: false, ctx, remount: async () => ({ mounted: [], mirrored: [], failed: [], skipped: 'not-started' }) }

  ctx.effect(() => {
    let disposed = false
    let timer
    let watcher
    let disposers = []
    const teardown = () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A manager already gone cannot be unregistered twice.
        }
      }
    }
    const remount = async () => {
      if (disposed) return { mounted: [], mirrored: [], failed: [], skipped: 'disposed' }
      try {
        await ensureLibrary(root)
        // Release our previous registrations first: the manager's listing must
        // show only OTHER servers, or every remount would mistake our own names
        // for occupied ones and skip them.
        teardown()
        const result = await mountMcpLibrary(ctx, root)
        if (disposed) {
          for (const dispose of result.disposers) {
            try {
              dispose()
            } catch {
              // Disposal raced the plugin teardown; nothing left to release.
            }
          }
          return result
        }
        disposers = result.disposers
        state.mounted = result.mounted
        state.mirrored = result.mirrored ?? []
        state.failed = result.failed
        state.skipped = result.skipped
        state.ready = true
        return result
      } catch (error) {
        state.ready = false
        state.failed = [{ id: '*', message: String(error?.message ?? error) }]
        return { mounted: [], mirrored: [], failed: state.failed, skipped: '' }
      }
    }
    state.remount = remount
    // The MCP manager may mount after this bundle; retry a few times instead of
    // silently mounting nothing for the rest of the process.
    let retries = 0
    const retryMount = () => {
      if (disposed || retries >= 6) return
      retries += 1
      const timer = setTimeout(() => {
        void remount().then((result) => {
          if (result?.skipped === 'mcpManager-unavailable') retryMount()
        })
      }, 500 * retries)
      if (typeof timer.unref === 'function') timer.unref()
    }
    // A definition written outside the tools (by hand, or by another plugin)
    // still appears without a restart. Watched only after the folder exists.
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { void remount() }, 400)
    }
    const startWatch = () => {
      if (watcher !== undefined || disposed) return
      try {
        watcher = watch(mcpFolderOf(root), { persistent: false }, schedule)
        watcher.on('error', () => undefined)
      } catch {
        watcher = undefined
      }
    }
    // Mount a moment after apply, so the profile's own MCP rows are already in
    // the manager's listing and their namespaces are respected as occupied.
    const firstTimer = setTimeout(() => {
      void remount().then((result) => {
        startWatch()
        if (result?.skipped === 'mcpManager-unavailable') retryMount()
      })
    }, 700)
    if (typeof firstTimer.unref === 'function') firstTimer.unref()

    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(firstTimer)
      try {
        watcher?.close()
      } catch {
        // An already-closed watcher is fine.
      }
      teardown()
    }
  }, 'agent-library: mcp mount')

  // The skill provider is registered once; it reads the folder per request, so
  // a new skill appears without a restart.
  if (typeof ctx.skills?.registerProvider === 'function') {
    ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(() => state.root)), 'agent-library: skill provider')
  }

  untilService(ctx, 'tools', (tools) => {
    tools.register({
      name: 'mcp_library',
      description: 'Manage the ONE shared MCP library every project uses: list, add, remove, enable/disable, install a server package into the library, mirror the profile\'s configured servers into it, or print its path. Adding an MCP here makes it available to every conversation without editing profile files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'add', 'remove', 'enable', 'disable', 'install', 'sync', 'path', 'remount'],
            description: 'list = definitions + mount state; add = write mcp/<id>/mcp.json; install = npm install a package into the server folder; sync = mirror profile-configured servers; remount = re-read the folder now.',
          },
          id: { type: 'string', description: 'Server id ([A-Za-z0-9_-]{1,32}); also the tool namespace mcp__<id>__*.', },
          command: { type: 'string', description: 'stdio server executable.' },
          args: { type: 'array', items: { type: 'string' }, description: 'stdio server arguments.' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: 'extra environment variables.' },
          url: { type: 'string', description: 'streamable-http endpoint.' },
          transport: { type: 'string', enum: ['stdio', 'streamable-http'], description: 'Transport; defaults to stdio.' },
          note: { type: 'string', description: 'Why this server is here.' },
          package: { type: 'string', description: 'install: npm package name, e.g. @modelcontextprotocol/server-filesystem.' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderMcpText(value) }],
      },
      async execute(args) {
        return await runMcpAction(args ?? {}, state, root)
      },
    })

    tools.register({
      name: 'skill_library',
      description: 'Manage the ONE shared skill library every project uses: list, create, import an existing SKILL.md folder, remove, or print its path. Skills in this folder are loaded into the normal skill catalog of every conversation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'import', 'remove', 'path'],
            description: 'create writes skills/<name>/SKILL.md; import copies an existing SKILL.md folder here.',
          },
          name: { type: 'string', description: 'Skill folder name ([A-Za-z0-9][A-Za-z0-9_-]{0,63}).' },
          description: { type: 'string', description: 'One-line catalog description.' },
          whenToUse: { type: 'string', description: 'Optional stronger trigger guidance.' },
          body: { type: 'string', description: 'Skill instructions (Markdown).' },
          path: { type: 'string', description: 'import/remove: source skill folder or SKILL.md path.' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderSkillText(value) }],
      },
      async execute(args) {
        return await runSkillAction(args ?? {}, root)
      },
    })
  })

  const routes = [
    {
      path: `${routePrefix}/library`,
      methods: ['GET'],
      fetch: async () => json({
        ok: true,
        root,
        mcp: await readMcpServers(root),
        skills: (await readSkills(root)).map(skill => ({ name: skill.name, folder: skill.folder, description: skill.description, path: skill.path })),
        mounted: state.mounted,
        mirrored: state.mirrored,
        failed: state.failed,
        skipped: state.skipped,
      }),
    },
    {
      path: `${routePrefix}/library/mcp`,
      methods: ['POST'],
      fetch: async (request) => {
        const input = await readJson(request)
        if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
        try {
          return json(await runMcpAction(input, state, root))
        } catch (error) {
          return json({ ok: false, error: 'mcp-failed', message: String(error?.message ?? error) }, 500)
        }
      },
    },
    {
      path: `${routePrefix}/library/skill`,
      methods: ['POST'],
      fetch: async (request) => {
        const input = await readJson(request)
        if (input === undefined) return json({ ok: false, error: 'bad-body' }, 400)
        try {
          return json(await runSkillAction(input, root))
        } catch (error) {
          return json({ ok: false, error: 'skill-failed', message: String(error?.message ?? error) }, 500)
        }
      },
    },
  ]
  for (const route of routes) {
    ctx.connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch })
  }
}

/**
 * Execute one `mcp_library` call.
 * @param {object} args - model arguments.
 * @param {object} state - mount state.
 * @param {string} root - library root.
 * @returns {Promise<object>} JSON-safe result.
 */
async function runMcpAction(args, state, root) {
  const action = String(args.action ?? '')
  if (action === 'path') return { ok: true, action, root }
  if (action === 'list') {
    const servers = await readMcpServers(root)
    return {
      ok: true,
      action,
      root,
      mounted: state.mounted,
      mirrored: state.mirrored,
      failed: state.failed,
      skipped: state.skipped,
      servers: servers.map(server => ({
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        enabled: server.enabled,
        source: server.source,
        mounted: state.mounted.includes(server.id),
        mirrored: state.mirrored.includes(server.id),
      })),
    }
  }
  if (action === 'add') {
    const definition = await writeMcpServer(root, args)
    return { ok: true, action, server: definition, hint: '调用 mcp_library {action:"remount"} 或重启 DSH 后生效' }
  }
  if (action === 'remove') {
    const removed = await removeMcpServer(root, args.id)
    return { ok: removed, action, id: args.id }
  }
  if (action === 'enable' || action === 'disable') {
    const servers = await readMcpServers(root)
    const server = servers.find(item => item.id === args.id)
    if (server === undefined) return { ok: false, action, error: `unknown id ${args.id}` }
    // A profile row owns its connection; the library only mirrors it, so a
    // local switch could not honour what it promises.
    if (Array.isArray(state.mirrored) && state.mirrored.includes(server.id)) {
      return {
        ok: false,
        action,
        error: 'profile-owned',
        message: '这个 MCP 由 profile 配置提供，库里只是镜像；要停用请改 profile',
      }
    }
    const definition = await writeMcpServer(root, { ...server, enabled: action === 'enable' })
    // Apply immediately: a click in the panel must change what is loaded now,
    // not after the next restart.
    const result = await state.remount()
    return {
      ok: true,
      action,
      id: definition.id,
      enabled: definition.enabled,
      mounted: result.mounted ?? state.mounted,
      mirrored: result.mirrored ?? state.mirrored,
      failed: result.failed ?? state.failed,
    }
  }
  if (action === 'install') {
    const spec = String(args.package ?? '').trim()
    if (!isSafePackageSpec(spec)) return { ok: false, action, error: 'package must be a plain npm package spec' }
    const id = validId(args.id)
    if (id === undefined) return { ok: false, action, error: 'install needs an id' }
    const folder = join(mcpFolderOf(root), id, 'packages')
    await mkdir(folder, { recursive: true })
    const result = await runNpm(['install', '--prefix', folder, '--no-audit', '--no-fund', spec], folder, {
      npm_config_cache: join(root, '_npm-cache'),
    })
    return {
      ok: result.code === 0,
      action,
      id,
      folder,
      code: result.code,
      stdout: result.stdout.slice(-4_000),
      stderr: result.stderr.slice(-4_000),
      hint: result.code === 0 ? `依赖已装到 ${folder}；把 command 指向其中 bin 或 node_modules/.bin` : '安装失败，检查 npm 是否可用',
    }
  }
  if (action === 'sync') {
    const result = await syncConfiguredMcp(state.ctx, root)
    return { ok: true, action, ...result }
  }
  if (action === 'remount') {
    const result = await state.remount()
    return { ok: true, action, mounted: result.mounted, mirrored: result.mirrored ?? [], failed: result.failed, skipped: result.skipped }
  }
  return { ok: false, error: `unknown action ${action}` }
}

/**
 * Execute one `skill_library` call.
 * @param {object} args - model arguments.
 * @param {string} root - library root.
 * @returns {Promise<object>} JSON-safe result.
 */
async function runSkillAction(args, root) {
  const action = String(args.action ?? '')
  if (action === 'path') return { ok: true, action, root }
  if (action === 'list') {
    const skills = await readSkills(root)
    return {
      ok: true,
      action,
      root,
      skills: skills.map(skill => ({ name: skill.name, folder: skill.folder, description: skill.description, path: skill.path })),
    }
  }
  if (action === 'create') {
    const skill = await writeSkill(root, args)
    return { ok: true, action, name: skill.name, path: skill.path, description: skill.description }
  }
  if (action === 'import') {
    const skill = await importSkill(root, args.path ?? args.name)
    return { ok: true, action, name: skill.name, path: skill.path }
  }
  if (action === 'remove') {
    const name = String(args.name ?? '').trim()
    if (!SKILL_NAME_PATTERN.test(name)) return { ok: false, action, error: 'remove needs a valid skill folder name' }
    await rm(join(skillFolderOf(root), name), { recursive: true, force: true })
    return { ok: true, action, name }
  }
  return { ok: false, error: `unknown action ${action}` }
}

/**
 * Render one `mcp_library` result.
 * @param {object} value - result.
 * @returns {string} text.
 */
function renderMcpText(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) return `mcp_library: ${value.error ?? value.message ?? 'failed'}`
  if (Array.isArray(value.servers)) {
    if (value.servers.length === 0) return `mcp library (${value.root}): empty`
    const lines = value.servers.map(server => `- ${server.id} [${server.transport}] ${server.enabled ? 'enabled' : 'disabled'}${server.mounted ? ' (mounted)' : ''} ${server.command || server.url}`)
    return `mcp library (${value.root}):\n${lines.join('\n')}`
  }
  if (value.action === 'path') return `mcp library: ${value.root}`
  if (value.action === 'list') return `mcp library (${value.root}): mounted ${value.mounted?.join(', ') || 'none'}`
  if (value.action === 'add') return `mcp_library add: ${value.server?.id} (${value.hint})`
  if (value.action === 'install') return `mcp_library install: ${value.ok ? 'ok' : 'failed'} ${value.folder ?? ''}`
  if (value.action === 'sync') return `mcp_library sync: mirrored ${value.written?.length ?? 0}, skipped ${value.skipped?.length ?? 0}`
  if (value.action === 'remount') return `mcp_library remount: mounted ${value.mounted?.length ?? 0}`
  return JSON.stringify(value)
}

/**
 * Render one `skill_library` result.
 * @param {object} value - result.
 * @returns {string} text.
 */
function renderSkillText(value) {
  if (value === null || typeof value !== 'object') return String(value)
  if (value.ok === false) return `skill_library: ${value.error ?? value.message ?? 'failed'}`
  if (Array.isArray(value.skills)) {
    if (value.skills.length === 0) return `skill library (${value.root}): empty`
    return `skill library (${value.root}):\n${value.skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`
  }
  if (value.action === 'path') return `skill library: ${value.root}`
  if (value.action === 'create' || value.action === 'import') return `skill_library ${value.action}: ${value.name} → ${value.path}`
  if (value.action === 'remove') return `skill_library remove: ${value.name}`
  return JSON.stringify(value)
}