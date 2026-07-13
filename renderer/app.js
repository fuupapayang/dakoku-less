'use strict';
/* DakokuLess renderer */
let state = null;
let activeTab = 'today';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CONF = { STABLE: '安定', UNSURE: '微妙', LOW: '不安定' };
const STATUS = { recording: '記録中', pending: '未提出', submitted: '提出済み', approved: '承認済み', rejected: '差し戻し' };
const MODES = [
  { id: 'auto', name: 'オート', desc: 'すべて自動提出。推定結果をそのまま提出します。' },
  { id: 'moderate', name: 'ほどほど', desc: '不安定な日だけ手動確認。それ以外は自動提出。', pop: '一番人気' },
  { id: 'strict', name: 'きっちり', desc: '安定した日のみ自動提出。微妙な日は確認します。' },
  { id: 'manual', name: 'マニュアル', desc: 'すべて確認してから提出。自動提出しません。' }
];
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function fmtTime(ts) {
  if (ts == null) return '--:--';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDur(min) {
  if (min == null || isNaN(min)) return '-';
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
}
function fmtDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  return `${m}/${d} (${wd})`;
}
function hm(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function effective(day) { return day && (day.correction || day.estimation); }

/* ---------- 今日 ---------- */
function segmentsFromCorrection(c) {
  const segs = [];
  let cur = c.start;
  const brs = [...(c.breaks || [])].sort((a, b) => a.s - b.s);
  for (const b of brs) {
    if (b.s > cur) segs.push({ s: cur, e: b.s, kind: 'work' });
    segs.push({ s: b.s, e: b.e, kind: 'break' });
    cur = b.e;
  }
  if (c.end > cur) segs.push({ s: cur, e: c.end, kind: 'work' });
  return segs;
}

function timelineHTML(est) {
  if (!est || est.start == null) return '<div class="muted">まだ稼働が検知されていません</div>';
  const segs = est.segments || segmentsFromCorrection(est);
  const d0 = new Date(est.start);
  const base = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime();
  const fromH = Math.min(8, d0.getHours());
  const toH = Math.max(19, new Date(est.end).getHours() + 1);
  const span = (toH - fromH) * 3600000;
  const x = ts => Math.max(0, Math.min(100, ((ts - base - fromH * 3600000) / span) * 100));
  let bars = '';
  for (const s of segs) {
    const l = x(s.s), w = Math.max(0.4, x(s.e) - l);
    bars += `<div class="tl-seg ${esc(s.kind)}" style="left:${l}%;width:${w}%" title="${esc(s.label || s.kind)} ${fmtTime(s.s)}〜${fmtTime(s.e)}"></div>`;
  }
  const ticks = [];
  for (let h = fromH; h <= toH; h += Math.ceil((toH - fromH) / 5)) ticks.push(`<span>${h}:00</span>`);
  return `<div class="timeline">${bars}</div><div class="tl-axis">${ticks.join('')}</div>
    <div class="legend">
      <span><i style="background:var(--green)"></i>稼働</span>
      <span><i style="background:#c3cdc6"></i>休憩</span>
      <span><i style="background:var(--amber)"></i>微妙な空白</span>
      <span><i style="background:repeating-linear-gradient(45deg,#c3cdc6,#c3cdc6 3px,#aab6ad 3px,#aab6ad 6px)"></i>対象外(移動等)</span>
    </div>`;
}

function suggestionHTML(sug, key, idx) {
  return `<div class="suggestion" data-key="${esc(key)}" data-idx="${idx}">
    <div class="who">DakokuLess AI</div>
    <div>${esc(sug.text)}</div>
    <div class="actions">
      <button class="btn primary sm" data-act="sug-add">マイルールに追加</button>
      <button class="btn sm" data-act="sug-once">今回だけ</button>
    </div>
    <div class="muted mt8">次回の似た時間帯から、自動でこのルールを適用します</div>
  </div>`;
}

function renderToday() {
  const key = state.todayKey;
  const day = state.days[key];
  const est = effective(day);
  const raw = day && day.estimation;
  const conf = raw ? raw.confidence : 'LOW';
  const status = day ? day.status : 'recording';
  const canSubmit = est && est.start != null && status !== 'submitted' && status !== 'approved';
  const sugs = (raw && raw.suggestions) || [];

  $('#tab-today').innerHTML = `
    <h1>今日の勤務</h1>
    <div class="page-sub">${fmtDate(key)} ｜ ただ仕事に集中するだけで、出退勤ログをそっと整えます。</div>

    <div class="card">
      <div class="row">
        <span class="rec-badge ${state.recording ? '' : 'idle'}"><span class="pulse"></span>${state.recording ? '記録中 — PC稼働を自動記録' : '待機中 — 操作の空白を検知'}</span>
        <span class="grow"></span>
        <span class="chip ${esc(conf)}">推定: ${CONF[conf]}</span>
        <span class="chip status-${esc(status)}">${STATUS[status] || status}</span>
      </div>
      ${workLineHTML()}
      <div class="big-time">${fmtTime(est && est.start)} — ${fmtTime(est && est.end)}
        <small>／ 休憩 ${fmtDur(est ? est.breakMin : null)} ／ 実働 ${fmtDur(est ? est.workMin : null)}</small></div>
      ${day && day.correction ? '<div class="muted">✎ 手動修正が適用されています(HITL: この修正はAIの次回推定に反映されます)</div>' : ''}
      ${timelineHTML(est)}
      <div class="row mt16">
        <button class="btn primary" data-act="submit-today" ${canSubmit ? '' : 'disabled'}>勤怠を確定・提出</button>
        <button class="btn" data-act="correct-today" ${est && est.start != null ? '' : 'disabled'}>修正する</button>
        <span class="grow"></span>
        <span class="muted">提出モード: ${MODES.find(m => m.id === state.settings.submitMode).name}</span>
      </div>
    </div>

    ${sugs.length ? `<div class="card"><h2>AIからの確認 <span class="tag exclude">HITL</span></h2>
      ${sugs.map((s, i) => suggestionHTML(s, key, i)).join('')}</div>` : ''}

    <div class="card">
      <h2>検知イベント</h2>
      <ul class="events">
        ${(day && day.events ? [...day.events].reverse().slice(0, 12) : [])
          .map(ev => `<li><b>${fmtTime(ev.t)}</b>${esc(ev.msg)}</li>`).join('') || '<li class="muted">まだイベントはありません</li>'}
      </ul>
      ${raw && raw.notes && raw.notes.length ? `<div class="muted mt8">推定メモ: ${raw.notes.map(esc).join(' ／ ')}</div>` : ''}
    </div>`;
}

/* ---------- 履歴 ---------- */
function renderHistory() {
  const keys = Object.keys(state.days).sort().reverse();
  const rows = keys.map(k => {
    const day = state.days[k];
    const est = effective(day);
    if (!est || est.start == null) return '';
    const conf = day.estimation ? day.estimation.confidence : 'LOW';
    const canSubmit = day.status === 'pending' || day.status === 'rejected';
    return `<tr>
      <td>${fmtDate(k)}${k === state.todayKey ? ' <span class="tag work">今日</span>' : ''}</td>
      <td>${fmtTime(est.start)}</td><td>${fmtTime(est.end)}</td>
      <td>${fmtDur(est.breakMin)}</td><td><b>${fmtDur(est.workMin)}</b></td>
      <td><span class="chip ${esc(conf)}">${CONF[conf]}</span></td>
      <td><span class="chip status-${esc(day.status)}">${STATUS[day.status] || day.status}</span>
          ${day.submitted && day.submitted.auto ? '<span class="tag">自動</span>' : ''}</td>
      <td>${canSubmit ? `<button class="btn sm" data-act="submit-day" data-key="${esc(k)}">提出</button>` : ''}
          <button class="btn sm ghost" data-act="correct-day" data-key="${esc(k)}">修正</button></td>
    </tr>`;
  }).join('');
  $('#tab-history').innerHTML = `
    <h1>履歴</h1>
    <div class="page-sub">推定・修正・提出の記録。修正はAIの次回推定に反映されます。</div>
    <div class="card"><table>
      <thead><tr><th>日付</th><th>始業</th><th>終業</th><th>休憩</th><th>実働</th><th>信頼度</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">まだ記録がありません</td></tr>'}</tbody>
    </table></div>`;
}

/* ---------- 案件 ---------- */
function projName(id) {
  const p = (state.projects || []).find(p => p.id === id);
  return p ? `[${p.code}] ${p.name}` : '(削除済み案件)';
}

function workLineHTML() {
  if (!state.settings.trackWork) return '';
  const w = state.currentWork;
  let label;
  if (!w) label = '<span class="muted">計測待機中</span>';
  else if (w.projectId) label = `<b>${esc(projName(w.projectId))}</b> <span class="muted">(${{ code: 'コード', keyword: 'キーワード', calendar: '会議' }[w.via] || ''}判定${w.app ? ' ・ ' + esc(w.app) : ''})</span>`;
  else label = `<span class="muted">案件未判定${w.app ? '(' + esc(w.app) + ')' : ''}</span>`;
  return `<div class="mt8">現在の作業: ${label}</div>`;
}

function projBarsHTML(projectMin, unclassifiedMin) {
  const rows = Object.entries(projectMin || {})
    .map(([id, min]) => ({ id, min: Math.round(min) }))
    .filter(r => r.min > 0).sort((a, b) => b.min - a.min);
  const total = rows.reduce((a, r) => a + r.min, 0) + (unclassifiedMin || 0);
  if (total === 0) return '<div class="muted">まだ計測データがありません</div>';
  const bar = (label, min, cls) => `
    <div class="row" style="margin-bottom:8px">
      <div style="width:220px;font-size:12.5px">${label}</div>
      <div class="grow" style="background:#eef2ef;border-radius:6px;height:18px;overflow:hidden">
        <div style="width:${Math.round(min / total * 100)}%;height:100%;border-radius:6px;background:${cls}"></div>
      </div>
      <div style="width:56px;text-align:right;font-variant-numeric:tabular-nums"><b>${fmtDur(min)}</b></div>
    </div>`;
  return rows.map(r => bar(esc(projName(r.id)), r.min, 'var(--green)')).join('') +
    (unclassifiedMin > 0 ? bar('未分類', unclassifiedMin, 'var(--amber)') : '');
}

function renderProjects() {
  const s = state.settings;
  const day = state.days[state.todayKey] || {};
  const unc = (day.unclassified || []).filter(b => b.e - b.s >= 3 * 60000);
  const uncMin = unc.reduce((a, b) => a + Math.round((b.e - b.s) / 60000), 0);
  const items = (state.projects || []).map(p => `
    <div class="rule-item">
      <div class="toggle ${p.active !== false ? 'on' : ''}" data-act="proj-toggle" data-id="${esc(p.id)}"></div>
      <div class="grow">
        <div><b>[${esc(p.code)}] ${esc(p.name)}</b></div>
        <div class="meta">キーワード: ${(p.keywords || []).map(esc).join('、 ') || '(なし ― コード判定のみ)'}</div>
      </div>
      <button class="btn sm ghost" data-act="proj-kw" data-id="${esc(p.id)}">キーワード編集</button>
      <button class="btn sm ghost danger" data-act="proj-del" data-id="${esc(p.id)}">削除</button>
    </div>`).join('');

  $('#tab-projects').innerHTML = `
    <h1>案件トラッキング</h1>
    <div class="page-sub">誰が・何の案件を・どれだけ。カレンダー → 案件コード → キーワードの順で自動判定します。</div>

    <div class="card">
      <div class="row">
        <div class="toggle ${s.trackWork ? 'on' : ''}" data-act="track-toggle"></div>
        <div class="grow"><b>作業内容の計測</b>
          <div class="muted">前面ウィンドウのタイトルをメモリ上で判定に使い、原文は保存しません。残るのは「案件×分数」だけです。
          ${state.platform === 'darwin' ? 'macOSでは初回に「画面収録」権限の許可が必要です。' : ''}</div></div>
      </div>
      ${s.trackWork && state.platform === 'darwin' && state.screenPermission !== 'granted' ? `
      <div class="suggestion mt8" style="background:var(--amber-bg);border-color:#f3ddb0">
        <div class="who" style="color:var(--amber)">画面収録の権限が未反映です(現在: ${esc(state.screenPermission)})</div>
        <div>① 下のボタンからシステム設定を開き、DakokuLess を許可(一覧になければ「+」で /Applications/DakokuLess.app を追加)<br>
        ② <b>許可後は必ずアプリを再起動</b>してください。反映されるまで計測は自動的に一時停止しています(アラートは出ません)。</div>
        <div class="actions">
          <button class="btn sm" data-act="perm-open">システム設定を開く</button>
          <button class="btn sm primary" data-act="app-relaunch">アプリを再起動</button>
        </div>
      </div>` : ''}
      ${workLineHTML()}
    </div>

    <div class="card">
      <h2>今日の案件別作業時間</h2>
      ${projBarsHTML(day.projectMin, uncMin)}
    </div>

    ${unc.length ? `<div class="card"><h2>未分類の作業 <span class="tag exclude">HITL</span></h2>
      <p class="muted">割り当てると語句・時間帯の傾向を学習し、次回から自動判定されます(学習データ: ${Math.round(state.learnN || 0)}件)。</p>
      ${unc.map((b) => `
        <div class="rule-item">
          <div class="grow"><b>${fmtTime(b.s)}〜${fmtTime(b.e)}</b>(${fmtDur(Math.round((b.e - b.s) / 60000))})
            <div class="meta">検出語句: ${(b.tokens || []).map(esc).join('、 ') || 'なし'}
            ${b.hint ? `<br>AI候補: <b>${esc(projName(b.hint.pid))}</b>(確度${b.hint.pct}%)` : ''}</div></div>
          ${b.hint ? `<button class="btn sm primary" data-act="assign-hint" data-idx="${(day.unclassified || []).indexOf(b)}" data-pid="${esc(b.hint.pid)}">候補で割り当て</button>` : ''}
          <button class="btn sm ${b.hint ? '' : 'primary'}" data-act="assign" data-idx="${(day.unclassified || []).indexOf(b)}">選んで割り当て</button>
        </div>`).join('')}</div>` : ''}

    <div class="card">
      <h2>案件マスター(${(state.projects || []).length})</h2>
      ${items || '<div class="muted">まだ案件がありません。下から追加してください。</div>'}
      <div class="field-row mt16">
        <label class="field">案件コード(大文字英字+数字)<input type="text" id="pj-code" placeholder="例: F000, T123"></label>
        <label class="field">案件名<input type="text" id="pj-name" placeholder="例: 山田商事 在庫管理"></label>
        <label class="field">キーワード(読点・カンマ区切り)<input type="text" id="pj-kw" placeholder="例: 山田商事, 在庫管理"></label>
      </div>
      <button class="btn primary" data-act="proj-add">案件を追加</button>
      <p class="muted mt8">運用のコツ: カレンダーの予定名・新規フォルダ・主要ファイル名の先頭に「F000_」のように<b>コード+アンダースコア</b>を付けてください(大文字必須。例: F000_定例会議、T123_見積書.xlsx)。それ以外はキーワード学習が吸収します。</p>
    </div>`;
}

function openAssignModal(idx) {
  const day = state.days[state.todayKey];
  const b = day.unclassified[idx];
  if (!b) return;
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">
    <h2>${fmtTime(b.s)}〜${fmtTime(b.e)} の作業を割り当て</h2>
    <label class="field">案件<select id="as-proj">
      ${(state.projects || []).filter(p => p.active !== false)
        .map(p => `<option value="${esc(p.id)}">[${esc(p.code)}] ${esc(p.name)}</option>`).join('')}
    </select></label>
    <label class="field">キーワードとして学習する語句(次回から自動判定)</label>
    <div id="as-tokens">${(b.tokens || []).map(t =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 8px 0;font-size:13px">
        <input type="checkbox" class="as-kw" value="${esc(t)}" checked> ${esc(t)}</label>`).join('') || '<span class="muted">候補なし</span>'}</div>
    <div class="foot">
      <button class="btn" data-act="modal-close">キャンセル</button>
      <button class="btn primary" data-act="as-save">割り当てる</button>
    </div>
  </div></div>`;
  root.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'modal-close' || e.target.classList.contains('overlay')) { root.innerHTML = ''; root.onclick = null; return; }
    if (act === 'as-save') {
      const pid = $('#as-proj').value;
      if (!pid) { toast('案件を選択してください'); return; }
      const kws = [...root.querySelectorAll('.as-kw:checked')].map(i => i.value);
      state = await window.api.assignBlock(state.todayKey, idx, pid, kws);
      root.innerHTML = ''; root.onclick = null;
      renderProjects();
      toast('割り当てました。キーワードを学習しました');
    }
  };
}

function openKeywordModal(pid) {
  const p = state.projects.find(p => p.id === pid);
  if (!p) return;
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">
    <h2>[${esc(p.code)}] ${esc(p.name)} のキーワード</h2>
    <label class="field">読点・カンマ区切り(タイトルにこの語句が含まれるとこの案件に計上)
      <input type="text" id="kw-input" value="${esc((p.keywords || []).join(', '))}"></label>
    <div class="foot">
      <button class="btn" data-act="modal-close">キャンセル</button>
      <button class="btn primary" data-act="kw-save">保存</button>
    </div>
  </div></div>`;
  root.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'modal-close' || e.target.classList.contains('overlay')) { root.innerHTML = ''; root.onclick = null; return; }
    if (act === 'kw-save') {
      const kws = $('#kw-input').value.split(/[,、]/).map(s => s.trim()).filter(Boolean);
      state = await window.api.updateProject(pid, { keywords: kws });
      root.innerHTML = ''; root.onclick = null;
      renderProjects(); toast('キーワードを更新しました');
    }
  };
}

/* ---------- マイルール ---------- */
function renderRules() {
  const items = state.rules.map(r => `
    <div class="rule-item">
      <div class="toggle ${r.enabled !== false ? 'on' : ''}" data-act="rule-toggle" data-id="${esc(r.id)}"></div>
      <div class="grow">
        <div><b>${esc(r.label)}</b> <span class="tag ${esc(r.treatAs)}">${{ work: '稼働扱い', break: '休憩扱い', exclude: '対象外' }[r.treatAs]}</span></div>
        <div class="meta">${hm(r.fromMin)}〜${hm(r.toMin)} ／ ${r.weekday == null ? '毎日' : WD[r.weekday] + '曜日'} ／ 追加日 ${new Date(r.createdAt).toLocaleDateString('ja-JP')}</div>
      </div>
      <button class="btn sm ghost danger" data-act="rule-del" data-id="${esc(r.id)}">削除</button>
    </div>`).join('');
  $('#tab-rules').innerHTML = `
    <h1>マイルール</h1>
    <div class="page-sub">あなた専用のルール。打刻を修正するたびにAIが候補を提案し、使うほど推定精度が高まります。</div>
    <div class="card">
      <h2>登録済みルール(${state.rules.length})</h2>
      ${items || '<div class="muted">まだルールはありません。勤怠を修正するとAIがルール化を提案します。</div>'}
    </div>
    <div class="card">
      <h2>手動でルールを追加</h2>
      <div class="field-row">
        <label class="field">ラベル<input type="text" id="rl-label" placeholder="例: 朝の移動時間"></label>
        <label class="field">扱い<select id="rl-treat">
          <option value="break">休憩扱い</option><option value="exclude">対象外(移動・私用)</option><option value="work">稼働扱い</option>
        </select></label>
      </div>
      <div class="field-row">
        <label class="field">開始<input type="time" id="rl-from" value="12:00"></label>
        <label class="field">終了<input type="time" id="rl-to" value="13:00"></label>
        <label class="field">曜日<select id="rl-wd"><option value="">毎日</option>
          ${WD.map((w, i) => `<option value="${i}">${w}曜日</option>`).join('')}</select></label>
      </div>
      <button class="btn primary" data-act="rule-add">ルールを追加</button>
    </div>`;
}

/* ---------- 設定 ---------- */
function renderSettings() {
  const s = state.settings;
  $('#tab-settings').innerHTML = `
    <h1>設定</h1>
    <div class="page-sub">自動提出も、手動チェックも。好みの提出レベルを選択できます。</div>
    <div class="card">
      <h2>提出モード</h2>
      <div class="mode-grid">
        ${MODES.map(m => `
          <div class="mode-card ${s.submitMode === m.id ? 'selected' : ''}" data-act="mode" data-id="${m.id}">
            ${m.pop ? `<span class="pop">${m.pop}</span>` : ''}
            <h3>${m.name}</h3><p>${m.desc}</p>
          </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2>検知パラメータ</h2>
      <div class="field-row">
        <label class="field">無操作とみなす秒数<input type="number" id="st-idle" value="${s.idleThresholdSec}" min="30" max="600"></label>
        <label class="field">休憩とみなす空白(分)<input type="number" id="st-break" value="${s.breakThresholdMin}" min="5" max="120"></label>
        <label class="field">日付の切替時刻(時)<input type="number" id="st-daystart" value="${s.dayStartHour}" min="0" max="12"></label>
      </div>
      <div class="field-row">
        <label class="field">表示名<input type="text" id="st-name" value="${esc(s.userName)}"></label>
      </div>
      <div class="row">
        <div class="toggle ${s.autoLaunch ? 'on' : ''}" data-act="autolaunch"></div>
        <span>ログイン時に自動起動(打刻を意識しないために推奨)</span>
      </div>
      <button class="btn primary mt16" data-act="save-settings">保存</button>
    </div>
    <div class="card">
      <h2>チーム同期(Firebase)</h2>
      <p class="muted">Firestoreを通じて、案件マスター・学習辞書・勤怠/工数サマリーをチームで共有します。
      タイトルや生ログは送信されません。${syncStatusHTML()}</p>
      <div class="field-row mt8">
        <label class="field">Firebase Project ID<input type="text" id="sy-pid" value="${esc(s.sync.projectId || '')}" placeholder="例: my-team-kintai"></label>
        <label class="field">Web API Key<input type="text" id="sy-key" value="${esc(s.sync.apiKey || '')}" placeholder="AIza..."></label>
        <label class="field">チームID(全員で同じ文字列)<input type="text" id="sy-team" value="${esc(s.sync.teamId || '')}" placeholder="例: eigyo-1"></label>
      </div>
      <div class="row">
        <div class="toggle ${s.sync.enabled ? 'on' : ''}" data-act="sync-toggle"></div>
        <span>チーム同期を有効にする</span>
        <span class="grow"></span>
        <button class="btn" data-act="sync-save">接続設定を保存</button>
        <button class="btn primary" data-act="sync-now" ${s.sync.enabled ? '' : 'disabled'}>今すぐ同期</button>
      </div>
      <p class="muted mt8">セットアップ: console.firebase.google.com → プロジェクト作成 → Firestore Database を「テストモード」で作成 →
      プロジェクトの設定からProject IDとWeb API Keyをコピー。チーム全員が同じ値+同じチームIDを設定すれば共有されます。</p>
    </div>
    <div class="card">
      <h2>データ連携</h2>
      <p class="muted">カレンダーの予定(.ics)をかけ合わせると、会議中の無操作を稼働として、移動予定を対象外として推定できます。</p>
      <div class="row mt8">
        <button class="btn" data-act="import-ics">カレンダー(.ics)をインポート</button>
        <button class="btn ghost" data-act="reseed">管理者ビューのデモデータを再生成</button>
      </div>
    </div>
    <div class="card">
      <h2>データ・プライバシー</h2>
      <p class="muted">取得された稼働サンプルはメモリ上で推論に一時利用され、ディスクに残さず即時に削除されます。
      アプリ名・ウィンドウタイトル・入力内容は一切収集しません。保存されるのは「何時から何時まで働いたか」という結果だけで、
      管理者を含め他の人が生ログを閲覧することはできません。</p>
    </div>`;
}

/* ---------- 管理者 ---------- */
function selfRow(dateKey) {
  const day = state.days[dateKey];
  const est = day && (day.submitted || effective(day));
  if (!est || est.start == null) return null;
  return {
    id: 'self', name: state.settings.userName + '(あなた)', dept: '—',
    start: est.start, end: est.end, workMin: est.workMin, breakMin: est.breakMin,
    confidence: day.estimation ? day.estimation.confidence : 'LOW',
    status: day.status === 'recording' ? 'pending' : day.status,
    discrepancyMin: 0, auto: day.submitted ? day.submitted.auto : false
  };
}

function renderAdmin() {
  const team = state.team || { members: [] };
  const sel = renderAdmin.date || (() => {
    const d = new Date(Date.now() - 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  renderAdmin.date = sel;

  // 同期メンバーがいれば実データを優先、いなければデモデータ
  const myId = (state.settings.sync && state.settings.sync.memberId) || '';
  const remote = state.remoteTeam && state.remoteTeam.members && state.remoteTeam.members.length
    ? state.remoteTeam.members.filter(m => m.id !== myId) : null;
  const roster = remote
    ? remote.map(m => ({ id: m.id, name: m.name, dept: '同期', days: m.days }))
    : team.members;

  const rows = [];
  const self = selfRow(sel);
  if (self) rows.push(self);
  for (const m of roster) {
    const d = m.days[sel];
    rows.push(d ? { id: m.id, name: m.name, dept: m.dept, ...d } : { id: m.id, name: m.name, dept: m.dept, start: null });
  }
  const submitted = rows.filter(r => r.status === 'submitted' || r.status === 'approved').length;
  const pendingN = rows.filter(r => r.start != null && r.status === 'pending').length;
  const waiting = rows.filter(r => r.status === 'submitted').length;

  // 乖離アラート(全期間)
  const alerts = [];
  for (const m of team.members)
    for (const [k, d] of Object.entries(m.days))
      if (d.discrepancyMin > 30) alerts.push({ name: m.name, key: k, min: d.discrepancyMin });
  alerts.sort((a, b) => b.key.localeCompare(a.key));

  $('#tab-admin').innerHTML = `
    <h1>管理者ビュー</h1>
    <div class="page-sub">催促も、言い訳も、いらない毎日へ。月末の乖離チェック業務を大幅に削減します。</div>
    <div class="kpis">
      <div class="kpi"><div class="num">${submitted}/${rows.length}</div><div class="lbl">提出済み(${fmtDate(sel)})</div></div>
      <div class="kpi"><div class="num">${pendingN}</div><div class="lbl">未提出</div></div>
      <div class="kpi"><div class="num">${waiting}</div><div class="lbl">承認待ち</div></div>
      <div class="kpi"><div class="num" style="color:${alerts.length ? 'var(--red)' : 'inherit'}">${alerts.length}</div><div class="lbl">乖離アラート(30分超)</div></div>
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">メンバー勤怠</h2>
        <input type="date" id="adm-date" value="${sel}" style="width:170px;margin:0"></div>
      <table class="mt8">
        <thead><tr><th>メンバー</th><th>部署</th><th>始業</th><th>終業</th><th>休憩</th><th>実働</th><th>信頼度</th><th>状態</th><th></th></tr></thead>
        <tbody>${rows.map(r => r.start == null ? `
          <tr class="member-row"><td>${esc(r.name)}</td><td>${esc(r.dept)}</td>
          <td colspan="6" class="muted">記録なし(休暇・休日)</td><td></td></tr>` : `
          <tr class="member-row"><td>${esc(r.name)}</td><td>${esc(r.dept)}</td>
          <td>${fmtTime(r.start)}</td><td>${fmtTime(r.end)}</td><td>${fmtDur(r.breakMin)}</td><td><b>${fmtDur(r.workMin)}</b>
            ${r.discrepancyMin > 30 ? `<div class="disc-warn">⚠ ログ乖離 ${r.discrepancyMin}分</div>` : ''}</td>
          <td><span class="chip ${esc(r.confidence)}">${CONF[r.confidence] || '-'}</span></td>
          <td><span class="chip status-${esc(r.status)}">${STATUS[r.status] || r.status}</span>${r.auto ? '<span class="tag">自動</span>' : ''}</td>
          <td>${r.status === 'submitted' ? `
            <button class="btn sm primary" data-act="approve" data-id="${esc(r.id)}" data-key="${sel}">承認</button>
            <button class="btn sm danger" data-act="reject" data-id="${esc(r.id)}" data-key="${sel}">差し戻し</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">案件別 工数マトリクス(直近30日)</h2>
        <button class="btn sm" data-act="csv-long">シート用CSV出力</button>
        <button class="btn sm" data-act="csv-export">CSV出力</button></div>
      ${projMatrixHTML()}
    </div>
    <div class="card">
      <h2>乖離アラート一覧</h2>
      ${alerts.length ? `<table><thead><tr><th>日付</th><th>メンバー</th><th>提出とPCログの乖離</th></tr></thead>
        <tbody>${alerts.slice(0, 10).map(a => `<tr><td>${fmtDate(a.key)}</td><td>${esc(a.name)}</td>
        <td class="disc-warn">${a.min}分</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted">乖離はありません。勤怠データに客観的な根拠が紐づいています。</div>'}
    </div>`;
}

function syncStatusHTML() {
  const st = state.syncStatus;
  if (!st || !state.settings.sync.enabled) return '';
  const map = { idle: '待機中', syncing: '同期中…', ok: '正常', error: 'エラー' };
  let s = `<br>状態: <b>${map[st.state] || st.state}</b>`;
  if (st.lastSync) s += ` ／ 最終同期 ${fmtTime(st.lastSync)} ／ メンバー${st.members}人`;
  if (st.error) s += `<br><span style="color:var(--red)">${esc(st.error)}</span>`;
  return s;
}

/* ---------- 管理者: 案件マトリクス ---------- */
function hashN(s) { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

/** 人×案件の直近30日集計。本人は実データ、デモメンバーは決定論的な擬似配分 */
function buildMatrix() {
  const projects = (state.projects || []).filter(p => p.active !== false);
  if (!projects.length) return null;
  const cutoff = Date.now() - 30 * 86400000;
  const rows = [];
  // 本人(実データ)
  const mine = { name: state.settings.userName + '(あなた)', cells: {}, unclassified: 0 };
  for (const [k, d] of Object.entries(state.days)) {
    if (new Date(k).getTime() < cutoff) continue;
    for (const [pid, min] of Object.entries(d.projectMin || {}))
      mine.cells[pid] = (mine.cells[pid] || 0) + Math.round(min);
    mine.unclassified += (d.unclassified || []).reduce((a, b) => a + Math.round((b.e - b.s) / 60000), 0);
  }
  rows.push(mine);
  const myId = (state.settings.sync && state.settings.sync.memberId) || '';
  const remote = state.remoteTeam && state.remoteTeam.members && state.remoteTeam.members.length
    ? state.remoteTeam.members.filter(m => m.id !== myId) : null;
  if (remote) {
    // 同期メンバー(実データ)
    for (const m of remote) {
      const r = { name: m.name, cells: {}, unclassified: 0 };
      for (const [k, d] of Object.entries(m.days || {})) {
        if (new Date(k).getTime() < cutoff) continue;
        let assigned = 0;
        for (const [pid, min] of Object.entries(d.projectMin || {})) {
          r.cells[pid] = (r.cells[pid] || 0) + Math.round(min);
          assigned += Math.round(min);
        }
        r.unclassified += Math.max(0, (d.workMin || 0) - assigned);
      }
      rows.push(r);
    }
  } else {
    // デモメンバー(実働時間を案件へ擬似配分 ― デモ表示用)
    for (const m of (state.team ? state.team.members : [])) {
      const r = { name: m.name + ' *', cells: {}, unclassified: 0 };
      for (const [k, d] of Object.entries(m.days)) {
        if (new Date(k).getTime() < cutoff || !d.workMin) continue;
        const weights = projects.map(p => 1 + hashN(m.id + p.id) % 5);
        const wsum = weights.reduce((a, b) => a + b, 0) + 2;
        projects.forEach((p, i) => {
          r.cells[p.id] = (r.cells[p.id] || 0) + Math.round(d.workMin * weights[i] / wsum);
        });
        r.unclassified += Math.round(d.workMin * 2 / wsum);
      }
      rows.push(r);
    }
  }
  return { projects, rows, remote: !!remote };
}

function projMatrixHTML() {
  const m = buildMatrix();
  if (!m) return '<div class="muted">案件マスターが空です。「案件」タブから登録すると、ここに人×案件の工数が集計されます。</div>';
  return `<table><thead><tr><th>メンバー</th>
    ${m.projects.map(p => `<th>[${esc(p.code)}]<br>${esc(p.name)}</th>`).join('')}
    <th>未分類</th><th>合計</th></tr></thead>
    <tbody>${m.rows.map(r => {
      const total = m.projects.reduce((a, p) => a + (r.cells[p.id] || 0), 0) + r.unclassified;
      return `<tr><td>${esc(r.name)}</td>
        ${m.projects.map(p => `<td>${r.cells[p.id] ? fmtDur(r.cells[p.id]) : '-'}</td>`).join('')}
        <td>${r.unclassified ? fmtDur(r.unclassified) : '-'}</td><td><b>${fmtDur(total)}</b></td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted mt8">${m.remote ? 'チーム同期による実データです。' : '* はデモデータ(擬似配分)。チーム同期を有効にすると実データに置き換わります。'}</p>`;
}

/** シート用CSV(縦持ち): 日付,メンバー,案件コード,案件名,分 */
function exportLongCSV() {
  const projects = state.projects || [];
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const cutoff = Date.now() - 30 * 86400000;
  const lines = [['日付', 'メンバー', '案件コード', '案件名', '分']];
  const pushDays = (name, days, projectMinGetter) => {
    for (const [k, d] of Object.entries(days)) {
      if (new Date(k).getTime() < cutoff) continue;
      for (const [pid, min] of Object.entries(projectMinGetter(d) || {})) {
        const p = byId[pid];
        if (Math.round(min) > 0) lines.push([k, name, p ? p.code : pid, p ? p.name : '(削除済み)', Math.round(min)]);
      }
    }
  };
  pushDays(state.settings.userName, state.days, d => d.projectMin);
  const myId = (state.settings.sync && state.settings.sync.memberId) || '';
  for (const m of ((state.remoteTeam && state.remoteTeam.members) || [])) {
    if (m.id === myId) continue;
    pushDays(m.name, m.days || {}, d => d.projectMin);
  }
  if (lines.length === 1) { toast('出力できる工数データがありません'); return; }
  const csv = '﻿' + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `工数実績_${state.todayKey}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('シート用CSVを書き出しました(案件管理シートの「工数実績」に貼り付け)');
}

function exportMatrixCSV() {
  const m = buildMatrix();
  if (!m) { toast('案件がありません'); return; }
  const head = ['メンバー', ...m.projects.map(p => `[${p.code}] ${p.name}`), '未分類', '合計(分)'];
  const lines = [head];
  for (const r of m.rows) {
    const total = m.projects.reduce((a, p) => a + (r.cells[p.id] || 0), 0) + r.unclassified;
    lines.push([r.name, ...m.projects.map(p => r.cells[p.id] || 0), r.unclassified, total]);
  }
  const csv = '﻿' + lines.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `案件工数_${state.todayKey}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSVを書き出しました');
}

/* ---------- 修正モーダル ---------- */
function openCorrectionModal(key) {
  const day = state.days[key];
  const est = effective(day);
  if (!est || est.start == null) return;
  const breaks = (est.breaks || []).map(b => ({ s: b.s, e: b.e }));
  const root = $('#modal-root');

  const breakRow = (b, i) => `<div class="break-edit" data-i="${i}">
      <input type="time" class="br-s" value="${fmtTime(b.s)}"> 〜 <input type="time" class="br-e" value="${fmtTime(b.e)}">
      <button class="btn sm ghost danger" data-act="br-del" data-i="${i}">✕</button></div>`;

  root.innerHTML = `<div class="overlay"><div class="modal">
    <h2>${fmtDate(key)} の勤怠を修正</h2>
    <div class="field-row">
      <label class="field">始業<input type="time" id="cr-start" value="${fmtTime(est.start)}"></label>
      <label class="field">終業<input type="time" id="cr-end" value="${fmtTime(est.end)}"></label>
    </div>
    <label class="field">休憩</label>
    <div id="cr-breaks">${breaks.map(breakRow).join('') || ''}</div>
    <button class="btn sm" data-act="br-add">+ 休憩を追加</button>
    <p class="muted mt8">修正内容はAIが学習し、次回から似た時間帯の推定に反映されます(Human-in-the-Loop)。</p>
    <div class="foot">
      <button class="btn" data-act="modal-close">キャンセル</button>
      <button class="btn primary" data-act="cr-save">修正を保存</button>
    </div>
  </div></div>`;

  const dayBase = (() => { const d = new Date(est.start); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); })();
  const parseT = v => { const [h, m] = v.split(':').map(Number); return dayBase + (h * 60 + m) * 60000; };

  root.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (!act) { if (e.target.classList.contains('overlay')) root.innerHTML = ''; return; }
    if (act === 'modal-close') { root.innerHTML = ''; root.onclick = null; }
    if (act === 'br-add') {
      $('#cr-breaks').insertAdjacentHTML('beforeend', breakRow({ s: dayBase + 12 * 3600000, e: dayBase + 13 * 3600000 }, Date.now()));
    }
    if (act === 'br-del') e.target.closest('.break-edit').remove();
    if (act === 'cr-save') {
      const brs = [...root.querySelectorAll('.break-edit')].map(el => ({
        s: parseT($('.br-s', el).value), e: parseT($('.br-e', el).value)
      })).filter(b => b.e > b.s);
      const correction = { start: parseT($('#cr-start').value), end: parseT($('#cr-end').value), breaks: brs };
      if (correction.end <= correction.start) { toast('終業は始業より後にしてください'); return; }
      const res = await window.api.correctDay(key, correction);
      state = res.state;
      root.innerHTML = ''; root.onclick = null;
      renderAll();
      toast('修正を保存しました');
      if (res.proposals && res.proposals.length) openProposalModal(res.proposals);
    }
  };
}

function openProposalModal(proposals) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal">
    <h2>AIからの提案 — マイルール化しますか？</h2>
    ${proposals.map((p, i) => `<div class="suggestion" data-i="${i}">
      <div class="who">DakokuLess AI</div><div>${esc(p.text)}</div>
      <div class="actions">
        <button class="btn primary sm" data-act="prop-add" data-i="${i}">マイルールに追加</button>
        <button class="btn sm" data-act="prop-skip" data-i="${i}">今回だけ</button>
      </div></div>`).join('')}
    <div class="foot"><button class="btn" data-act="modal-close">閉じる</button></div>
  </div></div>`;
  root.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'modal-close' || e.target.classList.contains('overlay')) { root.innerHTML = ''; root.onclick = null; return; }
    if (act === 'prop-add') {
      const p = proposals[+e.target.dataset.i];
      state = await window.api.addRule({ label: p.label, treatAs: p.treatAs, fromMin: p.fromMin, toMin: p.toMin, weekday: p.weekday });
      e.target.closest('.suggestion').remove();
      toast('マイルールに追加しました。次回から自動適用されます');
      renderAll();
    }
    if (act === 'prop-skip') e.target.closest('.suggestion').remove();
  };
}

/* ---------- 共通イベント ---------- */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.closest('#modal-root')) return;
  const act = btn.dataset.act;

  if (act === 'submit-today') {
    const r = await window.api.submitDay(state.todayKey);
    toast(r.ok ? '勤怠を確定・提出しました' : r.error);
  }
  if (act === 'submit-day') {
    const r = await window.api.submitDay(btn.dataset.key);
    toast(r.ok ? '提出しました' : r.error);
  }
  if (act === 'correct-today') openCorrectionModal(state.todayKey);
  if (act === 'correct-day') openCorrectionModal(btn.dataset.key);

  if (act === 'sug-add') {
    const wrap = btn.closest('.suggestion');
    const day = state.days[wrap.dataset.key];
    const p = day.estimation.suggestions[+wrap.dataset.idx];
    state = await window.api.addRule({ label: p.label, treatAs: p.treatAs, fromMin: p.fromMin, toMin: p.toMin, weekday: p.weekday });
    toast('マイルールに追加しました'); renderAll();
  }
  if (act === 'sug-once') { btn.closest('.suggestion').remove(); toast('今回だけ適用します'); }

  if (act === 'rule-toggle') { state = await window.api.toggleRule(btn.dataset.id); renderRules(); }
  if (act === 'rule-del') { state = await window.api.deleteRule(btn.dataset.id); renderRules(); toast('ルールを削除しました'); }
  if (act === 'rule-add') {
    const [fh, fm] = $('#rl-from').value.split(':').map(Number);
    const [th, tm] = $('#rl-to').value.split(':').map(Number);
    const wd = $('#rl-wd').value;
    state = await window.api.addRule({
      label: $('#rl-label').value || '手動ルール', treatAs: $('#rl-treat').value,
      fromMin: fh * 60 + fm, toMin: th * 60 + tm, weekday: wd === '' ? null : +wd
    });
    renderRules(); toast('ルールを追加しました');
  }

  if (act === 'track-toggle') {
    state = await window.api.updateSettings({ trackWork: !state.settings.trackWork });
    renderProjects();
    toast(state.settings.trackWork ? '作業内容の計測を開始しました' : '計測を停止しました');
  }
  if (act === 'proj-add') {
    const code = $('#pj-code').value.trim().toUpperCase(), name = $('#pj-name').value.trim();
    if (!code || !name) { toast('コードと案件名を入力してください'); return; }
    if (!/^[A-Z]+\d+$/.test(code)) { toast('案件コードは「大文字英字+数字」(例: F000, T123)にしてください'); return; }
    const keywords = $('#pj-kw').value.split(/[,、]/).map(s => s.trim()).filter(Boolean);
    const res = await window.api.addProject({ code, name, keywords });
    if (res.error) { toast(res.error); return; }
    state = res;
    renderProjects(); toast('案件を追加しました');
  }
  if (act === 'proj-toggle') {
    const p = state.projects.find(p => p.id === btn.dataset.id);
    state = await window.api.updateProject(btn.dataset.id, { active: !(p.active !== false) });
    renderProjects();
  }
  if (act === 'proj-del') {
    state = await window.api.deleteProject(btn.dataset.id);
    renderProjects(); toast('案件を削除しました');
  }
  if (act === 'proj-kw') openKeywordModal(btn.dataset.id);
  if (act === 'perm-open') await window.api.openScreenSettings();
  if (act === 'app-relaunch') await window.api.relaunchApp();
  if (act === 'assign') openAssignModal(+btn.dataset.idx);
  if (act === 'assign-hint') {
    state = await window.api.assignBlock(state.todayKey, +btn.dataset.idx, btn.dataset.pid, []);
    renderProjects(); toast('AI候補で割り当てました(学習に反映)');
  }
  if (act === 'csv-export') exportMatrixCSV();
  if (act === 'csv-long') exportLongCSV();

  if (act === 'sync-toggle') {
    state = await window.api.saveSync({ enabled: !state.settings.sync.enabled });
    renderSettings();
  }
  if (act === 'sync-save') {
    state = await window.api.saveSync({
      projectId: $('#sy-pid').value.trim(), apiKey: $('#sy-key').value.trim(), teamId: $('#sy-team').value.trim()
    });
    renderSettings(); toast('同期設定を保存しました');
  }
  if (act === 'sync-now') {
    toast('同期しています…');
    const r = await window.api.syncNow();
    state = r.state;
    renderSettings();
    toast(r.ok ? `同期完了(メンバー${r.members}人)` : `同期エラー: ${r.error}`);
  }

  if (act === 'mode') { state = await window.api.updateSettings({ submitMode: btn.dataset.id }); renderSettings(); toast('提出モードを変更しました'); }
  if (act === 'autolaunch') { state = await window.api.updateSettings({ autoLaunch: !state.settings.autoLaunch }); renderSettings(); }
  if (act === 'save-settings') {
    state = await window.api.updateSettings({
      idleThresholdSec: +$('#st-idle').value, breakThresholdMin: +$('#st-break').value,
      dayStartHour: +$('#st-daystart').value, userName: $('#st-name').value || 'あなた'
    });
    toast('設定を保存しました');
  }
  if (act === 'import-ics') {
    const r = await window.api.importCalendar();
    if (r.ok) toast(`予定を ${r.count} 件取り込みました`);
  }
  if (act === 'reseed') { state = await window.api.reseedDemo(); toast('デモデータを再生成しました'); if (activeTab === 'admin') renderAdmin(); }

  if (act === 'approve' || act === 'reject') {
    state = await window.api.setTeamStatus(btn.dataset.id, btn.dataset.key, act === 'approve' ? 'approved' : 'rejected');
    renderAdmin(); toast(act === 'approve' ? '承認しました' : '差し戻しました');
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'adm-date') { renderAdmin.date = e.target.value; renderAdmin(); }
});

/* ---------- ナビ / 描画 ---------- */
$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + activeTab));
  renderTab(activeTab);
});

function renderTab(tab) {
  if (tab === 'today') renderToday();
  if (tab === 'history') renderHistory();
  if (tab === 'projects') renderProjects();
  if (tab === 'rules') renderRules();
  if (tab === 'settings') renderSettings();
  if (tab === 'admin') renderAdmin();
}
function renderAll() { renderTab(activeTab); }

window.api.onUpdate((s) => {
  state = s;
  // 入力中のフォームを壊さないよう、閲覧系タブのみ自動更新
  if (['today', 'history', 'admin'].includes(activeTab) && !$('#modal-root').innerHTML) renderTab(activeTab);
});

(async () => { state = await window.api.getState(); renderAll(); })();
