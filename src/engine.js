'use strict';
/**
 * 勤怠推定エンジン
 * PC稼働インターバル + カレンダー予定 + マイルール から
 * 始業・終業・休憩・信頼度を推定する。
 * 生ログはここを通過するだけで、永続化されるのは推定結果のみ。
 */

const MIN = 60 * 1000;

/** 日付キー(YYYY-MM-DD)。dayStartHour より前は前日扱い */
function dayKey(ts, dayStartHour = 4) {
  const d = new Date(ts - dayStartHour * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtTime(ts) {
  if (ts == null) return '--:--';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDur(min) {
  if (min == null || isNaN(min)) return '-';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** インターバル配列を正規化(ソート + gapMin 分以内のギャップは結合) */
function mergeIntervals(intervals, gapMin = 3) {
  const sorted = [...intervals].filter(iv => iv.e > iv.s).sort((a, b) => a.s - b.s);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s - last.e <= gapMin * MIN) last.e = Math.max(last.e, iv.e);
    else out.push({ s: iv.s, e: iv.e });
  }
  return out;
}

/** ts が HH:MM 窓 [fromMin, toMin) (分/日) に重なるか */
function overlapsWindow(gapS, gapE, fromMin, toMin) {
  const d = new Date(gapS);
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const winS = base + fromMin * MIN;
  const winE = base + toMin * MIN;
  return gapS < winE && gapE > winS;
}

function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 推定本体
 * @param {Object} day { intervals:[{s,e}], calendar:[{s,e,summary}] }
 * @param {Array} rules マイルール [{id,label,treatAs:'work'|'break'|'exclude',fromMin,toMin,weekday|null,enabled}]
 * @param {Object} settings { breakThresholdMin, ambiguousMin, mergeGapMin }
 * @returns {Object} estimation
 */
function estimate(day, rules = [], settings = {}) {
  const breakThreshold = settings.breakThresholdMin ?? 15; // これ以上の空白は休憩候補
  const ambiguous = settings.ambiguousMin ?? 8;            // これ以上は「微妙」な空白
  const merged = mergeIntervals(day.intervals || [], settings.mergeGapMin ?? 3);
  const calendar = day.calendar || [];
  const notes = [];
  const suggestions = [];

  if (merged.length === 0) {
    return {
      start: null, end: null, breaks: [], workMin: 0, breakMin: 0,
      confidence: 'LOW', notes: ['稼働データがありません'], suggestions: [],
      segments: [], computedAt: Date.now()
    };
  }

  const start = merged[0].s;
  const end = merged[merged.length - 1].e;
  const weekday = new Date(start).getDay();
  const activeRules = rules.filter(r => r.enabled !== false &&
    (r.weekday == null || r.weekday === weekday));

  // ギャップを分類
  const breaks = [];
  const segments = merged.map(iv => ({ s: iv.s, e: iv.e, kind: 'work', label: '稼働' }));
  let ambiguousCount = 0;

  for (let i = 0; i < merged.length - 1; i++) {
    const gapS = merged[i].e, gapE = merged[i + 1].s;
    const gapMin = (gapE - gapS) / MIN;
    if (gapMin < ambiguous) continue; // 短い空白は稼働継続とみなす

    // 1) マイルール適用(最優先)
    const rule = activeRules.find(r => overlapsWindow(gapS, gapE, r.fromMin, r.toMin));
    if (rule) {
      if (rule.treatAs === 'work') {
        segments.push({ s: gapS, e: gapE, kind: 'work', label: `稼働(ルール: ${rule.label})` });
        notes.push(`${fmtTime(gapS)}〜${fmtTime(gapE)} マイルール「${rule.label}」により稼働扱い`);
      } else {
        const kind = rule.treatAs === 'exclude' ? 'exclude' : 'break';
        breaks.push({ s: gapS, e: gapE, kind, source: `ルール: ${rule.label}` });
        segments.push({ s: gapS, e: gapE, kind, label: rule.label });
        notes.push(`${fmtTime(gapS)}〜${fmtTime(gapE)} マイルール「${rule.label}」により${kind === 'exclude' ? '対象外' : '休憩'}扱い`);
      }
      continue;
    }

    // 2) カレンダー予定との突合(会議中の無操作は稼働扱い)
    const ev = calendar.find(ev => ev.s < gapE && ev.e > gapS);
    if (ev) {
      const isTravel = /移動|外出|通院|私用/.test(ev.summary || '');
      if (isTravel) {
        breaks.push({ s: gapS, e: gapE, kind: 'exclude', source: `予定: ${ev.summary}` });
        segments.push({ s: gapS, e: gapE, kind: 'exclude', label: ev.summary });
        suggestions.push({
          type: 'rule', treatAs: 'exclude',
          fromMin: minutesOfDay(gapS), toMin: minutesOfDay(gapE), weekday,
          label: ev.summary || '移動時間',
          text: `${fmtTime(gapS)}〜${fmtTime(gapE)} は「${ev.summary}」かもしれません。稼働に含めず申請しますか？`
        });
      } else {
        segments.push({ s: gapS, e: gapE, kind: 'work', label: `会議: ${ev.summary}` });
        notes.push(`${fmtTime(gapS)}〜${fmtTime(gapE)} カレンダー予定「${ev.summary}」により稼働扱い`);
      }
      continue;
    }

    // 3) ヒューリスティック
    if (gapMin >= breakThreshold) {
      const mid = minutesOfDay(gapS);
      const isLunch = mid >= 11 * 60 && mid <= 14 * 60;
      breaks.push({ s: gapS, e: gapE, kind: 'break', source: isLunch ? '操作の空白(昼休憩と判定)' : '操作の空白' });
      segments.push({ s: gapS, e: gapE, kind: 'break', label: '休憩' });
      if (!isLunch && gapMin < 45) ambiguousCount++;
    } else {
      ambiguousCount++;
      segments.push({ s: gapS, e: gapE, kind: 'ambiguous', label: '判定が微妙な空白' });
      notes.push(`${fmtTime(gapS)}〜${fmtTime(gapE)} の空白(${Math.round(gapMin)}分)は稼働として扱いました`);
    }
  }

  segments.sort((a, b) => a.s - b.s);
  const breakMin = breaks.reduce((a, b) => a + (b.e - b.s) / MIN, 0);
  const workMin = Math.max(0, (end - start) / MIN - breakMin);

  // 信頼度判定
  let confidence = 'STABLE';
  if (workMin < 60) confidence = 'LOW';
  else if (ambiguousCount >= 2) confidence = 'UNSURE';
  else if (ambiguousCount === 1) confidence = 'UNSURE';
  if (merged.length === 1 && workMin > 12 * 60) confidence = 'UNSURE';

  return {
    start, end, breaks, segments,
    workMin: Math.round(workMin), breakMin: Math.round(breakMin),
    confidence, notes, suggestions, computedAt: Date.now()
  };
}

/**
 * ユーザー修正と推定の差分からマイルール候補を生成(HITL学習)
 */
function diffToRuleProposals(estimation, correction) {
  const proposals = [];
  if (!estimation || !correction) return proposals;
  const wd = estimation.start != null ? new Date(estimation.start).getDay() : null;

  // 修正で追加された休憩 → 休憩ルール候補
  for (const cb of correction.breaks || []) {
    const covered = (estimation.breaks || []).some(eb => eb.s <= cb.s + 5 * MIN && eb.e >= cb.e - 5 * MIN);
    if (!covered) {
      proposals.push({
        treatAs: 'break', fromMin: minutesOfDay(cb.s), toMin: minutesOfDay(cb.e),
        weekday: wd, label: cb.label || '休憩',
        text: `${fmtTime(cb.s)}〜${fmtTime(cb.e)} を休憩とする修正を検知しました。次回から似た時間帯に自動適用しますか？`
      });
    }
  }
  // 推定休憩が修正で削除された → 稼働ルール候補
  for (const eb of estimation.breaks || []) {
    const kept = (correction.breaks || []).some(cb => cb.s < eb.e && cb.e > eb.s);
    if (!kept) {
      proposals.push({
        treatAs: 'work', fromMin: minutesOfDay(eb.s), toMin: minutesOfDay(eb.e),
        weekday: wd, label: '稼働(修正学習)',
        text: `${fmtTime(eb.s)}〜${fmtTime(eb.e)} を稼働に戻す修正を検知しました。次回から似た空白を稼働扱いにしますか？`
      });
    }
  }
  return proposals;
}

/** 提出モード判定 */
function shouldAutoSubmit(mode, confidence) {
  switch (mode) {
    case 'auto': return true;                                   // オート: すべて自動提出
    case 'moderate': return confidence !== 'LOW';               // ほどほど: 不安定な日だけ手動
    case 'strict': return confidence === 'STABLE';              // きっちり: 安定した日のみ自動
    default: return false;                                      // マニュアル
  }
}

/** 乖離チェック: 提出値と推定値の差(分) */
function discrepancyMin(estimation, submitted) {
  if (!estimation || !submitted || estimation.start == null || submitted.start == null) return 0;
  return Math.abs((estimation.workMin ?? 0) - (submitted.workMin ?? 0));
}

/** 簡易ICSパーサ(VEVENTのDTSTART/DTEND/SUMMARYのみ) */
function parseICS(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const b of blocks) {
    const body = b.split('END:VEVENT')[0];
    const get = (key) => {
      const m = body.match(new RegExp('^' + key + '[^:\\n]*:(.+)$', 'm'));
      return m ? m[1].trim() : null;
    };
    const parseDt = (v) => {
      if (!v) return null;
      const m = v.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?/);
      if (!m) return null;
      if (m[7] === 'Z') return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
      return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    };
    const s = parseDt(get('DTSTART')), e = parseDt(get('DTEND'));
    if (s && e) events.push({ s, e, summary: (get('SUMMARY') || '予定').replace(/\\,/g, ',') });
  }
  return events;
}

module.exports = {
  dayKey, fmtTime, fmtDur, mergeIntervals, estimate,
  diffToRuleProposals, shouldAutoSubmit, discrepancyMin, parseICS, MIN
};
