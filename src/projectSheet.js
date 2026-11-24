'use strict';
/**
 * 案件番号の参照(スプレッドシート「WEB案件進行一覧」)
 *  - 東京タブ(T000)・福岡・大阪タブ(F000)のA列=案件番号、B列=案件名
 *  - 「案件名が入っている最後の行」の次の行の番号が、次に使う案件番号
 *  - スプレッドシート側にGAS(doGet)を置き、アプリはそのURLから一覧を取得する
 *  - 案件登録時は action=add で、番号だけ振ってある行に案件名・Dev(顧客)・営業担当を書き込む(上書き・行追加はしない)
 *  - 登録時に、案件番号・案件名がシートやアプリの案件と重複していないかを確かめる
 */

const PS_VERSION = 2; // 2: 案件登録時の書き込み(action=add)
/** 参照するタブ(タブ名 → 地域ラベル・コードの頭文字) */
const TABS = [
  { tab: '東京', label: '東京', prefix: 'T' },
  { tab: '福岡・大阪', label: '福岡・大阪', prefix: 'F' }
];

/** スプレッドシート(WEB案件進行一覧)に貼るスクリプト(一覧の参照 + 案件登録時の書き込み) */
function gasScript(token) {
  return `// 全自動勤怠管理くん: 案件番号の参照と、案件登録時の書き込み
//  - 参照: A列(案件番号)・B列(案件名)を返すだけ
//  - 書き込み: 番号だけ振ってある行(案件名が空)に、案件名・Dev(顧客)・営業担当を入れる。
//    入っているセルは上書きしない。行の追加・削除はしない。
const TOKEN = ${JSON.stringify(token || '')}; // 合言葉。アプリの「スプレッドシート連携」の合言葉と同じ文字列
const TABS = ${JSON.stringify(TABS.map(t => ({ tab: t.tab, prefix: t.prefix })))};
const V = ${PS_VERSION};

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (TOKEN && p.token !== TOKEN) return out({ ok:false, error:'合言葉が一致しません' });
    if (p.action === 'add') return out(addProject(p));
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tabs = TABS.map(function(t) {
      const sh = ss.getSheetByName(t.tab);
      if (!sh) return { tab:t.tab, prefix:t.prefix, error:'タブ「' + t.tab + '」が見つかりません', rows:[] };
      return { tab:t.tab, prefix:t.prefix, rows:readRows(sh) };
    });
    return out({ ok:true, v:V, tabs:tabs, at:new Date().toISOString() });
  } catch (err) {
    return out({ ok:false, v:V, error:String(err) });
  }
}

function readRows(sh) {
  const n = sh.getLastRow();
  const v = n ? sh.getRange(1, 1, n, 2).getDisplayValues() : [];
  const rows = [];
  v.forEach(function(r) {
    const code = String(r[0] || '').trim().toUpperCase();
    if (/^[A-Z]+\\d+$/.test(code)) rows.push([code, String(r[1] || '').trim()]);
  });
  return rows;
}

function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[\\s・･\\-‐ー―_／/()（）「」【】]/g, ''); }

function addProject(p) {
  const code = String(p.code || '').trim().toUpperCase();
  const name = String(p.name || '').trim();
  if (!/^[A-Z]+\\d+$/.test(code) || !name) return { ok:false, v:V, error:'案件番号・案件名が正しくありません' };
  const t = TABS.filter(function(x) { return code.indexOf(x.prefix) === 0 && /^\\d+$/.test(code.slice(x.prefix.length)); })[0];
  if (!t) return { ok:false, v:V, error:code + ' はWEB案件進行一覧のタブ(' + TABS.map(function(x){return x.prefix;}).join('・') + ')に当てはまりません' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(t.tab);
    if (!sh) return { ok:false, v:V, error:'タブ「' + t.tab + '」が見つかりません' };
    const lastCol = Math.max(sh.getLastColumn(), 2);
    const n = sh.getLastRow();
    const vals = sh.getRange(1, 1, n, Math.min(lastCol, 30)).getDisplayValues();
    // 見出し行(「案件名」がある行)から列を探す
    let head = -1;
    for (let i = 0; i < Math.min(vals.length, 15); i++) if (vals[i].some(function(c){ return String(c).trim() === '案件名'; })) { head = i; break; }
    const col = function(label) { if (head < 0) return -1; return vals[head].map(function(c){ return String(c).trim(); }).indexOf(label); };
    const cName = col('案件名') >= 0 ? col('案件名') : 1, cDev = col('Dev'), cSales = col('営業担当');
    // 同じ案件名が別の番号で使われていないか(両タブ)
    if (p.force !== '1') {
      const nn = norm(name);
      for (let k = 0; k < TABS.length; k++) {
        const s2 = ss.getSheetByName(TABS[k].tab); if (!s2) continue;
        const hit = readRows(s2).filter(function(r){ return r[1] && r[0] !== code && norm(r[1]) === nn; })[0];
        if (hit) return { ok:false, v:V, dupName:true, error:'同じ案件名が ' + hit[0] + ' にあります' };
      }
    }
    let row = -1;
    for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toUpperCase() === code) { row = i; break; }
    if (row < 0) return { ok:false, v:V, noRow:true, error:t.tab + 'タブに ' + code + ' の行がありません(A列に番号を振った行を用意してください)' };
    const cur = String(vals[row][cName] || '').trim();
    if (cur) {
      if (norm(cur) === norm(name)) return { ok:true, v:V, already:true, tab:t.tab, row:row + 1 };
      return { ok:false, v:V, error:code + ' はすでに「' + cur + '」で使われています' };
    }
    const r = row + 1, wrote = ['案件名'];
    sh.getRange(r, cName + 1).setValue(name);
    if (cDev >= 0 && p.client && !String(vals[row][cDev] || '').trim()) { sh.getRange(r, cDev + 1).setValue(String(p.client)); wrote.push('Dev'); }
    if (cSales >= 0 && p.sales && !String(vals[row][cSales] || '').trim()) { sh.getRange(r, cSales + 1).setValue(String(p.sales)); wrote.push('営業担当'); }
    return { ok:true, v:V, tab:t.tab, row:r, wrote:wrote };
  } finally {
    lock.releaseLock();
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

/** 書き込み用URL(action=add)。シートのタブ(T/F)に当てはまらない番号は null */
function addUrl(url, token, { code, name, client, sales, force } = {}) {
  const base = requestUrl(url, token);
  const c = String(code || '').trim().toUpperCase();
  if (!base || !TABS.some(t => new RegExp(`^${t.prefix}\\d+$`).test(c))) return null;
  const q = { action: 'add', code: c, name: String(name || '').trim(), client: String(client || '').trim(), sales: (sales || []).join('・') };
  if (force) q.force = '1';
  return base + Object.entries(q).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
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
      if (!json.ok) throw Object.assign(new Error(json.error || '不明なエラー'), { resp: json });
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

module.exports = { PS_VERSION, TABS, gasScript, nextFromRows, summarize, normName, findDuplicates, requestUrl, addUrl, parseResponse };
