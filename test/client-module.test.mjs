/**
 * The browser half must evaluate and register the composer button.
 *
 * The module is a classic script that hands its factory to
 * `window.__ModuleLoader__`; running it in a bare VM with a stubbed React and a
 * fake client context is enough to prove the module parses, its plugin shape is
 * intact, and the `conversation.input.left` entry is registered — without a
 * browser, a token, or a rebuilt bundle.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const results = []
const check = (name, pass, detail) => results.push({ name, pass, detail })

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

let definition
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: {
    __ModuleLoader__: {
      load: (loaded) => { definition = loaded },
    },
  },
}
vm.createContext(sandbox)
let loadError = ''
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
} catch (error) {
  loadError = String(error?.stack ?? error)
}

check('client.js evaluates without a DOM', loadError === '' && definition !== undefined, { loadError: loadError.slice(0, 400) })

/** Minimal React stand-in: only `createElement` shape matters at registration. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(update) { this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) } }
    render() { return null }
  },
  PureComponent: class PureComponent {
    constructor(props) { this.props = props }
    render() { return null }
  },
  useState: value => [typeof value === 'function' ? value() : value, () => undefined],
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useMemo: factory => factory(),
  useCallback: callback => callback,
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  memo: component => component,
  createContext: value => ({ Provider: 'provider', Consumer: 'consumer', value }),
  useContext: () => undefined,
  forwardRef: component => component,
}

let plugin
try {
  plugin = definition.factory(id => {
    if (id === 'react') return React
    throw new Error(`unexpected require(${id})`)
  })
} catch (error) {
  check('the factory builds a plugin', false, { error: String(error?.message ?? error) })
}

if (plugin !== undefined) {
  check('the factory builds a plugin', typeof plugin?.apply === 'function' && Array.isArray(plugin.inject), {
    inject: plugin?.inject,
  })
  check('the plugin injects the slot registry', plugin.inject.includes('slots'), { inject: plugin.inject })
}

const registrations = []
const translators = []
const fakeCtx = {
  effect: fn => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => undefined },
  get: () => undefined,
  locale: {
    register: () => undefined,
    bind: () => (key) => {
      translators.push(key)
      return key === 'mcpLibrary' ? 'MCP' : key
    },
  },
  sidebarRightTabs: { register: () => () => undefined },
  slots: {
    inject: (slotName, factory) => { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => undefined },
    register: (options, render) => {
      registrations.push({ options, render })
      return () => undefined
    },
  },
}

let applyError = ''
try {
  plugin.apply(fakeCtx)
} catch (error) {
  applyError = String(error?.stack ?? error)
}

check('apply() runs against a client context', applyError === '', { applyError: applyError.slice(0, 400) })
check('the composer holds the MCP button', registrations.some(entry => entry.options?.name === 'conversation.input.left' && entry.options?.id === 'mcp-library-button'), {
  registered: registrations.map(entry => `${entry.options?.name}#${entry.options?.id ?? entry.options?.key ?? ''}`),
})
const button = registrations.find(entry => entry.options?.id === 'mcp-library-button')
check('the button sits beside the shipped composer controls', button?.options?.order === 40, { order: button?.options?.order })
check('its label is the localized MCP title', button?.options?.label?.() === 'MCP', { label: button?.options?.label?.() })
check('its renderer is a component thunk', typeof button?.render === 'function', { render: typeof button?.render })

const failed = results.filter(result => !result.pass)
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results: failed }, null, 1))
process.exitCode = failed.length === 0 ? 0 : 1