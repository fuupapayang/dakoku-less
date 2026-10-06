'use strict';
/**
 * 突発的な社内会議(「今日の勤務」の 社内会議 開始/終了 ボタン・トレイメニュー)
 *
 * 保存先は本人の day.calendar(ICSインポート分と同じ「個人の予定」。チーム共有カレンダーには載せない)。
 * エントリ: {id, s, e, summary, kind?:'internal', projectId?, adhoc:true, open?:true, seenAt?, credit?}
 *  - 案件を選ばない場合は kind='internal'(社内会議（案件外）)。案件を選んだ場合は projectId を持ち kind は無し
 *    (calendar.js の sanitizeInput と同じく kind と projectId は排他)。summary は「F000_社内会議」形式で案件判定が効く。
 *  - open=true の間は終了時刻を「今」とみなす(最大 MAX_MIN 分)。seenAt = 記録中に最後にサンプリングした時刻。
 *  - credit = この会議のために計上した分数 {meetingMin, min}(削除・時刻修正で差し戻すため)
 */
const calendarLib = require('./calendar');

const MIN = 60000;
/** 終了し忘れの自動終了までの時間(分) */
const MAX_MIN = 4 * 60;
/** アプリ再起動時、最後の記録からこの時間以内なら会議を継続扱いにする(アップデートの再起動など) */
const RESUME_GRACE_MIN = 10;
/** これより短い会議は記録しない(誤操作) */
const MIN_RECORD_MIN = 1;
const LABEL = '社内会議';

function isAdhoc(ev) { return !!(ev && ev.adhoc); }

/** day.calendar の中の、記録中(終了前)の社内会議 */
function openMeeting(calendar) {
  return (calendar || []).find(ev => isAdhoc(ev) && ev.open) || null;
}

/** 会議の記録上の終了時刻(記録中は now。ただし開始から MAX_MIN 分まで) */
function effectiveEnd(ev, now, maxMin = MAX_MIN) {
  if (!ev.open) return ev.e;
  return Math.max(ev.s, Math.min(now, ev.s + maxMin * MIN));
}

/** 新しい会議エントリ。project = {id, code} | null */
function createMeeting(now, project) {
  const ev = {
    id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    s: now, e: now, adhoc: true, open: true, seenAt: now,
    credit: { meetingMin: 0, min: 0 }
  };
  if (project && project.id) {
    ev.projectId = project.id;
    ev.summary = (project.code ? project.code + '_' : '') + LABEL;
  } else {
    ev.kind = 'internal';
    ev.summary = calendarLib.kindLabel('internal');
  }
  return ev;
}

/**
 * エンジン/判定用の予定一覧: 記録中の会議は終了=now に置き換えたコピーを返す(元データは変更しない)。
 * lookaheadMs: 「今まさに会議中か」(s <= now < e)の判定が時刻のわずかなずれで外れないよう、終了を少し先にする
 */
function forEngine(calendar, now, maxMin = MAX_MIN, lookaheadMs = 0) {
  return (calendar || []).map(ev => isAdhoc(ev) && ev.open
    ? { ...ev, e: Math.min(effectiveEnd(ev, now, maxMin) + lookaheadMs, ev.s + maxMin * MIN) } : ev);
}

/**
 * 会議の時間帯のうち、PC稼働の範囲(最初の稼働〜最後の稼働)の外側にはみ出す部分。
 * 推定エンジンに稼働区間として足すことで、会議から直帰した日・会議中に始業した日も会議を勤務に含める。
 * (範囲内の空白は予定との突合で「会議: …」として稼働扱いになるため、ここでは足さない)
 */
function extraIntervals(spans, intervals) {
  const ivs = (intervals || []).filter(iv => iv.e > iv.s);
  const out = [];
  if (!ivs.length) {
    for (const sp of spans || []) if (sp.e > sp.s) out.push({ s: sp.s, e: sp.e });
    return out;
  }
  const lo = Math.min(...ivs.map(iv => iv.s)), hi = Math.max(...ivs.map(iv => iv.e));
  for (const sp of spans || []) {
    if (!(sp.e > sp.s)) continue;
    if (sp.s < lo) out.push({ s: sp.s, e: Math.min(sp.e, lo) });
    if (sp.e > hi) out.push({ s: Math.max(sp.s, hi), e: sp.e });
  }
  return out;
}

/** 日付キーの勤務日の範囲 [start, end)(dayStartHour 時で区切る) */
function dayBounds(key, dayStartHour = 4) {
  const [y, m, d] = key.split('-').map(Number);
  return { start: new Date(y, m - 1, d, dayStartHour).getTime(), end: new Date(y, m - 1, d + 1, dayStartHour).getTime() };
}

/**
 * 終了し忘れた会議(日付変更・アプリ再起動)の「もっともらしい終了時刻」
 * = min(開始+MAX_MIN, 最後の記録(seenAt)・最後のPC稼働の遅い方, 勤務日の終わり)
 */
function plausibleEnd(ev, intervals, dayEnd, maxMin = MAX_MIN) {
  const lastAct = Math.max(0, ...(intervals || []).filter(iv => iv.e > ev.s).map(iv => iv.e));
  const seen = Math.max(ev.seenAt || 0, lastAct);
  let end = Math.min(ev.s + maxMin * MIN, seen || ev.s, dayEnd || Infinity);
  if (!Number.isFinite(end) || end < ev.s) end = ev.s;
  return end;
}

/** 記録に残す長さか */
function recordable(s, e) { return e - s >= MIN_RECORD_MIN * MIN; }

/**
 * 時刻修正の検証。sMin/eMin は勤務日の0時からの分(日付をまたぐ深夜は 24*60 以上も可)。
 * @returns {s,e} もしくは {error}
 */
function validateEdit(key, sMin, eMin, now, dayStartHour = 4) {
  sMin = Math.round(Number(sMin)); eMin = Math.round(Number(eMin));
  if (!Number.isFinite(sMin) || !Number.isFinite(eMin)) return { error: '時刻が不正です' };
  const [y, m, d] = key.split('-').map(Number);
  const base = new Date(y, m - 1, d).getTime();
  const s = base + sMin * MIN, e = base + eMin * MIN;
  const b = dayBounds(key, dayStartHour);
  if (e <= s) return { error: '終了は開始より後にしてください' };
  if (!recordable(s, e)) return { error: `${MIN_RECORD_MIN}分以上にしてください` };
  if (s < b.start || e > b.end) return { error: 'その日の勤務時間帯の中で指定してください' };
  if (e > now + MIN) return { error: '終了をこれから先の時刻にはできません' };
  return { s, e };
}

module.exports = {
  MAX_MIN, RESUME_GRACE_MIN, MIN_RECORD_MIN, LABEL,
  isAdhoc, openMeeting, effectiveEnd, createMeeting, forEngine, extraIntervals,
  dayBounds, plausibleEnd, recordable, validateEdit
};
