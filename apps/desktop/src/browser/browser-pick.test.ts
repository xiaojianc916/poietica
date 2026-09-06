import { expect, mock, test } from 'bun:test'
import type { ComposerAsset } from '@poietica/conversation'
import { type BrowserPickMessage, createBrowserPickController } from './browser-pick'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not ready.')
  }
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
const message: BrowserPickMessage = {
  reportPath: '/report',
  elementType: 'button',
  comment: 'inspect',
  submission: 'send',
}
const asset: ComposerAsset = {
  sessionToken: 'session',
  assetToken: 'asset',
  url: 'asset://report',
  filename: 'report',
  mediaType: 'text/plain',
}

test('a listener acquired after shutdown is released exactly once', async () => {
  const registration = deferred<() => void>()
  const released = deferred<void>()
  const detach = mock(() => {
    released.resolve()
  })
  const controller = createBrowserPickController({
    intake: { import: async () => [], discard: () => undefined },
    watch: () => registration.promise,
    report: () => undefined,
  })
  const stop = controller.start()
  stop()
  registration.resolve(detach)
  await released.promise
  stop()
  expect(detach).toHaveBeenCalledTimes(1)
})

test('an import completed for a replaced destination is released rather than attached', async () => {
  const importing = deferred<readonly ComposerAsset[]>()
  const installed = deferred<void>()
  const discarded = deferred<void>()
  let receive: (message: BrowserPickMessage) => void = () => {
    throw new Error('Listener is not installed.')
  }
  const attach = mock(() => undefined)
  const discard = mock((_asset: ComposerAsset) => {
    discarded.resolve()
  })
  const controller = createBrowserPickController({
    intake: { import: () => importing.promise, discard },
    watch: async (listen) => {
      receive = listen
      installed.resolve()
      return () => undefined
    },
    report: () => undefined,
  })
  const stop = controller.start()
  const releaseTarget = controller.adopt({ current: { attach } })
  await installed.promise
  receive(message)
  releaseTarget()
  controller.adopt({ current: { attach } })
  importing.resolve([asset])
  await discarded.promise
  expect(attach).not.toHaveBeenCalled()
  expect(discard).toHaveBeenCalledWith(asset)
  stop()
})

test('instances deliver only to their own target and preserve browser submission intent', async () => {
  const delivered = deferred<void>()
  const installed = deferred<void>()
  let receive: (message: BrowserPickMessage) => void = () => {
    throw new Error('Listener is not installed.')
  }
  const attach = mock(
    (_assets: readonly ComposerAsset[], _input?: { text?: string; submit?: boolean }) => {
      delivered.resolve()
    },
  )
  const foreign = mock(() => undefined)
  const first = createBrowserPickController({
    intake: { import: async () => [asset], discard: () => undefined },
    watch: async (listen) => {
      receive = listen
      installed.resolve()
      return () => undefined
    },
    report: () => undefined,
  })
  const second = createBrowserPickController({
    intake: { import: async () => [], discard: () => undefined },
    watch: async () => () => undefined,
    report: () => undefined,
  })
  const stop = first.start()
  first.adopt({ current: { attach } })
  second.adopt({ current: { attach: foreign } })
  await installed.promise
  receive(message)
  await delivered.promise
  expect(attach).toHaveBeenCalledWith(
    [{ ...asset, context: { kind: 'browser-element', label: 'button' } }],
    { text: 'inspect', submit: true },
  )
  expect(foreign).not.toHaveBeenCalled()
  stop()
})
