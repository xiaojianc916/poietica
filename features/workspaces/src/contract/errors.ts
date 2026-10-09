import { defineErrors } from '@poietica/contract-kit'

export const workspacesErrors = defineErrors('workspaces', {
  not_found: '工作区不存在',
  not_a_directory: '所选路径不是文件夹',
  directory_missing: '工作区文件夹已不存在',
})
