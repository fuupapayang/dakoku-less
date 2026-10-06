'use strict';
const assert = require('assert');
const mt = require('../src/meetings');
const cal = require('../src/calendar');
const engine = require('../src/engine');

const MIN = 60000;
const at = (h, m = 0) => new Date(2026, 6, 14, h, m).getTime(); // 2026-07-14(火)

// 1) 作成: 案件外 = kind internal / 案件を選ぶと projectId(kindと排他)・コード前置summary
const a = mt.createMeeting(at(10, 5), null);
assert.strictEqual(a.kind, 'internal');
assert.strictEqual(a.summary, '社内会議（案件外）');
assert.ok(a.adhoc && a.open && a.s === at(10, 5));
const b = mt.createMeeting(at(10, 5), { id: 'p1', code: 'F000' });
assert.strictEqual(b.projectId, 'p1');
assert.strictEqual(b.kind, undefined);
assert.strictEqual(b.summary, 'F000_社内会議');

// 2) 記録中の会議: 終了=今(上限まで)。元データは変更しない
const calendar = [{ s: at(9), e: at(9, 30), summary: 'ICSの予定' }, a];
assert.strictEqual(mt.openMeeting(calendar), a);
assert.strictEqual(mt.openMeeting([{ ...a, open: false }]), null);
const fe = mt.forEngine(calendar, at(10, 40));
assert.strictEqual(fe[1].e, at(10, 40));
assert.strictEqual(a.e, at(10, 5));
assert.strictEqual(fe[0], calendar[0]);
assert.strictEqual(mt.forEngine([a], at(20))[0].e, a.s + mt.MAX_MIN * MIN); // 上限で頭打ち
assert.strictEqual(mt.forEngine([a], at(10, 40), mt.MAX_MIN, MIN)[0].e, at(10, 41)); // 判定用の先読み
// 会議中の判定(B の activeKindAt)が効く
assert.strictEqual(cal.activeKindAt(mt.forEngine([a], at(10, 40), mt.MAX_MIN, MIN), at(10, 40)), 'internal');

// 3) 推定エンジン: 会議中の無操作は稼働扱い(会議と重なる部分だけ)
const day = {
  intervals: [{ s: at(9), e: at(10, 5) }, { s: at(11), e: at(12) }],
  calendar: [{ ...a, open: false, e: at(10, 40) }]
};
const est = engine.estimate(day, [], {});
const brk = est.breaks.reduce((x, y) => x + (y.e - y.s) / MIN, 0);
assert.strictEqual(brk, 20); // 10:40〜11:00 だけ休憩
assert.ok(est.segments.some(s => s.kind === 'work' && /会議/.test(s.label) && s.s === at(10, 5) && s.e === at(10, 40)));

// 4) PC稼働の範囲外へはみ出す分を稼働区間として補う(会議から直帰)
const ivs = [{ s: at(9), e: at(17) }];
assert.deepStrictEqual(mt.extraIntervals([{ s: at(16, 30), e: at(18) }], ivs), [{ s: at(17), e: at(18) }]);
assert.deepStrictEqual(mt.extraIntervals([{ s: at(8), e: at(9, 30) }], ivs), [{ s: at(8), e: at(9) }]);
assert.deepStrictEqual(mt.extraIntervals([{ s: at(10), e: at(11) }], ivs), []);
assert.deepStrictEqual(mt.extraIntervals([{ s: at(10), e: at(11) }], []), [{ s: at(10), e: at(11) }]);
const est2 = engine.estimate({ intervals: [...ivs, ...mt.extraIntervals([{ s: at(16, 30), e: at(18) }], ivs)], calendar: [] }, [], {});
assert.strictEqual(est2.end, at(18));

// 5) 終了し忘れ: min(開始+上限, 最後の記録/稼働, 勤務日の終わり)
const bounds = mt.dayBounds('2026-07-14', 4);
assert.strictEqual(bounds.start, at(4));
assert.strictEqual(bounds.end, new Date(2026, 6, 15, 4).getTime());
const o = { ...a, seenAt: at(10, 50) };
assert.strictEqual(mt.plausibleEnd(o, [{ s: at(9), e: at(10, 20) }], bounds.end), at(10, 50));
assert.strictEqual(mt.plausibleEnd({ ...a, seenAt: 0 }, [{ s: at(9), e: at(11) }], bounds.end), at(11));
assert.strictEqual(mt.plausibleEnd({ ...a, seenAt: at(23) }, [], bounds.end), a.s + mt.MAX_MIN * MIN);
assert.strictEqual(mt.plausibleEnd({ ...a, seenAt: 0 }, [{ s: at(9), e: at(10) }], bounds.end), a.s); // 開始後の記録なし → 0分
const late = { ...a, s: new Date(2026, 6, 15, 2).getTime(), seenAt: new Date(2026, 6, 15, 5).getTime() };
assert.strictEqual(mt.plausibleEnd(late, [], bounds.end), bounds.end); // 翌日(4時以降)へまたがない
assert.ok(!mt.recordable(at(10), at(10) + 30000));
assert.ok(mt.recordable(at(10), at(10, 1)));

// 6) 時刻修正の検証
const now = at(18);
assert.deepStrictEqual(mt.validateEdit('2026-07-14', 600, 645, now), { s: at(10), e: at(10, 45) });
assert.ok(mt.validateEdit('2026-07-14', 645, 600, now).error);
assert.ok(mt.validateEdit('2026-07-14', 600, 1200, now).error);           // 未来
assert.ok(mt.validateEdit('2026-07-14', 120, 180, now).error);            // 勤務日の開始(4時)より前
assert.ok(!mt.validateEdit('2026-07-14', 1500, 1530, new Date(2026, 6, 15, 3).getTime()).error); // 深夜(翌1時)はOK
assert.ok(mt.validateEdit('2026-07-14', 'x', 600, now).error);

console.log('✓ all meetings tests passed');
