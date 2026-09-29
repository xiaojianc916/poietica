/*
 * 现场发送的图片。
 *
 * 缘起是一个真实的缺口：`case 'prompt'` 收下 `command.attachments`（线上是磁盘绝对路径）
 * 之后直接 `agent.prompt(command.text)` —— 附件从来没交出去。于是随消息发的图既没进模型
 * 上下文，也没进对话记录，屏幕上连一块占位都没有：图就这么消失了。
 *
 * omp 的 SDK 只认 `PromptOptions.images: ImageContent[]`（base64，无 data: 前缀），
 * 全仓没有按路径喂图的入口，所以图片必须由桥自己读盘编码（官方 CLI 也走这条路，
 * 见 cli/file-processor.ts:104-133）。这个文件逐条钉住那三件事：
 *   1. 图片路径 → `agent.prompt` 的 options 里真的有 ImageContent；
 *   2. 同一条消息推得出能画的 attachment.upsert（data URL），并且 turn 引用了那个号；
 *   3. 非图片文件不变成 ImageContent —— 它留给 agent 用 Read 工具按路径读。
 *
 * 跑法：cd packages/agent-bridge && bun test src/__tests__/live-image-attachments.test.ts
 *
 * 内容类型不在这里判：线上那格 `mime` 来自 Rust 侧的文件头嗅探
 * （crates/asset/src/formats.rs 的 classify()），桥只是把它交给 SDK —— 扩展名不是判据，
 * 见本文件末尾那格回归。
 */

import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/* 一张 1×1 的 PNG。 */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/*
 * 受控 home 必须在**任何 SDK import 之前**定下：SDK 的 agent 目录是模块加载时解析的
 * （pi-utils 的 dirs.ts），晚了它就还是用户自己的 ~/.omp —— createBridge 会拿它跟这里对账
 * 并拒绝开工。这也是这个文件用动态 import 起桥的原因。
 */
const home = mkdtempSync(path.join(tmpdir(), 'poietica-live-image-'))
process.env['PI_CODING_AGENT_DIR'] = home

const { AgentSession } = await import('@oh-my-pi/pi-coding-agent')
const { imageAttachmentSource } = await import('@oh-my-pi/pi-tui/prompt/image-source')

let original: typeof AgentSession.prototype.prompt

/* 拦下 SDK 那一动，看桥究竟把什么交了出去 —— 真起一轮要模型与密钥，那是另一个测试的事。 */
const calls: { text: string; images: readonly unknown[] }[] = []

/*
 * 覆盖必须是**进程级**的：case 'prompt' 里那次 `agent.prompt` 就是这里拦下来的那个方法，
 * 所以这一格同时证明「桥把图交给了 SDK」而不是「我们自己的另一条路也读了图」。
 */
original = AgentSession.prototype.prompt
AgentSession.prototype.prompt = async function (
  this: unknown,
  text: string,
  options?: { images?: readonly unknown[] },
) {
  calls.push({ text, images: options?.images ?? [] })
  return true
} as typeof AgentSession.prototype.prompt

afterAll(() => {
  AgentSession.prototype.prompt = original
  /*
   * 临时 home 里的 agent.db 还开着（SQLite 句柄），Windows 上删不动。删不掉不是测试的
   * 事实，交给系统清临时目录 —— 为此让整个文件红掉是假警报。
   */
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // 句柄未释放：临时目录由系统回收。
  }
})

/*
 * 一条真会话（受控 home 是空的临时目录，起得来）+ 一次 prompt 命令。
 *
 * 每次都用新的桥：附件号里有 promptId，但会话里那几格状态是连着走的，分开更清楚。
 */
async function send(
  attachments: readonly {
    path: string
    kind: 'image' | 'file'
    mime: string
    name: string
  }[],
): Promise<{
  call: { text: string; images: readonly unknown[] }
  ops: readonly { op: string; attachment?: unknown; turn?: unknown }[]
}> {
  const { createBridge } = await import('../bridge.ts')
  const bridge = createBridge({
    agentDir: home,
    cwd: process.cwd(),
    env: { PI_CODING_AGENT_DIR: home },
  })

  const ops: { op: string; attachment?: unknown; turn?: unknown }[] = []
  bridge.subscribe((event) => {
    if (event.kind === 'transcript') {
      /*
       * payload 是交给客户端的那一帧，ops 在它内层的 payload 下（镜像的 `accept` 产物）：
       * 与 transscript-mirror.test.ts 里 `decode` 走的是同一格，这里只取 ops 看内容。
       */
      const frame = event.payload as { payload?: { ops?: typeof ops } }
      ops.push(...(frame.payload?.ops ?? []))
    }
  })

  await bridge.dispatch({ id: 'open', type: 'new_session', cwd: process.cwd() })
  await bridge.dispatch({
    id: 'send',
    type: 'prompt',
    text: '这是什么',
    promptId: 'p1',
    attachments,
    skills: [],
  })

  return { call: calls[calls.length - 1] as { text: string; images: readonly unknown[] }, ops }
}

/** 一张真图片落到盘上，返回它的绝对路径。 */
function writeImage(name: string): string {
  const file = path.join(home, name)
  writeFileSync(file, Buffer.from(PIXEL, 'base64'))
  return file
}

test('a sent image reaches the SDK as ImageContent, and the screen gets a drawable attachment', async () => {
  const file = writeImage('shot.png')
  const { call, ops } = await send([
    { path: file, kind: 'image', mime: 'image/png', name: 'shot.png' },
  ])

  /* (a) 模型那一边：真的是一张 ImageContent，裸 base64（`data:` 前缀会让供应商解不开）。 */
  expect(call.text).toBe('这是什么')
  expect(call.images).toHaveLength(1)
  expect(call.images[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PIXEL })

  /*
   * 路径也要跟着走：SDK 靠这个符号注入隐藏的 image-attachment 伴生消息
   * （agent-session.ts:6291-6311），agent 于是既拿得到像素，也拿得到能 `read` 的那个路径。
   */
  expect(imageAttachmentSource(call.images[0] as never)).toEqual({ path: file, kind: 'image' })

  /* (b) 屏幕那一边：同一个号上先是能画的 upsert，然后 turn 引用它。 */
  const attachment = ops.find((op) => op.op === 'attachment.upsert')?.attachment as {
    attachmentId: string
  }
  expect(attachment).toMatchObject({
    mediaType: 'image/png',
    source: { kind: 'url', url: `data:image/png;base64,${PIXEL}` },
    name: 'shot.png',
  })

  const turn = ops.find((op) => op.op === 'turn.upsert')?.turn as { attachmentIds?: string[] }
  expect(turn.attachmentIds).toEqual([attachment.attachmentId])

  /*
   * upsert 必须先于引用它的 turn 落地：反过来的话投影层先看到 turn，那一格引用一个
   * 还不存在的附件，屏幕上就是一块空白。
   */
  expect(ops.findIndex((op) => op.op === 'attachment.upsert')).toBeLessThan(
    ops.findIndex((op) => op.op === 'turn.upsert'),
  )
})

test('a non-image attachment stays a path reference and never becomes an ImageContent', async () => {
  const notes = path.join(home, 'notes.txt')
  writeFileSync(notes, '一把普通文本')

  const { call, ops } = await send([
    { path: notes, kind: 'file', mime: 'text/plain', name: 'notes.txt' },
  ])

  expect(call.images).toHaveLength(0)
  expect(ops.some((op) => op.op === 'attachment.upsert')).toBe(false)
})

/*
 * 回归：扩展名不是判据。
 *
 * Rust 侧按**文件头**判内容类型（crates/asset/src/formats.rs 的 classify()），剪贴板粘贴
 * 的图就叫 `pasted-<uuid>`、没有扩展名（apps/desktop/src/assistant/attachment-intake.ts）。
 * 桥曾经按 `path.extname` 反推 MIME，这类图整条链路上都被说成 `application/octet-stream`
 * 而被供应商拒 —— 预览看得见、发出去就失败。这一格钉住内容判据只从线上那一格 `mime` 来。
 *
 * 空的 `pasted-7f3a`（连点号都没有）才是真正到达用户的那一格：`screenshot.dat` 至少还有
 * 一段可辨认的后缀，而粘贴的图什么都没有 —— 扩展名那条路对它是彻底的无。
 */
test('an image whose filename has no image extension keeps the mime carried on the wire', async () => {
  const file = writeImage('screenshot.dat')
  const { call, ops } = await send([
    { path: file, kind: 'image', mime: 'image/png', name: 'screenshot.dat' },
  ])

  expect(call.images).toHaveLength(1)
  expect(call.images[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PIXEL })
  expect(imageAttachmentSource(call.images[0] as never)).toEqual({ path: file, kind: 'image' })

  /* 屏幕上那格也要用同一个内容判据，否则卡片会画不出来。 */
  expect(ops.find((op) => op.op === 'attachment.upsert')?.attachment).toMatchObject({
    mediaType: 'image/png',
    source: { kind: 'url', url: `data:image/png;base64,${PIXEL}` },
    name: 'screenshot.dat',
  })
})

/*
 * 同一格回归的第二种文件名：粘贴的图连后缀都没有（`pasted-<uuid>`）。
 * 这两格必须一起绿 —— 只测 `screenshot.dat` 会漏掉「根本没有后缀」这一支。
 */
test('a pasted image with no extension at all keeps the mime carried on the wire', async () => {
  const file = writeImage('pasted-7f3a-4c81')
  const { call, ops } = await send([
    { path: file, kind: 'image', mime: 'image/png', name: 'pasted-7f3a-4c81' },
  ])

  expect(call.images).toHaveLength(1)
  expect(call.images[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PIXEL })
  expect(ops.find((op) => op.op === 'attachment.upsert')?.attachment).toMatchObject({
    mediaType: 'image/png',
  })
})

test('an image whose file is too large is an honest error, not a silent drop', async () => {
  const huge = path.join(home, 'huge.png')
  /* 只写文件头 + 补到上限之上：这条测的是上限判定，不必真读 25MB 像素。 */
  writeFileSync(huge, Buffer.alloc(25 * 1024 * 1024 + 1))

  await expect(
    send([{ path: huge, kind: 'image', mime: 'image/png', name: 'huge.png' }]),
  ).rejects.toThrow(/attachment too large/)
})
