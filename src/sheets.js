'use strict';
/**
 * Google スプレッドシート連携(Google Apps Script ウェブアプリ経由)。
 * OAuth不要。ユーザーは対象シートにGASを貼り付けてウェブアプリ公開し、その/exec URLを設定するだけ。
 * アプリは月ごとのタブに「履歴」「工数」を書き出す(タブ内容を置き換える冪等な書き込み)。
 *
 * 送信ペイロード: { token, sheets: [ { tab, headers:[...], rows:[[...],...] }, ... ], summaries: [ { tab, from }, ... ] }
 *
 * v0.12〜: 各メンバーは「自分の分だけ」を個人タブ(履歴_2026-09_山田)に書く。
 * チーム全員分のタブ(履歴_2026-09)はGAS側が個人タブを連結して作り直す(summaries)。
 * これにより、複数人が同じスプレッドシートへ書き込んでも互いに上書きし合わない。
 */
const GAS_VERSION = 2; // 下記 GAS_SCRIPT が返す v。古いスクリプトの検出に使う
const recoru = require('./recoru');
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
      // 提出済みは提出値(承認待ちの水増し修正は推定値)、未提出・差し戻しは最新の推定/修正値。
      // (以前は未提出に戻した日も古い提出値を書き出していた)
      const est = d.estimation || d.submitted || d.correction ? recoru.historyRecord(d).rec : d;
      if (!est || est.start == null) continue;
      const wd = WD[new Date(k).getDay()];
      rows.push([
        m.name, k, wd, recoru.clock(k, est.start), recoru.clock(k, est.end),
        hhmm(est.breakMin), hhmm(est.workMin), hhmm(d.meetingMin || 0),
        statusLabel(d.status) || d.status || ''
      ]);
    }
  }
  return { tab: `履歴_${ym}`, headers, rows };
}

/** 工数タブの行: [ユーザ,案件コード,案件名,分,時間(h)]。時間は小数(時刻と誤認されないよう) */
function reportRows(members, ym, projById) {
  const headers = ['ユーザ', '案件コード', '案件名', '分', '時間(h)'];
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
      rows.push([m.name, p ? p.code : pid, p ? p.name : '(削除済み)', min, Math.round(min / 60 * 100) / 100]);
    }
  }
  // 案件コード順で見やすく
  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])));
  return { tab: `工数_${ym}`, headers, rows };
}

/** シート名に使えない文字を除去(Googleスプレッドシートの制約: []*?:/\\ 不可・100文字以内) */
function safeTabName(name) {
  return String(name || '').replace(/[\[\]*?:\/\\]/g, '').trim().slice(0, 40) || '名称未設定';
}

/**
 * 1人分の書き出し内容: 個人タブ2つ + GASに作らせるチーム集計タブ2つ
 * @returns {{ sheets: Array, summaries: Array }}
 */
function personalExport(member, ym, projById, statusLabel) {
  const who = safeTabName(member.name);
  const hist = historyRows([member], ym, statusLabel);
  const rep = reportRows([member], ym, projById);
  const sheets = [
    { ...hist, tab: `${hist.tab}_${who}` },
    { ...rep, tab: `${rep.tab}_${who}` }
  ];
  const summaries = [
    { tab: hist.tab, from: `${hist.tab}_` },
    { tab: rep.tab, from: `${rep.tab}_` }
  ];
  return { sheets, summaries };
}

/** スプレッドシートに貼り付けるGASコード(アプリの設定画面に表示する) */
function gasScript(token) {
  return `const TOKEN = ${JSON.stringify(token || '')}; // 合言葉(任意)。アプリの合言葉と同じ文字列に

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // 複数人の同時書き込みを順番に処理
    const body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) return out({ ok:false, error:'合言葉が一致しません' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    (body.sheets || []).forEach(function(s) { writeTab(ss, s.tab, s.headers, s.rows || []); });
    // チーム全員分: 「履歴_2026-09_〇〇」などの個人タブを連結して作り直す
    (body.summaries || []).forEach(function(sum) {
      let headers = null, rows = [];
      ss.getSheets().forEach(function(sh) {
        const name = sh.getName();
        if (name.indexOf(sum.from) !== 0) return;
        const v = sh.getDataRange().getDisplayValues(); // 表示どおりの文字列で連結(時刻の型変換を避ける)
        if (!v.length) return;
        headers = headers || v[0];
        rows = rows.concat(v.slice(1).filter(function(r){ return r.join('') !== ''; }));
      });
      if (headers) writeTab(ss, sum.tab, headers, rows);
    });
    return out({ ok:true, v:${GAS_VERSION} });
  } catch (err) {
    return out({ ok:false, error:String(err) });
  } finally {
    lock.releaseLock();
  }
}
function writeTab(ss, tab, headers, rows) {
  const sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
  sh.clearContents();
  const values = [headers].concat(rows);
  sh.getRange(1, 1, values.length, headers.length).setValues(values);
}
function out(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }`;
}

/** 「案件リスト」タブ: 工数按分スクリプトが制作・登録者を読む */
function projectListSheet(projects) {
  const ymd = (t) => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`; };
  const rows = (projects || []).filter(p => p.code)
    .sort((a, b) => String(a.code).localeCompare(String(b.code)))
    .map(p => [p.code, p.name || '', (p.makers || []).join(', '), (p.sales || []).join(', '), p.createdBy || '',
      (p.status || 'active') === 'active' ? '稼働中' : '納品完了', ymd(p.createdAt)]);
  return { tab: '案件リスト', headers: ['案件コード', '案件名', '制作', '担当営業', '登録者', 'ステータス', '登録日'], rows };
}

/** GASウェブアプリへPOST */
async function post(url, token, sheets, summaries) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token || '', sheets, summaries: summaries || [] }),
    redirect: 'follow'
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`スプレッドシート書き込み失敗: HTTP ${res.status} ${text.slice(0, 150)}`);
  let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  if (json && json.ok === false) throw new Error(`スプレッドシート側エラー: ${json.error || '不明'}`);
  return json || { ok: true };
}

module.exports = { historyRows, reportRows, personalExport, projectListSheet, safeTabName, gasScript, post, hhmm, fmtTime, GAS_VERSION };
