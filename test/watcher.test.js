'use strict';
const assert = require('assert');
const Watcher = require('../src/watcher');

// projectFolderIn: パスから CODE_名称 フォルダを抽出
assert.strictEqual(Watcher.projectFolderIn('/Users/black/制作/F599_D&Dホールディングス/見積.psd'), 'F599_D&Dホールディングス');
assert.strictEqual(Watcher.projectFolderIn('F672_東京メトロ車内ビジョン制作/data/main.ai'), 'F672_東京メトロ車内ビジョン制作');
assert.strictEqual(Watcher.projectFolderIn('T123_案件\\sub\\file.xlsx'), 'T123_案件');
// コード形式でないフォルダは無視
assert.strictEqual(Watcher.projectFolderIn('/Users/black/Downloads/請求書.pdf'), null);
assert.strictEqual(Watcher.projectFolderIn('f599_小文字/file.txt'), null); // 大文字必須
assert.strictEqual(Watcher.projectFolderIn('資料/normal.txt'), null);

// デバウンス動作(同一フォルダは5秒に1回)
let hits = [];
const w = new Watcher((folder) => hits.push(folder));
w._onEvent('/root', 'F599_案件/a.psd');
w._onEvent('/root', 'F599_案件/b.psd'); // 5秒以内 → 無視
assert.strictEqual(hits.length, 1);
assert.strictEqual(hits[0], 'F599_案件');

// 無視ファイルは反応しない
hits = [];
const w2 = new Watcher((f) => hits.push(f));
w2._onEvent('/root', 'F600_案件/.DS_Store');
w2._onEvent('/root', 'F600_案件/~$temp.docx');
assert.strictEqual(hits.length, 0);

console.log('✓ all watcher tests passed');
