#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const PLATFORM = 'windows-x86_64'
const ATTEMPTS = 18
const RETRY_MS = 5_000

type Artifact = { readonly url?: string; readonly signature?: string }
export type Manifest = { readonly version?: string; readonly platforms?: Record<string, Artifact> }

export function channelFault(manifest: Manifest, tag: string): string | null {
  const version = tag.replace(/^v/, '')
  if (manifest.version !== version) {
    return `the published manifest is ${manifest.version}, expected ${version}`
  }
  const artifact = manifest.platforms?.[PLATFORM]
  if (!artifact?.url || !artifact.signature) {
    return `${PLATFORM} is incomplete`
  }
  try {
    const url = new URL(artifact.url)
    if (url.protocol !== 'https:' || !url.pathname.includes(`/releases/download/${tag}/`)) {
      return `${PLATFORM} points outside release ${tag}`
    }
  } catch {
    return `${PLATFORM} has an invalid URL`
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
      const manifest = (await response.json()) as Manifest
      const fault = channelFault(manifest, tag)
      if (fault) {
        throw new Error(fault)
      }
      const url = manifest.platforms?.[PLATFORM]?.url as string
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
  const config = JSON.parse(await readFile(CONF, 'utf8')) as {
    plugins?: { updater?: { endpoints?: string[] } }
  }
  const endpoint = config.plugins?.updater?.endpoints?.[0]
  if (!endpoint) {
    throw new Error('tauri.conf.json 里没有 updater endpoint')
  }
  const manifest = await verify(endpoint, tag)
  console.log(`更新通道正常：${manifest.version}（${PLATFORM}）`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
