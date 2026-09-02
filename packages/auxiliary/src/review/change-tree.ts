/*
 * 变更清单 → 目录树的行。
 *
 * 纯函数：吃路径与折叠集合，交回一串带缩进深度的行。只有一个子目录且没有直属文件的
 * 目录段并成一行（src/review/…）—— 变更集是稀疏的，不并就会出现一长串单孩子目录。
 */
export interface ChangeTreeFile {
  readonly kind: 'file'
  readonly key: string
  readonly label: string
  readonly depth: number
  readonly path: string
}
export interface ChangeTreeFolder {
  readonly kind: 'folder'
  readonly key: string
  readonly label: string
  readonly depth: number
  readonly paths: readonly string[]
}
export type ChangeTreeNode = ChangeTreeFile | ChangeTreeFolder
interface Branch {
  readonly folders: Map<string, Branch>
  readonly files: string[]
}
export function changeTreeRows(
  paths: readonly string[],
  collapsed: ReadonlySet<string>,
): readonly ChangeTreeNode[] {
  const tree = branch()
  for (const held of [...paths].sort((left, right) => left.localeCompare(right))) {
    const parts = held.split('/')
    let here = tree
    for (const part of parts.slice(0, -1)) {
      const next = here.folders.get(part) ?? branch()
      here.folders.set(part, next)
      here = next
    }
    here.files.push(held)
  }
  const rows: ChangeTreeNode[] = []
  walk(tree, '', 0, collapsed, rows)
  return rows
}
function branch(): Branch {
  return { files: [], folders: new Map<string, Branch>() }
}
/* 目录在文件之前，两者各自按名字 —— 文件树的通行顺序。 */
function walk(
  here: Branch,
  prefix: string,
  depth: number,
  collapsed: ReadonlySet<string>,
  rows: ChangeTreeNode[],
): void {
  for (const [name, child] of here.folders) {
    let folder = child
    let label = name
    let key = prefix === '' ? name : `${prefix}/${name}`
    while (folder.files.length === 0 && folder.folders.size === 1) {
      const only = [...folder.folders.entries()][0]
      if (only === undefined) {
        break
      }
      label = `${label}/${only[0]}`
      key = `${key}/${only[0]}`
      folder = only[1]
    }
    rows.push({ depth, key, kind: 'folder', label, paths: filesOf(folder) })
    if (!collapsed.has(key)) {
      walk(folder, key, depth + 1, collapsed, rows)
    }
  }
  for (const held of here.files) {
    rows.push({
      depth,
      key: held,
      kind: 'file',
      label: held.slice(held.lastIndexOf('/') + 1),
      path: held,
    })
  }
}
function filesOf(here: Branch): readonly string[] {
  const found = [...here.files]
  for (const child of here.folders.values()) {
    found.push(...filesOf(child))
  }
  return found
}
