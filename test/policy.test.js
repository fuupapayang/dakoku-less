'use strict';
const assert = require('assert');
const P = require('../src/policy');
const pol = P.effective();

// 既定値(ご指定の 90秒 / 15分 / 4時)
assert.deepStrictEqual(pol.params, { idleThresholdSec: 90, breakThresholdMin: 15, dayStartHour: 4 });
// 保存値は既定値に上書き、欠けた項目は補完
assert.strictEqual(P.effective({ params: { idleThresholdSec: 120 } }).params.breakThresholdMin, 15);

// 仕事用アプリ / 私用アプリ
const fg = (app, title = '') => ({ app, title });
assert.ok(P.isWorkApp(fg('Figma', 'T724_バナー'), pol));
assert.ok(P.isWorkApp(fg('Code', 'main.js'), pol));               // 短い語はアプリ名で一致
assert.ok(!P.isWorkApp(fg('Google Chrome', 'QRコード 作成'), pol)); // タイトルの「コード/Code」には反応しない
assert.ok(!P.isWorkApp(fg('Google Chrome', 'WordPressとは'), pol));
assert.ok(P.isWorkApp(fg('Google Chrome', 'T724 構成案 - Claude'), pol)); // ブラウザ版AI
assert.strictEqual(P.privateAppHit(fg('Google Chrome', 'Netflix | 映画'), pol), 'Netflix');
assert.strictEqual(P.privateAppHit(fg('Figma', ''), pol), null);

// 勤務時間帯: 平日9:00〜22:00のみ。土日祝は常に時間外
const T = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();
assert.ok(P.inWorkWindow(T(5, 9), '2026-10-05', pol));
assert.ok(!P.inWorkWindow(T(5, 8, 59), '2026-10-05', pol));
assert.ok(!P.inWorkWindow(T(5, 22), '2026-10-05', pol));
assert.ok(!P.inWorkWindow(T(3, 12), '2026-10-03', pol));   // 土曜
assert.ok(!P.inWorkWindow(T(12, 12), '2026-10-12', pol));  // スポーツの日

// パスワード: 平文を保存せず検証できる
const h = P.hashPassword('correct horse');
assert.ok(!JSON.stringify(h).includes('correct horse'));
assert.ok(P.verifyPassword('correct horse', { adminHash: h.hash, adminSalt: h.salt }));
assert.ok(!P.verifyPassword('wrong', { adminHash: h.hash, adminSalt: h.salt }));
assert.ok(!P.verifyPassword('x', {}));

// 入力検証: 範囲外は既定値、一覧は重複・空行を除去
const sn = P.sanitize({ params: { idleThresholdSec: 5, breakThresholdMin: 30, dayStartHour: 99 }, workApps: ['A', 'A', ' ', 'B'], workStartMin: 600 });
assert.deepStrictEqual(sn.params, { idleThresholdSec: 90, breakThresholdMin: 30, dayStartHour: 4 });
assert.deepStrictEqual(sn.workApps, ['A', 'B']);
assert.strictEqual(sn.workStartMin, 600);
assert.ok(!('adminHash' in sn)); // ポリシー保存でパスワードは書き換えられない

console.log('✓ all policy tests passed');
