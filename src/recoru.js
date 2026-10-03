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

const IMPORT_HEADERS = ['ユーザID', '日付', '勤務区分', '開始', '終了', '休憩時間', 'メモ'];

/** 取込用の1行 */
function importRow(uid, key, est, memo = '') {
  return [uid, key.replace(/-/g, '/'), KUBUN[dayType(key)], clock(key, est.start), clock(key, est.end), hhmm(est.breakMin), memo];
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

function toCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  HOLIDAYS, SCHEDULED_MIN, KUBUN, IMPORT_HEADERS, SUMMARY_HEADERS,
  dayType, clock, hhmm, reviewReasons, nightMin, importRow, summarize, toCSV, monthOvertime, overtimeLevel, recordOf
};
