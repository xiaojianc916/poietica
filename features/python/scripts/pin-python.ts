import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PYTHON_DOWNLOAD_URLS, PYTHON_INSTALLER } from '../src/core/release'

/* 下载官方安装包并算 SHA-256，写进 release.generated.ts。校验和**固定在代码里**：运行时不再联网取它，镜像被篡改也能发现。
 * 只在「升级 Python 版本」时由人手动跑一次（`bun run python:pin`），产物随仓库提交。 */
const url = PYTHON_DOWNLOAD_URLS[PYTHON_DOWNLOAD_URLS.length - 1]!
/* bun-types 里 `Response` 的 `arrayBuffer()` 只在加载了 DOM 库时才有，而 scripts 工程是 bun 预设（lib: ES2023）。这里按最小结构
 * 类型读字节。 */
const response = (await fetch(url)) as unknown as { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }
if (!response.ok) {
  console.error(`下载 ${PYTHON_INSTALLER} 失败：HTTP ${response.status}`)
  process.exit(1)
}
const bytes = new Uint8Array(await response.arrayBuffer())
const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const out = path.join(import.meta.dir, '../src/core/release.generated.ts')
writeFileSync(
  out,
  `// 由 features/python/scripts/pin-python.ts 生成，不要手改\nexport const PYTHON_INSTALLER_SHA256 = '${sha}'\n`,
)
console.log(`已写入 ${out}: ${sha}（${bytes.length} 字节）`)
