'use strict';
const assert = require('assert');
const R = require('../src/restore');
const T = (h, m = 0, d = 10) => new Date(2026, 8, d, h, m).getTime();

assert.strictEqual(R.codeInPath('/Volumes/BB/F745_宇都宮PJ/data/a.psd'), 'F745');
assert.strictEqual(R.codeInPath('/Volumes/BB/領収書/a.pdf'), null);

const saves = R.savesFromFiles([
  { t: T(10, 0), path: '/x/F745_宇都宮/a.ai' },
  { t: T(14, 0), path: '/x/T724_メイツ/b.psd' },
  { t: T(16, 0), path: '/x/Z999_未登録/c.txt' }
]);
assert.strictEqual(R.codeAt(saves, T(10, 20), 30 * 60000), 'F745');   // 保存の30分後まで
assert.strictEqual(R.codeAt(saves, T(13, 40), 30 * 60000), 'T724');   // 次の保存の30分前から
assert.strictEqual(R.codeAt(saves, T(12, 0), 30 * 60000), null);

const projects = [{ id: 'p1', code: 'F745' }, { id: 'p2', code: 'T724' }];
const days = {
  '2026-09-10': {
    intervals: [{ s: T(9, 45), e: T(10, 45) }, { s: T(13, 45), e: T(14, 15) }, { s: T(16, 0), e: T(16, 10) }],
    projectMin: { p1: 20 }   // F745は既に20分記録済み
  },
  '2026-10-01': { intervals: [{ s: T(10, 0, 1), e: T(11, 0, 1) }], projectMin: {} } // 別の月は対象外
};
const p = R.plan({ days, saves, projects, ym: '2026-09' });
// F745: 9:45〜10:30の46分(9:45〜9:59は次の保存の30分前・10:00〜10:30は直後、境界を含む) − 既存20分 = 26分
assert.strictEqual(p.perDay['2026-09-10'].p1, 26);
assert.strictEqual(p.perDay['2026-09-10'].p2, 30);              // 13:45〜14:14
assert.strictEqual(p.unregistered.Z999, 10);                    // 未登録コードは復元しない
assert.strictEqual(p.beforeMin, 20);
assert.strictEqual(p.addMin, 56);

// 反映 → 再実行しても二重にならない → 取り消しで元通り
R.apply(days, '2026-09', p);
assert.deepStrictEqual(days['2026-09-10'].projectMin, { p1: 46, p2: 30 });
const p2 = R.plan({ days, saves, projects, ym: '2026-09' });
assert.strictEqual(p2.beforeMin, 20);                           // 復元分は「復元前」に含めない
R.apply(days, '2026-09', p2);
assert.deepStrictEqual(days['2026-09-10'].projectMin, { p1: 46, p2: 30 });
assert.strictEqual(R.undo(days, '2026-09'), 56);
assert.deepStrictEqual(days['2026-09-10'].projectMin, { p1: 20 });
assert.ok(!days['2026-09-10'].restoredMin);

// 上限: 操作時間 − 既存工数 を超えて足さない
const tight = { '2026-09-10': { intervals: [{ s: T(10, 0), e: T(10, 30) }], projectMin: { p2: 25 } } };
const pt = R.plan({ days: tight, saves, projects, ym: '2026-09' });
assert.ok(pt.addMin <= 5);

console.log('✓ all restore tests passed');
