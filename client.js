/**
 * Browser half of the thinking-tree bundle.
 *
 * Two surfaces, one state:
 *
 * - A pill on the right edge of the window, mounted as plain DOM on
 *   `document.body` so `position: fixed` reaches the real viewport.
 * - The `thinking-tree` tab type of the right Sidebar, which is the panel.
 *
 * The tree itself lives on disk (`<workspace>/thinking-tree/*.md`). This module
 * only renders it and writes it back through the Host's JSON routes, so the
 * panel and the agent always read the same files. The panel re-reads the folder
 * while it is visible, which is what makes it update live while the agent works.
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

    const EN = {
      tabTitle: 'Thinking tree',
      guideTitle: 'Thinking tree',
      guideDesc: 'Goal, approach, and steps as editable Markdown files',
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
      expand: 'Expand',
      collapse: 'Collapse',
      goal: 'Goal',
      approach: 'Approach',
      step: 'Step',
      loading: 'Reading the chain…',
      folder: 'folder',
      noSession: 'No session on screen',
      saving: 'Saving…',
      fail: 'Failed',
      statusPending: 'Pending',
      statusActive: 'In progress',
      statusDone: 'Done',
      statusBlocked: 'Blocked',
      chars: 'chars',
    }

    const ZH = {
      tabTitle: '思考链',
      guideTitle: '思考链',
      guideDesc: '目标、路线、步骤，每个块都是一份可编辑的 Markdown',
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
      expand: '展开',
      collapse: '收起',
      goal: '目标',
      approach: '路线',
      step: '步骤',
      loading: '正在读取思考链…',
      folder: '文件夹',
      noSession: '当前没有会话',
      saving: '保存中…',
      fail: '失败',
      statusPending: '待办',
      statusActive: '进行中',
      statusDone: '完成',
      statusBlocked: '受阻',
      chars: '字符',
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
      if (settings.signal !== undefined) init.signal = settings.signal
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
     * Markdown: a small inline renderer for node bodies
     * ---------------------------------------------------------------- */

    /**
     * Render inline Markdown (code, bold, italic, links).
     * @param {string} text - one line or paragraph.
     * @param {string} key - React key prefix.
     * @returns {Array} React children.
     */
    function inline(text, key) {
      const parts = []
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g
      let cursor = 0
      let match
      let index = 0
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) parts.push(text.slice(cursor, match.index))
        const token = match[0]
        const id = `${key}-${index}`
        index += 1
        if (token.startsWith('`')) parts.push(h('code', { key: id, className: 'dsh-tt-code' }, token.slice(1, -1)))
        else if (token.startsWith('**')) parts.push(h('strong', { key: id }, token.slice(2, -2)))
        else if (token.startsWith('*')) parts.push(h('em', { key: id }, token.slice(1, -1)))
        else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          parts.push(h('a', { key: id, className: 'dsh-tt-link', href: link ? link[2] : '#', target: '_blank', rel: 'noreferrer' }, link ? link[1] : token))
        }
        cursor = match.index + token.length
      }
      if (cursor < text.length) parts.push(text.slice(cursor))
      return parts
    }

    /**
     * Render a node body as block elements.
     * @param {string} source - Markdown body.
     * @returns {Array} React elements.
     */
    function renderMarkdown(source) {
      const lines = String(source || '').replace(/\r\n/g, '\n').split('\n')
      const out = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (line.startsWith('```')) {
          const code = []
          index += 1
          while (index < lines.length && !lines[index].startsWith('```')) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          out.push(h('pre', { key: `pre-${index}`, className: 'dsh-tt-pre' }, h('code', null, code.join('\n'))))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          out.push(h('div', { key: `h-${index}`, className: `dsh-tt-h dsh-tt-h${heading[1].length}` }, inline(heading[2], `h${index}`)))
          index += 1
          continue
        }
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
            items.push(h('li', { key: `li-${index}` }, inline(lines[index].replace(/^\s*[-*+]\s+/, ''), `li${index}`)))
            index += 1
          }
          out.push(h('ul', { key: `ul-${index}`, className: 'dsh-tt-list' }, items))
          continue
        }
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
            items.push(h('li', { key: `oli-${index}` }, inline(lines[index].replace(/^\s*\d+[.)]\s+/, ''), `oli${index}`)))
            index += 1
          }
          out.push(h('ol', { key: `ol-${index}`, className: 'dsh-tt-list' }, items))
          continue
        }
        if (/^>\s?/.test(line)) {
          const quoted = []
          while (index < lines.length && /^>\s?/.test(lines[index])) {
            quoted.push(lines[index].replace(/^>\s?/, ''))
            index += 1
          }
          out.push(h('blockquote', { key: `bq-${index}`, className: 'dsh-tt-quote' }, inline(quoted.join(' '), `bq${index}`)))
          continue
        }
        if (line.trim() === '') {
          index += 1
          continue
        }
        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|>)/.test(lines[index])) {
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length > 0) out.push(h('p', { key: `p-${index}`, className: 'dsh-tt-p' }, inline(paragraph.join(' '), `p${index}`)))
      }
      return out
    }

    /* ---------------------------------------------------------------- *
     * Styles
     * ---------------------------------------------------------------- */

    const CSS = `
.dsh-tt-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dsh-tt-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dsh-tt-head-title{font-weight:600;font-size:12px;letter-spacing:.02em}
.dsh-tt-head-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;direction:rtl;text-align:left}
.dsh-tt-btn{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer;font-size:11px;padding:3px 7px;font-family:inherit;transition:background .12s,color .12s}
.dsh-tt-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-tt-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent;padding:5px 12px;font-weight:600}
.dsh-tt-btn-primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary);color:#fff}
.dsh-tt-btn:disabled{opacity:.45;cursor:default}
.dsh-tt-scroll{overflow-y:auto;overflow-x:hidden;padding:10px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}
.dsh-tt-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:8px 10px;position:relative}
.dsh-tt-card-goal{border-left:3px solid var(--dsw-alias-brand-primary)}
.dsh-tt-card-approach{border-left:2px solid var(--dsw-alias-border-l2)}
.dsh-tt-card-step{border-left:2px solid transparent;background:var(--dsw-alias-bg-layer-2)}
.dsh-tt-row{display:flex;align-items:flex-start;gap:6px}
.dsh-tt-dot{width:9px;height:9px;border-radius:50%;border:none;padding:0;margin-top:5px;flex:none;cursor:pointer;background:var(--dsw-alias-state-idle-primary)}
.dsh-tt-dot[data-status=active]{background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.dsh-tt-dot[data-status=done]{background:var(--dsw-alias-state-success-primary)}
.dsh-tt-dot[data-status=blocked]{background:var(--dsw-alias-state-error-primary)}
.dsh-tt-title{flex:1;min-width:0;font-weight:600;word-break:break-word;cursor:text;font-size:12.5px}
.dsh-tt-card-goal .dsh-tt-title{font-size:13.5px}
.dsh-tt-kind{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;flex:none;margin-top:2px}
.dsh-tt-actions{display:flex;gap:1px;opacity:0;transition:opacity .12s;flex:none}
.dsh-tt-card:hover .dsh-tt-actions,.dsh-tt-card:focus-within .dsh-tt-actions{opacity:1}
.dsh-tt-body{margin-top:5px;padding-left:15px;color:var(--dsw-alias-label-primary);opacity:.94;word-break:break-word;overflow:hidden}
.dsh-tt-body.clip{max-height:132px;mask-image:linear-gradient(180deg,#000 78%,transparent)}
.dsh-tt-p{margin:3px 0}
.dsh-tt-h{font-weight:600;margin:6px 0 2px}
.dsh-tt-h1{font-size:13px}.dsh-tt-h2{font-size:12.5px}.dsh-tt-h3,.dsh-tt-h4,.dsh-tt-h5,.dsh-tt-h6{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-tt-list{margin:3px 0;padding-left:17px}
.dsh-tt-list li{margin:1px 0}
.dsh-tt-code{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.dsh-tt-pre{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;margin:4px 0;white-space:pre}
.dsh-tt-quote{margin:4px 0;padding-left:8px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-tt-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
.dsh-tt-more{background:none;border:none;color:var(--dsw-alias-label-secondary);font-size:10.5px;cursor:pointer;padding:1px 0 0 15px;font-family:inherit}
.dsh-tt-more:hover{color:var(--dsw-alias-label-primary)}
.dsh-tt-children{display:flex;flex-direction:column;gap:6px;margin-top:7px;padding-left:13px;border-left:1px dashed var(--dsw-alias-border-l1)}
.dsh-tt-editor{width:100%;box-sizing:border-box;min-height:130px;resize:vertical;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;margin-top:6px}
.dsh-tt-editor:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-tt-editrow{display:flex;gap:6px;align-items:center;margin-top:6px}
.dsh-tt-input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;font-size:12px;font-family:inherit}
.dsh-tt-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-tt-empty{display:flex;flex-direction:column;gap:8px;padding:16px 4px;color:var(--dsw-alias-label-secondary);align-items:flex-start}
.dsh-tt-empty strong{color:var(--dsw-alias-label-primary);font-size:13px}
.dsh-tt-error{color:var(--dsw-alias-state-error-primary);font-size:11.5px;padding:2px 0}
`

    /* ---------------------------------------------------------------- *
     * Small components
     * ---------------------------------------------------------------- */

    /**
     * A button that renders as a quiet text control.
     * @param {object} props - label, onClick, disabled, primary, title.
     * @returns {object} React element.
     */
    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-tt-btn${props.primary ? ' dsh-tt-btn-primary' : ''}`,
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
     * The component-local stylesheet, rendered by every component that needs it.
     * @returns {object} React element.
     */
    function Styles() {
      return h('style', null, CSS)
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
    function mountEdgeButton(ctx, t) {
      if (typeof document === 'undefined' || document.body === null) return () => undefined
      for (const stale of Array.from(document.querySelectorAll('[data-dsh-thinking-tree="host"]'))) stale.remove()

      const host = document.createElement('div')
      host.setAttribute('data-dsh-thinking-tree', 'host')
      host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:60;display:flex;align-items:center;justify-content:flex-end'

      // Focus ring only: everything else on the pill is inline, so it survives
      // whatever the host does to its own stylesheets.
      const sheet = document.createElement('style')
      sheet.textContent = '[data-dsh-thinking-tree="edge"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'

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
        'transition:background .14s,color .14s,padding-right .14s',
      ].join(';')
      button.innerHTML = [
        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
        '<path d="M4 2.5v11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
        '<path d="M4 5.5h4.2a1.8 1.8 0 0 1 0 3.6H6.4a1.8 1.8 0 0 0 0 3.6H12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
        '<circle cx="12.2" cy="5.5" r="1.5" fill="currentColor"/>',
        '</svg>',
        '<span style="writing-mode:vertical-rl;font-size:10.5px;letter-spacing:.16em;line-height:1"></span>',
      ].join('')
      const label = button.querySelector('span')
      if (label !== null) label.textContent = t('tabTitle')

      const enter = () => {
        button.style.background = 'var(--dsw-alias-bg-layer-2)'
        button.style.color = 'var(--dsw-alias-label-primary)'
        button.style.paddingRight = '8px'
      }
      const leave = () => {
        button.style.background = 'var(--dsw-alias-bg-layer-1)'
        button.style.color = 'var(--dsw-alias-label-secondary)'
        button.style.paddingRight = '5px'
      }
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
      button.addEventListener('mouseenter', enter)
      button.addEventListener('mouseleave', leave)
      button.addEventListener('click', click)

      host.appendChild(button)
      document.body.appendChild(sheet)
      document.body.appendChild(host)
      return () => {
        button.removeEventListener('mouseenter', enter)
        button.removeEventListener('mouseleave', leave)
        button.removeEventListener('click', click)
        host.remove()
        sheet.remove()
      }
    }

    /* ---------------------------------------------------------------- *
     * Tree panel
     * ---------------------------------------------------------------- */

    /**
     * One node card, with its children nested below it.
     * @param {object} props - node, depth, panel state and handlers.
     * @returns {object} React element.
     */
    function NodeCard(props) {
      const { node, depth, t, editing, onEdit, onCancel, onSave, onStatus, onAddChild, onDelete, busy } = props
      const [expanded, setExpanded] = React.useState(false)
      const [adding, setAdding] = React.useState(false)
      const [draftTitle, setDraftTitle] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const isEditing = editing === node.name
      const kind = depth === 0 ? t('goal') : depth === 1 ? t('approach') : t('step')
      const long = String(node.body || '').split('\n').length > 6 || String(node.body || '').length > 320

      React.useEffect(() => {
        if (isEditing) setDraft(node.body)
      }, [isEditing, node.body])

      React.useEffect(() => {
        if (!confirming) return undefined
        const timer = setTimeout(() => setConfirming(false), 4000)
        return () => clearTimeout(timer)
      }, [confirming])

      const commitTitle = () => {
        const value = draftTitle.trim()
        setAdding(false)
        setDraftTitle('')
        if (value !== '') onAddChild(node, value)
      }

      return h(
        'div',
        { className: `dsh-tt-card dsh-tt-card-${depth === 0 ? 'goal' : depth === 1 ? 'approach' : 'step'}`, 'data-node': node.name },
        h(
          'div',
          { className: 'dsh-tt-row' },
          h('button', {
            type: 'button',
            className: 'dsh-tt-dot',
            'data-status': node.status,
            title: t(`status${node.status.charAt(0).toUpperCase()}${node.status.slice(1)}`),
            'aria-label': t(`status${node.status.charAt(0).toUpperCase()}${node.status.slice(1)}`),
            onClick: () => onStatus(node),
          }),
          h('span', { className: 'dsh-tt-title', title: node.name, onDoubleClick: () => onEdit(node) }, node.title || node.name),
          h('span', { className: 'dsh-tt-kind' }, kind),
          h(
            'span',
            { className: 'dsh-tt-actions' },
            h(Button, { label: '＋', title: t('addChild'), onClick: () => setAdding(value => !value) }),
            h(Button, { label: '✎', title: t('edit'), onClick: () => onEdit(node) }),
            h(Button, {
              label: '🗑',
              title: confirming ? t('confirmRemove') : t('remove'),
              onClick: () => {
                if (confirming) {
                  setConfirming(false)
                  onDelete(node)
                } else {
                  setConfirming(true)
                }
              },
            }),
          ),
        ),
        isEditing
          ? h(
            'div',
            null,
            h('textarea', {
              className: 'dsh-tt-editor',
              value: draft,
              spellCheck: false,
              onChange: event => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') onCancel()
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSave(node, draft)
              },
            }),
            h(
              'div',
              { className: 'dsh-tt-editrow' },
              h(Button, { label: busy ? t('saving') : t('save'), primary: true, disabled: busy, onClick: () => onSave(node, draft) }),
              h(Button, { label: t('cancel'), onClick: onCancel }),
              h('span', { className: 'dsh-tt-head-path' }, `${String(draft.length)} ${t('chars')} · ${node.name}`),
            ),
          )
          : node.body && node.body.trim() !== ''
            ? h(
              'div',
              { className: `dsh-tt-body${long && !expanded ? ' clip' : ''}` },
              renderMarkdown(node.body),
            )
            : null,
        long && !isEditing
          ? h('button', { type: 'button', className: 'dsh-tt-more', onClick: () => setExpanded(value => !value) }, expanded ? t('collapse') : t('expand'))
          : null,
        adding
          ? h(
            'div',
            { className: 'dsh-tt-editrow' },
            h('input', {
              className: 'dsh-tt-input',
              value: draftTitle,
              autoFocus: true,
              placeholder: t('addChildPlaceholder'),
              onChange: event => setDraftTitle(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') commitTitle()
                if (event.key === 'Escape') {
                  setAdding(false)
                  setDraftTitle('')
                }
              },
            }),
            h(Button, { label: t('addChild'), primary: true, disabled: draftTitle.trim() === '', onClick: commitTitle }),
            h(Button, { label: t('cancel'), onClick: () => { setAdding(false); setDraftTitle('') } }),
          )
          : null,
        node.childNodes && node.childNodes.length > 0
          ? h(
            'div',
            { className: 'dsh-tt-children' },
            node.childNodes.map(child => h(NodeCard, { key: child.name, ...props, node: child, depth: depth + 1 })),
          )
          : null,
      )
    }

    /**
     * The right-Sidebar body: header, live tree, editing.
     * @param {object} props - `{ sessionId, t }` plus the framework's own props.
     * @returns {object} React element.
     */
    function TreePanel(props) {
      const { t } = props
      const sessionId = props.sessionId || props.session?.id || props.session?.sessionId || ''
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [editing, setEditing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [goalDraft, setGoalDraft] = React.useState('')
      const signature = React.useRef('')
      const editingRef = React.useRef(null)
      editingRef.current = editing

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
          if (editingRef.current !== null) return
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
      const roots = data === null ? [] : data.roots.map(id => byId.get(id)).filter(node => node !== undefined)
      // A hand-edited `parent` cycle would otherwise recurse forever.
      const attach = (node, seen) => ({
        ...node,
        childNodes: (node.children || [])
          .filter(id => !seen.has(id))
          .map(id => byId.get(id))
          .filter(child => child !== undefined)
          .map(child => attach(child, new Set([...seen, child.id]))),
      })
      const tree = roots.map(node => attach(node, new Set([node.id])))
      const total = data === null ? 0 : data.nodes.length

      const handlers = {
        t,
        editing,
        busy,
        onEdit: node => setEditing(node.name),
        onCancel: () => setEditing(null),
        onSave: async (node, draft) => {
          await mutate('save', { name: node.name, content: draft })
          setEditing(null)
        },
        onStatus: node => {
          const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(node.status) + 1) % STATUS_CYCLE.length]
          void mutate('status', { name: node.name, status: next })
        },
        onAddChild: (node, title) => mutate('create', { parent: node.id, title }),
        onDelete: node => mutate('delete', { name: node.name, cascade: true }),
      }

      const createGoal = async () => {
        const title = goalDraft.trim() === '' ? t('goal') : goalDraft.trim()
        await mutate('create', { parent: '', title })
        setGoalDraft('')
      }

      return h(
        'div',
        { className: 'dsh-tt-root', 'data-dsh-thinking-tree': 'panel' },
        h(Styles),
        h(
          'div',
          { className: 'dsh-tt-head' },
          h('span', { className: 'dsh-tt-head-title' }, t('tabTitle')),
          h('span', { className: 'dsh-tt-head-path', title: data?.absolute || '' },
            data === null ? '' : `${data.folder}/ · ${total}`),
          h(Button, { label: '⟳', title: t('refresh'), onClick: () => void load(true) }),
        ),
        h(
          'div',
          { className: 'dsh-tt-scroll' },
          sessionId === '' ? h('div', { className: 'dsh-tt-empty' }, h('strong', null, t('noSession'))) : null,
          state.error !== null ? h('div', { className: 'dsh-tt-error' }, `${t('fail')}: ${state.error}`) : null,
          state.loading && data === null ? h('div', { className: 'dsh-tt-empty' }, t('loading')) : null,
          sessionId !== '' && data !== null && tree.length === 0
            ? h(
              'div',
              { className: 'dsh-tt-empty' },
              h('strong', null, t('empty')),
              h('span', null, t('emptyHint')),
              h(
                'div',
                { className: 'dsh-tt-editrow', style: { width: '100%' } },
                h('input', {
                  className: 'dsh-tt-input',
                  value: goalDraft,
                  placeholder: t('goalPlaceholder'),
                  onChange: event => setGoalDraft(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') void createGoal() },
                }),
                h(Button, { label: t('create'), primary: true, disabled: busy, onClick: () => void createGoal() }),
              ),
            )
            : null,
          tree.map(node => h(NodeCard, { key: node.name, ...handlers, node, depth: 0 })),
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

        // `sessionId` is a standard prop of this seat, so nothing is injected:
        // the body only needs the translator, which the closure already owns.
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_ID },
          (props) => h(TreePanel, { ...props, t }),
        )), 'thinking-tree: panel body')

        ctx.effect(() => mountEdgeButton(ctx, t), 'thinking-tree: edge button')
      },
    }
  },
})