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

  console.log('✓ all sync tests passed');
})().catch(e => { console.error(e); process.exit(1); });
