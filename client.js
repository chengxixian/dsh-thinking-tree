/**
 * Browser half of the thinking-tree bundle.
 *
 * Two surfaces, one state:
 *
 * - A pill on the right edge of the window, mounted as plain DOM on
 *   `document.body` so `position: fixed` reaches the real viewport.
 * - The `thinking-tree` tab type of the right Sidebar, which draws the chain as
 *   a mind map: the goal on the left, branches to the right, curved links, and
 *   one editable Markdown file behind every node.
 *
 * The tree lives on disk (`<workspace>/thinking-tree/*.md`). This module only
 * reads and writes it through the Host's JSON routes, so the panel and the agent
 * always see the same files. While the panel is open it re-reads the folder,
 * which is what makes the map grow live while the agent works.
 */
window.__ModuleLoader__.load({
  id: 'dsh-thinking-tree',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ---------------------------------------------------------------- *
     * litegraph renderer (ComfyUI-style node canvas)
     * ---------------------------------------------------------------- */

    /**
     * A minimal litegraph renderer, ported from the drawing semantics
     * ComfyUI's frontend uses for its canvas: node frame + title bar + color,
     * input/output sockets with names, widgets, bezier links, and group boxes.
     * Read-only: it shows the real saved workflow graph inside the DSH canvas;
     * editing the graph itself still happens in ComfyUI.
     */

/**
 * ComfyUI's own palette, ported from litegraph's `node_colors` table: each
 * entry is the title bar / body pair ComfyUI paints for a node category.
 */
const COMFY_NODE_COLORS = {
  red: { title: '#a13030', body: '#3b1c1c' },
  green: { title: '#37723f', body: '#1d2f1f' },
  blue: { title: '#2a568c', body: '#1b2436' },
  pale_blue: { title: '#3f5159', body: '#2a363b' },
  cyan: { title: '#2f6b74', body: '#1c2c30' },
  purple: { title: '#6d3f8c', body: '#2c1d36' },
  yellow: { title: '#8c6d2a', body: '#3a2c17' },
  brown: { title: '#7a5333', body: '#32241a' },
  black: { title: '#333333', body: '#1e1e1e' },
}

/**
 * ComfyUI's link colors, keyed by the socket type it paints them with.
 */
const COMFY_LINK_COLORS = {
  MODEL: '#b39ddb',
  CLIP: '#ffd500',
  VAE: '#ff6e6e',
  IMAGE: '#64b5f6',
  MASK: '#81c784',
  LATENT: '#ff9cf9',
  CONDITIONING: '#ffa931',
  CONTROL_NET: '#a2dc6c',
  NOISE: '#cccccc',
  SAMPLER: '#b0b0b0',
  SIGMAS: '#9c9c9c',
  GUIDER: '#e0b060',
  INT: '#b0d0a0',
  FLOAT: '#b0d0a0',
  STRING: '#c0c0a0',
  default: '#9aa4ae',
}

/**
 * Pick the ComfyUI palette entry for one node class.
 * @param {string} type - node class name.
 * @returns {{ title: string, body: string }} colors.
 */
function nodePalette(type) {
  const text = String(type ?? '').toLowerCase()
  if (/save|preview|display/.test(text)) return COMFY_NODE_COLORS.red
  if (/unet|lora|checkpoint|model/.test(text)) return COMFY_NODE_COLORS.purple
  if (/clip|textenc|encode|prompt/.test(text)) return COMFY_NODE_COLORS.yellow
  if (/vae/.test(text)) return COMFY_NODE_COLORS.red
  if (/latent|empty/.test(text)) return COMFY_NODE_COLORS.cyan
  if (/sampler|noise|guider|sigmas|scheduler|steps/.test(text)) return COMFY_NODE_COLORS.blue
  if (/load|upload/.test(text)) return COMFY_NODE_COLORS.green
  if (/image|upscale|resize/.test(text)) return COMFY_NODE_COLORS.pale_blue
  return COMFY_NODE_COLORS.brown
}

/**
 * Pick a LiteGraph-style title-bar color for one node class.
 * @param {string} type - node class name.
 * @returns {string} css color.
 */
function nodeColor(type) {
  return nodePalette(type).title
}

/**
 * Link color for one socket type, following ComfyUI's link table.
 * @param {string} socketType - e.g. IMAGE, MODEL, INT.
 * @returns {string} css color.
 */
function linkColor(socketType) {
  const key = String(socketType ?? '').toUpperCase()
  return COMFY_LINK_COLORS[key] ?? COMFY_LINK_COLORS.default
}

/**
 * Measure and lay out one litegraph canvas view.
 * @param {{ nodes: object[], links: unknown[] }} ui - litegraph serialisation.
 * @returns {{ bounds: object, byId: Map<string, object> }} layout data.
 */
function layoutLitegraph(ui) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const byId = new Map()
  for (const node of ui?.nodes ?? []) {
    const pos = Array.isArray(node.pos) ? node.pos : [0, 0]
    const size = Array.isArray(node.size) ? node.size : [220, 120]
    const x = Number(pos[0]) || 0
    const y = Number(pos[1]) || 0
    const w = Math.max(120, Number(size[0]) || 220)
    const h = Math.max(60, Number(size[1]) || 120)
    byId.set(String(node.id), { ...node, x, y, w, h })
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 400
    maxY = 300
  }
  return { bounds: { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) }, byId }
}

/**
 * Draw one litegraph view onto a canvas context.
 * @param {CanvasRenderingContext2D} ctx - target context.
 * @param {{ nodes: object[], links: unknown[] }} ui - serialised graph.
 * @param {{ width: number, height: number, dpr?: number, offsetX?: number, offsetY?: number, scale?: number, highlight?: string[] }} options - viewport.
 * @returns {{ positions: Map<string, object>, scale: number }} where each node landed.
 */
function drawLitegraph(ctx, ui, options = {}) {
  const { width, height, dpr = 1, offsetX = 0, offsetY = 0, highlight = [] } = options
  const { bounds, byId } = layoutLitegraph(ui)
  const padded = { x: bounds.x - 24, y: bounds.y - 24, width: bounds.width + 48, height: bounds.height + 48 }
  const fit = Math.min(width / padded.width, height / padded.height)
  const scale = Math.max(0.05, Math.min(2, (options.scale ?? 1) * fit))
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = 'rgba(127,127,127,.06)'
  ctx.fillRect(0, 0, width, height)
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)
  ctx.translate(-padded.x, -padded.y)

  // Groups first, behind everything.
  for (const group of ui?.groups ?? []) {
    const box = Array.isArray(group.bounding) ? group.bounding : [0, 0, 0, 0]
    ctx.fillStyle = `${group.color === 'blue' ? '#2b5' : '#888'}14`
    ctx.strokeStyle = 'rgba(150,150,150,.45)'
    ctx.lineWidth = 1.5
    roundRect(ctx, box[0], box[1], box[2], box[3], 8)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = 'rgba(180,180,180,.8)'
    ctx.font = '13px sans-serif'
    ctx.fillText(String(group.title ?? ''), box[0] + 8, box[1] + 16)
  }

  // Links as bezier curves between socket anchors.
  const linkList = Array.isArray(ui?.links) ? ui.links : []
  const byLink = new Map()
  for (const link of linkList) {
    if (!Array.isArray(link)) continue
    byLink.set(link[0], link)
  }
  for (const link of linkList) {
    if (!Array.isArray(link)) continue
    const [, originId, originSlot, targetId, targetSlot] = link
    const from = byId.get(String(originId))
    const to = byId.get(String(targetId))
    if (from === undefined || to === undefined) continue
    const outputs = Array.isArray(from.outputs) ? from.outputs : []
    const inputs = Array.isArray(to.inputs) ? to.inputs : []
    const a = anchorOut(from, Number(originSlot) || 0, outputs.length)
    const b = anchorIn(to, Number(targetSlot) || 0, inputs.length)
    // ComfyUI colors a link by the type of the socket it leaves from.
    const socketType = outputs[Number(originSlot) || 0]?.type
    ctx.strokeStyle = linkColor(socketType)
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5)
    ctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y)
    ctx.stroke()
  }

  // Nodes.
  const positions = new Map()
  for (const node of byId.values()) {
    const highlighted = highlight.includes(String(node.id))
    const palette = nodePalette(node.type)
    const color = palette.title
    // ComfyUI paints a darker body and a colored title bar per category.
    ctx.fillStyle = palette.body
    ctx.strokeStyle = highlighted ? '#ffd166' : 'rgba(150,150,150,.55)'
    ctx.lineWidth = highlighted ? 2.5 : 1.2
    roundRect(ctx, node.x, node.y, node.w, node.h, 6)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = color
    roundRectTop(ctx, node.x, node.y, node.w, 24, 6)
    ctx.fill()
    ctx.fillStyle = '#eef2f5'
    ctx.font = 'bold 12px sans-serif'
    ctx.fillText(clipToWidth(ctx, String(node.title ?? node.type ?? ''), node.w - 16), node.x + 8, node.y + 16)

    const inputs = Array.isArray(node.inputs) ? node.inputs : []
    const outputs = Array.isArray(node.outputs) ? node.outputs : []
    const rows = Math.max(inputs.length, outputs.length)
    for (let i = 0; i < rows; i += 1) {
      const y = node.y + 36 + i * 18
      const input = inputs[i]
      if (input !== undefined) {
        socket(ctx, node.x, y, false)
        ctx.fillStyle = '#cfd6dd'
        ctx.font = '11px sans-serif'
        ctx.fillText(clipToWidth(ctx, String(input.name ?? ''), node.w / 2), node.x + 12, y + 4)
      }
      const output = outputs[i]
      if (output !== undefined) {
        socket(ctx, node.x + node.w, y, true)
        ctx.fillStyle = '#cfd6dd'
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'right'
        ctx.fillText(clipToWidth(ctx, String(output.name ?? ''), node.w / 2), node.x + node.w - 12, y + 4)
        ctx.textAlign = 'left'
      }
    }

    // Widgets below the socket band, like the real canvas.
    const widgets = widgetValues(node)
    const start = node.y + 36 + rows * 18 + 6
    for (let i = 0; i < widgets.length; i += 1) {
      const y = start + i * 20
      if (y > node.y + node.h - 8) break
      ctx.fillStyle = 'rgba(70,74,80,.9)'
      roundRect(ctx, node.x + 8, y - 11, node.w - 16, 16, 3)
      ctx.fill()
      ctx.fillStyle = '#e6ebef'
      ctx.font = '10px sans-serif'
      ctx.fillText(clipToWidth(ctx, `${widgets[i].name}: ${widgets[i].value}`, node.w - 24), node.x + 12, y)
    }
    positions.set(String(node.id), node)
  }
  ctx.restore()
  return { positions, scale }
}

/**
 * Collect display widgets from either litegraph shape.
 * @param {object} node - raw node.
 * @returns {{ name: string, value: string }[]} up to eight rows.
 */
function widgetValues(node) {
  if (Array.isArray(node.widgets_values)) {
    return node.widgets_values.slice(0, 8).map((value, index) => ({ name: `#${index + 1}`, value: short(value) }))
  }
  const entries = Object.entries(node.inputs ?? {})
  return entries.filter(([, value]) => !Array.isArray(value)).slice(0, 8).map(([name, value]) => ({ name, value: short(value) }))
}

/**
 * Shorten any widget value for display.
 * @param {unknown} value - raw widget value.
 * @returns {string} text.
 */
function short(value) {
  if (Array.isArray(value)) return `[${value.map(short).join(', ')}]`
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 24)
  return String(value).slice(0, 48)
}

/**
 * Anchor point of an output socket.
 * @param {object} node - laid-out node.
 * @param {number} slot - socket index.
 * @param {number} count - total outputs.
 * @returns {{ x: number, y: number }} point.
 */
function anchorOut(node, slot, count) {
  return { x: node.x + node.w, y: node.y + 36 + slot * 18 + (count === 0 ? 0 : 0) }
}

/**
 * Anchor point of an input socket.
 * @param {object} node - laid-out node.
 * @param {number} slot - socket index.
 * @param {number} count - total inputs.
 * @returns {{ x: number, y: number }} point.
 */
function anchorIn(node, slot, count) {
  void count
  return { x: node.x, y: node.y + 36 + slot * 18 }
}

/**
 * Draw one socket circle.
 * @param {CanvasRenderingContext2D} ctx - context.
 * @param {number} x - center x.
 * @param {number} y - center y.
 * @param {boolean} out - output side.
 */
function socket(ctx, x, y, out) {
  ctx.fillStyle = out ? '#9ecbff' : '#8fe3a1'
  ctx.beginPath()
  ctx.arc(x, y, 4, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Rounded rectangle path.
 * @param {CanvasRenderingContext2D} ctx - context.
 * @param {number} x - left.
 * @param {number} y - top.
 * @param {number} w - width.
 * @param {number} h - height.
 * @param {number} r - radius.
 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Rounded top half only (title bars).
 * @param {CanvasRenderingContext2D} ctx - context.
 * @param {number} x - left.
 * @param {number} y - top.
 * @param {number} w - width.
 * @param {number} h - height.
 * @param {number} r - radius.
 */
function roundRectTop(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Ellipsize text to a pixel budget.
 * @param {CanvasRenderingContext2D} ctx - context with font set.
 * @param {string} text - source.
 * @param {number} max - pixels.
 * @returns {string} possibly truncated text.
 */
function clipToWidth(ctx, text, max) {
  const value = String(text ?? '')
  if (typeof ctx.measureText !== 'function') return value
  if (ctx.measureText(value).width <= max) return value
  let out = value
  while (out.length > 1 && ctx.measureText(out + '\u2026').width > max) out = out.slice(0, -1)
  return out + '\u2026'
}

    /** Tab kind opened by the edge button and listed in the guide. */
    const TAB_KIND = 'thinking-tree'
    /** This implementation's identity; the key its body registers under. */
    const TAB_ID = 'dsh-thinking-tree'
    /** Locale namespace. */
    const NS = 'thinkingTree'
    /** Route prefix, relative so a path-prefixing proxy keeps working. */
    const API = 'api/thinking-tree'
    /** How often the open panel re-reads the folder. */
    const POLL_MS = 1500
    /** Statuses in cycle order. */
    const STATUS_CYCLE = ['pending', 'active', 'done', 'blocked']
    /** Mind-map geometry. */
    const GEO = { padX: 13, padY: 9, gapX: 54, gapY: 12, minW: 92, maxW: 288, line: 17, subLine: 15 }

    const EN = {
      tabTitle: 'Thinking tree',
      mcpLibrary: 'MCP',
      mcpLibraryHint: 'Every MCP server in the shared library, enabled or not',
      mcpEnabled: 'enabled',
      mcpDisabled: 'disabled',
      mcpMounted: 'running',
      mcpMirrored: 'from profile',
      mcpPending: 'enabled, not mounted',
      mcpEmpty: 'The shared MCP library is empty',
      mcpLoading: 'Reading the library…',
      mcpFailed: 'Could not read the MCP library',
      mcpRoot: 'Library folder',
      mcpTotal: 'servers',
      mcpRefresh: 'Refresh',
      mcpLoaded: 'Loaded',
      mcpAvailable: 'Available',
      mcpLoad: 'Load this MCP',
      mcpUnload: 'Unload this MCP',
      mcpProfileOwned: 'Configured by the profile; the library only mirrors it',
      mcpNoneLoaded: 'Nothing loaded yet — pick one below',
      mcpAllLoaded: 'Everything in the library is loaded',
      guideTitle: 'Thinking tree',
      guideDesc: 'Goal, approach, and steps as an editable mind map',
      edgeLabel: 'Open thinking tree',
      refresh: 'Refresh',
      empty: 'No thinking chain yet',
      emptyHint: 'Every node is one Markdown file in the workspace folder below.',
      goalPlaceholder: 'What is the goal?',
      create: 'Create goal',
      addChild: 'Add child',
      addChildPlaceholder: 'Title of the new node',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Delete again to confirm',
      close: 'Close',
      goal: 'Goal',
      approach: 'Approach',
      step: 'Step',
      loading: 'Reading the chain…',
      noSession: 'No session on screen',
      saving: 'Saving…',
      fail: 'Failed',
      statusPending: 'Pending',
      statusActive: 'In progress',
      statusDone: 'Done',
      statusBlocked: 'Blocked',
      chars: 'chars',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      fit: 'Fit',
      hint: 'Click a node to edit it · hold the left button on a node to move it · wheel to zoom',
      nodeTitle: 'Title',
      nodeModel: 'Model',
      inherit: 'Inherit the session model',
      modelEmpty: 'No model configured',
      crashTitle: 'The panel failed to render; send the text below to the author',
      selfcheckOff: 'Self-check',
      selfcheckOn: 'Checking',
      selfcheckPassed: 'Passed',
      selfcheckStopped: 'Stopped',
      selfcheckHint: 'Once on, every finished turn re-checks the chain and keeps working until the goal passes',
      selfcheckNoWake: 'Self-check is on, but the agent could not be woken automatically; say "self-check" once',
      selfcheckStarted: 'Self-check started: the agent is checking the chain against the goal now',
      selfcheckLoop: 'every turn continues it · 40 rounds max',
      selfcheckCounting: 'requirements',
      newNode: 'New node',
      addHint: 'Add a child block',
      deleteHint: 'Delete this block and its subtree',
      expandText: 'Show the whole text',
      collapseText: 'Collapse',
      arrange: 'Auto layout',
      moved: 'Moved',
      wfOpen: 'Workflow',
      wfTitle: 'AI workflow',
      wfHint: 'Left-drag a node · right-click to edit · wheel to zoom',
      wfAddModel: '+ Model',
      wfAddExchange: '+ Exchange',
      wfAddComfy: '+ ComfyUI',
      wfAddInput: '+ Input',
      wfAddLeader: '+ Leader',
      wfAddOutput: '+ Output',
      wfChatInput: 'Chat input',
      wfChatInputHint: 'The newest text typed in the main composer; Send passes it to the next node.',
      wfReadNow: 'Read composer',
      wfAutoRead: 'Follow the composer',
      wfOutputNode: 'Output',
      wfOutputHint: 'Whatever arrives here is also posted as the main reply.',
      wfPublished: 'Posted to chat',
      wfNotPublished: 'Not posted yet',
      wfResend: 'Post again',
      wfCheckUpdates: 'Check workflow updates',
      wfLeaderTitle: 'Leader · main chat',
      wfLeaderHint: 'This node is the conversation itself: it dispatches the composer text to its members and collects their results as the reply.',
      wfLeaderOnlyOne: 'There is already a Leader node',
      wfLeaderMembers: 'member results',
      wfLeaderUserInput: 'user message',
      wfDeleteEdge: 'Delete connection',
      wfCancel: 'Cancel',
      wfRun: 'Run',
      wfStop: 'Stop',
      wfSaved: 'Saved',
      wfSaving: 'Saving…',
      wfEmpty: 'Empty workflow',
      wfEmptyHint: 'Add a model node, then connect its output into another node or an exchange node.',
      wfModel: 'Model',
      wfPrompt: 'Node prompt',
      wfPromptHint: 'This prompt is the whole system context of this node. Other nodes never see it.',
      wfTools: 'Tools',
      wfSkills: 'Skills',
      wfMcps: 'MCP',
      wfNoTools: 'No tools selected',
      wfInput: 'Input',
      wfOutput: 'Output',
      wfExchange: 'Exchange',
      wfDispatch: 'Dispatch',
      wfDelete: 'Delete node',
      wfExchangePrompt: 'Exchange prompt',
      wfExchangeHint: 'Tell the model which upstream output to take, how to rewrite it, which downstream node gets it, and in what shape.',
      wfMode: 'Mode',
      wfModeAuto: 'Model routes by prompt',
      wfModeFanout: 'Copy to every downstream node',
      wfComfy: 'ComfyUI',
      wfComfyUrl: 'Server URL',
      wfComfyCheck: 'Check server',
      wfComfyStart: 'Start backend',
      wfComfyWorkflows: 'Workflow',
      wfComfyPrompt: 'Prompt text',
      wfComfySeed: 'Seed',
      wfComfySize: 'Size',
      wfComfyOverrides: 'Overrides (node id → inputs JSON)',
      wfComfyRefresh: 'Refresh list',
      wfComfyNotReady: 'ComfyUI is not reachable',
      wfComfyReady: 'ComfyUI is ready',
      wfComfyUiFormat: 'UI format — export API JSON to run',
      wfImage: 'Result',
      wfNoSession: 'No session on screen',
      wfRunDone: 'Run finished',
      wfRunFailed: 'Run failed',
      wfRunRunning: 'Running',
      wfCloseEditor: 'Close editor',
      wfViewGraph: 'View node graph',
      wfGraph: 'Graph',
      wfJson: 'JSON',
      wfZoomIn: 'Zoom in',
      wfZoomOut: 'Zoom out',
      wfGraphEmpty: 'No nodes in this workflow',
      wfNodeLib: 'Node library',
      wfNodeLibHint: 'The full ComfyUI node catalog read live from /object_info.',
      wfTargetPositive: 'Positive → node',
      wfTargetNegative: 'Negative → node',
      wfTargetReference: 'Reference image → node',
      wfPositive: 'Positive prompt',
      wfNegative: 'Negative prompt',
      wfReference: 'Reference image',
      wfUpload: 'Choose image',
      wfClear: 'Clear',
      wfCollapse: 'Collapse graph',
      wfExpand: 'Expand graph',
      wfNoNegative: 'This workflow has no negative-prompt input',
      wfPreview: 'Preview submit',
    }

    const ZH = {
      tabTitle: '思考链',
      mcpLibrary: 'MCP',
      mcpLibraryHint: '统一库里的全部 MCP 服务，含已启用/已停用',
      mcpEnabled: '已启用',
      mcpDisabled: '已停用',
      mcpMounted: '运行中',
      mcpMirrored: 'profile 提供',
      mcpPending: '已启用但未挂载',
      mcpEmpty: '统一 MCP 库还是空的',
      mcpLoading: '正在读取库…',
      mcpFailed: '读不到 MCP 库',
      mcpRoot: '库目录',
      mcpTotal: '个服务',
      mcpRefresh: '刷新',
      mcpLoaded: '已加载',
      mcpAvailable: '可加载',
      mcpLoad: '加载这个 MCP',
      mcpUnload: '卸载这个 MCP',
      mcpProfileOwned: '由 profile 配置提供，库里只是镜像',
      mcpNoneLoaded: '还没有加载任何 MCP，从下面挑一个',
      mcpAllLoaded: '库里的 MCP 都已加载',
      guideTitle: '思考链',
      guideDesc: '目标、路线、步骤，一张可编辑的思维导图',
      edgeLabel: '打开思考链',
      refresh: '刷新',
      empty: '还没有思考链',
      emptyHint: '每个块都是工作区下面这个文件夹里的一份 Markdown。',
      goalPlaceholder: '目标是什么？',
      create: '创建目标',
      addChild: '加子节点',
      addChildPlaceholder: '新节点的标题',
      save: '保存',
      cancel: '取消',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '再点一次删除',
      close: '关闭',
      goal: '目标',
      approach: '路线',
      step: '步骤',
      loading: '正在读取思考链…',
      noSession: '当前没有会话',
      saving: '保存中…',
      fail: '失败',
      statusPending: '待办',
      statusActive: '进行中',
      statusDone: '完成',
      statusBlocked: '受阻',
      chars: '字符',
      zoomIn: '放大',
      zoomOut: '缩小',
      fit: '适应',
      hint: '点节点改 · 左键长按拖动块 · 滚轮缩放',
      nodeTitle: '标题',
      nodeModel: '模型',
      inherit: '跟随会话模型',
      modelEmpty: '未配置模型',
      crashTitle: '面板渲染出错，把下面这段发给作者',
      selfcheckOff: '自检',
      selfcheckOn: '自检中',
      selfcheckPassed: '已通过',
      selfcheckStopped: '自检已停',
      selfcheckHint: '开启后每轮结束都按思考链自检，未达成目标就继续做，直到通过',
      selfcheckNoWake: '自检已开启，但没能自动唤醒模型，发一句“自检”即可',
      selfcheckStarted: '自检已开始：模型正在按思考链逐条核对目标',
      selfcheckLoop: '每轮结束自动继续 · 最多 40 轮',
      selfcheckCounting: '条要求',
      newNode: '新节点',
      addHint: '加子节点',
      deleteHint: '删除这个块及其子树',
      expandText: '展开全文',
      collapseText: '收起',
      arrange: '自动排列',
      moved: '已移动',
      wfOpen: '工作流',
      wfTitle: 'AI 工作流',
      wfHint: '左键拖动节点 · 右键编辑 · 滚轮缩放',
      wfAddModel: '＋模型',
      wfAddExchange: '＋交换',
      wfAddComfy: '＋ComfyUI',
      wfAddInput: '＋输入',
      wfAddLeader: '＋Leader',
      wfAddOutput: '＋输出',
      wfChatInput: '对话栏输入',
      wfChatInputHint: '取主界面对话框最新输入的文字；点「运行」就把它送进下游节点。',
      wfReadNow: '读取对话栏',
      wfAutoRead: '跟随对话栏',
      wfOutputNode: '输出',
      wfOutputHint: '流到这里的内容同时作为主界面回复。',
      wfPublished: '已回复到主界面',
      wfNotPublished: '尚未回复',
      wfResend: '再次回复',
      wfCheckUpdates: '检查更新工作流',
      wfLeaderTitle: 'Leader · 主界面对话',
      wfLeaderHint: '这个节点就是主界面这场对话：把对话栏文字派给成员，并收集成员结果作为回复。',
      wfLeaderOnlyOne: '已经有一个 Leader 节点了',
      wfLeaderMembers: '成员回报',
      wfLeaderUserInput: '用户消息',
      wfDeleteEdge: '删除连线',
      wfCancel: '取消',
      wfRun: '运行',
      wfStop: '停止',
      wfSaved: '已保存',
      wfSaving: '保存中…',
      wfEmpty: '空工作流',
      wfEmptyHint: '先加一个模型节点，再把它的输出连到另一个节点或交换节点。',
      wfModel: '模型',
      wfPrompt: '节点提示词',
      wfPromptHint: '这段提示词就是该节点的全部系统上下文，别的节点看不到。',
      wfTools: '工具',
      wfSkills: '技能',
      wfMcps: 'MCP',
      wfNoTools: '未选工具',
      wfInput: '输入',
      wfOutput: '输出',
      wfExchange: '交换',
      wfDispatch: '分发',
      wfDelete: '删除节点',
      wfExchangePrompt: '交换提示词',
      wfExchangeHint: '写清从上游拿什么、怎么改写、给哪个下游、用什么格式。',
      wfMode: '模式',
      wfModeAuto: '模型按提示词分发',
      wfModeFanout: '原样复制给所有下游',
      wfComfy: 'ComfyUI',
      wfComfyUrl: '服务地址',
      wfComfyCheck: '检测服务',
      wfComfyStart: '启动后端',
      wfComfyWorkflows: '工作流',
      wfComfyPrompt: '提示词',
      wfComfySeed: '种子',
      wfComfySize: '尺寸',
      wfComfyOverrides: '覆盖（节点 id → inputs JSON）',
      wfComfyRefresh: '刷新列表',
      wfComfyNotReady: 'ComfyUI 未就绪',
      wfComfyReady: 'ComfyUI 已就绪',
      wfComfyUiFormat: 'UI 格式，请导出 API JSON 后才能运行',
      wfImage: '结果',
      wfNoSession: '当前没有会话',
      wfRunDone: '运行完成',
      wfRunFailed: '运行失败',
      wfRunRunning: '运行中',
      wfCloseEditor: '退出编辑',
      wfViewGraph: '查看节点图',
      wfGraph: '节点图',
      wfJson: 'JSON',
      wfZoomIn: '放大',
      wfZoomOut: '缩小',
      wfGraphEmpty: '这个工作流里没有节点',
      wfNodeLib: '节点库',
      wfNodeLibHint: '从运行中的后端 /object_info 实时读取的完整 ComfyUI 节点目录。',
      wfTargetPositive: '正向写入节点',
      wfTargetNegative: '负向写入节点',
      wfTargetReference: '参考图写入节点',
      wfPositive: '正向提示词',
      wfNegative: '负向提示词',
      wfReference: '参考图片',
      wfUpload: '选择图片',
      wfClear: '清除',
      wfCollapse: '收起节点图',
      wfExpand: '展开节点图',
      wfNoNegative: '该工作流没有负向提示词输入',
      wfPreview: '预览提交',
    }

    /* ---------------------------------------------------------------- *
     * Transport
     * ---------------------------------------------------------------- */

    /**
     * Call one Host route.
     * @param {string} route - route name below the prefix.
     * @param {object} options - method, query, body.
     * @returns {Promise<object>} the JSON payload.
     */
    async function call(route, options) {
      const settings = options || {}
      const url = new URL(`${API}/${route}`, document.baseURI)
      if (settings.query) for (const [key, value] of Object.entries(settings.query)) url.searchParams.set(key, String(value))
      const init = { method: settings.method || 'GET', credentials: 'same-origin' }
      if (settings.body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(settings.body)
      }
      const response = await fetch(url, init)
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.message || payload.error || `HTTP ${response.status}`)
      }
      return payload
    }

    /* ---------------------------------------------------------------- *
     * Mind-map geometry
     * ---------------------------------------------------------------- */

    /**
     * Advance width of one character at a font size.
     * @param {string} ch - one character.
     * @param {number} size - font size in pixels.
     * @returns {number} estimated width.
     */
    function advance(ch, size) {
      const code = ch.codePointAt(0)
      const wide = code >= 0x2e80
      return wide ? size : size * 0.56
    }

    /**
     * Measure a run of text.
     * @param {string} text - the text.
     * @param {number} size - font size in pixels.
     * @returns {number} estimated width.
     */
    function measure(text, size) {
      let width = 0
      for (const ch of text) width += advance(ch, size)
      return width
    }

    /**
     * Cut a string to a pixel budget, with an ellipsis when it does not fit.
     * @param {string} text - source text.
     * @param {number} size - font size.
     * @param {number} budget - available pixels.
     * @returns {string} the possibly shortened text.
     */
    function ellipsize(text, size, budget) {
      if (measure(text, size) <= budget) return text
      let out = ''
      let width = 0
      for (const ch of text) {
        const next = advance(ch, size)
        if (width + next > budget - size) break
        out += ch
        width += next
      }
      return `${out}…`
    }

    /**
     * Wrap text into at most `maxLines` lines inside a pixel budget.
     * @param {string} text - source text.
     * @param {number} size - font size in pixels.
     * @param {number} budget - text budget in pixels.
     * @param {number} maxLines - hard cap on lines.
     * @returns {object} the lines, and whether anything was dropped.
     */
    function wrapText(text, size, budget, maxLines) {
      const source = String(text || '')
      if (measure(source, size) <= budget) return { lines: [source], truncated: false }
      const lines = []
      let current = ''
      let width = 0
      for (const ch of source) {
        const next = advance(ch, size)
        if (width + next > budget && current !== '') {
          lines.push(current)
          current = ''
          width = 0
          if (lines.length === maxLines) break
        }
        current += ch
        width += next
      }
      if (lines.length < maxLines && current !== '') lines.push(current)
      const consumed = lines.join('')
      if (consumed.length < source.length) {
        // Show the cut explicitly, and let the node say it can be expanded.
        lines[lines.length - 1] = ellipsize(`${lines[lines.length - 1] ?? ''}${source.slice(consumed.length)}`, size, budget)
        return { lines: lines.length === 0 ? [''] : lines, truncated: true }
      }
      return { lines: lines.length === 0 ? [''] : lines, truncated: false }
    }

    /**
     * First meaningful body line, for the node subtitle.
     * @param {string} body - Markdown body.
     * @returns {string} a short plain-text subtitle, or an empty string.
     */
    function subtitleOf(body) {
      for (const raw of String(body || '').split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        if (line.startsWith('#') || line.startsWith('```') || line.startsWith('|') || line.startsWith('>') || line.startsWith('---')) continue
        return line.replace(/^[-*+]\s+/, '').replace(/[*`]/g, '')
      }
      return ''
    }

    /**
     * The whole body as readable text, for the expanded view.
     * @param body - Markdown body.
     * @returns one string with headings flattened and bullets marked.
     */
    function detailOf(body) {
      const lines = []
      for (const raw of String(body || '').split('\n')) {
        const line = raw.trimEnd()
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (trimmed.startsWith('```')) continue
        if (trimmed.startsWith('|')) continue
        if (trimmed.startsWith('---')) continue
        if (/^#{1,6}\s/.test(trimmed)) {
          lines.push(trimmed.replace(/^#{1,6}\s+/, ''))
          continue
        }
        if (/^[-*+]\s+/.test(trimmed)) {
          lines.push(`· ${trimmed.replace(/^[-*+]\s+/, '').replace(/[*`]/g, '')}`)
          continue
        }
        lines.push(trimmed.replace(/[*`]/g, ''))
      }
      return lines.join('\n')
    }

    /**
     * Lay a tree out as a left-to-right mind map.
     * @param {Array} roots - nodes with `childNodes`.
     * @param {Set} expanded - node names whose text is shown in full.
     * @returns {object} boxes, links, and the canvas size.
     */
    function layoutMindMap(roots, expanded, moved) {
      const boxes = new Map()
      const order = []
      const open = expanded instanceof Set ? expanded : new Set()
      const pins = moved !== null && typeof moved === 'object' ? moved : {}

      const measureNode = (node, depth) => {
        const size = depth === 0 ? 13.5 : depth === 1 ? 12.8 : depth === 2 ? 12.4 : depth === 3 ? 12.1 : 11.6
        const isOpen = open.has(node.name)
        const budget = GEO.maxW - GEO.padX * 2
        const titleBudget = depth === 0 ? budget - 8 : budget
        const title = wrapText(node.title || node.name, size, titleBudget, isOpen ? 6 : 2)
        // Every node carries its detail, collapsed to a single line until opened:
        // one-line nodes say nothing useful once the work starts.
        const rawSubtitle = isOpen ? detailOf(node.body) : subtitleOf(node.body)
        const sub = rawSubtitle === ''
          ? { lines: [], truncated: false }
          : wrapText(rawSubtitle, 10.5, budget, isOpen ? 16 : 1)
        const titleWidth = Math.max(...title.lines.map(line => measure(line, size)))
        const subWidth = sub.lines.length === 0 ? 0 : Math.max(...sub.lines.map(line => measure(line, 10.5)))
        const width = Math.min(GEO.maxW, Math.max(GEO.minW, Math.max(titleWidth, subWidth) + GEO.padX * 2))
        const toggle = title.truncated || sub.truncated || isOpen
        const height = GEO.padY * 2
          + title.lines.length * GEO.line
          + sub.lines.length * GEO.subLine
          + (toggle ? 13 : 0)
        const box = {
          node,
          depth,
          size,
          lines: title.lines,
          subLines: sub.lines,
          subtitle: rawSubtitle,
          toggle,
          open: isOpen,
          width,
          height,
          x: 0,
          y: 0,
        }
        boxes.set(node.name, box)
        order.push(box)
        for (const child of node.childNodes || []) measureNode(child, depth + 1)
        return box
      }
      for (const root of roots) measureNode(root, 0)

      const columnWidth = []
      for (const box of order) columnWidth[box.depth] = Math.max(columnWidth[box.depth] || 0, box.width)
      const columnX = []
      let cursorX = 0
      for (let depth = 0; depth < columnWidth.length; depth += 1) {
        columnX[depth] = cursorX
        cursorX += columnWidth[depth] + GEO.gapX
      }

      let cursorY = 0
      /**
       * Move a whole subtree down, keeping the parent/child centring intact.
       * @param {object} node - subtree root (its own y is set by the caller).
       * @param {number} delta - pixels to add.
       */
      const shiftSubtree = (node, delta) => {
        for (const child of node.childNodes || []) {
          const box = boxes.get(child.name)
          if (box === undefined) continue
          box.y += delta
          shiftSubtree(child, delta)
        }
      }
      const place = (node) => {
        const box = boxes.get(node.name)
        box.x = columnX[box.depth]
        const children = node.childNodes || []
        const startY = cursorY
        if (children.length === 0) {
          box.y = startY
          cursorY = startY + box.height + GEO.gapY
          return box.y
        }
        for (const child of children) place(child)
        const first = boxes.get(children[0].name)
        const last = boxes.get(children[children.length - 1].name)
        let y = (first.y + last.y + last.height) / 2 - box.height / 2
        // A parent taller than its own band must not climb above the band start,
        // otherwise it overlaps the previous sibling in the same column.
        if (y < startY) {
          const shift = startY - y
          shiftSubtree(node, shift)
          cursorY += shift
          y = startY
        }
        box.y = y
        // Reserve the parent's own height when it reaches past its children.
        if (box.y + box.height + GEO.gapY > cursorY) cursorY = box.y + box.height + GEO.gapY
        return box.y
      }
      for (const root of roots) place(root)

      // A dragged or previously pinned node keeps its own coordinates; every
      // other node stays wherever the automatic layout put it.
      for (const box of order) {
        const override = pins[box.node.name]
        if (override !== undefined && Number.isFinite(override.x) && Number.isFinite(override.y)) {
          box.pinned = true
          box.x = Math.max(0, override.x)
          box.y = Math.max(0, override.y)
          continue
        }
        if (Number.isFinite(box.node.x) && Number.isFinite(box.node.y)) {
          box.pinned = true
          box.x = Math.max(0, box.node.x)
          box.y = Math.max(0, box.node.y)
        }
      }

      const links = []
      const link = (node) => {
        const from = boxes.get(node.name)
        for (const child of node.childNodes || []) {
          const to = boxes.get(child.name)
          const x1 = from.x + from.width
          const y1 = from.y + from.height / 2
          const x2 = to.x
          const y2 = to.y + to.height / 2
          const bend = Math.max(18, (x2 - x1) / 2)
          links.push({
            key: `${from.node.name}->${to.node.name}`,
            d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
            depth: to.depth,
            status: to.node.status,
          })
          link(child)
        }
      }
      for (const root of roots) link(root)

      let width = 0
      let height = 0
      for (const box of order) {
        width = Math.max(width, box.x + box.width)
        height = Math.max(height, box.y + box.height)
      }
      return { boxes: order, links, width: width + 24, height: height + 24 }
    }

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    const CSS = `
.dsh-tt-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;flex:1 1 auto;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dsh-tt-head{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-width:0;overflow:hidden}
.dsh-tt-head-title{font-weight:600;font-size:12px;letter-spacing:.02em;white-space:nowrap}
.dsh-tt-head-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.dsh-tt-btn{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font-size:11px;padding:3px 7px;font-family:inherit;transition:background .12s,color .12s}
.dsh-tt-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-tt-btn-primary{background:#d92f2f;color:#fff;border-color:#d92f2f;padding:5px 12px;font-weight:600}
.dsh-tt-btn-primary:hover{background:#e8453a;color:#fff}
.dsh-tt-btn-running{background:#c6241c;color:#fff;border-color:#c6241c;padding:5px 12px;font-weight:600;animation:dsh-tt-breathe 1.8s ease-in-out infinite}
.dsh-tt-btn-running:hover{background:#d92f2f;color:#fff}
.dsh-tt-btn-passed{background:#1f7a45;color:#fff;border-color:#1f7a45;padding:5px 12px;font-weight:600}
.dsh-tt-btn-passed:hover{background:#268a4f;color:#fff}
@keyframes dsh-tt-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.dsh-tt-status{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;font-variant-numeric:tabular-nums;border-bottom:1px solid var(--dsw-alias-border-l1);background:rgba(217,47,47,.10);color:#ff9c93;flex:none}
.dsh-tt-status .dot{width:7px;height:7px;border-radius:50%;background:#e5484d;animation:dsh-tt-ping 1.4s ease-out infinite;flex:none}
.dsh-tt-status .pct{margin-left:auto;opacity:.9}
.dsh-tt-status .loop{opacity:.7;font-size:10.5px}
.dsh-tt-status.on{animation:dsh-tt-flash .9s ease-out 1}
.dsh-tt-status.passed{background:rgba(31,122,69,.15);color:#7ee2a4}
.dsh-tt-status.passed .dot{animation:none;background:#38b26a}
.dsh-tt-status.stopped{background:rgba(229,180,77,.12);color:#e8c37a}
.dsh-tt-status.stopped .dot{animation:none;background:#d9a13a}
@keyframes dsh-tt-ping{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}70%{box-shadow:0 0 0 7px rgba(229,72,77,0)}100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}}
@keyframes dsh-tt-flash{0%{background:rgba(229,72,77,.45)}100%{background:rgba(217,47,47,.10)}}
.dsh-tt-btn:disabled{opacity:.45;cursor:default}
.dsh-tt-canvas{position:relative;flex:1;min-height:0;overflow:auto;cursor:grab;background:
  radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l1) 1px, transparent 0) 0 0/18px 18px}
.dsh-tt-canvas.dragging{cursor:grabbing}
.dsh-tt-canvas svg{display:block;user-select:none}
.dsh-tt-zoom{position:relative;transform-origin:0 0;will-change:transform}
.dsh-tt-node{cursor:pointer}
.dsh-tt-node:hover .dsh-tt-node-bg{filter:brightness(1.12)}
.dsh-tt-acts{opacity:0;transition:opacity .12s}
.dsh-tt-node:hover .dsh-tt-acts,.dsh-tt-node:focus-within .dsh-tt-acts{opacity:1}
.dsh-tt-empty{display:flex;flex-direction:column;gap:8px;padding:16px 14px;color:var(--dsw-alias-label-secondary);align-items:flex-start}
.dsh-tt-empty strong{color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-tt-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px;padding:4px 12px}
.dsh-tt-drawer{flex:none;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:8px 10px 10px;max-height:52%;display:flex;flex-direction:column;gap:6px;overflow:auto}
.dsh-tt-drawer-head{display:flex;align-items:center;gap:6px}
.dsh-tt-drawer-title{font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tt-drawer-file{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-tt-editor{width:100%;box-sizing:border-box;min-height:118px;resize:vertical;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5}
.dsh-tt-editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-tt-row{display:flex;gap:6px;align-items:center}
.dsh-tt-input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}
.dsh-tt-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-tt-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsh-tt-crash{display:flex;flex-direction:column;gap:8px;padding:14px;color:var(--dsw-alias-label-primary);font-size:12px;height:100%;overflow:auto}
.dsh-tt-crash strong{color:var(--dsw-alias-state-error-primary)}
.dsh-tt-crash pre{white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;font-size:11px;line-height:1.45;margin:0}
`

    /* ---------------------------------------------------------------- *
     * Small components
     * ---------------------------------------------------------------- */

    /**
     * Catch a render failure and print it inside the panel.
     *
     * A throwing slot entry is silently blanked by the shell, which reads as a
     * black column with no way to explain itself. Reporting the failure in the
     * panel keeps the reason visible to whoever is looking at it.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: null }
      }

      static getDerivedStateFromError(error) {
        return { failure: error }
      }

      render() {
        if (this.state.failure === null) return this.props.children
        const failure = this.state.failure
        return h(
          'div',
          { className: 'dsh-tt-crash' },
          h('strong', null, this.props.title),
          h('pre', null, String(failure?.stack ?? failure?.message ?? failure)),
        )
      }
    }

    /**
     * The component-local stylesheet.
     * @returns {object} React element.
     */
    function Styles() {
      return h('style', null, CSS)
    }

    /**
     * A quiet text button.
     * @param {object} props - label, onClick, disabled, primary, title.
     * @returns {object} React element.
     */
    function Button(props) {
      const tone = props.tone === undefined ? (props.primary === true ? 'primary' : 'plain') : props.tone
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-tt-btn${tone === 'plain' ? '' : ` dsh-tt-btn-${tone}`}`,
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          'aria-label': props.title,
        },
        props.label,
      )
    }

    /* ---------------------------------------------------------------- *
     * Edge button
     * ---------------------------------------------------------------- */

    /**
     * Open the panel from wherever the caller sits.
     *
     * A mind map needs width, and the docked column remembers whatever width it
     * had last time — which can be a 30px sliver that reads as a blank column. So
     * after opening, the panel measures itself and escalates to the fullscreen
     * presentation when the column is too narrow to show anything.
     * @param {object} ctx - client plugin context.
     */
    function openPanel(ctx) {
      const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : ctx.sidebarRight
      let opened = false
      try {
        if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function') {
          sidebar.openTab(TAB_KIND)
          opened = true
        }
      } catch {
        /* fall through */
      }
      if (!opened) {
        try {
          ctx.layout.openRightbar(true, false)
          return
        } catch {
          /* nothing else to try */
        }
      }
      const escalate = () => {
        if (typeof document === 'undefined') return
        const root = document.querySelector('[data-dsh-thinking-tree="panel"]')
        if (root === null) return
        // Measure the pane the panel sits in, not the panel's own content: a
        // narrow docked column clips a wide panel, and the panel still reports
        // its content width.
        const pane = root.parentElement
        const visible = pane === null ? root.getBoundingClientRect().width : pane.getBoundingClientRect().width
        if (visible >= 320) return
        try {
          ctx.layout.openRightbar(true, true)
          postDiag({ stage: 'escalated', paneWidth: Math.round(visible) })
        } catch {
          /* keep the docked presentation */
        }
      }
      if (typeof window !== 'undefined') setTimeout(escalate, 300)
    }

    /**
     * Report one client-side observation to the Host's temp file.
     * @param {object} payload - JSON-safe snapshot.
     */
    function postDiag(payload) {
      try {
        void fetch(new URL(`${API}/diag`, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: new Date().toISOString(), ...payload }),
        }).catch(() => undefined)
      } catch {
        /* diagnostics never break behaviour */
      }
    }

    /** Set once the panel has exercised its own interactions and reported them. */
    let drawerSelfTested = false

    /**
     * Dispatch real mouse events at a node and check that the editor opens.
     *
     * This exists because "the click handler looks right" is not evidence. The
     * test drives the same handlers a person does, then reports the DOM result.
     */
    function selfTestDrawer() {
      if (drawerSelfTested) return
      const node = document.querySelector('[data-dsh-thinking-tree="panel"] .dsh-tt-node')
      if (node === null) return
      drawerSelfTested = true
      const box = node.getBoundingClientRect()
      const point = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 0, bubbles: true }
      try {
        node.dispatchEvent(new MouseEvent('mousedown', point))
        window.dispatchEvent(new MouseEvent('mouseup', point))
      } catch (error) {
        postDiag({ stage: 'selftest-drawer', error: String(error?.message ?? error) })
        return
      }
      window.setTimeout(() => {
        const drawer = document.querySelector('[data-dsh-thinking-tree="panel"] .dsh-tt-drawer')
        const title = drawer === null ? '' : (drawer.querySelector('.dsh-tt-drawer-title')?.textContent ?? '')
        const file = drawer === null ? '' : (drawer.querySelector('.dsh-tt-drawer-file')?.textContent ?? '')
        postDiag({ stage: 'selftest-drawer', opened: drawer !== null, title, file })
        // Report the self-check strip's real computed look, so "it renders" is a
        // measurement instead of an assumption.
        const strip = document.querySelector('[data-dsh-thinking-tree="panel"] .dsh-tt-status')
        if (strip === null) {
          postDiag({ stage: 'selftest-strip', present: false })
        } else {
          const computed = window.getComputedStyle(strip)
          const dot = strip.querySelector('.dot')
          postDiag({
            stage: 'selftest-strip',
            present: true,
            text: (strip.textContent || '').replace(/\s+/g, ' ').trim(),
            className: strip.className,
            background: computed.backgroundColor,
            color: computed.color,
            dotAnimation: dot === null ? '' : window.getComputedStyle(dot).animationName,
            visible: strip.getBoundingClientRect().height > 8,
          })
        }
        if (drawer !== null) {
          const close = drawer.querySelector('.dsh-tt-btn')
          if (close !== null) close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
      }, 120)
    }

    /**
     * Mount the button on the right edge of the window.
     *
     * Deliberately not a slot entry: the shell draws overlay occupants inside a
     * containing block, which traps `position: fixed` and lands the pill in the
     * frame's top-left corner. Plain DOM appended to `document.body` resolves
     * `fixed` against the real viewport, and the creating effect owns removal.
     * @param {object} ctx - client plugin context.
     * @param {Function} t - translator.
     * @returns {Function} cleanup that removes the widget.
     */
    /** Set once the pill has exercised its own drag and reported the result. */
    let pillSelfTested = false

    function mountEdgeButton(ctx, t) {
      if (typeof document === 'undefined') return () => undefined
      let dispose = () => undefined
      const attach = () => {
        const built = buildEdgeButton(ctx, t)
        dispose = built === undefined ? () => undefined : built
      }
      // The client module may run before the document body exists, so mounting
      // is deferred until it does instead of silently doing nothing.
      if (document.body !== null) attach()
      else {
        const onReady = () => attach()
        document.addEventListener('DOMContentLoaded', onReady, { once: true })
        return () => {
          document.removeEventListener('DOMContentLoaded', onReady)
          dispose()
        }
      }
      return () => dispose()
    }

    /**
     * Build the pill itself; the document body must exist.
     * @param {object} ctx - client plugin context.
     * @param {Function} t - translator.
     * @returns {Function} cleanup that removes the widget.
     */
    function buildEdgeButton(ctx, t) {
      if (document.body === null) return () => undefined
      for (const stale of Array.from(document.querySelectorAll('[data-dsh-thinking-tree="host"]'))) stale.remove()

      const host = document.createElement('div')
      host.setAttribute('data-dsh-thinking-tree', 'host')
      host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000;display:flex;align-items:center;justify-content:flex-end'

      const sheet = document.createElement('style')
      sheet.textContent = '[data-dsh-thinking-tree="edge"]{transition:background .14s,color .14s,padding-right .14s}'
        + '[data-dsh-thinking-tree="edge"]:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding-right:8px}'
        + '[data-dsh-thinking-tree="edge"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'

      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-dsh-thinking-tree', 'edge')
      button.setAttribute('aria-label', t('edgeLabel'))
      button.title = t('edgeLabel')
      button.style.cssText = [
        'pointer-events:auto',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'gap:5px',
        'padding:9px 5px',
        'border:1px solid var(--dsw-alias-border-l1)',
        'border-right:none',
        'border-radius:9px 0 0 9px',
        'background:var(--dsw-alias-bg-layer-1)',
        'color:var(--dsw-alias-label-secondary)',
        'cursor:pointer',
        'box-shadow:-2px 0 10px rgba(0,0,0,.12)',
        'font-family:inherit',
      ].join(';')
      button.innerHTML = [
        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
        '<path d="M2.5 8h3.2M8.2 8h2.6M13 8h.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
        '<circle cx="2.2" cy="8" r="1.6" fill="currentColor"/>',
        '<circle cx="8" cy="4.2" r="1.6" fill="currentColor" opacity=".75"/>',
        '<circle cx="8" cy="11.8" r="1.6" fill="currentColor" opacity=".75"/>',
        '<circle cx="13.6" cy="8" r="1.6" fill="currentColor"/>',
        '</svg>',
        '<span style="writing-mode:vertical-rl;font-size:10.5px;letter-spacing:.16em;line-height:1"></span>',
      ].join('')
      const label = button.querySelector('span')
      if (label !== null) label.textContent = t('tabTitle')

      const click = () => {
        const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : ctx.sidebarRight
        try {
          if (sidebar !== undefined && sidebar !== null && typeof sidebar.openTab === 'function') {
            sidebar.openTab(TAB_KIND)
            return
          }
        } catch {
          /* fall through to revealing the column */
        }
        try {
          ctx.layout.openRightbar(true, false)
        } catch {
          /* nothing else to try */
        }
      }

      // The pill can be dragged up and down; the place it is dropped in is
      // remembered, so it stays where the user wants it across reloads.
      const STORE_KEY = 'dsh-thinking-tree.pillY'
      const clampY = value => Math.max(24, Math.min(Math.max(24, window.innerHeight - 120), value))
      const stored = Number.parseInt(window.localStorage.getItem(STORE_KEY) ?? '', 10)
      let offsetY = Number.isFinite(stored) ? clampY(stored) : Math.round((window.innerHeight - 76) / 2)
      const applyY = () => {
        button.style.marginTop = `${offsetY}px`
      }
      host.style.alignItems = 'flex-start'
      applyY()

      let dragging = false
      let moved = false
      let startPointerY = 0
      let startOffset = 0
      const onPointerDown = (event) => {
        if (event.button !== 0) return
        dragging = true
        moved = false
        startPointerY = event.clientY
        startOffset = offsetY
        button.style.cursor = 'grabbing'
        try {
          button.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety */
        }
      }
      const onPointerMove = (event) => {
        if (!dragging) return
        const delta = event.clientY - startPointerY
        if (Math.abs(delta) > 3) moved = true
        offsetY = clampY(startOffset + delta)
        applyY()
      }
      const onPointerUp = (event) => {
        if (!dragging) return
        dragging = false
        button.style.cursor = 'grab'
        try {
          button.releasePointerCapture(event.pointerId)
        } catch {
          /* nothing to release */
        }
        if (moved) {
          try {
            window.localStorage.setItem(STORE_KEY, String(offsetY))
          } catch {
            /* a blocked storage still leaves the pill where it was dragged */
          }
          return
        }
        click()
      }
      button.style.cursor = 'grab'
      button.style.touchAction = 'none'
      // Drive the drag handlers with synthetic pointer events and report the
      // result: a handler that merely looks correct is not evidence.
      if (!pillSelfTested) {
        pillSelfTested = true
        window.setTimeout(() => {
          const before = Number.parseFloat(button.style.marginTop || '0')
          try {
            button.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientY: 200, bubbles: true }))
            button.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, button: 0, clientY: 260, bubbles: true }))
            button.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, button: 0, clientY: 260, bubbles: true }))
          } catch (error) {
            postDiag({ stage: 'selftest-pill', error: String(error?.message ?? error) })
            return
          }
          const after = Number.parseFloat(button.style.marginTop || '0')
          const stored = window.localStorage.getItem('dsh-thinking-tree.pillY')
          postDiag({ stage: 'selftest-pill', before, after, moved: Math.abs(after - before) > 40, stored })
          // Put it back where the user had it; the test must not move the pill.
          button.style.marginTop = `${before}px`
          offsetY = before
          try {
            window.localStorage.setItem('dsh-thinking-tree.pillY', String(before))
          } catch {
            /* nothing to restore */
          }
        }, 600)
      }
      button.addEventListener('pointerdown', onPointerDown)
      button.addEventListener('pointermove', onPointerMove)
      button.addEventListener('pointerup', onPointerUp)
      button.addEventListener('pointercancel', onPointerUp)

      host.appendChild(button)
      document.body.appendChild(sheet)
      document.body.appendChild(host)
      // Evidence for a rendering problem the browser console would hold.
      try {
        const rect = host.getBoundingClientRect()
        const computed = window.getComputedStyle(host)
        void fetch(new URL(`${API}/diag`, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            at: new Date().toISOString(),
            stage: 'mounted',
            bodyChildren: document.body.children.length,
            hostInBody: document.body.contains(host),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            display: computed.display,
            zIndex: computed.zIndex,
            visibility: computed.visibility,
            opacity: computed.opacity,
            buttonRect: button.getBoundingClientRect().toJSON(),
            viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
            label: t('tabTitle'),
          }),
        }).catch(() => undefined)
        // Which Session is this window? The Host knows; guessing it from the
        // inside is what left two conversations sharing one chain.
        void fetch(new URL(`${API}/sessions`, document.baseURI))
          .then(response => response.json())
          .then(result => postDiag({ stage: 'sessions', items: result.items ?? [], ok: result.ok === true }))
          .catch(() => undefined)
      } catch {
        /* diagnostics must never break mounting */
      }
      return () => {
        button.removeEventListener('pointerdown', onPointerDown)
        button.removeEventListener('pointermove', onPointerMove)
        button.removeEventListener('pointerup', onPointerUp)
        button.removeEventListener('pointercancel', onPointerUp)
        host.remove()
        sheet.remove()
      }
    }

    /* ---------------------------------------------------------------- *
     * Mind map
     * ---------------------------------------------------------------- */

    /**
     * Shorten `provider/model` to what fits in a node's corner label.
     * @param {string} route - the stored model route.
     * @returns {string} the model id, cut to 14 characters.
     */
    function shortModel(route) {
      const id = String(route).split('/').pop() || String(route)
      return id.length > 14 ? `${id.slice(0, 13)}…` : id
    }

    /**
     * Stroke colour of one status.
     * @param {string} status - node status.
     * @returns {string} a CSS colour value.
     */
    function statusColor(status) {
      switch (status) {
        case 'active': return 'var(--dsw-alias-brand-primary)'
        case 'done': return 'var(--dsw-alias-state-success-primary)'
        case 'blocked': return 'var(--dsw-alias-state-error-primary)'
        default: return 'var(--dsw-alias-state-idle-primary)'
      }
    }

    /**
     * The diagram itself.
     * @param {object} props - boxes, links, size, zoom, selection, handlers.
     * @returns {object} React element.
     */
    function MindMap(props) {
      const { boxes, links, width, height, zoom, selected, onSelect, onStatus, onToggleExpand, onNodeDragStart, onAddChild, onDelete, deleteArmed, t } = props
      const nodes = []
      for (const box of boxes) {
        const isGoal = box.depth === 0
        const isRequirement = box.depth === 1
        const isPlan = box.depth === 2
        const isRoute = box.depth === 3
        const fill = isGoal
          ? 'var(--dsw-alias-bg-layer-2)'
          : isRequirement || isPlan || isRoute
            ? 'var(--dsw-alias-bg-layer-1)'
            : 'var(--dsw-alias-bg-base)'
        const stroke = box.node.status === 'pending'
          ? (isGoal ? 'var(--dsw-alias-brand-primary)' : isRequirement ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)')
          : statusColor(box.node.status)
        const active = selected === box.node.name
        const titleY = GEO.padY + box.size * 0.92
        const kind = box.depth === 0 ? 'GOAL' : box.depth === 1 ? 'REQ' : box.depth === 2 ? 'PLAN' : box.depth === 3 ? 'ROUTE' : 'STEP'
        nodes.push(h(
          'g',
          {
            key: box.node.name,
            className: 'dsh-tt-node',
            transform: `translate(${box.x} ${box.y})`,
            onClick: event => {
              // Selection happens on pointer release; the click must not toggle
              // it a second time or the drawer would open and close at once.
              event.stopPropagation()
            },
            // Hold the left button on a block to move it; the position is
            // written to the node's front matter when the button is released.
            // Left press moves the block; a right click expands its full text.
            // The press is swallowed here so the canvas does not also pan.
            onContextMenu: (event) => {
              event.preventDefault()
              event.stopPropagation()
              onToggleExpand(box.node.name)
            },
            onMouseDown: (event) => {
              if (event.button !== 0) return
              event.preventDefault()
              event.stopPropagation()
              onNodeDragStart(box.node.name, event)
            },
          },
          h('title', null, `${box.node.title}\n${box.node.name}`),
          h('rect', {
            className: 'dsh-tt-node-bg',
            width: box.width,
            height: box.height,
            rx: isGoal ? 12 : 9,
            fill,
            stroke: active ? 'var(--dsw-alias-brand-primary)' : stroke,
            strokeWidth: active ? 2 : 1.2,
            strokeDasharray: box.pinned ? '5 3' : undefined,
          }),
          h('circle', {
            cx: 0,
            cy: box.height / 2,
            r: 3.4,
            fill: statusColor(box.node.status),
            style: { cursor: 'pointer' },
            onClick: (event) => {
              event.stopPropagation()
              onStatus(box.node)
            },
          }),
          ...box.lines.map((line, index) => h('text', {
            key: `t${index}`,
            x: GEO.padX,
            y: titleY + index * GEO.line,
            fill: 'var(--dsw-alias-label-primary)',
            fontSize: box.size,
            fontWeight: isGoal ? 700 : isRequirement ? 600 : 500,
            style: { userSelect: 'none' },
          }, line)),
          box.open && box.subLines.length > 0
            ? h('line', {
              key: 'sep',
              x1: GEO.padX - 3,
              y1: titleY + (box.lines.length - 1) * GEO.line + 5,
              x2: box.width - GEO.padX,
              y2: titleY + (box.lines.length - 1) * GEO.line + 5,
              stroke: 'var(--dsw-alias-border-l1)',
              strokeWidth: 0.7,
            })
            : null,
          ...box.subLines.map((line, index) => h('text', {
            key: `s${index}`,
            x: GEO.padX,
            y: titleY + (box.lines.length - 1) * GEO.line + GEO.subLine * (index + 1),
            fill: 'var(--dsw-alias-label-secondary)',
            fontSize: 10.5,
            style: { userSelect: 'none' },
          }, line)),
          h('text', {
            key: 'kind',
            x: box.width - GEO.padX,
            y: 11,
            textAnchor: 'end',
            fill: 'var(--dsw-alias-label-secondary)',
            fontSize: 8.5,
            opacity: 0.75,
            style: { userSelect: 'none', letterSpacing: '.08em' },
          }, box.node.model ? `${kind} · ${shortModel(box.node.model)}` : kind),
          box.toggle
            ? h(
              'g',
              {
                key: 'toggle',
                transform: `translate(${box.width - 11} ${box.height - 11})`,
                style: { cursor: 'pointer' },
                onClick: (event) => {
                  event.stopPropagation()
                  onToggleExpand(box.node.name)
                },
              },
              h('title', null, box.open ? t('collapseText') : t('expandText')),
              h('circle', { r: 7.5, fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1 }),
              h('text', {
                textAnchor: 'middle',
                y: 3.4,
                fontSize: 9.5,
                fill: 'var(--dsw-alias-label-secondary)',
                style: { userSelect: 'none' },
              }, box.open ? '▴' : '▾'),
            )
            : null,
          // Add and delete live on the block itself, beside it in the gap.
          h(
            'g',
            { key: 'acts', className: 'dsh-tt-acts', transform: `translate(${box.width + 12} 0)` },
            h(
              'g',
              {
                style: { cursor: 'pointer' },
                onMouseDown: event => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation()
                  onAddChild(box.node)
                },
              },
              h('title', null, t('addHint')),
              h('circle', { cy: box.height / 2 - 10, r: 8.5, fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1 }),
              h('text', {
                y: box.height / 2 - 10 + 3.6,
                textAnchor: 'middle',
                fontSize: 11,
                fill: 'var(--dsw-alias-label-primary)',
                style: { userSelect: 'none' },
              }, '＋'),
            ),
            h(
              'g',
              {
                style: { cursor: 'pointer' },
                onMouseDown: event => event.stopPropagation(),
                onClick: (event) => {
                  event.stopPropagation()
                  onDelete(box.node)
                },
              },
              h('title', null, deleteArmed === box.node.name ? t('confirmRemove') : t('deleteHint')),
              h('circle', {
                cy: box.height / 2 + 10,
                r: 8.5,
                fill: deleteArmed === box.node.name ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-bg-layer-2)',
                stroke: deleteArmed === box.node.name ? 'none' : 'var(--dsw-alias-border-l2)',
                strokeWidth: 1,
              }),
              h('text', {
                y: box.height / 2 + 10 + 3.6,
                textAnchor: 'middle',
                fontSize: 11,
                fill: deleteArmed === box.node.name ? '#ffffff' : 'var(--dsw-alias-label-primary)',
                style: { userSelect: 'none' },
              }, deleteArmed === box.node.name ? '!' : '×'),
            ),
          ),
        ))
      }

      return h(
        'svg',
        // Fixed pixel size; zooming scales the wrapper instead. Rewriting these
        // attributes per wheel tick re-laid-out every node and made the map
        // flicker while scrolling.
        { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' },
        h('g', null, links.map(link => h('path', {
          key: link.key,
          d: link.d,
          fill: 'none',
          stroke: link.status === 'pending' ? 'var(--dsw-alias-border-l2)' : statusColor(link.status),
          strokeWidth: link.depth === 1 ? 1.8 : 1.3,
          strokeOpacity: link.status === 'pending' ? 0.9 : 0.75,
          strokeLinecap: 'round',
        }))),
        h('g', null, nodes),
      )
    }

    /* ---------------------------------------------------------------- *
     * Panel
     * ---------------------------------------------------------------- */

    /**
     * The right-Sidebar body: header, mind map, and the editor drawer.
     * @param {object} props - `{ sessionId, t }` plus the framework's own props.
     * @returns {object} React element.
     */
    function TreePanel(props) {
      const { t, ctx } = props
      const sessionId = props.sessionId || props.session?.id || props.session?.sessionId || ''
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [selected, setSelected] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [titleDraft, setTitleDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [goalDraft, setGoalDraft] = React.useState('')
      const [adding, setAdding] = React.useState(false)
      const [addTitle, setAddTitle] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [zoom, setZoom] = React.useState(1)
      const [moved, setMoved] = React.useState({})
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [catalog, setCatalog] = React.useState({ models: [] })
      const [deleteArmed, setDeleteArmed] = React.useState(null)
      const [notice, setNotice] = React.useState('')

      const armDelete = (node) => {
        if (deleteArmed !== node.name) {
          setDeleteArmed(node.name)
          setTimeout(() => setDeleteArmed(current => (current === node.name ? null : current)), 4000)
          return
        }
        setDeleteArmed(null)
        if (selected === node.name) setSelected(null)
        void mutate('delete', { name: node.name, cascade: true })
      }

      const addChild = async (node) => {
        setBusy(true)
        try {
          const created = await call('create', { method: 'POST', body: { sessionId, parent: node.id, title: t('newNode') } })
          await load(true)
          if (created !== undefined && typeof created.name === 'string') setSelected(created.name)
          setState(previous => ({ ...previous, error: null }))
        } catch (error) {
          setState(previous => ({ ...previous, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      // The model catalog is the Host's real dispatch table, fetched once per mount.
      React.useEffect(() => {
        let alive = true
        void call('models')
          .then((payload) => { if (alive) setCatalog({ models: Array.isArray(payload.models) ? payload.models : [] }) })
          .catch(() => undefined)
        return () => { alive = false }
      }, [])
      const signature = React.useRef('')
      const selectedRef = React.useRef(null)
      selectedRef.current = selected
      const canvasRef = React.useRef(null)
      const zoomLayerRef = React.useRef(null)
      // Wheel zoom writes the transform directly and only syncs React later, so
      // a fast scroll does not re-render the whole SVG on every tick.
      const interactingUntil = React.useRef(0)
      const mapSize = React.useRef({ w: 0, h: 0 })

      const load = React.useCallback(async (force) => {
        if (sessionId === '') {
          setState({ loading: false, error: null, data: null })
          return
        }
        try {
          const payload = await call('tree', { query: { sessionId } })
          if (!force && payload.signature === signature.current) return
          signature.current = payload.signature
          setState({ loading: false, error: null, data: payload })
        } catch (error) {
          setState(previous => ({ loading: false, error: String(error?.message ?? error), data: previous.data }))
        }
      }, [sessionId])

      React.useEffect(() => {
        void load(true)
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return
          // A dirty draft must not be replaced under the user's cursor.
          if (selectedRef.current !== null) return
          // Never refresh mid-gesture: it re-renders under the pointer and reads
          // as a stutter while zooming or panning.
          if (Date.now() < interactingUntil.current) return
          void load(false)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      const mutate = async (route, body) => {
        setBusy(true)
        try {
          await call(route, { method: 'POST', body: { sessionId, ...body } })
          await load(true)
          setState(previous => ({ ...previous, error: null }))
        } catch (error) {
          setState(previous => ({ ...previous, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      const data = state.data
      const byId = new Map()
      const byName = new Map()
      if (data !== null) {
        for (const node of data.nodes) {
          byId.set(node.id, node)
          byName.set(node.name, node)
        }
      }
      const attach = (node, seen) => ({
        ...node,
        childNodes: (node.children || [])
          .filter(id => !seen.has(id))
          .map(id => byId.get(id))
          .filter(child => child !== undefined)
          .map(child => attach(child, new Set([...seen, child.id]))),
      })
      const roots = data === null ? [] : data.roots.map(id => byId.get(id)).filter(node => node !== undefined)
      const tree = roots.map(node => attach(node, new Set([node.id])))
      const map = React.useMemo(
        () => layoutMindMap(tree, expanded, moved),
        [data === null ? '' : data.signature, expanded, moved],
      )

      // Right-button drag: the node follows the pointer and the button release
      // writes its position into the node's front matter.
      const nodeDrag = React.useRef(null)
      const dragged = React.useRef(false)
      const toggleRef = React.useRef(null)
      toggleRef.current = (name) => {
        setSelected(current => (current === name ? null : name))
      }
      const movedRef = React.useRef(moved)
      movedRef.current = moved
      const mutateRef = React.useRef(mutate)
      mutateRef.current = mutate
      const zoomLevel = React.useRef(zoom)
      zoomLevel.current = zoom
      const beginNodeDrag = (name, event) => {
        const box = map.boxes.find(entry => entry.node.name === name)
        if (box === undefined) return
        interactingUntil.current = Date.now() + 600
        dragged.current = false
        nodeDrag.current = { name, startX: event.clientX, startY: event.clientY, originX: box.x, originY: box.y }
        setMoved(previous => ({ ...previous, [name]: { x: box.x, y: box.y } }))
      }
      const toggleExpanded = (name) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }
      React.useEffect(() => {
        const onMove = (event) => {
          const dragState = nodeDrag.current
          if (dragState === null) return
          event.preventDefault()
          const deltaX = event.clientX - dragState.startX
          const deltaY = event.clientY - dragState.startY
          // Past a few pixels this is a move, not the click that opens the drawer.
          if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) dragged.current = true
          const x = Math.max(0, dragState.originX + deltaX / zoomLevel.current)
          const y = Math.max(0, dragState.originY + deltaY / zoomLevel.current)
          setMoved(previous => ({ ...previous, [dragState.name]: { x, y } }))
        }
        const onUp = () => {
          const dragState = nodeDrag.current
          if (dragState === null) return
          nodeDrag.current = null
          const didMove = dragged.current
          dragged.current = false
          // A press that never moved is a click on the block: open its editor.
          // Doing it here does not depend on the browser delivering a click
          // after the drag hook swallowed the press.
          if (!didMove) {
            toggleRef.current(dragState.name)
            return
          }
          const at = movedRef.current[dragState.name]
          if (at === undefined) return
          void mutateRef.current('position', { name: dragState.name, x: Math.round(at.x), y: Math.round(at.y) })
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [])
      // The selection carries the file name; the lookup map is keyed by id, so a
// name lookup is what the drawer needs. Mixing the two silently cleared the
// selection on every click.
      const selectedNode = selected === null ? undefined : byName.get(selected)

      React.useEffect(() => {
        if (selectedNode === undefined) {
          if (selected !== null) setSelected(null)
          return
        }
        setDraft(selectedNode.body)
        setTitleDraft(selectedNode.title || '')
      }, [selected, selectedNode === undefined ? '' : selectedNode.mtime])

      const closeDrawer = () => {
        setSelected(null)
        setAdding(false)
        setAddTitle('')
        setConfirming(false)
      }

      const cycleStatus = (node) => {
        const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(node.status) + 1) % STATUS_CYCLE.length]
        void mutate('status', { name: node.name, status: next })
      }

      // One save writes both halves of the node: the front matter title and the
      // Markdown body, each only when it actually changed.
      const saveNode = async () => {
        if (selectedNode === undefined) return
        setBusy(true)
        try {
          const nextTitle = titleDraft.trim()
          if (nextTitle !== '' && nextTitle !== selectedNode.title) {
            await call('title', { method: 'POST', body: { sessionId, name: selectedNode.name, title: nextTitle } })
          }
          await call('save', { method: 'POST', body: { sessionId, name: selectedNode.name, content: draft } })
          await load(true)
          setState(previous => ({ ...previous, error: null }))
        } catch (error) {
          setState(previous => ({ ...previous, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      // Drag to pan the canvas: left button, or the middle button over the map.
      const drag = React.useRef({ active: false, x: 0, y: 0, left: 0, top: 0 })
      const onPointerDown = (event) => {
        const canvas = canvasRef.current
        if (canvas === null || (event.button !== 0 && event.button !== 1)) return
        // Keep the poll from re-rendering while the user is panning.
        interactingUntil.current = Date.now() + 600
        if (event.button === 1) event.preventDefault()
        drag.current = { active: true, x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop }
        canvas.classList.add('dragging')
      }
      const onPointerMove = (event) => {
        const canvas = canvasRef.current
        if (canvas === null || !drag.current.active) return
        canvas.scrollLeft = drag.current.left - (event.clientX - drag.current.x)
        canvas.scrollTop = drag.current.top - (event.clientY - drag.current.y)
      }
      const onPointerUp = () => {
        const canvas = canvasRef.current
        drag.current.active = false
        if (canvas !== null) canvas.classList.remove('dragging')
      }

      const total = data === null ? 0 : data.nodes.length
      const showEmpty = sessionId !== '' && data !== null && tree.length === 0

      // Report what the panel actually rendered, once per tree revision. This is
      // how a rendering problem is observed from outside the browser: the numbers
      // land in a file instead of being guessed from a screenshot.
      const reported = React.useRef('')
      React.useEffect(() => {
        if (data === null) return
        if (data.signature === reported.current) return
        reported.current = data.signature
        const root = typeof document === 'undefined' ? null : document.querySelector('[data-dsh-thinking-tree="panel"]')
        // How much of the viewport is left of the panel's left edge is the width
        // the docked column actually gives it; the panel's own rect stays wide
        // because its content overflows a zero-width wrapper.
        const visibleWidth = root === null || typeof window === 'undefined'
          ? null
          : Math.round(window.innerWidth - root.getBoundingClientRect().left)
        const tiers = {}
        for (const box of map.boxes) tiers[box.depth] = (tiers[box.depth] || 0) + 1
        postDiag({
          stage: 'panel',
          sessionId,
          nodes: data.nodes.length,
          boxes: map.boxes.length,
          links: map.links.length,
          canvas: { w: Math.round(map.width), h: Math.round(map.height) },
          rootWidth: root === null ? null : Math.round(root.getBoundingClientRect().width),
          visibleWidth,
          paneWidth: root === null || root.parentElement === null ? null : Math.round(root.parentElement.getBoundingClientRect().width),
          rootHeight: root === null ? null : Math.round(root.getBoundingClientRect().height),
          svgRects: root === null ? null : root.querySelectorAll('svg rect').length,
          svgPaths: root === null ? null : root.querySelectorAll('svg path').length,
          svgTexts: root === null ? null : root.querySelectorAll('svg text').length,
          tiers,
          selfcheck: data.selfcheck || '',
          firstTitles: map.boxes.slice(0, 3).map(box => box.node.title),
        })
        // A docked column narrower than a couple of hundred pixels cannot show a
        // map at all; take the fullscreen presentation instead of a sliver.
        if (visibleWidth !== null && visibleWidth < 220 && ctx !== undefined) {
          try {
            ctx.layout.openRightbar(true, true)
            postDiag({ stage: 'escalated-on-mount', visibleWidth })
          } catch {
            /* keep the docked presentation */
          }
        }
      }, [data === null ? '' : data.signature])
      // Exercise the click-to-edit path once, so the report says whether the
      // editor actually opens rather than whether its handler looks right.
      React.useEffect(() => {
        if (data === null || data.nodes.length === 0) return
        const timer = window.setTimeout(() => selfTestDrawer(), 500)
        return () => window.clearTimeout(timer)
      }, [data === null ? '' : data.signature])
      const selfcheck = data === null ? '' : (data.selfcheck || '')
      const selfcheckRound = data === null ? 0 : (data.selfcheckRound || 0)
      const selfcheckLabel = selfcheck === 'on'
        ? `${t('selfcheckOn')} ${selfcheckRound}`
        : selfcheck === 'passed'
          ? t('selfcheckPassed')
          : selfcheck === 'stopped'
            ? t('selfcheckStopped')
            : t('selfcheckOff')
      const selfcheckTone = selfcheck === 'on' ? 'running' : selfcheck === 'passed' ? 'passed' : 'plain'
      const requirements = data === null ? [] : data.nodes.filter(node => node.depth === 1)
      const requirementsDone = requirements.filter(node => node.status === 'done').length
      // Re-key the strip whenever a round lands so the flash replays: that is the
      // visible sign that the loop is still turning.
      const roundSeen = React.useRef(0)
      const [roundTick, setRoundTick] = React.useState(0)
      React.useEffect(() => {
        if (selfcheckRound === roundSeen.current) return
        roundSeen.current = selfcheckRound
        if (selfcheck === 'on') setRoundTick(value => value + 1)
      }, [selfcheckRound, selfcheck])
      const toggleSelfCheck = async () => {
        if (sessionId === '') return
        setBusy(true)
        setNotice('')
        const turningOn = selfcheck !== 'on'
        try {
          const result = await call('selfcheck', {
            method: 'POST',
            body: { sessionId, mode: turningOn ? 'on' : 'off' },
          })
          await load(true)
          if (result.selfcheck === 'on') {
            setNotice(result.poked === true ? t('selfcheckStarted') : `${t('selfcheckNoWake')}${result.pokeError ? ` (${result.pokeError})` : ''}`)
          }
        } catch (error) {
          setState(previous => ({ ...previous, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }

      // The wheel zooms the map instead of scrolling it, anchored on the pointer
      // so the node under the cursor stays under the cursor.
      const zoomRef = React.useRef(zoom)
      zoomRef.current = zoom
      mapSize.current = { w: map.width, h: map.height }
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        let pending = 0
        let frame = 0
        let syncTimer = 0
        const pointer = { x: 0, y: 0 }
        const onWheel = (event) => {
          event.preventDefault()
          // Hold the poll off while the gesture lasts.
          interactingUntil.current = Date.now() + 600
          pointer.x = event.clientX
          pointer.y = event.clientY
          pending += event.deltaY
          if (frame !== 0) return
          frame = requestAnimationFrame(() => {
            frame = 0
            const live = canvasRef.current
            const layer = zoomLayerRef.current
            const delta = pending
            pending = 0
            if (live === null || layer === null || delta === 0) return
            const current = zoomRef.current
            const step = delta < 0 ? 1.12 : 1 / 1.12
            const next = Math.min(2.2, Math.max(0.35, Number((current * step).toFixed(3))))
            if (next === current) return
            const rect = live.getBoundingClientRect()
            const anchorX = pointer.x - rect.left
            const anchorY = pointer.y - rect.top
            const worldX = (live.scrollLeft + anchorX) / current
            const worldY = (live.scrollTop + anchorY) / current
            zoomRef.current = next
            const size = mapSize.current
            // Size and scale change together, inside one frame: splitting them
            // across a React render and a scroll fix-up is what made it flicker.
            layer.style.transform = `scale(${next})`
            layer.style.width = `${size.w * next}px`
            layer.style.height = `${size.h * next}px`
            live.scrollLeft = worldX * next - anchorX
            live.scrollTop = worldY * next - anchorY
            if (syncTimer !== 0) clearTimeout(syncTimer)
            syncTimer = setTimeout(() => { setZoom(next) }, 180)
          })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          canvas.removeEventListener('wheel', onWheel)
          if (frame !== 0) cancelAnimationFrame(frame)
          if (syncTimer !== 0) clearTimeout(syncTimer)
        }
      }, [showEmpty, sessionId])

      return h(
        'div',
        { className: 'dsh-tt-root', 'data-dsh-thinking-tree': 'panel' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-tt-head' },
          h('span', { className: 'dsh-tt-head-title' }, t('tabTitle')),
          h(Button, {
            label: t('wfOpen'),
            title: t('wfHint'),
            onClick: () => {
              const sidebar = typeof ctx?.get === 'function' ? ctx.get('sidebarRight') : ctx?.sidebarRight
              if (typeof sidebar?.openTab === 'function') sidebar.openTab(WF_KIND)
            },
          }),
          h('span', { className: 'dsh-tt-head-path', title: data?.absolute || '' }, data === null ? '' : `${data.folder}/ · ${total}`),
          h(Button, {
            label: selfcheckLabel,
            title: t('selfcheckHint'),
            tone: selfcheckTone,
            disabled: busy || sessionId === '',
            onClick: () => void toggleSelfCheck(),
          }),
          h(Button, { label: '−', title: t('zoomOut'), onClick: () => setZoom(value => Math.max(0.45, Number((value - 0.15).toFixed(2)))) }),
          h(Button, { label: '＋', title: t('zoomIn'), onClick: () => setZoom(value => Math.min(1.9, Number((value + 0.15).toFixed(2)))) }),
          h(Button, { label: '⤢', title: t('fit'), onClick: () => setZoom(1) }),
          h(Button, {
            label: '⇲',
            title: t('arrange'),
            onClick: () => {
              setMoved({})
              void mutate('arrange', {})
            },
          }),
          h(Button, { label: '⟳', title: t('refresh'), onClick: () => void load(true) }),
        ),
        state.error !== null ? h('div', { className: 'dsh-tt-error' }, `${t('fail')}: ${state.error}`) : null,
        selfcheck === ''
          ? null
          : h(
            'div',
            { className: `dsh-tt-status ${selfcheck}`, key: `status-${selfcheck}-${selfcheckRound}-${roundTick}` },
            h('span', { className: 'dot' }),
            h(
              'span',
              null,
              selfcheck === 'on'
                ? `${t('selfcheckOn')} · 第 ${selfcheckRound} 轮`
                : selfcheck === 'passed'
                  ? t('selfcheckPassed')
                  : t('selfcheckStopped'),
            ),
            h('span', { className: 'pct' }, `· ${requirementsDone}/${requirements.length} ${t('selfcheckCounting')}`),
            selfcheck === 'on' ? h('span', { className: 'loop' }, t('selfcheckLoop')) : null,
          ),
        notice !== '' ? h('div', { className: 'dsh-tt-meta', style: { padding: '4px 12px' } }, notice) : null,
        sessionId === ''
          ? h('div', { className: 'dsh-tt-empty' }, h('strong', null, t('noSession')))
          : showEmpty
            ? h(
              'div',
              { className: 'dsh-tt-empty' },
              h('strong', null, t('empty')),
              h('span', null, t('emptyHint')),
              h(
                'div',
                { className: 'dsh-tt-row', style: { width: '100%' } },
                h('input', {
                  className: 'dsh-tt-input',
                  value: goalDraft,
                  placeholder: t('goalPlaceholder'),
                  onChange: event => setGoalDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter') return
                    const title = goalDraft.trim() === '' ? t('goal') : goalDraft.trim()
                    setGoalDraft('')
                    void mutate('create', { parent: '', title })
                  },
                }),
                h(Button, {
                  label: t('create'),
                  primary: true,
                  disabled: busy,
                  onClick: () => {
                    const title = goalDraft.trim() === '' ? t('goal') : goalDraft.trim()
                    setGoalDraft('')
                    void mutate('create', { parent: '', title })
                  },
                }),
              ),
            )
            : h(
              'div',
              {
                className: 'dsh-tt-canvas',
                ref: canvasRef,
                title: t('hint'),
                onMouseDown: onPointerDown,
                onMouseMove: onPointerMove,
                onMouseUp: onPointerUp,
                onMouseLeave: onPointerUp,
              },
              state.loading && data === null
                ? h('div', { className: 'dsh-tt-empty' }, t('loading'))
                : h(
                  'div',
                  {
                    className: 'dsh-tt-zoom',
                    ref: zoomLayerRef,
                    style: {
                      width: map.width * zoom,
                      height: map.height * zoom,
                      transform: `scale(${zoom})`,
                      transformOrigin: '0 0',
                      willChange: 'transform',
                    },
                  },
                  h(MindMap, {
                    boxes: map.boxes,
                    links: map.links,
                    width: map.width,
                    height: map.height,
                    zoom: 1,
                    selected,
                    // Selection is handled on pointer release (see onUp), so the
                    // click only stops here instead of toggling a second time.
                    onSelect: (name) => {
                      if (dragged.current) {
                        dragged.current = false
                        return
                      }
                      setSelected(current => (current === name ? null : name))
                    },
                    onStatus: cycleStatus,
                    onToggleExpand: toggleExpanded,
                    onNodeDragStart: beginNodeDrag,
                    onAddChild: addChild,
                    onDelete: armDelete,
                    deleteArmed,
                    t,
                  }),
                ),
            ),
        selectedNode === undefined
          ? null
          : h(
            'div',
            { className: 'dsh-tt-drawer' },
            h(
              'div',
              { className: 'dsh-tt-drawer-head' },
              h('span', { className: 'dsh-tt-drawer-title' }, selectedNode.title || selectedNode.name),
              h('span', { className: 'dsh-tt-drawer-file' }, selectedNode.name),
              h(Button, { label: t('close'), title: t('close'), onClick: closeDrawer }),
            ),
            h(
              'div',
              { className: 'dsh-tt-row' },
              h('span', { className: 'dsh-tt-meta', style: { whiteSpace: 'nowrap' } }, t('nodeTitle')),
              h('input', {
                className: 'dsh-tt-input',
                value: titleDraft,
                onChange: event => setTitleDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void saveNode()
                  if (event.key === 'Escape') closeDrawer()
                },
              }),
            ),
            h(
              'div',
              { className: 'dsh-tt-row' },
              h('span', { className: 'dsh-tt-meta', style: { whiteSpace: 'nowrap' } }, t('nodeModel')),
              h(
                'select',
                {
                  className: 'dsh-tt-input',
                  value: selectedNode.model || '',
                  onChange: event => void mutate('model', { name: selectedNode.name, model: event.target.value }),
                },
                h('option', { value: '' }, t('inherit')),
                // A stored route that the catalog no longer advertises stays selectable.
                selectedNode.model && !catalog.models.some(model => `${model.provider}/${model.id}` === selectedNode.model)
                  ? h('option', { value: selectedNode.model }, selectedNode.model)
                  : null,
                catalog.models.map(model => h(
                  'option',
                  { key: `${model.provider}/${model.id}`, value: `${model.provider}/${model.id}` },
                  `${model.name} · ${model.provider}`,
                )),
              ),
            ),
            h('textarea', {
              className: 'dsh-tt-editor',
              value: draft,
              spellCheck: false,
              onChange: event => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') closeDrawer()
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void saveNode()
              },
            }),
            h(
              'div',
              { className: 'dsh-tt-row' },
              h(Button, {
                label: busy ? t('saving') : t('save'),
                primary: true,
                disabled: busy,
                onClick: () => void saveNode(),
              }),
              h(Button, { label: t('addChild'), onClick: () => setAdding(value => !value) }),
              h(Button, {
                label: confirming ? t('confirmRemove') : t('remove'),
                onClick: () => {
                  if (!confirming) {
                    setConfirming(true)
                    setTimeout(() => setConfirming(false), 4000)
                    return
                  }
                  setConfirming(false)
                  closeDrawer()
                  void mutate('delete', { name: selectedNode.name, cascade: true })
                },
              }),
              h('span', { className: 'dsh-tt-meta' }, `${String(draft.length)} ${t('chars')}`),
            ),
            adding
              ? h(
                'div',
                { className: 'dsh-tt-row' },
                h('input', {
                  className: 'dsh-tt-input',
                  value: addTitle,
                  autoFocus: true,
                  placeholder: t('addChildPlaceholder'),
                  onChange: event => setAddTitle(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' || addTitle.trim() === '') return
                    const title = addTitle.trim()
                    setAddTitle('')
                    setAdding(false)
                    void mutate('create', { parent: selectedNode.id, title })
                  },
                }),
                h(Button, {
                  label: t('addChild'),
                  primary: true,
                  disabled: addTitle.trim() === '',
                  onClick: () => {
                    const title = addTitle.trim()
                    if (title === '') return
                    setAddTitle('')
                    setAdding(false)
                    void mutate('create', { parent: selectedNode.id, title })
                  },
                }),
              )
              : null,
          ),
      )
    }

    /* ---------------------------------------------------------------- *
     * AI workflow panel
     * ---------------------------------------------------------------- */

    /** Tab kind of the workflow canvas. */
    const WF_KIND = 'ai-workflow'
    /** Implementation id used as the slot key. */
    const WF_ID = 'dsh-thinking-tree-workflow'
    /** Fixed node width; ports are placed from it. */
    const WF_W = 250
    /** Port vertical offsets inside one node card. */
    const WF_PORTS = { in: 44, exchange: 88, out: 62 }
    /** Expanded ComfyUI card size, large enough to show its own graph. */
    const WF_COMFY_W = 540
    const WF_COMFY_H = 408

    /** Live run id; persisted so a reload can re-attach to the running graph. */
    const WF_RUN_KEY = 'dsh-aiwf-run'

    /**
     * Call one workflow route.
     * @param {string} path - path below `api/ai-workflow`.
     * @param {object} options - `{ method, query, body }`.
     * @returns {Promise<object>} the JSON payload.
     */
    async function wfCall(path, options = {}) {
      const url = new URL(`api/ai-workflow/${path}`, document.baseURI)
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let data
      try {
        data = await response.json()
      } catch {
        data = { ok: false, error: `HTTP ${response.status}` }
      }
      if (response.ok !== true || data.ok === false) throw new Error(String(data.message ?? data.error ?? `HTTP ${response.status}`))
      return data
    }

    /**
     * Read a browser File as a base64 data URL.
     * @param {File} file - chosen image.
     * @returns {Promise<string>} the data URL.
     */
    function readBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error ?? new Error('read failed'))
        reader.readAsDataURL(file)
      })
    }

    /**
     * Give one node a usable title.
     * @param {string} type - node type.
     * @param {number} index - count of nodes of that type.
     * @returns {string} display title.
     */
    function wfDefaultTitle(type, index) {
      if (type === 'leader') return 'Leader'
      if (type === 'input') return '输入 ' + (index + 1)
      if (type === 'output') return '输出 ' + (index + 1)
      if (type === 'exchange') return '交换 ' + (index + 1)
      if (type === 'comfy') return 'ComfyUI ' + (index + 1)
      return '模型节点 ' + (index + 1)
    }

    /**
     * Strip runtime fields that must not drive the save signature.
     * @param {object} node - workflow node.
     * @returns the persisted fields only.
     */
    function wfPersisted(node) {
      const { status, output, error, ms, images, ...rest } = node
      return rest
    }

    /**
     * Merge one live run into the graph without touching configuration.
     * @param {object} workflow - current graph.
     * @param {object} run - run projection.
     * @returns the merged graph.
     */
    function wfApplyRun(workflow, run) {
      if (workflow === null || run === undefined || run === null) return workflow
      const nodes = workflow.nodes.map((node) => {
        const live = run.nodes?.[node.id]
        if (live === undefined) return node
        return {
          ...node,
          status: live.status,
          output: live.text ?? node.output,
          error: live.error ?? '',
          ms: live.ms ?? node.ms,
          images: Array.isArray(live.images) && live.images.length > 0 ? live.images : node.images,
        }
      })
      return { ...workflow, nodes }
    }

    /**
 * A minimal litegraph canvas view, ported from ComfyUI's frontend drawing
 * semantics: node frames with title bars and category colors, input/output
 * sockets with names, widgets, bezier links, and group boxes. Read-only —
 * editing the graph itself stays in ComfyUI; this shows the real saved nodes.
 * @param {object} props - `{ ui, highlight, zoom, pan }`.
 * @returns {object} React element.
 */
function LiteGraphView(props) {
  const ref = React.useRef(null)
  const sizeRef = React.useRef({ width: 0, height: 0 })
  /** Node rectangles in canvas pixels, refreshed by every draw. */
  const hitRef = React.useRef({ positions: new Map(), scale: 1, offsetX: 0, offsetY: 0, panX: 0, panY: 0 })
  const draw = React.useCallback(() => {
    const canvas = ref.current
    if (canvas === null || props.ui === undefined || props.ui === null) return
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio ?? 1
    const width = Math.max(80, Math.floor(rect.width))
    const height = Math.max(80, Math.floor(rect.height))
    sizeRef.current = { width, height, dpr }
    canvas.width = Math.floor(width * dpr)
    canvas.height = Math.floor(height * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    // A drawing failure must never take the panel down with it; the caller
    // shows the JSON tab instead when the canvas cannot paint.
    try {
      const result = drawLitegraph(ctx, props.ui, {
        width,
        height,
        dpr,
        scale: props.zoom ?? 1,
        offsetX: props.pan?.x ?? 0,
        offsetY: props.pan?.y ?? 0,
        highlight: props.highlight ?? [],
      })
      hitRef.current = { ...result, width, height }
    } catch (error) {
      console.warn('[wf] litegraph draw failed', error)
    }
  }, [props.ui, props.zoom, props.pan, props.highlight])

  React.useEffect(() => {
    draw()
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  /**
   * Turn a pointer position into the node under it, honouring the same
   * fit/offset transform the last draw used.
   * @param {React.PointerEvent} event - click on the canvas.
   * @returns {string|undefined} the node id.
   */
  const pick = (event) => {
    const canvas = ref.current
    if (canvas === null) return undefined
    const info = hitRef.current
    if (info.positions === undefined || info.positions.size === 0) return undefined
    const rect = canvas.getBoundingClientRect()
    const { bounds } = layoutLitegraph(props.ui)
    const padded = { x: bounds.x - 24, y: bounds.y - 24, width: bounds.width + 48, height: bounds.height + 48 }
    const fit = Math.min(info.width / padded.width, info.height / padded.height)
    const scale = Math.max(0.05, Math.min(2, (props.zoom ?? 1) * fit))
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top
    const worldX = (px - (props.pan?.x ?? 0)) / scale + padded.x
    const worldY = (py - (props.pan?.y ?? 0)) / scale + padded.y
    for (const node of info.positions.values()) {
      if (worldX >= node.x && worldX <= node.x + node.w && worldY >= node.y && worldY <= node.y + node.h) return String(node.id)
    }
    return undefined
  }

  const style = props.fill === true
    ? { width: '100%', height: '100%', minHeight: 0, display: 'block', cursor: 'pointer' }
    : { width: '100%', height: '100%', minHeight: 320, display: 'block', cursor: 'pointer' }
  return h('canvas', {
    className: 'dsh-wf-lite',
    ref,
    style,
    onClick: (event) => {
      const id = pick(event)
      if (id !== undefined && typeof props.onPick === 'function') props.onPick(id)
    },
  })
}

/** Styles that only the workflow canvas uses. */
    const WF_CSS = `
.dsh-wf-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-wf-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;flex:none}
.dsh-wf-title{font-weight:600;margin-right:4px}
.dsh-wf-sp{flex:1}
.dsh-wf-pill{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;white-space:nowrap}
.dsh-wf-pill.run{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dsh-wf-pill.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.dsh-wf-canvas{position:relative;flex:1;min-height:320px;overflow:hidden;background:radial-gradient(circle at 1px 1px, rgba(127,127,127,.18) 1px, transparent 1px) 0 0/18px 18px;touch-action:none;cursor:default}
.dsh-wf-world{position:absolute;left:0;top:0;width:6000px;height:6000px;transform-origin:0 0}
.dsh-wf-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:6}
.dsh-wf-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:2;pointer-events:none;stroke-linecap:round}
.dsh-wf-edge:hover{stroke:var(--dsw-alias-state-error-primary)}
.dsh-wf-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.dsh-wf-edge-live{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:2;stroke-dasharray:6 5}
.dsh-wf-node{position:absolute;z-index:1;width:${WF_W}px;min-height:128px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 18px rgba(0,0,0,.18);user-select:none}
.dsh-wf-node.sel{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsh-wf-node.running{border-color:var(--dsw-alias-state-success-primary)}
.dsh-wf-node.error{border-color:var(--dsw-alias-state-error-primary)}
.dsh-wf-node-head{display:flex;align-items:center;gap:6px;padding:7px 10px;background:var(--dsw-alias-bg-layer-2);cursor:grab;border-radius:11px 11px 0 0}
.dsh-wf-node-head:active{cursor:grabbing}
.dsh-wf-node-title{font-weight:600;font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.dsh-wf-kind{font-size:9px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 5px;flex:none}
.dsh-wf-node-body{padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px;min-height:88px;overflow:hidden}
.dsh-wf-node-model{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-wf-badges{display:flex;gap:4px;flex-wrap:wrap;min-height:16px}
.dsh-wf-badge{font-size:10px;line-height:1.5;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dsh-wf-node-out{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);max-height:46px;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.dsh-wf-mini{width:100%;height:62px;display:block;border-radius:7px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-wf-biggraph{width:100%;height:100%;min-height:0;display:block;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
.dsh-wf-thumb{width:100%;max-height:120px;object-fit:contain;border-radius:8px;background:#000;margin-top:2px}
.dsh-wf-port{position:absolute;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-bg-base);border:2px solid var(--dsw-alias-border-l2);cursor:crosshair;z-index:2}
.dsh-wf-port.out{border-color:var(--dsw-alias-brand-primary)}
.dsh-wf-port.exchange{border-color:var(--dsw-alias-state-success-primary);border-radius:3px}
.dsh-wf-port:hover{background:var(--dsw-alias-brand-primary)}
.dsh-wf-port-label{position:absolute;font-size:9px;color:var(--dsw-alias-label-secondary);transform:translateY(-50%);white-space:nowrap;pointer-events:none}
.dsh-wf-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dsh-wf-dot.running{background:var(--dsw-alias-state-success-primary);animation:dsh-wf-pulse 1s infinite}
.dsh-wf-dot.done{background:var(--dsw-alias-state-success-primary)}
.dsh-wf-dot.error{background:var(--dsw-alias-state-error-primary)}
@keyframes dsh-wf-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dsh-wf-inspector{position:relative;flex:0 0 auto;max-height:46%;width:auto;margin:0 8px 6px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:9px;box-shadow:0 -6px 18px rgba(0,0,0,.18);z-index:5}
.dsh-wf-inspector h4{margin:0;font-size:12px;display:flex;align-items:center;gap:6px}
.dsh-wf-field{display:flex;flex-direction:column;gap:3px}
.dsh-wf-field>span{font-size:10px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.03em}
.dsh-wf-input,.dsh-wf-select,.dsh-wf-area{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:inherit;font:inherit;padding:5px 7px;outline:none}
.dsh-wf-input:focus,.dsh-wf-select:focus,.dsh-wf-area:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-wf-area{resize:vertical;min-height:86px;line-height:1.5}
.dsh-wf-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dsh-wf-checks{max-height:150px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 6px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-alias-bg-base)}
.dsh-wf-check{display:flex;gap:6px;align-items:center;font-size:11px;line-height:1.5;cursor:pointer}
.dsh-wf-check input{margin:0}
.dsh-wf-check small{color:var(--dsw-alias-label-secondary);font-size:10px}
.dsh-wf-empty{position:absolute;left:50%;top:36%;transform:translate(-50%,-50%);text-align:center;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px;max-width:80%}
.dsh-wf-empty strong{color:var(--dsw-alias-label-primary);font-size:14px}
.dsh-wf-error{padding:4px 10px;color:var(--dsw-alias-state-error-primary);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-wf-foot{display:flex;gap:6px;align-items:center;padding:4px 10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;flex:none}
.dsh-wf-modal{position:absolute;inset:0;z-index:30;background:rgba(0,0,0,.48);display:flex;align-items:center;justify-content:center;padding:10px}
.dsh-wf-modal-card{width:100%;max-height:88%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45)}
.dsh-wf-modal-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-wf-modal-title{font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wf-menu{position:absolute;z-index:20;display:flex;flex-direction:column;gap:4px;padding:6px;min-width:150px;max-width:240px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.32)}
.dsh-wf-menu-title{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px 2px}
.dsh-wf-lite{display:block;width:100%;height:100%;max-height:100%;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:#14161a}
.dsh-wf-modal-body{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
.dsh-wf-graph{display:block;background:var(--dsw-alias-bg-base);border-radius:10px;border:1px solid var(--dsw-alias-border-l1)}
.dsh-wf-json{font:10px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:0;color:var(--dsw-alias-label-secondary)}
.dsh-wf-mcp-row{display:flex;gap:8px;align-items:center;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base)}
.dsh-wf-mcp-row main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-wf-mcp-name{font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-wf-mcp-note{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-wf-mcp-state{font-size:9px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;flex:none}
.dsh-wf-mcp-state.on{color:var(--dsw-alias-state-success-primary)}
.dsh-wf-mcp-state.off{color:var(--dsw-alias-label-secondary)}
.dsh-wf-grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px}
`

    /**
     * One small labelled form row.
     * @param {object} props - `{ label, children }`.
     * @returns {object} React element.
     */
    function WfField(props) {
      return h('label', { className: 'dsh-wf-field' }, h('span', null, props.label), props.children)
    }

    /**
     * The workflow canvas tab body.
     * @param {object} props - framework slot props plus `t`.
     * @returns {object} React element.
     */
    function WorkflowPanel(props) {
      const { t, ctx } = props
      const sessionId = props.sessionId || props.session?.id || props.session?.sessionId || ''
      const [workflow, setWorkflow] = React.useState(null)
      const [catalog, setCatalog] = React.useState({ providers: [], models: [], tools: [], skills: [], mcps: [] })
      const [selected, setSelected] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [runId, setRunId] = React.useState('')
      const [run, setRun] = React.useState(null)
      const [view, setView] = React.useState({ x: 48, y: 48, k: 1 })
      const [link, setLink] = React.useState(null)
      const [comfy, setComfy] = React.useState({ status: null, workflows: [], busy: '' })
      const [toolQuery, setToolQuery] = React.useState('')
      const [editing, setEditing] = React.useState('')
      const [graphs, setGraphs] = React.useState({})
      const [graphModal, setGraphModal] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState({})
      const [comfyPreview, setComfyPreview] = React.useState(null)
      const [targets, setTargets] = React.useState({})
      const [nodeLib, setNodeLib] = React.useState({ open: false, data: null, error: '', query: '' })
      const [comfyRaw, setComfyRaw] = React.useState({})
      /** Right-clicked connection: `{ id, x, y, label }` or null. */
      const [edgeMenu, setEdgeMenu] = React.useState(null)

      const canvasRef = React.useRef(null)
      const viewRef = React.useRef(view)
      viewRef.current = view
      const savedRef = React.useRef('')
      const workflowRef = React.useRef(null)
      workflowRef.current = workflow
      const selectedRef = React.useRef('')
      selectedRef.current = selected

      // Load the graph once per session.
      React.useEffect(() => {
        let alive = true
        if (sessionId === '') {
          setWorkflow({ version: 1, id: 'main', title: 'AI 工作流', nodes: [], edges: [] })
          return () => { alive = false }
        }
        void (async () => {
          try {
            const data = await wfCall('load', { query: { sessionId } })
            if (!alive) return
            setWorkflow(data.workflow)
            savedRef.current = JSON.stringify({ title: data.workflow.title, nodes: data.workflow.nodes.map(wfPersisted), edges: data.workflow.edges })
            if (data.source === 'new') setNotice(t('wfEmpty'))
          } catch (caught) {
            if (alive) setError(String(caught.message ?? caught))
          }
          // A run started before this reload keeps streaming once re-attached.
          try {
            const stored = sessionStorage.getItem(WF_RUN_KEY)
            if (alive && stored !== null && stored !== '') setRunId(stored)
          } catch {
            /* sessionStorage may be unavailable */
          }
        })()
        void (async () => {
          try {
            const data = await wfCall('catalog', { query: { sessionId } })
            if (alive) setCatalog({ providers: data.providers ?? [], models: data.models ?? [], tools: data.tools ?? [], skills: data.skills ?? [], mcps: data.mcps ?? [] })
          } catch {
            /* the catalog is advisory; a node can still be edited offline */
          }
        })()
        void (async () => {
          try {
            const data = await wfCall('comfy/workflows')
            if (alive) setComfy(current => ({ ...current, workflows: data.workflows ?? [] }))
          } catch {
            /* ComfyUI is optional */
          }
        })()
        return () => { alive = false }
      }, [sessionId])

      // Debounced save. The signature ignores live run fields so polling does not
      // write the file on every delta.
      React.useEffect(() => {
        if (workflow === null || sessionId === '') return undefined
        const signature = JSON.stringify({ title: workflow.title, nodes: workflow.nodes.map(wfPersisted), edges: workflow.edges })
        if (signature === savedRef.current) return undefined
        const timer = setTimeout(() => {
          setSaving(true)
          void (async () => {
            try {
              await wfCall('save', { method: 'POST', body: { sessionId, workflow } })
              savedRef.current = signature
              setNotice(t('wfSaved'))
              setError('')
            } catch (caught) {
              setError(String(caught.message ?? caught))
            } finally {
              setSaving(false)
            }
          })()
        }, 700)
        return () => clearTimeout(timer)
      }, [workflow, sessionId, t])

      // Load a compact node graph for every ComfyUI workflow referenced by a node,
// so the node card shows the real ComfyUI graph instead of only a file name.
      React.useEffect(() => {
        if (workflow === null) return
        const names = [...new Set(workflow.nodes.filter(node => node.type === 'comfy' && node.workflow !== '').map(node => node.workflow))]
        for (const name of names) {
          if (graphs[name] === undefined) {
            void wfCall('comfy/json', { query: { name } })
              .then((data) => { setGraphs(current => current[name] === undefined ? { ...current, [name]: data } : current) })
              .catch(() => undefined)
          }
          // API workflows expose their injectable nodes; UI ones answer with a
          // plain error that simply leaves the target lists empty.
          if (targets[name] === undefined) {
            void wfCall('comfy/targets', { query: { name } })
              .then((data) => { setTargets(current => current[name] === undefined ? { ...current, [name]: data } : current) })
              .catch(() => undefined)
          }
          // The raw saved graph is what the litegraph view renders.
          if (comfyRaw[name] === undefined) {
            void wfCall('comfy/json', { query: { name } })
              .then((data) => { setComfyRaw(current => current[name] === undefined ? { ...current, [name]: data.ui ?? data.json ?? null } : current) })
              .catch(() => undefined)
          }
        }
      }, [workflow, graphs, targets])

      // Poll one live run until it settles.
      React.useEffect(() => {
        if (runId === '') return undefined
        let cancelled = false
        let timer = 0
        const tick = async () => {
          try {
            const data = await wfCall('run/status', { query: { runId } })
            if (cancelled) return
            console.log('[wf] run/status', data.run.status, JSON.stringify(Object.fromEntries(Object.entries(data.run.nodes ?? {}).map(([id, n]) => [id, { status: n.status, images: (n.images ?? []).length }]))))
            setRun(data.run)
            setWorkflow(current => {
              const merged = wfApplyRun(current, data.run)
              console.log('[wf] merged', JSON.stringify(merged.nodes.map(n => ({ id: n.id, status: n.status, images: (n.images ?? []).length }))))
              return merged
            })
            if (data.run.status !== 'running') {
              try { sessionStorage.removeItem(WF_RUN_KEY) } catch { /* ignore */ }
              setNotice(data.run.status === 'done' ? t('wfRunDone') : (data.run.error || t('wfRunFailed')))
              setRunId('')
              return
            }
          } catch (caught) {
            if (cancelled) return
            setError(String(caught.message ?? caught))
            setRunId('')
            return
          }
          if (!cancelled) timer = setTimeout(tick, 700)
        }
        timer = setTimeout(tick, 250)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [runId, t])

      // Wheel zoom must be non-passive to stop the page scrolling under it.
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const rect = canvas.getBoundingClientRect()
          const current = viewRef.current
          const next = Math.max(0.35, Math.min(1.8, current.k * (event.deltaY < 0 ? 1.08 : 0.92)))
          const px = event.clientX - rect.left
          const py = event.clientY - rect.top
          setView({
            k: next,
            x: px - ((px - current.x) / current.k) * next,
            y: py - ((py - current.y) / current.k) * next,
          })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [])

      const nodeById = new Map((workflow?.nodes ?? []).map(node => [node.id, node]))
      const selectedNode = selected === '' ? undefined : nodeById.get(selected)
      const editingNode = editing === '' ? undefined : nodeById.get(editing)
      const isExpanded = node => node !== undefined && node.type === 'comfy' && node.workflow !== '' && (comfyRaw[node.workflow] ?? graphs[node.workflow]?.ui ?? null) !== null && collapsed[node.id] !== true
      const sizeOf = node => {
        if (node === undefined) return { w: WF_W, h: 140 }
        if (isExpanded(node)) return { w: WF_COMFY_W, h: WF_COMFY_H }
        return { w: WF_W, h: node.type === 'comfy' ? 150 : 140 }
      }
      const portOffset = (node, port) => {
        if (node.type === 'leader') return port === 'result' ? 78 : 38
        if (node.type === 'input') return 46
        if (node.type === 'output') return 46
        if (node.type === 'comfy') {
          const expanded = isExpanded(node)
          const base = expanded ? { in: 58, negative: 98, image: 138, out: 58 } : { in: 46, negative: 80, image: 114, out: 46 }
          return base[port] ?? base.in
        }
        if (node.type === 'exchange') return port === 'out' ? 46 : 46
        if (port === 'out') return WF_PORTS.out
        if (port === 'exchange') return WF_PORTS.exchange
        return WF_PORTS.in
      }

      const patchNode = (id, patch) => {
        setWorkflow(current => current === null ? current : ({
          ...current,
          nodes: current.nodes.map(node => (node.id === id ? { ...node, ...patch } : node)),
        }))
      }

      const addNode = (type) => {
        // The leader is the conversation itself, so exactly one may exist.
        if (type === 'leader' && (workflow?.nodes ?? []).some(node => node.type === 'leader')) {
          setNotice(t('wfLeaderOnlyOne'))
          return
        }
        const count = (workflow?.nodes ?? []).length
        const typeCount = (workflow?.nodes ?? []).filter(node => node.type === type).length
        const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
        const first = catalog.models.find(model => model.provider === 'ali' && model.id === 'deepseek-v4.1-flash-1017')
          ?? catalog.models.find(model => model.provider === 'ali')
          ?? catalog.models[0]
        const node = {
          id,
          type,
          title: wfDefaultTitle(type, typeCount),
          // Placement is world-fixed: adding a node while the inspector is open
          // shrinks the canvas, and a viewport-relative origin would pile the
          // next node on top of an earlier one.
          x: 20 + (count % 2) * 300,
          y: 20 + Math.floor(count / 2) * 190,
          provider: type === 'model' ? (first?.provider ?? '') : '',
          model: type === 'model' ? (first?.id ?? '') : '',
          reasoningEffort: '',
          prompt: type === 'exchange'
            ? '把上游多个节点的结果对比、提炼成给下游能直接用的材料。只写事实与结论，不要客套。'
            : '',
          tools: [],
          skills: [],
          mcps: [],
          mode: 'auto',
          targets: [],
          baseUrl: 'http://127.0.0.1:8188',
          workflow: '',
          promptText: '',
          negativeText: '',
          referenceImage: '',
          overrides: {},
          autoRead: true,
          value: '',
          published: false,
          status: 'idle',
          output: '',
          error: '',
          ms: 0,
          images: [],
        }
        setWorkflow(current => current === null ? current : ({ ...current, nodes: [...current.nodes, node] }))
        setSelected(id)
      }

      const removeNode = (id) => {
        setWorkflow(current => current === null ? current : ({
          ...current,
          nodes: current.nodes.filter(node => node.id !== id),
          edges: current.edges.filter(edge => edge.from.node !== id && edge.to.node !== id),
        }))
        setSelected('')
      }

      const addEdge = (from, to) => {
        if (from.node === to.node) return
        setWorkflow(current => {
          if (current === null) return current
          if (current.edges.some(edge => edge.from.node === from.node && edge.from.port === from.port && edge.to.node === to.node && edge.to.port === to.port)) return current
          return { ...current, edges: [...current.edges, { id: `e${Date.now().toString(36)}`, from, to }] }
        })
      }

      const removeEdge = (id) => {
        setWorkflow(current => current === null ? current : ({ ...current, edges: current.edges.filter(edge => edge.id !== id) }))
      }

      const beginDrag = (event, node) => {
        if (event.button !== 0) return
        event.stopPropagation()
        setSelected(node.id)
        const rect = canvasRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        const startX = event.clientX
        const startY = event.clientY
        const originX = node.x
        const originY = node.y
        const k = viewRef.current.k
        const move = (moveEvent) => {
          patchNode(node.id, {
            x: Math.round(originX + (moveEvent.clientX - startX) / k),
            y: Math.round(originY + (moveEvent.clientY - startY) / k),
          })
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }

      const beginPan = (event) => {
        if (event.button !== 0 && event.button !== 1) return
        const target = event.target
        const closest = typeof target?.closest === 'function' ? target.closest('.dsh-wf-node, .dsh-wf-inspector') : null
        if (closest !== null) return
        const startX = event.clientX
        const startY = event.clientY
        const origin = viewRef.current
        let moved = false
        const move = (moveEvent) => {
          if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 4) moved = true
          setView({ k: origin.k, x: origin.x + (moveEvent.clientX - startX), y: origin.y + (moveEvent.clientY - startY) })
        }
        const up = () => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          if (!moved) {
            setSelected('')
            setEditing('')
          }
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }

      const beginLink = (event, node, port) => {
        if (event.button !== 0) return
        event.stopPropagation()
        event.preventDefault()
        const rect = canvasRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        const pointOf = (pointerEvent) => ({
          x: (pointerEvent.clientX - rect.left - viewRef.current.x) / viewRef.current.k,
          y: (pointerEvent.clientY - rect.top - viewRef.current.y) / viewRef.current.k,
        })
        const from = { node: node.id, port }
        const start = pointOf(event)
        setLink({ from, x: start.x, y: start.y })
        const move = (moveEvent) => {
          const point = pointOf(moveEvent)
          setLink(current => current === null ? current : { ...current, x: point.x, y: point.y })
        }
        const up = (upEvent) => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          const element = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
          const portElement = element?.closest?.('[data-port]')
          if (portElement !== null && portElement !== undefined) {
            const nodeId = portElement.getAttribute('data-node') ?? ''
            const portKey = portElement.getAttribute('data-port') ?? ''
            if (nodeId !== '' && portKey !== '' && portKey !== port) addEdge(from, { node: nodeId, port: portKey })
          }
          setLink(null)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }

      /**
       * Title-bar color for one AI-workflow node kind, taken from the same
       * ComfyUI palette (purple model, yellow text, cyan latent, red output…).
       * @param {string} type - model | exchange | comfy | input | output | leader.
       * @returns {string} css color.
       */
      const typeColor = (type) => {
        if (type === 'model') return '#6d3f8c'
        if (type === 'exchange') return '#8c6d2a'
        if (type === 'comfy') return '#2a568c'
        if (type === 'input') return '#37723f'
        if (type === 'output') return '#a13030'
        if (type === 'leader') return '#2f6b74'
        return '#3f5159'
      }
      /**
       * Socket type of one edge, used only to pick its color.
       * @param {object} edge - workflow edge.
       * @returns {string} a ComfyUI-style type name.
       */
      const portSocketType = (edge) => {
        const source = nodeById.get(edge.from.node)
        if (source === undefined) return 'default'
        if (source.type === 'leader') return 'CONDITIONING'
        if (source.type === 'input') return 'STRING'
        if (source.type === 'output') return 'IMAGE'
        if (source.type === 'exchange') return 'CONDITIONING'
        if (source.type === 'comfy') return edge.from.port === 'negative' ? 'CONDITIONING' : edge.from.port === 'out' ? 'IMAGE' : edge.from.port === 'image' ? 'IMAGE' : 'MODEL'
        return 'MODEL'
      }

      const portPoint = (nodeId, port) => {
        const node = nodeById.get(nodeId)
        if (node === undefined) return { x: 0, y: 0 }
        const size = sizeOf(node)
        const y = node.y + portOffset(node, port)
        if (port === 'out') return { x: node.x + size.w, y }
        return { x: node.x, y }
      }

      const startRun = async () => {
        if (workflow === null) return
        setError('')
        setRun(null)
        setNotice(t('wfRunRunning'))
        try {
          const data = await wfCall('run', { method: 'POST', body: { sessionId, workflow } })
          try { sessionStorage.setItem(WF_RUN_KEY, data.runId) } catch { /* ignore */ }
          setRunId(data.runId)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        }
      }

      const stopRun = async () => {
        if (runId === '') return
        try {
          await wfCall('run/cancel', { method: 'POST', body: { runId } })
        } catch (caught) {
          setError(String(caught.message ?? caught))
        }
      }

      const checkComfy = async (node) => {
        setComfy(current => ({ ...current, busy: 'check' }))
        try {
          const data = await wfCall('comfy/status', { query: { baseUrl: node.baseUrl } })
          setComfy(current => ({ ...current, status: data.ok === true ? data.system : null, busy: '' }))
          if (data.ok !== true) setError(String(data.error ?? t('wfComfyNotReady')))
          else setError('')
        } catch (caught) {
          setComfy(current => ({ ...current, status: null, busy: '' }))
          setError(String(caught.message ?? caught))
        }
      }

      const startComfyBackend = async () => {
        setComfy(current => ({ ...current, busy: 'start' }))
        try {
          await wfCall('comfy/start', { method: 'POST', body: {} })
          setNotice('ComfyUI 正在启动，首次加载模型会比较久…')
        } catch (caught) {
          setError(String(caught.message ?? caught))
        } finally {
          setComfy(current => ({ ...current, busy: '' }))
        }
      }

      const refreshComfyWorkflows = async () => {
        setComfy(current => ({ ...current, busy: 'list' }))
        try {
          // Drop the cached graph/targets so a workflow edited in ComfyUI is
          // re-read instead of serving the version from page load.
          setGraphs({})
          setTargets({})
          setComfyRaw({})
          const data = await wfCall('comfy/workflows')
          setComfy(current => ({ ...current, workflows: data.workflows ?? [], busy: '' }))
          setNotice(`已刷新：${(data.workflows ?? []).length} 个工作流`)
        } catch (caught) {
          setError(String(caught.message ?? caught))
          setComfy(current => ({ ...current, busy: '' }))
        }
      }

      const readChatInput = async () => {
        try {
          const data = await wfCall('chat/input', { query: { sessionId } })
          const text = String(data.text ?? '')
          const card = nodeById.get(editing === '' ? selected : editing)
          if (card !== undefined) patchNode(card.id, { value: text })
          setNotice(text === '' ? '对话栏还没有文字' : '已读取对话栏文字')
        } catch (caught) {
          setError(String(caught.message ?? caught))
        }
      }

      const republishOutput = async (card) => {
        try {
          const receipt = await wfCall('chat/reply', { method: 'POST', body: { sessionId, text: card.output ?? '' } })
          patchNode(card.id, { published: receipt.ok === true })
          setNotice(receipt.ok === true ? t('wfPublished') : `回复失败：${receipt.error ?? ''}`)
        } catch (caught) {
          setError(String(caught.message ?? caught))
        }
      }

      const renderChecks = (items, values, onToggle, describe) => h(
        'div',
        { className: 'dsh-wf-checks' },
        items.length === 0
          ? h('span', { className: 'dsh-wf-node-model' }, '—')
          : items.map(item => h(
            'label',
            { className: 'dsh-wf-check', key: item.name ?? item.id },
            h('input', {
              type: 'checkbox',
              checked: values.includes(item.name ?? item.id),
              onChange: () => onToggle(item.name ?? item.id),
            }),
            h('span', null, item.name ?? item.id, describe === undefined ? null : h('small', null, ` ${describe(item)}`)),
          )),
      )

      const renderInspector = () => {
        const node = editingNode
        if (node === undefined) return null
        const graphNodes = node.type === 'comfy' && graphs[node.workflow] !== undefined ? graphs[node.workflow].nodes : []
        const loadImages = graphNodes.filter(item => item.title === 'LoadImage')
        const comfyTargets = node.type === 'comfy' ? targets[node.workflow] : undefined
        const positives = (comfyTargets?.positives ?? []).map(item => ({ ...item, title: graphNodes.find(g => g.id === item.id)?.title ?? item.classType }))
        const negatives = (comfyTargets?.negatives ?? []).map(item => ({ ...item, title: graphNodes.find(g => g.id === item.id)?.title ?? item.classType }))
        const imageTargets = comfyTargets?.images ?? []
        const referenceList = imageTargets.length > 0 ? imageTargets : loadImages.map(item => ({ id: item.id, classType: 'LoadImage', field: 'image' }))
        const referenceValue = (node.referenceTarget ?? '').includes(':') ? node.referenceTarget : `${node.referenceTarget ?? ''}:image`
        const models = catalog.models.filter(entry => entry.provider === node.provider)
        const effortModel = catalog.models.find(entry => entry.provider === node.provider && entry.id === node.model)
        const toggle = (key, value) => patchNode(node.id, {
          [key]: (node[key] ?? []).includes(value) ? node[key].filter(item => item !== value) : [...(node[key] ?? []), value],
        })
        const tools = catalog.tools.filter(tool => toolQuery === '' || tool.name.toLowerCase().includes(toolQuery.toLowerCase()))
        return h(
          'div',
          { className: 'dsh-wf-inspector', onPointerDown: event => event.stopPropagation() },
          h(
            'h4',
            null,
            h('span', { className: 'dsh-wf-kind' }, node.type === 'model' ? t('wfModel') : node.type === 'exchange' ? t('wfExchange') : t('wfComfy')),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, node.title),
            h(Button, {
              label: t('wfCloseEditor'),
              title: t('wfCloseEditor'),
              onClick: () => setEditing(''),
            }),
          ),
          h(WfField, { label: '标题' }, h('input', {
            className: 'dsh-wf-input',
            value: node.title,
            onChange: event => patchNode(node.id, { title: event.target.value }),
          })),
          node.type === 'model' || node.type === 'exchange'
            ? h(
              'div',
              { className: 'dsh-wf-row' },
              h(WfField, { label: 'Provider' }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.provider,
                  onChange: (event) => {
                    const provider = event.target.value
                    const first = catalog.models.find(entry => entry.provider === provider)
                    patchNode(node.id, { provider, model: first?.id ?? '' })
                  },
                },
                h('option', { value: '' }, '—'),
                catalog.providers.map(provider => h('option', { key: provider.id, value: provider.id }, provider.name)),
              )),
              h(WfField, { label: t('wfModel') }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.model,
                  onChange: event => patchNode(node.id, { model: event.target.value }),
                },
                h('option', { value: '' }, node.type === 'exchange' ? '继承第一个模型节点' : '—'),
                models.map(entry => h('option', { key: entry.id, value: entry.id }, entry.name)),
              )),
            )
            : null,
          node.type === 'model' || node.type === 'exchange'
            ? h(
              'div',
              { className: 'dsh-wf-row' },
              h(WfField, { label: '推理强度' }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.reasoningEffort ?? '',
                  onChange: event => patchNode(node.id, { reasoningEffort: event.target.value }),
                },
                h('option', { value: '' }, '默认'),
                (effortModel?.efforts ?? []).map(effort => h('option', { key: effort.id, value: effort.id }, effort.name)),
              )),
              h(WfField, { label: 'temperature' }, h('input', {
                className: 'dsh-wf-input',
                type: 'number',
                min: 0,
                max: 2,
                step: 0.1,
                value: node.temperature ?? '',
                onChange: event => patchNode(node.id, { temperature: event.target.value === '' ? undefined : Number(event.target.value) }),
              })),
            )
            : null,
          node.type === 'model'
            ? h(
              'div',
              null,
              h(WfField, { label: t('wfPrompt') }, h('textarea', {
                className: 'dsh-wf-area',
                rows: 6,
                value: node.prompt,
                placeholder: t('wfPromptHint'),
                onChange: event => patchNode(node.id, { prompt: event.target.value }),
              })),
              h('div', { className: 'dsh-wf-node-model' }, t('wfPromptHint')),
            )
            : null,
          node.type === 'exchange'
            ? h(
              'div',
              null,
              h(WfField, { label: t('wfExchangePrompt') }, h('textarea', {
                className: 'dsh-wf-area',
                rows: 7,
                value: node.prompt,
                placeholder: t('wfExchangeHint'),
                onChange: event => patchNode(node.id, { prompt: event.target.value }),
              })),
              h(WfField, { label: t('wfMode') }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.mode,
                  onChange: event => patchNode(node.id, { mode: event.target.value }),
                },
                h('option', { value: 'auto' }, t('wfModeAuto')),
                h('option', { value: 'fanout' }, t('wfModeFanout')),
              )),
              h('div', { className: 'dsh-wf-node-model' }, t('wfExchangeHint')),
            )
            : null,
          node.type === 'input' || node.type === 'leader'
            ? h(
              'div',
              null,
              h('div', { className: 'dsh-wf-node-model' }, node.type === 'leader' ? t('wfLeaderHint') : t('wfChatInputHint')),
              h(WfField, { label: t('wfChatInput') }, h('textarea', {
                className: 'dsh-wf-area',
                rows: 4,
                value: node.value ?? '',
                onChange: event => patchNode(node.id, { value: event.target.value }),
              })),
              h('label', { className: 'dsh-wf-check' },
                h('input', {
                  type: 'checkbox',
                  checked: node.autoRead !== false,
                  onChange: event => patchNode(node.id, { autoRead: event.target.checked }),
                }),
                h('span', null, t('wfAutoRead')),
              ),
              h('div', { className: 'dsh-wf-row' },
                h(Button, { label: t('wfReadNow'), onClick: () => void readChatInput() }),
              ),
            )
            : null,
          node.type === 'output'
            ? h(
              'div',
              null,
              h('div', { className: 'dsh-wf-node-model' }, t('wfOutputHint')),
              h('div', { className: 'dsh-wf-node-model' }, node.published === true ? `✓ ${t('wfPublished')}` : t('wfNotPublished')),
              h('div', { className: 'dsh-wf-row' },
                h(Button, {
                  label: t('wfResend'),
                  disabled: (node.output ?? '') === '',
                  onClick: () => void republishOutput(node),
                }),
              ),
            )
            : null,
          node.type === 'model'
            ? h(
              'div',
              null,
              h(WfField, { label: `${t('wfTools')}（${(node.tools ?? []).length}）` }, h('input', {
                className: 'dsh-wf-input',
                placeholder: '搜索工具…',
                value: toolQuery,
                onChange: event => setToolQuery(event.target.value),
              })),
              renderChecks(tools, node.tools ?? [], value => toggle('tools', value), tool => tool.name.startsWith('mcp__') ? 'MCP' : ''),
              h(WfField, { label: t('wfSkills') }, renderChecks(catalog.skills, node.skills ?? [], value => toggle('skills', value))),
              h(WfField, { label: t('wfMcps') }, renderChecks(
                catalog.mcps.map(server => ({ name: server.id })),
                node.mcps ?? [],
                value => toggle('mcps', value),
                server => `· ${catalog.tools.filter(tool => tool.name.startsWith(`mcp__${server.name}__`)).length} 个工具`,
              )),
            )
            : null,
          node.type === 'comfy'
            ? h(
              'div',
              { className: 'dsh-wf-row', style: { flexDirection: 'column', alignItems: 'stretch' } },
              h(WfField, { label: t('wfComfyUrl') }, h('input', {
                className: 'dsh-wf-input',
                value: node.baseUrl,
                onChange: event => patchNode(node.id, { baseUrl: event.target.value }),
              })),
              h(
                'div',
                { className: 'dsh-wf-row' },
                h(Button, { label: t('wfComfyCheck'), onClick: () => void checkComfy(node) }),
                h(Button, { label: t('wfComfyStart'), onClick: () => void startComfyBackend() }),
                h(Button, { label: t('wfComfyRefresh'), onClick: () => void refreshComfyWorkflows() }),
                h(Button, { label: t('wfCheckUpdates'), onClick: () => void refreshComfyWorkflows() }),
              ),
              h('div', { className: 'dsh-wf-node-model' }, comfy.status === null ? t('wfComfyNotReady') : t('wfComfyReady')),
              h('div', { className: 'dsh-wf-row' },
                h(Button, { label: t('wfViewGraph'), disabled: node.workflow === '', onClick: () => void openGraph(node.workflow) }),
              ),
              h(WfField, { label: t('wfComfyWorkflows') }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.workflow,
                  onChange: event => patchNode(node.id, { workflow: event.target.value }),
                },
                h('option', { value: '' }, '—'),
                comfy.workflows.map(item => h('option', {
                  key: item.name,
                  value: item.name,
                }, item.format === 'api' ? item.name : `${item.name} · UI→API`)),
              )),
              h(WfField, { label: t('wfTargetPositive') }, h(
                'select',
                {
                  className: 'dsh-wf-select',
                  value: node.positiveTarget ?? '',
                  onChange: event => patchNode(node.id, { positiveTarget: event.target.value }),
                },
                h('option', { value: '' }, positives.length > 0 ? '自动（所有文本编码节点）' : '无可选节点'),
                positives.map(item => h('option', { key: `${item.id}-${item.field}`, value: item.id }, `#${item.id} ${item.title} → ${item.field}`)),
              )),
              h(WfField, { label: t('wfPositive') }, h('textarea', {
                className: 'dsh-wf-area',
                rows: 2,
                value: node.promptText,
                onChange: event => patchNode(node.id, { promptText: event.target.value }),
              })),
              negatives.length > 0 || (node.negativeText ?? '') !== ''
                ? h(
                  'div',
                  null,
                  h(WfField, { label: t('wfTargetNegative') }, h(
                    'select',
                    {
                      className: 'dsh-wf-select',
                      value: node.negativeTarget ?? '',
                      onChange: event => patchNode(node.id, { negativeTarget: event.target.value }),
                    },
                    h('option', { value: '' }, negatives.length > 0 ? '自动（所有 negative_prompt）' : t('wfNoNegative')),
                    negatives.map(item => h('option', { key: `${item.id}-${item.field}`, value: item.id }, `#${item.id} ${item.title} → ${item.field}`)),
                  )),
                  h(WfField, { label: t('wfNegative') }, h('textarea', {
                    className: 'dsh-wf-area',
                    rows: 2,
                    value: node.negativeText ?? '',
                    onChange: event => patchNode(node.id, { negativeText: event.target.value }),
                  })),
                )
                : null,
              h(WfField, { label: t('wfReference') },
                h('div', { className: 'dsh-wf-row' },
                  h('input', {
                    className: 'dsh-wf-input',
                    type: 'file',
                    accept: 'image/png,image/jpeg,image/webp',
                    onChange: async (event) => {
                      const file = event.target.files?.[0]
                      if (file === undefined) return
                      try {
                        const data = await readBase64(file)
                        const result = await wfCall('comfy/upload', { method: 'POST', body: { sessionId, name: file.name, data } })
                        patchNode(node.id, { referenceImage: result.name })
                        setError('')
                      } catch (caught) {
                        setError(String(caught.message ?? caught))
                      }
                    },
                  }),
                  (node.referenceImage ?? '') !== ''
                    ? h(Button, { label: t('wfClear'), onClick: () => patchNode(node.id, { referenceImage: '' }) })
                    : null,
                ),
                (node.referenceImage ?? '') !== ''
                  ? h('img', {
                    className: 'dsh-wf-thumb',
                    src: `api/ai-workflow/comfy/view?sessionId=${encodeURIComponent(sessionId)}&baseUrl=${encodeURIComponent(node.baseUrl || '')}&filename=${encodeURIComponent(node.referenceImage)}&subfolder=&type=input`,
                    alt: t('wfReference'),
                  })
                  : null,
              ),
              referenceList.length > 0
                ? h(WfField, { label: t('wfTargetReference') }, h(
                  'select',
                  {
                    className: 'dsh-wf-select',
                    value: referenceValue,
                    onChange: event => patchNode(node.id, { referenceTarget: event.target.value }),
                  },
                  h('option', { value: '' }, '自动（第一个图像输入）'),
                  referenceList.map(item => h('option', { key: `${item.id}-${item.field}`, value: `${item.id}:${item.field}` }, `#${item.id} ${item.classType} → ${item.field}`)),
                ))
                : null,
              h('div', { className: 'dsh-wf-row' },
                h(Button, {
                  label: t('wfPreview'),
                  disabled: node.workflow === '',
                  onClick: async () => {
                    try {
                      const data = await wfCall('comfy/preview', { method: 'POST', body: { name: node.workflow, node } })
                      setComfyPreview(data.applied ?? [])
                      setError('')
                    } catch (caught) {
                      setError(String(caught.message ?? caught))
                    }
                  },
                }),
              ),
              comfyPreview !== null
                ? h(
                  'div',
                  { className: 'dsh-wf-checks' },
                  comfyPreview.length === 0
                    ? h('span', { className: 'dsh-wf-node-model' }, '没有字段被改写')
                    : comfyPreview.map(item => h(
                      'div',
                      { className: 'dsh-wf-check', key: item.id },
                      h('span', null, `#${item.id} ${item.class_type}: ${Object.entries(item.changes).map(([field, change]) => `${field}=${String(change.to).slice(0, 36)}`).join(' · ')}`),
                    )),
                )
                : null,
              h(
                'div',
                { className: 'dsh-wf-row' },
                h(WfField, { label: t('wfComfySeed') }, h('input', {
                  className: 'dsh-wf-input',
                  type: 'number',
                  value: node.seed ?? '',
                  onChange: event => patchNode(node.id, { seed: event.target.value === '' ? undefined : Number(event.target.value) }),
                })),
                h(WfField, { label: t('wfComfySize') }, h(
                  'div',
                  { className: 'dsh-wf-row' },
                  h('input', {
                    className: 'dsh-wf-input',
                    type: 'number',
                    style: { width: 72 },
                    value: node.width ?? '',
                    onChange: event => patchNode(node.id, { width: event.target.value === '' ? undefined : Number(event.target.value) }),
                  }),
                  h('span', null, '×'),
                  h('input', {
                    className: 'dsh-wf-input',
                    type: 'number',
                    style: { width: 72 },
                    value: node.height ?? '',
                    onChange: event => patchNode(node.id, { height: event.target.value === '' ? undefined : Number(event.target.value) }),
                  }),
                )),
              ),
              h(WfField, { label: t('wfComfyOverrides') }, h('textarea', {
                className: 'dsh-wf-area',
                rows: 3,
                value: JSON.stringify(node.overrides ?? {}, null, 2),
                onBlur: (event) => {
                  try {
                    const parsed = JSON.parse(event.target.value || '{}')
                    patchNode(node.id, { overrides: parsed !== null && typeof parsed === 'object' ? parsed : {} })
                    setError('')
                  } catch {
                    setError('overrides 不是合法 JSON')
                  }
                },
                onChange: () => undefined,
              })),
            )
            : null,
          h('div', { className: 'dsh-wf-row' }, h(Button, {
            label: t('wfDelete'),
            tone: 'danger',
            onClick: () => removeNode(node.id),
          })),
        )
      }

      const miniGraph = (ui) => {
        const laid = layoutLitegraph(ui ?? { nodes: [] })
        const bounds = laid.bounds
        return h(
          'svg',
          { className: 'dsh-wf-mini', viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`, preserveAspectRatio: 'xMidYMid meet' },
          (ui?.links ?? []).map((link, index) => {
            if (!Array.isArray(link)) return null
            const from = laid.byId.get(String(link[1]))
            const to = laid.byId.get(String(link[3]))
            if (from === undefined || to === undefined) return null
            return h('line', {
              key: `l${index}`,
              x1: from.x + from.w,
              y1: from.y + from.h / 2,
              x2: to.x,
              y2: to.y + to.h / 2,
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: Math.max(4, bounds.width / 200),
            })
          }),
          [...laid.byId.values()].map(node => h('rect', {
            key: node.id,
            x: node.x,
            y: node.y,
            width: node.w,
            height: node.h,
            rx: 10,
            fill: nodeColor(node.type),
            'fill-opacity': 0.55,
            stroke: 'var(--dsw-alias-border-l1)',
            strokeWidth: Math.max(3, bounds.width / 260),
          })),
        )
      }

      const bigGraph = (data) => {
        const bounds = data?.bounds ?? { width: 900, height: 600 }
        const byId = new Map((data?.nodes ?? []).map(node => [node.id, node]))
        return h(
          'svg',
          { className: 'dsh-wf-biggraph', viewBox: `0 0 ${bounds.width} ${bounds.height}`, preserveAspectRatio: 'xMidYMid meet' },
          (data?.edges ?? []).map((edge, index) => {
            const a = byId.get(edge.from)
            const b = byId.get(edge.to)
            if (a === undefined || b === undefined) return null
            return h('path', {
              key: `e${index}`,
              d: `M ${a.x + a.w} ${a.y + a.h / 2} C ${a.x + a.w + 26} ${a.y + a.h / 2}, ${b.x - 26} ${b.y + b.h / 2}, ${b.x} ${b.y + b.h / 2}`,
              fill: 'none',
              stroke: 'var(--dsw-alias-border-l2)',
              strokeWidth: 2,
            })
          }),
          (data?.nodes ?? []).map(node => h(
            'g',
            { key: node.id },
            h('rect', {
              x: node.x,
              y: node.y,
              width: node.w,
              height: node.h,
              rx: 8,
              fill: 'var(--dsw-alias-bg-layer-2)',
              stroke: 'var(--dsw-alias-border-l2)',
            }),
            h('text', { x: node.x + 8, y: node.y + 17, fill: 'var(--dsw-alias-label-primary)', fontSize: 10, fontWeight: 600 }, node.title.slice(0, 24)),
            h('text', { x: node.x + 8, y: node.y + 30, fill: 'var(--dsw-alias-label-secondary)', fontSize: 8 }, `#${node.id}`),
            node.summary.slice(0, 3).map((line, index) => h('text', {
              key: `s${index}`,
              x: node.x + 8,
              y: node.y + 44 + index * 11,
              fill: 'var(--dsw-alias-label-secondary)',
              fontSize: 8,
            }, line.slice(0, 30))),
          )),
        )
      }

      const renderNode = (node) => {
        const runtime = node.status ?? 'idle'
        const expanded = isExpanded(node)
        const size = sizeOf(node)
        const comfyGraph = node.type === 'comfy' ? graphs[node.workflow] : undefined
        const comfyUi = node.type === 'comfy' ? (comfyRaw[node.workflow] ?? comfyGraph?.ui ?? null) : null
        return h(
          'div',
          {
            key: node.id,
            className: `dsh-wf-node ${selected === node.id ? 'sel' : ''} ${runtime === 'running' ? 'running' : runtime === 'error' ? 'error' : ''}`,
            'data-node-id': node.id,
            style: { left: node.x, top: node.y, width: size.w, ...(expanded ? { height: size.h } : {}) },
            onPointerDown: event => beginDrag(event, node),
            onContextMenu: (event) => {
              event.preventDefault()
              event.stopPropagation()
              setSelected(node.id)
              setEditing(node.id)
            },
          },
          h(
            'div',
            {
              className: 'dsh-wf-node-head',
              // ComfyUI paints a title bar per node category; the AI node kinds
              // follow the same palette.
              style: { background: typeColor(node.type) },
            },
            h('span', { className: `dsh-wf-dot ${runtime}` }),
            h('span', { className: 'dsh-wf-node-title' }, node.title || node.id),
            comfyGraph !== undefined
              ? h('span', { style: { flex: 'none' }, onPointerDown: event => event.stopPropagation() },
                h(Button, {
                  label: expanded ? '收起' : '展开',
                  title: expanded ? t('wfCollapse') : t('wfExpand'),
                  onClick: (event) => {
                    event.stopPropagation()
                    setCollapsed(current => ({ ...current, [node.id]: expanded }))
                  },
                }))
              : null,
            h('span', { className: 'dsh-wf-kind' }, node.type === 'model' ? 'MODEL' : node.type === 'exchange' ? 'EXCH' : node.type === 'input' ? 'INPUT' : node.type === 'output' ? 'OUTPUT' : node.type === 'leader' ? 'LEADER' : 'COMFY'),
          ),
          expanded
            ? h(
              'div',
              { className: 'dsh-wf-node-body', style: { padding: 6, gap: 5, flex: 1, minHeight: 0, overflow: 'hidden' } },
              h('div', { className: 'dsh-wf-node-model' }, `${node.workflow} · ${String(comfyGraph?.format ?? '').toUpperCase()} · ${(comfyUi?.nodes ?? []).length} 节点`),
              h('div', { style: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' } }, h(LiteGraphView, { ui: comfyUi, zoom: 1, highlight: highlightFor(node), onPick: pickTarget })),
            )
            : h(
              'div',
              { className: 'dsh-wf-node-body' },
              node.type === 'model'
                ? h('div', { className: 'dsh-wf-node-model' }, `${node.provider || '—'} / ${node.model || '—'}`)
                : node.type === 'exchange'
                  ? h('div', { className: 'dsh-wf-node-model' }, node.mode === 'fanout' ? t('wfModeFanout') : t('wfModeAuto'))
                  : node.type === 'leader'
                    ? h('div', { className: 'dsh-wf-node-model' }, t('wfLeaderTitle'))
                    : node.type === 'input'
                      ? h('div', { className: 'dsh-wf-node-model' }, t('wfChatInput'))
                      : node.type === 'output'
                        ? h('div', { className: 'dsh-wf-node-model' }, node.published === true ? t('wfPublished') : t('wfNotPublished'))
                        : h('div', { className: 'dsh-wf-node-model' }, node.workflow || '—'),
              h(
                'div',
                { className: 'dsh-wf-badges' },
                node.type === 'model' ? h('span', { className: 'dsh-wf-badge' }, `${t('wfTools')} ${(node.tools ?? []).length}`) : null,
                node.type === 'model' ? h('span', { className: 'dsh-wf-badge' }, `${t('wfSkills')} ${(node.skills ?? []).length}`) : null,
                node.type === 'model' ? h('span', { className: 'dsh-wf-badge' }, `MCP ${(node.mcps ?? []).length}`) : null,
                node.status === 'done' && node.ms > 0 ? h('span', { className: 'dsh-wf-badge' }, `${(node.ms / 1000).toFixed(1)}s`) : null,
              ),
              node.type === 'comfy' && comfyUi !== null ? miniGraph(comfyUi) : null,
              node.error !== '' && node.error !== undefined
                ? h('div', { className: 'dsh-wf-node-out', style: { color: 'var(--dsw-alias-state-error-primary)' } }, node.error)
                : h('div', { className: 'dsh-wf-node-out' }, node.output === '' || node.output === undefined ? '—' : node.output.slice(0, 220)),
              Array.isArray(node.images) && node.images.length > 0 && node.images[0].url !== undefined
                ? h('img', { className: 'dsh-wf-thumb', src: node.images[0].url, alt: t('wfImage') })
                : null,
            ),
          node.type === 'model'
            ? [
              port(node, 'in', t('wfInput'), 'left', portOffset(node, 'in')),
              port(node, 'exchange', t('wfExchange'), 'left', portOffset(node, 'exchange')),
              port(node, 'out', t('wfOutput'), 'right', portOffset(node, 'out')),
            ]
            : node.type === 'exchange'
              ? [
                port(node, 'in', t('wfInput'), 'left', portOffset(node, 'in')),
                port(node, 'out', t('wfDispatch'), 'right', portOffset(node, 'out')),
              ]
              : node.type === 'input'
                ? [port(node, 'out', t('wfOutput'), 'right', portOffset(node, 'out'))]
                : node.type === 'output'
                  ? [port(node, 'in', t('wfInput'), 'left', portOffset(node, 'in'))]
                  : node.type === 'leader'
                    ? [
                      // Two inputs (user message, member results) and one
                      // dispatch output keep the three pipelines distinct.
                      port(node, 'out', t('wfDispatch'), 'right', 46),
                      port(node, 'input', t('wfLeaderUserInput'), 'left', 38),
                      port(node, 'result', t('wfLeaderMembers'), 'left', 78),
                    ]
                    : [
                    port(node, 'in', t('wfPositive'), 'left', portOffset(node, 'in')),
                    port(node, 'negative', t('wfNegative'), 'left', portOffset(node, 'negative')),
                    port(node, 'image', t('wfReference'), 'left', portOffset(node, 'image')),
                    port(node, 'out', t('wfOutput'), 'right', portOffset(node, 'out')),
                  ],
        )
      }

      const port = (card, key, label, side, top) => h(
        'div',
        {
          key,
          className: `dsh-wf-port ${key}`,
          'data-node': card.id,
          'data-port': key,
          style: side === 'left'
            ? { left: -6, top: top - 5 }
            : { right: -6, top: top - 5 },
          title: label,
          onPointerDown: event => beginLink(event, card, key),
        },
        h('span', {
          className: 'dsh-wf-port-label',
          style: side === 'left'
            ? { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 5 }
            : { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 5 },
        }, label),
      )

      const openGraph = async (name) => {
        if (name === '') return
        let data = graphs[name]
        if (data === undefined) {
          try {
            data = await wfCall('comfy/json', { query: { name } })
            setGraphs(current => ({ ...current, [name]: data }))
          } catch (caught) {
            setError(String(caught.message ?? caught))
            return
          }
        }
        let raw = comfyRaw[name]
        if (raw === undefined) {
          raw = data.ui ?? null
          if (raw !== null) setComfyRaw(current => ({ ...current, [name]: raw }))
        }
        setGraphModal({ name, data, ui: raw, tab: 'graph', zoom: 1 })
      }

      /**
       * Highlight the nodes one ComfyUI-type graph node injects into.
       * @param {object} card - workflow node of type `comfy`.
       * @returns {string[]} node ids as strings.
       */
      const highlightFor = (card) => [card?.positiveTarget, card?.negativeTarget, String(card?.referenceTarget ?? '').split(':')[0]]
        .filter(value => value !== undefined && value !== null && value !== '')
        .map(String)

      /**
       * Make one clicked ComfyUI graph node the injection target.
       *
       * The node's own writable fields decide which of the three targets move:
       * a text-encode node takes the prompts, an image loader takes the
       * reference image, and anything else reports that it has no slot.
       * @param {string} id - ComfyUI node id inside the workflow.
       */
      const pickTarget = (id) => {
        const card = nodeById.get(editing === '' ? selected : editing)
        if (card === undefined || card.type !== 'comfy') return
        const catalog = targets[card.workflow] ?? {}
        const pos = (catalog.positives ?? []).find(item => String(item.id) === String(id))
        const neg = (catalog.negatives ?? []).find(item => String(item.id) === String(id))
        const img = (catalog.images ?? []).find(item => String(item.id) === String(id))
        const patch = {}
        if (pos !== undefined) patch.positiveTarget = String(id)
        if (neg !== undefined) patch.negativeTarget = String(id)
        if (img !== undefined) patch.referenceTarget = `${id}:${img.field}`
        if (Object.keys(patch).length === 0) {
          setNotice(`#${id} 没有可注入的提示词或参考图字段`)
          return
        }
        patchNode(card.id, patch)
        setNotice(`#${id} 已设为注入目标`)
      }

      const renderGraphModal = () => {
        const data = graphModal.data
        const nodes = data?.nodes ?? []
        const byId = new Map(nodes.map(node => [node.id, node]))
        const bounds = data?.bounds ?? { width: 900, height: 600 }
        const zoom = graphModal.zoom ?? 1
        return h(
          'div',
          { className: 'dsh-wf-modal', onPointerDown: event => event.stopPropagation() },
          h(
            'div',
            { className: 'dsh-wf-modal-card' },
            h(
              'div',
              { className: 'dsh-wf-modal-head' },
              h('span', { className: 'dsh-wf-modal-title' }, `${graphModal.name} · ${data?.format?.toUpperCase() ?? ''}`),
              h(Button, { label: t('wfGraph'), primary: graphModal.tab === 'graph', onClick: () => setGraphModal(current => ({ ...current, tab: 'graph' })) }),
              h(Button, { label: t('wfJson'), primary: graphModal.tab === 'json', onClick: () => setGraphModal(current => ({ ...current, tab: 'json' })) }),
              h(Button, { label: '−', title: t('wfZoomOut'), onClick: () => setGraphModal(current => ({ ...current, zoom: Math.max(0.4, (current.zoom ?? 1) / 1.2) })) }),
              h(Button, { label: '＋', title: t('wfZoomIn'), onClick: () => setGraphModal(current => ({ ...current, zoom: Math.min(3, (current.zoom ?? 1) * 1.2) })) }),
              h(Button, { label: t('wfCloseEditor'), onClick: () => setGraphModal(null) }),
            ),
            h(
              'div',
              { className: 'dsh-wf-modal-body' },
              graphModal.tab === 'json'
                ? h('pre', { className: 'dsh-wf-json' }, JSON.stringify(data?.json ?? {}, null, 2))
                : (graphModal.ui?.nodes ?? []).length === 0
                  ? h('div', { className: 'dsh-wf-node-model' }, t('wfGraphEmpty'))
                  : h(LiteGraphView, {
                    ui: graphModal.ui,
                    zoom,
                    highlight: highlightFor(nodeById.get(editing === '' ? selected : editing)),
                    onPick: (id) => {
                      pickTarget(id)
                      setGraphModal(current => current === null ? current : { ...current, picked: id })
                    },
                  }),
            ),
          ),
        )
      }

      const openNodeLib = async () => {
        setNodeLib(current => ({ ...current, open: true }))
        if (nodeLib.data !== null) return
        try {
          const data = await wfCall('comfy/nodes', { query: { sessionId, baseUrl: 'http://127.0.0.1:8188' } })
          setNodeLib({ open: true, data, error: '', query: nodeLib.query })
        } catch (caught) {
          setNodeLib(current => ({ ...current, error: String(caught.message ?? caught) }))
        }
      }

      const renderNodeLib = () => {
        const q = nodeLib.query.toLowerCase()
        const nodes = (nodeLib.data?.nodes ?? []).filter(node => q === '' || node.name.toLowerCase().includes(q) || node.category.toLowerCase().includes(q))
        return h(
          'div',
          { className: 'dsh-wf-modal', onPointerDown: event => event.stopPropagation() },
          h(
            'div',
            { className: 'dsh-wf-modal-card' },
            h(
              'div',
              { className: 'dsh-wf-modal-head' },
              h('span', { className: 'dsh-wf-modal-title' }, `${t('wfNodeLib')} · ${nodeLib.data?.total ?? 0}（${nodeLib.data?.source ?? ''}）`),
              h('input', {
                className: 'dsh-wf-input',
                style: { maxWidth: 240 },
                placeholder: '搜索节点…',
                value: nodeLib.query,
                onChange: event => setNodeLib(current => ({ ...current, query: event.target.value })),
              }),
              h(Button, { label: t('wfCloseEditor'), onClick: () => setNodeLib(current => ({ ...current, open: false })) }),
            ),
            h(
              'div',
              { className: 'dsh-wf-modal-body' },
              nodeLib.error !== '' ? h('div', { className: 'dsh-wf-node-model' }, nodeLib.error) : null,
              nodeLib.data === null && nodeLib.error === '' ? h('div', { className: 'dsh-wf-node-model' }, '…') : null,
              nodes.slice(0, 300).map(node => h(
                'div',
                { className: 'dsh-wf-mcp-row', key: node.name },
                h(
                  'main',
                  null,
                  h('span', { className: 'dsh-wf-mcp-name' }, node.name),
                  h('span', { className: 'dsh-wf-mcp-note' }, `${node.category} · ${(node.inputs ?? []).map(input => `${input.field}:${input.kind}`).slice(0, 6).join(', ')}`),
                ),
              )),
              nodes.length > 300 ? h('div', { className: 'dsh-wf-node-model' }, `仅显示前 300 / ${nodes.length}`) : null,
            ),
          ),
        )
      }

      const byId = nodeById
      const nodes = workflow?.nodes ?? []
      const edges = workflow?.edges ?? []
      const running = run !== null && run.status === 'running'

      return h(
        'div',
        { className: 'dsh-wf-root', 'data-aiwf': 'panel' },
        h('style', null, WF_CSS),
        h(
          'div',
          { className: 'dsh-wf-head' },
          h('span', { className: 'dsh-wf-title' }, t('wfTitle')),
          h(Button, { label: t('wfAddModel'), primary: true, onClick: () => addNode('model') }),
          h(Button, { label: t('wfAddLeader'), onClick: () => addNode('leader') }),
          h(Button, { label: t('wfAddInput'), onClick: () => addNode('input') }),
          h(Button, { label: t('wfAddOutput'), onClick: () => addNode('output') }),
          h(Button, { label: t('wfAddExchange'), onClick: () => addNode('exchange') }),
          h(Button, { label: t('wfAddComfy'), onClick: () => addNode('comfy') }),
          h(Button, { label: t('wfNodeLib'), onClick: () => void openNodeLib() }),
          h('span', { className: 'dsh-wf-sp' }),
          h(Button, { label: running ? t('wfStop') : t('wfRun'), tone: running ? 'danger' : 'primary', disabled: workflow === null || nodes.length === 0 || sessionId === '', onClick: () => { void (running ? stopRun() : startRun()) } }),
          h(Button, {
            label: t('tabTitle'),
            title: t('tabTitle'),
            onClick: () => {
              const sidebar = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : ctx.sidebarRight
              if (typeof sidebar?.openTab === 'function') sidebar.openTab(TAB_KIND)
            },
          }),
          h('span', { className: 'dsh-wf-pill' }, saving ? t('wfSaving') : (notice || t('wfSaved'))),
          running ? h('span', { className: 'dsh-wf-pill run' }, t('wfRunRunning')) : null,
        ),
        error === '' ? null : h('div', { className: 'dsh-wf-error' }, error),
        sessionId === ''
          ? h('div', { className: 'dsh-wf-empty' }, h('strong', null, t('wfNoSession')))
          : h(
            'div',
            {
              className: 'dsh-wf-canvas',
              ref: canvasRef,
              onPointerDown: (event) => {
                setEdgeMenu(null)
                beginPan(event)
              },
              // The dot grid shares the world transform: spacing scales with
              // the zoom, origin follows the pan, so the dots move with the
              // mouse and the nodes never drift off the grid.
              style: {
                backgroundSize: `${18 * view.k}px ${18 * view.k}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              },
            },
            workflow === null
              ? h('div', { className: 'dsh-wf-empty' }, '…')
              : h(
                'div',
                {
                  className: 'dsh-wf-world',
                  style: { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` },
                },
                h(
                  'svg',
                  { className: 'dsh-wf-svg', width: 6000, height: 6000 },
                  edges.map((edge) => {
                    const a = portPoint(edge.from.node, edge.from.port)
                    const b = portPoint(edge.to.node, edge.to.port)
                    const path = `M ${a.x} ${a.y} C ${a.x + 70} ${a.y}, ${b.x - 70} ${b.y}, ${b.x} ${b.y}`
                    // Each pipeline gets its own color, like ComfyUI colors a
                    // link by the socket it leaves from.
                    const stroke = linkColor(portSocketType(edge))
                    return h(
                      'g',
                      { key: edge.id },
                      h('path', {
                        className: 'dsh-wf-edge-hit',
                        d: path,
                        onPointerDown: event => event.stopPropagation(),
                        onContextMenu: (event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          const host = canvasRef.current?.getBoundingClientRect()
                          setEdgeMenu({
                            id: edge.id,
                            x: event.clientX - (host?.left ?? 0),
                            y: event.clientY - (host?.top ?? 0),
                            label: `${byId.get(edge.from.node)?.title || edge.from.node} → ${byId.get(edge.to.node)?.title || edge.to.node}`,
                          })
                        },
                      }),
                      h('path', { className: 'dsh-wf-edge', d: path, style: { stroke, strokeWidth: 2.4 } }),
                    )
                  }),
                  link === null ? null : (() => {
                    const a = portPoint(link.from.node, link.from.port)
                    return h('path', {
                      className: 'dsh-wf-edge-live',
                      d: `M ${a.x} ${a.y} C ${a.x + 70} ${a.y}, ${link.x - 70} ${link.y}, ${link.x} ${link.y}`,
                    })
                  })(),
                ),
                workflow.nodes.length === 0
                  ? h('div', { className: 'dsh-wf-empty' }, h('strong', null, t('wfEmpty')), h('span', null, t('wfEmptyHint')))
                  : workflow.nodes.map(node => renderNode(node)),
              ),
          ),
        edgeMenu === null
          ? null
          : h(
            'div',
            {
              className: 'dsh-wf-menu',
              style: { left: Math.max(4, edgeMenu.x), top: Math.max(4, edgeMenu.y) },
              onPointerDown: event => event.stopPropagation(),
              onContextMenu: event => event.preventDefault(),
            },
            h('div', { className: 'dsh-wf-menu-title' }, edgeMenu.label ?? ''),
            h(Button, {
              label: t('wfDeleteEdge'),
              tone: 'danger',
              onClick: () => {
                removeEdge(edgeMenu.id)
                setEdgeMenu(null)
              },
            }),
            h(Button, { label: t('wfCancel'), onClick: () => setEdgeMenu(null) }),
          ),
        editingNode === undefined ? null : renderInspector(),
        h(
          'div',
          { className: 'dsh-wf-foot' },
          h('span', null, `${workflow?.nodes.length ?? 0} 节点 · ${workflow?.edges.length ?? 0} 连线 · ${view.k.toFixed(2)}×`),
          h('span', { className: 'dsh-wf-sp' }),
          h('span', null, t('wfHint')),
        ),
        sessionId === ''
          ? null
          : null,
        graphModal !== null ? renderGraphModal() : null,
        nodeLib.open ? renderNodeLib() : null,
      )
    }

    /* ---------------------------------------------------------------- *
     * MCP library button (composer tool row)
     * ---------------------------------------------------------------- */

    /** Styles for the composer button and its floating list. */
    const MCP_STYLES = `
      .ttl-mcp-wrap { position: relative; display: inline-flex; }
      .ttl-mcp-btn {
        display: inline-flex; align-items: center; gap: 5px;
        height: 26px; padding: 0 8px; border-radius: 7px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-layer-2, #f7f7f7);
        color: var(--dsw-alias-label-primary, #1f1f1f);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      .ttl-mcp-btn[aria-expanded="true"] {
        border-color: var(--dsw-alias-state-accent-primary, #4a6cf7);
        color: var(--dsw-alias-state-accent-primary, #4a6cf7);
      }
      .ttl-mcp-btn:disabled { opacity: .6; cursor: default; }
      .ttl-mcp-count {
        min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px;
        background: var(--dsw-alias-bg-layer-3, #e8e8e8);
        color: var(--dsw-alias-label-secondary, #6b6b6b);
        font-size: 10px; line-height: 15px; text-align: center;
      }
      .ttl-mcp-panel {
        position: fixed; z-index: 60; width: 372px; max-width: calc(100vw - 24px);
        max-height: min(60vh, 420px); overflow: hidden; display: flex; flex-direction: column;
        border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));
        background: var(--dsw-alias-bg-layer-1, #fff);
        color: var(--dsw-alias-label-primary, #1f1f1f);
        box-shadow: 0 14px 36px rgba(0,0,0,.18);
        font-size: 12px;
      }
      .ttl-mcp-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      .ttl-mcp-title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .ttl-mcp-title-text { font-weight: 600; font-size: 13px; }
      .ttl-mcp-title-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .ttl-mcp-hint { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .ttl-mcp-list { overflow: auto; padding: 4px; }
      .ttl-mcp-row {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
        padding: 7px 9px; border-radius: 8px;
      }
      .ttl-mcp-row:hover { background: var(--dsw-alias-bg-layer-2, #f4f4f4); }
      .ttl-mcp-id { font-weight: 600; font-size: 12px; }
      .ttl-mcp-cmd {
        font-size: 10px; color: var(--dsw-alias-label-secondary, #6b6b6b);
        margin-top: 2px; word-break: break-all; line-height: 1.35;
      }
      .ttl-mcp-pill {
        flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px; line-height: 16px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12));
        color: var(--dsw-alias-label-secondary, #6b6b6b);
        white-space: nowrap;
      }
      .ttl-mcp-pill[data-state="mounted"] { color: #1a7f37; border-color: rgba(26,127,55,.35); }
      .ttl-mcp-pill[data-state="mirrored"] { color: #8a6d00; border-color: rgba(138,109,0,.35); }
      .ttl-mcp-pill[data-state="pending"] { color: #b3541e; border-color: rgba(179,84,30,.35); }
      .ttl-mcp-pill[data-state="disabled"] { opacity: .75; }
      .ttl-mcp-foot {
        padding: 7px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        font-size: 10.5px; color: var(--dsw-alias-label-secondary, #6b6b6b);
        word-break: break-all; line-height: 1.4;
      }
      .ttl-mcp-err { color: var(--dsw-alias-state-error-primary, #c0392b); }
      .ttl-mcp-empty { padding: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
      .ttl-mcp-main { min-width: 0; flex: 1; }
      .ttl-mcp-actions { display: flex; align-items: center; gap: 8px; flex: none; }
      .ttl-mcp-section + .ttl-mcp-section { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      .ttl-mcp-section-head {
        padding: 8px 10px 4px; font-size: 10.5px; font-weight: 600;
        letter-spacing: .05em; color: var(--dsw-alias-label-secondary, #6b6b6b);
      }
      .ttl-mcp-switch {
        position: relative; flex: none; width: 30px; height: 16px; padding: 0;
        border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.2));
        background: var(--dsw-alias-bg-layer-3, #dcdcdc); cursor: pointer;
        transition: background .12s, border-color .12s;
      }
      .ttl-mcp-switch[aria-checked="true"] {
        background: #1a7f37; border-color: #1a7f37;
      }
      .ttl-mcp-switch[data-locked="true"] { opacity: .35; cursor: default; }
      .ttl-mcp-switch:disabled { cursor: default; }
      .ttl-mcp-knob {
        position: absolute; top: 1px; left: 1px; width: 12px; height: 12px;
        border-radius: 50%; background: #fff; transition: left .12s;
        box-shadow: 0 1px 2px rgba(0,0,0,.25);
      }
      .ttl-mcp-switch[aria-checked="true"] .ttl-mcp-knob { left: 15px; }
    `

    /** One composer button listing every MCP in the shared library. */
    function McpLibraryButton(props) {
      const t = props.t
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [busyId, setBusyId] = React.useState('')
      const [pos, setPos] = React.useState({ left: 0, bottom: 0 })
      const wrapRef = React.useRef(null)

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const payload = await call('library')
          setData(payload)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
          setData(null)
        } finally {
          setBusy(false)
        }
      }, [])

      const place = React.useCallback(() => {
        const node = wrapRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        setPos({ left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.top + 8) })
      }, [])

      const toggle = React.useCallback(() => {
        if (open) { setOpen(false); return }
        place()
        setOpen(true)
        void load()
      }, [open, place, load])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (wrapRef.current && wrapRef.current.contains(event.target)) return
          const panel = document.getElementById('dsh-mcp-library-panel')
          if (panel && panel.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, place])

      const servers = Array.isArray(data && data.mcp) ? data.mcp : []
      const mounted = Array.isArray(data && data.mounted) ? data.mounted : []
      const mirrored = Array.isArray(data && data.mirrored) ? data.mirrored : []
      const enabledCount = servers.filter(server => server.enabled !== false).length
      const loadedServers = servers.filter(server => mounted.indexOf(server.id) >= 0)
      const availableServers = servers.filter(server => mounted.indexOf(server.id) < 0)

      /** Status pill for one server. */
      const stateOf = (server) => {
        if (mirrored.indexOf(server.id) >= 0) return ['mirrored', t('mcpMirrored')]
        if (mounted.indexOf(server.id) >= 0) return ['mounted', t('mcpMounted')]
        if (server.enabled === false) return ['disabled', t('mcpDisabled')]
        return ['pending', t('mcpPending')]
      }

      const detailOf = (server) => {
        if (server.transport === 'streamable-http') return server.url || 'http'
        const args = Array.isArray(server.args) ? server.args.join(' ') : ''
        return `${server.command || ''}${args === '' ? '' : ` ${args}`}`.trim() || 'stdio'
      }

      /** Load or unload one library server; the Host remounts immediately. */
      const toggleServer = async (server) => {
        const isLoaded = mounted.indexOf(server.id) >= 0
        setBusyId(server.id)
        setError('')
        try {
          await call('library/mcp', { method: 'POST', body: { action: isLoaded ? 'disable' : 'enable', id: server.id } })
          await load()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusyId('')
        }
      }

      /** One row: identity, status, and a load/unload switch. */
      const rowOf = (server) => {
        const status = stateOf(server)
        const isMirrored = mirrored.indexOf(server.id) >= 0
        const isLoaded = mounted.indexOf(server.id) >= 0
        const isBusy = busyId === server.id
        return h('div', {
          key: server.id,
          className: 'ttl-mcp-row',
          'data-mcp-id': server.id,
          'data-state': status[0],
          'data-loaded': isLoaded ? 'true' : 'false',
        },
          h('div', { className: 'ttl-mcp-main' },
            h('div', { className: 'ttl-mcp-id' }, server.id),
            h('div', { className: 'ttl-mcp-cmd' }, `${server.transport || 'stdio'} · ${detailOf(server)}`),
          ),
          h('div', { className: 'ttl-mcp-actions' },
            h('span', { className: 'ttl-mcp-pill', 'data-state': status[0] }, status[1]),
            h('button', {
              type: 'button',
              className: 'ttl-mcp-switch',
              role: 'switch',
              'aria-checked': isLoaded,
              'aria-label': `${isLoaded ? t('mcpUnload') : t('mcpLoad')} ${server.id}`,
              'data-locked': isMirrored ? 'true' : 'false',
              disabled: isMirrored || isBusy,
              title: isMirrored ? t('mcpProfileOwned') : (isLoaded ? t('mcpUnload') : t('mcpLoad')),
              onClick: () => { if (!isMirrored && !isBusy) void toggleServer(server) },
            }, h('span', { className: 'ttl-mcp-knob' })),
          ),
        )
      }

      return h('div', { className: 'ttl-mcp-wrap', ref: wrapRef, 'data-dsh-mcp-library': 'button' },
        h('style', null, MCP_STYLES),
        h('button', {
          type: 'button',
          className: 'ttl-mcp-btn',
          'aria-expanded': open,
          title: t('mcpLibraryHint'),
          onClick: toggle,
        },
          h('span', null, t('mcpLibrary')),
          h('span', { className: 'ttl-mcp-count' }, String(data ? servers.length : '')),
        ),
        open ? h('div', {
          className: 'ttl-mcp-panel',
          id: 'dsh-mcp-library-panel',
          'data-dsh-mcp-library': 'panel',
          style: { left: pos.left + 'px', bottom: pos.bottom + 'px' },
        },
          h('div', { className: 'ttl-mcp-head' },
            h('div', { className: 'ttl-mcp-title' },
              h('span', { className: 'ttl-mcp-title-text' }, t('mcpLibraryHint')),
              h('span', { className: 'ttl-mcp-title-meta' }, data ? `${loadedServers.length} ${t('mcpLoaded')} / ${availableServers.length} ${t('mcpAvailable')}` : (busy ? t('mcpLoading') : '')),
            ),
            h('div', { className: 'ttl-mcp-hint' }, data ? `${enabledCount}/${servers.length} ${t('mcpEnabled')}` : ''),
          ),
          h('div', { className: 'ttl-mcp-list' },
            error ? h('div', { className: 'ttl-mcp-empty ttl-mcp-err' }, `${t('mcpFailed')}: ${error}`) : null,
            !error && data === null ? h('div', { className: 'ttl-mcp-empty' }, t('mcpLoading')) : null,
            !error && data !== null && servers.length === 0 ? h('div', { className: 'ttl-mcp-empty' }, `${t('mcpEmpty')} · ${t('mcpRoot')}: ${String(data.root || '')}`) : null,
            !error && servers.length > 0 ? h('div', { className: 'ttl-mcp-section', 'data-section': 'loaded' },
              h('div', { className: 'ttl-mcp-section-head' }, `${t('mcpLoaded')} · ${loadedServers.length}`),
              loadedServers.length === 0
                ? h('div', { className: 'ttl-mcp-empty' }, t('mcpNoneLoaded'))
                : loadedServers.map(rowOf),
            ) : null,
            !error && servers.length > 0 ? h('div', { className: 'ttl-mcp-section', 'data-section': 'available' },
              h('div', { className: 'ttl-mcp-section-head' }, `${t('mcpAvailable')} · ${availableServers.length}`),
              availableServers.length === 0
                ? h('div', { className: 'ttl-mcp-empty' }, t('mcpAllLoaded'))
                : availableServers.map(rowOf),
            ) : null,
          ),
          h('div', { className: 'ttl-mcp-foot' },
            h('div', null, `${t('mcpRoot')}: ${String((data && data.root) || '')}`),
            busy ? h('div', null, t('mcpLoading')) : null,
          ),
        ) : null,
      )
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'sidebarRightTabs', 'locale'],
      apply(ctx) {
        const dictionaries = { en: EN, zh: ZH }
        let translate = key => ZH[key] ?? EN[key] ?? key
        try {
          ctx.locale.register(NS, dictionaries)
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') translate = key => bound(key) ?? ZH[key] ?? EN[key] ?? key
          else {
            const locale = typeof ctx.locale.getLocale === 'function' ? ctx.locale.getLocale() : undefined
            const id = String(locale?.id ?? locale ?? '')
            translate = key => (id.startsWith('zh') ? ZH[key] : EN[key]) ?? key
          }
        } catch {
          /* keep the built-in fallback table */
        }
        const t = key => {
          try {
            const value = translate(key)
            return typeof value === 'string' && value !== '' ? value : (ZH[key] ?? EN[key] ?? key)
          } catch {
            return ZH[key] ?? EN[key] ?? key
          }
        }

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => t('tabTitle'),
          guide: [
            {
              id: TAB_KIND,
              order: 60,
              title: () => t('guideTitle'),
              description: () => t('guideDesc'),
            },
          ],
        }), 'thinking-tree: tab type')

        // The workflow canvas is a second tab in the same right Sidebar. It has
        // its own route family and its own store, so the chain panel keeps its
        // polling and editing behavior untouched.
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: WF_ID,
          kind: WF_KIND,
          title: () => t('wfTitle'),
          guide: [
            {
              id: WF_KIND,
              order: 61,
              title: () => t('wfTitle'),
              description: () => t('wfHint'),
            },
          ],
        }), 'thinking-tree: workflow tab type')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          props => h(PanelBoundary, { title: t('crashTitle') }, h(TreePanel, { ...props, t, ctx })),
        )), 'thinking-tree: panel body')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: WF_ID },
          props => h(PanelBoundary, { title: t('crashTitle') }, h(WorkflowPanel, { ...props, t, ctx })),
        )), 'thinking-tree: workflow panel body')

        ctx.effect(() => mountEdgeButton(ctx, t), 'thinking-tree: edge button')

        // The composer tool row gets one button that answers "which MCP servers
        // do I have right now?" without opening a settings page.
        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'mcp-library-button', order: 40, label: () => t('mcpLibrary') },
          props => h(McpLibraryButton, { ...props, t }),
        )), 'thinking-tree: mcp library button')
      },
    }
  },
})
