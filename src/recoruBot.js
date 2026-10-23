'use strict';
/**
 * レコル(RecoRu)の勤務表を、非表示の BrowserWindow(セッション 'persist:recoru')で操作して転記する。
 * 手順は実サイトで手動確認したものに合わせている:
 *  - 勤務表 https://app.recoru.in/ap/menuAttendance/ (当月1日〜末日、1日1行。行 = 日 − 1)
 *  - 休憩はダイアログで入力。ダイアログを開く鉛筆リンク・「休憩を追加」は合成クリックを無視するため
 *    webContents.sendInputEvent による実クリック(CSS px)で押す
 *  - ダイアログの「更新」は表を描き直して未保存の行の値を消すので、勤務区分・開始・終了はその後に入れる
 *  - confirm()/alert() はページ側で差し替え(confirm は OK、alert はエラーとして回収)
 *  - 確定チェック・申請には触らない
 * 純粋なロジック(値の組み立て・検証)は src/recoruPost.js。
 */
const P = require('./recoruPost');

const TIMESHEET_URL = 'https://app.recoru.in/ap/menuAttendance/';
const PARTITION = 'persist:recoru';
const LEAVE_RE = /有休|有給|欠勤|特休|振休|代休|半休|休暇|休職/; // レコルで休暇等が設定済みの日は上書きしない

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ページ内で使う関数群(executeJavaScript で注入。外部の変数は参照しないこと) */
function pageLib() {
  const vis = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const byId = (id) => document.getElementById(id);
  const txt = (el) => String((el && (el.value != null && el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent)) || '').trim();
  const row = (i) => {
    const s = byId(`chartDto.attendanceDtos[${i}].attendId`) || byId(`chartDto.attendanceDtos[${i}].worktimeStart`);
    return s ? s.closest('tr') : null;
  };
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const setVal = (el, v) => {
    try { el.focus(); } catch (_) {}
    el.value = v;
    fire(el, 'input'); fire(el, 'keyup'); fire(el, 'change');
    try { el.blur(); } catch (_) {}
    if (!document.hasFocus()) { el.dispatchEvent(new FocusEvent('blur')); el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); }
  };
  const breakInputs = () => ({
    s: [...document.querySelectorAll('input.breaktimeStart')].filter(vis),
    e: [...document.querySelectorAll('input.breaktimeEnd')].filter(vis)
  });
  const isUpdate = (el) => /^更\s*新(する)?$/.test(txt(el));
  const CLICKABLE = 'button, input[type=button], input[type=submit], a, [role=button], [onclick], span.ui-button-text';
  const clickables = () => [...document.querySelectorAll(CLICKABLE)].filter(vis);
  const desc = (el) => el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  let last = null;
  const rectOf = (el) => {
    if (!el) return null;
    last = el;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
  };
  /**
   * 休憩ダイアログの「更新」。ダイアログのボタンも勤務表本体と同じ input.common-btn.submit の場合があるため、
   * クラスでは除外せず、ダイアログを開く前に印を付けた本体の「更新」(data-dk-main)だけを除外する。
   * 休憩の入力欄から親をたどり、最初に「更新」が見つかった範囲で一番下のものを選ぶ。
   */
  const dialogSaveEl = () => {
    const inp = breakInputs().s[0];
    if (!inp) return null;
    for (let a = inp.parentElement; a; a = a.parentElement) {
      const c = [...a.querySelectorAll(CLICKABLE)]
        .map(el => (el.matches('span.ui-button-text') && el.closest('button')) || el)
        .filter((el, i, arr) => arr.indexOf(el) === i && vis(el) && isUpdate(el) && !el.hasAttribute('data-dk-main'));
      if (c.length) return c.sort((x, y) => y.getBoundingClientRect().top - x.getBoundingClientRect().top)[0];
    }
    return null;
  };
  window.__dk = {
    /** 勤務表本体の「更新」に印を付ける(休憩ダイアログの「更新」と取り違えないため) */
    markMain() {
      for (const el of document.querySelectorAll('[data-dk-main]')) el.removeAttribute('data-dk-main');
      const els = [...document.querySelectorAll('input.common-btn.submit')].filter(el => vis(el) && isUpdate(el));
      els.forEach(el => el.setAttribute('data-dk-main', '1'));
      return els.length;
    },
    /** 失敗時の手がかり: 画面に見えている「更新」らしき要素 */
    updateCandidates() {
      return [...document.querySelectorAll('*')].filter(el => vis(el) && /更\s*新/.test(txt(el)) && txt(el).length <= 6 && !el.children.length)
        .slice(0, 6).map(el => desc(el) + (el.hasAttribute('data-dk-main') ? '(本体)' : '') + '「' + txt(el) + '」').join(', ');
    },
    hook() {
      window.__msgs = window.__msgs || [];
      if (window.__dkHooked) return true;
      window.confirm = (m) => { window.__msgs.push('confirm: ' + m); return true; };
      window.alert = (m) => { window.__msgs.push('alert: ' + m); };
      window.__dkHooked = true;
      return true;
    },
    takeMsgs() { const m = window.__msgs || []; window.__msgs = []; return m; },
    ready() { return document.readyState === 'complete'; },
    mark() { window.__dkMark = 1; return true; },
    marked() { return !!window.__dkMark; },
    busy() {
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (/更新中|読み込み中/.test(n.nodeValue) && vis(n.parentElement)) return true;
      }
      return false;
    },
    loginForm() { return !!(byId('loginForm') || (byId('contractId') && byId('password'))); },
    loginError() {
      const f = byId('loginForm');
      const el = f && [...f.querySelectorAll('.error, .errorMessage, .err, .alert, [class*=error]')].find(vis);
      return el ? txt(el).slice(0, 120) : '';
    },
    fillLogin(c) {
      const a = byId('contractId'), b = byId('authId'), p = byId('password');
      if (!a || !b || !p) return 'ログイン画面の入力欄が見つかりません';
      setVal(a, c.contractId); setVal(b, c.authId); setVal(p, c.password);
      return '';
    },
    /**
     * 表示中の勤務表の年月。期間のプルダウンは全期間の選択肢を含むため、ページ全体の文字列からは読まない。
     * 1) 期間プルダウンの「選択中」の項目  2) プルダウン以外の文字  3) 1行目の日付(例 10/1)から月だけ
     */
    pageYm() {
      const re1 = /(20\d{2})\s*[年\/.\-]\s*(\d{1,2})\s*[月\/.\-]\s*(\d{1,2})\s*日?\s*(?:\([^)]*\))?\s*[〜～~]/;
      const re2 = /(20\d{2})\s*年\s*(\d{1,2})\s*月/;
      const pick = (t) => { const m = String(t || '').match(re1) || String(t || '').match(re2); return m ? { y: Number(m[1]), m: Number(m[2]) } : null; };
      for (const sel of document.querySelectorAll('select')) {
        if (!vis(sel) || sel.selectedIndex < 0) continue;
        const r = pick(sel.options[sel.selectedIndex].text);
        if (r) return r;
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && !n.parentElement.closest('select,option,script,style') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const r = pick(n.nodeValue);
        if (r) return r;
      }
      const r0 = row(0);
      const md = r0 && txt(r0.children[0]).match(/^(\d{1,2})\/1\(/);
      if (md) return { y: null, m: Number(md[1]) };
      return null;
    },
    hasRows() { return !!row(0); },
    readRow(i) {
      const r = row(i);
      if (!r) return null;
      const sel = byId(`chartDto.attendanceDtos[${i}].attendId`);
      const st = byId(`chartDto.attendanceDtos[${i}].worktimeStart`), en = byId(`chartDto.attendanceDtos[${i}].worktimeEnd`);
      const c = r.children;
      return {
        date: txt(c[0]), attend: sel ? sel.value : '', attendText: sel && sel.selectedIndex >= 0 ? txt(sel.options[sel.selectedIndex]) : '',
        hasAttend1: !!(sel && [...sel.options].some(o => o.value === '1')),
        start: st ? st.value.trim() : '', end: en ? en.value.trim() : '',
        locked: !!(st && (st.disabled || st.readOnly)) || !!(en && (en.disabled || en.readOnly)),
        hasInputs: !!(st && en),
        breakText: c[5] ? txt(c[5]) : '', workText: c[7] ? txt(c[7]) : '',
        hasBreakLink: !!(c[5] && c[5].querySelector('a'))
      };
    },
    setRow(i, v) {
      const sel = byId(`chartDto.attendanceDtos[${i}].attendId`);
      const st = byId(`chartDto.attendanceDtos[${i}].worktimeStart`), en = byId(`chartDto.attendanceDtos[${i}].worktimeEnd`);
      if (!sel || !st || !en) return '勤務区分・開始・終了の入力欄が見つかりません';
      if (![...sel.options].some(o => o.value === v.attend)) return '勤務区分「出勤」が選べません';
      sel.value = v.attend; fire(sel, 'change');
      setVal(st, v.start); setVal(en, v.end);
      if (sel.value !== v.attend || !st.value || !en.value) return '値を入力できませんでした'; // 表示形式(9:30 等)の差は保存後の読み戻しで確認
      return '';
    },
    breakCount() { const b = breakInputs(); return Math.min(b.s.length, b.e.length); },
    setBreak(n, s, e) {
      const b = breakInputs();
      if (!b.s[n] || !b.e[n]) return `休憩${n + 1}行目の入力欄が見つかりません`;
      setVal(b.s[n], s); setVal(b.e[n], e);
      return '';
    },
    clearBreaksFrom(n) {
      const b = breakInputs();
      for (let k = n; k < Math.min(b.s.length, b.e.length); k++) { if (b.s[k].value) setVal(b.s[k], ''); if (b.e[k].value) setVal(b.e[k], ''); }
      return true;
    },
    /** 実クリックする要素の中心座標(CSS px)。見つからなければ null */
    target(kind, arg) {
      if (kind === 'breakLink') { const r = row(arg); return rectOf(r && r.children[5] && r.children[5].querySelector('a')); }
      if (kind === 'addBreak') return rectOf([...document.querySelectorAll("input[type=button][value='休憩を追加']")].find(vis));
      if (kind === 'dialogSave') return rectOf(dialogSaveEl());
      if (kind === 'mainSave') return rectOf([...document.querySelectorAll('input.common-btn.submit')].find(el => vis(el) && isUpdate(el)));
      if (kind === 'loginSubmit') {
        return rectOf([...document.querySelectorAll('input.common-btn.submit')].find(el => vis(el) && txt(el) === 'ログイン') ||
          [byId('submit')].find(vis));
      }
      if (kind === 'text') return rectOf(clickables().find(el => txt(el).includes(arg)));
      return null;
    },
    /** 実クリックが届かない場合の予備(合成クリック) */
    clickLast() { if (!last) return false; last.click(); return true; }
  };
  return true;
}

class Bot {
  constructor({ show = false, log = () => {} } = {}) {
    const { BrowserWindow } = require('electron');
    this.log = log;
    this.win = new BrowserWindow({
      show, width: 1280, height: 900, title: 'レコル(全自動勤怠管理くん)',
      webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    });
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.keepOpen = false;
  }
  get wc() { return this.win.webContents; }
  alive() { return this.win && !this.win.isDestroyed(); }

  /** ページで式を評価(遷移中などで失敗したら undefined) */
  async ev(expr, timeoutMs = 8000) {
    if (!this.alive()) throw new Error('レコルのウィンドウが閉じられました');
    const code = `(function(){ if (!window.__dk) (${pageLib.toString()})(); return (${expr}); })()`;
    let t;
    try {
      return await Promise.race([
        this.wc.executeJavaScript(code, true),
        new Promise(r => { t = setTimeout(() => r(undefined), timeoutMs); })
      ]);
    } catch (e) { return undefined; } finally { clearTimeout(t); }
  }

  async waitFor(fn, timeoutMs, everyMs = 250) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(everyMs);
    }
    return false;
  }

  async load(url) {
    this.wc.loadURL(url).catch(() => {}); // リダイレクト(ログイン画面)で ERR_ABORTED になることがある
    await sleep(500);
    return this.waitFor(async () => !this.wc.isLoading() && (await this.ev('__dk.ready()')) === true, 30000);
  }

  /** 読み込み・「更新中」「読み込み中」が消えるまで待つ(最大20秒)+500ms */
  async waitIdle(timeoutMs = 20000) {
    await sleep(400);
    const ok = await this.waitFor(async () => !this.wc.isLoading() && (await this.ev('__dk.ready() && !__dk.busy()')) === true, timeoutMs);
    await sleep(500);
    return ok;
  }

  /** 実クリック(webContents.sendInputEvent・CSS px)。要素が無ければ false */
  async click(kind, arg) {
    const r = await this.ev(`__dk.target(${JSON.stringify(kind)}, ${JSON.stringify(arg == null ? null : arg)})`);
    if (!r || !r.w || !r.h) return false;
    await sleep(150); // scrollIntoView の反映待ち
    const r2 = (await this.ev(`__dk.target(${JSON.stringify(kind)}, ${JSON.stringify(arg == null ? null : arg)})`)) || r;
    const x = Math.round(r2.x), y = Math.round(r2.y);
    if (x < 0 || y < 0 || x > r2.vw || y > r2.vh) return false;
    this.wc.sendInputEvent({ type: 'mouseMove', x, y });
    this.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(40);
    this.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return true;
  }

  async alerts() {
    const m = (await this.ev('__dk.takeMsgs()')) || [];
    return m.filter(s => String(s).startsWith('alert: ')).map(s => String(s).slice(7).replace(/\s+/g, ' ').trim());
  }

  /** 勤務表を開く。ログイン画面なら保存済みのログイン情報で入る */
  async open(cred) {
    if (!(await this.load(TIMESHEET_URL))) return { ok: false, error: 'レコルを開けませんでした(ネットワークを確認してください)' };
    if (await this.ev('__dk.loginForm()')) {
      if (!cred || !cred.contractId || !cred.authId || !cred.password) return { ok: false, login: true, error: 'レコルのログイン情報が未設定です' };
      this.log('ログイン画面を検知。保存済みのログイン情報でログインします');
      const err = await this.ev(`__dk.fillLogin(${JSON.stringify(cred)})`);
      if (err !== '') return { ok: false, login: true, error: err || 'ログイン画面を操作できませんでした' };
      await this.ev('__dk.mark()');
      if (!(await this.click('loginSubmit'))) {
        // 実クリックできない場合はフォーム送信ボタンを合成クリック
        const found = await this.ev("(document.querySelector('input.common-btn.submit') || document.getElementById('submit')) ? (document.querySelector('input.common-btn.submit') || document.getElementById('submit')).click() || true : false");
        if (!found) return { ok: false, login: true, error: 'ログインボタンが見つかりません' };
      }
      await this.waitFor(async () => (await this.ev('__dk.marked()')) !== true && (await this.ev('__dk.ready()')) === true, 20000);
      await this.waitIdle();
      if (await this.ev('__dk.loginForm()')) {
        const msg = await this.ev('__dk.loginError()');
        return { ok: false, login: true, error: 'レコルにログインできませんでした' + (msg ? `(${msg})` : '') };
      }
      if (!(await this.load(TIMESHEET_URL))) return { ok: false, error: 'ログイン後に勤務表を開けませんでした' };
    }
    await this.waitIdle();
    if (await this.ev('__dk.loginForm()')) return { ok: false, login: true, error: 'レコルにログインできませんでした' };
    if (!(await this.ev('__dk.hasRows()'))) return { ok: false, error: '勤務表の行が見つかりません(画面の構成が変わった可能性があります)' };
    return { ok: true };
  }

  /** 対象月の勤務表に切り替える(前月へ / 翌月へ) */
  async ensureMonth(y, m, st) {
    const target = y * 12 + m;
    for (let attempt = 0; attempt < 3; attempt++) {
      let parsed = await this.ev('__dk.pageYm()');
      if (parsed && parsed.y == null) parsed = { y: Math.abs(parsed.m - m) <= 6 ? y : (parsed.m > m ? y - 1 : y + 1), m: parsed.m }; // 1行目の日付だけの場合は対象年の前後から推定
      const cur = parsed ? parsed.y * 12 + parsed.m : st.cur;
      st.cur = cur;
      if (cur === target) return '';
      const dir = target < cur ? '前月へ' : '翌月へ';
      await this.ev('__dk.mark()');
      if (!(await this.click('text', dir))) {
        if (!(await this.ev(`__dk.target('text', ${JSON.stringify(dir)}) && __dk.clickLast()`))) return `「${dir}」が見つかりません`;
      }
      await this.waitFor(async () => (await this.ev('__dk.marked()')) !== true && (await this.ev('__dk.ready()')) === true, 15000);
      await this.waitIdle();
      if (!parsed) st.cur = cur + (dir === '前月へ' ? -1 : 1);
    }
    let last = await this.ev('__dk.pageYm()');
    if (last && last.y == null) last = { y, m: last.m };
    if (last && last.y * 12 + last.m === target) return '';
    if (!last && st.cur === target) return '';
    return `${y}年${m}月の勤務表に切り替えられませんでした`;
  }

  /** 休憩ダイアログで休憩を入れて「更新」 */
  async doBreaks(i, breaks) {
    await this.ev('__dk.hook()');
    await this.ev('__dk.markMain()');
    let open = false;
    for (let t = 0; t < 2 && !open; t++) {
      if (!(await this.click('breakLink', i))) return '休憩の編集リンクが見つかりません';
      open = await this.waitFor(async () => (await this.ev('__dk.breakCount()')) > 0, 5000);
    }
    if (!open) return '休憩の入力画面が開きません';
    for (let n = 0; n < breaks.length; n++) {
      let cnt = await this.ev('__dk.breakCount()');
      if (cnt <= n) {
        await sleep(150);
        if (!(await this.click('addBreak'))) return '「休憩を追加」が見つかりません';
        const added = await this.waitFor(async () => (await this.ev('__dk.breakCount()')) > n, 3000);
        if (!added) return `休憩${n + 1}行目を追加できませんでした`;
      }
      const err = await this.ev(`__dk.setBreak(${n}, ${JSON.stringify(breaks[n].sIn)}, ${JSON.stringify(breaks[n].eIn)})`);
      if (err !== '') return err || '休憩を入力できませんでした';
    }
    await this.ev(`__dk.clearBreaksFrom(${breaks.length})`);
    await this.ev('__dk.hook()');
    await this.ev('__dk.takeMsgs()');
    // 画面外にはみ出して実クリックできない場合は、要素への直接クリックも試す
    if (!(await this.click('dialogSave')) && !(await this.ev(`__dk.target('dialogSave') && __dk.clickLast()`))) {
      const seen = await this.ev('__dk.updateCandidates()').catch(() => '');
      return '休憩の「更新」ボタンが見つかりません' + (seen ? `(画面上の候補: ${seen})` : '');
    }
    await this.waitIdle();
    await this.ev('__dk.hook()');
    const al = await this.alerts();
    if (al.length) return 'レコルのエラー(休憩): ' + al.join(' / ');
    const closed = await this.waitFor(async () => (await this.ev('__dk.breakCount()')) === 0, 3000);
    if (!closed) return '休憩の入力画面が閉じません(入力内容がレコルに受け付けられていない可能性があります)';
    return '';
  }

  /** 1日分を転記。結果 {key, status:'ok'|'skip'|'fail', reason, rk, adjusted, saved} */
  async postDay(it, { overwrite }, st) {
    const [y, m, d] = it.key.split('-').map(Number);
    const i = d - 1;
    const fail = (reason, extra = {}) => ({ key: it.key, status: 'fail', reason, ...extra });
    const skip = (reason) => ({ key: it.key, status: 'skip', reason });
    let err = await this.ensureMonth(y, m, st);
    if (err) return fail(err);
    const r = await this.ev(`__dk.readRow(${i})`);
    if (!r) return fail('勤務表の行が見つかりません');
    if (!P.rowDateMatches(r.date, m, d)) return fail(`勤務表の行の日付が一致しません(「${r.date}」)`);
    if (!r.hasInputs) return fail('開始・終了の入力欄が見つかりません');
    // 開始・終了の入力欄が編集不可(このアプリは確定・申請を行わない。レコル側の確定・申請・締め・権限による)
    if (r.locked) {
      return skip(r.start || r.end
        ? `レコルで編集できない状態です(${r.start || '--:--'}〜${r.end || '--:--'}。確定・申請済みなど)`
        : 'レコルで開始・終了が編集できない状態です(空欄のまま。レコルで確定・申請済み、締め済み、または入力権限がない可能性があります)');
    }
    if (!overwrite && (r.start || r.end)) return skip(`レコルに入力済み(${r.start || '--:--'}〜${r.end || '--:--'})`);
    if (!overwrite && LEAVE_RE.test(r.attendText)) return skip(`レコルの勤務区分が「${r.attendText}」のため`);
    if (!r.hasAttend1) return fail('勤務区分「出勤」が選べません');

    const existingBreak = P.parseHM(r.breakText);
    if (it.breaks.length || existingBreak > 0) {
      if (!r.hasBreakLink) return fail('休憩の編集リンクが見つかりません');
      err = await this.doBreaks(i, it.breaks);
      if (err) return fail(err);
      // ダイアログの保存で月が戻っていないか
      err = await this.ensureMonth(y, m, st);
      if (err) return fail(err);
    }

    // ダイアログ保存で行の未保存値が消えるため、勤務区分・開始・終了はここで入れる
    await this.ev('__dk.hook()');
    await this.ev('__dk.takeMsgs()');
    err = await this.ev(`__dk.setRow(${i}, ${JSON.stringify({ attend: '1', start: it.startIn, end: it.endIn })})`);
    if (err !== '') return fail(err || '開始・終了を入力できませんでした', { saved: !!it.breaks.length });
    if (!(await this.click('mainSave'))) return fail('「更新」ボタンが見つかりません', { saved: !!it.breaks.length });
    await this.waitIdle();
    await this.ev('__dk.hook()');
    const al = await this.alerts();
    if (al.length) return fail('レコルのエラー: ' + al.join(' / '), { saved: !!it.breaks.length });

    err = await this.ensureMonth(y, m, st);
    if (err) return fail('保存後の確認ができません: ' + err, { saved: true });
    const back = await this.ev(`__dk.readRow(${i})`);
    if (!back || !P.rowDateMatches(back.date, m, d)) return fail('保存後の行を読み取れません(レコルで確認してください)', { saved: true });
    const v = P.verifyRow(it, back);
    if (!v.ok) return fail('保存しましたが内容が一致しません: ' + v.issues.join(' / ') + '(レコルで確認してください)', { saved: true, rk: v.rk });
    return { key: it.key, status: 'ok', reason: v.adjusted ? 'レコルの規定で休憩が自動調整されました' : '', rk: v.rk, adjusted: v.adjusted, saved: true };
  }

  close() {
    if (this.keepOpen || !this.alive()) return;
    try { this.win.destroy(); } catch (_) {}
  }

  /** ログインできない時は、ウィンドウを表示して手動ログインしてもらう(閉じると破棄) */
  showForLogin() {
    if (!this.alive()) return;
    this.keepOpen = true;
    this.win.setTitle('レコルにログインしてください(ログイン後はこのウィンドウを閉じて、もう一度「レコルに転記する」を押してください)');
    this.win.show(); this.win.focus();
  }
}

/**
 * ログイン確認、または転記。
 * @param opts.mode 'test' | 'post'
 * @param opts.prepare async () => items  ログイン成功後に呼ばれ、転記する値(dayValues の配列)を返す
 * @returns {ok, error, login, results}
 */
async function run({ mode = 'post', cred, prepare, overwrite = false, show = false, timeoutMs = 3 * 60 * 1000, log = () => {} }) {
  let bot = null;
  const results = [];
  const deadline = Date.now() + timeoutMs;
  let timer;
  const work = (async () => {
    bot = new Bot({ show, log });
    const o = await bot.open(cred);
    if (!o.ok) {
      if (o.login) bot.showForLogin();
      return { ok: false, error: o.error, login: !!o.login, results };
    }
    if (mode === 'test') return { ok: true, message: 'レコルにログインし、勤務表を開けました', results };
    const items = (await prepare()) || [];
    const st = { cur: (() => { const n = new Date(); return n.getFullYear() * 12 + n.getMonth() + 1; })() };
    for (const it of items) {
      if (Date.now() > deadline) { results.push({ key: it.key, status: 'fail', reason: 'タイムアウト(未処理)' }); continue; }
      let r;
      try { r = await bot.postDay(it, { overwrite }, st); } catch (e) { r = { key: it.key, status: 'fail', reason: String((e && e.message) || e).slice(0, 200) }; }
      log(`${it.key}: ${r.status}${r.reason ? ' ' + r.reason : ''}`);
      results.push(r);
      // 画面が想定と違う(要素が無い)場合は、以降の日も同じ結果になりやすいので打ち切る
      if (r.status === 'fail' && /見つかりません|切り替えられません|閉じられました/.test(r.reason)) {
        for (const rest of items.slice(items.indexOf(it) + 1)) results.push({ key: rest.key, status: 'fail', reason: '前の日の転記に失敗したため中止' });
        break;
      }
    }
    return { ok: results.every(r => r.status !== 'fail'), results };
  })();
  const timeout = new Promise(r => { timer = setTimeout(() => r({ ok: false, error: `タイムアウト(${Math.round(timeoutMs / 60000)}分)`, results, timeout: true }), timeoutMs + 15000); });
  try {
    const out = await Promise.race([work, timeout]);
    if (out.timeout) {
      // 処理中だった日は不明として残す(次回やり直し。入力済みならスキップされる)
      out.results = results.slice();
    }
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), results };
  } finally {
    clearTimeout(timer);
    if (bot) bot.close();
  }
}

module.exports = { run, TIMESHEET_URL, PARTITION, pageLib };
