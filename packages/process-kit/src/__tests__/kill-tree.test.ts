import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { killTree } from '../kill-tree'

const CHILD_SCRIPT = `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
console.log('PID:' + grandchild.pid)
setInterval(() => {}, 1000)
`

/** 启动一个子进程；它再启动一个孙进程，并把孙进程 pid 打印到 stdout */
function spawnTree(): Promise<{ pid: number; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const pid = child.pid
    if (pid === undefined) {
      reject(new Error('子进程没有 pid'))
      return
    }
    const timer = setTimeout(() => reject(new Error('子进程没有报告孙进程 pid')), 5000)
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      const matched = /PID:(\d+)/.exec(out)
      if (matched === null) return
      clearTimeout(timer)
      resolve({ pid, grandchildPid: Number(matched[1]) })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(25)
  }
  return !isAlive(pid)
}

describe('killTree', () => {
  test('杀掉子进程时孙进程也一起结束', async () => {
    const { pid, grandchildPid } = await spawnTree()
    try {
      expect(isAlive(grandchildPid)).toBe(true)
      await killTree(pid)
      expect(await waitDead(grandchildPid, 1000)).toBe(true)
    } finally {
      await killTree(pid)
      if (isAlive(grandchildPid)) process.kill(grandchildPid)
    }
  })

  test('对不存在的 pid 调用不抛错', async () => {
    // Windows 的 pid 一定是 4 的倍数，999999999 不可能是有效 pid
    await expect(killTree(999_999_999)).resolves.toBeUndefined()
  })
})
