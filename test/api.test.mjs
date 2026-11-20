/**
 * End-to-end test of the panel's write path.
 *
 * These are the same handlers the HTTP routes call, driven with real `Request`
 * objects against a throwaway workspace. The earlier "positions reset on every
 * update" bug lived exactly here: saving a body used to rewrite the whole file
 * and drop the front matter. Run with `npm test`.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readTree, shapeTree,
  serveTree, serveSave, serveCreate, serveStatus, serveTitle, serveModel, servePosition, serveArrange, serveDelete, serveSelfCheck,
} from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'thinking-tree-test-'))
const sessionId = 'session-test'
// A stand-in for the Host's session controller: it records the exact prompt
// request so the test can prove the wake-up uses the real contract.
const prompts = []
const ctx = {
  get(name) {
    if (name === 'sessions') return { get: id => (id === sessionId || id === 'session-other' ? { id, header: { cwd: root } } : undefined) }
    if (name === 'sessionController') {
      return {
        prompt: async request => {
          prompts.push(request)
          return { accepted: true }
        },
      }
    }
    return undefined
  },
}
const base = 'http://local/api/thinking-tree'
const post = (path, body) => new Request(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) })
const once = async (handler, request) => {
  const response = await handler(ctx, request)
  return { status: response.status, body: await response.json() }
}

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

{
  const res = await once(serveTree, new Request(`${base}/tree?sessionId=${sessionId}`))
  check('empty folder answers an empty tree', res.status === 200 && res.body.ok && res.body.nodes.length === 0, {
    nodes: res.body.nodes?.length,
  })
}

let goalName
{
  const res = await once(serveCreate, post('create', { sessionId, parent: '', title: '做一个东西' }))
  goalName = res.body.name
  const file = readFileSync(join(root, 'thinking-tree', 's-test', goalName), 'utf8')
  check('create writes front matter with a parent field', res.body.ok === true && /\nparent:/.test(file) && /status: pending/.test(file), {
    name: goalName,
  })
}

let childName
{
  const res = await once(serveCreate, post('create', { sessionId, parent: goalName.replace(/\.md$/, ''), title: '第一条要求' }))
  childName = res.body.name
  const shaped = shapeTree((await readTree(join(root, 'thinking-tree', 's-test'))).nodes)
  check('a child nests under its parent', shaped.roots.length === 1 && shaped.roots[0].children.length === 1, {
    roots: shaped.roots.length,
    children: shaped.roots[0]?.children.length,
  })
}

// Two conversations in one workspace must not share a chain.
{
  const other = 'session-other'
  const otherBefore = await once(serveTree, new Request(`${base}/tree?sessionId=${other}`))
  const mine = await once(serveTree, new Request(`${base}/tree?sessionId=${sessionId}`))
  check('another conversation starts with its own empty chain', otherBefore.body.ok === true && otherBefore.body.nodes.length === 0 && otherBefore.body.folder !== mine.body.folder, {
    nodes: otherBefore.body.nodes.length,
    ownFolder: mine.body.folder,
    otherFolder: otherBefore.body.folder,
  })
  check('the owning conversation still sees its chain', mine.body.nodes.length === 2, { nodes: mine.body.nodes.length })
  const created = await once(serveCreate, post('create', { sessionId: other, parent: '', title: '另一个对话的目标' }))
  const otherAfter = await once(serveTree, new Request(`${base}/tree?sessionId=${other}`))
  const mineAfter = await once(serveTree, new Request(`${base}/tree?sessionId=${sessionId}`))
  check('each conversation only sees its own nodes',
    otherAfter.body.nodes.length === 1 && otherAfter.body.nodes[0].name === created.body.name &&
      mineAfter.body.nodes.length === 2 && !mineAfter.body.nodes.some(node => node.name === created.body.name), {
      other: otherAfter.body.nodes.length,
      mine: mineAfter.body.nodes.length,
    })
}

{
  const res = await once(serveSave, post('save', { sessionId, name: childName, content: '写好的一条要求\n第二行\n' }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('saving a body keeps the front matter', res.body.ok === true && node.parent !== '' && node.body.includes('写好的一条要求'), {
    parent: node.parent,
    body: node.body.trim().split('\n')[0],
  })
}

{
  await once(serveTitle, post('title', { sessionId, name: childName, title: '点右侧按钮弹出侧边栏' }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('renaming changes the title and keeps the body', node.title === '点右侧按钮弹出侧边栏' && node.body.includes('写好的一条要求'), {
    title: node.title,
  })
}

{
  const good = await once(serveModel, post('model', { sessionId, name: childName, model: 'deepseek/deepseek-chat' }))
  const bad = await once(serveModel, post('model', { sessionId, name: childName, model: 'no-slash' }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('a model route is stored and a malformed one is refused', good.body.ok && bad.status === 400 && node.model === 'deepseek/deepseek-chat', {
    model: node.model,
    invalidStatus: bad.status,
  })
}

{
  await once(serveStatus, post('status', { sessionId, name: childName, status: 'active' }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('status is stored', node.status === 'active', null)
}

{
  await once(servePosition, post('position', { sessionId, name: childName, x: 401, y: 96 }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('a pinned position round trips', node.x === 401 && node.y === 96, { x: node.x, y: node.y })
}

{
  const res = await once(serveArrange, post('arrange', { sessionId }))
  const node = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === childName)
  check('auto layout clears the pins', res.body.cleared >= 1 && node.x === undefined && node.y === undefined, {
    cleared: res.body.cleared,
  })
}

{
  const traversal = await once(serveSave, post('save', { sessionId, name: '../../evil.md', content: 'x' }))
  const unknown = await once(serveTree, new Request(`${base}/tree?sessionId=nobody`))
  const badName = await once(serveSave, post('save', { sessionId, name: 'ok.md', content: 'x' }))
  check('a traversal name is refused', traversal.status === 400, { status: traversal.status })
  check('an unknown session is refused', unknown.status === 400 && unknown.body.error === 'unknown-session', unknown.body)
  check('a plain .md name is accepted', badName.body.ok === true, badName.body)
}

{
  const res = await once(serveSelfCheck, post('selfcheck', { sessionId, mode: 'on' }))
  const goal = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === goalName)
  check('the self-check flag lands on the goal node', res.body.selfcheck === 'on' && goal.selfcheck === 'on', {
    goal: goal.selfcheck,
  })
  const wake = prompts[0]
  check('enabling self-check wakes the agent with a valid prompt request', res.body.poked === true && wake !== undefined && typeof wake.requestId === 'string' && wake.requestId.length > 0 && wake.mode === 'queue' && wake.content?.[0]?.type === 'text' && typeof wake.content[0].text === 'string', {
    poked: res.body.poked,
    requestId: wake?.requestId,
    mode: wake?.mode,
    parts: wake?.content?.length,
  })
}

{
  const off = await once(serveSelfCheck, post('selfcheck', { sessionId, mode: 'off' }))
  const goalOff = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === goalName)
  check('stopping self-check never fakes a pass', off.body.selfcheck === 'off' && goalOff.selfcheck === 'off', {
    state: off.body.selfcheck,
    file: goalOff.selfcheck,
  })
  const pass = await once(serveSelfCheck, post('selfcheck', { sessionId, mode: 'pass' }))
  const goalPassed = (await readTree(join(root, 'thinking-tree', 's-test'))).nodes.find(n => n.name === goalName)
  check('only an explicit pass marks the goal passed', pass.body.selfcheck === 'passed' && goalPassed.selfcheck === 'passed', {
    state: pass.body.selfcheck,
    file: goalPassed.selfcheck,
  })
}

{
  const res = await once(serveDelete, post('delete', { sessionId, name: goalName, cascade: true }))
  const left = readdirSync(join(root, 'thinking-tree', 's-test'))
  check('a cascade delete removes the subtree', res.body.deleted.length === 2 && !left.includes(goalName) && !left.includes(childName), {
    deleted: res.body.deleted,
    left,
  })
}

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
rmSync(root, { recursive: true, force: true })
process.exitCode = failed.length === 0 ? 0 : 1