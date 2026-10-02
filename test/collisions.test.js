'use strict';
const assert = require('assert');
const c = require('../src/collisions');
const T = (s) => new Date(s).getTime();

// p20 に3案件が同居(実データで起きた状態)
const projects = [
  { id: 'p20', code: 'T466', name: 'SOSiLA', makers: [], createdAt: T('2026-08-31') },
  { id: 'p20', code: 'T724', name: 'メイツ川越南台', makers: ['宮成', '田部'], createdAt: T('2026-08-04') },
  { id: 'p20', code: 'T777', name: 'ルネ大宮', makers: [], createdAt: T('2026-07-29') },
  { id: 'p9', code: 'F001', name: '単独', makers: [] }
];
const { projects: fixed, collisions } = c.splitCollisions(projects);
assert.deepStrictEqual(fixed.map(p => p.id), ['pc_T466', 'pc_T724', 'pc_T777', 'p9']);
assert.deepStrictEqual(collisions, { p20: ['pc_T466', 'pc_T724', 'pc_T777'] });
assert.strictEqual(new Set(fixed.map(p => p.id)).size, fixed.length);
assert.ok(fixed[0].keywordsReview && !fixed[3].keywordsReview);
// 何度実行しても同じ結果(どの端末で修復しても同じID)
assert.deepStrictEqual(c.splitCollisions(fixed).collisions, {});

const byId = Object.fromEntries(fixed.map(p => [p.id, p]));
const cands = collisions.p20.map(id => byId[id]);
// 7/30: T777しか存在しない → T777
assert.strictEqual(c.pickCandidate('2026-07-30', cands, '福永'), 'pc_T777');
// 8/10: T724/T777が候補。田部はT724の担当 → T724
assert.strictEqual(c.pickCandidate('2026-08-10', cands, '田部'), 'pc_T724');
// 8/10: 福永はどちらの担当でもない → 判別不能(null)
assert.strictEqual(c.pickCandidate('2026-08-10', cands, '福永'), null);
assert.ok(c.isMaker({ makers: ['井上'] }, '井上さくら'));

// データ修復: 付け替え+要確認、合計分数は保存される
const data = {
  projects: fixed,
  settings: { userName: '福永' },
  days: {
    '2026-07-30': { projectMin: { p20: 30, p9: 10 } },
    '2026-08-10': { projectMin: { p20: 45 } }
  },
  calEvents: [{ title: 'T724 打合せ', projectId: 'p20' }, { title: '定例', projectId: 'p20' }],
  learnStats: { tokens: { a: { p20: 3, p9: 1 } }, slots: { w1h9: { p20: 2 } }, totals: { p20: 5, p9: 1 }, n: 6 }
};
const r = c.repairData(data, collisions, '福永');
assert.deepStrictEqual(r, { moved: 30, review: 45 });
assert.deepStrictEqual(data.days['2026-07-30'].projectMin, { p9: 10, pc_T777: 30 });
assert.deepStrictEqual(data.days['2026-08-10'].projectMin, {});
assert.deepStrictEqual(data.days['2026-08-10'].reviewMin, [{ min: 45, candidates: collisions.p20, from: 'p20' }]);
assert.deepStrictEqual(data.calEvents.map(e => e.projectId), ['pc_T724', null]);
assert.deepStrictEqual(data.learnStats.totals, { p9: 1 });
assert.strictEqual(data.learnStats.n, 1);
assert.deepStrictEqual(data.learnStats.tokens.a, { p9: 1 });

console.log('✓ all collisions tests passed');
