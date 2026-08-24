#!/usr/bin/env bun
/**
 * 发布之后，用客户端那条端点验证更新通道确实通了。
 *
 * 没有这一步，"资产没上传 / release 不是 latest / 版本与 tag 不符" 三种失败全部
 * 静默：CI 全绿，而每一个已安装的客户端永远收不到更新，我们也收不到任何信号。
 *
 *   node scripts/release/verify-channel.mjs v0.1.2
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const CONF = 'apps/desktop/src-tauri/tauri.conf.json'
const ATTEMPTS = 5
const BACKOFF = 15_000

const tag = process.argv[2]

if (!tag) {
  console.error('usage: node scripts/release/verify-channel.mjs <tag>')
  process.exit(2)
}

const conf = JSON.parse(await readFile(CONF, 'utf8'))
const endpoint = conf.plugins?.updater?.endpoints?.[0]

if (!endpoint) {
  console.error(`${CONF}: no updater endpoint declared`)
  process.exit(2)
}

const expected = tag.replace(/^v/, '')

async function probe() {
  const response = await fetch(endpoint, { redirect: 'follow' })

  if (!response.ok) {
    throw new Error(`${endpoint} -> ${response.status}`)
  }

  const manifest = await response.json()

  if (manifest.version !== expected) {
    throw new Error(`manifest serves ${manifest.version}, expected ${expected}`)
  }

  const platform = manifest.platforms?.['windows-x86_64']

  if (!platform?.signature || !platform.url) {
    throw new Error('manifest has no signed windows-x86_64 artifact')
  }

  const installer = await fetch(platform.url, { method: 'HEAD', redirect: 'follow' })

  if (!installer.ok) {
    throw new Error(`${platform.url} -> ${installer.status}`)
  }
}

for (let attempt = 1; ; attempt += 1) {
  try {
    await probe()
    console.log(`update channel serves ${expected}`)
    break
  } catch (error) {
    if (attempt === ATTEMPTS) {
      console.error(String(error))
      process.exit(1)
    }

    console.log(`not ready yet (${error.message}); retrying in ${BACKOFF / 1000}s`)
    await sleep(BACKOFF)
  }
}
