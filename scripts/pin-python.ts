import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { PYTHON_ASSET, PYTHON_RELEASE_TAG } from '../features/python/src/core/release'

/*
 * 把 registry 上的 SHA256SUMS 抄进 release.generated.ts（07 页 §13C 的完整代码）。
 *
 * 校验和**固定在代码里**：运行时不再联网取它，镜像被篡改也能发现。所以这个脚本
 * 只在「升级 Python 版本」时由人手动跑一次（`bun run python:pin`），产物随仓库提交。
 * 注意：它 import release.ts，而 release.ts 又 import release.generated.ts —— 首次
 * 执行前 release.generated.ts 必须已经存在（占位文件即可）。
 */
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE_TAG}/SHA256SUMS`
/*
 * 响应只用到 `text()`。bun-types 里 `Response` 的 `text()` 只在加载了 DOM 库时才有
 * （`UseLibDomIfAvailable`），而 scripts 工程是 bun 预设（lib: ES2023）。这里按最小结构
 * 类型读一句 —— 与 `features/python/src/core/index.ts` 的 fetch 注入同一写法。
 */
const response = (await fetch(url)) as unknown as { text(): Promise<string> }
const text = await response.text()
const line = text.split('\n').find((l) => l.trim().endsWith(PYTHON_ASSET))
if (line === undefined) {
  console.error(`SHA256SUMS 中没有 ${PYTHON_ASSET}`)
  process.exit(1)
}
const sha = line.trim().split(/\s+/)[0]!.toLowerCase()
if (!/^[a-f0-9]{64}$/.test(sha)) {
  console.error('校验和格式不对')
  process.exit(1)
}
const out = path.join(import.meta.dir, '../features/python/src/core/release.generated.ts')
writeFileSync(out, `// 由 scripts/pin-python.ts 生成，不要手改\nexport const PYTHON_ASSET_SHA256 = '${sha}'\n`)
console.log(`已写入 ${out}: ${sha}`)
