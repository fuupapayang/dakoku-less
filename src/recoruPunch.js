'use strict';
/**
 * レコルへのリアルタイム打刻(出勤・退勤)の判定。純粋なロジックのみ(実際の打刻は src/recoruBot.js)。
 *
 * レコルで本人が勤務表を編集できない(打刻のみの)運用向け。時刻はさかのぼれないため、その時点で打刻する。
 *  - 出勤: その日(朝5時区切り)の最初の操作の瞬間
 *  - 5:00〜0:00: ロック・スリープ・無操作では退勤しない(自宅作業で頻繁にあるため)。
 *          シャットダウン時に「退勤を打刻しますか？」を出して選んでもらう
 *  - 0:00〜5:00: 1時間おきに「深夜残業となりますが作業を続けますか？」を出す。
 *          「いいえ」→退勤 / 30分答えがない→退勤 / 30分操作がない→退勤(0時の時点で既に30分操作がなければ0時に退勤)。
 *          シャットダウン時は確認を出す
 *  - 休憩は打刻しない
 *
 * 状態 st (settings.recoruPunch) = {
 *   days: { 'YYYY-MM-DD': { in, outs:[rec], lastActiveAt, needOut, outFail, promptAt, promptOpen } },
 *   lastKey
 * }  rec = { at, status: 'ok'|'unverified'|'fail', reason, rk }
 */
const MIN = 60000;
const DAY_START_HOUR = 5;   // 打刻の日付の区切り
const LATE_HOUR = 22;       // 22時以降はロック・スリープで退勤しない
const IDLE_MIN = 30;        // 深夜(0〜5時)にこの分数操作がなければ退勤(夜に作業を終えてPCを放置した場合は0時に退勤)
const PROMPT_EVERY_MIN = 60;
const PROMPT_WAIT_MIN = 30;
const KEEP_DAYS = 14;

const pad = (n) => String(n).padStart(2, '0');
function calKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function hm(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
/** 打刻の日付(朝5時区切り) */
function punchKey(ts) { return calKey(ts - DAY_START_HOUR * 60 * MIN); }
/** 'day' 5〜22時 / 'late' 22〜24時 / 'night' 0〜5時 */
function period(ts) {
  const h = new Date(ts).getHours();
  return h >= DAY_START_HOUR && h < LATE_HOUR ? 'day' : h >= LATE_HOUR ? 'late' : 'night';
}

function emptyState() { return { days: {}, lastKey: '' }; }
function norm(st) {
  st = st && typeof st === 'object' ? st : emptyState();
  if (!st.days || typeof st.days !== 'object') st.days = {};
  return st;
}
function dayOf(st, key) { return (st.days[key] = st.days[key] || { in: null, outs: [], lastActiveAt: 0, needOut: false }); }
const done = (rec) => !!(rec && (rec.status === 'ok' || rec.status === 'unverified'));
function hasIn(st, key) { return done(st.days[key] && st.days[key].in); }

/**
 * 失敗した打刻の再試行: 1分あけて3回まで・最初の失敗から10分まで。
 * それ以降は時刻がずれるため打刻せず、手動で打刻してもらう(通知済み)。
 */
function canRetry(rec, now) {
  if (!rec) return true;
  if (done(rec) || rec.status === 'declined') return false; // declined: 休日の確認で「打刻しない」を選んだ
  return (rec.tries || 1) < 3 && now - (rec.firstAt || rec.at) <= 10 * MIN && now - rec.at >= MIN;
}
const failRec = (prev, now) => prev && prev.status === 'fail'
  ? { tries: (prev.tries || 1) + 1, firstAt: prev.firstAt || prev.at }
  : { tries: 1, firstAt: now };

/** 出勤済みで、その後の操作の退勤をまだ打刻していない日(最後に操作した日) */
function openDay(st) {
  const k = st.lastKey;
  const d = k && st.days[k];
  return d && hasIn(st, k) && d.needOut ? { k, d } : null;
}

/**
 * サンプリング(15秒ごと)の判定。st を更新し、すべきことを返す:
 *  {kind:'in'|'out', key, reason} 打刻 / {kind:'prompt', key} 深夜の確認を出す / null
 * @param o.active 稼働(私用判定を除いた操作あり)  @param o.inFlight 打刻処理中
 */
function tick(st, { now, active, inFlight = false }) {
  st = norm(st);
  if (inFlight) { if (active) touch(st, now); return null; }
  // 深夜の確認に30分答えがない → 退勤(操作の有無に関係なく)
  const o = openDay(st);
  if (o && o.d.promptOpen && now - o.d.promptAt >= PROMPT_WAIT_MIN * MIN && canRetry(o.d.outFail, now)) {
    return { kind: 'out', key: o.k, reason: 'noanswer' };
  }
  if (active) {
    const key = touch(st, now);
    const d = st.days[key];
    if (!hasIn(st, key) && canRetry(d.in, now)) return { kind: 'in', key };
    // 深夜(0〜5時)は1時間おきに確認
    if (period(now) === 'night' && hasIn(st, key) && !d.promptOpen && (!d.promptAt || now - d.promptAt >= PROMPT_EVERY_MIN * MIN)) {
      return { kind: 'prompt', key };
    }
    return null;
  }
  if (!o || !canRetry(o.d.outFail, now)) return null;
  const idle = now - o.d.lastActiveAt >= IDLE_MIN * MIN;
  const p = period(now);
  if (idle && p === 'night') {
    return { kind: 'out', key: o.k, reason: 'idle' };
  }
  return null;
}

/** 操作を記録。打刻の日付キーを返す */
function touch(st, now) {
  const key = punchKey(now);
  const d = dayOf(st, key);
  d.lastActiveAt = now;
  if (hasIn(st, key) && !d.needOut) { d.needOut = true; d.outFail = null; } // 再び操作したら、次に離れた時の退勤を打刻し直す
  st.lastKey = key;
  return key;
}

/**
 * 画面ロック・スリープ・シャットダウン。
 *  {kind:'confirm'} シャットダウン時に退勤するか確認 / null(ロック・スリープでは退勤しない)
 */
function away(st, { now, reason }) {
  st = norm(st);
  const o = openDay(st);
  if (!o || !canRetry(o.d.outFail, now)) return null;
  return reason === 'shutdown' ? { kind: 'confirm', key: o.k, reason } : null;
}

/** 深夜の確認を出した */
function promptShown(st, { key, now }) {
  const d = dayOf(norm(st), key);
  d.promptAt = now;
  d.promptOpen = true;
  return st;
}
/** 深夜の確認への答え。'no' なら退勤する({kind:'out'})。'yes' は続行 */
function promptAnswer(st, { key, now, answer }) {
  st = norm(st);
  const d = st.days[key];
  if (!d) return null;
  d.promptOpen = false;
  if (answer === 'yes') { d.promptAt = now; return null; }
  return hasIn(st, key) ? { kind: 'out', key, reason: 'answer' } : null;
}

/** 打刻結果を記録 */
function record(st, { kind, key, now, status, reason = '', rk = null }) {
  st = norm(st);
  const d = dayOf(st, key);
  const rec = { at: now, status, reason, rk };
  if (kind === 'in') {
    if (status === 'fail') Object.assign(rec, failRec(d.in, now));
    d.in = rec;
    if (done(rec)) { d.needOut = true; if (!st.lastKey || st.lastKey < key) st.lastKey = key; }
  } else {
    d.outs = [...(d.outs || []), rec].slice(-20);
    if (done(rec)) { d.needOut = false; d.outFail = null; d.promptOpen = false; }
    else d.outFail = { at: now, status: 'fail', ...failRec(d.outFail, now) };
  }
  prune(st, now);
  return st;
}

function prune(st, now) {
  const from = calKey(now - KEEP_DAYS * 24 * 60 * MIN);
  for (const k of Object.keys(st.days)) if (k < from) delete st.days[k];
}

/** 退勤を打刻できないまま日が変わった日(電源断・夜間のスリープなど)。通知して修正を申請してもらう */
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
    const last = okOuts[okOuts.length - 1];
    return {
      key: k,
      in: d.in ? { time: hm(d.in.at), status: d.in.status, reason: d.in.reason || '' } : null,
      out: last ? { time: hm(last.at), status: last.status, count: okOuts.length } : null,
      lastFail: [...(d.outs || [])].reverse().find(r => r.status === 'fail') || null,
      needOut: !!d.needOut
    };
  });
}

module.exports = {
  DAY_START_HOUR, LATE_HOUR, IDLE_MIN, PROMPT_EVERY_MIN, PROMPT_WAIT_MIN,
  calKey, hm, punchKey, period, emptyState, tick, away, promptShown, promptAnswer, record, missedOuts, summary, hasIn
};
