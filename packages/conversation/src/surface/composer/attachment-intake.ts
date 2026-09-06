import { createContext, useContext } from 'react'
import type { AttachmentIntake } from '../../composer/attachment'

export const AttachmentIntakeContext = createContext<AttachmentIntake | null>(null)

export function useAttachmentIntake(): AttachmentIntake | null {
  return useContext(AttachmentIntakeContext)
}
