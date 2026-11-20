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
      newNode: 'New node',
      addHint: 'Add a child block',
      deleteHint: 'Delete this block and its subtree',
      expandText: 'Show the whole text',
      collapseText: 'Collapse',
      arrange: 'Auto layout',
      moved: 'Moved',
    }

    const ZH = {
      tabTitle: '思考链',
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
      newNode: '新节点',
      addHint: '加子节点',
      deleteHint: '删除这个块及其子树',
      expandText: '展开全文',
      collapseText: '收起',
      arrange: '自动排列',
      moved: '已移动',
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
        const title = wrapText(node.title || node.name, size, titleBudget, isOpen ? 8 : 2)
        const rawSubtitle = depth <= 1 ? subtitleOf(node.body) : ''
        const sub = rawSubtitle === ''
          ? { lines: [], truncated: false }
          : wrapText(rawSubtitle, 10.5, budget, isOpen ? 4 : 1)
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
.dsh-tt-btn:disabled{opacity:.45;cursor:default}
.dsh-tt-canvas{position:relative;flex:1;min-height:0;overflow:auto;cursor:grab;background:
  radial-gradient(circle at 1px 1px, var(--dsw-alias-border-l1) 1px, transparent 0) 0 0/18px 18px}
.dsh-tt-canvas.dragging{cursor:grabbing}
.dsh-tt-canvas svg{display:block;user-select:none}
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

    /**
     * The in-header entry point: a normal slot button the shell always paints.
     * @param {object} props - `{ ctx, t }`.
     * @returns {object} React element.
     */
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
              event.stopPropagation()
              onSelect(box.node.name)
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
        { width: width * zoom, height: height * zoom, viewBox: `0 0 ${width} ${height}`, role: 'img' },
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
      if (data !== null) for (const node of data.nodes) byId.set(node.id, node)
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
      const movedRef = React.useRef(moved)
      movedRef.current = moved
      const mutateRef = React.useRef(mutate)
      mutateRef.current = mutate
      const zoomLevel = React.useRef(zoom)
      zoomLevel.current = zoom
      const beginNodeDrag = (name, event) => {
        const box = map.boxes.find(entry => entry.node.name === name)
        if (box === undefined) return
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
          setTimeout(() => { dragged.current = false }, 0)
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
      const selectedNode = selected === null ? undefined : byId.get(selected)

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
      React.useEffect(() => {
        const canvas = canvasRef.current
        if (canvas === null) return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const current = zoomRef.current
          const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
          const next = Math.min(2.2, Math.max(0.35, Number((current * factor).toFixed(3))))
          if (next === current) return
          const rect = canvas.getBoundingClientRect()
          const anchorX = event.clientX - rect.left
          const anchorY = event.clientY - rect.top
          const worldX = (canvas.scrollLeft + anchorX) / current
          const worldY = (canvas.scrollTop + anchorY) / current
          setZoom(next)
          requestAnimationFrame(() => {
            const live = canvasRef.current
            if (live === null) return
            live.scrollLeft = worldX * next - anchorX
            live.scrollTop = worldY * next - anchorY
          })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [showEmpty, sessionId])

      return h(
        'div',
        { className: 'dsh-tt-root', 'data-dsh-thinking-tree': 'panel' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-tt-head' },
          h('span', { className: 'dsh-tt-head-title' }, t('tabTitle')),
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
                : h(MindMap, {
                  boxes: map.boxes,
                  links: map.links,
                  width: map.width,
                  height: map.height,
                  zoom,
                  selected,
                  onSelect: (name) => {
                    // A drag ends with a click on the same block; that one is a move, not a selection.
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

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          props => h(PanelBoundary, { title: t('crashTitle') }, h(TreePanel, { ...props, t })),
        )), 'thinking-tree: panel body')

        ctx.effect(() => mountEdgeButton(ctx, t), 'thinking-tree: edge button')
      },
    }
  },
})