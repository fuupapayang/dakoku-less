'use strict';
const assert = require('assert');
const K = require('../src/keywords');
const RA = require('../src/reassign');

// ---- キーワード整理
const projects = [
  { id: 'a', code: 'F709', name: '甲子園', keywords: [] },
  { id: 'b', code: 'T724', name: 'メイツ', keywords: ['甲子園', 'レーベン'], keywordsReview: true },
  { id: 'c', code: 'T777', name: 'ルネ', keywords: ['甲子園'], keywordsReview: true },
  { id: 'd', code: 'F748', name: 'レーベン京都', keywords: ['レーベン'] },
  { id: 'e', code: 'F542', name: 'F542案件', keywords: ['F542'] },
  { id: 'f', code: 'T082', name: 'GTL', keywords: ['F542', '固有'], keywordsReview: true }
];
const dups = K.findDuplicates(projects);
const by = Object.fromEntries(dups.map(d => [d.keyword, d]));
assert.deepStrictEqual(by['甲子園'].keep, []);          // 修復対象にしか無い → 全部外す案
assert.deepStrictEqual(by['レーベン'].keep, ['d']);      // 修復対象でない案件に残す
assert.deepStrictEqual(by['F542'].keep, ['e']);         // コードと同じ案件に残す
assert.ok(!by['固有']);                                  // 1案件だけのキーワードは対象外

const r = K.applyCleanup(projects, [
  { keyword: '甲子園', keep: [], addTo: 'a' },           // F709に付け直す
  { keyword: 'レーベン', keep: ['d'] },
  { keyword: 'F542', keep: ['e'] }
], 1000);
const P = Object.fromEntries(projects.map(p => [p.id, p]));
assert.deepStrictEqual(P.a.keywords, ['甲子園']);
assert.deepStrictEqual(P.b.keywords, []);
assert.deepStrictEqual(P.c.keywords, []);
assert.deepStrictEqual(P.f.keywords, ['固有']);
assert.strictEqual(P.b.updatedAt, 1000);                 // 同期で新しい方が採用されるよう更新
assert.ok(!P.b.keywordsReview && !P.f.keywordsReview);   // 重複が消えたので要確認を外す
assert.strictEqual(K.findDuplicates(projects).length, 0);
assert.strictEqual(r.changed.length, 4);                  // a(付け直し) b c f(外す)。d e は変更なし

// ---- 工数の付け替え
assert.ok(RA.validate({ memberId: 'm', fromPid: 'x', toPid: 'x', from: '2026-09-01', to: '2026-09-30' }));
assert.ok(RA.validate({ memberId: 'm', fromPid: 'x', from: '2026-09-30', to: '2026-09-01' }));
assert.strictEqual(RA.validate({ memberId: 'm', fromPid: 'x', toPid: null, from: '2026-09-01', to: '2026-09-30' }), null);
const days = {
  '2026-07-21': { projectMin: { b: 44 } },
  '2026-09-10': { projectMin: { b: 18, a: 5 }, restoredMin: { b: 10 } },
  '2026-10-01': { projectMin: { b: 30 } }                // 期間外
};
const o = RA.newOrder({ memberId: 'm1', fromPid: 'b', toPid: 'a', from: '2026-07-01', to: '2026-09-30' }, '福永');
assert.deepStrictEqual(RA.preview(days, o), { min: 62, days: 2 });
assert.strictEqual(RA.applyOrder(days, o), 62);
assert.deepStrictEqual(days['2026-07-21'].projectMin, { a: 44 });
assert.deepStrictEqual(days['2026-09-10'].projectMin, { a: 23 });
assert.deepStrictEqual(days['2026-09-10'].restoredMin, { a: 10 }); // 復元分も一緒に移る
assert.deepStrictEqual(days['2026-10-01'].projectMin, { b: 30 });
// 「工数から外す」
const o2 = RA.newOrder({ memberId: 'm1', fromPid: 'b', toPid: null, from: '2026-10-01', to: '2026-10-31' }, '福永');
assert.strictEqual(RA.applyOrder(days, o2), 30);
assert.deepStrictEqual(days['2026-10-01'].projectMin, {});
// 未反映の指示: 自分宛てで、反映済みでないものだけ
assert.deepStrictEqual(RA.pendingFor([o, o2, { ...o, id: 'x', memberId: 'other' }], 'm1', [o.id]).map(x => x.id), [o2.id]);

console.log('✓ all cleanup tests passed');
