'use strict';
const assert = require('assert');
const R = require('../src/recoruPunch');
const at = (dd, h, m = 0, s = 0) => new Date(2026, 9, dd, h, m, s).getTime(); // 2026年10月
const K = (dd) => `2026-10-${String(dd).padStart(2, '0')}`;

/** 15秒ごとに from〜to を稼働(または無操作)としてサンプリングし、出た打刻を返す */
function run(st, from, to, active, key, onPunch) {
  const out = [];
  for (let t = from; t <= to; t += 15000) {
    const a = R.tick(st, { now: t, key, active });
    if (a) { out.push({ ...a, t }); if (onPunch) onPunch(a, t); }
  }
  return out;
}
const ok = (st) => (a, t) => R.record(st, { kind: a.kind, key: a.key, now: t, status: 'ok' });

// ---- 出勤: 5分連続の稼働で1回だけ
{
  const st = R.emptyState();
  const p = run(st, at(23, 9, 0), at(23, 9, 4, 45), true, K(23), ok(st));
  assert.strictEqual(p.length, 0, '5分未満では打刻しない');
  const p2 = run(st, at(23, 9, 5), at(23, 10, 0), true, K(23), ok(st));
  assert.strictEqual(p2.length, 1);
  assert.deepStrictEqual([p2[0].kind, p2[0].key], ['in', K(23)]);
  assert.strictEqual(R.hm(p2[0].t), '09:05');
  assert.ok(R.hasIn(st, K(23)));
}

// ---- 短い操作(5分未満)が途切れたら連続はリセット
{
  const st = R.emptyState();
  run(st, at(23, 7, 0), at(23, 7, 3), true, K(23), ok(st));
  run(st, at(23, 7, 3, 15), at(23, 8, 0), false, K(23), ok(st));
  const p = run(st, at(23, 8, 0, 15), at(23, 8, 6), true, K(23), ok(st));
  assert.strictEqual(p.length, 1);
  assert.strictEqual(R.hm(p[0].t), '08:05');
}

// ---- 深夜0〜4時(アプリの日付は前日)の作業では出勤しない
{
  const st = R.emptyState();
  const p = run(st, at(24, 1, 0), at(24, 2, 0), true, K(23), ok(st));
  assert.strictEqual(p.filter(x => x.kind === 'in').length, 0);
}

// ---- 退勤: 15分無操作で1回。再び稼働したら、次に離れた時にもう一度
{
  const st = R.emptyState();
  run(st, at(23, 9, 0), at(23, 18, 0), true, K(23), ok(st));
  const p = run(st, at(23, 18, 0, 15), at(23, 19, 0), false, K(23), ok(st));
  assert.strictEqual(p.length, 1);
  assert.deepStrictEqual([p[0].kind, R.hm(p[0].t)], ['out', '18:15']);
  // 戻って作業 → 再度離れる
  run(st, at(23, 20, 0), at(23, 21, 0), true, K(23), ok(st));
  const p2 = run(st, at(23, 21, 0, 15), at(23, 22, 0), false, K(23), ok(st));
  assert.strictEqual(p2.length, 1);
  assert.strictEqual(R.hm(p2[0].t), '21:15');
  const s = R.summary(st, [K(23)])[0];
  assert.strictEqual(s.in.time, '09:05');
  assert.strictEqual(s.out.time, '21:15');
  assert.strictEqual(s.out.count, 2);
}

// ---- 画面ロック: その場で退勤。稼働がなければ二度目は出さない
{
  const st = R.emptyState();
  run(st, at(23, 9, 0), at(23, 17, 30), true, K(23), ok(st));
  const a = R.away(st, { now: at(23, 17, 31), reason: 'lock' });
  assert.deepStrictEqual(a, { kind: 'out', key: K(23), reason: 'lock' });
  R.record(st, { kind: 'out', key: K(23), now: at(23, 17, 31), status: 'ok' });
  assert.strictEqual(R.away(st, { now: at(23, 17, 40), reason: 'suspend' }), null);
  assert.strictEqual(run(st, at(23, 17, 41), at(23, 19, 0), false, K(23)).length, 0);
}

// ---- 出勤前(出勤打刻なし)は退勤しない
{
  const st = R.emptyState();
  run(st, at(23, 9, 0), at(23, 9, 3), true, K(23));
  assert.strictEqual(R.away(st, { now: at(23, 9, 4), reason: 'lock' }), null);
}

// ---- 日付をまたぐ作業: 退勤は出勤した日のキーで
{
  const st = R.emptyState();
  run(st, at(23, 20, 0), at(23, 23, 59), true, K(23), ok(st));
  run(st, at(24, 0, 0), at(24, 1, 0), true, K(23), ok(st)); // アプリの日付は 10/23 のまま
  const a = R.away(st, { now: at(24, 1, 1), reason: 'lock' });
  assert.deepStrictEqual([a.kind, a.key], ['out', K(23)]);
}

// ---- 出勤の失敗: 1分あけて再試行、3回で打ち切り
{
  const st = R.emptyState();
  const fails = [];
  run(st, at(23, 9, 0), at(23, 9, 20), true, K(23), (a, t) => { fails.push(t); R.record(st, { kind: a.kind, key: a.key, now: t, status: 'fail', reason: 'x' }); });
  assert.strictEqual(fails.length, 3);
  assert.ok(fails[1] - fails[0] >= 60000);
  assert.ok(!R.hasIn(st, K(23)));
}

// ---- 確認できない(押せたが読み戻せない)は打刻済み扱い(二重打刻しない)
{
  const st = R.emptyState();
  const p = run(st, at(23, 9, 0), at(23, 10, 0), true, K(23), (a, t) => R.record(st, { kind: a.kind, key: a.key, now: t, status: 'unverified' }));
  assert.strictEqual(p.length, 1);
}

// ---- 退勤できないまま日が変わった日
{
  const st = R.emptyState();
  run(st, at(22, 9, 0), at(22, 19, 0), true, K(22), ok(st)); // 退勤前にアプリ終了
  const m = R.missedOuts(st, K(23));
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].key, K(22));
  assert.strictEqual(R.hm(m[0].lastActiveAt), '19:00');
  st.days[K(22)].missNotified = true;
  assert.strictEqual(R.missedOuts(st, K(23)).length, 0);
}

// ---- 14日より前は削除
{
  const st = R.emptyState();
  run(st, at(1, 9, 0), at(1, 9, 6), true, K(1), ok(st));
  R.record(st, { kind: 'out', key: K(23), now: at(23, 18, 0), status: 'ok' });
  assert.ok(!st.days[K(1)]);
}

console.log('recoruPunch tests passed');
