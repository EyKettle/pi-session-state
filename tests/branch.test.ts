import { describe, expect, it } from "vitest";
import { branchKeyFromLeaf, type SessionTreeView } from "../src/branch.ts";

// Rule under test, architecture.md -> branch determination: walk up from the
// leaf while the parent has exactly one child, and stop at the first node
// whose parent is missing or has a child count other than one. Properties
// cited from the same section and from the invariance list: the key is always
// the top of a single-child segment; a fork created above a leaf moves that
// leaf's key, so keys are re-derived per read and never cached.

type Node = { id: string; parentId: string | null };

function treeOf(nodes: Node[]): SessionTreeView {
  return {
    parentOf: (id) => nodes.find((node) => node.id === id)?.parentId ?? null,
    childrenOf: (id) =>
      nodes.filter((node) => node.parentId === id).map((node) => node.id),
  };
}

describe("branch key", () => {
  it("walks a single path up to the root when no fork lies on the chain", () => {
    const view = treeOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
    ]);
    expect(branchKeyFromLeaf(view, "c")).toBe("a");
  });

  it("stops below the fork when the parent has several children", () => {
    const view = treeOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
      { id: "d", parentId: "c" },
      { id: "e", parentId: "b" },
    ]);
    expect(branchKeyFromLeaf(view, "d")).toBe("c");
  });

  it("takes the nearest fork when several forks lie above the leaf", () => {
    const view = treeOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
      { id: "d", parentId: "c" },
      { id: "e", parentId: "b" },
      { id: "f", parentId: "a" },
    ]);
    expect(branchKeyFromLeaf(view, "d")).toBe("c");
  });

  it("re-derives the key after a fork appears above the leaf", () => {
    const nodes: Node[] = [
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b" },
    ];
    const view = treeOf(nodes);
    expect(branchKeyFromLeaf(view, "c")).toBe("a");
    nodes.push({ id: "d", parentId: "a" });
    expect(branchKeyFromLeaf(view, "c")).toBe("b");
  });

  it("keys a second root as itself", () => {
    const view = treeOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "r", parentId: null },
    ]);
    expect(branchKeyFromLeaf(view, "r")).toBe("r");
  });

  it("yields no key for a null leaf", () => {
    const view = treeOf([{ id: "a", parentId: null }]);
    expect(branchKeyFromLeaf(view, null)).toBeNull();
  });
});
