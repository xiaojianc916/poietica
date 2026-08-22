#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const REVIEWED_COMMIT = '852099db54f9e2e052ca33662b8bc3708004b0a0'
const root = process.cwd()
const edits = new Map()
const originals = new Map()
const removals = new Map()
const changed = new Set()
const skipped = new Set()

const block = (...lines) => lines.join('\n')
const absolute = (relative) => path.join(root, relative)

class DriftError extends Error {
  constructor(relative, detail) {
    super(`${relative}: ${detail}`)
    this.name = 'DriftError'
  }
}

async function required(relative) {
  try {
    await access(absolute(relative))
  } catch {
    throw new DriftError(
      relative,
      `required repository path is missing; this script targets ${REVIEWED_COMMIT}`,
    )
  }
}

async function sourceOf(relative) {
  if (edits.has(relative)) {
    return edits.get(relative)
  }

  let source
  try {
    source = await readFile(absolute(relative), 'utf8')
  } catch (error) {
    throw new DriftError(relative, `cannot read file: ${String(error)}`)
  }

  originals.set(relative, source)
  return source
}

function occurrences(source, needle) {
  let count = 0
  let cursor = 0

  while (true) {
    const found = source.indexOf(needle, cursor)
    if (found < 0) return count
    count += 1
    cursor = found + needle.length
  }
}

async function replaceOnce(relative, before, after) {
  const source = await sourceOf(relative)

  if (source.includes(after)) {
    skipped.add(relative)
    return
  }

  const count = occurrences(source, before)
  if (count !== 1) {
    throw new DriftError(relative, `expected one baseline anchor, found ${String(count)}`)
  }

  edits.set(relative, source.replace(before, after))
  changed.add(relative)
}

async function replaceSection(relative, start, end, replacement, appliedAnchor) {
  const source = await sourceOf(relative)

  if (source.includes(appliedAnchor)) {
    skipped.add(relative)
    return
  }

  const starts = occurrences(source, start)
  if (starts !== 1) {
    throw new DriftError(relative, `expected one section start, found ${String(starts)}`)
  }

  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (to < 0) {
    throw new DriftError(relative, 'section end anchor is missing')
  }

  edits.set(relative, source.slice(0, from) + replacement + source.slice(to))
  changed.add(relative)
}

function gitBlobSha(source) {
  const bytes = Buffer.from(source)
  return createHash('sha1')
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest('hex')
}

async function removeReviewedFile(relative, expectedBlobSha) {
  let source
  try {
    source = await readFile(absolute(relative), 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      skipped.add(relative)
      return
    }
    throw new DriftError(relative, `cannot read file: ${String(error)}`)
  }

  const actual = gitBlobSha(source)
  if (actual !== expectedBlobSha) {
    throw new DriftError(
      relative,
      `delete refused because blob drifted (expected ${expectedBlobSha}, found ${actual})`,
    )
  }

  originals.set(relative, source)
  removals.set(relative, source)
  changed.add(relative)
}

async function finalSource(relative) {
  return edits.has(relative) ? edits.get(relative) : sourceOf(relative)
}

async function requireFinal(relative, needle) {
  const source = await finalSource(relative)
  if (!source.includes(needle)) {
    throw new DriftError(relative, `postcondition is missing: ${needle}`)
  }
}

async function forbidFinal(relative, needle) {
  const source = await finalSource(relative)
  if (source.includes(needle)) {
    throw new DriftError(relative, `obsolete path survived: ${needle}`)
  }
}

async function commitPlan() {
  const written = []
  const deleted = []

  try {
    for (const [relative, source] of edits) {
      await writeFile(absolute(relative), source, 'utf8')
      written.push(relative)
    }

    for (const relative of removals.keys()) {
      await rm(absolute(relative))
      deleted.push(relative)
    }
  } catch (error) {
    for (const relative of written) {
      const original = originals.get(relative)
      if (original !== undefined) {
        await writeFile(absolute(relative), original, 'utf8').catch(() => undefined)
      }
    }
    for (const relative of deleted) {
      const original = originals.get(relative)
      if (original !== undefined) {
        await writeFile(absolute(relative), original, 'utf8').catch(() => undefined)
      }
    }
    throw error
  }
}

function verifyRepository() {
  const result = spawnSync('pnpm', ['check'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`pnpm check could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`pnpm check failed with exit code ${String(result.status)}`)
  }
}

async function main() {
  for (const relative of [
    'package.json',
    'packages/agent-contract/src/run.ts',
    'packages/agent/src/timeline/timeline-reducer.ts',
    'packages/agent-ui/src/timeline/turn-fold.ts',
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
  ]) {
    await required(relative)
  }

  await replaceOnce(
    'packages/agent-contract/src/run.ts',
    block("export type RunStatus =", "  | 'idle'", "  | 'running'"),
    block("export type RunStatus =", "  | 'idle'", "  | 'submitted'", "  | 'running'"),
  )
  await replaceOnce(
    'packages/agent-contract/src/run.ts',
    'RunStatus above is the truth about the run itself: seven states',
    'RunStatus above is the truth about the run itself: eight states',
  )

  await replaceOnce(
    'packages/agent/src/timeline/timeline-reducer.ts',
    block(
      '  if (',
      "    draft.status === 'running' ||",
      "    draft.status === 'awaiting_permission' ||",
      "    draft.status === 'awaiting_question'",
      '  ) {',
      "    draft.status = 'failed'",
      '  }',
    ),
    block(
      '  if (',
      "    draft.status === 'submitted' ||",
      "    draft.status === 'running' ||",
      "    draft.status === 'awaiting_permission' ||",
      "    draft.status === 'awaiting_question'",
      '  ) {',
      "    draft.status = 'failed'",
      '  }',
    ),
  )
  await replaceOnce(
    'packages/agent/src/timeline/timeline-reducer.ts',
    block(
      '  const busy =',
      "    draft.status === 'running' ||",
      "    draft.status === 'awaiting_permission' ||",
      "    draft.status === 'awaiting_question'",
    ),
    block(
      '  const busy =',
      "    draft.status === 'submitted' ||",
      "    draft.status === 'running' ||",
      "    draft.status === 'awaiting_permission' ||",
      "    draft.status === 'awaiting_question'",
    ),
  )
  await replaceOnce(
    'packages/agent/src/timeline/timeline-reducer.ts',
    block('  if (!busy) {', '    openSegment(draft)', "    draft.status = 'running'", '  }'),
    block('  if (!busy) {', '    openSegment(draft)', "    draft.status = 'submitted'", '  }'),
  )

  await replaceOnce(
    'packages/agent/src/timeline/projection.ts',
    block("    case 'run_started': {", "      draft.status = 'running'"),
    block("    case 'run_started': {", "      draft.status = 'submitted'"),
  )

  await replaceOnce(
    'packages/agent/src/timeline/timeline-draft.ts',
    '  draft.spans[draft.spans.length - 1] = { ...open, firstFrameAt: item.at }',
    block(
      '  draft.spans[draft.spans.length - 1] = { ...open, firstFrameAt: item.at }',
      '',
      "  if (draft.status === 'submitted') {",
      "    draft.status = 'running'",
      '  }',
    ),
  )

  await replaceOnce(
    'packages/agent/src/timeline/timeline-queries.ts',
    block(
      '  return (',
      "    state.status === 'running' ||",
      "    state.status === 'awaiting_permission' ||",
      "    state.status === 'awaiting_question'",
      '  )',
    ),
    block(
      '  return (',
      "    state.status === 'submitted' ||",
      "    state.status === 'running' ||",
      "    state.status === 'awaiting_permission' ||",
      "    state.status === 'awaiting_question'",
      '  )',
    ),
  )

  await replaceOnce(
    'packages/agent-ui/src/session/use-assistant-session.ts',
    block('  switch (status) {', "    case 'running':"),
    block(
      '  switch (status) {',
      "    case 'submitted':",
      "      return 'submitted'",
      "    case 'running':",
    ),
  )

  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    "import { AttachIcon, SpinnerIcon, StopIcon, SubmitIcon } from '../primitives/icons'",
    "import { AttachIcon, StopIcon, SubmitIcon } from '../primitives/icons'",
  )
  await replaceOnce(
    'packages/agent-ui/src/composer/prompt-input.tsx',
    block(
      "  const isStreaming = status === 'streaming'",
      "  const Icon = isStreaming ? StopIcon : status === 'submitted' ? SpinnerIcon : SubmitIcon",
      '',
      '  return (',
      '    <button',
      '      {...props}',
      "      aria-label={isStreaming ? '停止生成' : '发送'}",
      '      className={className}',
      '      data-slot="prompt-input-submit"',
      '      data-status={status}',
      '      disabled={disabled ?? (!isStreaming && !canSubmitDraft(draft))}',
      '      onClick={isStreaming ? onCancel : undefined}',
      "      type={isStreaming ? 'button' : 'submit'}",
    ),
    block(
      "  const canCancel = status === 'submitted' || status === 'streaming'",
      '  const Icon = canCancel ? StopIcon : SubmitIcon',
      '',
      '  return (',
      '    <button',
      '      {...props}',
      "      aria-label={canCancel ? '停止生成' : '发送'}",
      '      className={className}',
      '      data-slot="prompt-input-submit"',
      '      data-status={status}',
      '      disabled={disabled ?? (!canCancel && !canSubmitDraft(draft))}',
      '      onClick={canCancel ? onCancel : undefined}',
      "      type={canCancel ? 'button' : 'submit'}",
    ),
  )

  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block(
      '  /**',
      '   * 这一段还没有结论的工作，按转录顺序。',
      '   *',
      '   * 它不在 rows 里，所以列表在一轮之内只会追加。读者是转录尾部那块瞬态区 —— 那里在虚拟',
      '   * 器的条目表之外，改动只经过 paddingEnd，不碰 count、不碰 getItemKey，也不作废任何一',
      '   * 行的实测高度。',
      '   */',
      '  readonly live: readonly FeedRow[]',
      '  /**',
      '   * 这一轮在跑，而屏幕上没有一样东西在动。',
      '   *',
      '   * 等待指示器唯一的出现条件。判据全在这一层：轮次在跑（span 的两端）、瞬态区里',
      '   * 没有在飞的调用、回答也不在流式追加。问的是屏幕，答案就该由算出屏幕内容的这',
      '   * 一处给出。',
      '   */',
      '  readonly thinking: boolean',
    ),
    block(
      '  /** In-flight process rows rendered outside the virtualized transcript. */',
      '  readonly live: readonly FeedRow[]',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block('  live: NO_FEED_ROWS,', '  thinking: false,'),
    '  live: NO_FEED_ROWS,',
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block('  readonly live: readonly FeedRow[]', '  readonly thinking: boolean', '  readonly seal:'),
    block('  readonly live: readonly FeedRow[]', '  readonly seal:'),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block(
      '    seals: sealed.seals,',
      '    live: sealed.live,',
      '    /* 只有最后一轮可能在跑，所以「有没有在等」只问它。 */',
      '    thinking: (lastTurn === undefined ? undefined : folds.get(lastTurn))?.thinking === true,',
    ),
    block('    seals: sealed.seals,', '    live: sealed.live,'),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block(
      '  /* 模型有没有真的开过口：收到过第一帧内容（firstFrameAt，思考不上屏所以这里才要它），',
      '     或者这一轮已经有话上屏 —— 哪怕只是一行报错，落定后就不是空碑。 */',
      '  const spoke = span?.firstFrameAt !== undefined || own.some((at) => rows[at]?.item.type !== SAID)',
      '  /* 碑要有地方挂：这一轮的提问就是它的位置，而重连接续上的轮次连开头都没有。 */',
      '  const saidAt = saidIn(rows, own)',
      '  /* 可点 ⟺ 真有东西可收。什么都没收起时封条只是一行字，不给假按钮。 */',
      '  const seal =',
      '    saidAt === undefined || !spoke ? undefined : sealOf(turn, span, isOpen, process.length > 0)',
    ),
    block(
      '  /* The seal needs both a visible anchor and observed agent activity. */',
      '  const saidAt = saidIn(rows, own)',
      '  const seal =',
      '    saidAt === undefined || span?.firstFrameAt === undefined',
      '      ? undefined',
      '      : sealOf(turn, span, isOpen, process.length > 0)',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block(
      '    live,',
      '    /* 在飞的调用与流式追加各自就是进度，再挂一行转圈是两个人报同一件事。 */',
      '    thinking:',
      '      running &&',
      '      !live.some((row) => row.isInFlight) &&',
      '      !own.some((at) => rows[at]?.isStreamingTail === true),',
      '    seal,',
    ),
    block('    live,', '    seal,'),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/turn-fold.ts',
    block(
      '  if (span === undefined || (span.startedAt === undefined && !hasProcess)) {',
      '    return undefined',
      '  }',
      '',
      '  return { turn, startedAt: span.startedAt, endedAt: span.endedAt, hasProcess, isOpen }',
    ),
    block(
      '  if (span?.firstFrameAt === undefined) {',
      '    return undefined',
      '  }',
      '',
      '  return { turn, startedAt: span.firstFrameAt, endedAt: span.endedAt, hasProcess, isOpen }',
    ),
  )

  await replaceOnce(
    'packages/agent-ui/src/timeline/transcript-view.tsx',
    "import { ThinkingIndicator } from './thinking-indicator'\n",
    '',
  )
  await replaceSection(
    'packages/agent-ui/src/timeline/transcript-view.tsx',
    block('  /*', '   * 尾部装的是属于这一轮、而不属于其中某一条的东西：瞬态区说「此刻在做什么」，等待'),
    '  const overlay = useCallback(',
    block(
      '  /* Live process rows are the single execution-progress surface. */',
      '  const footer = <LiveProcess renderRow={renderLiveRow} rows={groupedLive.rows} />',
      '',
    ),
    'Live process rows are the single execution-progress surface.',
  )

  await replaceOnce(
    'packages/agent/src/session/transcript-store.ts',
    block(
      '  cancel = (key: string): void => {',
      '    const threadId = this.#resolveKey(key)',
      '',
      '    if (threadId.startsWith(DRAFT)) {',
      '      return',
      '    }',
      '',
      '    void this.#attachedTo?.cancel(threadId)',
      '  }',
    ),
    block(
      '  cancel = (key: string): void => {',
      '    const threadId = this.#resolveKey(key)',
      '    const port = this.#attachedTo',
      '',
      '    if (threadId.startsWith(DRAFT) || port === null) {',
      '      return',
      '    }',
      '',
      '    try {',
      '      void Promise.resolve(port.cancel(threadId)).catch((cause: unknown) => {',
      '        this.note(key, describeFailure(cause))',
      '      })',
      '    } catch (cause) {',
      '      this.note(key, describeFailure(cause))',
      '    }',
      '  }',
    ),
  )

  await replaceOnce(
    'crates/agent-runtime/src/sessions.rs',
    block('    /// How many sessions are open.', '    pub fn open_count(&self) -> Result<usize> {'),
    block(
      '    /// Ends every turn still owned by this connection.',
      '    pub fn fail_active(&self, message: &str) -> Result<usize> {',
      '        let slots = self.book()?.values().cloned().collect::<Vec<RunSlot>>();',
      '        let mut failed = 0;',
      '',
      '        for slot in slots {',
      '            if let Some(mut recorder) = slot.take()? {',
      '                recorder.record_pending_cancelled();',
      '                recorder.record_run_failed(message);',
      '                failed += 1;',
      '            }',
      '        }',
      '',
      '        Ok(failed)',
      '    }',
      '',
      '    /// How many sessions are open.',
      '    pub fn open_count(&self) -> Result<usize> {',
    ),
  )
  await replaceOnce(
    'crates/agent-runtime/src/sessions.rs',
    block('    use super::SessionBook;', '    use crate::run_slot::RunSlot;'),
    block(
      '    use std::sync::{Arc, Mutex};',
      '',
      '    use super::SessionBook;',
      '    use crate::frame::RunFrame;',
      '    use crate::recorder::{RecordedEvent, Recorder};',
      '    use crate::run_slot::RunSlot;',
    ),
  )
  await replaceOnce(
    'crates/agent-runtime/src/sessions.rs',
    block(
      '    #[test]',
      '    fn adopting_a_known_name_does_not_open_a_second_session() {',
      '        let book = SessionBook::new();',
      '',
      '        assert!(book.open(NAME).is_ok());',
      '        assert!(book.adopt(NAME, RunSlot::new()).is_ok());',
      '        assert!(matches!(book.open_count(), Ok(1)));',
      '    }',
      '}',
    ),
    block(
      '    #[test]',
      '    fn adopting_a_known_name_does_not_open_a_second_session() {',
      '        let book = SessionBook::new();',
      '',
      '        assert!(book.open(NAME).is_ok());',
      '        assert!(book.adopt(NAME, RunSlot::new()).is_ok());',
      '        assert!(matches!(book.open_count(), Ok(1)));',
      '    }',
      '',
      '    #[test]',
      '    fn connection_loss_ends_the_turn_it_owned() {',
      '        let book = SessionBook::new();',
      '        let opened = book.open(NAME);',
      '        assert!(opened.is_ok());',
      '        let Some(slot) = opened.ok() else {',
      '            return;',
      '        };',
      '        let seen = Arc::new(Mutex::new(Vec::<RecordedEvent>::new()));',
      '        let delivered = Arc::clone(&seen);',
      '        let recorder = Recorder::new(',
      '            NAME.to_owned(),',
      '            slot.seq(),',
      '            Box::new(move |event| {',
      '                if let Ok(mut events) = delivered.lock() {',
      '                    events.push(event);',
      '                }',
      '            }),',
      '        );',
      '',
      '        assert!(slot.install(recorder).is_ok());',
      '        assert!(matches!(book.fail_active("agent connection lost"), Ok(1)));',
      '        assert!(seen.lock().is_ok_and(|events| {',
      '            events',
      '                .last()',
      '                .is_some_and(|event| matches!(&event.frame, RunFrame::RunFailed { .. }))',
      '        }));',
      '        assert!(!slot.is_listening());',
      '    }',
      '}',
    ),
  )

  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    'use std::sync::{Mutex, MutexGuard};',
    block(
      'use std::sync::atomic::{AtomicBool, Ordering};',
      'use std::sync::{Arc, Mutex, MutexGuard};',
    ),
  )
  await replaceSection(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    '    /// 这条连接锚会话的记录槽。',
    '    /// 这条连接的权限台。',
    '',
    'struct ConnectionLease(AtomicBool);',
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    '#[derive(Debug)]\nstruct Connection {',
    block(
      '#[derive(Debug)]',
      'struct ConnectionLease(AtomicBool);',
      '',
      'impl ConnectionLease {',
      '    const fn new() -> Self {',
      '        Self(AtomicBool::new(true))',
      '    }',
      '',
      '    fn close(&self) {',
      '        self.0.store(false, Ordering::Release);',
      '    }',
      '',
      '    fn is_open(&self) -> bool {',
      '        self.0.load(Ordering::Acquire)',
      '    }',
      '}',
      '',
      '#[derive(Debug)]',
      'struct Connection {',
    ),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block('struct Connection {', '    client: AgentClient,'),
    block('struct Connection {', '    client: AgentClient,', '    lease: Arc<ConnectionLease>,'),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block(
      '    pub(super) fn disconnect(&self) -> Result<()> {',
      '        retire(lock(&self.connection)?.take());',
      '        Ok(())',
      '    }',
    ),
    block(
      '    pub(super) fn disconnect(&self) -> Result<()> {',
      '        retire(lock(&self.connection)?.take());',
      '        Ok(())',
      '    }',
      '',
      '    fn expire(&self, lease: &Arc<ConnectionLease>) -> Result<()> {',
      '        let retired = {',
      '            let mut connection = lock(&self.connection)?;',
      '',
      '            if connection',
      '                .as_ref()',
      '                .is_some_and(|live| Arc::ptr_eq(&live.lease, lease))',
      '            {',
      '                connection.take()',
      '            } else {',
      '                None',
      '            }',
      '        };',
      '',
      '        retire(retired);',
      '        Ok(())',
      '    }',
    ),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block(
      '    // The process is going away either way, so a driver that already',
      '    // stopped is not an error worth reporting.',
      '    let _ignored = gone.client.shutdown();',
      '',
      '    /* 拿出来就丢掉。RunSlot::take 的文档写的是把这一位交回去、好让它自己',
      '    收尾，而丢掉正是让它收尾。 */',
      '    let _abandoned = gone.slot.take();',
      '',
      '    gone.desk.clear();',
    ),
    block(
      '    gone.lease.close();',
      '',
      '    // The process is going away either way, so a driver that already',
      '    // stopped is not an error worth reporting.',
      '    let _ignored = gone.client.shutdown();',
      '',
      '    if let Err(error) = gone',
      '        .book',
      '        .fail_active("agent 连接已断开，本轮已终止，请重试")',
      '    {',
      '        log::error!("could not terminate turns owned by a dead connection: {error}");',
      '    }',
      '',
      '    gone.desk.clear();',
    ),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block(
      '    // The crate is runtime-agnostic on purpose; this is the composition root,',
      '    // so this is where the driver gets an executor.',
      '    async_runtime::spawn(async move {',
      '        if let Err(error) = driver.await {',
      '            log::error!("the agent session ended: {error}");',
      '        }',
      '    });',
    ),
    block(
      '    // The composition root owns both the driver and the connection lease.',
      '    let lease = Arc::new(ConnectionLease::new());',
      '    let expired = Arc::clone(&lease);',
      '    let runtime = app.clone();',
      '',
      '    async_runtime::spawn(async move {',
      '        let outcome = driver.await;',
      '',
      '        expired.close();',
      '        if let Err(error) = runtime.state::<AgentRuntime>().expire(&expired) {',
      '            log::error!("could not retire the ended agent connection: {error}");',
      '        }',
      '        if let Err(error) = outcome {',
      '            log::error!("the agent session ended: {error}");',
      '        }',
      '    });',
    ),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block(
      '    *lock(&state.connection)? = Some(Connection {',
      '        client: client.clone(),',
      '        agent_id: agent_id.clone(),',
      '        anchor: session_id.clone(),',
      '        slot: slot.clone(),',
      '        desk: desk.clone(),',
      '        questions: questions.clone(),',
      '        book: book.clone(),',
      '    });',
    ),
    block(
      '    let kept = Connection {',
      '        client: client.clone(),',
      '        lease: Arc::clone(&lease),',
      '        agent_id: agent_id.clone(),',
      '        anchor: session_id.clone(),',
      '        desk: desk.clone(),',
      '        questions: questions.clone(),',
      '        book: book.clone(),',
      '    };',
      '',
      '    if !lease.is_open() {',
      '        retire(Some(kept));',
      '        return Err(translate(KapError::Refused(Refusal::Gone)));',
      '    }',
      '',
      '    *lock(&state.connection)? = Some(kept);',
    ),
  )
  await replaceOnce(
    'apps/desktop/src-tauri/src/commands/agent/runtime.rs',
    block(
      "pub(super) fn borrow(state: &State<'_, AgentRuntime>) -> Result<Option<Handle>> {",
      '    let guard = lock(&state.connection)?;',
      '',
      '    Ok(guard.as_ref().map(|live| Handle {',
      '        client: live.client.clone(),',
      '        agent_id: live.agent_id.clone(),',
      '        anchor: live.anchor.clone(),',
      '        desk: live.desk.clone(),',
      '        questions: live.questions.clone(),',
      '        book: live.book.clone(),',
      '    }))',
      '}',
    ),
    block(
      "pub(super) fn borrow(state: &State<'_, AgentRuntime>) -> Result<Option<Handle>> {",
      '    let mut guard = lock(&state.connection)?;',
      '',
      '    if guard.as_ref().is_some_and(|live| !live.lease.is_open()) {',
      '        let stale = guard.take();',
      '        drop(guard);',
      '        retire(stale);',
      '',
      '        return Ok(None);',
      '    }',
      '',
      '    Ok(guard.as_ref().map(|live| Handle {',
      '        client: live.client.clone(),',
      '        agent_id: live.agent_id.clone(),',
      '        anchor: live.anchor.clone(),',
      '        desk: live.desk.clone(),',
      '        questions: live.questions.clone(),',
      '        book: live.book.clone(),',
      '    }))',
      '}',
    ),
  )

  await replaceOnce(
    'packages/agent/src/timeline/__tests__/prompted-run.test.ts',
    "    expect(state.status).toBe('running')",
    "    expect(state.status).toBe('submitted')",
  )

  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    block(
      'function settled(turn: number, startedAt: number, endedAt: number): TurnSpan {',
      '  return { turn, startedAt, endedAt }',
      '}',
      '',
      'function running(turn: number, startedAt: number): TurnSpan {',
      '  return { turn, startedAt }',
      '}',
      '',
      'function heard(turn: number, startedAt: number, firstFrameAt: number): TurnSpan {',
      '  return { turn, startedAt, firstFrameAt }',
      '}',
    ),
    block(
      'function settled(',
      '  turn: number,',
      '  startedAt: number,',
      '  endedAt: number,',
      '  firstFrameAt = startedAt,',
      '): TurnSpan {',
      '  return { turn, startedAt, firstFrameAt, endedAt }',
      '}',
      '',
      'function withoutActivity(turn: number, startedAt: number, endedAt?: number): TurnSpan {',
      '  return { turn, startedAt, endedAt }',
      '}',
      '',
      'function running(turn: number, startedAt: number, firstFrameAt = startedAt): TurnSpan {',
      '  return { turn, startedAt, firstFrameAt }',
      '}',
      '',
      'function heard(turn: number, startedAt: number, firstFrameAt: number): TurnSpan {',
      '  return { turn, startedAt, firstFrameAt }',
      '}',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    "      startedAt: 1_000,\n      /* 这一轮还在跑：没有终点，封条继续跳字。 */",
    "      startedAt: 1_000,\n      /* 这一轮还在跑：没有终点，封条继续跳字。 */",
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    'const feed = foldFeed([said(\'q\', 0, 1_000)], [running(0, 1_000)], new Set())',
    "const feed = foldFeed([said('q', 0, 1_000)], [withoutActivity(0, 1_000)], new Set())",
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    block(
      "    const feed = foldFeed([said('q', 0, 1_000)], [heard(0, 1_000, 1_200)], new Set())",
      '',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 1_000,',
    ),
    block(
      "    const feed = foldFeed([said('q', 0, 1_000)], [heard(0, 1_000, 1_200)], new Set())",
      '',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 1_200,',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    "const feed = foldFeed([said('q', 0, 1_000)], [settled(0, 1_000, 4_000)], new Set())",
    "const feed = foldFeed([said('q', 0, 1_000)], [withoutActivity(0, 1_000, 4_000)], new Set())",
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    block(
      "  it('measures a turn that produced nothing from the moment it began', () => {",
      '    /* 只有一行报错也算有过内容：落定后一行都没有才是空碑，这里不立。 */',
      "    const rows = [said('q', 0, 1_000), broke('e', 0, 7_000)]",
      '    const feed = foldFeed(rows, [settled(0, 1_000, 7_000)], new Set())',
      '',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 1_000,',
      '      endedAt: 7_000,',
      '      hasProcess: false,',
      '      isOpen: false,',
      '    })',
      '  })',
    ),
    block(
      "  it('does not create a processing seal for a direct failure', () => {",
      "    const rows = [said('q', 0, 1_000), broke('e', 0, 7_000)]",
      '    const feed = foldFeed(rows, [withoutActivity(0, 1_000, 7_000)], new Set())',
      '',
      '    expect(feed.seals.size).toBe(0)',
      '  })',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    block(
      "    const feed = foldFeed(rows, [settled(0, 1_000, 31_000)], new Set())",
      '',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 1_000,',
    ),
    block(
      "    const feed = foldFeed(rows, [settled(0, 1_000, 31_000, 2_000)], new Set())",
      '',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 2_000,',
    ),
  )
  await replaceOnce(
    'packages/agent-ui/src/timeline/__tests__/turn-fold.test.ts',
    block(
      "    const feed = foldFeed(rows, [settled(0, 1_000, 4_500)], new Set())",
      '',
      '    expect(feed.rows).toBe(rows)',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 1_000,',
    ),
    block(
      "    const feed = foldFeed(rows, [settled(0, 1_000, 4_500, 2_000)], new Set())",
      '',
      '    expect(feed.rows).toBe(rows)',
      "    expect(feed.seals.get('q')).toEqual({",
      '      turn: 0,',
      '      startedAt: 2_000,',
    ),
  )

  await replaceOnce(
    'packages/agent/src/session/__tests__/transcript-store.test.ts',
    block(
      'function fakePort(): {',
      '  readonly port: AgentSessionPort',
    ),
    block(
      "function fakePort(cancel: AgentSessionPort['cancel'] = () => Promise.resolve()): {",
      '  readonly port: AgentSessionPort',
    ),
  )
  await replaceOnce(
    'packages/agent/src/session/__tests__/transcript-store.test.ts',
    '      cancel: () => Promise.resolve(),',
    '      cancel,',
  )
  await replaceOnce(
    'packages/agent/src/session/__tests__/transcript-store.test.ts',
    block(
      "  it('一拍里来两百段文字，界面只被叫醒一次', () => {",
      '    const { store, paint } = painted()',
    ),
    block(
      "  it('records a cancellation rejection instead of swallowing it', async () => {",
      '    const { store, paint } = painted()',
      "    const { port } = fakePort(() => Promise.reject(new Error('stop refused'))) ",
      '',
      '    store.ensure(port)',
      "    store.route('sess_a', 'thread_a')",
      "    store.cancel('thread_a')",
      '    await Promise.resolve()',
      '    await Promise.resolve()',
      '    paint()',
      '',
      "    expect(store.read('thread_a').timeline.items.at(-1)).toMatchObject({",
      "      type: 'error',",
      "      message: 'Error: stop refused',",
      '    })',
      '  })',
      '',
      "  it('一拍里来两百段文字，界面只被叫醒一次', () => {",
      '    const { store, paint } = painted()',
    ),
  )

  await removeReviewedFile(
    'packages/agent-ui/src/timeline/thinking-indicator.tsx',
    '29123a84414adcf8b1cfe4f38421fd12ad4ca30d',
  )
  await removeReviewedFile(
    'packages/agent-ui/src/timeline/thinking-indicator.css',
    'fbb67d7df63a5bf892d3ed5c66d89a2616143bb0',
  )

  await requireFinal('packages/agent-contract/src/run.ts', "| 'submitted'")
  await requireFinal('packages/agent/src/timeline/timeline-draft.ts', "draft.status = 'running'")
  await requireFinal('packages/agent-ui/src/timeline/turn-fold.ts', 'startedAt: span.firstFrameAt')
  await requireFinal('crates/agent-runtime/src/sessions.rs', 'pub fn fail_active')
  await requireFinal('apps/desktop/src-tauri/src/commands/agent/runtime.rs', 'struct ConnectionLease')
  await forbidFinal('packages/agent-ui/src/timeline/turn-fold.ts', 'readonly thinking: boolean')
  await forbidFinal('packages/agent-ui/src/timeline/transcript-view.tsx', 'ThinkingIndicator')
  await forbidFinal('packages/agent/src/session/transcript-store.ts', 'void this.#attachedTo?.cancel')
  await forbidFinal('apps/desktop/src-tauri/src/commands/agent/runtime.rs', 'slot: RunSlot,')

  if (changed.size === 0) {
    console.log('Execution lifecycle refactor is already applied.')
  } else {
    await commitPlan()
    console.log(`Applied ${String(changed.size)} reviewed file changes.`)
  }

  verifyRepository()
  console.log('pnpm check passed.')
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
