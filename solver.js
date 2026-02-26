/**
 * Node Group Organizer — Solver
 *
 * Pure-logic module (no DOM). Importable in browser (ES module) and Node.
 *
 * Terminology:
 *   nodeWeight              – weight of a single node
 *   linkWeight              – weight of the relationship between two nodes
 *   combinedWeight (group)  – sum of linkWeights for all intra-group node pairs
 *   totalWeight (solution)  – sum of combinedWeights across all groups
 *   minimumCombinedWeight   – lower bound on sum-of-nodeWeights per group
 *   maximumCombinedWeight   – upper bound on sum-of-nodeWeights per group
 *   allowFreeNodes          – when true, nodes may be left outside any group
 */

// ── Validation ──────────────────────────────────────────────────────────────

export function validate(nodes, linkMatrix, minCombined, maxCombined) {
  const errors = [];

  if (!nodes || nodes.length === 0) {
    errors.push('At least one node is required.');
  }

  if (minCombined > maxCombined) {
    errors.push(
      `minimumCombinedWeight (${minCombined}) must be ≤ maximumCombinedWeight (${maxCombined}).`
    );
  }

  for (const n of nodes) {
    if (n.nodeWeight > maxCombined) {
      errors.push(
        `Node "${n.id}" has nodeWeight ${n.nodeWeight} which exceeds maximumCombinedWeight ${maxCombined}.`
      );
    }
  }

  return errors;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function groupNodeWeightSum(group, nodesById) {
  return group.reduce((s, id) => s + nodesById[id].nodeWeight, 0);
}

function getPairLinkWeight(linkMatrix, a, b, symmetricLinks) {
  const ab = linkMatrix[`${a}|${b}`] || 0;
  const ba = linkMatrix[`${b}|${a}`] || 0;
  if (symmetricLinks) return ab || ba;
  return ab + ba;
}

function groupCombinedWeight(group, linkMatrix, symmetricLinks) {
  let w = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      w += getPairLinkWeight(linkMatrix, group[i], group[j], symmetricLinks);
    }
  }
  return w;
}

function getLinkWeight(linkMatrix, a, b, symmetricLinks) {
  return getPairLinkWeight(linkMatrix, a, b, symmetricLinks);
}

function nodeHasAnyLink(nodeId, allIds, linkMatrix, symmetricLinks) {
  for (const other of allIds) {
    if (other !== nodeId && getLinkWeight(linkMatrix, nodeId, other, symmetricLinks) !== 0) return true;
  }
  return false;
}

function solutionTotalWeight(groups, linkMatrix, symmetricLinks) {
  return groups.reduce((s, g) => s + groupCombinedWeight(g, linkMatrix, symmetricLinks), 0);
}

function buildGroupDetails(groups, linkMatrix, nodesById, symmetricLinks) {
  return groups.map((g) => ({
    nodeIds: [...g],
    nodeWeightSum: groupNodeWeightSum(g, nodesById),
    combinedWeight: groupCombinedWeight(g, linkMatrix, symmetricLinks),
  }));
}

function solutionKey(groups, freeNodes = []) {
  const groupPart = groups
    .map((g) => [...g].sort().join(','))
    .sort()
    .join('|');
  const freePart = [...freeNodes].sort().join(',');
  return freePart ? `${groupPart}||free:${freePart}` : groupPart;
}

function solutionHasDuplicateNodes(groups, freeNodes, totalNodeCount) {
  const allIds = groups.flat().concat(freeNodes);
  if (allIds.length !== totalNodeCount) return true;
  return new Set(allIds).size !== totalNodeCount;
}

function variance(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  return values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
}

// ── Solver entry ────────────────────────────────────────────────────────────

export function computeGroups(nodes, linkMatrix, minCombined, maxCombined, options = {}) {
  const { allowFreeNodes = false, symmetricLinks = true, balanceGroupWeightsFactor = 0, bonusPerGroup = 0, fixedGroups: rawFixedGroups = [] } = options;

  const errors = validate(nodes, linkMatrix, minCombined, maxCombined);
  if (errors.length > 0) {
    return { solutions: [], errors };
  }

  const nodesById = {};
  for (const n of nodes) nodesById[n.id] = n;
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const totalNodeCount = ids.length;

  let fixedGroups = rawFixedGroups.filter((g) => Array.isArray(g) && g.length > 0).map((g) => g.filter((id) => idSet.has(id))).filter((g) => g.length > 0);
  const fixedNodeSet = new Set(fixedGroups.flat());
  if (fixedNodeSet.size !== fixedGroups.flat().length) {
    errors.push('Fixed groups must not contain duplicate nodes.');
    return { solutions: [], errors };
  }
  for (const g of fixedGroups) {
    const sum = groupNodeWeightSum(g, nodesById);
    if (sum > maxCombined) {
      errors.push(`A fixed group exceeds maximum combined weight (${maxCombined}).`);
      return { solutions: [], errors };
    }
  }
  const freeIds = ids.filter((id) => !fixedNodeSet.has(id));
  const numFixed = fixedGroups.length;

  const seen = new Set();
  const solutions = [];

  function solutionScore(sol) {
    let score = sol.totalWeight + bonusPerGroup * sol.groups.length;
    if (balanceGroupWeightsFactor > 0 && sol.groupDetails.length > 0) {
      const combinedWeights = sol.groupDetails.map((d) => d.combinedWeight);
      score -= balanceGroupWeightsFactor * variance(combinedWeights);
    }
    return score;
  }

  function addSolution(groups, freeNodes = []) {
    if (solutionHasDuplicateNodes(groups, freeNodes, totalNodeCount)) return;
    const key = solutionKey(groups, freeNodes);
    if (seen.has(key)) return;
    seen.add(key);

    const details = buildGroupDetails(groups, linkMatrix, nodesById, symmetricLinks);
    const totalWeight = details.reduce((s, d) => s + d.combinedWeight, 0);
    solutions.push({
      groups: groups.map((g) => [...g]),
      freeNodes: [...freeNodes],
      totalWeight,
      groupDetails: details,
    });

    solutions.sort((a, b) => solutionScore(b) - solutionScore(a));
    if (solutions.length > 10) solutions.length = 10;
  }

  const isSmall = ids.length <= (allowFreeNodes ? 12 : 16);

  if (numFixed === 0) {
    if (isSmall) {
      exhaustiveSearch(ids, nodesById, linkMatrix, minCombined, maxCombined, addSolution, allowFreeNodes, symmetricLinks);
    }
    for (let seed = 0; seed < 20; seed++) {
      const result = greedyBuild(ids, nodesById, linkMatrix, minCombined, maxCombined, seed, allowFreeNodes, symmetricLinks);
      if (result) {
        addSolution(result.groups, result.freeNodes);
        const improved = localSearch(
          result.groups, result.freeNodes, ids, nodesById, linkMatrix,
          minCombined, maxCombined, allowFreeNodes, symmetricLinks, 0
        );
        if (improved) addSolution(improved.groups, improved.freeNodes);
      }
    }
  } else {
    for (let seed = 0; seed < 20; seed++) {
      const result = greedyBuildWithFixed(freeIds, fixedGroups, nodesById, linkMatrix, minCombined, maxCombined, seed, allowFreeNodes, symmetricLinks);
      if (result) {
        addSolution(result.groups, result.freeNodes);
        const improved = localSearch(
          result.groups, result.freeNodes, ids, nodesById, linkMatrix,
          minCombined, maxCombined, allowFreeNodes, symmetricLinks, fixedGroups
        );
        if (improved) addSolution(improved.groups, improved.freeNodes);
      }
    }
  }

  pruneWastefulSolutions(solutions, linkMatrix, symmetricLinks);

  if (balanceGroupWeightsFactor > 0) {
    solutions.sort((a, b) => solutionScore(b) - solutionScore(a));
  }

  const optimal = isSmall && numFixed === 0 && solutions.length > 0;

  return { solutions, optimal, errors: [] };
}

// ── Solution pruning ────────────────────────────────────────────────────────

function pruneWastefulSolutions(solutions, linkMatrix, symmetricLinks) {
  if (solutions.length === 0) return;

  function isWasteful(sol) {
    return sol.groupDetails.some((gd) => {
      if (gd.nodeIds.length <= 1) return false;
      return gd.nodeIds.some((id) =>
        gd.nodeIds.every((other) => other === id || getLinkWeight(linkMatrix, id, other, symmetricLinks) === 0)
      );
    });
  }

  const hasNonWasteful = solutions.some((s) => !isWasteful(s));
  if (hasNonWasteful) {
    for (let i = solutions.length - 1; i >= 0; i--) {
      if (isWasteful(solutions[i])) solutions.splice(i, 1);
    }
  }
}

// ── Exhaustive search (small instances) ─────────────────────────────────────

function exhaustiveSearch(ids, nodesById, linkMatrix, minCombined, maxCombined, addSolution, allowFreeNodes, symmetricLinks) {
  const n = ids.length;
  const maxGroups = n;
  const assignment = new Array(n).fill(0);

  function recurse(pos) {
    if (pos === n) {
      const groupMap = {};
      const freeNodes = [];
      for (let i = 0; i < n; i++) {
        if (assignment[i] === -1) {
          freeNodes.push(ids[i]);
        } else {
          const g = assignment[i];
          if (!groupMap[g]) groupMap[g] = [];
          groupMap[g].push(ids[i]);
        }
      }
      const groups = Object.values(groupMap);
      for (const g of groups) {
        const nwSum = groupNodeWeightSum(g, nodesById);
        if (nwSum < minCombined || nwSum > maxCombined) return;
      }
      addSolution(groups, freeNodes);
      return;
    }

    // Option: make this node free
    if (allowFreeNodes) {
      assignment[pos] = -1;
      recurse(pos + 1);
    }

    // Collect used group indices from already-assigned (non-free) nodes
    const usedGroups = new Set();
    for (let i = 0; i < pos; i++) {
      if (assignment[i] >= 0) usedGroups.add(assignment[i]);
    }

    // Option: assign to an existing group
    for (const g of usedGroups) {
      assignment[pos] = g;
      const currentGroup = [];
      for (let i = 0; i <= pos; i++) {
        if (assignment[i] === g) currentGroup.push(ids[i]);
      }
      if (groupNodeWeightSum(currentGroup, nodesById) <= maxCombined) {
        recurse(pos + 1);
      }
    }

    // Option: start a new group
    const nextNew = usedGroups.size > 0 ? Math.max(...usedGroups) + 1 : 0;
    if (nextNew < maxGroups) {
      assignment[pos] = nextNew;
      recurse(pos + 1);
    }
  }

  recurse(0);
}

// ── Greedy build ────────────────────────────────────────────────────────────

function greedyBuild(ids, nodesById, linkMatrix, minCombined, maxCombined, seed, allowFreeNodes, symmetricLinks) {
  const shuffled = shuffleWithSeed([...ids], seed);
  const groups = [];
  const assigned = new Set();

  const edges = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const w = getLinkWeight(linkMatrix, ids[i], ids[j], symmetricLinks);
      if (w !== 0) edges.push({ a: ids[i], b: ids[j], w });
    }
  }

  const rng = mulberry32(seed);
  edges.sort((x, y) => {
    const diff = y.w - x.w;
    if (diff !== 0) return diff;
    return rng() - 0.5;
  });

  for (const { a, b } of edges) {
    if (assigned.has(a) && assigned.has(b)) continue;

    if (!assigned.has(a) && !assigned.has(b)) {
      const nwSum = nodesById[a].nodeWeight + nodesById[b].nodeWeight;
      if (nwSum <= maxCombined) {
        groups.push([a, b]);
        assigned.add(a);
        assigned.add(b);
        continue;
      }
    }

    const inGroup = assigned.has(a) ? a : b;
    const outside = assigned.has(a) ? b : a;
    if (assigned.has(outside)) continue;

    for (const g of groups) {
      if (!g.includes(inGroup)) continue;
      const newSum = groupNodeWeightSum(g, nodesById) + nodesById[outside].nodeWeight;
      if (newSum <= maxCombined) {
        g.push(outside);
        assigned.add(outside);
        break;
      }
    }
  }

  // Handle unassigned nodes
  const freeNodes = [];
  for (const id of shuffled) {
    if (assigned.has(id)) continue;

    if (allowFreeNodes && !nodeHasAnyLink(id, ids, linkMatrix, symmetricLinks)) {
      freeNodes.push(id);
      continue;
    }

    let placed = false;
    for (const g of groups) {
      const newSum = groupNodeWeightSum(g, nodesById) + nodesById[id].nodeWeight;
      if (newSum <= maxCombined) {
        g.push(id);
        assigned.add(id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (allowFreeNodes) {
        freeNodes.push(id);
      } else {
        groups.push([id]);
        assigned.add(id);
      }
    }
  }

  // Check min constraint — try to merge small groups
  const hasUnderMin = groups.some((g) => groupNodeWeightSum(g, nodesById) < minCombined);
  if (hasUnderMin) {
    const merged = mergeSmallGroups(groups, nodesById, minCombined, maxCombined, allowFreeNodes, freeNodes);
    if (!merged) return null;
    return merged;
  }

  return { groups, freeNodes };
}

function greedyBuildWithFixed(freeIds, fixedGroups, nodesById, linkMatrix, minCombined, maxCombined, seed, allowFreeNodes, symmetricLinks) {
  const groups = fixedGroups.map((g) => [...g]);
  const assigned = new Set(groups.flat());
  const allIds = [...new Set([...freeIds, ...assigned])];
  const freeSet = new Set(freeIds);

  const edges = [];
  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      const w = getLinkWeight(linkMatrix, allIds[i], allIds[j], symmetricLinks);
      if (w !== 0) edges.push({ a: allIds[i], b: allIds[j], w });
    }
  }

  const rng = mulberry32(seed);
  edges.sort((x, y) => {
    const diff = y.w - x.w;
    if (diff !== 0) return diff;
    return rng() - 0.5;
  });

  for (const { a, b } of edges) {
    if (assigned.has(a) && assigned.has(b)) continue;

    const inGroup = assigned.has(a) ? a : assigned.has(b) ? b : null;
    const outside = inGroup === a ? b : inGroup === b ? a : null;
    if (inGroup !== null && outside !== null) {
      for (const g of groups) {
        if (!g.includes(inGroup)) continue;
        const newSum = groupNodeWeightSum(g, nodesById) + nodesById[outside].nodeWeight;
        if (newSum <= maxCombined) {
          g.push(outside);
          assigned.add(outside);
          break;
        }
      }
      continue;
    }

    if (!assigned.has(a) && !assigned.has(b) && freeSet.has(a) && freeSet.has(b)) {
      const nwSum = nodesById[a].nodeWeight + nodesById[b].nodeWeight;
      if (nwSum <= maxCombined) {
        groups.push([a, b]);
        assigned.add(a);
        assigned.add(b);
      }
    }
  }

  const shuffledFree = shuffleWithSeed([...freeIds], seed + 1000);
  const freeNodes = [];
  for (const id of shuffledFree) {
    if (assigned.has(id)) continue;

    if (allowFreeNodes && !nodeHasAnyLink(id, allIds, linkMatrix, symmetricLinks)) {
      freeNodes.push(id);
      continue;
    }

    let placed = false;
    for (const g of groups) {
      const newSum = groupNodeWeightSum(g, nodesById) + nodesById[id].nodeWeight;
      if (newSum <= maxCombined) {
        g.push(id);
        assigned.add(id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      if (allowFreeNodes) {
        freeNodes.push(id);
      } else {
        groups.push([id]);
        assigned.add(id);
      }
    }
  }

  const hasUnderMin = groups.some((g) => groupNodeWeightSum(g, nodesById) < minCombined);
  if (hasUnderMin) {
    const merged = mergeSmallGroupsWithFixed(groups, nodesById, minCombined, maxCombined, allowFreeNodes, freeNodes, fixedGroups);
    if (!merged) return null;
    return merged;
  }

  return { groups, freeNodes };
}

function mergeSmallGroupsWithFixed(groups, nodesById, minCombined, maxCombined, allowFreeNodes, freeNodes, fixedGroupsParam) {
  let merged = groups.map((g) => [...g]);
  let free = [...(freeNodes || [])];
  let changed = true;
  const fixedGroupIds = new Set((fixedGroupsParam || []).flat());

  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (groupNodeWeightSum(merged[i], nodesById) >= minCombined) continue;
      let didMerge = false;
      for (let j = 0; j < merged.length; j++) {
        if (i === j) continue;
        const combined = [...merged[i], ...merged[j]];
        if (groupNodeWeightSum(combined, nodesById) <= maxCombined) {
          const at = Math.min(i, j);
          const rm = Math.max(i, j);
          merged[at] = combined;
          merged.splice(rm, 1);
          if (rm <= i) i--;
          changed = true;
          didMerge = true;
          break;
        }
      }
      const groupHasFixed = merged[i].some((id) => fixedGroupIds.has(id));
      if (!didMerge && allowFreeNodes && !groupHasFixed) {
        free.push(...merged[i]);
        merged.splice(i, 1);
        i--;
        changed = true;
      }
      if (changed) break;
    }
  }

  for (const g of merged) {
    const s = groupNodeWeightSum(g, nodesById);
    if (s < minCombined || s > maxCombined) return null;
  }

  return { groups: merged, freeNodes: free };
}

function mergeSmallGroups(groups, nodesById, minCombined, maxCombined, allowFreeNodes, freeNodes) {
  let merged = groups.map((g) => [...g]);
  let free = [...(freeNodes || [])];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      if (groupNodeWeightSum(merged[i], nodesById) >= minCombined) continue;
      let didMerge = false;
      for (let j = 0; j < merged.length; j++) {
        if (i === j) continue;
        const combined = [...merged[i], ...merged[j]];
        if (groupNodeWeightSum(combined, nodesById) <= maxCombined) {
          merged[i] = combined;
          merged.splice(j, 1);
          if (j < i) i--;
          changed = true;
          didMerge = true;
          break;
        }
      }
      if (!didMerge && allowFreeNodes) {
        // Can't merge this under-min group — free its nodes
        free.push(...merged[i]);
        merged.splice(i, 1);
        i--;
        changed = true;
      }
      if (changed) break;
    }
  }

  for (const g of merged) {
    const s = groupNodeWeightSum(g, nodesById);
    if (s < minCombined || s > maxCombined) return null;
  }

  return { groups: merged, freeNodes: free };
}

// ── Local search ────────────────────────────────────────────────────────────

function localSearch(initialGroups, initialFreeNodes, ids, nodesById, linkMatrix, minCombined, maxCombined, allowFreeNodes, symmetricLinks, fixedGroupsParam = []) {
  let best = initialGroups.map((g) => [...g]);
  let bestFree = [...(initialFreeNodes || [])];
  let bestTotal = solutionTotalWeight(best, linkMatrix, symmetricLinks);
  let improved = true;

  const nodeToFixedGroup = new Map();
  for (const fg of fixedGroupsParam) {
    for (const id of fg) nodeToFixedGroup.set(id, fg);
  }

  for (let iter = 0; iter < 200 && improved; iter++) {
    improved = false;

    for (let gi = 0; gi < best.length; gi++) {
      for (let ni = 0; ni < best[gi].length; ni++) {
        const node = best[gi][ni];
        const fixedGroup = nodeToFixedGroup.get(node);
        const nodesToMove = fixedGroup ? fixedGroup.filter((id) => best[gi].includes(id)) : [node];
        if (fixedGroup && nodesToMove.length !== fixedGroup.length) continue;
        if (nodesToMove.length === 0) continue;

        for (let gj = 0; gj < best.length; gj++) {
          if (gi === gj) continue;

          const srcAfter = best[gi].filter((id) => !nodesToMove.includes(id));
          const dstAfter = [...best[gj], ...nodesToMove];

          if (srcAfter.length > 0) {
            const srcSum = groupNodeWeightSum(srcAfter, nodesById);
            const dstSum = groupNodeWeightSum(dstAfter, nodesById);
            if (srcSum < minCombined || dstSum > maxCombined) continue;

            const candidate = best.map((g, idx) => {
              if (idx === gi) return srcAfter;
              if (idx === gj) return dstAfter;
              return [...g];
            });
            const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
            if (total > bestTotal) {
              best = candidate;
              bestTotal = total;
              improved = true;
            }
          } else {
            const candidate = best
              .filter((_, idx) => idx !== gi)
              .map((g, idx) => {
                const adjustedGj = gj > gi ? gj - 1 : gj;
                if (idx === adjustedGj) return dstAfter;
                return [...g];
              });

            const dstSum = groupNodeWeightSum(dstAfter, nodesById);
            if (dstSum > maxCombined) continue;

            let valid = true;
            for (const g of candidate) {
              const s = groupNodeWeightSum(g, nodesById);
              if (s < minCombined || s > maxCombined) { valid = false; break; }
            }
            if (!valid) continue;

            const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
            if (total > bestTotal) {
              best = candidate;
              bestTotal = total;
              improved = true;
            }
          }
        }

        // Try moving node from group to free (only from non-fixed groups)
        if (allowFreeNodes && gi >= numFixed) {
          const srcAfter = best[gi].filter((_, idx) => idx !== ni);
          if (srcAfter.length > 0) {
            const srcSum = groupNodeWeightSum(srcAfter, nodesById);
            if (srcSum >= minCombined) {
              const candidate = best.map((g, idx) => (idx === gi ? srcAfter : [...g]));
              const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
              if (total > bestTotal) {
                best = candidate;
                bestFree = [...bestFree, node];
                bestTotal = total;
                improved = true;
              }
            }
          } else {
            // Group becomes empty — remove it, node goes free
            const candidate = best.filter((_, idx) => idx !== gi);
            let valid = true;
            for (const g of candidate) {
              const s = groupNodeWeightSum(g, nodesById);
              if (s < minCombined || s > maxCombined) { valid = false; break; }
            }
            if (valid) {
              const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
              if (total >= bestTotal) {
                best = candidate;
                bestFree = [...bestFree, node];
                bestTotal = total;
                improved = true;
              }
            }
          }
        }

        if (improved) break;
      }
      if (improved) break;
    }

    // Try moving free nodes into groups
    if (!improved && allowFreeNodes && bestFree.length > 0) {
      for (let fi = 0; fi < bestFree.length && !improved; fi++) {
        const node = bestFree[fi];
        for (let gj = 0; gj < best.length && !improved; gj++) {
          const dstAfter = [...best[gj], node];
          const dstSum = groupNodeWeightSum(dstAfter, nodesById);
          if (dstSum > maxCombined) continue;

          const candidate = best.map((g, idx) => (idx === gj ? dstAfter : [...g]));
          const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
          if (total > bestTotal) {
            best = candidate;
            bestFree = bestFree.filter((_, idx) => idx !== fi);
            bestTotal = total;
            improved = true;
          }
        }
      }
    }

    if (!improved) {
      // Try swapping two nodes between different groups (only among non-fixed groups)
      for (let gi = numFixed; gi < best.length && !improved; gi++) {
        for (let gj = gi + 1; gj < best.length && !improved; gj++) {
          for (let ni = 0; ni < best[gi].length && !improved; ni++) {
            for (let nj = 0; nj < best[gj].length && !improved; nj++) {
              const candidate = best.map((g) => [...g]);
              const tmp = candidate[gi][ni];
              candidate[gi][ni] = candidate[gj][nj];
              candidate[gj][nj] = tmp;

              const sA = groupNodeWeightSum(candidate[gi], nodesById);
              const sB = groupNodeWeightSum(candidate[gj], nodesById);
              if (sA < minCombined || sA > maxCombined) continue;
              if (sB < minCombined || sB > maxCombined) continue;

              const total = solutionTotalWeight(candidate, linkMatrix, symmetricLinks);
              if (total > bestTotal) {
                best = candidate;
                bestTotal = total;
                improved = true;
              }
            }
          }
        }
      }
    }
  }

  return { groups: best, freeNodes: bestFree };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let t = seed + 0x6d2b79f5;
  return function () {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithSeed(arr, seed) {
  const rng = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Build linkMatrix from flat list ─────────────────────────────────────────

export function buildLinkMatrix(linkWeights) {
  const matrix = {};
  for (const { from, to, linkWeight } of linkWeights) {
    matrix[`${from}|${to}`] = linkWeight;
  }
  return matrix;
}

export function matrixToList(linkMatrix) {
  const list = [];
  for (const [key, linkWeight] of Object.entries(linkMatrix)) {
    const [from, to] = key.split('|');
    list.push({ from, to, linkWeight });
  }
  return list;
}
