import type { DiffFile } from '@poietica/auxiliary/review'

export interface DeriveRequest {
  readonly id: number
  readonly patch: string
  readonly wordDiff: boolean
}

export type DeriveFailure = { readonly code: 'REVIEW_DERIVE_FAILED'; readonly message: string }

export type DeriveReply =
  | { readonly id: number; readonly ok: true; readonly files: readonly DiffFile[] }
  | { readonly id: number; readonly ok: false; readonly error: DeriveFailure }
