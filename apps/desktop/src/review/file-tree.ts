import type { GitFileChange } from '@poietica/ipc'

/*
 * 变更清单折成目录树。
 *
 * 路径由 git 交回，porcelain 一律用 / 分隔（与平台无关），所以这里只切 /。
 * 次序：目录在前，同级按码位序 —— 与 git status 的字典序同一把尺，人扫的是
 * 同一列；localeCompare 走 ICU 区域排序会与它分叉。
 */

export interface FileTreeFolder {
  readonly kind: 'folder'
  readonly name: string
  readonly path: string
  readonly children: readonly FileTreeNode[]
}

export interface FileTreeFile {
  readonly kind: 'file'
  readonly name: string
  readonly change: GitFileChange
}

export type FileTreeNode = FileTreeFolder | FileTreeFile

interface Building {
  readonly folders: Map<string, Building>
  readonly files: GitFileChange[]
}

function building(): Building {
  return { files: [], folders: new Map() }
}

export function fileTree(changes: readonly GitFileChange[]): readonly FileTreeNode[] {
  const root = building()

  for (const change of changes) {
    const parts = change.path.split('/')
    let held = root

    for (const part of parts.slice(0, -1)) {
      const found = held.folders.get(part) ?? building()

      held.folders.set(part, found)
      held = found
    }

    held.files.push(change)
  }

  return materialized(root, '')
}

function materialized(held: Building, prefix: string): readonly FileTreeNode[] {
  const folders = [...held.folders]
    .sort(([left], [right]) => byCodePoint(left, right))
    .map(([name, child]): FileTreeNode => {
      const path = `${prefix + name}/`

      return { children: materialized(child, path), kind: 'folder', name, path }
    })

  const files = [...held.files]
    .sort((left, right) => byCodePoint(left.path, right.path))
    .map((change): FileTreeNode => ({ change, kind: 'file', name: leafOf(change.path) }))

  return [...folders, ...files]
}

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
