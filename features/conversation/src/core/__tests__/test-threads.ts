import { createSubmissionsRepository } from '@poietica/feature-runs/core'
import { createReclaimRepository, createThreadsRepository, ThreadService } from '@poietica/feature-threads/core'
import type { Clock } from '@poietica/foundation'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import { createTestLogger } from '@poietica/test-kit'

/** 直接构造 ConversationCore 的用例：线程服务走真实实现，端口由 ConversationCore 自己 configure。 */
export function createTestThreads(db: ModuleDatabase, clock: Clock): ThreadService {
  return new ThreadService({
    repo: createThreadsRepository(db),
    reclaim: createReclaimRepository(db),
    transaction: (fn) => db.transaction(fn),
    clock,
    logger: createTestLogger(),
  })
}

export const createTestSubmissions = createSubmissionsRepository
