import { createContext, useContext } from 'react'
import type { BrowserPickController } from './browser-pick'

export const BrowserPickContext = createContext<BrowserPickController | null>(null)
export function useBrowserPick(): BrowserPickController {
  const controller = useContext(BrowserPickContext)
  if (controller === null) {
    throw new Error('Browser picking must be supplied by the application.')
  }
  return controller
}
