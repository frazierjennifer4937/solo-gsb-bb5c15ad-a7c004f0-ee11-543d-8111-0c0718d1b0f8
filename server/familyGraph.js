'use strict';

/**
 * 家谱图核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 关系模型：每条边 parent -> child（父母 → 子女）。
 * parentsOf[child] = [parentA, parentB]，每名子女至多两位父母。
 * 每个连通结构必须是有向无环图（DAG），即沿父母链向上永远不会回到自身。
 */

const MAX_PARENTS_PER_CHILD = 2;
const MAX_MEMBERS = 30;
const MAX_BATCH_EDGES = 100;

/** 创建一个空的家谱状态对象 */
function createState(maxMembers = MAX_MEMBERS) {
  return {
    maxMembers,
    members: [], // [{ id, name }]
    parentsOf: {}, // memberId -> [parentId, ...]
  };
}

function getMember(state, id) {
  return state.members.find((m) => m.id === id) || null;
}

function hasMember(state, id) {
  return state.members.some((m) => m.id === id);
}

/**
 * 判断从 from 出发沿“父母链”向上是否能到达 to（含 from === to）。
 * parentsOf 是一个 DAG（外部保证），此处用栈式 DFS。
 */
function isReachableUp(state, from, to) {
  if (from === to) return true;
  const stack = [...(state.parentsOf[from] || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of state.parentsOf[cur] || []) stack.push(p);
  }
  return false;
}

/**
 * 校验并尝试添加一条 parent -> child 边。
 * 返回 { error: string } 或 { error: null }。
 * 不修改 state（由调用方在校验通过后写入）。
 */
function validateEdge(state, parentId, childId) {
  if (!hasMember(state, parentId)) return { error: '父母成员不存在' };
  if (!hasMember(state, childId)) return { error: '子女成员不存在' };

  if (parentId === childId) {
    return { error: '拒绝自指关系：不能成为自己的父母' };
  }

  const parents = state.parentsOf[childId] || [];
  if (parents.includes(parentId)) {
    return { error: '拒绝重复边：该父母→子女关系已存在' };
  }
  if (parents.length >= MAX_PARENTS_PER_CHILD) {
    return {
      error: `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母，该成员已有 ${parents.length} 位父母`,
    };
  }

  // 祖先环路检测：若 parent 沿父母链向上能到达 child，
  // 再加 child 成为 parent 的祖先，则 child 会成为自己的祖先。
  if (isReachableUp(state, parentId, childId)) {
    return { error: '拒绝祖先环路：该父母已是此子女的后代，添加后将形成循环祖先关系' };
  }

  return { error: null };
}

/**
 * 批量校验待添加的父母→子女草稿（纯函数，不修改 state）。
 *
 * 校验基准是「当前已有关系 + 整批草稿」合并后的完整结果，而不是逐条顺序处理：
 * 因此先入草稿在判定中不会“生效”，草稿顺序如何排列都不影响任何一条的结论。
 *
 * 每条草稿可能同时命中多个错误，errors 为全部命中项：
 *   - 父母/子女成员不存在（或格式非法）
 *   - 自指
 *   - 批内重复（同一对父母→子女在草稿中出现多次）
 *   - 与已有关系重复
 *   - 合并后该子女父母超过两位（计数只含已有关系 + 批内去重后的边）
 *   - 祖先环路（在合并后的图上检测，任一条边使合并图成环都会被标记）
 *
 * 返回 { valid, error: string|null, items: [{ index, parentId, childId, errors }] }。
 * valid 仅在非空且每条草稿都无错误时为 true；任何一条无效，整批都不可提交。
 */
function validateEdgeBatch(state, rawEdges) {
  if (!Array.isArray(rawEdges)) {
    return { valid: false, error: '草稿必须是数组', items: [] };
  }
  if (rawEdges.length === 0) {
    return { valid: false, error: '草稿为空：请至少添加一条父母→子女关系', items: [] };
  }
  if (rawEdges.length > MAX_BATCH_EDGES) {
    return {
      valid: false,
      error: `单批最多 ${MAX_BATCH_EDGES} 条草稿，当前 ${rawEdges.length} 条`,
      items: [],
    };
  }

  // 第一阶段：结构校验（成员存在、自指），同时按「无序对 child|parent」找批内重复。
  // 结构不合法的条目不参与后续计数与环路检测。
  const items = rawEdges.map((raw, index) => {
    const parentId =
      raw && typeof raw.parentId === 'string' ? raw.parentId.trim() : '';
    const childId =
      raw && typeof raw.childId === 'string' ? raw.childId.trim() : '';
    const errors = [];
    let structurallyValid = true;

    if (!parentId || !hasMember(state, parentId)) {
      errors.push('父母成员不存在');
      structurallyValid = false;
    }
    if (!childId || !hasMember(state, childId)) {
      errors.push('子女成员不存在');
      structurallyValid = false;
    }
    if (parentId && childId && parentId === childId) {
      errors.push('拒绝自指关系：不能成为自己的父母');
      structurallyValid = false;
    }

    return { index, parentId: parentId || null, childId: childId || null, errors, structurallyValid };
  });

  // 批内重复：同一条父母→子女在草稿中出现多次（所有副本一起标记）
  const keyOf = (parentId, childId) => `${childId}|${parentId}`;
  const groups = new Map();
  for (const item of items) {
    if (!item.structurallyValid) continue;
    const key = keyOf(item.parentId, item.childId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      for (const item of group) item.errors.push('批内重复：该父母→子女关系在草稿中出现多次');
    }
  }

  // 第二阶段：合并结果上的去重边集（已有关系 + 批内去重后的结构合法边）。
  // 与已有重复、超父母上限的边同样纳入合并图做环路检测：
  // 环路是整批合并结果的性质，与“哪些边最终能写入”无关，且判定不依赖顺序。
  const existingByChild = new Map();
  for (const e of edgesFromState(state)) {
    if (!existingByChild.has(e.childId)) existingByChild.set(e.childId, new Set());
    existingByChild.get(e.childId).add(e.parentId);
  }

  const merged = new Map(); // childId -> Set<parentId>（已有关系为底）
  for (const [childId, parents] of existingByChild) {
    merged.set(childId, new Set(parents));
  }

  const duplicateFreeCandidates = new Map(); // childId -> Set<parentId>，仅批内去重后
  const newCandidates = new Map(); // childId -> Set<parentId>，批内去重且不与已有重复
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (!duplicateFreeCandidates.has(item.childId)) duplicateFreeCandidates.set(item.childId, new Set());
    duplicateFreeCandidates.get(item.childId).add(item.parentId);
    const isExistingDup = !!(existingByChild.get(item.childId) && existingByChild.get(item.childId).has(item.parentId));
    if (!isExistingDup) {
      if (!newCandidates.has(item.childId)) newCandidates.set(item.childId, new Set());
      newCandidates.get(item.childId).add(item.parentId);
    }
    if (!merged.has(item.childId)) merged.set(item.childId, new Set());
    merged.get(item.childId).add(item.parentId);
  }

  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    const existing = existingByChild.get(item.childId);
    if (existing && existing.has(item.parentId)) {
      item.errors.push('拒绝重复边：该父母→子女关系已存在');
    }
  }

  // 每名子女至多两位父母：合并后总父母数 = 现有父母 + 草稿中新引入的父母（去重）。
  // 与已有重复的边不会引入新父母，因此不参与计数；超限则该子女下全部新边都标记。
  for (const [childId, incoming] of newCandidates) {
    const existingCount = existingByChild.has(childId) ? existingByChild.get(childId).size : 0;
    const total = existingCount + incoming.size;
    if (total > MAX_PARENTS_PER_CHILD) {
      for (const parentId of incoming) {
        for (const item of items) {
          if (
            item.childId === childId &&
            item.parentId === parentId &&
            item.structurallyValid &&
            groups.get(keyOf(parentId, childId)).length === 1
          ) {
            item.errors.push(
              `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母：合并草稿后该子女将有 ${total} 位父母（现有 ${existingCount} 位）`,
            );
          }
        }
      }
    }
  }

  // 祖先环路：在合并后的图上，对每条候选边检查 parent 是否沿父母链向上可达 child。
  // 可达性基于最终合并图（而非逐条累加），故结论与草稿顺序无关。
  const mergedState = {
    ...state,
    parentsOf: Object.fromEntries(
      [...merged.entries()].map(([childId, parents]) => [childId, [...parents]]),
    ),
  };
  for (const item of items) {
    if (!item.structurallyValid) continue;
    if (groups.get(keyOf(item.parentId, item.childId)).length > 1) continue;
    if (isReachableUp(mergedState, item.parentId, item.childId)) {
      item.errors.push('拒绝祖先环路：合并该批草稿后将形成循环祖先关系');
    }
  }

  const valid = items.every((item) => item.errors.length === 0);
  return {
    valid,
    error: valid
      ? null
      : `草稿中有 ${items.filter((i) => i.errors.length > 0).length} 条关系不合法，整批不可提交`,
    items: items.map(({ index, parentId, childId, errors }) => ({ index, parentId, childId, errors })),
  };
}

/** 从状态导出边表（与 store 内的 edgesList 保持一致的最小实现） */
function edgesFromState(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf || {})) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

/**
 * BFS 沿父母链向上，返回从 start 到其全部祖先（含自身）的“全部最短路径”。
 *
 * 返回 Map: ancestorId -> {
 *   gen: number,                 // 最短代数（向上步数）：自身 0、父母 1、祖父母 2……
 *   paths: Array<Array<id>>,     // 所有长度等于 gen 的路径，方向 start → ... → ancestor
 * }
 *
 * 同代数的不同路径全部保留（例如同时通过父系与母系到达同一祖父母）。
 */
function allShortestPathsUp(state, start) {
  const result = new Map();
  result.set(start, { gen: 0, paths: [[start]] });
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const curInfo = result.get(cur);
    for (const p of state.parentsOf[cur] || []) {
      const nextGen = curInfo.gen + 1;
      if (!result.has(p)) {
        // 首次以 BFS 到达 p，nextGen 即最短代数
        result.set(p, {
          gen: nextGen,
          paths: curInfo.paths.map((path) => [...path, p]),
        });
        queue.push(p);
      } else if (result.get(p).gen === nextGen) {
        // 同一最短代数经另一条路径再次到达 → 保留该路径
        const info = result.get(p);
        for (const path of curInfo.paths) info.paths.push([...path, p]);
      }
      // result.get(p).gen < nextGen：更长路径，丢弃
    }
  }
  return result;
}

/**
 * 查询两人的共同祖先。
 * 返回 {
 *   samePerson: boolean,
 *   minTotalGen: number,
 *   ancestors: [{ id, genA, genB, pathsA: [[id]], pathsB: [[id]] }]
 * }
 * minTotalGen 为所有共同祖先中 genA + genB 的最小值；
 * 只返回达到该最小值的全部共同祖先；没有共同祖先时 ancestors 为空。
 */
function findCommonAncestors(state, idA, idB) {
  if (!hasMember(state, idA) || !hasMember(state, idB)) {
    return { error: '成员不存在' };
  }

  if (idA === idB) {
    const self = allShortestPathsUp(state, idA).get(idA);
    return {
      samePerson: true,
      minTotalGen: 0,
      ancestors: [
        {
          id: idA,
          genA: 0,
          genB: 0,
          totalGen: 0,
          pathsA: self.paths,
          pathsB: self.paths,
        },
      ],
    };
  }

  const upA = allShortestPathsUp(state, idA);
  const upB = allShortestPathsUp(state, idB);

  const common = [];
  let minTotalGen = Infinity;
  for (const [ancestorId, infoA] of upA) {
    const infoB = upB.get(ancestorId);
    if (!infoB) continue;
    const totalGen = infoA.gen + infoB.gen;
    if (totalGen < minTotalGen) minTotalGen = totalGen;
    common.push({
      id: ancestorId,
      genA: infoA.gen,
      genB: infoB.gen,
      totalGen,
      pathsA: infoA.paths,
      pathsB: infoB.paths,
    });
  }

  const nearest = common
    .filter((c) => c.totalGen === minTotalGen)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    samePerson: false,
    minTotalGen: minTotalGen === Infinity ? null : minTotalGen,
    ancestors: nearest,
  };
}

module.exports = {
  MAX_PARENTS_PER_CHILD,
  MAX_MEMBERS,
  MAX_BATCH_EDGES,
  createState,
  getMember,
  isReachableUp,
  validateEdge,
  validateEdgeBatch,
  allShortestPathsUp,
  findCommonAncestors,
};
