'use strict';
const assert = require('assert');
const e = require('../src/engine');

const D = (h, m = 0) => new Date(2026, 6, 10, h, m).getTime(); // 2026-07-10 (金)

// 1) 基本推定: 9:00-12:00, 13:00-18:00 → 昼休憩1h
let r = e.estimate({ intervals: [{ s: D(9), e: D(12) }, { s: D(13), e: D(18) }] });
assert.strictEqual(e.fmtTime(r.start), '09:00');
assert.strictEqual(e.fmtTime(r.end), '18:00');
assert.strictEqual(r.breakMin, 60);
assert.strictEqual(r.workMin, 480);
assert.strictEqual(r.confidence, 'STABLE');

// 2) データなし → LOW
r = e.estimate({ intervals: [] });
assert.strictEqual(r.confidence, 'LOW');

// 3) 微妙な空白が複数 → UNSURE
r = e.estimate({ intervals: [
  { s: D(9), e: D(10) }, { s: D(10, 10), e: D(15) }, { s: D(15, 10), e: D(18) }
] });
assert.strictEqual(r.confidence, 'UNSURE');

// 4) マイルール: 10:30-11:00 は移動(対象外)
r = e.estimate(
  { intervals: [{ s: D(9), e: D(10, 30) }, { s: D(11), e: D(18) }] },
  [{ id: 'r1', label: '移動時間', treatAs: 'exclude', fromMin: 630, toMin: 660, weekday: null, enabled: true }]
);
assert.strictEqual(r.breaks.length, 1);
assert.strictEqual(r.breaks[0].kind, 'exclude');
assert.strictEqual(r.workMin, 510);

// 5) カレンダー: 会議中の無操作は稼働扱い
r = e.estimate({
  intervals: [{ s: D(9), e: D(14) }, { s: D(15), e: D(18) }],
  calendar: [{ s: D(14), e: D(15), summary: '定例会議' }]
});
assert.strictEqual(r.breakMin, 0);
assert.strictEqual(r.workMin, 540);

// 6) カレンダー: 「移動」予定 → 対象外 + ルール提案
r = e.estimate({
  intervals: [{ s: D(9), e: D(10, 30) }, { s: D(11), e: D(18) }],
  calendar: [{ s: D(10, 30), e: D(11), summary: '移動' }]
});
assert.strictEqual(r.suggestions.length, 1);
assert.strictEqual(r.suggestions[0].treatAs, 'exclude');

// 7) 修正差分 → ルール候補(HITL)
const est = e.estimate({ intervals: [{ s: D(9), e: D(18) }] });
const props = e.diffToRuleProposals(est, {
  start: D(9), end: D(18), breaks: [{ s: D(15), e: D(15, 30) }]
});
assert.strictEqual(props.length, 1);
assert.strictEqual(props[0].treatAs, 'break');

// 8) 提出モード
assert.strictEqual(e.shouldAutoSubmit('auto', 'LOW'), true);
assert.strictEqual(e.shouldAutoSubmit('moderate', 'UNSURE'), true);
assert.strictEqual(e.shouldAutoSubmit('moderate', 'LOW'), false);
assert.strictEqual(e.shouldAutoSubmit('strict', 'UNSURE'), false);
assert.strictEqual(e.shouldAutoSubmit('strict', 'STABLE'), true);
assert.strictEqual(e.shouldAutoSubmit('manual', 'STABLE'), false);

// 9) ICSパース
const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20260710T103000
DTEND;TZID=Asia/Tokyo:20260710T110000
SUMMARY:移動
END:VEVENT
END:VCALENDAR`;
const evs = e.parseICS(ics);
assert.strictEqual(evs.length, 1);
assert.strictEqual(evs[0].summary, '移動');

// 10) dayKey: 深夜2時は前日扱い(dayStartHour=4)
assert.strictEqual(e.dayKey(new Date(2026, 6, 11, 2).getTime(), 4), '2026-07-10');

console.log('✓ all 10 engine tests passed');
