import { commands } from '@poietica/contract'
import type { LibraryGateway } from '@poietica/library'
import { throughIpc } from './ipc-error'

export const libraryGateway: LibraryGateway = {
  execute: (request) => throughIpc(() => commands.libraryExecute(request)),
  importFile: (parent) => throughIpc(() => commands.libraryImport(parent)),
}

export const openLibraryLink = (url: string): Promise<void> =>
  throughIpc(() => commands.windowOpenExternalUrl(url))
