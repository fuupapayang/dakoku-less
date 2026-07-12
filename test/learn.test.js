'use strict';
const assert = require('assert');
const L = require('../src/learn');

const projects = [
  { id: 'p1', code: 'A123', name: '山田商事', active: true },
  { id: 'p2', code: 'B200', name: '鈴木建設', active: true }
];
const T = (wd, h) => new Date(2026, 6, 5 + wd, h).getTime(); // 2026-07-05は日曜

// 1) 学習前は推論しない
let s = L.emptyStats();
assert.strictEqual(L.infer([s], { tokens: ['見積書'], projects }), null);

// 2) 語句学習 → 高確度で推論
s = L.emptyStats();
for (let i = 0; i < 5; i++) L.learn(s, { tokens: ['山田商事', '見積書'], ts: T(2, 10), projectId: 'p1', weight: 3 });
for (let i = 0; i < 3; i++) L.learn(s, { tokens: ['鈴木建設', '図面'], ts: T(3, 15), projectId: 'p2', weight: 3 });
let r = L.infer([s], { tokens: ['山田商事', '請求書'], ts: T(2, 10), projects });
assert.ok(r && r.pid === 'p1', 'p1が推論されるべき');
assert.ok(r.p > 0.7, `確度が低すぎる: ${r && r.p}`);

// 3) 時間帯prior: 語句ヒントなしでも火曜10時はp1寄り
r = L.infer([s], { tokens: ['メモ'], ts: T(2, 10), projects });
assert.ok(r === null || r.pid === 'p1');

// 4) 会議の余韻
const cal = [{ s: T(2, 9), e: T(2, 10), summary: '[B200] 定例' }];
const carry = L.carryProject(cal, T(2, 10) + 10 * 60000, (t) => /b200/i.test(t) ? { id: 'p2' } : null);
assert.strictEqual(carry, 'p2');

// 5) 余韻バイアスが効く(拮抗時にp2へ寄る)
r = L.infer([s], { tokens: ['議事録'], ts: T(3, 15), carryPid: 'p2', projects });
assert.ok(!r || r.pid === 'p2');

// 6) チーム統計の合成(自分は空でもチームの学習で推論)
const team = L.emptyStats();
for (let i = 0; i < 10; i++) L.learn(team, { tokens: ['在庫管理'], ts: T(4, 11), projectId: 'p1', weight: 3 });
r = L.infer([L.emptyStats(), team], { tokens: ['在庫管理'], ts: T(4, 11), projects });
assert.ok(r && r.pid === 'p1', 'チーム辞書から推論されるべき');

// 7) prune: 語句上限
const big = L.emptyStats();
for (let i = 0; i < 700; i++) L.learn(big, { tokens: ['tok' + i], projectId: 'p1' });
assert.ok(Object.keys(big.tokens).length <= 600);

console.log('✓ all 7 learn tests passed');
