'use strict';
const assert = require('assert');
const { Sync } = require('../src/sync');

(async () => {
  const s = new Sync(() => ({ enabled: true, projectId: 'x', apiKey: 'k', teamId: 't', memberId: 'm' }));

  // リモート: p1=F599, p2=T100
  s.getDoc = async () => ({ projects: [
    { id: 'p1', code: 'F599', name: 'A', keywords: ['x'], createdAt: 1 },
    { id: 'p2', code: 'T100', name: 'B', keywords: [], createdAt: 1 }
  ] });
  let written = null;
  s.setDoc = async (path, obj) => { written = obj; };

  // ローカル: p1=F600(idは衝突するがコードは別案件), p2=T100(同コード)
  const local = [
    { id: 'p1', code: 'F600', name: 'C', keywords: ['y'], createdAt: 2 },
    { id: 'p2', code: 'T100', name: 'B2', keywords: ['z'], createdAt: 3 }
  ];
  const merged = await s.syncProjects(local);

  // id衝突があっても消えず、コード単位で3件残る(以前は消えていた)
  const codes = merged.map(p => p.code).sort();
  assert.deepStrictEqual(codes, ['F599', 'F600', 'T100'], 'id衝突で案件が消えてはならない');

  // 同コードT100は「新しく編集した側(local, createdAt新)」のキーワードを採用
  const t = merged.find(p => p.code === 'T100');
  assert.deepStrictEqual(t.keywords, ['z'], '新しい編集内容が優先される(合算しない=削除が反映される)');

  // リモートにも同じ内容が書き戻される(3件)
  assert.ok(written && written.projects.length === 3);

  // キーワード削除の反映: リモートに['a','b']、ローカルで['a'](bを削除・updatedAt新)→ 結果['a']
  s.getDoc = async () => ({ projects: [{ id: 'q1', code: 'X10', name: 'n', keywords: ['a', 'b'], updatedAt: 1 }] });
  const merged2 = await s.syncProjects([{ id: 'q1', code: 'X10', name: 'n', keywords: ['a'], updatedAt: 5 }]);
  assert.deepStrictEqual(merged2.find(p => p.code === 'X10').keywords, ['a'], '削除したキーワードが反映される');

  // ---- バージョン同期
const { compareVersions, inferLegacyVersion } = require('../src/sync');
assert.ok(compareVersions('0.13.1', '0.13.2') < 0);
assert.ok(compareVersions('0.13.10', '0.13.2') > 0);   // 数値として比較
assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
assert.strictEqual(inferLegacyVersion({ a: { categoryMin: {} } }), 'v0.13.0〜0.13.1');
assert.strictEqual(inferLegacyVersion({ a: { privateMin: 0 } }), 'v0.12');
assert.strictEqual(inferLegacyVersion({ a: { workMin: 1 } }), 'v0.11以前');

  // ---- pushSummary: 前月1日起点・小数1桁・tracking
  const { summaryFromKey, roundMinMap } = require('../src/sync');
  assert.strictEqual(summaryFromKey(new Date(2026, 9, 7).getTime()), '2026-09-01');
  assert.strictEqual(summaryFromKey(new Date(2026, 0, 31).getTime()), '2025-12-01');
  assert.deepStrictEqual(roundMinMap({ a: 0.25, b: 0.04, c: 12.345, d: -1 }), { a: 0.3, c: 12.3 });
  const s2 = new Sync(() => ({ enabled: true, projectId: 'x', apiKey: 'k', teamId: 't', memberId: 'm1', userName: '中村',
    tracking: { trackWork: true, titleDetect: false, watchRoots: 2, rootsMissing: 1 } }));
  let pushed = null; let writes = 0;
  s2.setDoc = async (path, obj) => { pushed = obj; writes++; };
  const est = { start: 1, end: 2, workMin: 60, breakMin: 0 };
  const sdays = {
    '2026-08-31': { estimation: est, projectMin: { p1: 10 } },             // 前々月 → 送らない
    '2026-09-01': { estimation: est, projectMin: { p1: 0.25, p2: 0.01 } }, // 前月1日 → 送る(35日より前でも)
    '2026-10-07': { estimation: est, projectMin: { p1: 3 } }
  };
  const nowTs = new Date(2026, 9, 7, 12).getTime();
  await s2.pushSummary(sdays, null, [], nowTs);
  assert.deepStrictEqual(Object.keys(pushed.days).sort(), ['2026-09-01', '2026-10-07']);
  assert.deepStrictEqual(pushed.days['2026-09-01'].projectMin, { p1: 0.3 });
  assert.deepStrictEqual(pushed.tracking, { trackWork: true, titleDetect: false, watchRoots: 2, rootsMissing: 1 });
  await s2.pushSummary(sdays, null, [], nowTs); // 変化なし → 書き込まない
  assert.strictEqual(writes, 1);

  // pullAll: メンバーごとの tracking(旧版は null)
  s2.listDocs = async (p) => p === 'summary'
    ? [{ id: 'm1', data: { name: '中村', days: {}, tracking: pushed.tracking } }, { id: 'm2', data: { name: '旧版', days: {} } }]
    : [];
  s2.getDoc = async () => null;
  const all = await s2.pullAll();
  assert.deepStrictEqual(all.members[0].tracking, pushed.tracking);
  assert.strictEqual(all.members[1].tracking, null);

console.log('✓ all sync tests passed');
})().catch(e => { console.error(e); process.exit(1); });
