import { defineErrors } from '@poietica/contract-kit'

export const pythonErrors = defineErrors('python', {
  busy: '正在安装 Python，请稍候',
  download_failed: 'Python 下载失败，请检查网络后重试',
  checksum_mismatch: '下载的 Python 文件校验失败',
  extract_failed: 'Python 解压失败',
  verify_failed: 'Python 安装后无法运行',
})
