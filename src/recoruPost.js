'use strict';
/**
 * レコル(RecoRu)への自動転記: 画面操作を伴わない純粋なロジック。
 *  - 転記候補の日の選び方 / レコルに入れる値の組み立て(24時超えは hour−24)
 *  - 保存後の読み戻し値の検証(±2分の許容、レコル規定による休憩の自動調整)
 *  - 転記の確認を出すタイミング(起動・復帰・毎日の時刻)
 * ブラウザ操作は src/recoruBot.js、Electron との接続は main.js。
 */
const R = require('./recoru');

const MIN = 60000;
const MAX_DAYS = 7;
const TOLERANCE_MIN = 2;
const DEBOUNCE_MS = 60 * 1000;
const LOG_MAX = 20;

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' を n 日ずらす */
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** 'H:MM' / 'HH:MM' / '25:30' → 分。読めなければ null */
function parseHM(s) {
  const m = String(s == null ? '' : s).match(/(\d{1,3})\s*[:：]\s*(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分 → 'HH:MM'(24時超えはそのまま 25:30 表記) */
function fmtHM(min) {
  min = Math.max(0, Math.round(min || 0));
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** レコルに入力する時刻。24:00以降は hour−24(25:37 → 01:37。終了 < 開始 はレコルが翌日として扱う) */
function toRecoruTime(v) {
  const min = typeof v === 'number' ? Math.round(v) : parseHM(v);
  if (min == null) return '';
  return fmtHM(((min % 1440) + 1440) % 1440);
}

/** 日付キーの0時から見た分(clock() と同じ丸め) */
function minOfDay(key, ts) {
  const [y, m, d] = key.split('-').map(Number);
  return Math.round((ts - new Date(y, m - 1, d).getTime()) / MIN);
}

/** 転記済みとして扱う記録(成功・スキップ・保存済みだが要確認)。失敗は次回やり直す */
function isDone(p) { return !!(p && (p.ok || p.skipped || p.saved)); }

/**
 * 転記候補の日(古い順)。今日より前・直近 maxDays 日以内・記録がある・まだ転記していない日。
 * @param days {key: day}  @param todayKey engine.dayKey の今日  @param posted settings().recoruPosted
 */
function candidateKeys(days, todayKey, posted = {}, { maxDays = MAX_DAYS } = {}) {
  const from = addDays(todayKey, -maxDays);
  return Object.keys(days || {}).filter(k => {
    if (k >= todayKey || k < from) return false;
    const d = days[k];
    if (!d || d.status === 'recording') return false;
    const { rec } = R.historyRecord(d);
    if (!rec || rec.start == null || rec.end == null) return false;
    return !isDone(posted && posted[k]);
  }).sort();
}

/** 休憩区間を [開始,終了] 内に切り詰め・分単位に丸め・重なり/隣接を結合(分の配列) */
function normBreaks(key, breaks, startMin, endMin) {
  const list = (breaks || [])
    .map(b => ({ s: Math.max(startMin, minOfDay(key, b.s)), e: Math.min(endMin, minOfDay(key, b.e)) }))
    .filter(b => b.e - b.s >= 1)
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else out.push({ ...b });
  }
  return out;
}

/**
 * 1日分のレコル入力値。
 * @returns {key, start, end, startIn, endIn, breaks:[{s,e,sIn,eIn}], breakMin, workMin, breaksUnknown, notes[], error}
 *   start/end/s/e = 表示用(24時超え表記) / *In = レコルに入力する値(hour−24)
 *   記録がない日は null
 */
function dayValues(key, d) {
  const { rec, note } = R.historyRecord(d);
  if (!rec || rec.start == null || rec.end == null) return null;
  const notes = [];
  if (d.status === 'rejected') notes.push('差し戻し');
  if ((d.reviewReasons || []).length && (d.status === 'pending' || d.status === 'rejected')) notes.push('要確認: ' + d.reviewReasons.join('・'));
  if (note) notes.push(note);
  const startMin = minOfDay(key, rec.start), endMin = minOfDay(key, rec.end);
  let error = '';
  if (startMin < 0 || startMin >= 1440) error = '開始が日付の範囲外のため自動入力できません(レコルで手入力してください)';
  else if (endMin <= startMin) error = '終了が開始より前です';
  else if (endMin - startMin >= 1440) error = '24時間以上の勤務は自動入力できません';
  const raw = R.breaksOf(d, rec);
  const breaksUnknown = raw == null;
  if (breaksUnknown) notes.push('休憩区間不明(休憩なしで転記・レコルの規定で補正される場合があります)');
  const br = breaksUnknown ? [] : normBreaks(key, raw, startMin, endMin);
  const breakMin = br.reduce((a, b) => a + (b.e - b.s), 0);
  return {
    key,
    start: fmtHM(startMin), end: fmtHM(endMin),
    startIn: toRecoruTime(startMin), endIn: toRecoruTime(endMin),
    spanMin: endMin - startMin,
    breaks: br.map(b => ({ s: fmtHM(b.s), e: fmtHM(b.e), sIn: toRecoruTime(b.s), eIn: toRecoruTime(b.e) })),
    breakMin,
    workMin: endMin - startMin - breakMin, // レコルが入力値から計算する実働と同じ式
    appWorkMin: Math.round(rec.workMin || 0),
    breaksUnknown, notes, error
  };
}

/**
 * 勤務表の日付セル(例 "10/20(火)" "20日(火)")が対象日か。数字に日が含まれ、月らしき数字があれば月も一致すること
 */
function rowDateMatches(text, m, d) {
  const nums = (String(text || '').match(/\d+/g) || []).map(Number);
  if (!nums.includes(d)) return false;
  const small = nums.filter(n => n >= 1 && n <= 31);
  if (small.length >= 2) return small.includes(m);
  return true;
}

/**
 * 保存後に読み戻した行の検証。
 * @param exp dayValues の結果  @param act {start, end, breakText, workText}(レコルの表示値)
 * @returns {ok, adjusted, issues[], rk:{start,end,break,work}}
 *   adjusted = レコルの規定で休憩が増えた(失敗ではない)
 */
function verifyRow(exp, act, tol = TOLERANCE_MIN) {
  const issues = [];
  const near = (a, b) => a != null && b != null && Math.abs(a - b) <= tol;
  const aS = parseHM(act && act.start), aE = parseHM(act && act.end);
  // 休憩セルが空欄(数字なし)は 0 分として扱う
  const bt = String((act && act.breakText) || '');
  const aB = parseHM(bt) != null ? parseHM(bt) : (/\d/.test(bt) ? null : 0);
  const aW = parseHM(act && act.workText);
  if (aS == null) issues.push('開始が保存されていません');
  else if (!near(aS, parseHM(exp.startIn))) issues.push(`開始が違います(レコル ${fmtHM(aS)} / 期待 ${exp.startIn})`);
  if (aE == null) issues.push('終了が保存されていません');
  else if (!near(aE, parseHM(exp.endIn))) issues.push(`終了が違います(レコル ${fmtHM(aE)} / 期待 ${exp.endIn})`);
  let adjusted = false;
  let expWork = exp.workMin;
  if (aB == null) issues.push('休憩時間を読み取れません');
  else if (!near(aB, exp.breakMin)) {
    if (aB > exp.breakMin) { adjusted = true; expWork = exp.spanMin - aB; }
    else issues.push(`休憩が少なく保存されました(レコル ${fmtHM(aB)} / 期待 ${fmtHM(exp.breakMin)})`);
  }
  if (aW == null) issues.push('労働時間を読み取れません');
  else if (!near(aW, expWork)) issues.push(`労働時間が違います(レコル ${fmtHM(aW)} / 期待 ${fmtHM(expWork)})`);
  return {
    ok: issues.length === 0, adjusted, issues,
    rk: { start: aS == null ? '' : fmtHM(aS), end: aE == null ? '' : fmtHM(aE), break: aB == null ? '' : fmtHM(aB), work: aW == null ? '' : fmtHM(aW) }
  };
}

/** 端末のローカル日付 'YYYY-MM-DD' と 0時からの分 */
function localDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localMin(ts) { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); }

/**
 * 転記の確認を出すか。
 * @param reason 'start'(起動30秒後) | 'resume' | 'unlock' | 'tick'(毎分)
 * @param st {lastAt, timeFiredDate} 前回の状態(メモリ)
 * @returns {fire, st} st = 次の状態
 *  - start: 常に出す / resume・unlock: 前回から1分以上空いていれば出す
 *  - tick: 毎日の時刻(postTime)を過ぎていて、今日まだ時刻以降に出していなければ出す
 *  - 時刻以降に(理由を問わず)出したら、その日の tick は出さない
 */
function triggerDecision(reason, now, st = {}, { postTime = '09:30', debounceMs = DEBOUNCE_MS } = {}) {
  st = { lastAt: 0, timeFiredDate: '', ...st };
  const date = localDate(now);
  const t = parseHM(postTime);
  const pastTime = t != null && localMin(now) >= t;
  let fire = false;
  if (reason === 'start') fire = true;
  else if (reason === 'resume' || reason === 'unlock') fire = !st.lastAt || now - st.lastAt >= debounceMs;
  else if (reason === 'tick') fire = pastTime && st.timeFiredDate !== date;
  if (!fire) return { fire, st };
  return { fire, st: { lastAt: now, timeFiredDate: pastTime ? date : st.timeFiredDate } };
}

/** 最後に転記できた日(成功のみ) */
function lastOkDay(posted) {
  return Object.keys(posted || {}).filter(k => posted[k] && posted[k].ok).sort().pop() || '';
}

/** 結果を転記記録に反映(古い記録は keepDays 日で削除)。posted を直接更新して返す */
function applyResults(posted, results, now, { todayKey, keepDays = 62 } = {}) {
  posted = posted || {};
  for (const r of results) {
    posted[r.key] = {
      at: now, ok: r.status === 'ok', skipped: r.status === 'skip', saved: !!r.saved,
      reason: r.reason || '', adjusted: !!r.adjusted, rk: r.rk ? { break: r.rk.break || '', work: r.rk.work || '' } : null
    };
  }
  if (todayKey) {
    const from = addDays(todayKey, -keepDays);
    for (const k of Object.keys(posted)) if (k < from) delete posted[k];
  }
  return posted;
}

/** 直近の結果ログ(新しい順・最大 max 件) */
function appendLog(log, results, now, max = LOG_MAX) {
  const add = results.map(r => ({ at: now, key: r.key, status: r.status, reason: r.reason || '', adjusted: !!r.adjusted,
    rk: r.rk ? { break: r.rk.break || '', work: r.rk.work || '' } : null }));
  return [...add.reverse(), ...(log || [])].slice(0, max);
}

/** 結果の一言まとめ */
function summaryText(results) {
  const n = (s) => results.filter(r => r.status === s).length;
  const parts = [];
  if (n('ok')) parts.push(`${n('ok')}日転記`);
  if (n('skip')) parts.push(`${n('skip')}日スキップ`);
  if (n('fail')) parts.push(`${n('fail')}日失敗`);
  return parts.join('・') || '対象なし';
}

module.exports = {
  MAX_DAYS, TOLERANCE_MIN, DEBOUNCE_MS, LOG_MAX,
  addDays, parseHM, fmtHM, toRecoruTime, minOfDay, isDone, candidateKeys, normBreaks, dayValues,
  rowDateMatches, verifyRow, triggerDecision, lastOkDay, applyResults, appendLog, summaryText
};
