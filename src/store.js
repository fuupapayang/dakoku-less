'use strict';
const fs = require('fs');
const path = require('path');
const collisionsLib = require('./collisions');

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
        notifications: true, // デスクトップ通知
        hourlyRate: 5000,    // 原価単価(円/h) 収益性計算用
        travelAsWork: true,  // カレンダーの「移動・外出」予定を稼働として計上
        detectMeetings: true,// オンライン会議(Teams/Zoom/Meet等)を会議として記録
        recoruUserId: '',    // レコルCSV用のユーザID(空なら表示名)
        sheetsUrl: '',       // Google Apps Script ウェブアプリの /exec URL
        sheetsToken: '',     // 連携用の合言葉(GAS側と一致)
        autoExportSheets: false, // 毎月自動で書き出す
        lastExportMonth: '', // 最後に自動書き出しした月 YYYY-MM
        trackWork: false,    // 案件トラッキング(オプトイン)
        titleDetect: false,  // ウィンドウタイトル判定(active-win使用・macOSは権限要求)。既定オフ
        folderDetect: false, // 【廃止】旧アクセシビリティ方式。互換のため残置(常にfalse)
        folderStickyMin: 30, // フォルダ監視の継続時間(分): 最後のファイル更新からこの間は同じ案件に継続計上
        watchRoots: [],      // フォルダ監視の親ディレクトリ(署名不要・権限ダイアログなし)
        sync: {              // 現在アクティブなチームの接続情報(teamProfilesから反映)
          enabled: false, projectId: '', apiKey: '', teamId: '', memberId: ''
        },
        teamProfiles: [],    // 複数チーム [{id,label,projectId,apiKey,teamId,memberId}]
        activeTeamId: ''     // アクティブなチームプロファイルid
      },
      days: {},        // { 'YYYY-MM-DD': dayRecord }
      rules: [],       // マイルール
      projects: [],    // 案件マスター [{id,code,name,client,sales[],makers[],boxUrl,status,keywords,active}]
      calEvents: [],   // 共有カレンダー [{id,date,sMin,eMin,title,projectId,members,createdBy,updatedAt,deleted}]
      learnStats: { tokens: {}, slots: {}, totals: {}, n: 0 }, // 動向学習(語句・時間帯→案件回数のみ)
      remoteTeam: null, // Firebase同期で取得したチームの実データ
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
        if (!this.data.settings.sync) this.data.settings.sync = { enabled: false, projectId: '', apiKey: '', teamId: '', memberId: '' };
        if (!this.data.settings.watchRoots) this.data.settings.watchRoots = [];
        if (this.data.settings.titleDetect == null) this.data.settings.titleDetect = false;
        if (this.data.settings.folderStickyMin == null) this.data.settings.folderStickyMin = 30;
        this.data.settings.folderDetect = false; // 旧方式は完全無効化
        if (!this.data.learnStats) this.data.learnStats = { tokens: {}, slots: {}, totals: {}, n: 0 };
        if (!this.data.calEvents) this.data.calEvents = [];
        for (const p of this.data.projects || []) {
          if (!p.sales) p.sales = [];
          if (!p.makers) p.makers = [];
          if (!p.status) p.status = 'active';
          if (p.client == null) p.client = '';
          if (p.boxUrl == null) p.boxUrl = '';
          if (p.budgetHours == null) p.budgetHours = 0;
          if (p.estimateAmount == null) p.estimateAmount = 0;
        }
        // 旧バージョンのデータを補完
        for (const d of Object.values(this.data.days || {})) {
          if (!d.projectMin) d.projectMin = {};
          if (!d.unclassified) d.unclassified = [];
          if (d.meetingMin == null) d.meetingMin = 0;
        }
        // 複数チームへの移行: 旧単一sync設定を1つのプロファイルに変換
        if (!Array.isArray(this.data.settings.teamProfiles)) this.data.settings.teamProfiles = [];
        if (this.data.settings.activeTeamId == null) this.data.settings.activeTeamId = '';
        const sy = this.data.settings.sync || {};
        if (this.data.settings.teamProfiles.length === 0 && sy.projectId) {
          const pid = 'tp' + Math.random().toString(36).slice(2, 9);
          this.data.settings.teamProfiles.push({
            id: pid, label: sy.teamId || 'マイチーム',
            projectId: sy.projectId, apiKey: sy.apiKey, teamId: sy.teamId,
            memberId: sy.memberId || ('m' + Math.random().toString(36).slice(2, 10))
          });
          if (sy.enabled) this.data.settings.activeTeamId = pid;
        }
        if (this.data.settings.travelAsWork == null) this.data.settings.travelAsWork = true;
        if (this.data.settings.detectMeetings == null) this.data.settings.detectMeetings = true;
        if (this.data.settings.recoruUserId == null) this.data.settings.recoruUserId = '';
        if (this.data.settings.sheetsUrl == null) this.data.settings.sheetsUrl = '';
        if (this.data.settings.sheetsToken == null) this.data.settings.sheetsToken = '';
        if (this.data.settings.autoExportSheets == null) this.data.settings.autoExportSheets = false;
        if (this.data.settings.lastExportMonth == null) this.data.settings.lastExportMonth = '';
        // 同一コードの重複案件を統合(過去のID衝突の後始末)
        this.dedupeProjects();
        this.lastRepair = this.repairIdCollisions();
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
        meetingMin: 0,       // オンライン会議の分数
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

  /**
   * 同一コードの重複案件を1つに統合(過去のID衝突の後始末)。
   * 工数(projectMin)・カレンダー(projectId)・学習(totals)の参照を統合先へ付け替える。
   */
  dedupeProjects() {
    const seen = new Map();  // CODE -> canonical project
    const remap = {};        // 重複id -> canonical id
    const kept = [];
    for (const p of this.data.projects || []) {
      const code = String(p.code || '').trim().toUpperCase();
      if (!code) { kept.push(p); continue; }
      const canon = seen.get(code);
      if (!canon) { seen.set(code, p); kept.push(p); continue; }
      remap[p.id] = canon.id;
      canon.keywords = [...new Set([...(canon.keywords || []), ...(p.keywords || [])])];
      if (!canon.client && p.client) canon.client = p.client;
      if ((!canon.sales || !canon.sales.length) && p.sales && p.sales.length) canon.sales = p.sales;
      if ((!canon.makers || !canon.makers.length) && p.makers && p.makers.length) canon.makers = p.makers;
      if (!canon.boxUrl && p.boxUrl) canon.boxUrl = p.boxUrl;
      if (!canon.budgetHours && p.budgetHours) canon.budgetHours = p.budgetHours;
      if (!canon.estimateAmount && p.estimateAmount) canon.estimateAmount = p.estimateAmount;
      if ((p.status || 'active') !== 'active') canon.status = canon.status; // 稼働中を優先で維持
    }
    if (!Object.keys(remap).length) return remap;
    this.data.projects = kept;
    for (const d of Object.values(this.data.days || {})) {
      if (!d.projectMin) continue;
      for (const [oid, nid] of Object.entries(remap)) {
        if (d.projectMin[oid] != null) {
          d.projectMin[nid] = (d.projectMin[nid] || 0) + d.projectMin[oid];
          delete d.projectMin[oid];
        }
      }
    }
    for (const ev of this.data.calEvents || []) {
      if (ev.projectId && remap[ev.projectId]) ev.projectId = remap[ev.projectId];
    }
    const ls = this.data.learnStats;
    if (ls && ls.totals) for (const [oid, nid] of Object.entries(remap)) {
      if (ls.totals[oid] != null) { ls.totals[nid] = (ls.totals[nid] || 0) + ls.totals[oid]; delete ls.totals[oid]; }
    }
    return remap;
  }

  /**
   * 案件IDの衝突(旧連番IDの名残)を修復。衝突が無ければ何もしない。
   * @returns {{moved:number, review:number, ids:number}|null}
   */
  repairIdCollisions(collisions) {
    if (!collisions) {
      const r = collisionsLib.splitCollisions(this.data.projects || []);
      if (!Object.keys(r.collisions).length) return null;
      this.data.projects = r.projects;
      collisions = r.collisions;
    }
    const res = collisionsLib.repairData(this.data, collisions, this.data.settings.userName);
    this.save();
    return { ...res, ids: Object.keys(collisions).length };
  }

  addProject(p) {
    // 端末をまたいで衝突しないグローバル一意ID(旧: 連番p1,p2は衝突の原因だった)
    const proj = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), active: true, keywords: [],
      client: '', sales: [], makers: [], boxUrl: '', status: 'active',
      budgetHours: 0, estimateAmount: 0, alert80: false, alert100: false,
      createdAt: Date.now(), updatedAt: Date.now(),
      ...p, code: String(p.code || '').trim(), name: String(p.name || '').trim()
    };
    this.data.projects.push(proj);
    this.save();
    return proj;
  }
}

module.exports = Store;
