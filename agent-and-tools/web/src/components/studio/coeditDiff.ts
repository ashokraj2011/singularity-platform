/**
 * Minimal single-region text diff for binding a plain textarea to a Yjs Y.Text. Computes the common
 * prefix and suffix between the old and new value and returns the one delete+insert in the middle —
 * exactly what a caret edit, selection replace, or paste produces. Pure and unit-tested; the Yjs
 * merge handles concurrency, this only translates one local change into a Y.Text op.
 */
export interface TextOp {
  index: number;
  delete: number;
  insert: string;
}

export function diffToOps(oldStr: string, newStr: string): TextOp | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const min = Math.min(oldStr.length, newStr.length);
  while (start < min && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { index: start, delete: endOld - start, insert: newStr.slice(start, endNew) };
}

/**
 * Remap a caret offset across a Yjs text delta (array of retain/insert/delete) so a remote edit
 * before the caret shifts it correctly. Used to keep the local caret stable while others type.
 */
export function remapCaret(delta: Array<{ retain?: number; insert?: string | object; delete?: number }>, pos: number): number {
  let idx = 0;
  let out = pos;
  for (const d of delta) {
    if (d.retain != null) {
      idx += d.retain;
    } else if (typeof d.insert === "string") {
      if (idx <= out) out += d.insert.length;
      idx += d.insert.length;
    } else if (d.delete != null) {
      if (idx < out) out -= Math.min(d.delete, out - idx);
    }
  }
  return out;
}
