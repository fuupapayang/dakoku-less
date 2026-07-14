'use strict';
/* ブラウザデモ用モックAPI: Electronのwindow.apiを置き換え、サンプルデータで全画面を再現 */
(function () {
  const MIN = 60000;
  const now = new Date();
  const dayMs = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayKey = key(now);

  let ruleSeq = 3, projSeq = 3;

  const projects = [
    { id: 'p1', code: 'F000', name: '在庫管理システム刷新', client: '山田商事', sales: ['あなた', '佐藤 美咲'], makers: ['田中 蓮'], boxUrl: 'https://app.box.com/folder/000000001', status: 'active', keywords: ['山田商事', '在庫管理'], budgetHours: 45, estimateAmount: 1500000, active: true, createdAt: Date.now() - 20 * 86400000 },
    { id: 'p2', code: 'T123', name: '勤怠システム導入', client: '鈴木建設', sales: ['佐藤 美咲'], makers: ['高橋 大和'], boxUrl: 'https://app.box.com/folder/000000002', status: 'active', keywords: ['鈴木建設'], budgetHours: 80, estimateAmount: 800000, active: true, createdAt: Date.now() - 15 * 86400000 },
    { id: 'p3', code: 'F001', name: 'ECサイト保守', client: 'ABC商店', sales: ['あなた'], makers: ['田中 蓮'], boxUrl: '', status: 'delivered', keywords: [], budgetHours: 0, estimateAmount: 300000, active: true, createdAt: Date.now() - 40 * 86400000 }
  ];

  const calKey = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return key(d);
  };
  let calSeq = 4;
  const calEvents = [
    { id: 'c1', date: calKey(0), sMin: 840, eMin: 870, title: '定例会議', projectId: 'p1', members: [], createdBy: '佐藤 美咲', updatedAt: 1 },
    { id: 'c2', date: calKey(1), sMin: 600, eMin: 660, title: '先方訪問', projectId: 'p2', members: ['佐藤 美咲', '高橋 大和'], createdBy: '佐藤 美咲', updatedAt: 1 },
    { id: 'c3', date: calKey(3), sMin: 900, eMin: 960, title: '納品', projectId: 'p1', members: [], createdBy: 'あなた', updatedAt: 1 }
  ];

  function makeToday() {
    const s = dayMs(now, 9, 2);
    const b1 = dayMs(now, 12, 10), b2 = dayMs(now, 13, 5);
    const e = Math.max(dayMs(now, 15, 40), b2 + 30 * MIN);
    return {
      date: todayKey,
      intervals: [{ s, e: b1 }, { s: b2, e }],
      calendar: [{ s: dayMs(now, 14, 0), e: dayMs(now, 14, 30), summary: 'F000_定例会議' }],
      estimation: {
        start: s, end: e, workMin: Math.round((e - s - 55 * MIN) / MIN), breakMin: 55,
        confidence: 'STABLE',
        breaks: [{ s: b1, e: b2, kind: 'break', source: '操作の空白(昼休憩と判定)' }],
        segments: [
          { s, e: dayMs(now, 10, 30), kind: 'work', label: '稼働' },
          { s: dayMs(now, 10, 30), e: dayMs(now, 11, 0), kind: 'ambiguous', label: '判定が微妙な空白' },
          { s: dayMs(now, 11, 0), e: b1, kind: 'work', label: '稼働' },
          { s: b1, e: b2, kind: 'break', label: '休憩' },
          { s: b2, e, kind: 'work', label: '稼働' }
        ],
        notes: ['14:00〜14:30 カレンダー予定「F000_定例会議」により稼働扱い'],
        suggestions: [{
          type: 'rule', treatAs: 'exclude', fromMin: 630, toMin: 660, weekday: now.getDay(), label: '移動時間',
          text: '10:30〜11:00 は「移動時間」かもしれません。稼働に含めず申請しますか？'
        }],
        computedAt: Date.now()
      },
      correction: null, status: 'recording', submittedAt: null,
      events: [
        { t: s, msg: '始業を検知(09:02 PC稼働)' },
        { t: b1, msg: '操作の空白を検知(12:10〜)' },
        { t: b2, msg: '稼働を再検知(13:05)' },
        { t: dayMs(now, 14, 0), msg: 'カレンダー予定「F000_定例会議」を稼働に反映' }
      ],
      projectMin: { p1: 190, p2: 85 },
      unclassified: [{
        s: dayMs(now, 13, 5), e: dayMs(now, 13, 50),
        tokens: ['請求書2026', '山田商事', '7月分'], hint: { pid: 'p1', pct: 78 }
      }]
    };
  }

  function makePast(daysAgo, opts) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const s = dayMs(d, 8, 50 + (daysAgo * 7) % 25);
    const e = dayMs(d, 18, 10 + (daysAgo * 11) % 40);
    const workMin = Math.round((e - s) / MIN) - 60;
    return {
      date: key(d), intervals: [{ s, e }], calendar: [],
      estimation: {
        start: s, end: e, workMin, breakMin: 60, confidence: opts.conf,
        breaks: [{ s: dayMs(d, 12, 5), e: dayMs(d, 13, 5), kind: 'break', source: '操作の空白(昼休憩と判定)' }],
        segments: [
          { s, e: dayMs(d, 12, 5), kind: 'work', label: '稼働' },
          { s: dayMs(d, 12, 5), e: dayMs(d, 13, 5), kind: 'break', label: '休憩' },
          { s: dayMs(d, 13, 5), e, kind: 'work', label: '稼働' }
        ],
        notes: [], suggestions: [], computedAt: e
      },
      correction: null, status: opts.status,
      submittedAt: opts.status === 'pending' ? null : e + 3600000,
      submitted: opts.status === 'pending' ? null : { start: s, end: e, workMin, breakMin: 60, auto: opts.auto },
      events: [{ t: s, msg: '始業を検知' }, { t: e, msg: '終業を検知' }],
      projectMin: { p1: Math.round(workMin * 0.6), p2: Math.round(workMin * 0.3) },
      unclassified: []
    };
  }

  const days = { [todayKey]: makeToday() };
  const patterns = [
    { conf: 'STABLE', status: 'approved', auto: true }, { conf: 'STABLE', status: 'approved', auto: true },
    { conf: 'UNSURE', status: 'submitted', auto: false }, { conf: 'STABLE', status: 'submitted', auto: true },
    { conf: 'LOW', status: 'pending', auto: false }, { conf: 'STABLE', status: 'approved', auto: true },
    { conf: 'UNSURE', status: 'approved', auto: true }, { conf: 'STABLE', status: 'rejected', auto: true }
  ];
  let di = 1, pi = 0;
  while (pi < patterns.length) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - di);
    if (d.getDay() !== 0 && d.getDay() !== 6) { days[key(d)] = makePast(di, patterns[pi]); pi++; }
    di++;
  }

  function seedTeam() {
    const members = [
      { id: 'u2', name: '佐藤 美咲', dept: '営業部' }, { id: 'u3', name: '田中 蓮', dept: '開発部' },
      { id: 'u4', name: '鈴木 陽菜', dept: '人事部' }, { id: 'u5', name: '高橋 大和', dept: '開発部' }
    ];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const m of members) {
      m.days = {};
      for (let i = 35; i >= 1; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        if (d.getDay() === 0 || d.getDay() === 6 || rnd() < 0.05) continue;
        const s = dayMs(d, 8, Math.round(rnd() * 90));
        const lenH = 8 + rnd() * 2.5;
        const breakMin = 45 + Math.round(rnd() * 30);
        const workMin = Math.round(lenH * 60 - breakMin);
        const r = rnd();
        const confidence = r < 0.7 ? 'STABLE' : r < 0.9 ? 'UNSURE' : 'LOW';
        const submitted = confidence !== 'LOW' || rnd() < 0.5;
        m.days[key(d)] = {
          start: s, end: s + lenH * 3600000, breakMin, workMin, confidence,
          status: submitted ? (rnd() < 0.6 ? 'approved' : 'submitted') : 'pending',
          discrepancyMin: rnd() < 0.08 ? Math.round(30 + rnd() * 60) : 0,
          auto: submitted && rnd() < 0.8
        };
      }
    }
    return { members, seededAt: Date.now() };
  }

  const state = {
    settings: {
      submitMode: 'moderate', breakThresholdMin: 15, ambiguousMin: 8, mergeGapMin: 3,
      idleThresholdSec: 90, dayStartHour: 4, userName: 'あなた', autoLaunch: true, trackWork: true,
      notifications: true, hourlyRate: 5000,
      sync: { enabled: false, projectId: '', apiKey: '', teamId: '', memberId: 'demo' }
    },
    todayKey, days,
    rules: [
      { id: 'r1', label: '移動時間', treatAs: 'exclude', fromMin: 630, toMin: 660, weekday: 2, enabled: true, createdAt: Date.now() - 5 * 86400000 },
      { id: 'r2', label: '昼休憩(遅め)', treatAs: 'break', fromMin: 780, toMin: 840, weekday: null, enabled: true, createdAt: Date.now() - 3 * 86400000 }
    ],
    projects, calEvents, learnN: 42,
    currentWork: { projectId: 'p1', code: 'F000', name: '山田商事 在庫管理システム', via: 'keyword', app: 'Excel' },
    team: seedTeam(), remoteTeam: null,
    syncStatus: { state: 'idle', lastSync: null, error: null, members: 0 },
    screenPermission: 'granted', recording: true, platform: 'demo'
  };

  const S = () => JSON.parse(JSON.stringify(state));
  const listeners = [];

  window.api = {
    getState: async () => S(),
    updateSettings: async (patch) => { Object.assign(state.settings, patch); return S(); },
    correctDay: async (k, correction) => {
      const day = state.days[k];
      const workMin = Math.round((correction.end - correction.start) / MIN -
        (correction.breaks || []).reduce((a, b) => a + (b.e - b.s) / MIN, 0));
      day.correction = { ...correction, workMin };
      if (day.status === 'submitted' || day.status === 'approved') day.status = 'pending';
      day.events.push({ t: Date.now(), msg: '勤怠を手動修正しました' });
      const added = (correction.breaks || []).length > (day.estimation.breaks || []).length;
      const proposals = added ? [{
        treatAs: 'break', fromMin: 900, toMin: 930, weekday: now.getDay(), label: '休憩',
        text: '休憩を追加する修正を検知しました。次回から似た時間帯に自動適用しますか？'
      }] : [];
      return { proposals, state: S() };
    },
    addRule: async (r) => { state.rules.push({ id: 'r' + ++ruleSeq, enabled: true, createdAt: Date.now(), ...r }); return S(); },
    toggleRule: async (id) => { const r = state.rules.find(r => r.id === id); if (r) r.enabled = !r.enabled; return S(); },
    deleteRule: async (id) => { state.rules = state.rules.filter(r => r.id !== id); return S(); },
    submitDay: async (k) => {
      const day = state.days[k];
      const est = day.correction || day.estimation;
      if (!est || est.start == null) return { ok: false, error: '提出できる推定結果がありません' };
      day.status = 'submitted'; day.submittedAt = Date.now();
      day.submitted = { start: est.start, end: est.end, workMin: est.workMin, breakMin: est.breakMin, auto: false };
      day.events.push({ t: Date.now(), msg: '手動で提出しました' });
      return { ok: true };
    },
    addProject: async (p) => {
      if (!/^[A-Z]+\d+$/.test(p.code)) return { error: '案件コードは「大文字英字+数字」(例: F000, T123)で入力してください' };
      if (state.projects.some(x => x.code === p.code)) return { error: `案件コード ${p.code} は既に登録されています` };
      state.projects.push({ id: 'p' + ++projSeq, active: true, keywords: [], client: '', sales: [], makers: [], boxUrl: '', status: 'active', createdAt: Date.now(), ...p });
      return S();
    },
    addCalEvent: async (ev) => {
      state.calEvents.push({ id: 'c' + ++calSeq, createdBy: state.settings.userName, updatedAt: Date.now(), deleted: false, ...ev });
      return S();
    },
    deleteCalEvent: async (id) => { state.calEvents = state.calEvents.filter(ev => ev.id !== id); return S(); },
    openUrl: async (url) => { window.open(url, '_blank'); return true; },
    importFolderProjects: async () => ({ ok: false, error: 'ブラウザデモでは利用できません(デスクトップ版の機能です)' }),
    updateProject: async (id, patch) => { const p = state.projects.find(p => p.id === id); if (p) Object.assign(p, patch); return S(); },
    deleteProject: async (id) => { state.projects = state.projects.filter(p => p.id !== id); return S(); },
    assignBlock: async (k, idx, pid, kws) => {
      const day = state.days[k];
      const b = day.unclassified[idx];
      if (b && pid) {
        day.projectMin[pid] = (day.projectMin[pid] || 0) + Math.round((b.e - b.s) / MIN);
        day.unclassified.splice(idx, 1);
        const p = state.projects.find(p => p.id === pid);
        if (p) for (const kw of (kws || [])) if (!p.keywords.includes(kw)) p.keywords.push(kw);
        state.learnN += 3;
        day.events.push({ t: Date.now(), msg: '未分類の作業を案件に割り当てました' });
      }
      return S();
    },
    saveSync: async (patch) => { Object.assign(state.settings.sync, patch); return S(); },
    syncNow: async () => ({ ok: false, error: 'ブラウザデモのため同期は無効です', state: S() }),
    importCalendar: async () => ({ ok: false, canceled: true }),
    setTeamStatus: async (memberId, dateKey, status) => {
      if (memberId === 'self') { if (state.days[dateKey]) state.days[dateKey].status = status; }
      else { const m = state.team.members.find(m => m.id === memberId); if (m && m.days[dateKey]) m.days[dateKey].status = status; }
      return S();
    },
    reseedDemo: async () => { state.team = seedTeam(); return S(); },
    openScreenSettings: async () => true,
    relaunchApp: async () => { location.reload(); },
    onUpdate: (cb) => listeners.push(cb)
  };
})();
