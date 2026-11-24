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
