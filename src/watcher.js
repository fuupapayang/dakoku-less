'use strict';
/**
 * フォルダ監視方式の作業ログ取得(アクセシビリティ不要)。
 * 案件フォルダの親ディレクトリ(または案件フォルダ自体)を監視し、
 * 変更されたファイルのパスに含まれる「F599_案件名」フォルダから案件を判定する。
 *
 * 2系統で検知する:
 *  1) fs.watch(recursive) … ローカルディスクで即時検知(低負荷)
 *  2) ポーリング(定期スキャン) … NAS/SMBやDropbox/Box/Google Drive等の
 *     クラウド・ネットワークドライブでもmtimeの変化で検知(fs.watchが無反応な環境の保険)
 *
 * プライバシー: ファイルの中身は一切読まない。使うのはパス(フォルダ名)と更新時刻のみ。
 */
const fs = require('fs');
const path = require('path');

const IGNORE_SEG = /^(\.|node_modules$|\.git$|\.tmp$|__MACOSX$)/;
const IGNORE_FILE = /(^~\$|\.tmp$|\.crdownload$|\.download$|\.DS_Store$|\.swp$|^\.~lock)/i;
const POLL_MS = 20 * 1000;   // ポーリング間隔
const MAX_ENTRIES = 20000;   // 1スキャンあたりの走査上限(巨大ドライブ対策)
const MAX_DEPTH = 5;

class Watcher {
  /** @param onHit (folderName, fullPath) => void */
  constructor(onHit) {
    this.onHit = onHit;
    this.watchers = [];
    this.roots = [];
    this.recentByFolder = new Map();
    this.pollTimer = null;
    this.lastScan = Date.now();
    this.lastHitAt = 0;   // 最終検知時刻(UI表示用)
    this.mode = 'idle';
  }

  start(roots) {
    this.stop();
    this.roots = (Array.isArray(roots) ? roots : []).filter(r => r && fs.existsSync(r));
    if (!this.roots.length) { this.mode = 'idle'; return false; }
    // 1) fs.watch(recursive)
    for (const root of this.roots) {
      try {
        const w = fs.watch(root, { recursive: true }, (evt, fname) => this._onEvent(root, fname));
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (e) { /* recursive非対応環境はポーリングに委ねる */ }
    }
    // 2) ポーリング(常時併用 ― クラウド/ネットワークドライブの保険)
    this.lastScan = Date.now();
    this.pollTimer = setInterval(() => this._poll(), POLL_MS);
    this.mode = this.watchers.length ? 'watch+poll' : 'poll';
    return true;
  }

  _hit(folder, full) {
    const now = Date.now();
    if (now - (this.recentByFolder.get(folder) || 0) < 5000) return;
    this.recentByFolder.set(folder, now);
    this.lastHitAt = now;
    try { this.onHit(folder, full); } catch (_) {}
  }

  _onEvent(root, fname) {
    if (!fname) return;
    const full = path.join(root, String(fname));
    if (IGNORE_FILE.test(path.basename(String(fname)))) return;
    // 絶対パスで判定 → 親フォルダ選択でも案件フォルダ自体の選択でもコードを拾える
    const folder = Watcher.projectFolderIn(full);
    if (folder) this._hit(folder, full);
  }

  /** ポーリング: 前回スキャン以降に更新されたファイルを探し、案件フォルダなら検知 */
  _poll() {
    const since = this.lastScan - 3000; // 取りこぼし防止に3秒バッファ
    const now = Date.now();
    let scanned = 0;
    const walk = (dir, depth) => {
      if (depth > MAX_DEPTH || scanned > MAX_ENTRIES) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        if (scanned > MAX_ENTRIES) return;
        scanned++;
        if (IGNORE_SEG.test(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full, depth + 1); continue; }
        if (IGNORE_FILE.test(ent.name)) continue;
        let st; try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.mtimeMs >= since) {
          const folder = Watcher.projectFolderIn(full);
          if (folder) this._hit(folder, full);
        }
      }
    };
    for (const root of this.roots) walk(root, 0);
    this.lastScan = now;
  }

  /** パス文字列から最初の「CODE_名称」フォルダ名を返す(なければnull) */
  static projectFolderIn(p) {
    for (const seg of String(p).split(/[\\/]+/)) {
      if (/^[A-Z]+\d+_/.test(seg)) return seg;
    }
    return null;
  }

  status() {
    return { mode: this.mode, roots: this.roots.length, lastHitAt: this.lastHitAt };
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch (_) {} }
    this.watchers = [];
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.mode = 'idle';
  }
}

module.exports = Watcher;
