#!/usr/bin/env bun
/**
 * 按客户端真正会去访问的那条地址，验证刚刚发布的版本已经出现在更新通道上。
 *
 * 客户端（electron-updater）启动后拉的是仓库 latest release 上的 latest.yml，
 * 所以这里不查 API、不查 tag 列表，就查那一个地址与它指向的资产 —— 验的是
 * 「用户机器上会发生的事」，不是「GitHub 上看起来对」。
 *
 * 用法：bun run verify:channel <tag>
 */

import process from 'node:process'
import { parse } from 'yaml'

import { REPO_BASE } from './version'

const ATTEMPTS = 18
const RETRY_MS = 5_000

/**
 * 本仓的 bun preset 不带 DOM lib，全局 `Response` 于是落在 bun-types 的
 * `UseLibDomIfAvailable` 上、成员是残缺的（没有 ok / status / text）。
 * 与 features/python/src/core/index.ts 同一个理由：按结构声明我们要用的那几格。
 */
type HttpResponse = {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** electron-updater 认的 latest.yml：一个版本、一个路径、一份 sha512。 */
export type Manifest = {
  readonly version?: string
  readonly path?: string
  readonly sha512?: string
  readonly files?: ReadonlyArray<{ readonly url?: string; readonly sha512?: string }>
}

export function channelFault(manifest: Manifest, tag: string): string | null {
  const version = tag.replace(/^v/, '')
  if (manifest.version !== version) {
    return `the published manifest is ${manifest.version}, expected ${version}`
  }
  if (!manifest.path || !manifest.sha512) {
    return 'the published manifest has no installer or no sha512'
  }
  if (!manifest.path.endsWith('-setup.exe')) {
    return `the published installer is not an NSIS setup: ${manifest.path}`
  }
  return null
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** 资产必须在那个地址上真实可取；HEAD 足够，不下字节。 */
async function requireAsset(url: string): Promise<void> {
  const response = (await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  })) as unknown as HttpResponse

  if (!response.ok) {
    throw new Error(`${url} 返回了 ${response.status}`)
  }
}

async function verify(endpoint: string, tag: string): Promise<Manifest> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = (await fetch(endpoint, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })) as unknown as HttpResponse
      if (!response.ok) {
        throw new Error(`${endpoint} 返回了 ${response.status}`)
      }
      const manifest = parse(await response.text()) as Manifest
      const fault = channelFault(manifest, tag)
      if (fault) {
        throw new Error(fault)
      }
      const url = `${REPO_BASE}/releases/download/${tag}/${encodeURIComponent(manifest.path ?? '')}`
      await requireAsset(url)
      /*
       * 差分下载的那一份块索引。缺了它客户端不会报错 —— 它会安静地退回整包下载，
       * 每次更新重下上百 MB。静默的降级只能靠这里挡住。
       */
      await requireAsset(`${url}.blockmap`)
      return manifest
    } catch (error) {
      lastError = error
      if (attempt < ATTEMPTS) {
        await wait(RETRY_MS)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function main(): Promise<void> {
  const tag = process.argv[2]
  if (!tag) {
    throw new Error('用法：bun run verify:channel <tag>')
  }
  /* electron-updater 的默认检查地址就是仓库 latest release 上的 latest.yml。 */
  const endpoint = `${REPO_BASE}/releases/latest/download/latest.yml`
  const manifest = await verify(endpoint, tag)
  console.log(`更新通道正常：${manifest.version}（${manifest.path}）`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
