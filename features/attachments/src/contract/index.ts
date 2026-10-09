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
  ],
  notifications: [],
  errors: attachmentsErrors,
})
