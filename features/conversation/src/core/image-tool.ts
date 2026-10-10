import path from 'node:path'
import type { AgentToolRegistry } from '@poietica/core-kernel'
import type { AttachmentsService } from '@poietica/feature-attachments/core-api'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { OWNER_KEY } from './thread-service'

/*
 * agent 往对话里展示一张图（审查 R-13）。
 *
 * 助手正文里的图只认附件协议 `poietica-asset://attachment/<sha256>`（prose.tsx 的净化链与 CSP
 * 都只放行它；file://、data:、http(s) 一律被拦）。协议处理器只读附件库那一棵树 —— 这是安全边界：
 * 任何被渲染出来的 markdown（包括模型被网页、文件内容诱导着复述的）都够得着它，放开成「任意路径」
 * 就等于界面能显示本机任意文件。所以不放宽协议，而是给 agent 一个**正式入口**：交一个路径，
 * 由 Core 走与输入框添加附件同一条导入管线（50 MB 上限、扩展名定 mime、按内容去重），
 * 挂到这条对话名下（删对话、分支、回收都跟着对话走），交回那一行 markdown。
 */

/** 能在对话里直接显示的扩展名：与附件协议处理器的内联白名单同一张（attachments/host/asset-handler.ts 的 INLINE_MIME） */
const SHOWABLE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
const SHOWABLE_LIST = 'png, jpg, jpeg, gif, webp, bmp, svg'

const showImageParams = z.object({
  path: z.string().min(1).describe('Path of the image file: absolute, or relative to the working directory.'),
  caption: z.string().optional().describe('Short description used as the alt text. Defaults to the file name.'),
})

/** markdown 图片的替代文字里不能有方括号与换行（会把这一行拆坏） */
function altOf(caption: string | undefined, fallback: string): string {
  const cleaned = (caption ?? '').replace(/[[\]\r\n]+/g, ' ').trim()
  return cleaned === '' ? fallback.replace(/[[\]\r\n]+/g, ' ').trim() : cleaned
}

export function registerImageTool(d: {
  readonly tools: AgentToolRegistry
  readonly attachments: AttachmentsService
}): void {
  const { attachments, tools } = d
  tools.register({
    name: 'show_image',
    label: '展示图片',
    description: [
      'Show an image file to the user in this chat. This is the only supported means of displaying an image in the conversation.',
      'Markdown images that reference file://, data:, or http(s) URLs are blocked by the application.',
      `Supply the path of a file in one of the following supported formats: ${SHOWABLE_LIST} — for example, a chart you have just rendered, a screenshot,`,
      'or an image already stored on disk.',
      'The file is copied into the application; consequently, subsequent modifications to it do not alter what has already been displayed.',
      'The result is a single Markdown image line, which must be inserted verbatim into the reply at the position where the image is to appear.',
    ].join(' '),
    parameters: showImageParams,
    approval: 'read',
    async execute(params: z.output<typeof showImageParams>, ctx) {
      const file = path.resolve(ctx.cwd, params.path)
      const extension = path.extname(file).toLowerCase()
      if (!SHOWABLE_EXTENSIONS.has(extension)) {
        throw new AppError(
          SystemErrorCode.invalidParams,
          `不支持的图片类型「${extension === '' ? '无扩展名' : extension}」：只能展示 ${SHOWABLE_LIST}，请先转换成 PNG`,
        )
      }
      // 不存在、不是文件、超过 50 MB：导入管线自己抛中文错误（attachments.unreadable / too_large），原样交给模型
      const [imported] = await attachments.importPaths([file])
      if (imported === undefined || imported.previewUrl === null) {
        throw new AppError(SystemErrorCode.internal, `图片导入之后没有可显示的地址：${file}`)
      }
      // 挂到这条对话名下：不挂的话 24 小时后会被回收；删对话、分支对话都按这把 key 处理
      attachments.retain([imported.id], OWNER_KEY(ctx.sessionKey))
      return {
        text: `![${altOf(params.caption, imported.name)}](${imported.previewUrl})`,
        details: { attachmentId: imported.id },
      }
    },
  })
}
