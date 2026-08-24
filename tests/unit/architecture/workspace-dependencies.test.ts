import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * A package may only import what it declares.
 *
 * bunfig.toml sets linker = "isolated" with hoist = false, so an undeclared
 * package no longer resolves — with one exception Bun documents: workspace
 * packages are symlinked into the root node_modules and stay reachable from
 * anywhere. Every specifier checked here is a workspace package, so the
 * linker cannot enforce this and the test has to.
 *
 * This recomputes the comparison instead of listing the answer, so it keeps
 * holding as packages are added.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCOPE = '@poietica/'
const SOURCE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/
const IGNORED = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', 'target', 'gen'])

const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]/g,
]

function workspaceDirs(): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const globs: string[] = manifest.workspaces.packages

  const dirs: string[] = []

  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const parent = glob.slice(0, -2)

      for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(`${parent}/${entry.name}`)
        }
      }
    } else {
      dirs.push(glob)
    }
  }

  return dirs.filter((dir) => {
    try {
      readFileSync(join(ROOT, dir, 'package.json'), 'utf8')

      return true
    } catch {
      return false
    }
  })
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []

  const walk = (current: string): void => {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) {
        continue
      }

      const next = `${current}/${entry.name}`

      if (entry.isDirectory()) {
        walk(next)
      } else if (SOURCE.test(entry.name)) {
        found.push(next)
      }
    }
  }

  walk(dir)

  return found
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/')

  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : `${parts[0]}`
}

describe('workspace dependencies', () => {
  const undeclared: string[] = []

  for (const dir of workspaceDirs()) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'))
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])

    for (const file of sourceFiles(dir)) {
      const text = readFileSync(join(ROOT, file), 'utf8')

      for (const pattern of SPECIFIERS) {
        pattern.lastIndex = 0

        let match = pattern.exec(text)

        while (match !== null) {
          const specifier = match[1] ?? ''
          const name = packageOf(specifier)

          if (specifier.startsWith(SCOPE) && name !== manifest.name && !declared.has(name)) {
            undeclared.push(`${file} imports ${name}, which ${manifest.name} does not declare`)
          }

          match = pattern.exec(text)
        }
      }
    }
  }

  it('are declared by every package that imports them', () => {
    expect(undeclared).toEqual([])
  })
})
