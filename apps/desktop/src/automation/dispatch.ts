import { type AutomationDispatch, sessionConfigOf } from '@poietica/automation'
import type { AgentSessionPort, ThreadsStore, TranscriptStore } from '@poietica/conversation'

export function createAutomationDispatch(input: {
  readonly session: AgentSessionPort
  readonly threads: Pick<ThreadsStore, 'create' | 'rename' | 'noteUserMessage'>
  readonly transcripts: Pick<TranscriptStore, 'send' | 'waitForTerminal'>
  readonly createId: () => string
  readonly signal: AbortSignal
}): AutomationDispatch {
  return async (automation) => {
    input.signal.throwIfAborted()
    const threadId = input.createId()
    const opened = await input.threads.create(threadId)
    input.signal.throwIfAborted()
    if (opened === null) {
      return { threadId: null, outcome: 'failed' }
    }
    await input.threads.rename(threadId, automation.title)
    input.signal.throwIfAborted()
    const submitted = await input.transcripts.send({
      assets: [],
      configuration: Object.entries(sessionConfigOf(automation)).map(([id, value]) => ({
        id,
        value,
      })),
      onUserMessage: (id) => input.threads.noteUserMessage(id, automation.title),
      port: input.session,
      skills: [],
      text: automation.prompt,
      threadId,
    })
    input.signal.throwIfAborted()
    if (!submitted) {
      return { threadId, outcome: 'failed' }
    }
    const terminal = await input.transcripts.waitForTerminal(
      threadId,
      submitted.promptId,
      input.signal,
    )
    return { threadId, outcome: terminal === 'completed' ? 'succeeded' : 'failed' }
  }
}
