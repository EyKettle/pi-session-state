export interface SessionTreeView {
  parentOf(id: string): string | null;
  childrenOf(id: string): readonly string[];
}

// architecture.md -> branch determination: the key is the top of the
// single-child segment containing the leaf. Walk up while the parent has
// exactly one child; the first node whose parent is missing, or whose parent
// has a child count other than one, is the key.
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
