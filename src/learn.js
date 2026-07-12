'use strict';
/**
 * 動向学習エンジン(Human-in-the-Loop)
 * 個人・チームの割り当て実績から、未分類の作業を推論する。
 *  - 語句 → 案件 のナイーブベイズ(ラプラス平滑化)
 *  - 曜日×時間帯の事前確率(「火曜10時台はだいたいA123」)
 *  - 会議の余韻(直前の会議案件は続きの作業になりやすい)
 * 学習統計は「語句・時間帯 → 案件の回数」だけを保持し、タイトル原文は残さない。
 */

const AUTO_THRESHOLD = 0.85;    // これ以上で自動計上
const HINT_THRESHOLD = 0.5;     // これ以上で候補として提示
const CARRY_MIN = 30;           // 会議終了後、この分数は同案件バイアス

function emptyStats() {
  return { tokens: {}, slots: {}, totals: {}, n: 0 };
}

function slotKey(ts) {
  const d = new Date(ts);
  return `w${d.getDay()}h${d.getHours()}`;
}

/** 学習: tokens/時刻 → projectId (weight=確度。手動割当3、コード/カレンダー確定1) */
function learn(stats, { tokens = [], ts, projectId, weight = 1 }) {
  if (!projectId) return;
  stats.totals[projectId] = (stats.totals[projectId] || 0) + weight;
  stats.n += weight;
  for (const t of tokens.slice(0, 12)) {
    if (!stats.tokens[t]) stats.tokens[t] = {};
    stats.tokens[t][projectId] = (stats.tokens[t][projectId] || 0) + weight;
  }
  if (ts) {
    const sk = slotKey(ts);
    if (!stats.slots[sk]) stats.slots[sk] = {};
    stats.slots[sk][projectId] = (stats.slots[sk][projectId] || 0) + weight;
  }
  prune(stats);
}

/** 統計の肥大化防止: 語句は上位600件まで */
function prune(stats, cap = 600) {
  const keys = Object.keys(stats.tokens);
  if (keys.length <= cap) return;
  const scored = keys.map(k => [k, Object.values(stats.tokens[k]).reduce((a, b) => a + b, 0)])
    .sort((a, b) => a[1] - b[1]);
  for (const [k] of scored.slice(0, keys.length - cap)) delete stats.tokens[k];
}

/**
 * 推論: 候補案件と確率を返す
 * @param statsList 統計の配列(自分のstats + チームメンバーのstats)。後者は重み減衰して合成
 * @returns {pid, p, second} | null
 */
function infer(statsList, { tokens = [], ts, carryPid = null, projects = [] }) {
  const act = projects.filter(p => p.active !== false);
  if (!act.length) return null;
  // 統計を合成(自分1.0、チーム0.4)
  const merged = emptyStats();
  statsList.forEach((s, i) => {
    if (!s) return;
    const w = i === 0 ? 1 : 0.4;
    for (const [pid, n] of Object.entries(s.totals || {})) merged.totals[pid] = (merged.totals[pid] || 0) + n * w;
    merged.n += (s.n || 0) * w;
    for (const [t, m] of Object.entries(s.tokens || {})) {
      if (!tokens.includes(t)) continue; // 必要な語句だけ合成
      if (!merged.tokens[t]) merged.tokens[t] = {};
      for (const [pid, n] of Object.entries(m)) merged.tokens[t][pid] = (merged.tokens[t][pid] || 0) + n * w;
    }
    const sk = ts ? slotKey(ts) : null;
    if (sk && s.slots && s.slots[sk]) {
      if (!merged.slots[sk]) merged.slots[sk] = {};
      for (const [pid, n] of Object.entries(s.slots[sk])) merged.slots[sk][pid] = (merged.slots[sk][pid] || 0) + n * w;
    }
  });
  if (merged.n < 3) return null; // 学習不足

  const V = Math.max(10, Object.keys(merged.tokens).length);
  const scores = {};
  for (const p of act) {
    const prior = ((merged.totals[p.id] || 0) + 1) / (merged.n + act.length);
    let logp = Math.log(prior);
    for (const t of tokens.slice(0, 12)) {
      const m = merged.tokens[t] || {};
      const tot = Object.values(m).reduce((a, b) => a + b, 0);
      logp += Math.log(((m[p.id] || 0) + 1) / (tot + V) * V / 3 + 1e-9) * 0.6;
    }
    const sk = ts ? slotKey(ts) : null;
    if (sk && merged.slots[sk]) {
      const m = merged.slots[sk];
      const tot = Object.values(m).reduce((a, b) => a + b, 0);
      logp += Math.log(((m[p.id] || 0) + 0.5) / (tot + act.length)) * 0.8;
    }
    if (carryPid === p.id) logp += Math.log(3); // 会議の余韻バイアス
    scores[p.id] = logp;
  }
  // softmax
  const max = Math.max(...Object.values(scores));
  let z = 0;
  const exp = {};
  for (const [pid, s] of Object.entries(scores)) { exp[pid] = Math.exp(s - max); z += exp[pid]; }
  const ranked = Object.entries(exp).map(([pid, e]) => ({ pid, p: e / z })).sort((a, b) => b.p - a.p);
  const best = ranked[0];
  if (!best || best.p < HINT_THRESHOLD) return null;
  return { pid: best.pid, p: best.p, second: ranked[1] ? ranked[1].p : 0 };
}

/** 直近の会議案件(余韻): カレンダーから、ts直前CARRY_MIN分以内に終わった会議の案件 */
function carryProject(calendar, ts, matchFn) {
  let best = null;
  for (const ev of calendar || []) {
    if (ev.e <= ts && ts - ev.e <= CARRY_MIN * 60000) {
      const hit = matchFn(ev.summary);
      if (hit && (!best || ev.e > best.e)) best = { e: ev.e, pid: hit.id };
    }
  }
  return best ? best.pid : null;
}

module.exports = { emptyStats, learn, infer, carryProject, slotKey, AUTO_THRESHOLD, HINT_THRESHOLD };
