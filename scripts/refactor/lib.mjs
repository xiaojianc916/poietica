import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

function occurrences(source, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let offset = 0
  while (true) {
    const found = source.indexOf(needle, offset)
    if (found < 0) return count
    count += 1
    offset = found + needle.length
  }
}

export class Migration {
  root = resolve(process.cwd())
  staged = new Map()
  removals = new Map()

  fail(message) { throw new Error(`[refactor] ${message}`) }
  path(path) { return join(this.root, path) }
  exists(path) { return existsSync(this.path(path)) && !this.removals.has(path) }

  read(path) {
    if (this.removals.has(path)) this.fail(`attempted to read staged removal: ${path}`)
    const staged = this.staged.get(path)
    if (staged !== undefined) return staged
    const absolute = this.path(path)
    if (!existsSync(absolute)) this.fail(`missing required file: ${path}`)
    return readFileSync(absolute, 'utf8')
  }

  replace(path, before, after) {
    if (before === after) return
    const source = this.read(path)
    const count = occurrences(source, before)
    if (count === 0) this.fail(`anchor not found in ${path}: ${JSON.stringify(before.slice(0, 100))}`)
    if (count !== 1) this.fail(`anchor is not unique in ${path}`)
    if (after !== '' && source.includes(after)) this.fail(`old and target forms coexist in ${path}`)
    this.staged.set(path, source.replace(before, after))
  }

  replaceAll(path, before, after, expectedCount) {
    const source = this.read(path)
    const count = occurrences(source, before)
    if (count === 0) this.fail(`anchor not found in ${path}: ${JSON.stringify(before.slice(0, 100))}`)
    if (count !== expectedCount) this.fail(`expected ${expectedCount} anchors in ${path}, found ${count}`)
    this.staged.set(path, source.split(before).join(after))
  }

  section(path, start, end, replacement) {
    const source = this.read(path)
    const starts = occurrences(source, start)
    if (starts === 0) this.fail(`section start not found in ${path}: ${JSON.stringify(start)}`)
    if (starts !== 1) this.fail(`section start is not unique in ${path}`)
    const from = source.indexOf(start)
    const to = source.indexOf(end, from + start.length)
    if (to < 0) this.fail(`section end not found in ${path}: ${JSON.stringify(end)}`)
    if (source.indexOf(end, to + end.length) >= 0) this.fail(`section end is not unique in ${path}`)
    this.staged.set(path, source.slice(0, from) + replacement + source.slice(to + end.length))
  }

  write(path, content, expectedExistingMarker) {
    if (this.exists(path)) {
      const source = this.read(path)
      if (source === content) return
      if (expectedExistingMarker === undefined || !source.includes(expectedExistingMarker)) {
        this.fail(`refusing to overwrite unexpected file: ${path}`)
      }
    }
    this.staged.set(path, content)
  }

  remove(path, expectedMarker) {
    if (!existsSync(this.path(path))) this.fail(`missing required removal: ${path}`)
    const source = readFileSync(this.path(path), 'utf8')
    if (!source.includes(expectedMarker)) this.fail(`refusing to remove unexpected file: ${path}`)
    this.removals.set(path, expectedMarker)
    this.staged.delete(path)
  }

  assertAbsent(needle, paths) {
    for (const path of paths) {
      if (this.removals.has(path)) continue
      if (this.read(path).includes(needle)) this.fail(`obsolete form remains in ${path}: ${needle}`)
    }
  }

  commit() {
    for (const path of this.removals.keys()) {
      const source = readFileSync(this.path(path), 'utf8')
      if (!source.includes(this.removals.get(path))) this.fail(`removal changed during migration: ${path}`)
    }
    for (const [path, content] of this.staged) {
      const absolute = this.path(path)
      mkdirSync(dirname(absolute), { recursive: true })
      const temporary = `${absolute}.refactor-${process.pid}`
      writeFileSync(temporary, content, 'utf8')
      renameSync(temporary, absolute)
      console.log(`[refactor] updated ${relative(this.root, absolute)}`)
    }
    for (const path of this.removals.keys()) {
      rmSync(this.path(path))
      console.log(`[refactor] removed ${path}`)
    }
  }

  run(command, args) {
    const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
    const result = spawnSync(executable, args, { cwd: this.root, stdio: 'inherit' })
    if (result.error) this.fail(`${command} could not start: ${result.error.message}`)
    if (result.status !== 0) this.fail(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}
