/**
 * Shared library behaviour: one folder for every MCP server and every skill,
 * scan + mount, profile mirroring, and the two management tools.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  libraryRoot, ensureLibrary, readMcpServers, writeMcpServer, removeMcpServer,
  mountMcpLibrary, syncConfiguredMcp, mcpRegistrationEntry, isSafePackageSpec,
  readSkills, writeSkill, importSkill, createSkillProvider, registerLibraries,
  mcpFolderOf, skillFolderOf,
} from '../libraries.js'
import { json, readJson } from './helpers.mjs'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const root = mkdtempSync(join(tmpdir(), 'thinking-tree-library-'))
process.env.DSH_AGENT_LIBRARY = root

// A shared root, independent of any conversation or project.
{
  const withEnv = libraryRoot(process.env)
  const withoutEnv = libraryRoot({ USERPROFILE: 'C:/Users/demo' })
  check('the library root honours the override', withEnv === root.replace(/\\/g, '/') || withEnv === root, { root: withEnv })
  check('the default root is one shared folder', withoutEnv.replace(/\\/g, '/').endsWith('.dsh/agent-library'), { path: withoutEnv })
}

await ensureLibrary(root)
{
  check('ensureLibrary creates both folders', existsSync(mcpFolderOf(root)) && existsSync(skillFolderOf(root)), null)
}

// Write / read / remove one server definition.
{
  await writeMcpServer(root, { id: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], note: 'demo' })
  await writeMcpServer(root, { id: 'off-server', transport: 'stdio', command: 'node', enabled: false })
  const servers = await readMcpServers(root)
  check('definitions round trip through mcp/<id>/mcp.json', servers.length === 2 && servers[0].args.length === 2, {
    ids: servers.map(server => server.id),
  })
  const entry = mcpRegistrationEntry(servers[0], root)
  check('a stdio entry carries serverName/command/args and the library npm cache', entry.serverName === servers[0].id && entry.command === 'npx' && String(entry.env.npm_config_cache).includes('_npm-cache'), entry)
  const removed = await removeMcpServer(root, 'off-server')
  check('removing a server removes its folder', removed === true && (await readMcpServers(root)).length === 1, null)
}

// Mount only enabled servers, and keep the disposers.
{
  const registered = []
  const manager = { register: (name, entry) => { registered.push({ name, entry }); return () => registered.push({ name: `dispose:${name}` }) } }
  await writeMcpServer(root, { id: 'disabled-one', transport: 'stdio', command: 'node', enabled: false })
  const mounted = await mountMcpLibrary({ get: name => (name === 'mcpManager' ? manager : undefined) }, root)
  check('mount registers enabled servers only', mounted.mounted.includes('filesystem') && !mounted.mounted.includes('disabled-one'), mounted)
  check('mount keeps one disposer per mounted server', mounted.disposers.length === mounted.mounted.length, { mounted: mounted.mounted.length })
  const missing = await mountMcpLibrary({ get: () => undefined }, root)
  check('a Host without the MCP manager degrades gracefully', missing.skipped === 'mcpManager-unavailable', missing)

  // A profile-configured server keeps its namespace; the library mirror is not re-registered.
  const withConfigured = {
    list: () => [{ name: 'filesystem', configured: true, status: { state: 'connected' } }],
    register: () => { throw new Error('must not register a configured namespace') },
  }
  const mirrored = await mountMcpLibrary({ get: name => (name === 'mcpManager' ? withConfigured : undefined) }, root)
  check('a configured namespace is mirrored, not registered twice', mirrored.mirrored.includes('filesystem') && !mirrored.mounted.includes('filesystem'), mirrored)
}

// The profile's configured MCP rows are mirrored into the same folder.
{
  const editor = {
    configuration: () => [
      { entry: { id: 'mcp-blender', name: '@deepseek-ai/dsh-mcp-client' }, inherited: {}, override: { serverName: 'blender', transport: 'stdio', command: 'D:/tool/venv/blender-mcp.exe', args: [] } },
      { entry: { id: 'unrelated', name: 'other-plugin' }, inherited: {}, override: {} },
    ],
  }
  const mirrored = await syncConfiguredMcp({ get: name => (name === 'configEditor' ? editor : undefined) }, root)
  const servers = await readMcpServers(root)
  const blender = servers.find(server => server.id === 'blender')
  check('sync mirrors a configured MCP row into the library', mirrored.written.includes('blender') && blender?.source === 'profile', {
    written: mirrored.written,
    blender: blender?.command,
  })
}

// Package specs that could smuggle shell syntax are refused.
{
  check('safe package specs pass', isSafePackageSpec('@modelcontextprotocol/server-filesystem') && isSafePackageSpec('some-pkg@1.2.3'), null)
  check('shell syntax is refused', isSafePackageSpec('pkg; rm -rf /') === false && isSafePackageSpec('pkg && echo x') === false, null)
}

// Skills: write, read, provider list/get, import.
{
  await writeSkill(root, { name: 'demo-skill', description: '演示技能', body: '# 演示\n\n步骤一。' })
  const skills = await readSkills(root)
  check('a skill lands in skills/<name>/SKILL.md', skills.length === 1 && skills[0].description === '演示技能', { skills: skills.map(skill => skill.name) })
  const provider = createSkillProvider(() => root)
  const candidates = await provider.list()
  const loaded = await provider.get(candidates[0])
  check('the provider lists and loads library skills', candidates.length === 1 && loaded.content.includes('步骤一'), { content: loaded.content?.slice(0, 20) })
  const source = mkdtempSync(join(tmpdir(), 'thinking-tree-skill-src-'))
  mkdirSync(join(source, 'copied'), { recursive: true })
  writeFileSync(join(source, 'copied', 'SKILL.md'), '---\nname: copied-skill\ndescription: 复制来的\n---\n\n正文\n', 'utf8')
  const imported = await importSkill(root, join(source, 'copied'))
  check('import copies an existing skill into the library', imported.name === 'copied-skill' && existsSync(join(skillFolderOf(root), 'copied-skill', 'SKILL.md')), { imported: imported.name })
  rmSync(source, { recursive: true, force: true })
}

// The registered tools operate on the same library.
{
  const tools = []
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: definition => { tools.push(definition); return () => undefined } }
      if (name === 'skills') return { registerProvider: factory => { factory({ signal: new AbortController().signal, invalidate: () => undefined }); return () => undefined } }
      return undefined
    },
    on() { return () => undefined },
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => undefined },
    connection: { fetch: { register: route => { routes.push(route); return () => undefined } } },
  }
  registerLibraries(ctx, { readJson, json, routePrefix: '/api/thinking-tree' })
  const mcpTool = tools.find(tool => tool.name === 'mcp_library')
  const skillTool = tools.find(tool => tool.name === 'skill_library')
  check('both management tools are registered', mcpTool !== undefined && skillTool !== undefined, { tools: tools.map(tool => tool.name) })
  const listed = await mcpTool.execute({ action: 'list' }, {})
  const created = await skillTool.execute({ action: 'create', name: 'tool-skill', description: '通过工具创建', body: '正文' }, {})
  check('mcp_library list sees the library', listed.ok === true && listed.servers.length >= 1, { count: listed.servers?.length })
  check('skill_library create writes into the library', created.ok === true && existsSync(join(skillFolderOf(root), 'tool-skill', 'SKILL.md')), created)
  const libraryRoute = routes.find(route => route.path.endsWith('/library'))
  const payload = await (await libraryRoute.fetch(new Request('http://local/api/thinking-tree/library'))).json()
  check('the library route returns both halves', payload.ok === true && Array.isArray(payload.mcp) && Array.isArray(payload.skills), {
    mcp: payload.mcp?.length, skills: payload.skills?.length,
  })

  // A click in the panel must load/unload right away, not after a restart.
  const live = new Set()
  const liveManager = {
    list: () => [...live].map(name => ({ name, configured: false })),
    register: (name) => { live.add(name); return () => { live.delete(name) } },
  }
  const toggles = []
  const toggleCtx = {
    get(name) {
      if (name === 'tools') return { register: definition => { toggles.push(definition); return () => undefined } }
      if (name === 'skills') return { registerProvider: () => () => undefined }
      if (name === 'mcpManager') return liveManager
      return undefined
    },
    on() { return () => undefined },
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => undefined },
    connection: { fetch: { register: () => () => undefined } },
  }
  await writeMcpServer(root, { id: 'toggle-demo', transport: 'stdio', command: 'node' })
  registerLibraries(toggleCtx, { readJson, json, routePrefix: '/api/thinking-tree' })
  const mcpTool2 = toggles.find(tool => tool.name === 'mcp_library')
  await mcpTool2.execute({ action: 'remount' }, {})
  check('an enabled library server is loaded on remount', live.has('toggle-demo') === true, { live: [...live] })
  const off = await mcpTool2.execute({ action: 'disable', id: 'toggle-demo' }, {})
  check('disable unloads immediately', off.ok === true && live.has('toggle-demo') === false, { off, live: [...live] })
  const on = await mcpTool2.execute({ action: 'enable', id: 'toggle-demo' }, {})
  check('enable loads again immediately', on.ok === true && live.has('toggle-demo') === true, { on, live: [...live] })

  // The profile owns its namespaces; the library refuses to fake a switch.
  live.add('profile-owned')
  const ownedState = await mcpTool2.execute({ action: 'remount' }, {})
  await writeMcpServer(root, { id: 'profile-owned', transport: 'stdio', command: 'node' })
  await mcpTool2.execute({ action: 'remount' }, {})
  const refused = await mcpTool2.execute({ action: 'disable', id: 'profile-owned' }, {})
  check('a profile-owned server refuses a local switch', refused.ok === false && refused.error === 'profile-owned', { refused, owned: ownedState.mirrored })
}

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results: failed }, null, 1))
rmSync(root, { recursive: true, force: true })
process.exitCode = failed.length === 0 ? 0 : 1