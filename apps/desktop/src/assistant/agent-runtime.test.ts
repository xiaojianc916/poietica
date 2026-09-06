import { expect, test } from 'bun:test'
import type { SessionConfigControl, SessionConfigPort } from '@poietica/conversation'
import {
  type AgentRuntimeChannels,
  type AgentRuntimeDependencies,
  createAgentRuntime,
} from './agent-runtime'

const model: SessionConfigControl = {
  id: 'model',
  label: 'Model',
  purpose: 'model',
  current: 'chosen',
  choices: [{ value: 'chosen', label: 'Chosen' }],
}
const controls: readonly SessionConfigControl[] = [model]
const unavailable = (): Promise<never> => Promise.reject(new Error('Unexpected fixture operation'))
const subscribe = (): (() => void) => () => undefined

function fixture() {
  const effects: string[] = []
  const state: {
    select: SessionConfigPort['select']
    ready: () => Promise<void>
    metadata: () => Promise<void>
    mutation: () => Promise<void>
  } = {
    select: () => Promise.resolve(controls),
    ready: () => Promise.resolve(),
    metadata: () => Promise.resolve(),
    mutation: () => Promise.resolve(),
  }
  const channels: AgentRuntimeChannels = {
    session: {
      transcript: {
        subscribeTranscript: subscribe,
        readTranscript: unavailable,
        catchUpTranscript: unavailable,
      },
      prompt: unavailable,
      cancel: unavailable,
      steer: unavailable,
      abortPrompt: unavailable,
      resolvePermission: unavailable,
      answerQuestions: unavailable,
      dismissQuestions: unavailable,
    },
    threads: {
      list: () => Promise.resolve([]),
      read: unavailable,
      create: unavailable,
      open: unavailable,
    },
    config: { select: (...args) => state.select(...args), subscribe },
    usage: { subscribe },
    capabilities: {
      read: () => Promise.resolve(controls),
      select: () => Promise.resolve(controls),
      subscribe,
      readToolkit: () => Promise.resolve({ skills: [], mcpServers: [] }),
    },
  }
  let prepare: () => Promise<string> = unavailable
  const dependencies: AgentRuntimeDependencies = {
    agentId: 'agent',
    modelCatalog: {
      synchronizeMetadata: () => {
        effects.push('metadata')
        return state.metadata()
      },
      refresh: () => Promise.resolve(),
      getSnapshot: () => ({
        data: { providers: [], models: [], catalog: [], defaultModel: 'chosen' },
        loading: false,
        mutating: false,
        error: null,
      }),
      mutate: async (operation) => {
        if (operation.kind !== 'setDefault') {
          throw new Error('Unexpected model operation')
        }
        effects.push(`default:${operation.modelId}`)
        await state.mutation()
      },
    },
    mcpReady: () => state.ready(),
    permissionPosture: { read: () => undefined, write: () => undefined },
    thinking: {
      selection: () => undefined,
      remember: (_agent, _controls, id, value) => {
        effects.push(`remember:${id}:${value}`)
      },
    },
    report: (_message, context) => {
      effects.push(`report:${context.operation}`)
    },
    connect: (ready) => {
      prepare = ready
      return channels
    },
  }
  const runtime = createAgentRuntime(dependencies)
  return { runtime, state, effects, prepare: () => prepare() }
}

test('unacknowledged selections never become preferences', async () => {
  const { runtime, effects } = fixture()
  expect(await runtime.sessionConfig.select('thread', 'model', 'rejected')).toBe(controls)
  expect(effects).toEqual([])
  await runtime.dispose()
})

test('accepted selections persist the model before remembering preferences', async () => {
  const { runtime, effects } = fixture()
  expect(await runtime.capabilities().select(model, 'chosen')).toBe(controls)
  expect(effects).toEqual(['default:chosen', 'remember:model:chosen'])
  await runtime.dispose()
})

test('a configuration reply after disposal cannot write preferences', async () => {
  const h = fixture()
  const reply = Promise.withResolvers<readonly SessionConfigControl[]>()
  h.state.select = () => reply.promise
  const pending = h.runtime.sessionConfig.select('thread', 'model', 'chosen')
  // Attach handlers eagerly: Bun's expect().rejects hangs when awaited late.
  const settled = pending.then(
    () => new Error('Expected selection to stop after disposal'),
    (cause: unknown) => cause,
  )
  await h.runtime.dispose()
  reply.resolve(controls)
  expect(await settled).toHaveProperty('name', 'AbortError')
  expect(h.effects).toEqual([])
})

test('disposal while a model write completes stops subsequent preference effects', async () => {
  const h = fixture()
  const entered = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  h.state.mutation = () => {
    entered.resolve()
    return finished.promise
  }
  const pending = h.runtime.capabilities().select(model, 'chosen')
  // Attach handlers eagerly: Bun's expect().rejects hangs when awaited late.
  const settled = pending.then(
    () => new Error('Expected model write to stop after disposal'),
    (cause: unknown) => cause,
  )
  await entered.promise
  await h.runtime.dispose()
  finished.resolve()
  expect(await settled).toHaveProperty('name', 'AbortError')
  expect(h.effects).toEqual(['default:chosen'])
})

test('launches share metadata readiness and capabilities retain their identity', async () => {
  const h = fixture()
  expect(await Promise.all([h.prepare(), h.prepare()])).toEqual(['agent', 'agent'])
  expect(h.effects).toEqual(['metadata'])
  expect(h.runtime.capabilities()).toBe(h.runtime.capabilities())
  await h.runtime.dispose()
})

test('stopping during launch prerequisites prevents metadata work', async () => {
  const h = fixture()
  const ready = Promise.withResolvers<void>()
  h.state.ready = () => ready.promise
  const pending = h.prepare()
  // Attach handlers eagerly: Bun's expect().rejects hangs when awaited late.
  const settled = pending.then(
    () => new Error('Expected launch to stop after disposal'),
    (cause: unknown) => cause,
  )
  await h.runtime.dispose()
  ready.resolve()
  expect(await settled).toHaveProperty('name', 'AbortError')
  expect(h.effects).toEqual([])
})
