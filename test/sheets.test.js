'use strict';
const assert = require('assert');
const sh = require('../src/sheets');

const members = [
  { name: '佐藤', days: {
    '2026-09-01': { estimation: { start: new Date(2026, 8, 1, 9, 0).getTime(), end: new Date(2026, 8, 1, 18, 0).getTime(), workMin: 480, breakMin: 60 }, status: 'approved', meetingMin: 30, projectMin: { p1: 300, p2: 180 } },
    '2026-08-31': { estimation: { start: 1, end: 2, workMin: 100, breakMin: 0 }, status: 'submitted', projectMin: { p1: 100 } } // 前月・対象外
  } }
];
const projById = { p1: { code: 'F001', name: 'A案件' }, p2: { code: 'T002', name: 'B案件' } };

// 履歴: 2026-09 のみ
const hist = sh.historyRows(members, '2026-09', (s) => s);
assert.strictEqual(hist.tab, '履歴_2026-09');
assert.strictEqual(hist.rows.length, 1);
assert.deepStrictEqual(hist.rows[0].slice(0, 7), ['佐藤', '2026-09-01', '火', '09:00', '18:00', '01:00', '08:00']);
assert.strictEqual(hist.rows[0][7], '00:30'); // 会議

// 工数: 2026-09 の案件別
const rep = sh.reportRows(members, '2026-09', projById);
assert.strictEqual(rep.tab, '工数_2026-09');
assert.strictEqual(rep.rows.length, 2);
const f = rep.rows.find(r => r[1] === 'F001');
assert.deepStrictEqual(f, ['佐藤', 'F001', 'A案件', 300, 5]);   // 時間(h)は小数

// 端数の工数: 日ごとに丸めず月合計で1回だけ丸める(0.4分×5日=2分。以前は日ごとに0へ丸めて消えていた)
const frac = { name: '中村', days: {} };
for (let i = 1; i <= 5; i++) frac.days[`2026-09-0${i}`] = { projectMin: { p1: 0.4, p2: 0.05 } };
const fr = sh.reportRows([frac], '2026-09', projById);
assert.deepStrictEqual(fr.rows.map(r => [r[1], r[3]]), [['F001', 2]]); // p2(合計0.25分)は丸めて0なので出さない

// 月ハッシュ・月キー
assert.strictEqual(sh.monthKey(new Date(2026, 9, 7)), '2026-10');
assert.strictEqual(sh.contentHash([[1, 'a']]), sh.contentHash([[1, 'a']]));
assert.notStrictEqual(sh.contentHash([[1, 'a']]), sh.contentHash([[1, 'b']]));

// 回帰: 「未提出」に戻した日は古い提出値ではなく最新の推定値を書き出す
const stale = { '2026-09-05': {
  status: 'pending',
  submitted: { start: new Date(2026, 8, 5, 4, 25).getTime(), end: new Date(2026, 8, 6, 1, 50).getTime(), workMin: 824, breakMin: 461, auto: true },
  estimation: { start: new Date(2026, 8, 5, 4, 25).getTime(), end: new Date(2026, 8, 6, 1, 50).getTime(), workMin: 400, breakMin: 885 }
} };
const hs = sh.historyRows([{ name: '福永', days: stale }], '2026-09', (s) => s);
assert.strictEqual(hs.rows[0][6], '06:40');      // 実働 = 推定値(400分)。提出値824分ではない
assert.strictEqual(hs.rows[0][4], '25:50');      // 日をまたぐ終業は24時超え表記

// 案件リストタブ(制作・登録者)
const pl = sh.projectListSheet([{ code: 'T2', name: 'B', makers: [], sales: ['営業'], createdBy: '福永', createdAt: new Date(2026, 9, 7).getTime() }, { code: 'F1', name: 'A', makers: ['田部', '宮成'] }, { name: 'コードなし' }]);
assert.strictEqual(pl.tab, '案件リスト');
assert.deepStrictEqual(pl.rows.map(r => r[0]), ['F1', 'T2']);
assert.deepStrictEqual(pl.rows[1], ['T2', 'B', '', '営業', '福永', '稼働中', '2026/10/07']);
assert.strictEqual(pl.rows[0][2], '田部, 宮成');

console.log('✓ all sheets tests passed');

// ---- v0.12: 個人タブ + チーム集計(GASで再構成) ----
assert.strictEqual(sh.safeTabName('山田/太郎[営業]'), '山田太郎営業');
const px = sh.personalExport(members[0], '2026-09', projById, (s) => s);
assert.deepStrictEqual(px.sheets.map(s => s.tab), ['履歴_2026-09_佐藤', '工数_2026-09_佐藤']);
assert.deepStrictEqual(px.summaries, [{ tab: '履歴_2026-09', from: '履歴_2026-09_' }, { tab: '工数_2026-09', from: '工数_2026-09_' }]);

// GASスクリプトを擬似スプレッドシートで実行し、2人が順に書いても互いに消えないことを確認
function fakeSpreadsheet() {
  const tabs = new Map();
  const mk = (name) => {
    let vals = [];
    return {
      getName: () => name,
      clearContents: () => { vals = []; },
      getRange: (r, c, nr, nc) => ({ setValues: (v) => { assert.strictEqual(v.length, nr); vals = v.map(x => x.map(String)); } }),
      getDataRange: () => ({ getDisplayValues: () => vals })
    };
  };
  return {
    tabs,
    getSheetByName: (n) => tabs.get(n) || null,
    insertSheet: (n) => { const t = mk(n); tabs.set(n, t); return t; },
    getSheets: () => [...tabs.values()]
  };
}
const ss = fakeSpreadsheet();
const gasEnv = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return JSON.parse(t); } }) }
};
const doPost = new Function(...Object.keys(gasEnv), sh.gasScript('abc') + '\nreturn doPost;')(...Object.values(gasEnv));
const send = (payload) => doPost({ postData: { contents: JSON.stringify(payload) } });

assert.strictEqual(send({ token: 'wrong', sheets: [] }).ok, false);
const other = sh.personalExport({ name: '鈴木', days: members[0].days }, '2026-09', projById, (s) => s);
assert.deepStrictEqual(send({ token: 'abc', ...px }), { ok: true, v: sh.GAS_VERSION });
send({ token: 'abc', ...other });
send({ token: 'abc', ...px }); // 佐藤が再書き出ししても鈴木の分は残る
const team = ss.getSheetByName('履歴_2026-09').getDataRange().getDisplayValues();
assert.strictEqual(team[0][0], 'ユーザ');
assert.deepStrictEqual(team.slice(1).map(r => r[0]).sort(), ['佐藤', '鈴木']);
assert.strictEqual(ss.getSheetByName('工数_2026-09').getDataRange().getDisplayValues().length, 1 + 4);

console.log('✓ v0.12 team sheets tests passed');
