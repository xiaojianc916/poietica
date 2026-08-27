/*
 * 统一补丁折成行模型。
 *
 * 一处解析，一处消费：颜色与行号由行的种类决定，不由字符串首字母决定。按前缀
 * 上色会把 --- 与 +++ 两行画成删除与新增，而丢掉 @@ 之前的一切会让二进制文件
 * 与纯模式变更画出一片空白 —— 两者都是「界面自己猜补丁」的后果。
 *
 * 与 opencode 同一范式（packages/session-ui/src/components/session-diff.ts）：
 * 补丁先解析成结构，界面从结构渲染。
 */

export type PatchLineKind = 'context' | 'added' | 'removed'

export interface PatchLine {
  readonly kind: PatchLineKind
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly text: string
}

export interface PatchHunk {
  readonly header: string
  readonly lines: readonly PatchLine[]
}

export interface PatchView {
  readonly hunks: readonly PatchHunk[]
  /** git 说这是二进制文件：没有行可画。 */
  readonly binary: boolean
  /** 有补丁却没有一段 hunk：模式变更，或没有基线可比。 */
  readonly empty: boolean
}

const RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function patchView(patch: string): PatchView {
  const hunks: PatchHunk[] = []
  let lines: PatchLine[] = []
  let header = ''
  let oldLine = 0
  let newLine = 0
  let binary = false

  const close = (): void => {
    if (header.length > 0) {
      hunks.push({ header, lines })
    }

    header = ''
    lines = []
  }

  for (const raw of patch.split('\n')) {
    const range = RANGE.exec(raw)

    if (range !== null) {
      close()
      header = raw
      oldLine = Number(range[1] ?? '1')
      newLine = Number(range[2] ?? '1')
      continue
    }

    if (header.length === 0) {
      if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) {
        binary = true
      }

      continue
    }

    /* 「\ No newline at end of file」说的是上一行的结尾，不是一行内容。 */
    if (raw.startsWith('\\')) {
      continue
    }

    if (raw.startsWith('+')) {
      lines.push({ kind: 'added', newLine, oldLine: null, text: raw.slice(1) })
      newLine += 1
      continue
    }

    if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', newLine: null, oldLine, text: raw.slice(1) })
      oldLine += 1
      continue
    }

    if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', newLine, oldLine, text: raw.slice(1) })
      oldLine += 1
      newLine += 1
      continue
    }

    /* hunk 之外的行（下一个文件的补丁头、结尾空行）结束这一段。 */
    close()
  }

  close()

  return { binary, empty: !binary && hunks.length === 0, hunks }
}
