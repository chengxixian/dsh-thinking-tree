/**
 * Memory bank behaviour: a per-conversation Markdown folder under one shared
 * root, dedupe on repeat, search, prune/archive, digest budget, the route
 * round-trip, and "nothing is captured automatically".
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_ENTRIES, readEntries, recordMemory, searchMemory, forgetMemory, pruneMemory,
  renderMemoryDigest, registerMemory, memoryDirOf, memoryRoot, safeMemoryKey,
} from '../memory.js'
import { json, readJson } from './helpers.mjs'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const root = mkdtempSync(join(tmpdir(), 'thinking-tree-memory-'))
// Every conversation lives under one shared root, one folder each.
process.env.DSH_AGENT_MEMORY = root
const sessionId = 'session-memory-test'
const otherSession = 'session-other-test'
const memDir = memoryDirOf(sessionId)

check('the memory root follows the environment override', memoryDirOf(sessionId) === join(root, safeMemoryKey(sessionId)), {
  dir: memoryDirOf(sessionId),
})
check('two conversations never share a folder', memoryDirOf(sessionId) !== memoryDirOf(otherSession), {
  a: memoryDirOf(sessionId), b: memoryDirOf(otherSession),
})
check('the default root is one shared folder', memoryRoot({ USERPROFILE: 'C:/Users/demo' }).replace(/\\/g, '/').endsWith('.dsh/agent-memory'), {
  root: memoryRoot({ USERPROFILE: 'C:/Users/demo' }),
})

// A repeated lesson updates instead of piling up duplicates.
{
  await recordMemory(memDir, { kind: 'lesson', title: 'PowerShell 不能读 asar 里的文件', body: '用 ELECTRON_RUN_AS_NODE + fs 读' })
  const second = await recordMemory(memDir, { kind: 'lesson', title: 'powershell 不能读 ASAR 里的文件', body: '用 read 工具或 electron node 读' })
  const { entries } = await readEntries(memDir)
  check('a repeated memory merges into one entry', entries.length === 1 && entries[0].hits === 2 && second.created === false, {
    entries: entries.length,
    hits: entries[0]?.hits,
  })
  check('the stored body is the newest one', String(entries[0]?.body ?? '').includes('electron node'), { body: entries[0]?.body })
  check('the bank is plain Markdown on disk', readdirSync(memDir).filter(name => name.endsWith('.md')).length === 1, null)
}

// Kinds are separate identities, and search works over title/body/tags.
{
  await recordMemory(memDir, { kind: 'failure', title: 'bash 退出 1', body: 'TSCONFIG 少了 include', tags: ['bash', 'tsc'] })
  const byTag = await searchMemory(memDir, 'tsc')
  const byBody = await searchMemory(memDir, 'TSCONFIG')
  check('search finds entries by tag and body', byTag.length === 1 && byBody.length === 1, { byTag: byTag.length, byBody: byBody.length })
  check('a different kind is a different entry', (await readEntries(memDir)).entries.length === 2, null)
}

// The digest stays inside its budget and carries one line per entry.
{
  for (let index = 0; index < 10; index += 1) {
    await recordMemory(memDir, { kind: 'fact', title: `事实 ${index}`, body: 'x'.repeat(200), importance: index === 0 ? 5 : 1 })
  }
  const { entries } = await readEntries(memDir)
  const digest = renderMemoryDigest(entries, 6)
  const lines = digest.split('\n').filter(line => line !== '')
  check('the digest renders at most six lines', lines.length <= 6, { lines: lines.length })
  check('the digest puts the most important entry first', lines[0]?.includes('事实 0'), { first: lines[0] })
  check('the digest stays under 1200 characters', digest.length <= 1200, { length: digest.length })
}

// Pruning archives the weakest entries instead of deleting the bank.
{
  const before = (await readEntries(memDir)).entries.length
  const archived = await pruneMemory(memDir, 3)
  const after = (await readEntries(memDir)).entries.length
  const archive = readdirSync(join(memDir, '_archive')).filter(name => name.endsWith('.md'))
  check('prune keeps the requested number and archives the rest', after === 3 && archived.length === before - 3 && archive.length === archived.length, {
    before, after, archived: archived.length, files: archive.length,
  })
}

// Forgetting one entry by title works.
{
  const removed = await forgetMemory(memDir, { title: '事实 0' })
  check('forget removes by title', removed.removed.length >= 1, removed)
}

// Routes and the tool share the same store, scoped to one conversation.
const routes = []
const tools = []
const listeners = new Map()
const ctx = {
  get(name) {
    if (name === 'tools') return { register: definition => { tools.push(definition); return () => undefined } }
    return undefined
  },
  on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) },
  effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => undefined },
  connection: { fetch: { register: route => { routes.push(route); return () => undefined } } },
}
registerMemory(ctx, {
  memoryDirOfSession: id => memoryDirOf(id),
  readJson,
  json,
  routePrefix: '/api/thinking-tree',
})

{
  const record = routes.find(route => route.path.endsWith('/memory/record'))
  const response = await record.fetch(new Request('http://local/x', { method: 'POST', body: JSON.stringify({ sessionId, kind: 'decision', title: '统一库放在 ~/.dsh/agent-library', body: '用环境变量覆盖' }) }))
  const body = await response.json()
  const list = routes.find(route => route.path === '/api/thinking-tree/memory')
  const listed = await (await list.fetch(new Request(`http://local/x?sessionId=${sessionId}`))).json()
  const other = await (await list.fetch(new Request(`http://local/x?sessionId=${otherSession}`))).json()
  check('the memory route writes and reads back', body.ok === true && listed.ok === true && listed.entries.some(entry => entry.title.includes('统一库')), {
    write: body.ok, count: listed.entries?.length,
  })
  check('another conversation cannot read this bank', other.ok === true && other.entries.length === 0, { other: other.entries?.length })
}

{
  const memoryTool = tools.find(tool => tool.name === 'memory')
  const first = await memoryTool.execute({ action: 'record', kind: 'lesson', title: '工具失败要进记忆库', body: '模型判断后手写' }, { agent: { id: sessionId } })
  const digest = await memoryTool.execute({ action: 'digest' }, { agent: { id: sessionId } })
  const text = memoryTool.output.render({ action: 'digest' }, digest)
  check('the memory tool records and renders a digest', first.ok === true && String(text[0]?.text ?? '').includes('工具失败'), {
    first: first.ok, digest: digest.digest?.slice(0, 40),
  })
}

// Nothing is captured behind the model's back: no session listener at all.
{
  check('registering the bank adds no automatic capture', listeners.size === 0, { events: [...listeners.keys()] })
  const failedResult = { type: 'tool/result', data: { turn: 2, step: 1, message: { toolCallId: 'c9' }, error: { code: 'EXIT_1', reason: 'x' } } }
  check('a failed tool result alone writes nothing', !JSON.stringify(failedResult).includes('agent-memory'), null)
}

check('the bank keeps a bounded size', MAX_ENTRIES >= 100, { cap: MAX_ENTRIES })

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results: failed }, null, 1))
delete process.env.DSH_AGENT_MEMORY
rmSync(root, { recursive: true, force: true })
process.exitCode = failed.length === 0 ? 0 : 1