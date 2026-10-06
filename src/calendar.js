'use strict';
/**
 * 共有カレンダー(案件の予定)
 * イベント: {id, date:'YYYY-MM-DD', sMin, eMin, title, projectId, kind, members:[表示名],
 *            createdById, createdByName, createdBy(旧版互換=表示名), createdAt, updatedAt, updatedBy, deleted}
 * members が空 = チーム全員向け。Firestore同期は updatedAt が新しい方を採用(削除はtombstoneで常に優先)。
 * kind = 案件ではない予定の区分('internal' 社内会議(案件外) / 'shoot' 撮影・ロケハン)。projectIdとは排他。
 */

/** 案件外の予定区分(カレンダー登録の案件リストに固定で並ぶ項目)。renderer/app.js の EVENT_KINDS と揃えること */
const EVENT_KINDS = {
  internal: '社内会議（案件外）',
  shoot: '撮影・ロケハン'
};
const KIND_IDS = Object.keys(EVENT_KINDS);

/** 不正な値は null に正規化 */
function normKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVENT_KINDS, kind) ? kind : null;
}
function kindLabel(kind) { return EVENT_KINDS[kind] || ''; }

/**
 * 2つのイベント配列をマージ(id単位)
 *  - 削除(tombstone)は常に優先(古い編集が削除済み予定を復活させない)
 *  - 削除状態が同じなら updatedAt が新しい方。同値なら後ろ(b=リモート)を採用
 */
function mergeEvents(a, b) {
  const map = new Map();
  for (const ev of [...(a || []), ...(b || [])]) {
    if (!ev || !ev.id) continue;
    const cur = map.get(ev.id);
    if (!cur) { map.set(ev.id, ev); continue; }
    if (!!cur.deleted !== !!ev.deleted) { if (ev.deleted) map.set(ev.id, ev); continue; }
    if ((ev.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(ev.id, ev);
  }
  return [...map.values()].sort((x, y) =>
    x.date === y.date ? (x.sMin - y.sMin) : x.date.localeCompare(y.date));
}

/**
 * 予定を編集できるか(登録者本人のみ)
 * @param me { ids:[自分の作成者ID(ローカルID・各チームのmemberId)], name: 表示名 }
 * 作成者IDが無い旧データは「作成者の表示名 = 自分の表示名」の場合だけ本人とみなす。
 */
function canEdit(ev, me) {
  if (!ev || !me) return false;
  if (ev.createdById) return (me.ids || []).includes(ev.createdById);
  const name = ev.createdByName || ev.createdBy;
  return !!name && !!me.name && name === me.name;
}

/** レンダラーから受け取った入力を検証・整形(新規/編集共通)。不正なら {error} */
function sanitizeInput(input, validProjectIds) {
  const i = input || {};
  const sMin = Math.round(Number(i.sMin)), eMin = Math.round(Number(i.eMin));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(i.date || ''))) return { error: '日付が不正です' };
  if (!Number.isFinite(sMin) || !Number.isFinite(eMin) || sMin < 0 || eMin > 24 * 60 || eMin <= sMin) {
    return { error: '終了は開始より後にしてください' };
  }
  const kind = normKind(i.kind);
  let projectId = kind ? null : (i.projectId || null);
  if (projectId && validProjectIds && !validProjectIds.includes(projectId)) projectId = null;
  return {
    date: String(i.date), sMin, eMin,
    title: String(i.title || '').trim().slice(0, 80) || kindLabel(kind) || '予定',
    projectId, kind,
    members: Array.isArray(i.members) ? i.members.map(m => String(m).trim()).filter(Boolean).slice(0, 50) : []
  };
}

/** 新規イベントを作成 */
function createEvent(fields, creator, now = Date.now()) {
  return {
    id: 'c' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    ...fields,
    createdById: creator.id, createdByName: creator.name,
    createdBy: creator.name, // 旧版の表示互換
    createdAt: now, updatedAt: now, updatedBy: creator.name, deleted: false
  };
}

/**
 * 編集を適用した新しいイベントを返す(作成者情報は保持。旧データは編集時に作成者IDを確定させる)。
 * updatedAt は必ず増加させ、同期マージで編集が古いコピーに勝つようにする。
 */
function applyEdit(ev, fields, editor, now = Date.now()) {
  return {
    ...ev, ...fields,
    createdById: ev.createdById || editor.id,
    createdByName: ev.createdByName || ev.createdBy || editor.name,
    createdBy: ev.createdBy || ev.createdByName || editor.name,
    updatedAt: Math.max(now, (ev.updatedAt || 0) + 1),
    updatedBy: editor.name
  };
}

/**
 * 指定日の自分に関係する予定を、勤怠推定エンジン用の形式 {s,e,summary,kind} に変換。
 * summary は「F000_タイトル」形式にして案件コード判定がそのまま効くようにする。
 * 案件外の区分は「社内会議（案件外）_タイトル」形式(会議判定・稼働扱いが効く)。
 */
function eventsForEngine(events, dateKey, userName, projects) {
  const byId = Object.fromEntries((projects || []).map(p => [p.id, p]));
  const out = [];
  for (const ev of events || []) {
    if (ev.deleted || ev.date !== dateKey) continue;
    if (ev.members && ev.members.length && !ev.members.includes(userName)) continue;
    const [y, m, d] = dateKey.split('-').map(Number);
    const base = new Date(y, m - 1, d).getTime();
    const kind = normKind(ev.kind);
    const p = !kind && ev.projectId ? byId[ev.projectId] : null;
    const prefix = p ? p.code + '_' : kind ? kindLabel(kind) + '_' : '';
    const o = {
      s: base + ev.sMin * 60000,
      e: base + ev.eMin * 60000,
      summary: prefix + (ev.title || '予定')
    };
    if (kind) o.kind = kind;
    out.push(o);
  }
  return out;
}

/** エンジン形式の予定一覧から、時刻nowに進行中の案件外区分(なければnull) */
function activeKindAt(calendar, now) {
  const ev = (calendar || []).find(ev => ev.kind && ev.s <= now && now < ev.e);
  return ev ? normKind(ev.kind) : null;
}

/** 案件の「次の予定」(今日以降で最初の未削除イベント) */
function nextEventFor(events, projectId, todayKey) {
  const list = (events || [])
    .filter(ev => !ev.deleted && ev.projectId === projectId && ev.date >= todayKey)
    .sort((a, b) => a.date === b.date ? a.sMin - b.sMin : a.date.localeCompare(b.date));
  return list[0] || null;
}

module.exports = {
  EVENT_KINDS, KIND_IDS, normKind, kindLabel,
  mergeEvents, canEdit, sanitizeInput, createEvent, applyEdit,
  eventsForEngine, activeKindAt, nextEventFor
};
