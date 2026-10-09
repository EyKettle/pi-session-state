export interface SessionTreeView {
  parentOf(id: string): string | null;
  childrenOf(id: string): readonly string[];
}

// architecture.md -> branch determination: the key is the top of the
// single-child segment containing the leaf.
export function branchKeyFromLeaf(
  view: SessionTreeView,
  leaf: string | null,
): string | null {
  if (leaf === null) return null;
  let node = leaf;
  for (;;) {
    const parent = view.parentOf(node);
    if (parent === null) return node;
    if (view.childrenOf(parent).length !== 1) return node;
    node = parent;
  }
}
