import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { KERNEL_CACHE_ENTRIES, SESSION_DIRECTORY } from './session-directory'

/*
 * 内核那一摊的落点只有一格：<数据根>/session。这里守两件事 —— 那一层名字只写一次，
 * 以及「哪些能清」的清单不为空（清缓存这条命令按它算占用）。
 */
test('内核落点是数据根下面的一层，名字只有一处', () => {
  expect(SESSION_DIRECTORY).toBe('session')
  expect(join('/data', SESSION_DIRECTORY)).toBe(join('/data', 'session'))
})

test('可清的内核缓存认得内核真正会写的那些目录', () => {
  expect(KERNEL_CACHE_ENTRIES).toContain('Cache')
  expect(KERNEL_CACHE_ENTRIES).toContain('Code Cache')
  expect(KERNEL_CACHE_ENTRIES).toContain('GPUCache')
})
