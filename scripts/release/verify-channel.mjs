#!/usr/bin/env bun
/**
 * 用客户端那条 URL 亲自验一遍发布通道。
 *
 *   bun scripts/release/verify-channel.mjs <tag>
 */
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const ENDPOINT_FILE = 'apps/desktop/src-tauri/updater/manifest.url'
const [tag] = process.argv.slice(2)
if (!tag) {
  console.error('usage: bun scripts/release/verify-channel.mjs <tag>')
  process.exit(2)
}
function fail(message) {
  console.error(message)
  process.exit(1)
}
const endpoint = (await readFile(ENDPOINT_FILE, 'utf8')).trim()
const response = await fetch(endpoint, { redirect: 'follow' })
if (!response.ok) {
  fail(`${endpoint} answered ${response.status}`)
}
const manifest = await response.json()
const version = tag.replace(/^v/, '')
if (manifest.version !== version) {
  fail(`the published manifest is ${manifest.version}, expected ${version}`)
}
if (typeof manifest.payloadHash !== 'string' || manifest.payloadHash.length !== 64) {
  fail('the published manifest carries no payload hash')
}
const artifacts = [
  { label: 'full', url: manifest.full?.url, signature: manifest.full?.signature },
  ...(manifest.patches ?? []).map((patch) => ({
    label: `patch from ${patch.fromHash}`,
    url: patch.url,
    signature: patch.signature,
  })),
]
for (const artifact of artifacts) {
  if (!artifact.url || !artifact.signature) {
    fail(`${artifact.label} is incomplete`)
  }
  const reachable = await fetch(artifact.url, { method: 'HEAD', redirect: 'follow' })
  if (!reachable.ok) {
    fail(`${artifact.label} answered ${reachable.status}`)
  }
}
console.log(`update channel: ${version}, ${artifacts.length - 1} incremental payload(s)`)
