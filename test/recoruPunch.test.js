'use strict';
const assert = require('assert');
const R = require('../src/recoruPunch');
const at = (dd, h, m = 0, s = 0) => new Date(2026, 9, dd, h, m, s).getTime(); // 2026年10月
const K = (dd) => `2026-10-${String(dd).padStart(2, '0')}`;

/** 15秒ごとに from〜to を稼働(または無操作)としてサンプリング。打刻は成功扱い、確認は answer で応答 */
function run(st, from, to, active, { answer = null, status = 'ok' } = {}) {
  const out = [];
  for (let t = from; t <= to; t += 15000) {
    const a = R.tick(st, { now: t, active });
    if (!a) continue;
    out.push({ ...a, t });
    if (a.kind === 'prompt') {
      R.promptShown(st, { key: a.key, now: t });
      if (answer) {
        const b = R.promptAnswer(st, { key: a.key, now: t, answer });
        if (b) { out.push({ ...b, t }); R.record(st, { kind: b.kind, key: b.key, now: t, status }); }
      }
    } else R.record(st, { kind: a.kind, key: a.key, now: t, status });
  }
  return out;
}
const kinds = (p) => p.map(x => `${x.kind}@${R.hm(x.t)}`);

// ---- 区分
assert.strictEqual(R.period(at(23, 9)), 'day');
assert.strictEqual(R.period(at(23, 22)), 'late');
assert.strictEqual(R.period(at(24, 3)), 'night');
assert.strictEqual(R.period(at(24, 5)), 'day');
assert.strictEqual(R.punchKey(at(24, 4, 59)), K(23));
assert.strictEqual(R.punchKey(at(24, 5, 0)), K(24));

// ---- 出勤: 最初の操作の瞬間・1日1回
{
  const st = R.emptyState();
  const p = run(st, at(23, 8, 59, 45), at(23, 12, 0), true);
  assert.deepStrictEqual(kinds(p), ['in@08:59']);
  assert.ok(R.hasIn(st, K(23)));
}

// ---- 5〜24時: ロック・スリープ・無操作では退勤しない。シャットダウンは確認
{
  const st = R.emptyState();
  run(st, at(23, 9, 0), at(23, 12, 0), true);
  assert.deepStrictEqual(run(st, at(23, 12, 0, 15), at(23, 16, 0), false), []);
  assert.strictEqual(R.away(st, { now: at(23, 16, 1), reason: 'lock' }), null);
  assert.strictEqual(R.away(st, { now: at(23, 16, 1), reason: 'suspend' }), null);
  assert.deepStrictEqual(R.away(st, { now: at(23, 18, 0), reason: 'shutdown' }), { kind: 'confirm', key: K(23), reason: 'shutdown' });
  assert.deepStrictEqual(R.away(st, { now: at(23, 23, 0), reason: 'shutdown' }), { kind: 'confirm', key: K(23), reason: 'shutdown' });
  // 確認で退勤 → 操作がなければ二度目の確認は出さない。再び操作すれば次の終了時にまた確認
  R.record(st, { kind: 'out', key: K(23), now: at(23, 18, 0), status: 'ok' });
  assert.strictEqual(R.away(st, { now: at(23, 18, 1), reason: 'shutdown' }), null);
  run(st, at(23, 19, 0), at(23, 20, 0), true);
  assert.strictEqual(R.away(st, { now: at(23, 20, 1), reason: 'shutdown' }).kind, 'confirm');
  const s = R.summary(st, [K(23)])[0];
  assert.deepStrictEqual([s.in.time, s.out.time], ['09:00', '18:00']);
}

// ---- 0〜5時: 1時間おきに確認。「はい」で続行、「いいえ」でその場で退勤
{
  const st = R.emptyState();
  run(st, at(23, 21, 0), at(23, 23, 59, 45), true);
  const p = run(st, at(24, 0, 0), at(24, 1, 59), true, { answer: 'yes' });
  assert.deepStrictEqual(kinds(p), ['prompt@00:00', 'prompt@01:00']);
  const p2 = run(st, at(24, 2, 0), at(24, 2, 10), true, { answer: 'no' });
  assert.deepStrictEqual(kinds(p2), ['prompt@02:00', 'out@02:00']);
  assert.strictEqual(R.summary(st, [K(23)])[0].out.time, '02:00');
}

// ---- 0〜5時: 確認に30分答えがない → 退勤
{
  const st = R.emptyState();
  run(st, at(23, 21, 0), at(23, 23, 59, 45), true);
  const p = run(st, at(24, 0, 0), at(24, 0, 5), true); // 確認は出たが答えない
  assert.deepStrictEqual(kinds(p), ['prompt@00:00']);
  const p2 = run(st, at(24, 0, 5, 15), at(24, 0, 59), true); // 退勤後も作業を続ければ、次の1時に再び確認が出る
  assert.deepStrictEqual(kinds(p2), ['out@00:30']);
}

// ---- 夜に作業を終えてPCを放置: 22〜24時は退勤しない → 0時の時点で既に30分操作がないので0時に退勤
{
  const st = R.emptyState();
  run(st, at(23, 21, 0), at(23, 22, 30), true);
  const p = run(st, at(23, 22, 30, 15), at(24, 3, 0), false);
  assert.deepStrictEqual(kinds(p), ['out@00:00']);
}
// ---- 0時台に作業を終えて放置: 30分後に退勤
{
  const st = R.emptyState();
  run(st, at(23, 21, 0), at(24, 0, 40), true, { answer: 'yes' });
  const p = run(st, at(24, 0, 40, 15), at(24, 3, 0), false);
  assert.deepStrictEqual(kinds(p), ['out@01:10']);
}
// ---- 23:50まで作業して放置: 0時ではまだ30分たっていない → 0:20に退勤
{
  const st = R.emptyState();
  run(st, at(23, 21, 0), at(23, 23, 50), true);
  const p = run(st, at(23, 23, 50, 15), at(24, 3, 0), false);
  assert.deepStrictEqual(kinds(p), ['out@00:20']);
}

// ---- 深夜0〜5時の作業は前日扱い(出勤しない)・5時以降の操作で新しい日の出勤
{
  const st = R.emptyState();
  run(st, at(23, 9, 0), at(23, 9, 1), true);
  R.record(st, { kind: 'out', key: K(23), now: at(23, 18, 0), status: 'ok' });
  const p = run(st, at(24, 1, 0), at(24, 1, 5), true, { answer: 'yes' });
  assert.deepStrictEqual(kinds(p), ['prompt@01:00']);
  const p2 = run(st, at(24, 5, 0), at(24, 5, 1), true);
  assert.deepStrictEqual(kinds(p2), ['in@05:00']);
}

// ---- 出勤前は退勤しない
{
  const st = R.emptyState();
  assert.strictEqual(R.away(st, { now: at(23, 9, 4), reason: 'lock' }), null);
}

// ---- 出勤の失敗: 1分あけて再試行、3回で打ち切り
{
  const st = R.emptyState();
  const p = run(st, at(23, 9, 0), at(23, 9, 20), true, { status: 'fail' });
  assert.deepStrictEqual(kinds(p), ['in@09:00', 'in@09:01', 'in@09:02']);
  assert.ok(!R.hasIn(st, K(23)));
}

// ---- 確認できない(押せたが読み戻せない)は打刻済み扱い(二重打刻しない)
{
  const st = R.emptyState();
  assert.strictEqual(run(st, at(23, 9, 0), at(23, 10, 0), true, { status: 'unverified' }).length, 1);
}

// ---- 退勤できないまま日が変わった日
{
  const st = R.emptyState();
  run(st, at(22, 9, 0), at(22, 19, 0), true); // 退勤前にアプリ終了
  const m = R.missedOuts(st, K(23));
  assert.deepStrictEqual(m.map(x => [x.key, R.hm(x.lastActiveAt)]), [[K(22), '19:00']]);
  st.days[K(22)].missNotified = true;
  assert.strictEqual(R.missedOuts(st, K(23)).length, 0);
}

// ---- 14日より前は削除
{
  const st = R.emptyState();
  run(st, at(1, 9, 0), at(1, 9, 1), true);
  R.record(st, { kind: 'out', key: K(23), now: at(23, 18, 0), status: 'ok' });
  assert.ok(!st.days[K(1)]);
}

console.log('recoruPunch tests passed');
