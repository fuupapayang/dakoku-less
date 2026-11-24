'use strict';
const assert = require('assert');
const PS = require('../src/projectSheet');

// 東京: T835〜T837 に名前あり、T838 以降は番号なし → 次は T838
const tokyo = [['T001', 'リリアージュ'], ['T804', ''], ['T836', '清水総合開発お年賀'], ['T837', 'ルネ柏ディアパーク']];
assert.deepStrictEqual(PS.nextFromRows(tokyo, 'T', []), { last: { code: 'T837', name: 'ルネ柏ディアパーク' }, next: 'T838' });
// 福岡: F768 まで名前、F769〜 は番号だけ → 次は F769
const fk = [['F232', ''], ['F767', 'A'], ['F768', '三井栄タワー映像制作'], ['F769', ''], ['F770', '']];
assert.strictEqual(PS.nextFromRows(fk, 'F', []).next, 'F769');
// アプリで先に F769 を登録済み → F770
assert.strictEqual(PS.nextFromRows(fk, 'F', ['F769']).next, 'F770');
// 空のタブ
assert.strictEqual(PS.nextFromRows([], 'T', []).next, 'T001');
// 頭文字の違う行は無視
assert.strictEqual(PS.nextFromRows([['F010', 'x'], ['T005', 'y']], 'T', []).next, 'T006');

const resp = { tabs: [{ tab: '東京', rows: tokyo }, { tab: '福岡・大阪', rows: fk }] };
const sum = PS.summarize(resp, ['T838']);
assert.strictEqual(sum[0].next, 'T839');
assert.strictEqual(sum[1].next, 'F769');
assert.ok(PS.summarize({ tabs: [{ tab: '東京', error: 'なし' }] }, [])[0].error);

// 重複チェック
let d = PS.findDuplicates('T838', 'ルネ柏 ディアパーク', resp, []);
assert.strictEqual(d.codeInSheet, null);
assert.deepStrictEqual(d.nameInSheet.map(x => x.code), ['T837']); // 空白・全角の揺れを吸収
d = PS.findDuplicates('T837', 'ルネ柏ディアパーク', resp, []);
assert.ok(d.codeInSheet && d.sameAsSheet && d.nameInSheet.length === 0); // シートの案件をそのまま登録
d = PS.findDuplicates('T836', '新しい案件', resp, []);
assert.ok(d.codeInSheet && !d.sameAsSheet); // 番号が別の案件で使われている
d = PS.findDuplicates('T900', 'ﾃｽﾄ案件', resp, [{ code: 'F001', name: 'テスト案件' }]);
assert.deepStrictEqual(d.nameInApp, [{ code: 'F001', name: 'テスト案件' }]);
assert.strictEqual(PS.normName('ザ・パークハウス 大手門'), PS.normName('ザパークハウス大手門'));

// GASスクリプトは構文として正しい
new Function(PS.gasScript('abc'));
assert.ok(PS.gasScript('abc').includes('"abc"'));

// 応答の解釈(ログイン状態で読む)
assert.strictEqual(PS.requestUrl('https://script.google.com/a/macros/qlea.net/s/AKfy/exec', 'a b'), 'https://script.google.com/a/macros/qlea.net/s/AKfy/exec?token=a%20b');
assert.strictEqual(PS.requestUrl('https://example.com/x', ''), null);
assert.deepStrictEqual(PS.parseResponse('{"ok":true,"tabs":[]}', 'https://script.googleusercontent.com/macros/echo?x').tabs, []);
assert.throws(() => PS.parseResponse('ログイン', 'https://accounts.google.com/v3/signin/identifier?x'), e => e.needLogin);
assert.throws(() => PS.parseResponse('{"ok":false,"error":"合言葉が一致しません"}', 'https://script.googleusercontent.com/x'), /合言葉/);
assert.throws(() => PS.parseResponse('<html>?</html>', 'https://script.google.com/x'), e => !e.needLogin);

console.log('✓ projectSheet tests passed');

// --- GASスクリプト(書き込み)をモックのシートで実行 ---
{
  const vm = require('vm');
  const mkSheet = (rows) => ({
    rows,
    getLastRow() { return this.rows.length; },
    getLastColumn() { return Math.max(...this.rows.map(r => r.length)); },
    getRange(r, c, nr = 1, nc = 1) {
      const sh = this;
      return {
        getDisplayValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => String((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))); },
        setValue(v) { while (sh.rows[r - 1].length < c) sh.rows[r - 1].push(''); sh.rows[r - 1][c - 1] = v; }
      };
    }
  });
  const tokyo = mkSheet([
    ['', 'イベント'], ['', '案件項目'],
    ['iD', '案件名', 'Dev', '代理店', '営業担当', 'デザイン'],
    ['T838', 'プレミストクラブ 特設物件LP', 'ダイワハウス', '', '与那嶺', '増満'],
    ['T839', 'GM松濤　映像', '積水ハウス', '', '吉岡', ''],
    ['T840', '', '', '', '', ''],
    ['T841', '', '', '', '既存', '']
  ]);
  const fuk = mkSheet([['', ''], ['', ''], ['', '案件名', '制作内容', 'Dev', '代理店', '営業担当'], ['F1074', '', '', '', '', '']]);
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => ({ '東京': tokyo, '福岡・大阪': fuk })[n] || null }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ setMimeType() { return JSON.parse(t); } }) }
  };
  vm.createContext(ctx);
  vm.runInContext(PS.gasScript('tk'), ctx);
  const get = (p) => ctx.doGet({ parameter: { token: 'tk', ...p } });
  assert.strictEqual(get({ token: 'x' }).ok, false);
  assert.strictEqual(get({}).v, PS.PS_VERSION);
  // 空行に書き込み(案件名・Dev・営業担当)
  let r = get({ action: 'add', code: 'T840', name: '新案件', client: '三井', sales: '福永' });
  assert.ok(r.ok && r.row === 6, JSON.stringify(r));
  assert.deepStrictEqual(tokyo.rows[5].slice(0, 5), ['T840', '新案件', '三井', '', '福永']);
  // 同じ内容で再実行 → already
  assert.ok(get({ action: 'add', code: 'T840', name: '新案件' }).already);
  // 別の名前が入っている番号 → エラー(上書きしない)
  r = get({ action: 'add', code: 'T839', name: '別案件' });
  assert.ok(!r.ok && /使われています/.test(r.error));
  assert.strictEqual(tokyo.rows[4][1], 'GM松濤　映像');
  // 同名が別番号 → force なしはエラー
  r = get({ action: 'add', code: 'T841', name: 'GM松濤 映像' });
  assert.ok(!r.ok && r.dupName);
  // force あり、入力済みの営業担当は上書きしない
  r = get({ action: 'add', code: 'T841', name: 'GM松濤 映像2', sales: '山岡', force: '1' });
  assert.ok(r.ok); assert.strictEqual(tokyo.rows[6][4], '既存'); assert.deepStrictEqual(r.wrote, ['案件名']);
  // 行が無い番号 → エラー(行を追加しない)
  r = get({ action: 'add', code: 'T999', name: 'x' });
  assert.ok(!r.ok && r.noRow); assert.strictEqual(tokyo.rows.length, 7);
  // 福岡・大阪は見出しの列位置が違う(Dev=D, 営業担当=F)
  r = get({ action: 'add', code: 'F1074', name: '福岡案件', client: 'C社', sales: '松尾' });
  assert.ok(r.ok); assert.deepStrictEqual(fuk.rows[3], ['F1074', '福岡案件', '', 'C社', '', '松尾']);
  // T/F以外は対象外
  assert.ok(!get({ action: 'add', code: 'X1', name: 'x' }).ok);
}
assert.strictEqual(PS.addUrl('https://script.google.com/macros/s/a/exec', 't', { code: 'IKIIKI0001', name: 'x' }), null);
assert.ok(/action=add&code=T840&name=%E6%96%B0&client=&sales=A%E3%83%BBB&force=1$/.test(PS.addUrl('https://script.google.com/macros/s/a/exec', 't', { code: 't840', name: '新', sales: ['A', 'B'], force: true })));
console.log('projectSheet GAS write ok');
