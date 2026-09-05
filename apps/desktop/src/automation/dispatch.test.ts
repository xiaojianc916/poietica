import { expect, test } from 'bun:test'
import type { Automation } from '@poietica/automation'
import type { AgentSessionPort, TranscriptStore } from '@poietica/conversation'
import { createAutomationDispatch } from './dispatch'

const automation: Automation = {
  id: 'automation',
  title: 'Daily review',
  prompt: 'Review the changes',
  enabled: true,
  createdAt: '2026-01-01T00:00:00Z',
  schedule: null,
  nextRunAt: null,
  runs: [],
  sessionConfig: { model: 'chosen-model' },
}

const session: AgentSessionPort = {
  transcript: {
    subscribeTranscript: () => () => undefined,
    readTranscript: async () => {
      throw new Error('Unexpected transcript read.')
    },
    catchUpTranscript: async () => {
      throw new Error('Unexpected catch-up.')
    },
  },
  prompt: async () => {
    throw new Error('The submission store owns the prompt path.')
  },
  cancel: async () => undefined,
  steer: async () => undefined,
  abortPrompt: async () => undefined,
  resolvePermission: async () => undefined,
  answerQuestions: async () => undefined,
  dismissQuestions: async () => undefined,
}

test('automation submits configuration once and uses the actual conversation identity', async () => {
  const calls: string[] = []
  const signal = new AbortController().signal
  const dispatch = createAutomationDispatch({
    session,
    signal,
    createId: () => 'thread',
    threads: {
      create: async (id) => {
        calls.push(`create:${id}`)
        return id
      },
      rename: async (id, title) => {
        calls.push(`rename:${id}:${title}`)
      },
      noteUserMessage: (id, title) => {
        calls.push(`note:${id}:${title}`)
      },
    },
    transcripts: {
      send: async (request: Parameters<TranscriptStore['send']>[0]) => {
        expect(request.configuration).toEqual([{ id: 'model', value: 'chosen-model' }])
        expect(request.text).toBe(automation.prompt)
        request.onUserMessage?.(request.threadId, request.text)
        calls.push('submit')
        return true
      },
      waitForTerminal: async (id, cancellation) => {
        expect(id).toBe('thread')
        expect(cancellation).toBe(signal)
        calls.push('wait')
        return 'completed'
      },
    },
  })
  expect(await dispatch(automation)).toEqual({ threadId: 'thread', outcome: 'succeeded' })
  expect(calls).toEqual([
    'create:thread',
    'rename:thread:Daily review',
    'note:thread:Daily review',
    'submit',
    'wait',
  ])
})

test('a failed submission does not wait forever for a turn that never started', async () => {
  const dispatch = createAutomationDispatch({
    session,
    signal: new AbortController().signal,
    createId: () => 'thread',
    threads: {
      create: async (id) => id,
      rename: async () => undefined,
      noteUserMessage: () => undefined,
    },
    transcripts: {
      send: async () => false,
      waitForTerminal: async () => {
        throw new Error('Must not wait after failed submission.')
      },
    },
  })
  expect(await dispatch(automation)).toEqual({ threadId: 'thread', outcome: 'failed' })
})
