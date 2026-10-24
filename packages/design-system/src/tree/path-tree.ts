/*
 * 一组路径 → 目录树的行。纯函数，不认 React。
 *
 * 只有一个子目录且没有直属文件的目录段并成一行（src/review/…）：稀疏的路径集（变更清单、搜索结果）不并就是一长串
 * 单孩子目录。原先是 review 私有的 change-tree.ts；文件树下沉到 design-system 之后，「路径集画成树」也跟着下来，
 * 审查与文件两处共用同一份行模型（插件之间不能互相依赖，见 AGENTS.md 功能分级）。
 */

/* 不从 ../diff 取 basename：那一条子路径带着 jsdiff，根入口不该为一个 lastIndexOf 把它拽进首屏闭包。 */
function basename(path: string): string {
  const tail = path.slice(path.lastIndexOf('/') + 1)
  return tail === '' ? path : tail
}

export interface PathTreeFile {
  readonly kind: 'file'
  readonly key: string
  readonly label: string
  readonly depth: number
  readonly path: string
}
export interface PathTreeFolder {
  readonly kind: 'folder'
  readonly key: string
  readonly label: string
  readonly depth: number
}
export type PathTreeNode = PathTreeFile | PathTreeFolder

interface Branch {
  readonly folders: Map<string, Branch>
  readonly files: string[]
}

export function pathTreeRows(paths: readonly string[], collapsed: ReadonlySet<string>): readonly PathTreeNode[] {
  const tree = branch()
  for (const held of [...paths].sort((left, right) => left.localeCompare(right))) {
    /* 逐段切而不是 split + slice：split 会为每条路径建一整张数组、slice 再建一张，切片只在插树时用一次。 */
    let here = tree
    let from = 0
    for (;;) {
      const cut = held.indexOf('/', from)
      if (cut < 0) {
        break
      }
      const part = held.slice(from, cut)
      const next = here.folders.get(part) ?? branch()
      here.folders.set(part, next)
      here = next
      from = cut + 1
    }
    here.files.push(held)
  }
  const rows: PathTreeNode[] = []
  walk(tree, '', 0, collapsed, rows)
  return rows
}

function branch(): Branch {
  return { files: [], folders: new Map<string, Branch>() }
}

function walk(here: Branch, prefix: string, depth: number, collapsed: ReadonlySet<string>, rows: PathTreeNode[]): void {
  for (const [name, child] of here.folders) {
    let folder = child
    let label = name
    let key = prefix === '' ? name : `${prefix}/${name}`
    while (folder.files.length === 0 && folder.folders.size === 1) {
      /* 只取第一个：展开成数组再取 [0] 会为每个并段分配一张整表（几千条路径就是几千次）。 */
      const only = folder.folders.entries().next().value
      if (only === undefined) {
        break
      }
      label = `${label}/${only[0]}`
      key = `${key}/${only[0]}`
      folder = only[1]
    }
    rows.push({ depth, key, kind: 'folder', label })
    if (!collapsed.has(key)) {
      walk(folder, key, depth + 1, collapsed, rows)
    }
  }
  for (const held of here.files) {
    rows.push({
      depth,
      key: held,
      kind: 'file',
      label: basename(held),
      path: held,
    })
  }
}
