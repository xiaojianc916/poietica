#!/usr/bin/env bun
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const PLATFORM = 'windows-x86_64-nsis'

export function manifestBase(endpointText: string): string | null {
  try {
    const endpoint = new URL(endpointText.trim())
    const suffix = '/releases/latest/download/latest.json'
    return endpoint.origin === 'https://github.com' && endpoint.pathname.endsWith(suffix)
      ? endpoint.origin + endpoint.pathname.slice(0, -suffix.length)
      : null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const [outDir, tag] = process.argv.slice(2)
  if (!outDir || !tag) {
    throw new Error('usage: bun tools/release/manifest.ts <outDir> <tag>')
  }
  const config = JSON.parse(await readFile(CONF, 'utf8')) as {
    plugins?: { updater?: { endpoints?: string[] } }
  }
  const endpoint = config.plugins?.updater?.endpoints?.[0]
  const base = endpoint ? manifestBase(endpoint) : null
  if (!base) {
    throw new Error('tauri updater endpoint is not a GitHub latest-release URL')
  }
  const archives = (await readdir(outDir)).filter((name) => name.endsWith('.nsis.zip'))
  if (archives.length !== 1) {
    throw new Error(`expected one .nsis.zip artifact, found ${archives.length}`)
  }
  const archive = archives[0]
  const signature = (await readFile(path.join(outDir, `${archive}.sig`), 'utf8')).trim()
  if (!signature) {
    throw new Error('updater signature is empty')
  }
  const version = tag.replace(/^v/, '')
  const url = `${base}/releases/download/${tag}/${archive}`
  const manifest = {
    version,
    notes: `${base}/releases/tag/${tag}`,
    pub_date: new Date().toISOString(),
    platforms: { [PLATFORM]: { url, signature } },
  }
  await writeFile(
    path.join(outDir, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
