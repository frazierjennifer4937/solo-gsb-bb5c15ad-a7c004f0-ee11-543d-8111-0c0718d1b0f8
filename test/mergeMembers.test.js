'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createState,
  validateEdge,
  planMerge,
} = require('../server/familyGraph');
const { createStore } = require('../server/store');

/** 测试辅助：批量建成员（id 与姓名相同），可附带合法初始边 */
function makeState(names, existing = []) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  for (const [p, c] of existing) {
    const r = validateEdge(state, p, c);
    assert.equal(r.error, null, `准备数据失败 ${p} -> ${c}: ${r.error}`);
    state.parentsOf[c].push(p);
  }
  return state;
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-merge-'));
  return path.join(dir, 'family.json');
}

const edgeKeys = (edges) => edges.map((e) => `${e.parentId}->${e.childId}`).sort();

/* ---------------- planMerge 纯函数 ---------------- */

test('合并：被合并成员的关系全部转移到保留成员并去重', () => {
  // K、D 都是 C 的父母；D 还是 E 的父母；另有与两人无关的边 X->Y
  const state = makeState(['K', 'D', 'C', 'E', 'X', 'Y'], [
    ['K', 'C'],
    ['D', 'C'],
    ['D', 'E'],
    ['X', 'Y'],
  ]);
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.error, null);
  assert.equal(plan.valid, true);
  assert.deepEqual(plan.conflicts, []);
  // D->C 替换为 K->C 与已有 K->C 重复，去重 1 条；D->E 变为 K->E
  assert.equal(plan.removedCount, 1);
  assert.deepEqual(edgeKeys(plan.edges), ['K->C', 'K->E', 'X->Y']);
});

test('合并：成员不存在或同一人时返回结构错误', () => {
  const state = makeState(['K', 'D']);
  assert.match(planMerge(state, 'K', 'missing').error, /被合并成员不存在/);
  assert.match(planMerge(state, 'missing', 'D').error, /保留成员不存在/);
  assert.match(planMerge(state, 'K', 'K').error, /不能是同一人/);
});

test('合并：两人之间存在直接父母→子女关系时产生自指冲突', () => {
  const state = makeState(['K', 'D', 'C'], [['K', 'D'], ['D', 'C']]);
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.valid, false);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].type, 'self');
  assert.match(plan.conflicts[0].message, /自指/);
  // 反向（D 是 K 的父母）同样是自指冲突
  const state2 = makeState(['K', 'D'], [['D', 'K']]);
  const plan2 = planMerge(state2, 'K', 'D');
  assert.equal(plan2.valid, false);
  assert.equal(plan2.conflicts[0].type, 'self');
});

test('合并：合并后子女超过两位父母时产生父母上限冲突（防御手工数据）', () => {
  // 手工构造不合法数据：C 已有三位父母 P1、P2、D
  const state = makeState(['K', 'D', 'P1', 'P2', 'C']);
  state.parentsOf['C'] = ['P1', 'P2', 'D'];
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.valid, false);
  const c = plan.conflicts.find((x) => x.type === 'parents');
  assert.ok(c, '应报告父母上限冲突');
  assert.match(c.message, /3 位父母/);
  assert.match(c.message, /C/);
});

test('合并：合并后形成祖先环路时逐边列出冲突', () => {
  // K -> A -> D：合并 D 到 K 后 K -> A -> K 成环（两人间无直接边，不是自指）
  const state = makeState(['K', 'D', 'A'], [['K', 'A'], ['A', 'D']]);
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.valid, false);
  const cycles = plan.conflicts.filter((c) => c.type === 'cycle');
  assert.equal(cycles.length, 2); // 环上的两条边都被标记
  assert.ok(cycles.every((c) => /环路/.test(c.message)));
  assert.ok(plan.conflicts.every((c) => c.type === 'cycle'));
});

test('合并：多代祖先链合并成环也能检出', () => {
  // K -> A -> B -> D，合并 D 到 K：K -> A -> B -> K 成环
  const state = makeState(['K', 'D', 'A', 'B'], [['K', 'A'], ['A', 'B'], ['B', 'D']]);
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.valid, false);
  assert.ok(plan.conflicts.some((c) => c.type === 'cycle'));
});

test('合并：planMerge 不修改原状态', () => {
  const state = makeState(['K', 'D', 'C'], [['K', 'C'], ['D', 'C']]);
  const before = JSON.stringify({ members: state.members, parentsOf: state.parentsOf });
  planMerge(state, 'K', 'D');
  assert.equal(JSON.stringify({ members: state.members, parentsOf: state.parentsOf }), before);
});

test('合并：无关系涉及的两人合并后关系不变、去重为 0', () => {
  const state = makeState(['K', 'D', 'X', 'Y'], [['X', 'Y']]);
  const plan = planMerge(state, 'K', 'D');
  assert.equal(plan.valid, true);
  assert.equal(plan.removedCount, 0);
  assert.deepEqual(edgeKeys(plan.edges), ['X->Y']);
});

/* ---------------- store.mergeMembers 原子提交 ---------------- */

test('合并提交：成功时保留姓名、去重关系、删除被合并成员，版本只 +1', () => {
  const file = tmpFile();
  const store = createStore(file);
  const k = store.addMember('张三').member;
  const d = store.addMember('张三（重复）').member;
  const c = store.addMember('子女').member;
  const e = store.addMember('外孙').member;
  store.addEdge(k.id, c.id);
  store.addEdge(d.id, c.id); // 与保留成员重复的关系
  store.addEdge(d.id, e.id);
  const v = store.getVersion();

  const result = store.mergeMembers(k.id, d.id, v);
  assert.equal(result.error, null);
  assert.equal(result.plan.removedCount, 1);

  const data = store.list();
  // 版本只推进一次
  assert.equal(data.version, v + 1);
  // 被合并成员已删除，保留成员姓名不变
  assert.deepEqual(data.members.map((m) => m.name).sort(), ['外孙', '子女', '张三']);
  assert.equal(data.members.find((m) => m.id === k.id).name, '张三');
  // 关系已转移并去重
  assert.deepEqual(
    data.edges.map((x) => `${x.parentId}->${x.childId}`).sort(),
    [`${k.id}->${c.id}`, `${k.id}->${e.id}`].sort(),
  );

  // 落盘一次后的文件可被完整恢复
  const reloaded = createStore(file).list();
  assert.deepEqual(reloaded, data);
});

test('合并提交：预览后家谱变化（版本不符）整单 409 拒绝且零写入', () => {
  const store = createStore(tmpFile());
  const k = store.addMember('K').member;
  const d = store.addMember('D').member;
  const c = store.addMember('C').member;
  const v = store.getVersion();

  // 预览之后，其他操作改动了家谱
  store.addEdge(k.id, c.id);

  const result = store.mergeMembers(k.id, d.id, v);
  assert.equal(result.status, 409);
  assert.match(result.error, /重新预览/);
  assert.equal(result.currentVersion, store.getVersion());
  // 零写入：两名成员都还在，只有预检后那条关系
  assert.equal(store.list().members.length, 3);
  assert.equal(store.list().edges.length, 1);
});

test('合并提交：仍有冲突时整单 400 拒绝，数据与版本均不变', () => {
  const store = createStore(tmpFile());
  const k = store.addMember('K').member;
  const d = store.addMember('D').member;
  store.addEdge(k.id, d.id); // 两人间直接关系 → 合并将自指
  const v = store.getVersion();
  const before = store.list();

  const result = store.mergeMembers(k.id, d.id, v);
  assert.equal(result.status, 400);
  assert.match(result.error, /冲突/);
  assert.ok(result.plan.conflicts.some((c) => c.type === 'self'));
  assert.deepEqual(store.list(), before);
});

test('合并提交：缺少版本号被拒绝；成员不存在返回 404', () => {
  const store = createStore(tmpFile());
  const k = store.addMember('K').member;
  const d = store.addMember('D').member;
  const v = store.getVersion();

  const noVersion = store.mergeMembers(k.id, d.id, undefined);
  assert.equal(noVersion.status, 400);
  assert.match(noVersion.error, /版本号/);

  const missing = store.mergeMembers(k.id, 'missing-id', v);
  assert.equal(missing.status, 404);
  assert.match(missing.error, /被合并成员不存在/);

  // 以上拒绝均未改动数据
  assert.equal(store.getVersion(), v);
  assert.equal(store.list().members.length, 2);
});

test('合并预览：返回合并方案但不修改任何数据', () => {
  const store = createStore(tmpFile());
  const k = store.addMember('K').member;
  const d = store.addMember('D').member;
  const c = store.addMember('C').member;
  store.addEdge(k.id, c.id);
  store.addEdge(d.id, c.id);
  const before = store.list();

  const plan = store.previewMerge(k.id, d.id);
  assert.equal(plan.valid, true);
  assert.equal(plan.removedCount, 1);
  assert.equal(plan.edges.length, 1);
  // 预览不写数据：版本与内容完全不变
  assert.deepEqual(store.list(), before);
});
