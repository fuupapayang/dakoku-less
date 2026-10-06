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
assert.deepStrictEqual(R.IMPORT_HEADERS, ['名前', 'ユーザID', '日付', '勤務区分', '開始', '終了', '休憩時間', 'メモ']);
assert.deepStrictEqual(R.importRow('山田 太郎', 'U1', '2026-09-04', e4, 'm'), ['山田 太郎', 'U1', '2026/09/04', '出勤', '09:00', '23:00', '01:00', 'm']);
// ユーザID未設定: 名前で代用せず空欄、メモで知らせる
assert.deepStrictEqual(R.importRow('山田 太郎', '', '2026-09-04', e4, 'm'), ['山田 太郎', '', '2026/09/04', '出勤', '09:00', '23:00', '01:00', 'm / ユーザID未設定']);
assert.strictEqual(R.importRow('山田 太郎', '  ', '2026-09-04', e4)[7], 'ユーザID未設定');
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

// ---- 勤怠履歴CSV
const H = (name) => R.HISTORY_HEADERS.indexOf(name);
const SL = { pending: '未提出', submitted: '提出済み', approved: '承認済み' };
const hDays = {
  // 平日・承認済み・深夜跨ぎ(9:00〜翌1:00、休憩1h → 実働15h)
  '2026-09-04': { status: 'approved', estimation: { start: at(9, 0, 4), end: at(1, 0, 5), breakMin: 60, workMin: 900 },
    submitted: { start: at(9, 0, 4), end: at(1, 0, 5), breakMin: 60, workMin: 900 },
    meetingMin: 45, privateMin: 20.4, categoryMin: { internal: 30, shoot: 90 } },
  // 土曜・未提出・要確認
  '2026-09-05': { status: 'pending', reviewReasons: ['休日の稼働'], estimation: { start: at(10, 0, 5), end: at(13, 0, 5), breakMin: 0, workMin: 180 } },
  // 日曜 → 残業0
  '2026-09-06': { status: 'submitted', estimation: { start: at(10, 0, 6), end: at(12, 0, 6), breakMin: 0, workMin: 120 },
    submitted: { start: at(10, 0, 6), end: at(12, 0, 6), breakMin: 0, workMin: 120 } },
  // 平日・+2hの修正で承認待ち → 推定値で出力、修正値は別列
  '2026-09-07': { status: 'submitted', estimation: { start: at(9, 0, 7), end: at(18, 0, 7), breakMin: 60, workMin: 480 },
    correction: { start: at(9, 0, 7), end: at(20, 0, 7), breakMin: 60, workMin: 600 },
    submitted: { start: at(9, 0, 7), end: at(20, 0, 7), breakMin: 60, workMin: 600, needsApproval: true } },
  // 平日・未提出で-15分の修正 → 修正値をそのまま
  '2026-09-08': { status: 'pending', estimation: { start: at(9, 0, 8), end: at(18, 0, 8), breakMin: 60, workMin: 480 },
    correction: { start: at(9, 0, 8), end: at(17, 45, 8), breakMin: 60, workMin: 465 } },
  // 未提出で+1hの修正 → 承認前の値として推定値
  '2026-09-09': { status: 'pending', estimation: { start: at(9, 0, 9), end: at(18, 0, 9), breakMin: 60, workMin: 480 },
    correction: { start: at(9, 0, 9), end: at(19, 0, 9), breakMin: 60, workMin: 540 } },
  '2026-09-10': { status: 'pending', estimation: null }, // 記録なしは出力しない
  '2026-10-01': { status: 'pending', estimation: { start: new Date(2026, 9, 1, 9).getTime(), end: new Date(2026, 9, 1, 18).getTime(), breakMin: 60, workMin: 480 } }
};
const hr = R.historyRows(hDays, { from: '2026-09-01', to: '2026-09-30', statusLabel: SL });
assert.strictEqual(hr.length, 6);
assert.ok(hr.every(r => r.length === R.HISTORY_HEADERS.length));
assert.deepStrictEqual(hr[0], ['2026/09/04', '金', '出勤', '09:00', '25:00', '01:00', '15:00', '07:00', '00:45', '00:20', '00:30', '01:30', '承認済み', '', '', '']);
assert.strictEqual(hr[1][H('区分')], '所定休日出勤');
assert.strictEqual(hr[1][H('残業')], '03:00');                        // 土曜は全部残業
assert.strictEqual(hr[1][H('備考')], '要確認: 休日の稼働');
assert.strictEqual(hr[2][H('区分')], '法定休日出勤');
assert.strictEqual(hr[2][H('残業')], '00:00');                        // 日曜は休日労働(残業0)
assert.strictEqual(hr[3][H('実働')], '08:00');                        // 承認待ち → 推定値
assert.strictEqual(hr[3][H('終業')], '18:00');
assert.strictEqual(hr[3][H('本人修正')], '+02:00');
assert.strictEqual(hr[3][H('修正後(承認待ち)')], '09:00〜20:00 休憩01:00 実働10:00');
assert.ok(hr[3][H('備考')].includes('承認待ち'));
assert.strictEqual(hr[4][H('実働')], '07:45');
assert.strictEqual(hr[4][H('本人修正')], '-00:15');
assert.strictEqual(hr[4][H('修正後(承認待ち)')], '');
assert.strictEqual(hr[5][H('実働')], '08:00');                        // +1hの未提出修正は推定値
assert.strictEqual(hr[5][H('修正後(承認待ち)')], '09:00〜19:00 休憩01:00 実働09:00');
// 承認後は修正値
const appr = R.historyRows({ '2026-09-07': { ...hDays['2026-09-07'], status: 'approved' } }, { statusLabel: SL });
assert.strictEqual(appr[0][H('実働')], '10:00');
assert.strictEqual(appr[0][H('修正後(承認待ち)')], '');
// 期間未指定は全件
assert.strictEqual(R.historyRows(hDays).length, 7);
assert.ok(R.toCSV([R.HISTORY_HEADERS, ...hr]).startsWith('日付,曜日,区分,'));

console.log('✓ all recoru tests passed');
