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
