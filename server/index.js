'use strict';

const path = require('path');
const express = require('express');
const { createStore } = require('./store');
const { findCommonAncestors, validateEdge } = require('./familyGraph');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'family.json');

const store = createStore(DATA_FILE);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sendError(res, status, message) {
  const payload = typeof message === 'string' ? { error: message } : message;
  return res.status(status).json(payload);
}

/** 统一的输入校验：从请求体取非空字符串字段 */
function requireId(body, field) {
  const value = body && typeof body[field] === 'string' ? body[field].trim() : '';
  return value || null;
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 50);
}

/** 获取全部数据：成员 + 关系 */
app.get('/api/state', (req, res) => {
  res.json(store.list());
});

/** 新增成员（最多 30 人） */
app.post('/api/members', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.addMember(name);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 修改成员姓名（支持修改后重新查询） */
app.patch('/api/members/:id', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.renameMember(req.params.id, name);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 删除成员（级联删除相关关系） */
app.delete('/api/members/:id', (req, res) => {
  const result = store.deleteMember(req.params.id);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/**
 * 添加 父母→子女 关系。
 * 服务端拒绝：自指、重复边、超过两位父母、祖先环路。
 */
app.post('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '请选择父母与子女');

  // 双重校验（store.addEdge 内部同样校验，保证单一规则来源）
  const check = validateEdge(store.getState(), parentId, childId);
  if (check.error) return sendError(res, 400, check.error);

  const result = store.addEdge(parentId, childId);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 删除关系（修改关系 = 删除后重新添加） */
app.delete('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '缺少关系参数');
  const result = store.deleteEdge(parentId, childId);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 为预检结果补上成员姓名（成员可能已在预检前被删除） */
function decorateBatchResult(result) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  return {
    version: store.getVersion(),
    valid: result.valid,
    error: result.error,
    items: result.items.map((item) => ({
      index: item.index,
      parentId: item.parentId,
      childId: item.childId,
      parentName: item.parentId ? byId.get(item.parentId) || '（已删除）' : '',
      childName: item.childId ? byId.get(item.childId) || '（已删除）' : '',
      errors: item.errors,
    })),
  };
}

/**
 * 批量关系预检：在「当前关系 + 整批草稿」的合并结果上校验
 * 成员存在、自指、批内及已有重复、父母上限与祖先环路。
 * 不写入任何数据，只返回每条草稿的错误、整批可否提交及当前家谱版本。
 * 请求体：{ edges: [{ parentId, childId }, ...] }
 */
app.post('/api/edges/batch/preview', (req, res) => {
  const edges = req.body && req.body.edges;
  const result = store.validateEdgeBatch(edges);
  res.json(decorateBatchResult(result));
});

/**
 * 批量关系提交：必须携带预检返回的家谱版本 version。
 * 服务端重新比对版本并重跑全部校验：版本变化（409）或任何一条非法（400）
 * 都整批拒绝、不写入任何一条；合法时整批一次持久化并返回最新关系列表。
 * 请求体：{ version: number, edges: [...] }
 */
app.post('/api/edges/batch', (req, res) => {
  const edges = req.body && req.body.edges;
  const expectedVersion = req.body && req.body.version;
  const result = store.commitEdges(edges, expectedVersion);
  if (result.error) {
    const payload = { error: result.error };
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    // 非法条目明细一并返回，便于前端展示每条错误
    if (result.result) payload.preview = decorateBatchResult(result.result);
    return sendError(res, result.status || 400, payload);
  }
  res.status(201).json(store.list());
});

/** 为合并方案补上成员姓名（成员可能已在预览前被删除） */
function decorateMergePlan(plan) {
  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  return {
    version: store.getVersion(),
    error: plan.error,
    valid: plan.valid,
    keepId: plan.keepId,
    dropId: plan.dropId,
    keepName: plan.keepId ? byId.get(plan.keepId) || '（已删除）' : '',
    dropName: plan.dropId ? byId.get(plan.dropId) || '（已删除）' : '',
    removedCount: plan.removedCount,
    edgeCount: plan.edges.length,
    edges: plan.edges.map((e) => ({
      parentId: e.parentId,
      childId: e.childId,
      parentName: byId.get(e.parentId) || '（已删除）',
      childName: byId.get(e.childId) || '（已删除）',
    })),
    conflicts: plan.conflicts,
  };
}

/**
 * 合并预览：把被合并成员在全部父母→子女关系中的 ID 替换为保留成员，
 * 返回合并去重后的完整关系、去重数量与冲突列表（自指/父母超限/祖先环路）。
 * 不写入任何数据。请求体：{ keepId, dropId }
 */
app.post('/api/members/merge/preview', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const dropId = requireId(req.body, 'dropId');
  if (!keepId || !dropId) return sendError(res, 400, '请选择保留成员与被合并成员');
  const plan = store.previewMerge(keepId, dropId);
  res.json(decorateMergePlan(plan));
});

/**
 * 合并提交：必须携带预览返回的家谱版本 version。
 * 服务端重新比对版本并按同一规则重算：版本变化（409）、成员不存在（404）
 * 或仍有冲突（400）都整单拒绝、不改数据；成功时保留成员姓名、
 * 去重关系并删除被合并成员，一次落盘、版本加一。
 * 请求体：{ keepId, dropId, version }
 */
app.post('/api/members/merge', (req, res) => {
  const keepId = requireId(req.body, 'keepId');
  const dropId = requireId(req.body, 'dropId');
  if (!keepId || !dropId) return sendError(res, 400, '请选择保留成员与被合并成员');
  const result = store.mergeMembers(keepId, dropId, req.body && req.body.version);
  if (result.error) {
    const payload = { error: result.error };
    if (result.currentVersion !== undefined) payload.currentVersion = result.currentVersion;
    // 冲突明细一并返回，便于前端直接展示
    if (result.plan) payload.plan = decorateMergePlan(result.plan);
    return sendError(res, result.status || 400, payload);
  }
  const data = store.list();
  data.merge = {
    keepId,
    dropId,
    removedCount: result.plan.removedCount,
    edgeCount: result.plan.edges.length,
  };
  res.status(201).json(data);
});

/**
 * 查询两人共同祖先：
 * 沿父母链 BFS，找出总代数最少的全部共同祖先，
 * 并返回双方到每个祖先的全部最短亲缘路径（同代数不同路径全部保留）。
 */
app.get('/api/common-ancestors', (req, res) => {
  const { personA, personB } = req.query;
  if (typeof personA !== 'string' || typeof personB !== 'string') {
    return sendError(res, 400, '请选择两位成员');
  }
  const result = findCommonAncestors(store.getState(), personA, personB);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: byId.get(id) || '（已删除）' }));

  res.json({
    samePerson: result.samePerson,
    minTotalGen: result.minTotalGen,
    ancestors: result.ancestors.map((a) => ({
      id: a.id,
      name: byId.get(a.id) || '（已删除）',
      genA: a.genA,
      genB: a.genB,
      totalGen: a.totalGen,
      pathsA: a.pathsA.map(decoratePath),
      pathsB: a.pathsB.map(decoratePath),
    })),
  });
});

/** JSON 解析错误兜底 */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, '请求体不是合法的 JSON');
  }
  return next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`家谱关系核对应用已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});

module.exports = app;
