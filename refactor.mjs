#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const staged = new Map()
const skipped = []

function occurrences(text, needle) {
  let count = 0
  let offset = 0

  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }

  return count
}

async function source(relative) {
  if (staged.has(relative)) return staged.get(relative)
  return readFile(path.join(root, relative), 'utf8')
}

async function replaceOnce(relative, before, after, marker = after) {
  const input = await source(relative)

  if (input.includes(marker) && !input.includes(before)) {
    skipped.push(relative)
    return
  }

  const count = occurrences(input, before)
  if (count !== 1) {
    throw new Error(`${relative}: expected one exact anchor, found ${count}`)
  }

  staged.set(relative, input.replace(before, after))
}

async function replacePattern(relative, pattern, after, marker) {
  const input = await source(relative)

  if (input.includes(marker)) {
    skipped.push(relative)
    return
  }

  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...input.matchAll(new RegExp(pattern.source, flags))]
  if (matches.length !== 1) {
    throw new Error(`${relative}: expected one structural anchor, found ${matches.length}`)
  }

  staged.set(relative, input.replace(pattern, after))
}

async function verifyRepository() {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== 'poietica') {
    throw new Error('refactor.mjs must be run from the poietica repository root')
  }

  await readFile(path.join(root, 'AGENTS.md'), 'utf8')
}

await verifyRepository()

const turn = 'apps/desktop/src-tauri/src/commands/agent/turn.rs'
await replaceOnce(
  turn,
  'use std::sync::Arc;\n',
  'use std::sync::Arc;\nuse std::sync::mpsc::{Receiver as SyncReceiver, RecvTimeoutError, sync_channel};\n',
  'Receiver as SyncReceiver',
)
await replaceOnce(turn, 'use tokio::time::{Instant, timeout_at};\n', 'use std::time::Instant;\n', 'use std::time::Instant;')

const durablePipeline = String.raw`const FRAME_EVENT_QUEUE_CAPACITY: usize = 512;
const FRAME_BATCH_QUEUE_CAPACITY: usize = 8;

fn logging(app: AppHandle, thread: Uuid) -> FrameSink {
    let (arrived, arriving) = sync_channel::<RecordedEvent>(FRAME_EVENT_QUEUE_CAPACITY);
    let (shaped, batches) = mpsc::channel::<Vec<RecordedFrame>>(FRAME_BATCH_QUEUE_CAPACITY);

    std::thread::spawn(move || batch_frames(arriving, shaped));
    async_runtime::spawn(recording(app, thread, batches));

    Box::new(move |event| {
        if arrived.send(event).is_err() {
            log::error!("durable frame pipeline stopped before accepting an event");
        }
    })
}

fn batch_frames(arriving: SyncReceiver<RecordedEvent>, shaped: mpsc::Sender<Vec<RecordedFrame>>) {
    while let Ok(first) = arriving.recv() {
        let deadline = Instant::now() + FRAME_INTERVAL;
        let mut held = vec![first];
        let disconnected = loop {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break false;
            };

            match arriving.recv_timeout(remaining) {
                Ok(event) => held.push(event),
                Err(RecvTimeoutError::Timeout) => break false,
                Err(RecvTimeoutError::Disconnected) => break true,
            }
        };

        if shaped.blocking_send(recorded(held.into_iter())).is_err() {
            return;
        }

        if disconnected {
            return;
        }
    }
}

async fn recording(
    app: AppHandle,
    thread: Uuid,
    mut arriving: mpsc::Receiver<Vec<RecordedFrame>>,
) {
    while let Some(logged) = arriving.recv().await {
        let persisted = app
            .state::<Arc<AsyncMutex<LocalIndex>>>()
            .on_index({
                let logged = &logged;
                move |index| index.record_frames(thread, logged)
            })
            .await;

        match persisted {
            Ok(0) => {
                let shown: Vec<&RawValue> = logged.iter().map(|frame| frame.payload.as_ref()).collect();
                if let Err(error) = app.emit(AGENT_EVENT, &shown) {
                    log::warn!("emit agent event failed: {error}");
                }
            }
            Ok(refused) => {
                log::error!(
                    "durable frame pipeline refused {refused} frames; unpublished batch retained on disk"
                );
            }
            Err(error) => {
                log::error!("persist agent event batch failed; batch was not published: {error}");
            }
        }
    }
}

/// 一批帧，成形一次`

await replacePattern(
  turn,
  /fn logging\(\n    app: AppHandle,\n    thread: Uuid,\n\) -> FrameSink \{[\s\S]*?\n\}\n\n\/\/\/ 一批帧，成形一次/,
  durablePipeline,
  'FRAME_EVENT_QUEUE_CAPACITY',
)

const driver = 'crates/agent-runtime/src/driver.rs'
const activityArm = String.raw`        "event.session.work_changed" => {
            if payload.get("busy").and_then(Value::as_bool) == Some(false) {
                let last_turn_reason = payload
                    .get("last_turn_reason")
                    .and_then(Value::as_str)
                    .unwrap_or("failed");
                let outstanding = Outstanding {
                    approvals: std::mem::take(&mut state.pending_approvals),
                    questions: std::mem::take(&mut state.pending_questions),
                };

                if let Ok(Some(slot)) = book.slot(session_id)
                    && let Ok(Some(mut recorder)) = slot.take()
                {
                    recorder.record_pending_cancelled();
                    match last_turn_reason {
                        "completed" | "cancelled" => {
                            recorder.record_run_finished(last_turn_reason);
                        }
                        _ => recorder.record_run_failed(
                            "KAP ended the work aggregate without a terminal error event; check model quota, authentication, and connectivity.",
                        ),
                    }
                }

                desk.abandon(outstanding.approvals);
                questions.abandon(outstanding.questions);

                let _sent = events_tx.unbounded_send(SessionEvent::Cursor {
                    session_id: session_id.to_owned(),
                    seq,
                    epoch: epoch.to_owned(),
                });
            }
        }
        "turn.ended" => {`
await replaceOnce(
  driver,
  '        "turn.ended" => {',
  activityArm,
  'KAP ended the work aggregate without a terminal error event',
)

const transcript = 'packages/agent/src/session/transcript-store.ts'
await replaceOnce(
  transcript,
  '  requestRunCancellation,\n',
  '  rejectRunCancellation,\n  requestRunCancellation,\n',
  '  rejectRunCancellation,',
)
await replaceOnce(
  transcript,
  String.raw`interface PendingSubmission {
  readonly key: string
  readonly port: AgentSessionPort
  threadId: string | null
  acknowledged: boolean
  cancelRequested: boolean
  settled: boolean
  deadline: ReturnType<typeof setTimeout> | null
}`,
  String.raw`interface PendingSubmission {
  readonly key: string
  readonly port: AgentSessionPort
  threadId: string | null
  cancelRequested: boolean
  cancelSent: boolean
}`,
  '  cancelSent: boolean',
)
await replaceOnce(transcript, 'const CANCELLATION_DEADLINE_MS = 8_000\n', '', 'const ERROR_HOLD_MS')
await replaceOnce(
  transcript,
  String.raw`      acknowledged: false,
      cancelRequested: false,
      deadline: null,
      key,
      port,
      settled: false,
      threadId: null,`,
  String.raw`      cancelRequested: false,
      cancelSent: false,
      key,
      port,
      threadId: null,`,
  '      cancelSent: false,',
)
await replaceOnce(transcript, '        submission.acknowledged = true\n', '', '        submission.threadId = handle.threadId')
await replaceOnce(
  transcript,
  String.raw`        if (submission.cancelRequested) {
          this.#finishCancellation(submission)
          this.#releaseSubmission(submission)

          return undefined
        }`,
  String.raw`        if (submission.cancelRequested) {
          this.#cancelUnsubmitted(submission)
          this.#releaseSubmission(submission)

          return undefined
        }`,
  '          this.#cancelUnsubmitted(submission)',
)

const cancellationMethods = String.raw`  #requestCancellation(submission: PendingSubmission): void {
    if (submission.cancelRequested) {
      return
    }

    submission.cancelRequested = true
    const conversation = this.#conversations.get(submission.key)
    if (conversation !== undefined) {
      conversation.timeline = requestRunCancellation(conversation.timeline)
      this.#paint(conversation)
    }

    if (submission.threadId !== null) {
      this.#sendCancellation(submission)
    }
  }

  #sendCancellation(submission: PendingSubmission): void {
    const { cancel } = submission.port
    const threadId = submission.threadId

    if (threadId === null || submission.cancelSent) {
      return
    }

    if (cancel === undefined) {
      this.#note(submission.key, new Error('This agent cannot cancel an active run.'))
      this.#rejectCancellation(submission)
      return
    }

    submission.cancelSent = true
    void Promise.resolve(cancel(threadId)).catch((cause: unknown) => {
      submission.cancelSent = false
      this.#note(submission.key, cause)
      this.#rejectCancellation(submission)
    })
  }

  #cancelUnsubmitted(submission: PendingSubmission): void {
    const conversation = this.#conversations.get(submission.key)
    if (conversation === undefined) {
      return
    }

    conversation.timeline = confirmRunCancellation(conversation.timeline)
    this.#paint(conversation)
  }

  #rejectCancellation(submission: PendingSubmission): void {
    const conversation = this.#conversations.get(submission.key)
    if (conversation === undefined) {
      return
    }

    conversation.timeline = rejectRunCancellation(conversation.timeline)
    this.#paint(conversation)
  }

  #releaseSubmission(submission: PendingSubmission): void {
    if (this.#submissions.get(submission.key) === submission) {
      this.#submissions.delete(submission.key)
    }
  }

  #settle(`
await replacePattern(
  transcript,
  /  #requestCancellation\(submission: PendingSubmission\): void \{[\s\S]*?\n  #settle\(/,
  cancellationMethods,
  '  #cancelUnsubmitted(submission: PendingSubmission): void {',
)
await replaceOnce(
  transcript,
  String.raw`    if (submission.settled) {
      return
    }

`,
  '',
  '    const state = conversation.timeline',
)
await replaceOnce(
  transcript,
  '    } else if (submission.cancelRequested && submission.acknowledged) {\n',
  '    } else if (submission.cancelRequested) {\n',
  '    } else if (submission.cancelRequested) {',
)

const reducer = 'packages/agent/src/timeline/timeline-reducer.ts'
const rejection = String.raw`export function rejectRunCancellation(state: TimelineState): TimelineState {
  if (state.status !== 'cancelling') {
    return state
  }

  const draft = TimelineDraft.from(state)
  draft.status = 'running'
  return draft.freeze()
}

export function confirmRunCancellation(`
await replaceOnce(
  reducer,
  'export function confirmRunCancellation(',
  rejection,
  'export function rejectRunCancellation(',
)

const timelineIndex = 'packages/agent/src/timeline/index.ts'
await replaceOnce(
  timelineIndex,
  '  requestRunCancellation,\n',
  '  rejectRunCancellation,\n  requestRunCancellation,\n',
  '  rejectRunCancellation,',
)

const files = [...staged]
if (files.length === 0) {
  console.log('KAP runtime convergence refactor is already applied.')
  process.exit(0)
}

const backups = new Map()
try {
  for (const [relative, content] of files) {
    const target = path.join(root, relative)
    backups.set(relative, await readFile(target, 'utf8'))
    const temporary = `${target}.refactor-${process.pid}`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, target)
  }

  execFileSync('git', ['diff', '--check', '--', ...files.map(([relative]) => relative)], {
    cwd: root,
    stdio: 'inherit',
  })
} catch (error) {
  for (const [relative, content] of backups) {
    const target = path.join(root, relative)
    const temporary = `${target}.rollback-${process.pid}`
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, target)
    await rm(`${target}.refactor-${process.pid}`, { force: true })
  }
  throw error
}

console.log(`Applied KAP runtime convergence refactor to ${files.length} files.`)
console.log('Run: cargo fmt --all && pnpm check')
if (skipped.length > 0) {
  console.log(`Already-applied anchors skipped: ${new Set(skipped).size}`)
}
