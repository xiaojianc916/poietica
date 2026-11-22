import { windowsExecutable } from '@poietica/platform-kit'
import { PYTHON_INSTALLER_SHA256 } from './release.generated'

/** 2026-11-22 钉住的最新稳定版（python.org 下载页）。升级时改这里再跑 `bun run python:pin`。 */
export const PYTHON_VERSION = '3.15.2'
/** 低于它就算「版本过低」：3.10 已于 2026-10 结束支持。 */
export const MIN_PYTHON_VERSION = '3.11.0'
export const PYTHON_INSTALLER = windowsExecutable(`python-${PYTHON_VERSION}-amd64`)
export { PYTHON_INSTALLER_SHA256 }
/** 按顺序尝试；镜像只影响下载快慢，校验和钉死，任何一份内容不符都会被丢弃。 */
export const PYTHON_DOWNLOAD_URLS: readonly string[] = [
  `https://registry.npmmirror.com/-/binary/python/${PYTHON_VERSION}/${PYTHON_INSTALLER}`,
  `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_INSTALLER}`,
]
export const DOWNLOAD_TIMEOUT_MS = 600_000
/** 静默安装本身；慢盘上解压 pip/tcltk 也要一点时间。 */
export const INSTALL_TIMEOUT_MS = 900_000
