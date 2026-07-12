'use strict';
/**
 * Firebase(Firestore) チーム同期 — REST API利用(SDK不要)
 *
 * 共有するもの(いずれも集計・辞書のみ。タイトルや生ログは送信しない):
 *  - teams/{team}/meta/projects     … 案件マスター(キーワードはメンバー間でユニオン)
 *  - teams/{team}/summary/{member}  … 各メンバーの直近35日の勤怠+案件別分数
 *  - teams/{team}/dict/{member}     … 各メンバーの学習統計(語句→案件回数)
 *  - teams/{team}/reviews/{member}  … 管理者の承認/差し戻し
 *
 * 前提: Firestoreを「テストモード」または適切なルールで作成しておくこと。
 */

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

class Sync {
  /** @param cfg () => ({projectId, apiKey, teamId, memberId, userName, enabled}) */
  constructor(cfg) {
    this.cfg = cfg;
    this.status = { state: 'idle', lastSync: null, error: null, members: 0 };
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
    const res = await fetch(u, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
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

  /** 案件マスター: リモートとマージ(キーワードはユニオン、名前等は新しい方) */
  async syncProjects(localProjects) {
    const remote = (await this.getDoc('meta/projects')) || { projects: [] };
    const byId = new Map();
    for (const p of remote.projects || []) byId.set(p.id, p);
    for (const p of localProjects) {
      const r = byId.get(p.id);
      if (!r) { byId.set(p.id, { ...p }); continue; }
      const newer = (p.updatedAt || p.createdAt || 0) >= (r.updatedAt || r.createdAt || 0) ? p : r;
      byId.set(p.id, {
        ...newer,
        keywords: [...new Set([...(r.keywords || []), ...(p.keywords || [])])]
      });
    }
    const merged = [...byId.values()];
    await this.setDoc('meta/projects', { projects: merged, updatedAt: Date.now() });
    return merged;
  }

  /** 自分の勤怠サマリー(直近35日)を1ドキュメントでpush */
  async pushSummary(days, projectsMeta) {
    const c = this.cfg();
    const cutoff = Date.now() - 35 * 86400000;
    const out = {};
    for (const [key, d] of Object.entries(days)) {
      if (new Date(key).getTime() < cutoff) continue;
      const est = d.correction || d.estimation;
      if (!est || est.start == null) continue;
      out[key] = {
        start: est.start, end: est.end,
        workMin: est.workMin || 0, breakMin: est.breakMin || 0,
        confidence: d.estimation ? d.estimation.confidence : 'LOW',
        status: d.status, auto: !!(d.submitted && d.submitted.auto),
        projectMin: Object.fromEntries(
          Object.entries(d.projectMin || {}).map(([k, v]) => [k, Math.round(v)])
        )
      };
    }
    await this.setDoc(`summary/${c.memberId}`, {
      name: c.userName, days: out, updatedAt: Date.now()
    });
  }

  /** 学習統計をpush(語句→案件回数のみ) */
  async pushDict(stats) {
    const c = this.cfg();
    await this.setDoc(`dict/${c.memberId}`, {
      stats: JSON.stringify(stats), updatedAt: Date.now()
    });
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
      id: s.id, name: s.data.name || s.id, days: s.data.days || {}, updatedAt: s.data.updatedAt
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

module.exports = { Sync, enc, dec, encDoc, decDoc };
