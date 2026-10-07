'use strict';
const assert = require('assert');
const pe = require('../src/projectEdit');

const team = ['福永', '山岡 潤', '井上さくら', '増満奈央'];

// 1) 分割: カンマ・読点・全角カンマ・空白で区切り、前後空白除去・重複除去
assert.deepStrictEqual(pe.splitNames('小川, 日野、梶山，小川'), ['小川', '日野', '梶山']);
assert.deepStrictEqual(pe.splitNames('小川 日野　梶山'), ['小川', '日野', '梶山']);
assert.deepStrictEqual(pe.splitNames(['  福永 ', '', null, '福永']), ['福永']);
assert.deepStrictEqual(pe.splitNames(''), []);
assert.deepStrictEqual(pe.splitNames(undefined), []);
// 1b) チームメンバーのフルネームは空白で割らない(表記はメンバー名に揃える)
assert.deepStrictEqual(pe.splitNames('山岡 潤, 福永', team), ['山岡 潤', '福永']);
assert.deepStrictEqual(pe.splitNames('山岡潤', team), ['山岡 潤']);
assert.deepStrictEqual(pe.splitNames(['山岡 潤', '山岡潤'], team), ['山岡 潤']);
// 既知でない空白入りは分割
assert.deepStrictEqual(pe.splitNames('後藤 与那嶺', team), ['後藤', '与那嶺']);

// 2) ゆるい一致・未知名
assert.ok(pe.looseMatch('井上', '井上さくら') && pe.looseMatch('山岡潤', '山岡 潤'));
assert.ok(!pe.looseMatch('', '福永') && !pe.looseMatch('小川', '福永'));
assert.deepStrictEqual(pe.unknownNames(['井上', '小川', '増満'], team), ['小川']);

// 3) 必須チェック
assert.strictEqual(pe.validateStaff(['佐藤'], ['田中']), null);
assert.ok(/担当営業と制作/.test(pe.validateStaff([], [])));
assert.ok(/^担当営業/.test(pe.validateStaff([], ['田中'])));
assert.ok(/^制作/.test(pe.validateStaff(['佐藤'], undefined)));
assert.ok(pe.missingStaff({ sales: ['a'], makers: [] }) && pe.missingStaff({}) && !pe.missingStaff({ sales: ['a'], makers: ['b'] }));

// 4) パッチ整形: 担当に触れないパッチは担当未入力の案件でも通る
assert.deepStrictEqual(pe.normalizePatch({ status: 'delivered' }).patch, { status: 'delivered' });
assert.ok(pe.normalizePatch({ status: 'bogus' }).error);
assert.ok(pe.normalizePatch({ name: '  ' }).error);
const np = pe.normalizePatch({ id: 'x', code: 'Z9', createdBy: 'evil', name: ' 新名 ', budgetHours: '-3', estimateAmount: '1000', sales: '佐藤、鈴木', makers: ['田中'] });
assert.deepStrictEqual(np.patch, { name: '新名', budgetHours: 0, estimateAmount: 1000, sales: ['佐藤', '鈴木'], makers: ['田中'] });
assert.ok(pe.normalizePatch({ sales: ['佐藤'], makers: ' 、 ' }).error);

// 5) applyEdit: updatedAt を単調に進め、最終編集者を記録、keywordsReview を消す
const p = { id: 'p1', code: 'F1', name: 'A', sales: [], makers: [], updatedAt: 5000, keywordsReview: true, createdBy: '福永' };
let r = pe.applyEdit(p, { makers: ['日野'] }, { userName: '福永', now: 1000 });
assert.ok(/担当営業/.test(r.error), '片方だけ送っても既存の空のもう片方で弾く');
assert.strictEqual(p.updatedAt, 5000, 'エラー時は変更しない');
assert.deepStrictEqual(p.makers, []);
r = pe.applyEdit(p, { sales: '後藤', makers: '日野, 山岡潤' }, { userName: '福永', knownNames: team, now: 1000 });
assert.ok(!r.error);
assert.deepStrictEqual(p.sales, ['後藤']);
assert.deepStrictEqual(p.makers, ['日野', '山岡 潤']);
assert.strictEqual(p.updatedAt, 5001, '時計が遅れていても updatedAt は前回より大きく(同期で勝つ)');
assert.strictEqual(p.lastEditedBy, '福永');
assert.strictEqual(p.createdBy, '福永');
assert.ok(!('keywordsReview' in p));
// 片方だけの変更は既存のもう片方で検査して通る
r = pe.applyEdit(p, { makers: ['梶山'] }, { userName: '井上', now: 9000 });
assert.ok(!r.error);
assert.deepStrictEqual(p.sales, ['後藤']);
assert.deepStrictEqual(p.makers, ['梶山']);
assert.strictEqual(p.updatedAt, 9000);
assert.strictEqual(p.lastEditedBy, '井上');
// 担当に触れない更新(納品完了)は担当未入力の案件でも通る
const old = { id: 'p2', sales: [], makers: [] };
assert.ok(!pe.applyEdit(old, { status: 'delivered' }, { now: 1 }).error);
assert.strictEqual(old.status, 'delivered');
assert.ok(pe.applyEdit(null, {}).error);

console.log('projectEdit tests passed');
