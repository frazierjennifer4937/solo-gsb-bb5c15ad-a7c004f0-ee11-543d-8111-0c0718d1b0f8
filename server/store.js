'use strict';

/**
 * JSON 文件持久化：启动时读取，每次变更后同步写入（先写临时文件再 rename）。
 *
 * 家谱版本 version：每次成功变更（成员增删改、关系增删/批量提交）单调 +1，
 * 并随数据落盘。批量预检返回当时的 version，提交时必须原样带回；
 * 预检与提交之间家谱若被其他操作改动，version 不匹配则整批拒绝。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  isReachableUp,
  MAX_MEMBERS,
} = require('./familyGraph');

function createStore(filePath) {
  const loaded = loadState(filePath);
  const state = loaded.state;
  let version = loaded.version;

  /** 每次成功变更后统一落盘并推进家谱版本 */
  function persist() {
    version += 1;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    // 统一以 { members, edges } 的边表格式落盘，与 loadState 读取格式保持一致
    const snapshot = {
      version,
      maxMembers: state.maxMembers,
      members: state.members,
      edges: edgesList(state),
    };
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  function list() {
    return {
      version,
      maxMembers: state.maxMembers,
      members: state.members,
      edges: edgesList(state),
    };
  }

  function addMember(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    if (state.members.length >= state.maxMembers) {
      return { error: `成员数量上限为 ${state.maxMembers} 人，无法继续添加` };
    }
    const member = { id: crypto.randomUUID(), name };
    state.members.push(member);
    state.parentsOf[member.id] = [];
    persist();
    return { error: null, member };
  }

  function renameMember(id, rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    member.name = name;
    persist();
    return { error: null, member };
  }

  /** 删除成员：同时移除以其为父母或子女的全部边（级联） */
  function deleteMember(id) {
    if (!state.members.some((m) => m.id === id)) {
      return { error: '成员不存在' };
    }
    state.members = state.members.filter((m) => m.id !== id);
    delete state.parentsOf[id];
    for (const childId of Object.keys(state.parentsOf)) {
      state.parentsOf[childId] = state.parentsOf[childId].filter((p) => p !== id);
    }
    persist();
    return { error: null };
  }

  function addEdge(parentId, childId) {
    const check = validateEdge(state, parentId, childId);
    if (check.error) return check;
    state.parentsOf[childId].push(parentId);
    persist();
    return { error: null };
  }

  function deleteEdge(parentId, childId) {
    const parents = state.parentsOf[childId];
    if (!parents || !parents.includes(parentId)) {
      return { error: '关系不存在' };
    }
    state.parentsOf[childId] = parents.filter((p) => p !== parentId);
    persist();
    return { error: null };
  }

  /**
   * 整批原子提交父母→子女关系。
   * 先比对家谱版本（乐观锁），再在「当前关系 + 整批草稿」的合并结果上重跑
   * 与预检完全一致的校验；任何一条无效或版本已变化，都不写入任何一条。
   * 全部合法时一次性写入、一次落盘，版本只推进一次。
   */
  function commitEdges(edges, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先预检后再提交', status: 400 };
    }
    if (expectedVersion !== version) {
      return {
        error: '家谱在预检后已被修改，请重新预检后再提交',
        status: 409,
        currentVersion: version,
      };
    }

    const result = validateEdgeBatch(state, edges);
    if (result.error) {
      return { error: result.error, status: 400, result };
    }

    // 全部合法：按批内去重后的边一次写入（校验已保证与现有关系不重复）
    const seen = new Set();
    for (const item of result.items) {
      const key = `${item.childId} ${item.parentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.parentsOf[item.childId].push(item.parentId);
    }
    persist();
    return { error: null };
  }

  return {
    list,
    addMember,
    renameMember,
    deleteMember,
    addEdge,
    deleteEdge,
    commitEdges,
    validateEdgeBatch: (edges) => validateEdgeBatch(state, edges),
    getState: () => state,
    getVersion: () => version,
  };
}

function edgesList(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf)) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { state: createState(MAX_MEMBERS), version: 0 };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`无法解析数据文件 ${filePath}: ${err.message}`);
  }

  const state = createState(Number.isInteger(raw.maxMembers) ? raw.maxMembers : MAX_MEMBERS);

  if (Array.isArray(raw.members)) {
    for (const m of raw.members) {
      if (m && typeof m.id === 'string' && typeof m.name === 'string') {
        state.members.push({ id: m.id, name: m.name });
      }
    }
  }
  const ids = new Set(state.members.map((m) => m.id));
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (e && ids.has(e.parentId) && ids.has(e.childId) && e.parentId !== e.childId) {
        (state.parentsOf[e.childId] ||= []).push(e.parentId);
      }
    }
  } else if (raw.parentsOf && typeof raw.parentsOf === 'object') {
    // 兼容早期版本落盘的 parentsOf 邻接表格式
    for (const [childId, parents] of Object.entries(raw.parentsOf)) {
      if (!ids.has(childId) || !Array.isArray(parents)) continue;
      for (const parentId of parents) {
        if (ids.has(parentId) && parentId !== childId) {
          (state.parentsOf[childId] ||= []).push(parentId);
        }
      }
    }
  }
  for (const m of state.members) {
    const ps = state.parentsOf[m.id] || [];
    state.parentsOf[m.id] = [...new Set(ps)].slice(0, 2);
  }
  // 手工编辑数据文件可能引入环路（正常 API 路径已在写入前拦截）。
  // 按成员出现顺序做拓扑净化：丢弃会让父母链重新回到已处理成员的边，
  // 保证加载后的图一定是 DAG，避免查询时死循环。
  for (const child of state.members) {
    state.parentsOf[child.id] = state.parentsOf[child.id].filter(
      (parentId) => !isReachableUp(state, parentId, child.id),
    );
  }
  return { state, version: Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 0 };
}

module.exports = { createStore };
