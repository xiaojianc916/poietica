#!/usr/bin/env node

import { access, readFile, rename, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolve } from 'node:path'

const root = process.cwd()
const cancellationDeadlineMs = 8_000

const files = {
  contract: 'packages/agent-contract/src/run.ts',
  reducer: 'packages/agent/src/timeline/timeline-reducer.ts',
  timelineIndex: 'packages/agent/src/timeline/index.ts',
  queries: 'packages/agent/src/timeline/timeline-queries.ts',
  store: 'packages/agent/src/session/transcript-store.ts',
  storeTest: 'packages/agent/src/session/__tests__/transcript-store.test.ts',
  sessionHook: 'packages/agent-ui/src/session/use-assistant-session.ts',
  composer: 'packages/agent-ui/src/composer/prompt-input.tsx',
  turn: 'apps/desktop/src-tauri/src/commands/agent/turn.rs',
}

function rule(name, applied, before, after) {
  return { name, applied, before, after }
}

const plans = [
  {
    path: files.contract,
    rules: [
      rule(
        'add the cancelling run state',
        "  | 'cancelling'\n  | 'awaiting_permission'",
        "  | 'running'\n  | 'awaiting_permission'",
        "  | 'running'\n  | 'cancelling'\n  | 'awaiting_permission'",
      ),
      rule(
        'add the cancelling composer state',
        "'streaming' | 'cancelling' | 'error'",
        "export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'",
        "export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'cancelling' | 'error'",
      ),
    ],
  },
  {
    path: files.reducer,
    rules: [
      rule(
        'import cancellation draft operations',
        '  markTurnEnd,\n  namespace,',
        '  freeze,\n  namespace,',
        '  freeze,\n  markTurnEnd,\n  namespace,',
      ),
      rule(
        'import tail sealing',
        '  pushBeforeRun,\n  sealTail,',
        '  push,\n  pushBeforeRun,',
        '  push,\n  pushBeforeRun,\n  sealTail,',
      ),
      rule(
        'treat interrupted cancellation as incomplete replay',
        "    draft.status === 'cancelling' ||",
        "    draft.status === 'running' ||\n    draft.status === 'awaiting_permission' ||",
        "    draft.status === 'running' ||\n    draft.status === 'cancelling' ||\n    draft.status === 'awaiting_permission' ||",
      ),
      rule(
        'add explicit cancellation transitions',
        'export function requestRunCancellation(',
        `  return freeze(draft)\n}\n\n/**\n * 一批帧，一趟草稿。`,
        `  return freeze(draft)\n}\n\nfunction canCancel(status: TimelineState['status']): boolean {\n  return (\n    status === 'submitted' ||\n    status === 'running' ||\n    status === 'awaiting_permission' ||\n    status === 'awaiting_question'\n  )\n}\n\n/** Records user intent without pretending that the server has stopped. */\nexport function requestRunCancellation(state: TimelineState): TimelineState {\n  if (!canCancel(state.status)) {\n    return state\n  }\n\n  const draft = draftOf(state)\n\n  sealTail(draft)\n  draft.status = 'cancelling'\n\n  return freeze(draft)\n}\n\n/** Closes a cancellation after KAP accepts it or the local deadline expires. */\nexport function confirmRunCancellation(state: TimelineState, at: number): TimelineState {\n  if (state.status === 'cancelled' || (!canCancel(state.status) && state.status !== 'cancelling')) {\n    return state\n  }\n\n  const draft = draftOf(state)\n\n  sealTail(draft)\n  draft.status = 'cancelled'\n  markTurnEnd(draft, at)\n\n  return freeze(draft)\n}\n\n/**\n * 一批帧，一趟草稿。`,
      ),
    ],
  },
  {
    path: files.timelineIndex,
    rules: [
      rule(
        'export cancellation transitions',
        '  confirmRunCancellation,\n  requestRunCancellation,',
        '  appendLocalError,\n  appendUserMessage,',
        '  appendLocalError,\n  appendUserMessage,\n  confirmRunCancellation,\n  requestRunCancellation,',
      ),
    ],
  },
  {
    path: files.queries,
    rules: [
      rule(
        'include cancelling in busy projection',
        "    state.status === 'cancelling' ||",
        "    state.status === 'running' ||\n    state.status === 'awaiting_permission' ||",
        "    state.status === 'running' ||\n    state.status === 'cancelling' ||\n    state.status === 'awaiting_permission' ||",
      ),
    ],
  },
  {
    path: files.sessionHook,
    rules: [
      rule(
        'project cancelling into the composer',
        "    case 'cancelling':\n      return 'cancelling'",
        "    case 'submitted':\n      return 'submitted'\n    case 'running':",
        "    case 'submitted':\n      return 'submitted'\n    case 'cancelling':\n      return 'cancelling'\n    case 'running':",
      ),
    ],
  },
  {
    path: files.composer,
    rules: [
      rule(
        'render cancellation acknowledgement',
        "  const cancelling = status === 'cancelling'",
        `  const draft = usePromptInputDraft()\n  const canCancel = status === 'submitted' || status === 'streaming'\n  const Icon = canCancel ? StopIcon : SubmitIcon\n\n  return (\n    <button\n      {...props}\n      aria-label={canCancel ? '停止生成' : '发送'}\n      className={className}\n      data-slot="prompt-input-submit"\n      data-status={status}\n      disabled={disabled ?? (!canCancel && !canSubmitDraft(draft))}\n      onClick={canCancel ? onCancel : undefined}\n      type={canCancel ? 'button' : 'submit'}\n    >`,
        `  const draft = usePromptInputDraft()\n  const cancelling = status === 'cancelling'\n  const canCancel = status === 'submitted' || status === 'streaming'\n  const Icon = canCancel || cancelling ? StopIcon : SubmitIcon\n\n  return (\n    <button\n      {...props}\n      aria-label={cancelling ? '正在停止' : canCancel ? '停止生成' : '发送'}\n      className={className}\n      data-slot="prompt-input-submit"\n      data-status={status}\n      disabled={cancelling || disabled === true || (!canCancel && !canSubmitDraft(draft))}\n      onClick={canCancel ? onCancel : undefined}\n      type={canCancel ? 'button' : 'submit'}\n    >`,
      ),
    ],
  },
  {
    path: files.store,
    rules: [
      rule(
        'import cancellation transitions',
        '  confirmRunCancellation,\n  createTimelineState,',
        '  applyRunEvents,\n  createTimelineState,',
        '  applyRunEvents,\n  confirmRunCancellation,\n  createTimelineState,',
      ),
      rule(
        'import cancellation request transition',
        '  replayThreadEvents,\n  requestRunCancellation,',
        '  replayThreadEvents,\n  selectIsBusy,',
        '  replayThreadEvents,\n  requestRunCancellation,\n  selectIsBusy,',
      ),
      rule(
        'define pending submission ownership',
        'interface PendingSubmission {',
        `export interface SendOptions {\n  readonly port: AgentSessionPort | undefined\n  /** 这一格现在的键：真对话 id，或入口那一格的草稿键。 */\n  readonly key: string\n  /** 这一格已经是哪条对话；入口那一格是 null。 */\n  readonly endpoint: string | null\n  readonly text: string\n  /** 这一句带的图片，按它们在原生交付注册表里的位置点名。 */\n  readonly assets: readonly PromptAsset[]\n  readonly configuration: readonly PromptConfiguration[]\n  readonly skills: readonly PromptSkill[]\n  readonly identify?: (() => Promise<string | null>) | undefined\n  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined\n}\n`,
        `export interface SendOptions {\n  readonly port: AgentSessionPort | undefined\n  /** 这一格现在的键：真对话 id，或入口那一格的草稿键。 */\n  readonly key: string\n  /** 这一格已经是哪条对话；入口那一格是 null。 */\n  readonly endpoint: string | null\n  readonly text: string\n  /** 这一句带的图片，按它们在原生交付注册表里的位置点名。 */\n  readonly assets: readonly PromptAsset[]\n  readonly configuration: readonly PromptConfiguration[]\n  readonly skills: readonly PromptSkill[]\n  readonly identify?: (() => Promise<string | null>) | undefined\n  readonly onUserMessage?: ((threadId: string, text: string) => void) | undefined\n}\n\ninterface PendingSubmission {\n  key: string\n  readonly port: AgentSessionPort\n  threadId: string | null\n  acknowledged: boolean\n  cancelRequested: boolean\n  settled: boolean\n  deadline: ReturnType<typeof setTimeout> | null\n}\n\nconst CANCELLATION_DEADLINE_MS = ${cancellationDeadlineMs}\n`,
      ),
      rule(
        'make paint scheduling single-shot',
        '  let settled = false\n  let frame: number | null = null',
        `  const ceiling = setTimeout(flush, FLUSH_CEILING_MS)\n\n  requestAnimationFrame(() => {\n    clearTimeout(ceiling)\n    flush()\n  })`,
        `  let settled = false\n  let frame: number | null = null\n  let ceiling: ReturnType<typeof setTimeout>\n\n  const finish = () => {\n    if (settled) {\n      return\n    }\n\n    settled = true\n    clearTimeout(ceiling)\n\n    if (frame !== null) {\n      cancelAnimationFrame(frame)\n    }\n\n    flush()\n  }\n\n  ceiling = setTimeout(finish, FLUSH_CEILING_MS)\n  frame = requestAnimationFrame(finish)`,
      ),
      rule(
        'own pending submissions in the transcript store',
        '#submissions = new Map<string, PendingSubmission>()',
        '  #opening = 0\n\n  /**\n   * 收到了、还没折进转录的帧，按对话攒着。',
        '  #opening = 0\n\n  #submissions = new Map<string, PendingSubmission>()\n\n  /**\n   * 收到了、还没折进转录的帧，按对话攒着。',
      ),
      rule(
        'release submissions with their conversation',
        '    this.#releaseSubmission(real)\n    this.#held.delete(real)',
        '    this.#held.delete(real)\n    this.#pending.delete(real)',
        '    this.#releaseSubmission(real)\n    this.#held.delete(real)\n    this.#pending.delete(real)',
      ),
      rule(
        'register submission before asynchronous setup',
        '    const submission: PendingSubmission = {',
        `    this.#attach(port)\n\n    const conversation =`,
        `    this.#attach(port)\n\n    const real = this.#resolveKey(key)\n    this.#releaseSubmission(real)\n\n    const submission: PendingSubmission = {\n      key: real,\n      port,\n      threadId: endpoint,\n      acknowledged: false,\n      cancelRequested: false,\n      settled: false,\n      deadline: null,\n    }\n\n    this.#submissions.set(real, submission)\n\n    const conversation =`,
      ),
      rule(
        'release a submission with no conversation',
        '          this.#releaseSubmission(submission)\n          this.#fail(key, new Error(NO_THREAD))',
        '        if (threadId === null) {\n          this.#fail(key, new Error(NO_THREAD))',
        '        if (threadId === null) {\n          this.#releaseSubmission(submission)\n          this.#fail(key, new Error(NO_THREAD))',
      ),
      rule(
        'stop before prompt dispatch when cancellation wins setup',
        '        submission.threadId = threadId\n\n        if (submission.cancelRequested) {',
        `        if (threadId !== key) {\n          this.#rename(key, threadId)\n        }\n\n        /*\n         * 用来命名的那句话`,
        `        if (threadId !== key) {\n          this.#rename(key, threadId)\n        }\n\n        submission.threadId = threadId\n\n        if (submission.cancelRequested) {\n          this.#finishCancellation(submission)\n          this.#releaseSubmission(submission)\n\n          return undefined\n        }\n\n        /*\n         * 用来命名的那句话`,
      ),
      rule(
        'retry cancellation after prompt acknowledgement',
        '          submission.acknowledged = true',
        `        return port.prompt({ threadId, text, assets, configuration, skills }).then((handle) => {\n          /*\n           * 这条对话的会话号只有这里知道：新建的对话在开口之前没有号可登记。\n           * 登记的同时把跑在地址前面的那批帧折进去（见 route）。\n           */\n          this.route(handle.sessionId, threadId)\n        })`,
        `        return port.prompt({ threadId, text, assets, configuration, skills }).then((handle) => {\n          submission.acknowledged = true\n          this.route(handle.sessionId, threadId)\n\n          if (submission.cancelRequested) {\n            this.#sendCancellation(submission)\n          }\n        })`,
      ),
      rule(
        'separate cancelled setup from failed setup',
        '        if (submission.cancelRequested) {\n          this.#finishCancellation(submission)',
        `      .catch((cause: unknown) => {\n        /* 没有"当前那一轮"要收拾了：这一轮从来没拿到过地址，也就从来没占过谁。 */\n        this.#fail(key, cause)\n      })`,
        `      .catch((cause: unknown) => {\n        if (submission.cancelRequested) {\n          this.#finishCancellation(submission)\n          this.#releaseSubmission(submission)\n\n          return\n        }\n\n        this.#releaseSubmission(submission)\n        this.#fail(key, cause)\n      })`,
      ),
      rule(
        'replace fire-and-forget cancellation',
        '    this.#requestCancellation(submission)',
        `  /**\n   * 停掉这条对话上正在跑的那一轮。\n   *\n   * 点名一条对话就够了，地址在端口那一侧：这一层不留任何会过期的取消凭据。\n   *\n   * 入口那一格在开口之前还不是任何一条对话。它没有轮次在飞，也没有会话可发。\n   */\n  cancel = (key: string): void => {\n    const threadId = this.#resolveKey(key)\n    const port = this.#attachedTo\n\n    if (threadId.startsWith(DRAFT) || port === null) {\n      return\n    }\n\n    try {\n      void Promise.resolve(port.cancel(threadId)).catch((cause: unknown) => {\n        this.note(key, describeFailure(cause))\n      })\n    } catch (cause) {\n      this.note(key, describeFailure(cause))\n    }\n  }`,
        `  cancel = (key: string): void => {\n    const threadId = this.#resolveKey(key)\n    const port = this.#attachedTo\n\n    if (port === null) {\n      return\n    }\n\n    let submission = this.#submissions.get(threadId)\n\n    if (submission === undefined) {\n      if (threadId.startsWith(DRAFT)) {\n        return\n      }\n\n      submission = {\n        key: threadId,\n        port,\n        threadId,\n        acknowledged: true,\n        cancelRequested: false,\n        settled: false,\n        deadline: null,\n      }\n      this.#submissions.set(threadId, submission)\n    }\n\n    this.#requestCancellation(submission)\n  }`,
      ),
      rule(
        'add cancellation lifecycle methods',
        '  #requestCancellation(submission: PendingSubmission): void {',
        '  /* 线路只有一条（#attachedTo），答复的地址不必由调用方再交一次 —— 与 cancel 同一个入口。 */\n  resolvePermission = (',
        `  #requestCancellation(submission: PendingSubmission): void {\n    if (submission.cancelRequested) {\n      return\n    }\n\n    submission.cancelRequested = true\n    const current = this.#now(submission.key)\n\n    this.#put(submission.key, {\n      ...current,\n      timeline: requestRunCancellation(current.timeline),\n    })\n\n    if (submission.threadId === null) {\n      this.#finishCancellation(submission)\n\n      return\n    }\n\n    submission.deadline = setTimeout(() => {\n      this.#finishCancellation(submission)\n    }, CANCELLATION_DEADLINE_MS)\n\n    this.#sendCancellation(submission)\n  }\n\n  #sendCancellation(submission: PendingSubmission): void {\n    const threadId = submission.threadId\n\n    if (\n      threadId === null ||\n      !submission.cancelRequested ||\n      this.#submissions.get(submission.key) !== submission\n    ) {\n      return\n    }\n\n    try {\n      void Promise.resolve(submission.port.cancel(threadId)).then(\n        () => {\n          this.#finishCancellation(submission)\n        },\n        (cause: unknown) => {\n          if (!submission.acknowledged) {\n            return\n          }\n\n          this.note(submission.key, describeFailure(cause))\n          this.#finishCancellation(submission)\n        },\n      )\n    } catch (cause) {\n      this.note(submission.key, describeFailure(cause))\n      this.#finishCancellation(submission)\n    }\n  }\n\n  #finishCancellation(submission: PendingSubmission): void {\n    if (this.#submissions.get(submission.key) !== submission) {\n      return\n    }\n\n    if (submission.deadline !== null) {\n      clearTimeout(submission.deadline)\n      submission.deadline = null\n    }\n\n    submission.settled = true\n    const current = this.#now(submission.key)\n\n    this.#put(submission.key, {\n      ...current,\n      timeline: confirmRunCancellation(current.timeline, Date.now()),\n    })\n  }\n\n  #releaseSubmission(target: string | PendingSubmission): void {\n    const submission =\n      typeof target === 'string' ? this.#submissions.get(target) : target\n\n    if (submission === undefined || this.#submissions.get(submission.key) !== submission) {\n      return\n    }\n\n    if (submission.deadline !== null) {\n      clearTimeout(submission.deadline)\n    }\n\n    this.#submissions.delete(submission.key)\n  }\n\n  /* 线路只有一条（#attachedTo），答复的地址不必由调用方再交一次 —— 与 cancel 同一个入口。 */\n  resolvePermission = (`,
      ),
      rule(
        'move submission ownership with a draft rename',
        '    const submission = this.#submissions.get(from)',
        `  #rename(from: string, to: string): void {\n    this.#alias.set(from, to)`,
        `  #rename(from: string, to: string): void {\n    const submission = this.#submissions.get(from)\n\n    if (submission !== undefined) {\n      this.#submissions.delete(from)\n      submission.key = to\n      submission.threadId = to\n      this.#submissions.set(to, submission)\n    }\n\n    this.#alias.set(from, to)`,
      ),
      rule(
        'reconcile cancellation with terminal frames',
        '    const terminal = waiting.some(',
        `    const timeline = applyRunEvents(current.timeline, waiting)\n\n    if (timeline === current.timeline) {\n      return current\n    }\n\n    this.#write(real, { ...current, timeline })`,
        `    const terminal = waiting.some(\n      (event) => event.kind === 'run_finished' || event.kind === 'run_failed',\n    )\n    const submission = this.#submissions.get(real)\n    let timeline = applyRunEvents(current.timeline, waiting)\n\n    if (terminal) {\n      this.#releaseSubmission(real)\n    } else if (submission?.cancelRequested === true) {\n      timeline = submission.settled\n        ? confirmRunCancellation(timeline, Date.now())\n        : requestRunCancellation(timeline)\n    }\n\n    if (timeline === current.timeline) {\n      return current\n    }\n\n    this.#write(real, { ...current, timeline })`,
      ),
    ],
  },
  {
    path: files.turn,
    rules: [
      rule(
        'make KAP the cancellation authority',
        '    // KAP owns turn activity; a local recorder cannot gate cancellation.',
        `    let Some(slot) = live.book.slot(&addressed)? else {\n        return Err(CommandError::state(NOTHING_TO_STOP));\n    };\n\n    if !slot.is_listening() {\n        return Err(CommandError::state(NOTHING_TO_STOP));\n    }\n\n    live.client.cancel(addressed).await?;`,
        `    // KAP owns turn activity; a local recorder cannot gate cancellation.\n    live.client.cancel(addressed).await?;`,
      ),
    ],
  },
  {
    path: files.storeTest,
    rules: [
      rule(
        'allow prompt control in the test port',
        "  prompt: AgentSessionPort['prompt'] = () => Promise.resolve({ sessionId: 'sess_a' }),",
        `function fakePort(cancel: AgentSessionPort['cancel'] = () => Promise.resolve()): {\n  readonly port: AgentSessionPort`,
        `function fakePort(\n  cancel: AgentSessionPort['cancel'] = () => Promise.resolve(),\n  prompt: AgentSessionPort['prompt'] = () => Promise.resolve({ sessionId: 'sess_a' }),\n): {\n  readonly port: AgentSessionPort`,
      ),
      rule(
        'use the injected prompt in tests',
        '      prompt,\n      cancel,',
        "      prompt: () => Promise.resolve({ sessionId: 'sess_a' }),\n      cancel,",
        '      prompt,\n      cancel,',
      ),
      rule(
        'cover cancellation before conversation identity',
        "  it('cancels before a draft can start', async () => {",
        `  it('records a cancellation rejection instead of swallowing it', async () => {`,
        `  it('cancels before a draft can start', async () => {\n    const { store, paint } = painted()\n    let identify: ((threadId: string) => void) | undefined\n    let prompts = 0\n    const { port } = fakePort(undefined, () => {\n      prompts += 1\n\n      return Promise.resolve({ sessionId: 'sess_a' })\n    })\n    const key = store.newDraft()\n\n    store.send({\n      port,\n      key,\n      endpoint: null,\n      identify: () =>\n        new Promise<string>((resolve) => {\n          identify = resolve\n        }),\n      text: '在吗',\n      assets: [],\n      configuration: [],\n      skills: [],\n    })\n    store.cancel(key)\n    identify?.('thread_a')\n    await Promise.resolve()\n    await Promise.resolve()\n    paint()\n\n    expect(prompts).toBe(0)\n    expect(store.read(key).timeline.status).toBe('cancelled')\n  })\n\n  it('records a cancellation rejection instead of swallowing it', async () => {`,
      ),
    ],
  },
]

function countOccurrences(source, needle) {
  let count = 0
  let cursor = 0

  while ((cursor = source.indexOf(needle, cursor)) !== -1) {
    count += 1
    cursor += needle.length
  }

  return count
}

function applyRule(source, path, current) {
  if (source.includes(current.applied)) {
    return { source, changed: false }
  }

  const matches = countOccurrences(source, current.before)

  if (matches !== 1) {
    throw new Error(
      `${path}: ${current.name} expected one anchor, found ${matches}. Refusing a partial refactor.`,
    )
  }

  return {
    source: source.replace(current.before, current.after),
    changed: true,
  }
}

async function verifyRoot() {
  await access(resolve(root, '.git'))
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

  if (packageJson.private !== true || typeof packageJson.scripts?.check !== 'string') {
    throw new Error('Run this script from the poietica repository root.')
  }

  for (const path of Object.values(files)) {
    await access(resolve(root, path))
  }
}

async function writeAtomically(path, content) {
  const destination = resolve(root, path)
  const temporary = `${destination}.refactor-${String(process.pid)}`

  await writeFile(temporary, content, 'utf8')
  await rename(temporary, destination)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })

  if (result.error !== undefined) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}.`)
  }
}

async function main() {
  await verifyRoot()

  const edits = []

  for (const plan of plans) {
    let source = await readFile(resolve(root, plan.path), 'utf8')
    let changed = false

    for (const current of plan.rules) {
      const result = applyRule(source, plan.path, current)
      source = result.source
      changed ||= result.changed
    }

    if (changed) {
      edits.push({ path: plan.path, source })
    }
  }

  if (edits.length === 0) {
    console.log('Turn lifecycle refactor is already applied; nothing changed.')
    return
  }

  for (const edit of edits) {
    await writeAtomically(edit.path, edit.source)
    console.log(`updated ${edit.path}`)
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const tsFiles = edits
    .map((edit) => edit.path)
    .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))

  if (tsFiles.length > 0) {
    run(pnpm, ['exec', 'biome', 'format', '--write', ...tsFiles])
  }

  if (edits.some((edit) => edit.path.endsWith('.rs'))) {
    run('cargo', ['fmt', '--all'])
  }

  run(pnpm, ['check'])
  console.log('Turn cancellation now has one explicit lifecycle and KAP owns abort authority.')
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.stack : cause)
  process.exitCode = 1
})
