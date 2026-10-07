'use strict';
/**
 * Firebase(Firestore) チーム同期 — REST API利用(SDK不要)
 *
 * 共有するもの(いずれも集計・辞書のみ。タイトルや生ログは送信しない):
 *  - teams/{team}/meta/projects     … 案件マスター(キーワードはメンバー間でユニオン)
 *  - teams/{team}/summary/{member}  … 各メンバーの前月1日以降の勤怠+案件別分数+案件記録の設定状況
 *  - teams/{team}/dict/{member}     … 各メンバーの学習統計(語句→案件回数)
 *  - teams/{team}/reviews/{member}  … 管理者の承認/差し戻し
 *
 * 前提: Firestoreを「テストモード」または適切なルールで作成しておくこと。
 */

const { splitCollisions } = require('./collisions');

const BASE = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;

/* ---- JSON <-> Firestore Value 変換 ---- */
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  const fields = {};
  for (const [k, val] of Object.entries(v)) fields[k] = enc(val);
  return { mapValue: { fields } };
}
function dec(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) o[k] = dec(val);
    return o;
  }
  return null;
}
function encDoc(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = enc(v);
  return { fields };
}
function decDoc(doc) {
  const o = {};
  for (const [k, v] of Object.entries(doc.fields || {})) o[k] = dec(v);
  return o;
}

/** バージョン文字列の比較(a<b: 負, 等しい: 0, a>b: 正) */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * バージョンを同期しない旧版(〜v0.13.1)のメンバーは、同期項目の有無からおおまかに推定する
 *  categoryMin あり → v0.13.0〜0.13.1 / privateMin あり → v0.12 / どちらもなし → v0.11以前
 */
function inferLegacyVersion(days) {
  const all = Object.values(days || {});
  if (all.some(d => d && 'categoryMin' in d)) return 'v0.13.0〜0.13.1';
  if (all.some(d => d && 'privateMin' in d)) return 'v0.12';
  return 'v0.11以前';
}

/** サマリーの同期開始日(前月1日, 'YYYY-MM-DD'。ローカル時刻基準) */
function summaryFromKey(now = Date.now()) {
  const d = new Date(now);
  const m = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-01`;
}

/** 案件別分数を小数1桁に丸め、0.05分未満(丸めて0)の項目は落とす */
function roundMinMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const r = Math.round((Number(v) || 0) * 10) / 10;
    if (r >= 0.1) out[k] = r;
  }
  return out;
}

/** 案件記録の設定状況 { trackWork, titleDetect, watchRoots, rootsMissing } */
function normTracking(t) {
  t = t || {};
  const out = {
    trackWork: !!t.trackWork,
    titleDetect: !!t.titleDetect,
    watchRoots: Number(t.watchRoots) || 0,
    rootsMissing: Number(t.rootsMissing) || 0
  };
  // 制作担当なのに案件フォルダが無い件数とコード(最大20件)。判定できないとき(未接続など)は送らない
  if (t.missingFolders != null) {
    out.missingFolders = Math.max(0, Number(t.missingFolders) || 0);
    out.missingFolderCodes = (Array.isArray(t.missingFolderCodes) ? t.missingFolderCodes : [])
      .map(c => String(c).slice(0, 20)).filter(Boolean).slice(0, 20);
  }
  return out;
}

class Sync {
  /** @param cfg () => ({projectId, apiKey, teamId, memberId, userName, enabled}) */
  constructor(cfg) {
    this.cfg = cfg;
    this.status = { state: 'idle', lastSync: null, error: null, members: 0, auth: 'none' };
    this._tok = null;
    this._tokExp = 0;
  }

  /**
   * 匿名認証トークン(Firebase Authentication)。
   * コンソールで「匿名」プロバイダを有効にすると本番ルールで運用できる。
   * 無効な場合はnullを返し、未認証で続行(テストモード運用)。
   */
  async token() {
    const c = this.cfg();
    if (!c || !c.apiKey) return null;
    if (this._tok && Date.now() < this._tokExp - 5 * 60000) return this._tok;
    try {
      const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${c.apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
      );
      if (!res.ok) { this._tok = null; this.status.auth = 'disabled'; return null; }
      const j = await res.json();
      this._tok = j.idToken;
      this._tokExp = Date.now() + Number(j.expiresIn || 3600) * 1000;
      this.status.auth = 'anonymous';
      return this._tok;
    } catch (e) { this.status.auth = 'error'; return null; }
  }

  enabled() {
    const c = this.cfg();
    return !!(c && c.enabled && c.projectId && c.apiKey && c.teamId && c.memberId);
  }

  url(path) {
    const c = this.cfg();
    return `${BASE(c.projectId)}/teams/${encodeURIComponent(c.teamId)}/${path}?key=${c.apiKey}`;
  }

  async req(method, path, body, extraQuery = '') {
    const c = this.cfg();
    const u = `${BASE(c.projectId)}/teams/${encodeURIComponent(c.teamId)}/${path}?key=${c.apiKey}${extraQuery}`;
    const headers = { 'Content-Type': 'application/json' };
    const tok = await this.token();
    if (tok) headers['Authorization'] = `Bearer ${tok}`;
    const res = await fetch(u, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 401) {
      throw new Error(`アクセス拒否(HTTP ${res.status})。Firestoreルールが本番用の場合は、Firebaseコンソール → Authentication → ログイン方法 で「匿名」を有効にしてください`);
    }
    if (res.status === 429) {
      const err = new Error('Firebase無料枠の1日の上限に達しました(RESOURCE_EXHAUSTED)。しばらく同期を控えます。翌日の上限リセットで自動回復します。');
      err.quota = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Firestore ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** 前回送信内容と変化があるかを判定(無駄な書き込みを避けて無料枠を節約) */
  _changed(key, obj) {
    const h = JSON.stringify(obj);
    if (!this._hashes) this._hashes = {};
    if (this._hashes[key] === h) return false;
    this._hashes[key] = h;
    return true;
  }

  async getDoc(path) {
    const d = await this.req('GET', path);
    return d ? decDoc(d) : null;
  }

  async setDoc(path, obj) {
    return this.req('PATCH', path, encDoc(obj));
  }

  async listDocs(path) {
    const out = [];
    let pageToken = '';
    do {
      const r = await this.req('GET', path, null, pageToken ? `&pageToken=${pageToken}` : '&pageSize=100');
      if (!r) break;
      for (const d of r.documents || []) {
        out.push({ id: d.name.split('/').pop(), data: decDoc(d) });
      }
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  /* ---- push ---- */

  /**
   * 案件マスター: リモートとマージ。
   * ★重要: 端末ごとに採番されるid(p1,p2..)は衝突するため、案件コードを一意キーにして統合する。
   * これによりメンバー間・端末間で案件が消えなくなる。コードが無い案件のみidで区別。
   * 同一コードはリモート側のidを正(canonical)として揃え、キーワードはユニオンする。
   */
  async syncProjects(localProjects) {
    const remote = (await this.getDoc('meta/projects')) || { projects: [] };
    const byKey = new Map();
    const keyOf = (p) => {
      const code = String(p.code || '').trim().toUpperCase();
      return code ? 'C:' + code : 'I:' + p.id;
    };
    const add = (p) => {
      const key = keyOf(p);
      const cur = byKey.get(key);
      if (!cur) { byKey.set(key, { ...p }); return; }
      const newer = (p.updatedAt || p.createdAt || 0) >= (cur.updatedAt || cur.createdAt || 0) ? p : cur;
      byKey.set(key, {
        ...newer,
        id: cur.id, // 先に入った側(リモート優先)のidを正とする
        // キーワードは「新しく編集した側」を採用(合算しない)。手で消した削除が反映され、混入も除去できる
        keywords: [...new Set(newer.keywords || [])]
      });
    };
    for (const p of remote.projects || []) add(p);   // 先にリモート → idの基準
    for (const p of localProjects) add(p);            // ローカルを統合
    // 別コードの案件が同じIDを持っていたら(旧連番IDの衝突)コード由来のIDに振り直す。
    // 古いバージョンの端末が衝突IDを送ってきても、ここで毎回分離されるので再発しない。
    const merged = splitCollisions([...byKey.values()]).projects;
    // 内容に変化があるときだけ書き込む(無料枠の節約)
    if (this._changed('projects', merged)) {
      await this.setDoc('meta/projects', { projects: merged, updatedAt: Date.now() });
    }
    return merged;
  }

  /**
   * 自分の勤怠サマリー(前月1日〜今日)を1ドキュメントでpush。
   * 以前は直近35日だったため、月の5日頃を過ぎると前月の月初分が管理者側で欠けていた。
   * 前月1日起点なら前月全体が常に揃い、最大でも約62日分に収まる。
   */
  async pushSummary(days, projectsMeta, rules = [], now = Date.now()) {
    const c = this.cfg();
    const fromKey = summaryFromKey(now);
    const out = {};
    for (const [key, d] of Object.entries(days)) {
      if (String(key) < fromKey) continue;
      const est = d.correction || d.estimation;
      if (!est || est.start == null) continue;
      out[key] = {
        start: est.start, end: est.end,
        workMin: est.workMin || 0, breakMin: est.breakMin || 0,
        confidence: d.estimation ? d.estimation.confidence : 'LOW',
        status: d.status, auto: !!(d.submitted && d.submitted.auto),
        meetingMin: Math.round(d.meetingMin || 0),
        privateMin: Math.round(d.privateMin || 0),
        noEvidenceMin: Math.round(d.noEvidenceMin || 0),
        estWorkMin: d.estimation ? Math.round(d.estimation.workMin || 0) : 0,
        corrDeltaMin: d.correction && d.estimation ? Math.round((d.correction.workMin || 0) - (d.estimation.workMin || 0)) : 0,
        needsApproval: !!(d.submitted && d.submitted.needsApproval),
        // 15秒サンプリングの端数を案件×日ごとに整数へ丸めると小さな工数が消えるため、小数1桁で送る
        projectMin: roundMinMap(d.projectMin),
        // 案件外の予定区分の時間 { internal: 社内会議(案件外), shoot: 撮影・ロケハン }
        categoryMin: Object.fromEntries(
          Object.entries(d.categoryMin || {}).map(([k, v]) => [k, Math.round(v)])
        )
      };
    }
    const workRules = (rules || []).filter(r => r.enabled !== false && r.treatAs === 'work')
      .map(r => ({ label: r.label, fromMin: r.fromMin, toMin: r.toMin, weekday: r.weekday == null ? null : r.weekday }));
    const payload = {
      name: c.userName, recoruUserId: c.recoruUserId || '', workRules,
      appVersion: c.appVersion || '', platform: c.platform || '', arch: c.arch || '',
      // 案件記録の設定状況(管理者が「案件の分数が出ない理由」を確認するため)
      tracking: normTracking(c.tracking),
      days: out
    };
    if (this._changed('summary', payload)) {
      await this.setDoc(`summary/${c.memberId}`, { ...payload, updatedAt: Date.now() });
    }
  }

  /** 学習統計をpush(語句→案件回数のみ) */
  async pushDict(stats) {
    const c = this.cfg();
    const str = JSON.stringify(stats);
    if (this._changed('dict', str)) {
      await this.setDoc(`dict/${c.memberId}`, { stats: str, updatedAt: Date.now() });
    }
  }

  /** 管理者の承認/差し戻しをpush */
  async pushReview(memberId, dateKey, status) {
    const cur = (await this.getDoc(`reviews/${memberId}`)) || {};
    cur[dateKey] = status;
    cur.updatedAt = Date.now();
    await this.setDoc(`reviews/${memberId}`, cur);
  }

  /* ---- pull ---- */

  /** チーム全体を取得: メンバーサマリー・辞書・案件・自分宛レビュー */
  async pullAll() {
    const c = this.cfg();
    const [summaries, dicts, projectsDoc, myReview] = await Promise.all([
      this.listDocs('summary'),
      this.listDocs('dict'),
      this.getDoc('meta/projects'),
      this.getDoc(`reviews/${c.memberId}`)
    ]);
    const members = summaries.map(s => ({
      id: s.id, name: s.data.name || s.id, recoruUserId: s.data.recoruUserId || '', workRules: s.data.workRules || [], days: s.data.days || {}, updatedAt: s.data.updatedAt,
      appVersion: s.data.appVersion || '', platform: s.data.platform || '', arch: s.data.arch || '',
      versionLabel: s.data.appVersion ? 'v' + s.data.appVersion : inferLegacyVersion(s.data.days),
      tracking: s.data.tracking || null // 旧版(未送信)は null
    }));
    const teamStats = [];
    for (const d of dicts) {
      if (d.id === c.memberId) continue;
      try { teamStats.push(JSON.parse(d.data.stats || '{}')); } catch (_) {}
    }
    this.status.members = members.length;
    return {
      members,
      teamStats,
      projects: projectsDoc ? projectsDoc.projects || [] : [],
      myReview: myReview || {}
    };
  }
}

module.exports = { Sync, enc, dec, encDoc, decDoc, compareVersions, inferLegacyVersion, summaryFromKey, roundMinMap, normTracking };
