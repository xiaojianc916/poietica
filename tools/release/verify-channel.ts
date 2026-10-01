#!/usr/bin/env bun
import process from 'node:process'
import { parse } from 'yaml'

import { REPO_BASE } from './version.ts'

const ATTEMPTS = 18
const RETRY_MS = 5_000

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

async function verify(endpoint: string, tag: string): Promise<Manifest> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new Error(`${endpoint} 返回了 ${response.status}`)
      }
      const manifest = parse(await response.text()) as Manifest
      const fault = channelFault(manifest, tag)
      if (fault) {
        throw new Error(fault)
      }
      const url = `${REPO_BASE}/releases/download/${tag}/${encodeURIComponent(manifest.path ?? '')}`
      const artifact = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      if (!artifact.ok) {
        throw new Error(`${url} 返回了 ${artifact.status}`)
      }
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
    throw new Error('用法：bun tools/release/verify-channel.ts <tag>')
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
