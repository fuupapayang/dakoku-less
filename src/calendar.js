'use strict';
/**
 * 共有カレンダー(案件の予定)
 * イベント: {id, date:'YYYY-MM-DD', sMin, eMin, title, projectId, members:[表示名], createdBy, updatedAt, deleted}
 * members が空 = チーム全員向け。Firestore同期は updatedAt が新しい方を採用(削除はtombstone)。
 */

/** 2つのイベント配列をマージ(id単位、updatedAtが新しい方を採用) */
function mergeEvents(a, b) {
  const map = new Map();
  for (const ev of [...(a || []), ...(b || [])]) {
    if (!ev || !ev.id) continue;
    const cur = map.get(ev.id);
    if (!cur || (ev.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(ev.id, ev);
  }
  return [...map.values()].sort((x, y) =>
    x.date === y.date ? (x.sMin - y.sMin) : x.date.localeCompare(y.date));
}

/**
 * 指定日の自分に関係する予定を、勤怠推定エンジン用の形式 {s,e,summary} に変換。
 * summary は「F000_タイトル」形式にして案件コード判定がそのまま効くようにする。
 */
function eventsForEngine(events, dateKey, userName, projects) {
  const byId = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const out = [];
  for (const ev of events || []) {
    if (ev.deleted || ev.date !== dateKey) continue;
    if (ev.members && ev.members.length && !ev.members.includes(userName)) continue;
    const [y, m, d] = dateKey.split('-').map(Number);
    const base = new Date(y, m - 1, d).getTime();
    const p = ev.projectId ? byId[ev.projectId] : null;
    out.push({
      s: base + ev.sMin * 60000,
      e: base + ev.eMin * 60000,
      summary: (p ? p.code + '_' : '') + (ev.title || '予定')
    });
  }
  return out;
}

/** 案件の「次の予定」(今日以降で最初の未削除イベント) */
function nextEventFor(events, projectId, todayKey) {
  const list = (events || [])
    .filter(ev => !ev.deleted && ev.projectId === projectId && ev.date >= todayKey)
    .sort((a, b) => a.date === b.date ? a.sMin - b.sMin : a.date.localeCompare(b.date));
  return list[0] || null;
}

module.exports = { mergeEvents, eventsForEngine, nextEventFor };
