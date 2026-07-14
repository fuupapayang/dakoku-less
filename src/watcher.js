'use strict';
/**
 * フォルダ監視方式の作業ログ取得(アクセシビリティ不要)。
 * 案件フォルダの親ディレクトリを fs.watch({recursive}) で監視し、
 * 変更されたファイルのパスに含まれる「F599_案件名」フォルダから案件を判定する。
 *
 * プライバシー: ファイルの中身は一切読まない。使うのはパス(フォルダ名)のみで、
 * 判定に使ったパスは保存しない。残るのは「案件×分数」だけ。
 */
const fs = require('fs');
const path = require('path');

// 監視対象外(ノイズ源)
const IGNORE_SEG = /^(\.|node_modules$|\.git$|\.tmp$|__MACOSX$)/;
const IGNORE_FILE = /(^~\$|\.tmp$|\.crdownload$|\.download$|\.DS_Store$|\.swp$|^\.~lock)/i;

class Watcher {
  /**
   * @param onHit (folderName:string, fullPath:string) => void  変更検知コールバック
   */
  constructor(onHit) {
    this.onHit = onHit;
    this.watchers = [];
    this.roots = [];
    this.recentByFolder = new Map(); // フォルダ名 -> 最終検知ts(デバウンス)
  }

  /** 親フォルダ配列を監視開始(既存監視は破棄) */
  start(roots) {
    this.stop();
    this.roots = Array.isArray(roots) ? roots.filter(Boolean) : [];
    for (const root of this.roots) {
      try {
        if (!fs.existsSync(root)) continue;
        // まず再帰監視を試す(macOSはネイティブ対応、Windowsも対応)
        const w = fs.watch(root, { recursive: true }, (evt, fname) => this._onEvent(root, fname));
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (e) {
        // recursive非対応環境: 直下の各案件フォルダを個別監視にフォールバック
        this._watchShallow(root);
      }
    }
    return this.watchers.length > 0;
  }

  _watchShallow(root) {
    try {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (!ent.isDirectory() || IGNORE_SEG.test(ent.name)) continue;
        const sub = path.join(root, ent.name);
        try {
          const w = fs.watch(sub, { recursive: true }, (evt, fname) =>
            this._onEvent(root, path.join(ent.name, fname || '')));
          w.on('error', () => {});
          this.watchers.push(w);
        } catch (_) {}
      }
    } catch (_) {}
  }

  _onEvent(root, fname) {
    if (!fname) return;
    const rel = String(fname);
    const base = path.basename(rel);
    if (IGNORE_FILE.test(base)) return;
    // パスの各セグメントから「大文字コード_名称」フォルダを探す
    const folder = Watcher.projectFolderIn(rel);
    if (!folder) return;
    // 同一フォルダは5秒デバウンス(保存の連打を1回に)
    const now = Date.now();
    if (now - (this.recentByFolder.get(folder) || 0) < 5000) return;
    this.recentByFolder.set(folder, now);
    try { this.onHit(folder, path.join(root, rel)); } catch (_) {}
  }

  /** パス文字列から最初の「CODE_名称」フォルダ名を返す(なければnull) */
  static projectFolderIn(p) {
    for (const seg of String(p).split(/[\\/]+/)) {
      if (/^[A-Z]+\d+_/.test(seg)) return seg;
    }
    return null;
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch (_) {} }
    this.watchers = [];
  }
}

module.exports = Watcher;
