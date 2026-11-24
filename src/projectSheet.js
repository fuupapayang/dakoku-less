'use strict';
/**
 * 案件番号の参照(スプレッドシート「WEB案件進行一覧」)
 *  - 東京タブ(T000)・福岡・大阪タブ(F000)のA列=案件番号、B列=案件名
 *  - 「案件名が入っている最後の行」の次の行の番号が、次に使う案件番号
 *  - スプレッドシート側に読み取り専用のGAS(doGet)を置き、アプリはそのURLから一覧を取得する
 *  - 登録時に、案件番号・案件名がシートやアプリの案件と重複していないかを確かめる
 */

const PS_VERSION = 1;
/** 参照するタブ(タブ名 → 地域ラベル・コードの頭文字) */
const TABS = [
  { tab: '東京', label: '東京', prefix: 'T' },
  { tab: '福岡・大阪', label: '福岡・大阪', prefix: 'F' }
];

/** スプレッドシート(WEB案件進行一覧)に貼る読み取り専用スクリプト */
function gasScript(token) {
  return `// 全自動勤怠管理くん: 案件番号の参照(読み取り専用。シートには書き込みません)
const TOKEN = ${JSON.stringify(token || '')}; // 合言葉。アプリの「スプレッドシート連携」の合言葉と同じ文字列
const TABS = ${JSON.stringify(TABS.map(t => ({ tab: t.tab, prefix: t.prefix })))};

function doGet(e) {
  try {
    if (TOKEN && (!e || !e.parameter || e.parameter.token !== TOKEN)) return out({ ok:false, error:'合言葉が一致しません' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tabs = TABS.map(function(t) {
      const sh = ss.getSheetByName(t.tab);
      if (!sh) return { tab:t.tab, prefix:t.prefix, error:'タブ「' + t.tab + '」が見つかりません', rows:[] };
      const n = sh.getLastRow();
      const v = n ? sh.getRange(1, 1, n, 2).getDisplayValues() : [];
      const rows = [];
      v.forEach(function(r) {
        const code = String(r[0] || '').trim().toUpperCase();
        if (/^[A-Z]+\\d+$/.test(code)) rows.push([code, String(r[1] || '').trim()]);
      });
      return { tab:t.tab, prefix:t.prefix, rows:rows };
    });
    return out({ ok:true, v:${PS_VERSION}, tabs:tabs, at:new Date().toISOString() });
  } catch (err) {
    return out({ ok:false, error:String(err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

const codeNum = (code) => { const m = /^([A-Z]+)(\d+)$/.exec(String(code || '')); return m ? { prefix: m[1], num: Number(m[2]), width: m[2].length } : null; };

/**
 * 1つのタブの行 [[code, name], ...] から、案件名がある最後の行と次の番号を求める。
 * 次の番号 = 最後の行の次の行の番号(番号だけ先に振ってある行)。無ければ最後の番号+1。
 * appCodes(アプリに登録済みのコード)と重なる番号は飛ばす(シートへの記入前にアプリで登録された番号)。
 */
function nextFromRows(rows, prefix, appCodes) {
  const list = (rows || []).filter(r => r && codeNum(r[0]) && codeNum(r[0]).prefix === prefix);
  let lastIdx = -1;
  list.forEach((r, i) => { if (String(r[1] || '').trim()) lastIdx = i; });
  const last = lastIdx >= 0 ? { code: list[lastIdx][0], name: String(list[lastIdx][1]).trim() } : null;
  const used = new Set([...(appCodes || []), ...list.filter(r => String(r[1] || '').trim()).map(r => r[0])]);
  const width = last ? codeNum(last.code).width : 3;
  let n = last ? codeNum(last.code).num + 1 : 1;
  // 次の行に番号が振ってあれば、その番号を優先
  const after = lastIdx >= 0 ? list[lastIdx + 1] : list[0];
  if (after && !String(after[1] || '').trim() && codeNum(after[0]).num >= n) n = codeNum(after[0]).num;
  let code;
  for (let guard = 0; guard < 10000; guard++, n++) {
    code = prefix + String(n).padStart(width, '0');
    if (!used.has(code)) break;
  }
  return { last, next: code };
}

/** 取得結果(GASの応答)を地域ごとの {tab,label,prefix,last,next,error} にまとめる */
function summarize(resp, appCodes) {
  return TABS.map(t => {
    const x = ((resp && resp.tabs) || []).find(v => v.tab === t.tab) || { rows: [], error: 'タブが見つかりません' };
    if (x.error) return { ...t, error: x.error, last: null, next: '' };
    return { ...t, ...nextFromRows(x.rows, t.prefix, appCodes) };
  });
}

/** 名前の比較用(全角/半角・大文字小文字・空白・記号の揺れを吸収) */
function normName(v) {
  return String(v || '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s・･\-‐ー―_／/()（）「」【】]/g, '');
}

/**
 * 登録しようとしている案件番号・案件名の重複を調べる。
 * @returns { codeInSheet:{code,name,tab}|null, sameAsSheet, nameInSheet:[別の番号で同じ名前], nameInApp:[{code,name}] }
 */
function findDuplicates(code, name, resp, appProjects) {
  const c = String(code || '').trim().toUpperCase();
  const nn = normName(name);
  let codeInSheet = null;
  const nameInSheet = [];
  for (const x of (resp && resp.tabs) || []) {
    for (const [rc, rn] of x.rows || []) {
      if (!String(rn || '').trim()) continue;
      if (rc === c && !codeInSheet) codeInSheet = { code: rc, name: rn, tab: x.tab };
      if (nn && normName(rn) === nn) nameInSheet.push({ code: rc, name: rn, tab: x.tab });
    }
  }
  const nameInApp = (appProjects || []).filter(p => nn && normName(p.name) === nn && p.code !== c).map(p => ({ code: p.code, name: p.name }));
  // シートに同じ番号・同じ名前で載っている案件 = シートの案件をアプリに登録する(重複ではない)
  const sameAsSheet = !!codeInSheet && normName(codeInSheet.name) === nn;
  return { codeInSheet, sameAsSheet, nameInSheet: nameInSheet.filter(x => x.code !== c), nameInApp };
}

/** 参照URL(+合言葉)。/exec 形式でなければ null */
function requestUrl(url, token) {
  const u = String(url || '').trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) return null;
  return `${u}?token=${encodeURIComponent(token || '')}`;
}

/**
 * ページの本文(GASの応答)を解釈。ログイン画面なら {needLogin:true} の Error を投げる。
 * 「qlea.net 内の全員」で公開したスクリプトは、Googleにログインした状態でないと読めない。
 */
function parseResponse(text, pageUrl) {
  const t = String(text || '').trim();
  if (t.startsWith('{')) {
    let json; try { json = JSON.parse(t); } catch (_) { json = null; }
    if (json) {
      if (!json.ok) throw new Error(`案件一覧の取得エラー: ${json.error || '不明'}`);
      return json;
    }
  }
  if (/accounts\.google\.com/.test(String(pageUrl || ''))) {
    const e = new Error('Googleにログインしていません。「Googleにログイン」から、WEB案件進行一覧を見られるアカウント(qlea.net)でログインしてください');
    e.needLogin = true;
    throw e;
  }
  if (/アクセス|権限|access|permission/i.test(t.slice(0, 400))) {
    const e = new Error('このGoogleアカウントでは参照できません。WEB案件進行一覧を見られるアカウント(qlea.net)でログインし直してください');
    e.needLogin = true;
    throw e;
  }
  throw new Error('案件一覧を取得できませんでした(参照URL・スクリプトのデプロイを確認してください)');
}

module.exports = { PS_VERSION, TABS, gasScript, nextFromRows, summarize, normName, findDuplicates, requestUrl, parseResponse };
