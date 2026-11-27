import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyComfyParams,
  buildSystemPrompt,
  comfyInputTargets,
  emptyWorkflow,
  getRun,
  graphFromApi,
  graphFromUi,
  loadComfyGraph,
  normalizeWorkflow,
  parseExchange,
  readLatestUserText,
  promptFields,
  resetWorkflowState,
  runModelNode,
  startRun,
  topoOrder,
  uiToApi,
  userMessage,
} from '../workflow.js'

/**
 * One scripted reply: either a text answer or one tool call followed by text.
 * @param {{ text?: string, call?: { id: string, name: string, arguments: string } }} script
 * @returns an async generator shaped like the LLM stream.
 */
function scriptedStream(script) {
  return (async function* () {
    if (script.call !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: script.call.id, name: script.call.name, argumentsDelta: script.call.arguments }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: script.call.id, name: script.call.name, arguments: script.call.arguments } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = script.text ?? ''
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

test('normalizeWorkflow keeps valid nodes and drops dangling edges', () => {
  const workflow = normalizeWorkflow({
    id: 'main',
    title: 'x',
    nodes: [
      { id: 'a', type: 'model', provider: 'p', model: 'm', tools: ['t', 't'], prompt: 'hi' },
      { id: 'b', type: 'exchange', mode: 'fanout' },
      { id: 'a', type: 'model' },
      { id: 'c', type: 'nope' },
    ],
    edges: [
      { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
      { id: 'e2', from: { node: 'a', port: 'out' }, to: { node: 'missing', port: 'in' } },
      { id: 'e3', from: { node: 'b', port: 'out' }, to: { node: 'b', port: 'in' } },
    ],
  })
  assert.equal(workflow.nodes.length, 3)
  assert.deepEqual(workflow.nodes[0].tools, ['t'])
  assert.equal(workflow.nodes[2].type, 'model')
  assert.deepEqual(workflow.edges.map(edge => edge.id), ['e1'])
})

test('emptyWorkflow is a valid empty graph', () => {
  const workflow = emptyWorkflow()
  assert.equal(workflow.nodes.length, 0)
  assert.equal(workflow.edges.length, 0)
  assert.equal(workflow.version, 1)
})

test('topoOrder respects edges and rejects cycles', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const order = topoOrder(nodes, [
    { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
    { from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'exchange' } },
  ])
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.throws(() => topoOrder(nodes, [
    { from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
    { from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } },
  ]), /cycle/)
})

test('buildSystemPrompt composes the node prompt, skill body, and MCP tools', () => {
  const system = buildSystemPrompt(
    { prompt: '你是写手', tools: ['read', 'mcp__blender__render'] },
    {
      skills: [{ name: 'style', content: 'SKILL BODY' }],
      mcpTools: new Map([['blender', [{ name: 'mcp__blender__render' }]]]),
    },
  )
  assert.match(system, /你是写手/)
  assert.match(system, /SKILL BODY/)
  assert.match(system, /【MCP 服务 · 每轮加载】/)
  assert.match(system, /mcp__blender__render/)
  assert.match(system, /【可用工具】/)
})

test('runModelNode executes one tool call inside a private message array', async () => {
  const requests = []
  const executions = []
  const llm = {
    stream(options) {
      requests.push(options)
      return requests.length === 1
        ? scriptedStream({ call: { id: 'call-1', name: 'read', arguments: '{"path":"x"}' } })
        : scriptedStream({ text: 'done' })
    },
  }
  const tools = {
    async execute(input) {
      executions.push(input)
      return {
        results: input.calls.map(call => ({ callId: call.id, result: { content: [{ type: 'text', text: 'tool-ok' }], isError: false } })),
        additionalContexts: [],
        concluded: false,
      }
    },
  }
  const result = await runModelNode({
    llm,
    tools,
    agent: undefined,
    node: { provider: 'p', model: 'm', reasoningEffort: '', prompt: 'node', tools: ['read'] },
    system: 'SYS',
    userText: 'do it',
    toolSchemas: [{ name: 'read', description: 'read', parameters: {} }],
    signal: new AbortController().signal,
  })
  assert.equal(result.text, 'done')
  assert.equal(executions.length, 1)
  assert.equal(result.messages[0].role, 'user')
  assert.equal(result.messages[1].role, 'assistant')
  assert.equal(result.messages[2].role, 'tool')
  assert.equal(result.messages[2].toolCallId, 'call-1')
  assert.equal(result.messages[3].content[0].text, 'done')
  // The tool result travels in the same node's private history only.
  assert.match(result.messages[2].content[0].text, /tool-ok/)
})

test('parseExchange maps a model reply onto known target nodes', () => {
  const parsed = parseExchange(
    '```json\n{"summary":"s","targets":[{"node":"写手","payload":"给写手"},{"node":"n-unknown","payload":"丢弃"}]}\n```',
    [{ id: 'n1', title: '写手' }, { id: 'n2', title: '评审' }],
  )
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.payloads, [{ node: 'n1', payload: '给写手' }])
  const broken = parseExchange('not json', [{ id: 'n1', title: '写手' }])
  assert.equal(broken.ok, false)
})

test('applyComfyParams rewrites prompt, size, seed, and explicit overrides', () => {
  const graph = {
    1: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'old', clip: ['3', 0] } },
    2: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    3: { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  }
  applyComfyParams(graph, {
    promptText: 'new prompt',
    width: 768,
    height: 1024,
    seed: 42,
    overrides: { 2: { batch_size: 2 } },
  })
  assert.equal(graph[1].inputs.prompt, 'new prompt')
  assert.equal(graph[2].inputs.width, 768)
  assert.equal(graph[2].inputs.height, 1024)
  assert.equal(graph[2].inputs.batch_size, 2)
  assert.equal(graph[3].inputs.noise_seed, 42)
})

test('promptFields finds the writable positive and negative inputs of a node', () => {
  assert.deepEqual(promptFields({ class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'x', negative_prompt: '' } }), { positive: 'prompt', negative: 'negative_prompt' })
  assert.deepEqual(promptFields({ class_type: 'CLIPTextEncode', inputs: { text: 'x' } }), { positive: 'text', negative: undefined })
  assert.deepEqual(promptFields({ class_type: 'EmptyLatentImage', inputs: { width: 512 } }), { positive: undefined, negative: undefined })
})

test('applyComfyParams writes only into the chosen target nodes', () => {
  const graph = {
    5: { class_type: 'LoadImage', inputs: { image: 'a.png' } },
    6: { class_type: 'LoadImage', inputs: { image: 'b.png' } },
    7: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'old', negative_prompt: 'old neg' } },
    8: { class_type: 'TextEncodeQwenImage21', inputs: { prompt: 'other', negative_prompt: '' } },
  }
  applyComfyParams(graph, {
    promptText: 'NEW',
    negativeText: 'NEW NEG',
    referenceImage: 'ref.png',
    positiveTarget: '7',
    negativeTarget: '7',
    referenceTarget: '6',
  })
  assert.equal(graph[7].inputs.prompt, 'NEW')
  assert.equal(graph[8].inputs.prompt, 'other')
  assert.equal(graph[7].inputs.negative_prompt, 'NEW NEG')
  assert.equal(graph[8].inputs.negative_prompt, '')
  assert.equal(graph[5].inputs.image, 'a.png')
  assert.equal(graph[6].inputs.image, 'ref.png')
  assert.throws(() => applyComfyParams(structuredClone(graph), { promptText: 'X', positiveTarget: '5' }), /没有可写的正向提示词字段/)
})

test('comfyInputTargets lists injectable nodes of a real workflow file', async () => {
  const targets = await comfyInputTargets('qwen21_fusion_api.json')
  assert.ok(targets.positives.length >= 1)
  assert.ok(targets.images.length >= 2)
  assert.ok(targets.negatives.length >= 1)
})

test('uiToApi converts a UI workflow into a runnable API graph', () => {
  const api = uiToApi({
    nodes: [
      { id: 1, type: 'MarkdownNote', widgets_values: ['# doc'] },
      {
        id: 2,
        type: 'OpenAIGPTImageNodeV2',
        inputs: [{ name: 'model.images.image_1', link: null }, { name: 'model.mask', link: null }],
        outputs: [{ name: 'IMAGE' }],
        widgets_values: ['hello prompt', 'gpt-image-2.5-flare', 'auto', 1024, 1024, 'auto', 'high', 1, 20250001, 'randomize'],
      },
      { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 7 }], widgets_values: ['prefix'] },
    ],
    links: [[7, 2, 0, 3, 0, 'IMAGE']],
  })
  assert.equal(api['1'], undefined)
  assert.equal(api['2'].class_type, 'OpenAIGPTImageNodeV2')
  // Without object_info the positional guess keeps the first string as prompt.
  assert.equal(api['2'].inputs.prompt, 'hello prompt')
  const infoFixture = { X: { input: { required: { prompt: ['STRING', {}], mode: ['COMBO', { options: [{ key: 'opt', inputs: { required: { count: ['INT', {}] } } }] }] } } } }
  const withInfo = uiToApi({ nodes: [{ id: 2, type: 'X', inputs: [], widgets_values: ['P', 'opt', 10] }] }, infoFixture)
  assert.deepEqual(withInfo['2'].inputs, { prompt: 'P', mode: 'opt', count: 10 })
  assert.equal(api['3'].inputs.images[0], '2')
  assert.equal(api['3'].inputs.images[1], 0)
})

test('comfyInputTargets and loadComfyGraph convert UI workflows too', async () => {
  const targets = await comfyInputTargets('GPTImage25-文生图.json')
  assert.equal(targets.format, 'ui-converted')
  assert.ok(targets.positives.some(item => item.field === 'prompt'))
  const loaded = await loadComfyGraph('GPTImage25-文生图.json')
  assert.equal(loaded.format, 'ui-converted')
  assert.ok(Object.keys(loaded.graph).length >= 2)
})

test('graphFromApi lays nodes into dependency columns and links array inputs', () => {
  const graph = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'm.safetensors' } },
    2: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 42 } },
    3: { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'x' } },
  }
  const display = graphFromApi(graph)
  assert.equal(display.format, 'api')
  assert.equal(display.nodes.length, 3)
  assert.equal(display.edges.length, 2)
  const column = id => display.nodes.find(node => node.id === id).x
  assert.ok(column('1') < column('2'))
  assert.ok(column('2') < column('3'))
  assert.ok(display.bounds.width > 0)
  assert.ok(display.nodes.find(node => node.id === '1').summary.some(line => line.includes('unet_name')))
})

test('graphFromUi reads node positions and links', () => {
  const display = graphFromUi({
    nodes: [
      { id: 1, type: 'LoadImage', pos: [10, 20], size: [200, 100], widgets_values: ['a.png'] },
      { id: 2, type: 'PreviewImage', pos: [300, 20], size: [200, 100] },
    ],
    links: [[7, 1, 0, 2, 0, 'IMAGE']],
  })
  assert.equal(display.format, 'ui')
  assert.equal(display.nodes.length, 2)
  assert.deepEqual(display.edges, [{ from: '1', to: '2', label: '' }])
  assert.equal(display.nodes[0].x, 10)
})

test('userMessage includes an image block for every attachment reference', () => {
  const message = userMessage('look', [
    { attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 4, height: 4 } },
    { url: 'no attachment' },
  ])
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content.map(block => block.type), ['text', 'image'])
  assert.match(message.content[1].attachment.attachmentId, /att-1/)
})

test('runModelNode sends inbound images as image blocks', async () => {
  let captured
  const llm = {
    stream(options) {
      captured = options
      return scriptedStream({ text: 'ok' })
    },
  }
  const result = await runModelNode({
    llm,
    tools: { execute: async () => ({ results: [], additionalContexts: [], concluded: false }) },
    agent: undefined,
    node: { provider: 'p', model: 'vision', prompt: '' },
    system: 'SYS',
    userText: 'see',
    images: [{ attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 8, width: 2, height: 2 } }],
    toolSchemas: [],
    signal: new AbortController().signal,
  })
  assert.equal(result.text, 'ok')
  assert.deepEqual(captured.messages[0].content.map(block => block.type), ['text', 'image'])
})

test('input and output nodes are first-class graph types', () => {
  const workflow = normalizeWorkflow({
    nodes: [
      { id: 'i1', type: 'input', autoRead: true, value: 'hello' },
      { id: 'o1', type: 'output', published: true },
    ],
    edges: [{ id: 'e1', from: { node: 'i1', port: 'out' }, to: { node: 'o1', port: 'in' } }],
  })
  assert.equal(workflow.nodes[0].type, 'input')
  assert.equal(workflow.nodes[0].autoRead, true)
  assert.equal(workflow.nodes[1].type, 'output')
  assert.equal(workflow.nodes[1].published, true)
  assert.equal(workflow.edges.length, 1)
})

test('readLatestUserText returns the newest user-typed message', () => {
  const ctx = {
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        get: () => ({
          deriveMessages: () => [
            { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] },
            { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'ignored' }] },
            { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'latest' }] },
          ],
        }),
      }
    },
  }
  assert.equal(readLatestUserText(ctx, 's'), 'latest')
})

test('a run with input → output publishes the composer text', async () => {
  resetWorkflowState()
  const root = await mkdtemp(join(tmpdir(), 'dsh-aiwf-io-'))
  const appended = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: () => ({
            header: { cwd: root },
            deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '从对话栏来的文字' }] }],
            append: (type, data) => { appended.push({ type, data }); return { seq: appended.length } },
          }),
        }
      }
      if (name === 'agents') return { get: () => undefined, turnBoundaryOf: () => ({ lastTurn: 3 }) }
      if (name === 'llm') return { stream: () => (async function* () {})() }
      if (name === 'tools') return { schemas: () => [], execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
      if (name === 'skills') return { list: async () => [], get: async () => undefined }
      return undefined
    },
    effect() {},
  }
  const runId = await startRun(ctx, {
    sessionId: 'session-io',
    workflow: {
      id: 'main',
      nodes: [
        { id: 'i1', type: 'input', title: '输入', x: 0, y: 0 },
        { id: 'o1', type: 'output', title: '输出', x: 300, y: 0 },
      ],
      edges: [{ id: 'e1', from: { node: 'i1', port: 'out' }, to: { node: 'o1', port: 'in' } }],
    },
  })
  const run = getRun(runId)
  const deadline = Date.now() + 5000
  while (run.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(run.status, 'done', run.error)
  assert.equal(run.nodes.i1.text, '从对话栏来的文字')
  assert.equal(run.nodes.o1.text, '从对话栏来的文字')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'assistant/message')
  assert.equal(appended[0].data.message.content[0].text, '从对话栏来的文字')
  assert.match(appended[0].data.message.source.provider, /ai-workflow/)
})

test('a leader dispatches to isolated members and collects their results', async () => {
  resetWorkflowState()
  const root = await mkdtemp(join(tmpdir(), 'dsh-aiwf-leader-'))
  const requests = []
  const appended = []
  const llm = {
    stream(options) {
      requests.push(options)
      const system = String(options.system ?? '')
      if (system.includes('成员甲')) return scriptedStream({ text: '甲的结果' })
      if (system.includes('成员乙')) return scriptedStream({ text: '乙的结果' })
      return scriptedStream({ text: 'other' })
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: () => ({
            header: { cwd: root },
            deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '主界面的任务' }] }],
            append: (type, data) => { appended.push({ type, data }); return { seq: appended.length } },
          }),
        }
      }
      if (name === 'agents') return { get: () => undefined, turnBoundaryOf: () => ({ lastTurn: 2 }) }
      if (name === 'llm') return llm
      if (name === 'tools') return { schemas: () => [], execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
      if (name === 'skills') return { list: async () => [], get: async () => undefined }
      return undefined
    },
    effect() {},
  }
  const runId = await startRun(ctx, {
    sessionId: 'session-leader',
    workflow: {
      id: 'main',
      nodes: [
        { id: 'L', type: 'leader', title: 'Leader', x: 0, y: 0 },
        { id: 'a', type: 'model', title: '甲', provider: 'p', model: 'm', prompt: '成员甲', x: 300, y: 0, tools: [], skills: [], mcps: [] },
        { id: 'b', type: 'model', title: '乙', provider: 'p', model: 'm', prompt: '成员乙', x: 300, y: 200, tools: [], skills: [], mcps: [] },
      ],
      edges: [
        { id: 'e1', from: { node: 'L', port: 'out' }, to: { node: 'a', port: 'in' } },
        { id: 'e2', from: { node: 'L', port: 'out' }, to: { node: 'b', port: 'in' } },
        { id: 'e3', from: { node: 'a', port: 'out' }, to: { node: 'L', port: 'in' } },
        { id: 'e4', from: { node: 'b', port: 'out' }, to: { node: 'L', port: 'in' } },
      ],
    },
  })
  const run = getRun(runId)
  const deadline = Date.now() + 5000
  while (run.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(run.status, 'done', run.error)
  assert.equal(run.nodes.a.text, '甲的结果')
  assert.equal(run.nodes.b.text, '乙的结果')
  assert.match(run.nodes.L.text, /成员结果/)
  assert.match(run.nodes.L.text, /甲的结果/)
  assert.match(run.nodes.L.text, /乙的结果/)
  assert.equal(appended.length, 1)
  assert.match(appended[0].data.message.content[0].text, /甲的结果/)

  // Both members received the leader's dispatch text, and neither saw the
  // other member's prompt or history.
  const aRequest = requests.find(request => String(request.system).includes('成员甲'))
  const bRequest = requests.find(request => String(request.system).includes('成员乙'))
  assert.match(JSON.stringify(aRequest.messages), /主界面的任务/)
  assert.doesNotMatch(JSON.stringify(aRequest), /成员乙/)
  assert.doesNotMatch(JSON.stringify(bRequest), /成员甲/)
})

test('skills and node prompts are reloaded on every round', async () => {
  resetWorkflowState()
  const root = await mkdtemp(join(tmpdir(), 'dsh-aiwf-skill-'))
  let skillVersion = '第一版 skill'
  const systems = []
  const llm = { stream(options) { systems.push(String(options.system ?? '')); return scriptedStream({ text: 'ok' }) } }
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: () => ({ header: { cwd: root }, deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }], append: () => ({ seq: 1 }) }) }
      if (name === 'agents') return { get: () => undefined, turnBoundaryOf: () => ({ lastTurn: 1 }) }
      if (name === 'llm') return llm
      if (name === 'tools') return { schemas: () => [], execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
      if (name === 'skills') return { list: async () => [], get: async name2 => ({ name: name2, content: skillVersion }) }
      return undefined
    },
    effect() {},
  }
  const workflow = {
    id: 'main',
    nodes: [{ id: 'a', type: 'model', title: '甲', provider: 'p', model: 'm', prompt: '节点提示词', x: 0, y: 0, tools: [], skills: ['style'], mcps: [] }],
    edges: [],
  }
  const first = getRun(await startRun(ctx, { sessionId: 'session-skill', workflow }))
  while (first.status === 'running') await new Promise(resolve => setTimeout(resolve, 20))
  skillVersion = '第二版 skill'
  const second = getRun(await startRun(ctx, { sessionId: 'session-skill', workflow }))
  while (second.status === 'running') await new Promise(resolve => setTimeout(resolve, 20))
  assert.match(systems[0], /第一版 skill/)
  assert.match(systems[1], /第二版 skill/)
})

test('a leader accepts the user message through an input pipeline', async () => {
  resetWorkflowState()
  const root = await mkdtemp(join(tmpdir(), 'dsh-aiwf-leader-in-'))
  const requests = []
  const llm = { stream(options) { requests.push(options); return scriptedStream({ text: '收到' }) } }
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        // Empty conversation on purpose: the text must come from the pipeline.
        return { get: () => ({ header: { cwd: root }, deriveMessages: () => [], append: () => ({ seq: 1 }) }) }
      }
      if (name === 'agents') return { get: () => undefined, turnBoundaryOf: () => ({ lastTurn: 1 }) }
      if (name === 'llm') return llm
      if (name === 'tools') return { schemas: () => [], execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
      if (name === 'skills') return { list: async () => [], get: async () => undefined }
      return undefined
    },
    effect() {},
  }
  const runId = await startRun(ctx, {
    sessionId: 'session-leader-in',
    workflow: {
      id: 'main',
      nodes: [
        { id: 'i', type: 'input', title: '输入', autoRead: false, value: '来自输入管线的任务', x: 0, y: 0 },
        { id: 'L', type: 'leader', title: 'Leader', x: 300, y: 0 },
        { id: 'm', type: 'model', title: '成员', provider: 'p', model: 'm', prompt: '成员提示', x: 600, y: 0, tools: [], skills: [], mcps: [] },
      ],
      edges: [
        { id: 'e1', from: { node: 'i', port: 'out' }, to: { node: 'L', port: 'input' } },
        { id: 'e2', from: { node: 'L', port: 'out' }, to: { node: 'm', port: 'in' } },
        { id: 'e3', from: { node: 'm', port: 'out' }, to: { node: 'L', port: 'result' } },
      ],
    },
  })
  const run = getRun(runId)
  const deadline = Date.now() + 5000
  while (run.status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(run.status, 'done', run.error)
  assert.equal(run.nodes.L.text.includes('来自输入管线的任务'), true)
  assert.match(JSON.stringify(requests[0].messages), /来自输入管线的任务/)
  assert.match(run.nodes.L.text, /收到/)
})

test('startRun keeps node contexts isolated and routes exchange payloads', async () => {
  resetWorkflowState()
  const root = await mkdtemp(join(tmpdir(), 'dsh-aiwf-'))
  const requests = []
  const llm = {
    stream(options) {
      requests.push(options)
      const system = String(options.system ?? '')
      if (system.includes('交换提示')) {
        return scriptedStream({
          text: JSON.stringify({ summary: '合并完成', targets: [{ node: 'nC', payload: '来自交换节点' }] }),
        })
      }
      if (system.includes('C的提示')) return scriptedStream({ text: 'C-结果' })
      if (system.includes('A的提示')) return scriptedStream({ text: 'A-结果' })
      if (system.includes('B的提示')) return scriptedStream({ text: 'B-结果' })
      return scriptedStream({ text: 'other' })
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'sessions') return { get: () => ({ header: { cwd: root } }) }
      if (name === 'tools') return { schemas: () => [], execute: async () => ({ results: [], additionalContexts: [], concluded: false }) }
      if (name === 'skills') return { list: async () => [], get: async () => undefined }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    effect() {},
  }
  const workflow = {
    id: 'main',
    title: 'test',
    nodes: [
      { id: 'nA', type: 'model', title: 'A', provider: 'p', model: 'm', prompt: 'A的提示', x: 0, y: 0, tools: [], skills: [], mcps: [] },
      { id: 'nB', type: 'model', title: 'B', provider: 'p', model: 'm', prompt: 'B的提示', x: 0, y: 0, tools: [], skills: [], mcps: [] },
      { id: 'nX', type: 'exchange', title: '交换', prompt: '交换提示', mode: 'auto', x: 0, y: 0 },
      { id: 'nC', type: 'model', title: 'C', provider: 'p', model: 'm', prompt: 'C的提示', x: 0, y: 0, tools: [], skills: [], mcps: [] },
    ],
    edges: [
      { id: 'e1', from: { node: 'nA', port: 'out' }, to: { node: 'nX', port: 'in' } },
      { id: 'e2', from: { node: 'nB', port: 'out' }, to: { node: 'nX', port: 'in' } },
      { id: 'e3', from: { node: 'nX', port: 'out' }, to: { node: 'nC', port: 'exchange' } },
    ],
  }
  const runId = await startRun(ctx, { sessionId: 'session-test', workflow })
  const run = getRun(runId)
  assert.ok(run !== undefined)
  const deadline = Date.now() + 5000
  while (run.status === 'running' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(run.status, 'done', run.error)
  assert.equal(run.nodes.nA.text, 'A-结果')
  assert.equal(run.nodes.nB.text, 'B-结果')
  assert.equal(run.nodes.nC.text, 'C-结果')
  assert.match(run.nodes.nX.text, /合并完成/)

  const requestOf = marker => requests.find(request => String(request.system ?? '').includes(marker))
  assert.ok(requestOf('A的提示'))
  assert.ok(requestOf('B的提示'))
  const cRequest = requestOf('C的提示')
  const cText = JSON.stringify(cRequest.messages)
  assert.match(cText, /【交换信息/)
  assert.match(cText, /来自交换节点/)
  // A's output reaches the exchange node, but never appears in B's request.
  const bRequest = requestOf('B的提示')
  assert.doesNotMatch(JSON.stringify(bRequest), /A-结果/)
  // Each node wrote its own run log.
  const logA = JSON.parse(await readFile(join(root, 'dsh-workflows', 'session-test', 'runs', runId, 'nA.json'), 'utf8'))
  assert.equal(logA.output, 'A-结果')
  const logC = JSON.parse(await readFile(join(root, 'dsh-workflows', 'session-test', 'runs', runId, 'nC.json'), 'utf8'))
  assert.match(JSON.stringify(logC.messages), /来自交换节点/)
})