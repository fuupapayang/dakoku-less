'use strict';
const assert = require('assert');
const E = require('../src/engine');
const R = require('../src/recoru');
const at = (h, m = 0, dd = 5) => new Date(2026, 8, dd, h, m).getTime();

// ---- 回帰: 10:00〜10:15「朝会=稼働」ルールが、それをまたぐ長い不在を丸ごと稼働にしない
const rules = [{ label: '朝会', treatAs: 'work', fromMin: 600, toMin: 615, enabled: true }];
const day = { intervals: [{ s: at(8), e: at(9) }, { s: at(18), e: at(19) }] }; // 9:00〜18:00は不在
const est = E.estimate(day, rules, {});
assert.strictEqual(est.workMin, 60 + 15 + 60);           // 稼働2h + 朝会15分だけ
assert.strictEqual(est.breakMin, 9 * 60 - 15);
// カレンダー予定も重なる部分だけ稼働扱い(会議30分 / 不在9時間)
const est2 = E.estimate({ ...day, calendar: [{ s: at(13), e: at(13, 30), summary: '定例' }] }, [], {});
assert.strictEqual(est2.workMin, 120 + 30);
// ルールが空白全体を覆う場合は従来どおり
const est3 = E.estimate({ intervals: [{ s: at(9, 55), e: at(9, 59) }, { s: at(10, 20), e: at(11) }] }, rules, {});
assert.ok(est3.workMin >= 60);

// ---- 区分
assert.strictEqual(R.dayType('2026-09-04'), 'work');
assert.strictEqual(R.dayType('2026-09-05'), 'scheduledHoliday'); // 土
assert.strictEqual(R.dayType('2026-09-06'), 'legalHoliday');     // 日
assert.strictEqual(R.dayType('2026-09-22'), 'scheduledHoliday'); // 国民の休日
// ---- 24時超え表記
assert.strictEqual(R.clock('2026-09-04', at(2, 30, 5)), '26:30');
// ---- 深夜: 21:00〜翌1:00、休憩なし → 22:00〜1:00 = 180分
assert.strictEqual(R.nightMin('2026-09-04', { start: at(21, 0, 4), end: at(1, 0, 5), breaks: [] }), 180);
// 23:00〜24:00を休憩 → 120分
assert.strictEqual(R.nightMin('2026-09-04', { start: at(21, 0, 4), end: at(1, 0, 5), breaks: [{ s: at(23, 0, 4), e: at(0, 0, 5) }] }), 120);
// ---- 取込行・集計
const e4 = { start: at(9, 0, 4), end: at(23, 0, 4), breakMin: 60, workMin: 780, breaks: [{ s: at(12, 0, 4), e: at(13, 0, 4) }] };
assert.deepStrictEqual(R.importRow('U1', '2026-09-04', e4, 'm'), ['U1', '2026/09/04', '出勤', '09:00', '23:00', '01:00', 'm']);
const sm = R.summarize('2026-09-04', e4);
assert.strictEqual(sm[R.SUMMARY_HEADERS.indexOf('法定外残業')], '05:00');
assert.strictEqual(sm[R.SUMMARY_HEADERS.indexOf('深夜')], '01:00');
assert.deepStrictEqual(R.reviewReasons('2026-09-05', { start: 1, workMin: 100 }), ['休日の稼働']);
assert.deepStrictEqual(R.reviewReasons('2026-09-04', e4, { longMin: 720 }), ['実働12時間以上']);
assert.strictEqual(R.toCSV([['a', 'b,c']]), 'a,"b,c"\r\n');

// ---- みなし残業
const W = (min) => ({ estimation: { start: 1, workMin: min } });
const ot = R.monthOvertime({
  '2026-09-01': W(600),  // 平日10h → 残業2h
  '2026-09-02': W(420),  // 平日7h → 0(不足はマイナスしない)
  '2026-09-05': W(300),  // 土曜 → 全部残業
  '2026-09-06': W(240),  // 日曜 → 休日労働
  '2026-09-22': W(60),   // 祝日 → 残業
  '2026-08-31': W(900)   // 前月は対象外
}, '2026-09', '2026-09-10');
assert.strictEqual(ot.overtimeMin, 120 + 300 + 60);
assert.strictEqual(ot.legalHolidayMin, 240);
assert.strictEqual(ot.forecastMin, Math.round(480 / 10 * 30));
assert.strictEqual(R.overtimeLevel(ot, 2700), 'ok');     // 8h消化・月末予測24h
assert.strictEqual(R.overtimeLevel({ overtimeMin: 1200, forecastMin: 3600, elapsed: 10 }, 2700), 'pace');
assert.strictEqual(R.overtimeLevel({ overtimeMin: 1200, forecastMin: 3600, elapsed: 3 }, 2700), 'ok'); // 月初はブレるので予測警告しない
assert.strictEqual(R.overtimeLevel({ overtimeMin: 2200, forecastMin: 2200, elapsed: 28 }, 2700), 'warn');
assert.strictEqual(R.overtimeLevel({ overtimeMin: 2700, forecastMin: 2700, elapsed: 28 }, 2700), 'over');
// ---- 水増し対策: 30分超の「稼働扱い」ルールは無効
const longRule = [{ label: '作業', treatAs: 'work', fromMin: 9 * 60, toMin: 18 * 60, enabled: true }];
assert.strictEqual(E.estimate(day, longRule, {}).workMin, 120);           // 9時間ルールは効かない
assert.strictEqual(E.estimate(day, rules, {}).workMin, 135);              // 15分ルールは有効
const prop = E.diffToRuleProposals({ start: at(8), breaks: [{ s: at(12), e: at(14) }] }, { breaks: [] });
assert.strictEqual(prop.length, 0);                                       // 2時間の休憩削除から稼働ルールを提案しない

// ---- 水増し対策: 30分以上増やす修正は承認まで推定値で集計
const pend = { status: 'submitted', estimation: { start: 1, workMin: 480 }, correction: { start: 1, workMin: 600 }, submitted: { start: 1, workMin: 600, needsApproval: true } };
assert.strictEqual(R.recordOf(pend).workMin, 480);
assert.strictEqual(R.recordOf({ ...pend, status: 'approved' }).workMin, 600);
assert.strictEqual(R.recordOf({ start: 1, workMin: 600, estWorkMin: 480, needsApproval: true, status: 'submitted' }).workMin, 480); // 同期サマリー
assert.strictEqual(R.monthOvertime({ '2026-09-01': pend }, '2026-09', '2026-09-30').overtimeMin, 0);

console.log('✓ all recoru tests passed');
