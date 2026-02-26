import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate, computeGroups, buildLinkMatrix } from './solver.js';

// ── Helper ──────────────────────────────────────────────────────────────────

function makeNodes(defs) {
  return defs.map(([id, nodeWeight]) => ({ id, label: id, nodeWeight }));
}

function makeLinkMatrix(edges) {
  return buildLinkMatrix(
    edges.map(([from, to, linkWeight]) => ({ from, to, linkWeight }))
  );
}

function allGroupsValid(solutions, min, max, nodes) {
  const byId = {};
  for (const n of nodes) byId[n.id] = n;

  for (const sol of solutions) {
    for (const gd of sol.groupDetails) {
      const nwSum = gd.nodeIds.reduce((s, id) => s + byId[id].nodeWeight, 0);
      assert.equal(
        nwSum,
        gd.nodeWeightSum,
        `nodeWeightSum mismatch in group [${gd.nodeIds}]`
      );
      assert.ok(
        nwSum >= min,
        `Group [${gd.nodeIds}] nodeWeightSum ${nwSum} < min ${min}`
      );
      assert.ok(
        nwSum <= max,
        `Group [${gd.nodeIds}] nodeWeightSum ${nwSum} > max ${max}`
      );
    }
  }
}

function allNodesAccountedFor(solutions, nodeIds, allowFreeNodes = false) {
  const idSet = new Set(nodeIds);
  for (const sol of solutions) {
    const assigned = new Set();
    for (const gd of sol.groupDetails) {
      for (const id of gd.nodeIds) {
        assert.ok(idSet.has(id), `Unknown node ${id} in solution`);
        assert.ok(!assigned.has(id), `Node ${id} assigned to multiple groups`);
        assigned.add(id);
      }
    }
    const free = sol.freeNodes || [];
    for (const id of free) {
      assert.ok(idSet.has(id), `Unknown free node ${id}`);
      assert.ok(!assigned.has(id), `Free node ${id} also assigned to a group`);
      assigned.add(id);
    }
    if (!allowFreeNodes) {
      assert.equal(assigned.size, idSet.size, 'Not all nodes assigned');
    }
  }
}

// ── Validation tests ────────────────────────────────────────────────────────

describe('validate', () => {
  it('rejects when no nodes', () => {
    const errors = validate([], {}, 0, 100);
    assert.ok(errors.length > 0);
    assert.ok(errors[0].toLowerCase().includes('at least one node'));
  });

  it('rejects when min > max', () => {
    const nodes = makeNodes([['a', 5]]);
    const errors = validate(nodes, {}, 50, 10);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('must be')));
  });

  it('rejects when nodeWeight > maximumCombinedWeight', () => {
    const nodes = makeNodes([['a', 200]]);
    const errors = validate(nodes, {}, 0, 100);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('exceeds')));
  });

  it('passes with valid input', () => {
    const nodes = makeNodes([['a', 10], ['b', 20]]);
    const errors = validate(nodes, {}, 10, 50);
    assert.equal(errors.length, 0);
  });
});

// ── Solver: constraint enforcement ──────────────────────────────────────────

describe('solver constraints', () => {
  it('returns errors when nodeWeight exceeds max', () => {
    const nodes = makeNodes([['a', 200]]);
    const result = computeGroups(nodes, {}, 0, 100);
    assert.ok(result.errors.length > 0);
    assert.equal(result.solutions.length, 0);
  });

  it('every group respects min/max node-weight bounds', () => {
    const nodes = makeNodes([
      ['a', 10], ['b', 15], ['c', 12], ['d', 8], ['e', 5],
    ]);
    const matrix = makeLinkMatrix([
      ['a', 'b', 3], ['b', 'c', 7], ['c', 'd', 2],
      ['d', 'e', 4], ['a', 'c', 1],
    ]);
    const min = 15;
    const max = 30;
    const result = computeGroups(nodes, matrix, min, max);

    assert.ok(result.solutions.length > 0, 'Should find at least one solution');
    allGroupsValid(result.solutions, min, max, nodes);
    allNodesAccountedFor(result.solutions, nodes.map((n) => n.id));
  });

  it('returns no solutions when bounds are infeasible', () => {
    const nodes = makeNodes([['a', 10], ['b', 10]]);
    const matrix = makeLinkMatrix([['a', 'b', 5]]);
    const result = computeGroups(nodes, matrix, 25, 30);
    assert.equal(result.solutions.length, 0);
  });

  it('returns at most 10 solutions', () => {
    const nodes = makeNodes([
      ['a', 5], ['b', 5], ['c', 5], ['d', 5],
      ['e', 5], ['f', 5], ['g', 5], ['h', 5],
    ]);
    const matrix = makeLinkMatrix([
      ['a', 'b', 1], ['c', 'd', 1], ['e', 'f', 1], ['g', 'h', 1],
      ['a', 'c', 2], ['b', 'd', 2], ['e', 'g', 2], ['f', 'h', 2],
    ]);
    const result = computeGroups(nodes, matrix, 5, 25);
    assert.ok(result.solutions.length <= 10);
    assert.ok(result.solutions.length > 0);
  });

  it('solutions are sorted by totalWeight descending', () => {
    const nodes = makeNodes([
      ['a', 5], ['b', 5], ['c', 5], ['d', 5],
    ]);
    const matrix = makeLinkMatrix([
      ['a', 'b', 10], ['c', 'd', 8], ['a', 'c', 1], ['b', 'd', 1],
    ]);
    const result = computeGroups(nodes, matrix, 5, 20);
    for (let i = 1; i < result.solutions.length; i++) {
      assert.ok(
        result.solutions[i - 1].totalWeight >= result.solutions[i].totalWeight,
        `Solution ${i - 1} (${result.solutions[i - 1].totalWeight}) < solution ${i} (${result.solutions[i].totalWeight})`
      );
    }
  });
});

// ── Two unjoined groups (disconnected components) ───────────────────────────

describe('two unjoined groups', () => {
  it('never places nodes from different components in the same group', () => {
    const nodes = makeNodes([['A', 10], ['B', 10], ['C', 10], ['D', 10]]);
    const matrix = makeLinkMatrix([
      ['A', 'B', 5],
      ['C', 'D', 8],
    ]);
    const min = 10;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max);
    assert.ok(result.solutions.length > 0, 'Should find at least one solution');

    const comp1 = new Set(['A', 'B']);
    const comp2 = new Set(['C', 'D']);

    for (const sol of result.solutions) {
      for (const gd of sol.groupDetails) {
        const hasComp1 = gd.nodeIds.some((id) => comp1.has(id));
        const hasComp2 = gd.nodeIds.some((id) => comp2.has(id));
        assert.ok(
          !(hasComp1 && hasComp2),
          `Group [${gd.nodeIds}] mixes nodes from disconnected components`
        );
      }
    }
  });

  it('the best solution groups connected nodes together', () => {
    const nodes = makeNodes([['A', 10], ['B', 10], ['C', 10], ['D', 10]]);
    const matrix = makeLinkMatrix([
      ['A', 'B', 5],
      ['C', 'D', 8],
    ]);
    const min = 10;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max);
    const best = result.solutions[0];
    assert.equal(best.totalWeight, 13, 'Best totalWeight should be 5 + 8 = 13');

    const groupSets = best.groups.map((g) => new Set(g));
    const hasAB = groupSets.some(
      (s) => s.size === 2 && s.has('A') && s.has('B')
    );
    const hasCD = groupSets.some(
      (s) => s.size === 2 && s.has('C') && s.has('D')
    );
    assert.ok(hasAB, 'Best solution should group A and B together');
    assert.ok(hasCD, 'Best solution should group C and D together');
  });

  it('works with three disconnected components', () => {
    const nodes = makeNodes([
      ['A', 5], ['B', 5],
      ['C', 5], ['D', 5],
      ['E', 5], ['F', 5],
    ]);
    const matrix = makeLinkMatrix([
      ['A', 'B', 10],
      ['C', 'D', 7],
      ['E', 'F', 3],
    ]);
    const min = 5;
    const max = 15;

    const result = computeGroups(nodes, matrix, min, max);
    assert.ok(result.solutions.length > 0);

    const components = [new Set(['A', 'B']), new Set(['C', 'D']), new Set(['E', 'F'])];
    for (const sol of result.solutions) {
      for (const gd of sol.groupDetails) {
        let touchedComps = 0;
        for (const comp of components) {
          if (gd.nodeIds.some((id) => comp.has(id))) touchedComps++;
        }
        assert.ok(
          touchedComps <= 1,
          `Group [${gd.nodeIds}] touches ${touchedComps} components`
        );
      }

      allGroupsValid([sol], min, max, nodes);
    }
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('single node', () => {
    const nodes = makeNodes([['a', 10]]);
    const result = computeGroups(nodes, {}, 5, 15);
    assert.ok(result.solutions.length > 0);
    assert.equal(result.solutions[0].groups.length, 1);
    assert.deepEqual(result.solutions[0].groups[0], ['a']);
    assert.equal(result.solutions[0].totalWeight, 0);
  });

  it('all nodes isolated (no links)', () => {
    const nodes = makeNodes([['a', 5], ['b', 5], ['c', 5]]);
    const result = computeGroups(nodes, {}, 5, 15);
    assert.ok(result.solutions.length > 0);
    allGroupsValid(result.solutions, 5, 15, nodes);
    allNodesAccountedFor(result.solutions, ['a', 'b', 'c']);
    assert.equal(result.solutions[0].totalWeight, 0);
  });

  it('complete graph', () => {
    const nodes = makeNodes([['a', 3], ['b', 3], ['c', 3], ['d', 3]]);
    const matrix = makeLinkMatrix([
      ['a', 'b', 1], ['a', 'c', 2], ['a', 'd', 3],
      ['b', 'c', 4], ['b', 'd', 5], ['c', 'd', 6],
    ]);
    const result = computeGroups(nodes, matrix, 3, 12);
    assert.ok(result.solutions.length > 0);
    allGroupsValid(result.solutions, 3, 12, nodes);
    allNodesAccountedFor(result.solutions, ['a', 'b', 'c', 'd']);
  });
});

// ── Free nodes (allowFreeNodes) ─────────────────────────────────────────────

describe('allowFreeNodes', () => {
  it('isolated nodes become free when allowFreeNodes is true', () => {
    // A-B linked, X isolated (no links to anyone)
    const nodes = makeNodes([['A', 10], ['B', 10], ['X', 5]]);
    const matrix = makeLinkMatrix([['A', 'B', 7]]);
    const min = 10;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max, { allowFreeNodes: true });
    assert.ok(result.solutions.length > 0);

    const best = result.solutions[0];
    assert.ok(
      best.freeNodes.includes('X'),
      `Isolated node X should be free, got freeNodes: [${best.freeNodes}]`
    );
    assert.equal(best.totalWeight, 7, 'totalWeight should be 7 (A-B link)');

    const groupedIds = best.groups.flat();
    assert.ok(groupedIds.includes('A'), 'A should be in a group');
    assert.ok(groupedIds.includes('B'), 'B should be in a group');
    assert.ok(!groupedIds.includes('X'), 'X should NOT be in a group');
  });

  it('all nodes grouped when allowFreeNodes is false (default)', () => {
    const nodes = makeNodes([['A', 10], ['B', 10], ['X', 5]]);
    const matrix = makeLinkMatrix([['A', 'B', 7]]);
    const min = 5;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max);
    assert.ok(result.solutions.length > 0);

    for (const sol of result.solutions) {
      const allGrouped = sol.groups.flat();
      assert.ok(allGrouped.includes('X'), `X must be in some group when free nodes not allowed`);
      assert.deepEqual(sol.freeNodes, [], 'No free nodes when allowFreeNodes is false');
    }
    allNodesAccountedFor(result.solutions, ['A', 'B', 'X']);
  });

  it('solutions include freeNodes array', () => {
    const nodes = makeNodes([['A', 10], ['B', 10], ['C', 3]]);
    const matrix = makeLinkMatrix([['A', 'B', 5]]);
    const result = computeGroups(nodes, matrix, 10, 25, { allowFreeNodes: true });

    for (const sol of result.solutions) {
      assert.ok(Array.isArray(sol.freeNodes), 'Every solution must have a freeNodes array');
    }
  });

  it('free nodes are not double-counted in groups', () => {
    const nodes = makeNodes([['A', 5], ['B', 5], ['C', 5], ['D', 5]]);
    const matrix = makeLinkMatrix([['A', 'B', 10], ['C', 'D', 8]]);
    const result = computeGroups(nodes, matrix, 5, 15, { allowFreeNodes: true });

    for (const sol of result.solutions) {
      const grouped = new Set(sol.groups.flat());
      const free = new Set(sol.freeNodes);
      for (const id of free) {
        assert.ok(!grouped.has(id), `Node ${id} is both free and grouped`);
      }
    }
  });

  it('multiple isolated nodes all become free', () => {
    // A-B linked; X, Y, Z all isolated
    const nodes = makeNodes([['A', 10], ['B', 10], ['X', 3], ['Y', 4], ['Z', 2]]);
    const matrix = makeLinkMatrix([['A', 'B', 12]]);
    const min = 10;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max, { allowFreeNodes: true });
    assert.ok(result.solutions.length > 0);

    const best = result.solutions[0];
    const freeSet = new Set(best.freeNodes);
    assert.ok(freeSet.has('X'), 'X should be free');
    assert.ok(freeSet.has('Y'), 'Y should be free');
    assert.ok(freeSet.has('Z'), 'Z should be free');
    assert.equal(best.totalWeight, 12);
  });

  it('node with weak links can be freed if it improves solution', () => {
    // A-B strongly linked (10), C has weak link to A (1) but no link to B
    // With allowFreeNodes, the solver may choose to free C if it
    // doesn't help any group. At minimum, freeing C shouldn't break anything.
    const nodes = makeNodes([['A', 10], ['B', 10], ['C', 10]]);
    const matrix = makeLinkMatrix([['A', 'B', 10], ['A', 'C', 1]]);
    const min = 10;
    const max = 20;

    const result = computeGroups(nodes, matrix, min, max, { allowFreeNodes: true });
    assert.ok(result.solutions.length > 0);

    for (const sol of result.solutions) {
      allGroupsValid([sol], min, max, nodes);
      // Every node is either grouped or free, not missing
      const all = new Set([...sol.groups.flat(), ...sol.freeNodes]);
      assert.equal(all.size, 3, 'All 3 nodes must be accounted for');
    }
  });

  it('groups still respect min/max bounds with free nodes enabled', () => {
    const nodes = makeNodes([
      ['A', 8], ['B', 7], ['C', 6], ['D', 9], ['X', 3],
    ]);
    const matrix = makeLinkMatrix([
      ['A', 'B', 5], ['C', 'D', 4], ['A', 'D', 2],
    ]);
    const min = 10;
    const max = 20;

    const result = computeGroups(nodes, matrix, min, max, { allowFreeNodes: true });
    assert.ok(result.solutions.length > 0);
    allGroupsValid(result.solutions, min, max, nodes);
  });

  it('two disconnected components with free node', () => {
    // comp1: A-B, comp2: C-D, isolated: X
    const nodes = makeNodes([['A', 10], ['B', 10], ['C', 10], ['D', 10], ['X', 5]]);
    const matrix = makeLinkMatrix([['A', 'B', 6], ['C', 'D', 9]]);
    const min = 10;
    const max = 25;

    const result = computeGroups(nodes, matrix, min, max, { allowFreeNodes: true });
    assert.ok(result.solutions.length > 0);

    const best = result.solutions[0];
    assert.ok(best.freeNodes.includes('X'), 'Isolated X should be free');
    assert.equal(best.totalWeight, 15, 'totalWeight should be 6 + 9 = 15');

    // No group should mix components
    const comp1 = new Set(['A', 'B']);
    const comp2 = new Set(['C', 'D']);
    for (const gd of best.groupDetails) {
      const hasC1 = gd.nodeIds.some((id) => comp1.has(id));
      const hasC2 = gd.nodeIds.some((id) => comp2.has(id));
      assert.ok(!(hasC1 && hasC2), `Group [${gd.nodeIds}] mixes components`);
    }
  });
});
