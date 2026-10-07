'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fc = require('../src/folderCheck');
const pe = require('../src/projectEdit');

const now = new Date(2026, 9, 7, 12).getTime();
const DAY = 86400000;

// 1) フォルダ名 → コード(大文字小文字無視)
assert.strictEqual(fc.codeOfFolderName('T724_メイツ川越南台'), 'T724');
assert.strictEqual(fc.codeOfFolderName('t724_メイツ'), null);   // 小文字は工数が記録されないので「フォルダあり」としない
assert.strictEqual(fc.codeOfFolderName('T724メイツ'), null);
assert.strictEqual(fc.codeOfFolderName('資料'), null);

// 2) 走査: 深さ3まで・ルート自身・小文字コードは対象外(工数が記録されないため)・隠しフォルダ除外
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
try {
  const mk = (...p) => fs.mkdirSync(path.join(tmp, ...p), { recursive: true });
  mk('root', 'F001_直下');
  mk('root', '2026', '10月', 'T724_深さ3');
  mk('root', 'a', 'b', 'c', 'X999_深さ4');      // 深さ4 → 対象外
  mk('root', 'a', 'f002_小文字');
  mk('root', '.hidden', 'H001_隠し');
  mk('T555_ルート自身', 'sub');
  const codes = fc.scanCodes([path.join(tmp, 'root'), path.join(tmp, 'T555_ルート自身'), path.join(tmp, 'nope')]);
  assert.deepStrictEqual([...codes].sort(), ['F001', 'T555', 'T724']);
  // 上限(フォルダ数)で打ち切っても例外にならない
  assert.ok(fc.scanCodes([path.join(tmp, 'root')], { maxDirs: 1 }).size <= 1);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// 3) 対象案件: 制作に自分・稼働中のみ・最近使っただけは対象外・コード大文字小文字無視
const projects = [
  { id: 'a', code: 'T724', name: 'メイツ川越南台', makers: ['山岡 潤', '福永'], status: 'active' },
  { id: 'b', code: 'F001', name: '見つかる', makers: ['山岡潤'] },
  { id: 'c', code: 'F002', name: '営業だけ', sales: ['山岡 潤'], makers: ['福永'] },
  { id: 'd', code: 'F003', name: '納品済み', makers: ['山岡 潤'], status: 'delivered' },
  { id: 'e', code: 'F004', name: '停止中', makers: ['山岡 潤'], active: false },
  { id: 'f', code: '', name: 'コードなし', makers: ['山岡 潤'] },
  { id: 'g', code: 'K010', name: 'スヌーズ中', makers: ['山岡'] }
];
const snooze = { K010: now + DAY };
let miss = fc.missingFolderProjects(projects, '山岡 潤', new Set(['f001']), { snooze, now });
assert.deepStrictEqual(miss.map(p => p.code), ['T724']);
assert.strictEqual(miss[0].folderName, 'T724_メイツ川越南台');
assert.strictEqual(miss[0].id, 'a');
miss = fc.missingFolderProjects(projects, '山岡 潤', ['F001'], { snooze, now, includeSnoozed: true });
assert.deepStrictEqual(miss.map(p => [p.code, p.snoozed]), [['K010', true], ['T724', false]]);
// スヌーズ期限切れ → 再表示
assert.deepStrictEqual(fc.missingFolderProjects(projects, '山岡 潤', ['F001'], { snooze, now: now + 2 * DAY }).map(p => p.code), ['K010', 'T724']);
// 表示名なし → 誰の案件でもない
assert.deepStrictEqual(fc.missingFolderProjects(projects, '', []), []);

// 4) 旧「今後表示しない」→ 7日スヌーズへ移行・期限切れ掃除
const s = { folderHintDismissed: ['t724', 'F001'], folderSnooze: { OLD: now - 1, F001: now + 3 * DAY } };
assert.strictEqual(fc.migrateSnooze(s, now), true);
assert.ok(!('folderHintDismissed' in s));
assert.deepStrictEqual(s.folderSnooze, { F001: now + 3 * DAY, T724: now + fc.SNOOZE_MS });
assert.strictEqual(fc.migrateSnooze(s, now), false);
const s2 = {}; fc.migrateSnooze(s2, now); assert.deepStrictEqual(s2.folderSnooze, {});
assert.ok(fc.isSnoozed(s.folderSnooze, 't724', now));

// 5) フォルダ名の生成(使えない文字の除去・長さ上限・空名)
assert.strictEqual(fc.folderNameFor('T724', ' メイツ/川越:南台*? "<>| '), 'T724_メイツ川越南台');
assert.strictEqual(fc.folderNameFor('F1', ''), 'F1_案件');
assert.strictEqual(fc.folderNameFor('F1', 'abc...'), 'F1_abc');
assert.strictEqual([...fc.folderNameFor('F1', 'あ'.repeat(100))].length, 3 + 60);
assert.ok(!/[\/\\:*?"<>|]/.test(fc.folderNameFor('F1', 'a\\b\nc')));

// 6) 制作から外れる: 自分だけ外す・完全一致優先・最後の1人は不可
assert.deepStrictEqual(fc.removeMeFromMakers({ makers: ['山岡 潤', '福永'] }, '山岡潤'), { makers: ['福永'] });
assert.deepStrictEqual(fc.removeMeFromMakers({ makers: ['井上 さくら', '井上', '福永'] }, '井上'), { makers: ['井上 さくら', '福永'] });
assert.deepStrictEqual(fc.removeMeFromMakers({ makers: ['山岡'] , sales: ['x'] }, '山岡 潤').onlyMaker, true);
assert.ok(fc.removeMeFromMakers({ makers: ['福永'] }, '山岡').error);
assert.ok(fc.removeMeFromMakers({ makers: ['福永'] }, '').error);
// applyEdit と組み合わせ: updatedAt が進み lastEditedBy が入る
const proj = { id: 'a', code: 'T724', sales: ['佐藤'], makers: ['山岡 潤', '福永'], updatedAt: now + 5000 };
const r = fc.removeMeFromMakers(proj, '山岡 潤');
const ed = pe.applyEdit(proj, { makers: r.makers }, { userName: '山岡 潤', now });
assert.ok(!ed.error);
assert.deepStrictEqual(proj.makers, ['福永']);
assert.strictEqual(proj.updatedAt, now + 5001);
assert.strictEqual(proj.lastEditedBy, '山岡 潤');

// 7) 通知計画: 新規だけ・上限3件+ほかN件・解消した案件は記録から消える
const m = (codes) => codes.map(code => ({ code, name: code }));
let plan = fc.planNotifications(m(['A1', 'B1']), undefined, '2026-10-07');
assert.deepStrictEqual(plan.toNotify.map(p => p.code), ['A1', 'B1']);
assert.strictEqual(plan.more, 0);
plan = fc.planNotifications(m(['A1', 'B1', 'C1']), plan.notified, '2026-10-07'); // 再起動しても同じ案件は再通知しない
assert.deepStrictEqual(plan.toNotify.map(p => p.code), ['C1']);
plan = fc.planNotifications(m(['A1', 'C1', 'D1', 'E1', 'F1', 'G1']), plan.notified, '2026-10-08');
assert.deepStrictEqual(plan.toNotify.map(p => p.code), ['D1', 'E1', 'F1']);
assert.strictEqual(plan.more, 1);
assert.deepStrictEqual(Object.keys(plan.notified).sort(), ['A1', 'C1', 'D1', 'E1', 'F1', 'G1']); // B1 は解消 → 消える
assert.strictEqual(plan.notified.A1, '2026-10-07');

// 8) isInside
assert.ok(fc.isInside('/a/b', '/a/b/c'));
assert.ok(fc.isInside('/a/b', '/a/b'));
assert.ok(!fc.isInside('/a/b', '/a/bc'));
assert.ok(!fc.isInside('/a/b', '/a'));

console.log('✓ all folderCheck tests passed');
