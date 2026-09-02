import type { AttachmentIntake } from '@poietica/conversation'
import { createContext, useContext } from 'react'

export const AttachmentIntakeContext = createContext<AttachmentIntake | null>(null)

export function useAttachmentIntake(): AttachmentIntake | null {
  return useContext(AttachmentIntakeContext)
}
