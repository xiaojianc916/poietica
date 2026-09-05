/** A single write lane for complete workbench snapshots, with bounded pending work. */
export function createWorkbenchPersistence(
  write: (document: string) => void | Promise<void>,
  report: ((cause: unknown) => void) | undefined,
) {
  let pending: string | null = null
  let running: Promise<void> | null = null
  let failure: { readonly cause: unknown } | null = null

  async function drain(): Promise<void> {
    while (pending !== null) {
      const document = pending
      pending = null
      try {
        await write(document)
        failure = null
      } catch (cause: unknown) {
        failure = { cause }
        try {
          report?.(cause)
        } catch (reporting: unknown) {
          failure = {
            cause: new AggregateError([cause, reporting], 'Persistence and reporting failed.'),
          }
        }
      }
    }
  }

  function start(): void {
    if (running !== null) {
      return
    }
    running = Promise.resolve()
      .then(drain)
      .finally(() => {
        running = null
        if (pending !== null) {
          start()
        }
      })
  }

  return {
    enqueue(document: string): void {
      pending = document
      start()
    },
    async flush(): Promise<void> {
      while (running !== null) {
        await running
      }
      if (failure !== null) {
        throw failure.cause
      }
    },
  }
}
