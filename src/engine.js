'use strict';
/**
 * 勤怠推定エンジン
 * PC稼働インターバル + カレンダー予定 + マイルール から
 * 始業・終業・休憩・信頼度を推定する。
 * 生ログはここを通過するだけで、永続化されるのは推定結果のみ。
 */

const MIN = 60 * 1000;
/** 「稼働扱い」マイルールの最大幅(分)。長いルールで不在を稼働に見せかけるのを防ぐ */
const MAX_WORK_RULE_MIN = 30;
const ruleSpan = (r) => ((r.toMin - r.fromMin) + 1440) % 1440;

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

/** 空白 [gapS,gapE) と HH:MM 窓の重なり部分(空白の開始日・終了日の両方の窓を確認)。無ければnull */
function windowClip(gapS, gapE, fromMin, toMin) {
  const bases = new Set();
  for (const t of [gapS, gapE]) {
    const d = new Date(t);
    bases.add(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  }
  for (const base of [...bases].sort((a, b) => a - b)) {
    const s = Math.max(gapS, base + fromMin * MIN);
    const e = Math.min(gapE, base + toMin * MIN);
    if (e > s) return { s, e };
  }
  return null;
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
    (r.weekday == null || r.weekday === weekday) &&
    !(r.treatAs === 'work' && ruleSpan(r) > MAX_WORK_RULE_MIN)); // 30分超の稼働ルールは無効

  // ギャップを分類
  const breaks = [];
  const segments = merged.map(iv => ({ s: iv.s, e: iv.e, kind: 'work', label: '稼働' }));
  let ambiguousCount = 0;

  /**
   * 空白 [gapS, gapE) を分類する。
   * マイルールとカレンダー予定は「重なっている部分だけ」に適用し、残りの部分は再帰的に分類する。
   * (旧実装は空白全体に適用していたため、10:00〜10:15の「朝会」ルールがあると
   *  9時間の不在でも丸ごと稼働扱いになっていた)
   */
  const classifyGap = (gapS, gapE) => {
    const gapMin = (gapE - gapS) / MIN;
    if (gapMin < ambiguous) return; // 短い空白は稼働継続とみなす(segments上は前後の稼働に含める)

    // 1) マイルール適用(最優先)
    for (const rule of activeRules) {
      const w = windowClip(gapS, gapE, rule.fromMin, rule.toMin);
      if (!w) continue;
      if (rule.treatAs === 'work') {
        segments.push({ s: w.s, e: w.e, kind: 'work', label: `稼働(ルール: ${rule.label})` });
        notes.push(`${fmtTime(w.s)}〜${fmtTime(w.e)} マイルール「${rule.label}」により稼働扱い`);
      } else {
        const kind = rule.treatAs === 'exclude' ? 'exclude' : 'break';
        breaks.push({ s: w.s, e: w.e, kind, source: `ルール: ${rule.label}` });
        segments.push({ s: w.s, e: w.e, kind, label: rule.label });
        notes.push(`${fmtTime(w.s)}〜${fmtTime(w.e)} マイルール「${rule.label}」により${kind === 'exclude' ? '対象外' : '休憩'}扱い`);
      }
      if (w.s > gapS) classifyRest(gapS, w.s);
      if (w.e < gapE) classifyRest(w.e, gapE);
      return;
    }

    // 2) カレンダー予定との突合(会議中の無操作は稼働扱い)。予定と重なる部分だけに適用
    const ev = calendar.find(ev => ev.s < gapE && ev.e > gapS);
    if (ev) {
      const s0 = Math.max(gapS, ev.s), e0 = Math.min(gapE, ev.e);
      const summary = ev.summary || '';
      // 案件外の区分(社内会議・撮影/ロケハン)は明示的な業務予定なので、語句に関係なく稼働扱い
      const isTravel = !ev.kind && /移動|外出|直行|直帰|出張/.test(summary);
      const isExcluded = !ev.kind && /通院|私用|中抜け|離席/.test(summary);
      if (isTravel && settings.travelAsWork !== false) {
        segments.push({ s: s0, e: e0, kind: 'work', label: `移動: ${summary}` });
        notes.push(`${fmtTime(s0)}〜${fmtTime(e0)} 「${summary}」を移動(稼働)として計上`);
      } else if (isTravel || isExcluded) {
        breaks.push({ s: s0, e: e0, kind: 'exclude', source: `予定: ${summary}` });
        segments.push({ s: s0, e: e0, kind: 'exclude', label: summary });
        suggestions.push({
          type: 'rule', treatAs: 'exclude',
          fromMin: minutesOfDay(s0), toMin: minutesOfDay(e0), weekday,
          label: summary || '対象外',
          text: `${fmtTime(s0)}〜${fmtTime(e0)} は「${summary}」かもしれません。稼働に含めず申請しますか？`
        });
      } else {
        segments.push({ s: s0, e: e0, kind: 'work', label: `会議: ${summary}` });
        notes.push(`${fmtTime(s0)}〜${fmtTime(e0)} カレンダー予定「${summary}」により稼働扱い`);
      }
      if (s0 > gapS) classifyRest(gapS, s0);
      if (e0 < gapE) classifyRest(e0, gapE);
      return;
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
  };
  // ルール/予定で切り出した残りの部分。短い切れ端も休憩判定の対象にする(短い場合は稼働扱いの「微妙」へ)
  const classifyRest = (s0, e0) => {
    if ((e0 - s0) / MIN < ambiguous) {
      segments.push({ s: s0, e: e0, kind: 'ambiguous', label: '判定が微妙な空白' });
      return;
    }
    classifyGap(s0, e0);
  };

  for (let i = 0; i < merged.length - 1; i++) classifyGap(merged[i].e, merged[i + 1].s);

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
  // 推定休憩が修正で削除された → 稼働ルール候補(30分以内のものだけ)
  for (const eb of estimation.breaks || []) {
    const kept = (correction.breaks || []).some(cb => cb.s < eb.e && cb.e > eb.s);
    if (!kept && (eb.e - eb.s) / MIN <= MAX_WORK_RULE_MIN) {
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
  dayKey, fmtTime, fmtDur, mergeIntervals, estimate, MAX_WORK_RULE_MIN, ruleSpan,
  diffToRuleProposals, shouldAutoSubmit, discrepancyMin, parseICS, MIN
};
