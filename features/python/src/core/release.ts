import { PYTHON_ASSET_SHA256 } from './release.generated'
export const PYTHON_RELEASE_TAG = '20261001'
export const PYTHON_VERSION = '3.12.15'
export const PYTHON_ASSET = `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`
export { PYTHON_ASSET_SHA256 }
/** 按顺序尝试；'+' 必须编码为 %2B */
export const PYTHON_DOWNLOAD_URLS: readonly string[] = [
  `https://registry.npmmirror.com/-/binary/python-build-standalone/${PYTHON_RELEASE_TAG}/${encodeURIComponent(PYTHON_ASSET)}`,
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/${encodeURIComponent(PYTHON_ASSET)}`,
]
export const DOWNLOAD_TIMEOUT_MS = 600_000
