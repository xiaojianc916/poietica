import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/* 开发版更新配置。electron-updater 未打包时读 `app.getAppPath()/dev-app-update.yml`，字段与打包版 resources/app-update.yml 同形，
 * 所以发布源只有一处。这份文件是**手写的 YAML**（不是构建产物），格式漂了 electron-updater 只会拿一份解析不了的配置去检查、在日志里
 * 留一句 —— 这一条钉住它真的在、三格发布源齐全，且缓存目录与安装版**故意不同名**（开发版下载的待装字节不能与安装版混在一起）。
 * 断言逐行比对而不是引入 YAML 解析器：文件是平的、仓里也没有为测试加第三方依赖的理由。 */

const repoRoot = path.join(import.meta.dir, '../../../../..')
const devConfig = path.join(repoRoot, 'apps/desktop/dev-app-update.yml')
const builderConfig = path.join(repoRoot, 'apps/desktop/electron-builder.yml')

function configValue(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (match !== null && match[1] === key) {
      const value = match[2] ?? ''
      return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
    }
  }
  return undefined
}

describe('dev-app-update.yml', () => {
  const dev = readFileSync(devConfig, 'utf8')

  test('发布源与打包配置同源（provider/owner/repo）', () => {
    expect(configValue(dev, 'provider')).toBe('github')
    expect(configValue(dev, 'owner')).toBe('xiaojianc916')
    expect(configValue(dev, 'repo')).toBe('poietica')

    /* 改一处忘另一处，开发版就会去问另一个仓库。 */
    const builder = readFileSync(builderConfig, 'utf8')
    expect(builder).toContain(`owner: ${configValue(dev, 'owner') ?? ''}`)
    expect(builder).toContain(`repo: ${configValue(dev, 'repo') ?? ''}`)
  })

  test('缓存目录与安装版不同名', () => {
    expect(configValue(dev, 'updaterCacheDirName')).toBe('@poieticadesktop-updater-dev')
    expect(configValue(dev, 'updaterCacheDirName')).not.toBe('@poieticadesktop-updater')
  })
})
