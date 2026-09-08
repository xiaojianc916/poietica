import { describe, expect, test } from 'bun:test'
import type { LibraryCatalog, LibraryReply } from '@poietica/contract/library'
import { LibraryController } from './controller'

const catalog: LibraryCatalog = { root: '/notes', entries: [] }
const document = { path: 'a.md', content: 'saved' }
const describeError = (cause: unknown) => String(cause)

describe('library document ownership', () => {
  test('failed saves keep draft and prevent navigation', async () => {
    const calls: string[] = []
    const controller = new LibraryController(
      {
        pick: async () => catalog,
        execute: async (_root, request): Promise<LibraryReply> => {
          calls.push(request.kind)
          if (request.kind === 'read') {
            return { kind: 'document', value: document }
          }
          throw new Error('disk unavailable')
        },
      },
      describeError,
    )
    await controller.choose()
    await controller.open('a.md')
    controller.edit('draft')
    expect(await controller.open('b.md')).toBe(false)
    expect(calls).toEqual(['read', 'save'])
    expect(controller.getSnapshot().draft).toBe('draft')
    expect(controller.getSnapshot().document?.path).toBe('a.md')
  })

  test('typing during save does not get replaced by the saved snapshot', async () => {
    let finish: ((reply: LibraryReply) => void) | undefined
    const controller = new LibraryController(
      {
        pick: async () => catalog,
        execute: async (_root, request): Promise<LibraryReply> => {
          if (request.kind === 'read') {
            return { kind: 'document', value: document }
          }
          if (request.kind === 'list') {
            return { kind: 'catalog', value: catalog }
          }
          return new Promise((resolve) => {
            finish = resolve
          })
        },
      },
      describeError,
    )
    await controller.choose()
    await controller.open('a.md')
    controller.edit('first')
    const saving = controller.save()
    await Promise.resolve()
    controller.edit('second')
    if (!finish) {
      throw new Error('save was not dispatched')
    }
    finish({ kind: 'document', value: { path: 'a.md', content: 'first' } })
    expect(await saving).toBe(true)
    expect(controller.getSnapshot().draft).toBe('second')
    expect(controller.dirty).toBe(true)
  })

  test('cancelling a folder chooser preserves the active document', async () => {
    let choices = 0
    const controller = new LibraryController(
      {
        pick: async () => (choices++ === 0 ? catalog : null),
        execute: async (): Promise<LibraryReply> => ({ kind: 'document', value: document }),
      },
      describeError,
    )
    await controller.choose()
    await controller.open('a.md')
    await controller.choose()
    expect(controller.getSnapshot().document).toEqual(document)
  })
})
