'use strict';
/**
 * Google スプレッドシート連携(Google Apps Script ウェブアプリ経由)。
 * OAuth不要。ユーザーは対象シートにGASを貼り付けてウェブアプリ公開し、その/exec URLを設定するだけ。
 * アプリは月ごとのタブに「履歴」「工数」を書き出す(タブ内容を置き換える冪等な書き込み)。
 *
 * 送信ペイロード: { token, sheets: [ { tab, headers:[...], rows:[[...],...] }, ... ] }
 */
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function fmtTime(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function hhmm(min) {
  min = Math.round(min || 0);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function inMonth(key, ym) { return String(key).slice(0, 7) === ym; }

/** 履歴タブの行: [ユーザ,日付,曜日,始業,終業,休憩,実働,会議,状態] */
function historyRows(members, ym, statusLabel) {
  const headers = ['ユーザ', '日付', '曜日', '始業', '終業', '休憩', '実働', '会議', '状態'];
  const rows = [];
  for (const m of members) {
    for (const k of Object.keys(m.days || {}).sort()) {
      if (!inMonth(k, ym)) continue;
      const d = m.days[k];
      const est = d.submitted || d.correction || d.estimation || d;
      if (!est || est.start == null) continue;
      const wd = WD[new Date(k).getDay()];
      rows.push([
        m.name, k, wd, fmtTime(est.start), fmtTime(est.end),
        hhmm(est.breakMin), hhmm(est.workMin), hhmm(d.meetingMin || 0),
        statusLabel(d.status) || d.status || ''
      ]);
    }
  }
  return { tab: `履歴_${ym}`, headers, rows };
}

/** 工数タブの行: [ユーザ,案件コード,案件名,分,時間] */
function reportRows(members, ym, projById) {
  const headers = ['ユーザ', '案件コード', '案件名', '分', '時間'];
  const rows = [];
  for (const m of members) {
    const agg = {}; // pid -> min
    for (const [k, d] of Object.entries(m.days || {})) {
      if (!inMonth(k, ym)) continue;
      for (const [pid, min] of Object.entries(d.projectMin || {})) agg[pid] = (agg[pid] || 0) + Math.round(min);
    }
    for (const [pid, min] of Object.entries(agg)) {
      if (min <= 0) continue;
      const p = projById[pid];
      rows.push([m.name, p ? p.code : pid, p ? p.name : '(削除済み)', min, hhmm(min)]);
    }
  }
  // 案件コード順で見やすく
  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])));
  return { tab: `工数_${ym}`, headers, rows };
}

/** GASウェブアプリへPOST */
async function post(url, token, sheets) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token || '', sheets }),
    redirect: 'follow'
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`スプレッドシート書き込み失敗: HTTP ${res.status} ${text.slice(0, 150)}`);
  let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  if (json && json.ok === false) throw new Error(`スプレッドシート側エラー: ${json.error || '不明'}`);
  return json || { ok: true };
}

module.exports = { historyRows, reportRows, post, hhmm, fmtTime };
