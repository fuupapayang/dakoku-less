'use strict';
/**
 * レコルへのリアルタイム打刻(出勤・退勤)の判定。純粋なロジックのみ(実際の打刻は src/recoruBot.js)。
 *
 * レコルで本人が勤務表を編集できない(打刻のみの)運用向け。時刻はさかのぼれないため、
 * 「実際に操作を検知した時点」で打刻する:
 *  - 出勤: その日(暦日)に初めて IN_STREAK_MIN 分続けて稼働を検知した時点
 *  - 退勤: 画面ロック・スリープ・シャットダウンの時点、または OUT_IDLE_MIN 分操作がない時点。
 *          その後に稼働があれば、次に離れた時にもう一度打刻する(レコルは最後の退勤打刻を採用する前提)
 *  - 休憩は打刻しない
 *
 * 状態 st (settings.recoruPunch) = {
 *   days: { 'YYYY-MM-DD': { in: rec|null, outs: [rec], lastActiveAt, needOut } },
 *   streakStart, lastKey
 * }  rec = { at, status: 'ok'|'unverified'|'fail', reason, rk:{start,end} }
 */
const MIN = 60000;
const IN_STREAK_MIN = 5;
const OUT_IDLE_MIN = 15;
const KEEP_DAYS = 14;

const pad = (n) => String(n).padStart(2, '0');
function calKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

function emptyState() { return { days: {}, streakStart: null, lastKey: '' }; }
function norm(st) {
  st = st && typeof st === 'object' ? st : emptyState();
  if (!st.days || typeof st.days !== 'object') st.days = {};
  return st;
}
function dayOf(st, key) { return (st.days[key] = st.days[key] || { in: null, outs: [], lastActiveAt: 0, needOut: false }); }
const done = (rec) => !!(rec && (rec.status === 'ok' || rec.status === 'unverified'));
/** 出勤打刻済み(成功・確認できないが押せた)か */
function hasIn(st, key) { return done(st.days[key] && st.days[key].in); }

/**
 * サンプリング(15秒ごと)の判定。st を更新し、打刻すべきなら {kind:'in'|'out', key} を返す。
 * @param o.now  @param o.key アプリの日付キー(朝4時切替)  @param o.active 稼働(私用判定を除いた操作あり)
 * @param o.inFlight 打刻処理中(二重に出さない)
 */
function tick(st, { now, key, active, inFlight = false }) {
  st = norm(st);
  if (active) {
    if (st.streakStart == null) st.streakStart = now;
    const d = dayOf(st, key);
    d.lastActiveAt = now;
    if (hasIn(st, key)) { d.needOut = true; d.outFail = null; } // 再び稼働したら、次に離れた時の退勤を打刻し直す
    st.lastKey = key;
    // 出勤: 暦日とアプリの日付が同じ(深夜0〜4時の続きの作業では打刻しない)・連続稼働が規定分以上
    if (!inFlight && !hasIn(st, key) && key === calKey(now) && now - st.streakStart >= IN_STREAK_MIN * MIN && canRetry(d.in, now)) {
      return { kind: 'in', key };
    }
    return null;
  }
  st.streakStart = null;
  const k = st.lastKey;
  const d = k && st.days[k];
  if (!inFlight && d && hasIn(st, k) && d.needOut && now - d.lastActiveAt >= OUT_IDLE_MIN * MIN && canRetry(d.outFail, now)) return { kind: 'out', key: k, reason: 'idle' };
  return null;
}

/**
 * 失敗した打刻の再試行: 1分あけて3回まで・最初の失敗から10分まで。
 * それ以降は時刻がずれるため打刻せず、手動で打刻してもらう(通知済み)。
 */
function canRetry(rec, now) {
  if (!rec) return true;
  if (done(rec)) return false;
  return (rec.tries || 1) < 3 && now - (rec.firstAt || rec.at) <= 10 * MIN && now - rec.at >= MIN;
}
const failRec = (prev, now) => prev && prev.status === 'fail'
  ? { tries: (prev.tries || 1) + 1, firstAt: prev.firstAt || prev.at }
  : { tries: 1, firstAt: now };

/** 画面ロック・スリープ・シャットダウン: 稼働後まだ退勤を打刻していなければ退勤 */
function away(st, { now, reason }) {
  st = norm(st);
  st.streakStart = null;
  const k = st.lastKey;
  const d = k && st.days[k];
  if (d && hasIn(st, k) && d.needOut && canRetry(d.outFail, now)) return { kind: 'out', key: k, reason };
  return null;
}

/** 打刻結果を記録 */
function record(st, { kind, key, now, status, reason = '', rk = null }) {
  st = norm(st);
  const d = dayOf(st, key);
  const rec = { at: now, status, reason, rk };
  if (kind === 'in') {
    if (status === 'fail') Object.assign(rec, failRec(d.in, now));
    d.in = rec;
    if (done(rec)) d.needOut = d.lastActiveAt > now - MIN; // 出勤直後の稼働も退勤の対象
  } else {
    d.outs = [...(d.outs || []), rec].slice(-20);
    if (done(rec)) { d.needOut = false; d.outFail = null; }
    else d.outFail = { at: now, status: 'fail', ...failRec(d.outFail, now) };
  }
  prune(st, now);
  return st;
}

function prune(st, now) {
  const from = calKey(now - KEEP_DAYS * 24 * 60 * MIN);
  for (const k of Object.keys(st.days)) if (k < from) delete st.days[k];
}

/**
 * 退勤を打刻できないまま日が変わった日(アプリ終了・電源断など)。起動時・日付変更時に通知する。
 * @returns [{key, lastActiveAt}]
 */
function missedOuts(st, todayKey) {
  st = norm(st);
  return Object.entries(st.days)
    .filter(([k, d]) => k < todayKey && d && done(d.in) && d.needOut && !d.missNotified)
    .map(([k, d]) => ({ key: k, lastActiveAt: d.lastActiveAt }));
}

/** 画面用: 日ごとの打刻の要約 */
function summary(st, keys) {
  st = norm(st);
  return keys.map(k => {
    const d = st.days[k] || {};
    const okOuts = (d.outs || []).filter(done);
    return {
      key: k,
      in: d.in ? { time: hm(d.in.at), status: d.in.status, reason: d.in.reason || '' } : null,
      out: okOuts.length ? { time: hm(okOuts[okOuts.length - 1].at), status: okOuts[okOuts.length - 1].status, count: okOuts.length } : null,
      lastFail: [...(d.outs || [])].reverse().find(r => r.status === 'fail') || null,
      needOut: !!d.needOut
    };
  });
}

module.exports = { IN_STREAK_MIN, OUT_IDLE_MIN, calKey, hm, emptyState, tick, away, record, missedOuts, summary, hasIn };
