/** 子序列匹配打分：不匹配返回 -1；连续命中、词首命中加分；大小写不敏感 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let prev = -2
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    score += 1
    if (found === prev + 1) score += 3
    if (found === 0 || t[found - 1] === ' ' || t[found - 1] === '.' || t[found - 1] === ':') score += 2
    prev = found
    ti = found + 1
  }
  return score - (t.length - q.length) * 0.01
}
