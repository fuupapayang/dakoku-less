'use strict';
const fs = require('fs');
const path = require('path');

/**
 * シンプルなJSON永続化ストア。
 * プライバシー設計: 保存されるのは「何時から何時まで稼働していたか」の
 * 分単位インターバルと推定結果のみ。アプリ名・ウィンドウタイトル・
 * キー入力内容などは一切収集・保存しない。
 */
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'dakoku-less-data.json');
    this.data = {
      settings: {
        submitMode: 'moderate',      // auto | moderate | strict | manual
        breakThresholdMin: 15,
        ambiguousMin: 8,
        mergeGapMin: 3,
        idleThresholdSec: 90,
        dayStartHour: 4,
        userName: 'あなた',
        autoLaunch: false,
        trackWork: false     // 案件トラッキング(オプトイン)
      },
      days: {},        // { 'YYYY-MM-DD': dayRecord }
      rules: [],       // マイルール
      projects: [],    // 案件マスター [{id,code,name,keywords,active}]
      team: null,      // 管理者ビュー用デモデータ
      ruleSeq: 1,
      projSeq: 1
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...raw, settings: { ...this.data.settings, ...(raw.settings || {}) } };
        // 旧バージョンのデータを補完
        for (const d of Object.values(this.data.days || {})) {
          if (!d.projectMin) d.projectMin = {};
          if (!d.unclassified) d.unclassified = [];
        }
      }
    } catch (e) { console.error('store load error', e); }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('store save error', e); }
  }

  day(key) {
    if (!this.data.days[key]) {
      this.data.days[key] = {
        date: key,
        intervals: [],       // [{s,e}] 分粒度の稼働区間(結果のみ)
        calendar: [],        // [{s,e,summary}] ICSインポート分
        estimation: null,
        correction: null,    // ユーザー修正 {start,end,breaks:[{s,e,label}],workMin}
        status: 'recording', // recording | pending | submitted | approved | rejected
        submittedAt: null,
        events: [],          // 監査ログ [{t,msg}] 例: 始業検知など
        projectMin: {},      // 案件別の作業分数 {projectId: min}
        unclassified: []     // 未分類ブロック [{s,e,tokens}] tokensは候補語上位のみ
      };
    }
    return this.data.days[key];
  }

  addRule(rule) {
    const r = { id: 'r' + this.data.ruleSeq++, enabled: true, createdAt: Date.now(), ...rule };
    this.data.rules.push(r);
    this.save();
    return r;
  }

  addProject(p) {
    const proj = {
      id: 'p' + this.data.projSeq++, active: true, keywords: [], createdAt: Date.now(),
      ...p, code: String(p.code || '').trim(), name: String(p.name || '').trim()
    };
    this.data.projects.push(proj);
    this.save();
    return proj;
  }
}

module.exports = Store;
