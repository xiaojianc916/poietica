import { defineServiceToken } from '@poietica/foundation'
import type { ThreadsRepository } from './types'

export type { ThreadRow, ThreadsRepository } from './types'

export const ThreadsRepositoryToken = defineServiceToken<ThreadsRepository>('threads', 'ThreadsRepository')

export * from './pending-interaction'
export * from './thread-of'
export * from './title'
