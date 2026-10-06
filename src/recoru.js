'use strict';
/**
 * レコル(RecoRu)連携用の勤怠変換。
 * レコルの勤務表の列(日付/勤務区分/開始/終了/休憩時間/…/メモ)に合わせて行を作る。
 * 取込CSVは「入力列」だけを出力し、残業・深夜などの集計はレコル側の計算に任せる。
 * 確認用に、レコルの集計列を同じルールで試算する関数(summarize)も持つ。
 *
 * 前提(画面からの類推。就業規則と違う場合は定数を調整):
 *  - 所定労働 8時間/日(9月の所定時間 152:00 = 19日 × 8h)
 *  - 土曜・祝日 = 所定休日、日曜 = 法定休日
 *  - 深夜 = 22:00〜翌5:00
 */
const MIN = 60000;
const SCHEDULED_MIN = 480;

// 内閣府「国民の祝日」(振替休日・国民の休日を含む)
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29',
  '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23',
  '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22',
  '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11',
  '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03', '2027-11-23'
]);

function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** 'work' | 'scheduledHoliday'(土・祝) | 'legalHoliday'(日) */
function dayType(key) {
  const wd = weekdayOf(key);
  if (wd === 0) return 'legalHoliday';
  if (wd === 6 || HOLIDAYS.has(key)) return 'scheduledHoliday';
  return 'work';
}

const KUBUN = { work: '出勤', scheduledHoliday: '所定休日出勤', legalHoliday: '法定休日出勤' };

/** 日付キーの0時から見た時刻を HH:MM で(翌日にまたがる場合は 25:30 のように24時超え表記) */
function clock(key, ts) {
  const [y, m, d] = key.split('-').map(Number);
  const min = Math.round((ts - new Date(y, m - 1, d).getTime()) / MIN);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function hhmm(min) {
  min = Math.max(0, Math.round(min || 0));
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * 確認が必要な理由(自動提出・レコル取込の前に人が見るべき日)
 * @param est {start,end,workMin}
 */
function reviewReasons(key, est, { longMin = 720 } = {}) {
  const r = [];
  if (!est || est.start == null) return r;
  const t = dayType(key);
  if (t !== 'work') r.push(HOLIDAYS.has(key) ? '祝日の稼働' : '休日の稼働');
  if ((est.workMin || 0) >= longMin) r.push(`実働${Math.floor(longMin / 60)}時間以上`);
  return r;
}

/** 深夜(22:00〜翌5:00)に含まれる稼働分数。breaksを除いた [start,end] と深夜帯の重なり */
function nightMin(key, est) {
  if (!est || est.start == null) return 0;
  const [y, m, d] = key.split('-').map(Number);
  const base = new Date(y, m - 1, d).getTime();
  const nights = [[base - 2 * 3600000, base + 5 * 3600000], [base + 22 * 3600000, base + 29 * 3600000]];
  const ov = (s1, e1, s2, e2) => Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
  let ms = 0;
  for (const [ns, ne] of nights) {
    ms += ov(est.start, est.end, ns, ne);
    for (const b of est.breaks || []) ms -= ov(Math.max(b.s, est.start), Math.min(b.e, est.end), ns, ne);
  }
  return Math.max(0, Math.round(ms / MIN));
}

const IMPORT_HEADERS = ['名前', 'ユーザID', '日付', '勤務区分', '開始', '終了', '休憩時間', 'メモ'];

/** 取込用の1行。ユーザIDが空の場合は管理者が気付けるようメモに「ユーザID未設定」を付ける */
function importRow(name, uid, key, est, memo = '') {
  uid = String(uid || '').trim();
  if (!uid) memo = [memo, 'ユーザID未設定'].filter(Boolean).join(' / ');
  return [name || '', uid, key.replace(/-/g, '/'), KUBUN[dayType(key)], clock(key, est.start), clock(key, est.end), hhmm(est.breakMin), memo];
}

/** 確認用: レコルの集計列を試算 */
const SUMMARY_HEADERS = ['日付', '曜日', '勤務区分', '開始', '終了', '休憩時間', '所定時間', '所定不足時間', '労働時間', '実労働時間',
  '法定内残業', '法定外残業', '深夜', '所定休日', '所定休日深夜', '法定休日', '法定休日深夜', 'メモ'];
function summarize(key, est, memo = '') {
  const t = dayType(key);
  const work = est.workMin || 0;
  const night = nightMin(key, est);
  const isWork = t === 'work';
  return [
    key.replace(/-/g, '/'), '日月火水木金土'[weekdayOf(key)], KUBUN[t],
    clock(key, est.start), clock(key, est.end), hhmm(est.breakMin),
    isWork ? hhmm(SCHEDULED_MIN) : '00:00',
    isWork ? hhmm(Math.max(0, SCHEDULED_MIN - work)) : '00:00',
    hhmm(work), hhmm(work),
    '00:00', // 所定8h=法定8hのため法定内残業は発生しない
    isWork ? hhmm(Math.max(0, work - SCHEDULED_MIN)) : '00:00',
    isWork ? hhmm(night) : '00:00',
    t === 'scheduledHoliday' ? hhmm(work) : '00:00',
    t === 'scheduledHoliday' ? hhmm(night) : '00:00',
    t === 'legalHoliday' ? hhmm(work) : '00:00',
    t === 'legalHoliday' ? hhmm(night) : '00:00',
    memo
  ];
}

/**
 * 集計に使う値。実働を30分以上増やす本人修正は、総管理者が承認するまで推定値(PCログ)を使う。
 */
function recordOf(d) {
  if (!d) return null;
  // 同期サマリー形式(start/end/workMinが修正後の値、estWorkMinが推定値)
  if (d.needsApproval && d.status !== 'approved') return { ...d, workMin: d.estWorkMin || 0 };
  if (d.submitted && d.submitted.needsApproval && d.status !== 'approved') return d.estimation || d.submitted;
  return d.submitted || d.correction || d.estimation || d;
}

/**
 * 当月の残業(みなし残業の消化状況)。
 *  残業 = 平日の8時間超 + 所定休日(土・祝)の労働。法定休日(日)の労働は「休日労働」として別集計。
 *  月末予測 = ここまでの残業 ÷ 経過日数 × 月の日数(単純な日割りペース)
 * @param days {key: day} (submitted/correction/estimation を持つ day、または同期サマリー)
 * @param ym 'YYYY-MM'  @param todayKey 'YYYY-MM-DD'
 */
function monthOvertime(days, ym, todayKey) {
  let overtime = 0, legalHoliday = 0;
  for (const [k, d] of Object.entries(days || {})) {
    if (k.slice(0, 7) !== ym) continue;
    const est = recordOf(d);
    if (!est || est.start == null) continue;
    const w = est.workMin || 0;
    const t = dayType(k);
    if (t === 'work') overtime += Math.max(0, w - SCHEDULED_MIN);
    else if (t === 'scheduledHoliday') overtime += w;
    else legalHoliday += w;
  }
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const elapsed = todayKey.slice(0, 7) === ym ? Number(todayKey.slice(8, 10)) : daysInMonth;
  const forecast = elapsed ? Math.round(overtime / elapsed * daysInMonth) : overtime;
  return { overtimeMin: Math.round(overtime), legalHolidayMin: Math.round(legalHoliday), forecastMin: forecast, elapsed, daysInMonth };
}

/** みなし残業に対する段階: ok / pace(月末予測が超過) / warn(80%以上) / over(超過) */
function overtimeLevel(ot, limitMin) {
  if (ot.overtimeMin >= limitMin) return 'over';
  if (ot.overtimeMin >= limitMin * 0.8) return 'warn';
  if (ot.forecastMin >= limitMin && ot.elapsed >= 5) return 'pace';
  return 'ok';
}

/** +01:30 / -00:15 のような符号付き HH:MM */
function signedHhmm(min) {
  min = Math.round(min || 0);
  return (min > 0 ? '+' : min < 0 ? '-' : '') + hhmm(Math.abs(min));
}

/**
 * 勤怠履歴CSV(履歴タブの「CSVダウンロード」)。
 * 値は集計と同じ扱い: 提出済み・承認済みの日は recordOf(実働を30分以上増やす修正は承認まで推定値)。
 * 未提出・差し戻しの日は画面と同じ修正値(なければ推定値)だが、30分以上増やす修正は推定値で出し、修正値は別列に出す。
 */
const HISTORY_HEADERS = ['日付', '曜日', '区分', '始業', '終業', '休憩', '実働', '残業', '会議', '私用除外',
  '社内会議（案件外）', '撮影・ロケハン', '状態', '本人修正', '修正後(承認待ち)', '備考'];

/** @returns {rec, pending, note, delta} rec=出力する値 / pending=承認待ちの修正値(なければnull) */
function historyRecord(d) {
  if (!d) return { rec: null, pending: null, note: '', delta: 0 };
  const delta = d.correction && d.estimation ? Math.round((d.correction.workMin || 0) - (d.estimation.workMin || 0)) : 0;
  if (d.status === 'submitted' || d.status === 'approved') {
    const pend = !!(d.submitted && d.submitted.needsApproval && d.status !== 'approved');
    return { rec: recordOf(d), pending: pend ? d.submitted : null, note: pend ? '承認待ち(承認までは推定値)' : '', delta };
  }
  if (delta >= 30) {
    return { rec: d.estimation, pending: d.correction, note: '実働を30分以上増やす修正(提出後に承認が必要・承認までは推定値)', delta };
  }
  return { rec: d.correction || d.estimation, pending: null, note: '', delta };
}

/**
 * @param days {key: day}  @param from/to 'YYYY-MM-DD'(空なら制限なし)
 * @param statusLabel 状態コード → 表示名
 * @returns 行の配列(ヘッダーは含まない。記録のない日は出力しない)
 */
function historyRows(days, { from = '', to = '', statusLabel = {} } = {}) {
  const rows = [];
  for (const k of Object.keys(days || {}).sort()) {
    if ((from && k < from) || (to && k > to)) continue;
    const d = days[k];
    const { rec, pending, note, delta } = historyRecord(d);
    if (!rec || rec.start == null) continue;
    const t = dayType(k);
    const w = Math.round(rec.workMin || 0);
    // 残業は monthOvertime と同じ: 平日は8h超、所定休日(土・祝)は全部、法定休日(日)は休日労働のため0
    const overtime = t === 'work' ? Math.max(0, w - SCHEDULED_MIN) : t === 'scheduledHoliday' ? w : 0;
    const cat = d.categoryMin || {};
    const notes = [];
    if ((d.reviewReasons || []).length && (d.status === 'pending' || d.status === 'rejected')) notes.push('要確認: ' + d.reviewReasons.join('・'));
    if (note) notes.push(note);
    rows.push([
      k.replace(/-/g, '/'), '日月火水木金土'[weekdayOf(k)], KUBUN[t],
      clock(k, rec.start), clock(k, rec.end), hhmm(rec.breakMin), hhmm(w), hhmm(overtime),
      hhmm(d.meetingMin), hhmm(d.privateMin), hhmm(cat.internal), hhmm(cat.shoot),
      statusLabel[d.status] || d.status || '',
      d.correction && d.estimation ? signedHhmm(delta) : '',
      pending && pending.start != null ? `${clock(k, pending.start)}〜${clock(k, pending.end)} 休憩${hhmm(pending.breakMin)} 実働${hhmm(pending.workMin)}` : '',
      notes.join(' / ')
    ]);
  }
  return rows;
}

function toCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  HOLIDAYS, SCHEDULED_MIN, KUBUN, IMPORT_HEADERS, SUMMARY_HEADERS, HISTORY_HEADERS,
  dayType, clock, hhmm, signedHhmm, reviewReasons, nightMin, importRow, summarize, toCSV, monthOvertime, overtimeLevel, recordOf,
  historyRecord, historyRows
};
