import { defineErrors } from '@poietica/contract-kit'

export const filesErrors = defineErrors('files', {
  outside_workspace: '这个路径不在当前工作区里',
  not_found: '文件不存在',
  not_a_directory: '这不是一个目录',
  is_directory: '这是一个目录，不是文件',
  unreadable: '无法读取这个文件',
})
