import type { JournalService } from '@poietica/feature-journal/core-api'

/** 测试替身：Journal 只在真实装配里落库；直连 ConversationCore 的用例不需要它。 */
export function fakeJournal(): JournalService {
  return {
    append: () => 0,
    appendAndStamp: (_threadId, _agentId, events) => events,
    read: () => [],
    readTyped: () => [],
    latestSeq: () => 0,
    clear: () => 0,
  }
}
