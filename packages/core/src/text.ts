import { diff3Merge } from 'node-diff3'

export interface TextMergeResult {
  /** True when both sides changed the same lines in different ways. */
  conflict: boolean
  text: string
}

/**
 * Three-way merge of a text field, line by line.
 * `base` is the text both devices last agreed on; `ours` and `theirs` are
 * the two edited versions. Changes to different lines are both kept.
 */
export function mergeText(base: string, ours: string, theirs: string): TextMergeResult {
  if (ours === theirs) return { conflict: false, text: ours }
  if (ours === base) return { conflict: false, text: theirs }
  if (theirs === base) return { conflict: false, text: ours }
  const regions = diff3Merge(ours.split('\n'), base.split('\n'), theirs.split('\n'), { excludeFalseConflicts: true })
  const out: string[] = []
  for (const r of regions) {
    if (r.ok) out.push(...r.ok)
    else if (r.conflict) return { conflict: true, text: ours }
  }
  return { conflict: false, text: out.join('\n') }
}
