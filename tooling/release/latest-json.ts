#!/usr/bin/env bun
/**
 * 把 electron-builder 已经产出的 `latest.yml` 补成发布资产。
 *
 * electron-builder 自己会写 latest.yml（版本、路径、sha512），electron-updater 认的
 * 就是它。这里不再手搓第二份清单 —— 手抄一份 latest.json 等于给更新通道建第二个事实，
 * 而两边一旦不一致，客户端会去拉一个不存在的地址。
 *
 * 这一步做两件事，都是 electron-builder 不做、而发布必须有的：
 *   1. 校验 latest.yml 指向的正是刚构建出来的那个安装包（版本、文件名都要对得上）。
 *   2. 把 sha512（base64）换算成十六进制写进 SHA256SUMS.txt 旁边那份校验和清单。
 *
 * 仓库地址不在这里重复声明：它从 electron-builder.yml 的 publish 段读 —— 那正是
 * 客户端真正会去拉的地址，两边不可能再各写各的。
 *
 *   bun run latest-json <bundleDir> <outDir> <tag>
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'

import { REPO_BASE } from './version'

export type UpdaterManifest = {
  readonly version: string
  readonly files: ReadonlyArray<{
    readonly url: string
    readonly sha512: string
    readonly size?: number
  }>
  readonly path: string
  readonly sha512: string
  readonly releaseDate?: string
}

/** electron-builder 的 latest.yml 必须在、且必须指向这一版。 */
export function manifestFault(manifest: UpdaterManifest | undefined, tag: string, installer: string): string | null {
  if (!manifest) {
    return 'latest.yml 缺失：electron-builder 没有产出更新清单'
  }
  const version = tag.replace(/^v/, '')
  if (manifest.version !== version) {
    return `latest.yml 的版本是 ${manifest.version}，不是 ${version}`
  }
  if (manifest.path !== installer) {
    return `latest.yml 指向 ${manifest.path}，不是 ${installer}`
  }
  if (!manifest.sha512) {
    return 'latest.yml 没有 sha512：客户端无法校验下载来的安装包'
  }
  return null
}

/** 下载地址由仓库基址与 tag 拼出，与 electron-builder 的 publish 段同源。 */
export function downloadUrl(base: string, tag: string, installer: string): string {
  return `${base}/releases/download/${tag}/${encodeURIComponent(installer)}`
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main(): Promise<void> {
  const [bundleDir, outDir, tag] = process.argv.slice(2)
  if (!bundleDir || !outDir || !tag) {
    console.error('用法：bun run latest-json <bundleDir> <outDir> <tag>')
    process.exit(2)
  }

  const raw = await readFile(path.join(bundleDir, 'latest.yml'), 'utf8').catch(() => null)
  if (raw === null) {
    fail(`${bundleDir} 下没有 latest.yml：electron-builder 的 publish 段没配，或构建没跑完`)
  }

  const manifest = parse(raw) as UpdaterManifest
  const installer = (await readdir(bundleDir)).find((name) => name.endsWith('-setup.exe'))
  if (!installer) {
    fail(`${bundleDir} 下没有 *-setup.exe`)
  }

  const fault = manifestFault(manifest, tag, installer)
  if (fault) {
    fail(fault)
  }

  /* latest.yml 原样搬过去：electron-updater 在 release 页面上找的就是这个名字，
     重新序列化一遍只会引入差异。 */
  await writeFile(path.join(outDir, 'latest.yml'), raw, 'utf8')

  /* 校验和清单：latest.yml 的 sha512 与安装包逐字节算出来的一致才入账。 */
  const bytes = await readFile(path.join(bundleDir, installer))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  if (sha512 !== manifest.sha512) {
    fail(`${installer} 的 sha512 与 latest.yml 里的不一致：清单不可信`)
  }

  await writeFile(path.join(outDir, 'SHA256SUMS.txt'), `${sha256}  ${installer}\n${sha256}  latest.yml\n`, 'utf8')
  console.log(`latest.yml -> ${downloadUrl(REPO_BASE, tag, installer)}`)
}

if (import.meta.main) {
  await main()
}
