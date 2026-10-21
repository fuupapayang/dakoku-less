'use strict';
const assert = require('assert');
const P = require('../src/recoruPost');
const at = (dd, h, m = 0) => new Date(2026, 9, dd, h, m).getTime(); // 2026年10月

// ---- 時刻変換: 24時以降は hour−24
assert.strictEqual(P.toRecoruTime('09:05'), '09:05');
assert.strictEqual(P.toRecoruTime('25:37'), '01:37');
assert.strictEqual(P.toRecoruTime('24:00'), '00:00');
assert.strictEqual(P.toRecoruTime(23 * 60 + 59), '23:59');
assert.strictEqual(P.toRecoruTime(27 * 60 + 5), '03:05');
assert.strictEqual(P.parseHM('1:00'), 60);
assert.strictEqual(P.parseHM(' 10:30 '), 630);
assert.strictEqual(P.parseHM(''), null);
assert.strictEqual(P.addDays('2026-10-01', -1), '2026-09-30');
assert.strictEqual(P.addDays('2026-12-31', 1), '2027-01-01');

// ---- 候補の日
const rec = (dd, h1 = 9, h2 = 18) => ({ start: at(dd, h1), end: at(dd, h2), workMin: (h2 - h1) * 60 - 60, breakMin: 60,
  breaks: [{ s: at(dd, 12), e: at(dd, 13), kind: 'break' }] });
const days = {
  '2026-10-10': { status: 'pending', estimation: rec(10) },          // 11日前(7日より前)
  '2026-10-14': { status: 'submitted', submitted: rec(14) },          // 7日前ちょうど
  '2026-10-16': { status: 'pending', estimation: rec(16) },          // 転記済み
  '2026-10-17': { status: 'pending', estimation: null },             // 記録なし
  '2026-10-18': { status: 'pending', estimation: { start: null } },  // 記録なし
  '2026-10-19': { status: 'rejected', estimation: rec(19) },         // 前回失敗 → やり直す
  '2026-10-20': { status: 'pending', estimation: rec(20) },          // 前日
  '2026-10-21': { status: 'recording', estimation: rec(21) }         // 今日
};
const posted = { '2026-10-16': { ok: true }, '2026-10-19': { ok: false, reason: 'x' } };
assert.deepStrictEqual(P.candidateKeys(days, '2026-10-21', posted), ['2026-10-14', '2026-10-19', '2026-10-20']);
// スキップ済み・保存済み(要確認)もやり直さない
assert.deepStrictEqual(P.candidateKeys(days, '2026-10-21', { ...posted, '2026-10-20': { skipped: true }, '2026-10-14': { saved: true } }), ['2026-10-19']);
// 上限日数を変える
assert.deepStrictEqual(P.candidateKeys(days, '2026-10-21', posted, { maxDays: 2 }), ['2026-10-19', '2026-10-20']);
// 「記録中」のまま残っている過去日は対象外(起動時に確定されてから)
assert.deepStrictEqual(P.candidateKeys({ '2026-10-20': { status: 'recording', estimation: rec(20) } }, '2026-10-21', {}), []);

// ---- 値の組み立て
const v = P.dayValues('2026-10-20', days['2026-10-20']);
assert.strictEqual(v.start, '09:00'); assert.strictEqual(v.end, '18:00');
assert.strictEqual(v.startIn, '09:00'); assert.strictEqual(v.endIn, '18:00');
assert.deepStrictEqual(v.breaks, [{ s: '12:00', e: '13:00', sIn: '12:00', eIn: '13:00' }]);
assert.strictEqual(v.breakMin, 60); assert.strictEqual(v.workMin, 480); assert.strictEqual(v.error, '');
// 日付をまたぐ勤務・休憩: 10:00〜翌1:37、休憩 12:00-12:30 / 23:50-翌0:20 / 0:10-0:30(重なりは結合)
const night = { status: 'submitted', submitted: { start: at(20, 10), end: at(21, 1, 37), workMin: 0, breakMin: 70,
  breaks: [{ s: at(21, 0, 10), e: at(21, 0, 30) }, { s: at(20, 12), e: at(20, 12, 30) }, { s: at(20, 23, 50), e: at(21, 0, 20) }] } };
const vn = P.dayValues('2026-10-20', night);
assert.strictEqual(vn.end, '25:37'); assert.strictEqual(vn.endIn, '01:37');
assert.deepStrictEqual(vn.breaks, [{ s: '12:00', e: '12:30', sIn: '12:00', eIn: '12:30' }, { s: '23:50', e: '24:30', sIn: '23:50', eIn: '00:30' }]);
assert.strictEqual(vn.breakMin, 70);
assert.strictEqual(vn.workMin, (15 * 60 + 37) - 70);
// 休憩が開始前・終了後にはみ出す分は切り詰め、1分未満は捨てる
const clip = P.normBreaks('2026-10-20', [{ s: at(20, 8), e: at(20, 9, 30) }, { s: at(20, 17, 59) + 40000, e: at(20, 18, 30) }], 9 * 60, 18 * 60);
assert.deepStrictEqual(clip, [{ s: 540, e: 570 }]);
// 休憩区間不明(手修正で時刻が違う)→ 休憩なしで転記し、メモで知らせる
const unk = { status: 'pending', correction: { start: at(20, 9), end: at(20, 18), workMin: 480, breakMin: 60 }, estimation: { ...rec(20, 8, 18) } };
const vu = P.dayValues('2026-10-20', unk);
assert.strictEqual(vu.breaksUnknown, true); assert.deepStrictEqual(vu.breaks, []);
assert.ok(vu.notes.some(n => n.startsWith('休憩区間不明')));
// 承認待ち・要確認のメモ
const pend = { status: 'pending', reviewReasons: ['休日の稼働'], estimation: rec(18) };
assert.deepStrictEqual(P.dayValues('2026-10-18', pend).notes, ['要確認: 休日の稼働']);
const appr = { status: 'submitted', submitted: { ...rec(20), needsApproval: true }, estimation: rec(20, 9, 17) };
assert.ok(P.dayValues('2026-10-20', appr).notes.some(n => n.includes('承認待ち')));
assert.strictEqual(P.dayValues('2026-10-20', appr).end, '17:00'); // 承認までは推定値
// 記録なし → null / 開始が翌0時以降 → エラー
assert.strictEqual(P.dayValues('2026-10-17', days['2026-10-17']), null);
assert.ok(P.dayValues('2026-10-20', { status: 'pending', estimation: { start: at(21, 1), end: at(21, 3), breaks: [] } }).error);

// ---- 勤務表の日付セル
assert.ok(P.rowDateMatches('10/20(火)', 10, 20));
assert.ok(P.rowDateMatches('20日(火)', 10, 20));
assert.ok(P.rowDateMatches('2026/10/20', 10, 20));
assert.ok(!P.rowDateMatches('10/21(水)', 10, 20));
assert.ok(!P.rowDateMatches('9/20(日)', 10, 20));
assert.ok(!P.rowDateMatches('', 10, 20));

// ---- 読み戻しの検証(±2分)
const ok1 = P.verifyRow(v, { start: '09:00', end: '18:00', breakText: '1:00', workText: '8:00' });
assert.deepStrictEqual([ok1.ok, ok1.adjusted], [true, false]);
assert.deepStrictEqual(ok1.rk, { start: '09:00', end: '18:00', break: '01:00', work: '08:00' });
assert.ok(P.verifyRow(v, { start: '09:00', end: '18:00', breakText: '1:02', workText: '7:58' }).ok);
// レコルの規定で休憩が増えた(拘束8h以上で1:00など)→ 失敗ではなく adjusted
const vs = P.dayValues('2026-10-20', { status: 'pending', estimation: { start: at(20, 9), end: at(20, 18), workMin: 525, breakMin: 15,
  breaks: [{ s: at(20, 12), e: at(20, 12, 15) }] } });
const adj = P.verifyRow(vs, { start: '09:00', end: '18:00', breakText: '1:00', workText: '8:00' });
assert.deepStrictEqual([adj.ok, adj.adjusted], [true, true]);
// 休憩が減った・労働時間が違う・開始が違う → 失敗
assert.ok(!P.verifyRow(v, { start: '09:00', end: '18:00', breakText: '0:30', workText: '8:30' }).ok);
assert.ok(!P.verifyRow(v, { start: '09:00', end: '18:00', breakText: '1:00', workText: '7:30' }).ok);
assert.ok(!P.verifyRow(v, { start: '09:10', end: '18:00', breakText: '1:00', workText: '7:50' }).ok);
assert.ok(!P.verifyRow(v, { start: '', end: '', breakText: '', workText: '' }).ok);
// 日付またぎ: レコルは 01:37 と表示
assert.ok(P.verifyRow(vn, { start: '10:00', end: '01:37', breakText: '1:10', workText: '14:27' }).ok);
// 休憩なしの日で休憩セルが空欄 → 0分
const v0 = P.dayValues('2026-10-20', { status: 'pending', estimation: { start: at(20, 9), end: at(20, 12), workMin: 180, breakMin: 0, breaks: [] } });
assert.ok(P.verifyRow(v0, { start: '09:00', end: '12:00', breakText: ' ', workText: '3:00' }).ok);

// ---- 確認を出すタイミング
const T = (h, m = 0, dd = 21) => new Date(2026, 9, dd, h, m).getTime();
const cfg = { postTime: '09:30' };
let d = P.triggerDecision('start', T(8, 0), {}, cfg);
assert.strictEqual(d.fire, true); assert.strictEqual(d.st.timeFiredDate, ''); // 時刻前の起動
assert.strictEqual(P.triggerDecision('tick', T(9, 0), d.st, cfg).fire, false); // 時刻前
const t1 = P.triggerDecision('tick', T(9, 30), d.st, cfg);
assert.strictEqual(t1.fire, true); assert.strictEqual(t1.st.timeFiredDate, '2026-10-21');
assert.strictEqual(P.triggerDecision('tick', T(9, 31), t1.st, cfg).fire, false); // 今日はもう出した
assert.strictEqual(P.triggerDecision('tick', T(9, 30, 22), t1.st, cfg).fire, true); // 翌日
// 時刻を過ぎてからの起動で出したら、その日の tick は出さない
const s2 = P.triggerDecision('start', T(10, 0), {}, cfg);
assert.strictEqual(P.triggerDecision('tick', T(10, 1), s2.st, cfg).fire, false);
// 復帰・ロック解除は1分のデバウンス
const r1 = P.triggerDecision('resume', T(13, 0), s2.st, cfg);
assert.strictEqual(r1.fire, true);
assert.strictEqual(P.triggerDecision('unlock', T(13, 0) + 30 * 1000, r1.st, cfg).fire, false);
assert.strictEqual(P.triggerDecision('unlock', T(13, 1) + 1000, r1.st, cfg).fire, true);

// ---- 記録・ログ
const results = [{ key: '2026-10-19', status: 'fail', reason: 'x' }, { key: '2026-10-20', status: 'ok', rk: { break: '01:00', work: '08:00' } },
  { key: '2026-10-18', status: 'skip', reason: 'レコルに入力済み' }];
const p2 = P.applyResults({ '2026-08-01': { ok: true } }, results, 1, { todayKey: '2026-10-21' });
assert.strictEqual(p2['2026-08-01'], undefined); // 62日より前は削除
assert.deepStrictEqual(p2['2026-10-20'], { at: 1, ok: true, skipped: false, saved: false, reason: '', adjusted: false, rk: { break: '01:00', work: '08:00' } });
assert.strictEqual(p2['2026-10-18'].skipped, true);
assert.strictEqual(P.lastOkDay(p2), '2026-10-20');
assert.strictEqual(P.lastOkDay({}), '');
const log = P.appendLog(Array.from({ length: 19 }, (_, i) => ({ key: 'old' + i })), results, 1);
assert.strictEqual(log.length, 20); assert.strictEqual(log[0].key, '2026-10-18');
assert.strictEqual(P.summaryText(results), '1日転記・1日スキップ・1日失敗');

// ---- 同期: tracking.recoruPost(管理者の「メンバーのアプリ」用)
const { normTracking } = require('../src/sync');
assert.deepStrictEqual(normTracking({ trackWork: true, recoruPost: { enabled: 1, lastOkDay: '2026-10-20' } }).recoruPost, { enabled: true, lastOkDay: '2026-10-20' });
assert.deepStrictEqual(normTracking({ recoruPost: { enabled: false, lastOkDay: '<x>' } }).recoruPost, { enabled: false, lastOkDay: '' });
assert.strictEqual('recoruPost' in normTracking({}), false);

console.log('recoruPost tests passed');
