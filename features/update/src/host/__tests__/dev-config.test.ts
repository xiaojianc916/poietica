import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/*
 * 开发版更新配置（产品负责人 2026-10-08：开发版也能检查更新）。
 *
 * electron-updater 未打包时读 `app.getAppPath()/dev-app-update.yml`（`forceDevUpdateConfig`
 * 打开之后）—— electron-vite dev 下 app path 就是 apps/desktop（`startElectron` 跑的是
 * `electron .`，应用根由 apps/desktop/package.json 的 `main` 决定）。字段与打包版
 * resources/app-update.yml 同形（provider/owner/repo），所以发布源只有一处。
 *
 * 这份文件是**手写的 YAML**（不是构建产物），格式漂了 electron-updater 只会拿一份解析
 * 不了的配置去检查、在日志里留一句。这一条钉住它真的在、三格发布源齐全，且缓存目录与
 * 安装版**故意不同名**（开发版下载的待装字节不能与安装版混在一起）。
 *
 * 断言逐行比对而不是引入 YAML 解析器：文件是平的、仓里也没有为测试加第三方依赖的理由。
 */

const repoRoot = path.join(import.meta.dir, '../../../../..')
const devConfig = path.join(repoRoot, 'apps/desktop/dev-app-update.yml')
const builderConfig = path.join(repoRoot, 'apps/desktop/electron-builder.yml')

/** 逐行取值；找不到键就交回 undefined（键缺失与被赋空值在断言里是同一句话）。 */
function configValue(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line)
    if (match !== null && match[1] === key) {
      const value = match[2] ?? ''
      /* YAML 的引号是写法、不是值的一部分（`'@poieticadesktop-updater-dev'` 去引号）。 */
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

    /* 两份配置的源必须一致：改一处忘另一处，开发版就会去问另一个仓库。 */
    const builder = readFileSync(builderConfig, 'utf8')
    expect(builder).toContain(`owner: ${configValue(dev, 'owner') ?? ''}`)
    expect(builder).toContain(`repo: ${configValue(dev, 'repo') ?? ''}`)
  })

  test('缓存目录与安装版不同名', () => {
    expect(configValue(dev, 'updaterCacheDirName')).toBe('@poieticadesktop-updater-dev')
    /* 安装版的缓存目录由 electron-builder 写进 app-update.yml，值为 @poieticadesktop-updater。 */
    expect(configValue(dev, 'updaterCacheDirName')).not.toBe('@poieticadesktop-updater')
  })
})
