import { readFileSync, writeFileSync } from 'node:fs'

const target = 'refactor.mjs'
const source = readFileSync(target, 'utf8')

const faultyValidator = / {6}const initializers = \[[\s\S]*? {6}if \(before === source\) \{/

const replacement = [
  '      /*',
  '       * 不数 “ThreadSummary {” 的出现次数：',
  '       * pub struct ThreadSummary { 是声明，不是初始化。',
  '       * 这里只检查修复后是否仍有漏掉 archived_at 的 workspace_root 映射。',
  '       */',
  '      const remainingMissingMappings = source.match(',
  '        /^(\\s*)workspace_root: row\\.get\\(7\\)\\?,\\r?\\n(?!\\s*archived_at:)/gm,',
  '      )',
  '',
  '      if (remainingMissingMappings !== null) {',
  '        throw new Error(',
  '          `还有 ${remainingMissingMappings.length} 个 ThreadSummary 初始化缺少 archived_at。`,',
  '        )',
  '      }',
  '',
  '      if (before === source) {',
].join('\n')

if (!faultyValidator.test(source)) {
  throw new Error('没有找到旧的 ThreadSummary 错误校验器；refactor.mjs 可能已经被修改。')
}

const updated = source.replace(faultyValidator, replacement)

writeFileSync(target, updated, 'utf8')

console.log('已修复 refactor.mjs 的 ThreadSummary 校验器。')
