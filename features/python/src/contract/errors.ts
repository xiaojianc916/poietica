import { defineErrors } from '@poietica/contract-kit'

export const pythonErrors = defineErrors('python', {
  download_failed: 'Python 下载失败，请检查网络后重试',
  checksum_mismatch: '下载的 Python 文件校验失败',
  install_failed: 'Python 安装失败',
  verify_failed: 'Python 安装后没有找到可用版本',
})
