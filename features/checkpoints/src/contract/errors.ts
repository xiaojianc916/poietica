import { defineErrors } from '@poietica/contract-kit'

export const checkpointErrors = defineErrors('checkpoints', {
  conflict: '工作区在检查点之后被手动改过，恢复会覆盖这些改动',
  git_failed: '影子仓库命令失败',
  invalid_path: '路径不在工作区之内',
})
