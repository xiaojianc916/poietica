import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { DirectoryListing, FileContent, FileSearchHit, LocatedFile } from './entities'
import { filesErrors } from './errors'

export * from './entities'
export { filesErrors } from './errors'
export { imageMimeOf, workspaceFileUrl } from './media'

/** 图片字节走资源协议：poietica-asset://workspace-file/<workspaceId>/<相对路径的各段>?v=<mtimeMs>（Host 侧校验，见 host/）。 */
export const WORKSPACE_FILE_ASSET_HOST = 'workspace-file'

const workspaceId = z.string().min(1)
/* 相对工作区根，或写在正文里的绝对路径：Core 负责解析并校验它落在工作区之内（含符号链接）。 */
const anyPath = z.string().max(4096)

export const filesContract = defineContract({
  id: 'files',
  namespaces: ['files'],
  methods: [
    defineMethod({
      name: 'files.list',
      owner: 'core',
      params: z.object({ workspaceId, path: anyPath }),
      result: DirectoryListing,
      description: '列一个目录的直属条目（目录在前；.git 不列）；超出上限 truncated=true',
    }),
    defineMethod({
      name: 'files.read',
      owner: 'core',
      params: z.object({ workspaceId, path: anyPath }),
      result: FileContent,
      description: '读一个文件：正文（超过上限截断）/ 图片（只给元数据）/ 二进制',
    }),
    defineMethod({
      name: 'files.locate',
      owner: 'core',
      params: z.object({ workspaceId, path: anyPath }),
      result: LocatedFile,
      description: '把正文里写的路径解析成工作区内的相对路径与绝对路径；不在工作区内 → outside_workspace',
    }),
    defineMethod({
      name: 'files.search',
      owner: 'core',
      params: z.object({ workspaceId, query: z.string().max(256), limit: z.number().int().min(1).max(500).optional() }),
      result: z.object({ hits: z.array(FileSearchHit), truncated: z.boolean() }),
      timeoutMs: 30_000,
      description: '按路径筛文件（空格分开的几段都要命中，不分大小写）；仓库里尊重 .gitignore',
    }),
    defineMethod({
      name: 'files.watch',
      owner: 'core',
      params: z.object({ workspaceIds: z.array(workspaceId).max(32) }),
      result: z.object({}),
      description: '声明此刻要监听的工作区全集（不是引用计数）：不在集合里的停掉；Core 重启后由界面重发',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'files.changed',
      owner: 'core',
      params: z.object({ workspaceId, paths: z.array(z.string()).nullable() }),
      description: '工作区里有文件变了（去抖后合并）；paths 为相对路径，太多时为 null（= 全部重读）',
    }),
  ],
  errors: filesErrors,
})
