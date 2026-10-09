// 用法：bun run new:feature <id> --parts core,core-api,host,ui,ui-api   （contract 总是生成）
import { parseArgs } from 'node:util'
import { FEATURE_PARTS, type FeaturePart, KEBAB, renderFeature } from './templates'
import { fail, syncReferences, writeFiles } from './write'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { parts: { type: 'string', default: '' } },
  allowPositionals: true,
})
const id = positionals[0]
if (id === undefined || !KEBAB.test(id)) fail('功能 id 必须是 kebab-case，例如 agent-settings')
const parts = (values.parts ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0) as FeaturePart[]
for (const p of parts) if (!FEATURE_PARTS.includes(p)) fail(`未知子入口：${p}（可选：${FEATURE_PARTS.join(', ')}）`)
if (parts.includes('core-api') && !parts.includes('core')) fail('有 core-api 就必须有 core')
if (parts.includes('ui-api') && !parts.includes('ui')) fail('有 ui-api 就必须有 ui')

writeFiles(renderFeature(id, parts))
syncReferences()
console.log(`已创建 features/${id}。下一步：
  1. bun install
  2. 在 packages/protocol/src/index.ts 的 contracts 数组加入 ${id} 的 contract
  3. 有 core：在 apps/core/src/modules.ts 加一行；有 host：在 apps/desktop/src/main/modules.ts 加一行；有 ui：在 apps/desktop/src/renderer/features.ts 加一行
  4. 在 apps/core / apps/desktop 的 package.json 中加入 "@poietica/feature-${id}": "workspace:*"
  5. bun run refs`)
