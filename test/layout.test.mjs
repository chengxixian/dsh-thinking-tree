/**
 * Geometry test for the mind map.
 *
 * It loads the layout code straight out of `client.js` — the same source that
 * runs in the browser — so the assertions describe the shipped algorithm, not a
 * copy of it. Run with `npm test`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
const start = source.indexOf('const GEO')
// The closing marker is a comment banner; accept either line ending so the
// test does not break when the file is reformatted.
const banner = (() => {
  const lf = source.indexOf('/* ---------------------------------------------------------------- *\n     * Styles')
  if (lf >= 0) return lf
  return source.indexOf('/* ---------------------------------------------------------------- *\r\n     * Styles')
})()
const end = banner
if (start < 0 || end < 0) throw new Error('the geometry block moved; update this test')
const api = new Function(`${source.slice(start, end)}; return { GEO, layoutMindMap, wrapText }`)()

const node = (name, title, body, status, children) => ({ name, id: name.replace(/\.md$/, ''), title, body, status, childNodes: children || [] })

const tree = [node('00-goal.md', '做一个思考链插件并发布到 GitHub', '把思考过程变成右侧边栏里一棵实时的树。', 'done', [
  node('01-req.md', '点窗口右侧按钮弹出侧边栏', '按钮在窗口右侧。', 'done', [
    node('01-1-plan.md', '复用内置右侧栏', '', 'done', [
      node('01-1-1-route.md', '标签页类型 + 键控槽位', '', 'done', [
        node('01-1-1-1-step.md', '调 openTab 打开并展开', '', 'done', []),
      ]),
    ]),
  ]),
  node('02-req-long.md', '这一条标题故意写得非常非常长，用来验证两行截断之后会出现展开按钮，而且展开以后能看到完整文字', '正文第一行也会被截断，展开后最多四行。', 'active', []),
  node('03-req.md', '每个块用 markdown 写在同一个文件夹', '', 'pending', [
    node('03-1-plan.md', 'front matter 承载结构', '', 'done', []),
    node('03-2-plan.md', '解析器对残缺文件容错', '', 'done', []),
    node('03-3-plan.md', '位置写进 front matter 的 x / y', '', 'active', []),
  ]),
])]

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const collapsed = api.layoutMindMap(tree, new Set(), {})
check('every node gets a box and every edge a link', collapsed.boxes.length === 10 && collapsed.links.length === 9, {
  boxes: collapsed.boxes.length,
  links: collapsed.links.length,
})

const columns = new Map()
for (const box of collapsed.boxes) {
  const key = Math.round(box.x)
  if (!columns.has(key)) columns.set(key, [])
  columns.get(key).push(box)
}
const overlaps = []
for (const [, list] of columns) {
  list.sort((a, b) => a.y - b.y)
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].y < list[i - 1].y + list[i - 1].height) overlaps.push([list[i - 1].node.name, list[i].node.name])
  }
}
check('no two boxes in one column overlap', overlaps.length === 0, overlaps)

const longBox = collapsed.boxes.find(box => box.node.name === '02-req-long.md')
const expanded = api.layoutMindMap(tree, new Set(['02-req-long.md']), {})
const expandedBox = expanded.boxes.find(box => box.node.name === '02-req-long.md')
check('a truncated block offers the expand control', longBox.toggle === true && longBox.lines.join('').includes('…'), {
  toggle: longBox.toggle,
})
check('expanding shows the whole title', expandedBox.lines.join('') === expandedBox.node.title && expandedBox.height > longBox.height, {
  collapsedLines: longBox.lines.length,
  expandedLines: expandedBox.lines.length,
})

const pinned = api.layoutMindMap(tree, new Set(), { '03-req.md': { x: 640, y: 12 } })
const pinnedBox = pinned.boxes.find(box => box.node.name === '03-req.md')
check('a dragged block keeps its own coordinates', pinnedBox.pinned === true && Math.round(pinnedBox.x) === 640 && Math.round(pinnedBox.y) === 12, {
  x: Math.round(pinnedBox.x),
  y: Math.round(pinnedBox.y),
  pinnedCount: pinned.boxes.filter(box => box.pinned).length,
})

const stored = tree.map(entry => ({ ...entry }))
stored[0].x = 30
stored[0].y = 44
const storedBox = api.layoutMindMap(stored, new Set(), {}).boxes.find(box => box.node.name === '00-goal.md')
check('a stored x/y in front matter is honoured', storedBox.pinned === true && Math.round(storedBox.x) === 30 && Math.round(storedBox.y) === 44, {
  x: Math.round(storedBox.x),
  y: Math.round(storedBox.y),
})

const wrapped = api.wrapText('这一条标题故意写得非常非常长，用来验证两行截断', 12.8, api.GEO.maxW - 26, 2)
check('text wraps to the budget', wrapped.lines.length <= 2 && wrapped.lines.every(line => typeof line === 'string'), {
  lines: wrapped.lines.length,
})

// A collapsed card shows one line of detail; opening it shows the whole body.
{
  const detailed = [node('00-goal.md', '目标', Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 步：用 node 把 out/items.json 写出来，字段保留 id/name/price。`).join('\n'), 'active', [])]
  const closed = api.layoutMindMap(detailed, new Set(), {}).boxes[0]
  const opened = api.layoutMindMap(detailed, new Set(['00-goal.md']), {}).boxes[0]
  check('a collapsed card keeps one detail line', closed.subLines.length === 1 && closed.toggle === true, {
    lines: closed.subLines.length,
    toggle: closed.toggle,
  })
  check('opening a card reveals the whole body', opened.subLines.length > 6 && opened.height > closed.height, {
    collapsedLines: closed.subLines.length,
    openLines: opened.subLines.length,
    collapsedHeight: Math.round(closed.height),
    openHeight: Math.round(opened.height),
  })
  check('the opened body starts at the first line and is capped', opened.subLines.length === 16 && opened.subLines[0].startsWith('第 1 步'), {
    lines: opened.subLines.length,
    first: opened.subLines[0],
  })
}

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1