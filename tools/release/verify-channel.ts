#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const PLATFORM = 'windows-x86_64-nsis'
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
  return null
}

async function main(): Promise<void> {
  const tag = process.argv[2]
  if (!tag) {
    throw new Error('usage: bun tools/release/verify-channel.ts <tag>')
  }
  const config = JSON.parse(await readFile(CONF, 'utf8')) as {
    plugins?: { updater?: { endpoints?: string[] } }
  }
  const endpoint = config.plugins?.updater?.endpoints?.[0]
  if (!endpoint) {
    throw new Error('updater endpoint is missing')
  }
  const response = await fetch(endpoint, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`${endpoint} answered ${response.status}`)
  }
  const manifest = (await response.json()) as Manifest
  const fault = channelFault(manifest, tag)
  if (fault) {
    throw new Error(fault)
  }
  const url = manifest.platforms?.[PLATFORM]?.url as string
  const artifact = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!artifact.ok) {
    throw new Error(`${url} answered ${artifact.status}`)
  }
  console.log(`update channel: ${manifest.version}, ${PLATFORM}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
