import { createContext, useContext } from 'react'
import type { AttachmentIntake } from '../index'

export const AttachmentIntakeContext = createContext<AttachmentIntake | null>(null)

export function useAttachmentIntake(): AttachmentIntake | null {
  return useContext(AttachmentIntakeContext)
}
