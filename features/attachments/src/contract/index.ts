import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { Attachment } from './entities'
import { attachmentsErrors } from './errors'

export * from './entities'
export { attachmentsErrors } from './errors'

export const attachmentsContract = defineContract({
  id: 'attachments',
  namespaces: ['attachments'],
  methods: [
    defineMethod({
      name: 'attachments.importPaths',
      owner: 'core',
      params: z.object({ paths: z.array(z.string().min(1)) }),
      result: z.object({ attachments: z.array(Attachment) }),
      description: '把本地文件导入附件库',
    }),
    defineMethod({
      name: 'attachments.importData',
      owner: 'core',
      params: z.object({ name: z.string().min(1), mime: z.string(), base64: z.string() }),
      result: Attachment,
      description: '把一段 base64 数据导入附件库（粘贴的图片）',
    }),
    defineMethod({
      name: 'attachments.get',
      owner: 'core',
      params: z.object({ attachmentId: z.string().min(1) }),
      result: Attachment,
      description: '读一条附件记录',
    }),
    defineMethod({
      name: 'attachments.setOwnerRefs',
      owner: 'core',
      params: z.object({
        /*
         * 只允许 UI 前缀：UI 整体替换的是自己那一份引用（草稿），放开成任意
         * ownerKey 就等于让 UI 能误删 Core 的引用（R-07 §3.1）。上限放到 10 000：
         * 整体替换一旦被拒，等于把超出的部分全部释放，宁可放宽。
         */
        ownerKey: z.string().regex(/^ui:[a-z0-9.:-]+$/),
        attachmentIds: z.array(z.string().min(1)).max(10_000),
      }),
      result: z.object({ missing: z.array(z.string()) }),
      description: 'UI 持有的附件（如草稿）的引用登记：整体替换；返回已不存在的 id',
    }),
  ],
  notifications: [],
  errors: attachmentsErrors,
})
