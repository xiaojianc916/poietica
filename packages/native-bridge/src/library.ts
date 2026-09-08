import { commands } from '@poietica/contract'
import type { LibraryGateway } from '@poietica/library'
import { throughIpc } from './ipc-error'

export const libraryGateway: LibraryGateway = {
  pick: () => throughIpc(() => commands.libraryPick()),
  execute: (root, request) => throughIpc(() => commands.libraryExecute(root, request)),
}

export const openLibraryLink = (url: string): Promise<void> =>
  throughIpc(() => commands.windowOpenExternalUrl(url))
