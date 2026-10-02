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

console.log('✓ all recoru tests passed');
