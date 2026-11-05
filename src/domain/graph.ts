/** Dependency graphs between changes. Pure. */

export type Node = { readonly id: string; readonly dependsOn: readonly string[] };

/** Kahn's algorithm; returns the ids left over when there is a cycle. */
export const findCycle = (nodes: readonly Node[]): readonly string[] => {
  const indegree = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen.add(id);
    for (const n of nodes) {
      if (!n.dependsOn.includes(id)) continue;
      const d = (indegree.get(n.id) ?? 0) - 1;
      indegree.set(n.id, d);
      if (d === 0) queue.push(n.id);
    }
  }
  return nodes.map((n) => n.id).filter((id) => !seen.has(id));
};
