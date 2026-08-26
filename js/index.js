// ============================================================
// 設定
// ============================================================
// API_URL / ANON_KEY / CLIENT_ID は js/api.js（共有通信層）で定義
// ALLOWED配列は廃止（管理者一覧はサーバー側で判定）
const DOW7      = ['月','火','水','木','金','土','日'];
// 日曜始まり。スロットキー（第N週 M/D(曜) HH:MM~HH:MM）はサーバーの
// _shared.ts の DAY / dateLabel と一字一句そろえないと紐づけが外れる
const DOW_SUN   = ['日','月','火','水','木','金','土'];
// 時間の選択肢 0〜23
const HOURS_LIST = Array.from({length:24},(_,i)=>String(i).padStart(2,'0'));
const MINS_LIST  = ['00','15','30','45'];
const INTV_LIST  = [5,10,15,20,30];

// ============================================================
// 状態
// ============================================================
let currentPwType = 'normal'; // 'normal' | 'limited' | 'limited2' | ...
let limitedSlots  = [];       // [{id:'limited', name:'限定PW'}, ...]
const _initNow = new Date();
const _nextM = new Date(_initNow.getFullYear(), _initNow.getMonth() + 1, 1);
let curY  = _nextM.getFullYear();
let curM  = _nextM.getMonth() + 1;  // 対象月（来月をデフォルト）
let _currentUser = null;                   // ログイン中の管理者情報
let calY  = _initNow.getFullYear(), calM  = _initNow.getMonth() + 1;  // カレンダー表示月（限定PW専用）
let adminData   = null;
let adminPhases = [];  // 限定PWフェーズ一覧（getAdminData で取得）
let currentPhaseIndex = 0; // 現在編集中のフェーズ番号
let slots       = [];    // [{y,m,d,time,interval}]
let dates       = {apply:null, deadline:null, open:null};
let popupDay    = null;
let popupTimes  = [];

// ============================================================
// 認証
//
// このアプリはログイン画面を持たない。未認証なら共通ログイン画面
// （login.html）へリダイレクトし、認証が済んだ状態で戻ってくる
// ============================================================

// 救済ログインのセッションで管理アプリに入る（Googleアカウントが使えない管理者向け）。
// 有効期限はサーバー側で検証される。shift-form と同一オリジンのため localStorage を共有できる
async function tryRecoveryLogin() {
  let token = '';
  try { token = localStorage.getItem('pwgws_recovery_session') || ''; } catch (_) {}
  if (!token) return false;
  try {
    const res = await apiPost({ action: 'validateRecoverySession' });
    if (!res.ok || !res.isAdmin) return false;
    _currentUser = { uid: res.uid || '', name: res.name, email: '', isRecoverySession: true };
    document.getElementById('loading').classList.add('show');
    setLoadingStep(3, 'データを読み込み中...');
    const av = document.getElementById('av');
    av.textContent = ([...res.name || '?'][0] || '?').toUpperCase();
    const now = new Date();
    const _nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    curY = _nm.getFullYear(); curM = _nm.getMonth() + 1;
    calY = now.getFullYear(); calM = now.getMonth() + 1;
    await loadAdminData({ initial: true });
    if (res.daysLeft <= 3) {
      setTimeout(() => uiAlert({
        type: 'warn', title: '一時ログインの期限が近づいています',
        message: 'この一時ログインはあと ' + res.daysLeft + '日で終了します。\n'
          + 'Googleアカウントの再設定、またはメールアドレスの変更を済ませてください。',
      }), 1500);
    }
    return true;
  } catch (e) { return false; }
}

// 自動ログイン（救済セッション → One Tap → localStorageフォールバック）
async function tryAutoLogin() {
  // 基準時刻より前の古いセッションは破棄して、共通ログイン画面からやり直してもらう
  // （Googleのアイコンなどログイン時にしか取れない情報を集めるため。1度きり）
  if (pwgwsEnforceRelogin()) {
    try { localStorage.removeItem('adminUser'); } catch (_) {}
    pwgwsGoToLogin();
    return;
  }

  // Googleアカウントが使えない管理者のための救済セッションを最優先で確認
  if (await tryRecoveryLogin()) return;

  // 共通セッションの不透明tokenがある場合だけ復元する。adminUser は表示用キャッシュであり、
  // 本人確認・権限確認には使わない。
  const shared = pwgwsGetSession();
  if (shared && pwgwsGetSessionToken()) {
    processUser({ email: shared.email, name: shared.name, picture: shared.picture }, false);
    return;
  }

  // 未ログイン：共通ログイン画面へ送る（このアプリ内に認証画面は持たない）
  pwgwsGoToLogin();
}
// リダイレクトは即座に判断してよいので待たない
tryAutoLogin();

function processUser(u, save = true) {
  _processUserWithGasAuth(u, save);
}
async function _processUserWithGasAuth(u, save) {
  if (!document.getElementById('loading').classList.contains('show')) {
    document.getElementById('loading').classList.add('show');
  }
  setLoadingStep(2, '管理者権限を確認中...');
  // 認証応答は try の外（アイコン表示・localStorage 保存）でも使うので、
  // try の中で const 宣言してはいけない。ブロックスコープから漏れて
  // ReferenceError になり、しかも catch の外なので権限確認のまま止まる
  let auth = null;
  try {
    const res = await apiAuthGet(u.email, 'admin');
    if (!res.ok) { showAuthErr('', 'unauthorized'); return; }
    if (!res.isAdmin) { showAuthErr('', 'noadmin'); return; }
    auth = res;
    // ログインユーザー情報を保持（uid空＝オーナーアカウント）
    _currentUser = { uid: res.uid || '', name: res.name || '', email: res.email || '' };
  } catch(e) { showAuthErr('認証に失敗しました: ' + e.message); return; }
  // ログイン情報をlocalStorageに保存（次回自動ログイン用）
  if (save) {
    try { localStorage.setItem('adminUser', JSON.stringify({ email: auth.email, name: auth.name, picture: u.picture, avatar: auth.avatar || '', isAdmin: true })); } catch(e) {}
    // 他の2アプリでもログイン済みとして扱えるよう共通セッションにも保存する
    pwgwsSaveSession(auth.email, auth.name, u.picture);
  }
  const av = document.getElementById('av');
  // フォームアプリで設定したアバター（auth.avatar）を優先し、未設定ならGoogle写真にフォールバック
  const avSrc = (auth && auth.avatar) || u.picture;
  if (avSrc) {
    const img = document.createElement('img');
    img.src = avSrc;
    img.alt = '';
    img.onerror = () => { av.innerHTML = ''; av.textContent = ([...u.name||u.email][0]||'?').toUpperCase(); };
    av.innerHTML = '';
    av.appendChild(img);
  } else {
    av.textContent = ([...u.name||u.email][0]||'?').toUpperCase();
  }
  const now = new Date();
  const _nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  curY = _nm.getFullYear();
  curM = _nm.getMonth() + 1; // 来月をデフォルト
  calY = now.getFullYear(); calM = now.getMonth() + 1;
  setLoadingStep(3, 'データを読み込み中...');
  await loadAdminData({ initial: true });
}
// アカウント切り替えメニュー（実体は共有の session.js。3アプリで同じ見た目にするため）
function openAccountMenu(el) {
  pwgwsOpenAccountMenu(el, { onSignOut: signOut });
}
function signOut() {
  try { localStorage.removeItem('adminUser'); } catch(e) {}
  // 共通セッション・救済ログインも併せて破棄する（3アプリ共通のログアウト）
  pwgwsClearSession();
  // ログアウト後は共通ログイン画面へ戻す
  // （Google認証は login.html 側で行うため、ここでGISを触ってはいけない）
  pwgwsGoToLogin();
}
function setLoadingStep(step, msg) {
  document.getElementById('ld-status').textContent = msg;
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById('ldst-' + i);
    el.classList.remove('active', 'done');
    if (i < step) el.classList.add('done');
    else if (i === step) el.classList.add('active');
    if (i < 3) document.getElementById('ldsl-' + i).classList.toggle('done', i < step);
  }
  const pct = [0, 20, 55, 80];
  document.getElementById('ld-bar').style.width = pct[step] + '%';
}
// 認証に関する失敗は共通ログイン画面へ戻して、そこで理由を表示させる。
// データ読み込み失敗など認証以外の失敗はこの画面上に出す
function showAuthErr(msg, reason) {
  if (reason === 'noadmin') {
    // 管理者権限が無いだけで、本人としては正しくログインできている。
    // アカウント切り替えで個人アカウントに変えたときがこれにあたるので、
    // ログアウトさせずにフォームアプリへ送る
    // （ここで pwgwsClearSession を呼ぶと保存済みアカウントが全部消える）
    try { localStorage.removeItem('adminUser'); } catch (_) {}
    location.replace(PWGWS_FORM_URL);
    return;
  }
  if (reason) {
    // 誤ったアカウントのセッションが残り続けないよう破棄してから戻す
    try { localStorage.removeItem('adminUser'); } catch (_) {}
    pwgwsClearSession();
    pwgwsGoToLogin(reason);
    return;
  }
  document.getElementById('loading').classList.remove('show');
  const el = document.getElementById('load-err');
  el.textContent = msg;
  setVisible(el, true);
}

// apiGet は js/api.js（共有通信層）で定義

// ============================================================
// データ読み込み
// ============================================================
let _adminLoadGeneration = 0;
let _adminSwitching = false;

function parseEventDate(value, targetYear, targetMonth) {
  if (!value) return null;
  let y, m, d;
  if (typeof value === 'object') {
    y = Number(value.y ?? value.year);
    m = Number(value.m ?? value.month);
    d = Number(value.d ?? value.day);
  } else {
    const text = String(value).trim();
    let hit = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
    if (hit) {
      y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]);
    } else {
      // 旧APIの M/D だけは移行中の表示を壊さないため受ける。年は対象月に
      // 最も近い候補を選び、1月分の申込開始日=前年12月も正しく扱う。
      hit = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
      if (!hit) return null;
      m = Number(hit[1]); d = Number(hit[2]);
      const base = Number(targetYear) * 12 + Number(targetMonth) - 1;
      y = [Number(targetYear) - 1, Number(targetYear), Number(targetYear) + 1]
        .sort((a, b) => Math.abs(a * 12 + m - 1 - base) - Math.abs(b * 12 + m - 1 - base))[0];
    }
  }
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(y, m - 1, d);
  return check.getFullYear() === y && check.getMonth() + 1 === m && check.getDate() === d ? { y, m, d } : null;
}

function applyEventDates(eventDates, targetYear, targetMonth) {
  const src = eventDates || {};
  dates.apply    = parseEventDate(src['申込開始'], targetYear, targetMonth);
  dates.deadline = parseEventDate(src['締切'], targetYear, targetMonth);
  dates.open     = parseEventDate(src['シフト公開'], targetYear, targetMonth);
}

async function fetchAdminMonthBundle(year, month, type) {
  const target = { year, month, type };
  const [data, calStatus, shiftStatusResult, calApprovalResult] = await Promise.all([
    apiGet('adminData', target),
    apiGet('getCalPubStatus', { type }),
    apiGet('getShiftPublishStatus', target),
    apiGet('getCalApprovalStatus', target),
  ]);
  if (!data || data.ok === false) throw new Error((data && data.error) || '管理データの取得に失敗しました');
  [calStatus, shiftStatusResult, calApprovalResult].forEach(result => {
    if (result && result.ok === false) throw new Error(result.error || '公開・承認状態の取得に失敗しました');
  });
  return { data, calStatus, shiftStatusResult, calApprovalResult };
}

function showInitialApp() {
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    document.getElementById('ld-bar').style.width = '100%';
    setTimeout(() => {
      document.getElementById('loading').classList.remove('show');
      setVisible(document.getElementById('app'), true);
    }, 400);
  };
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, 1000);
}

async function loadAdminData(options) {
  const opts = options || {};
  const targetYear = Number(opts.year || curY);
  const targetMonth = Number(opts.month || curM);
  const targetType = opts.type || currentPwType;
  const generation = ++_adminLoadGeneration;
  try {
    const bundle = await fetchAdminMonthBundle(targetYear, targetMonth, targetType);
    if (generation !== _adminLoadGeneration) return false;
    const d = bundle.data;

    // 取得が全部成功してから対象年月・PWとDOMを一度に更新する。
    curY = targetYear; curM = targetMonth; currentPwType = targetType;
    if (targetType !== 'normal') { calY = targetYear; calM = targetMonth; }
    adminData = d;
    applyEventDates(d.eventDates, targetYear, targetMonth);
    slots = (d.currentSlots || []).map(s => ({
      y: Number(s.y || targetYear), m: Number(s.m || targetMonth), d: Number(s.d),
      time: s.time, interval: parseInt(s.interval) || 15,
    }));
    // 保存済みの前月との紐づけ。実施日設定モーダルの既定値として使う。
    slotMapping = d.slotMapping || {};
    if (d.limitedSlots) limitedSlots = d.limitedSlots;
    adminPhases = d.phases || [];
    currentPhaseIndex = 0;
    if (currentPwType !== 'normal') syncSlotsFromPhases();

    applyCalPubStatus(bundle.calStatus);
    applyShiftStatus(bundle.shiftStatusResult, targetYear, targetMonth);
    applyCalApprovalStatus(bundle.calApprovalResult, targetYear, targetMonth);
    renderPwTypeTabs();
    renderAll();
    renderProgressStrip();
    if (currentPwType === 'normal') loadPendingCounts();
    if (opts.initial) showInitialApp();
    return true;
  } catch(e) {
    if (generation !== _adminLoadGeneration) return false;
    if (opts.initial) showAuthErr('データの読み込みに失敗しました: ' + e.message);
    if (opts.rethrow) throw e;
    if (!opts.initial) toast('データの読み込みに失敗しました: ' + e.message, 'e');
    return false;
  }
}

function renderAll() {
  const isLimited = currentPwType !== 'normal';
  // 年月ナビは限定PWでは不要なため非表示
  const nav = document.getElementById('cal-ym-nav');
  if (nav) nav.style.visibility = isLimited ? 'hidden' : 'visible';
  const slotsArea = document.getElementById('info-slots-card');
  setVisible(slotsArea, !isLimited);
  const datesArea = document.getElementById('info-dates-card');
  setVisible(datesArea, !isLimited);
  // 限定PWでもカレンダーエリアを表示
  const calArea = document.getElementById('cal-scroll-area');
  setVisible(calArea, true);
  // cal-view-nav は限定PWのみ表示（通常PWは前月+管理月の2ヶ月固定のため不要）
  const calViewNavBar = document.getElementById('cal-view-nav-bar');
  setVisible(calViewNavBar, isLimited);
  updYmTitle();
  updDateViews();
  buildCalScroll();
  buildSlotSetList();
  buildInfoArea();
}

// ============================================================
// 年月タイトル・ドロップダウン
// ============================================================
function updYmTitle() {
  const t = curY+'年'+curM+'月';
  const el1 = document.getElementById('ym-title-text');
  if(el1) el1.textContent = t+' PW';
  const el2 = document.getElementById('cal-ym-label');
  if(el2) el2.textContent = t;
  // 対象年月を動かしたら、公開中の月とのズレ表示も即座に追従させる
  updCalPubState();
}
function updCalViewLabel() {
  const el = document.getElementById('cal-view-label');
  if(el) el.textContent = calY+'年'+calM+'月';
}
// 年月の表示そのものを押して対象年月を選ぶ。
// ‹ › の送りだけだと数ヶ月先へ行くのに何度も押すことになるため
function openYmPicker(el) {
  openMonthPicker(el, {
    title: '対象年月', year: curY, month: curM,
    onPick: (y, m) => { if (y !== curY || m !== curM) setYm(y, m); },
  });
}

// 限定PWのカレンダー表示月（対象年月とは別物。表示を送るだけ）
function openCalViewPicker(el) {
  openMonthPicker(el, {
    title: 'カレンダー表示月', year: calY, month: calM,
    note: '表示する月を変えるだけで、対象年月は変わりません',
    onPick: (y, m) => { calY = y; calM = m; buildCalScroll(); },
  });
}

// ============================================================
// カレンダースクロール（当月から6ヶ月分表示）
// ============================================================
function buildCalScroll() {
  const area = document.getElementById('cal-scroll-area');
  area.innerHTML = '';
  updCalViewLabel();
  // 通常PW: 前月 + 管理月の2ヶ月固定 / 限定PW: calY/calM から6ヶ月
  const months = [];
  if (currentPwType === 'normal') {
    months.push(prevMonth(curY, curM));
    months.push({y: curY, m: curM});
  } else {
    let my = calY, mm = calM;
    for (let i = 0; i < 6; i++) {
      months.push({y: my, m: mm});
      if (mm === 12) { my++; mm = 1; } else { mm++; }
    }
  }
  months.forEach(({y,m}) => {
    const block = document.createElement('div');
    block.className = 'cal-month-block';
    block.id = 'cal-block-'+y+'-'+m;
    const lbl = document.createElement('div');
    lbl.style.cssText='font-size:11px;font-weight:700;color:var(--ink3);padding:0 2px 4px;';
    lbl.textContent = y+'年'+m+'月';
    const cal = document.createElement('div');
    cal.className = 'mini-cal';
    cal.innerHTML = '<div class="cal-dows"><div class="cdow">月</div><div class="cdow">火</div><div class="cdow">水</div><div class="cdow">木</div><div class="cdow">金</div><div class="cdow sat">土</div><div class="cdow sun">日</div></div><div class="cal-body" id="cg-'+y+'-'+m+'"></div>';
    block.appendChild(lbl);
    block.appendChild(cal);
    area.appendChild(block);
    buildCalGrid('cg-'+y+'-'+m, y, m, 'main');
  });
  // 先頭（前月）にスクロール
  area.scrollTop = 0;
}

function prevMonth(y,m){ return m===1?{y:y-1,m:12}:{y,m:m-1}; }
function nextMonth(y,m){ return m===12?{y:y+1,m:1}:{y,m:m+1}; }

function chM(dir) {
  let y = curY, m = curM + dir;
  if (m > 12) { m = 1;  y++; }
  if (m < 1)  { m = 12; y--; }
  setYm(y, m);
}

// 対象年月を切り替える。‹ › の送りと年月ピッカーの入口を1本にまとめている
async function setYm(y, m) {
  const targetYear = Number(y), targetMonth = Number(m);
  if (_adminSwitching || !targetYear || !targetMonth || (targetYear === curY && targetMonth === curM)) return;
  _adminSwitching = true;
  setAdminSwitching(true);
  showProc(targetYear + '年' + targetMonth + '月のデータを読み込んでいます...', '保存済みの画面は読み込みが完了するまで保持されます');
  try {
    await loadAdminData({ year: targetYear, month: targetMonth, type: currentPwType, rethrow: true });
  } catch (e) {
    toast('年月の切り替えを中止しました: ' + e.message, 'e');
  } finally {
    hideProc();
    setAdminSwitching(false);
    _adminSwitching = false;
  }
}
function chCalM(dir) {
  calM += dir;
  if (calM > 12) { calM = 1; calY++; }
  if (calM < 1)  { calM = 12; calY--; }
  buildCalScroll();
}

function setAdminSwitching(on) {
  document.querySelectorAll('#cal-ym-nav button, #cal-view-nav-bar button, #pw-type-bar button')
    .forEach(button => { button.disabled = !!on; });
}

// ============================================================
// カレンダーグリッド描画
// ============================================================
function buildCalGrid(gid, y, m, mode) {
  const g = document.getElementById(gid); if(!g) return;
  const first = new Date(y,m-1,1), last = new Date(y,m,0);
  const today = new Date(); today.setHours(0,0,0,0);
  const fDow = first.getDay(), off = fDow===0?6:fDow-1;
  const toDate = obj => obj ? new Date(obj.y,obj.m-1,obj.d).getTime() : null;
  let _dApply = dates.apply, _dDeadline = dates.deadline, _dOpen = dates.open;
  if (currentPwType !== 'normal' && mode === 'main') {
    const _ph = adminPhases[currentPhaseIndex];
    _dApply = _ph ? _ph.apply : null; _dDeadline = _ph ? _ph.deadline : null; _dOpen = _ph ? _ph.open : null;
  }
  const ap = toDate(_dApply), dl = toDate(_dDeadline), op = toDate(_dOpen);
  let h='';
  for(let i=0;i<off;i++) h+='<div class="cc other"></div>';
  for(let d=1;d<=last.getDate();d++){
    const dt=new Date(y,m-1,d), dow=dt.getDay(), t=dt.getTime();
    const isSat=dow===6, isSun=dow===0, isToday=t===today.getTime();
    const isApply=ap&&t===ap, isDL=dl&&t===dl, isOpen=op&&t===op;
    const inPeriod=ap&&dl&&t>ap&&t<dl;
    const daySlots=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
    const hasSlot=daySlots.length>0;
    let cls='cc'+(isSun?' sun':isSat?' sat':'')+(isToday?' today-c':'');
    if(isApply) cls+=' period-start';
    else if(isDL) cls+=' period-end';
    else if(inPeriod) cls+=' in-period';
    if(hasSlot) cls+=' has-slot'+(mode==='main'&&hasSlot?' slot-picked':'');
    let chips='<div class="cn">'+d+'</div>';
    if(isApply) chips+='<div class="chip apply">申込</div>';
    if(isDL) chips+='<div class="chip deadline">締切</div>';
    if(isOpen) chips+='<div class="chip open">公開</div>';
    if(hasSlot&&!isApply&&!isDL&&!isOpen) chips+='<div class="chip slot">&#9679;'+daySlots.length+'</div>';
    // 期間バー
    if(inPeriod) chips+='<div class="period-bar middle"></div>';
    if(isApply) chips+='<div class="period-bar start"></div>';
    if(isDL) chips+='<div class="period-bar end"></div>';
    let oc='';
    if(mode==='main') oc=`onclick="openDaySelectModal(${y},${m},${d})"`;
    // メインモードでは全日付クリック可能
    if(mode==='main') cls+=' has-slot'; // カーソルpointer
    h+=`<div class="${cls}" ${oc}>${chips}</div>`;
  }
  g.innerHTML=h;
}

// ============================================================
// タブ切り替え
// ============================================================
function swTab(id,btn){
  // 設定タブ廃止 - カレンダー統合
}

// ============================================================
// PW タブ描画
// ============================================================
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}
// esc は escHtml の別名（旧実装同様 null/undefined/0/false/'' は '' として扱う）
function esc(s) { return escHtml(s || ''); }
function setVisible(el, on) { if (el) el.classList.toggle('is-hidden', !on); }

function renderPwTypeTabs() {
  const bar = document.getElementById('pw-type-bar');
  if (!bar) return;
  const isNormal = currentPwType === 'normal';
  let html = `<button type="button" class="pw-type-tab pw-tab-first${isNormal ? ' active normal-tab' : ''}" data-pw-type="normal">通常PW</button>`;

  limitedSlots.forEach((slot, idx) => {
    const isActive = currentPwType === slot.id;
    html += `<button type="button" class="pw-type-tab${isActive ? ' active' : ''}" data-pw-type="${escHtml(slot.id)}">${escHtml(slot.name)}<span class="lt-edit-ic" data-edit-pw="${escHtml(slot.id)}">✏</span></button>`;
  });

  html += '<button type="button" class="pw-type-tab pw-tab-add" data-add-pw>＋</button>';
  bar.innerHTML = html;
  bar.querySelectorAll('[data-pw-type]').forEach(button => {
    button.addEventListener('click', () => switchPwType(button.dataset.pwType || 'normal'));
  });
  bar.querySelectorAll('[data-edit-pw]').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      openEditLimitedSlotModal(button.dataset.editPw || '');
    });
  });
  bar.querySelector('[data-add-pw]')?.addEventListener('click', openAddLimitedSlotModal);

  // 限定PW 対象メンバー管理ボタンの表示切り替え
  const btnLm = document.getElementById('btn-limited-members');
  setVisible(btnLm, currentPwType !== 'normal');

  // 通常PW専用要素（メンバー管理・お知らせ・要望・バグ報告・代理・夫婦・未対応セクションなど）の表示切り替え
  document.querySelectorAll('.normal-only').forEach(b => {
    setVisible(b, currentPwType === 'normal');
  });

  // シフト管理アプリへのリンクに現在のPWタイプを引き継ぐ
  const btnSc = document.getElementById('btn-shift-create');
  if (btnSc) btnSc.href = './shift-create.html' + (currentPwType !== 'normal' ? '?type=' + encodeURIComponent(currentPwType) : '');
}

// ============================================================
// PW モード切り替え
// ============================================================
async function switchPwType(type) {
  if (_adminSwitching || currentPwType === type) return;
  const label = type === 'normal' ? '通常PW' : (limitedSlots.find(s => s.id === type)?.name || '限定PW');
  _adminSwitching = true;
  setAdminSwitching(true);
  showProc(`${label} のデータを読み込んでいます...`, '現在の画面は読み込みが完了するまで保持されます');
  try {
    // type も取得条件として渡し、取得が全て成功した後だけ global/DOM を切り替える。
    await loadAdminData({ year: curY, month: curM, type, rethrow: true });
    const slotName = limitedSlots.find(s => s.id === type);
    toast(type === 'normal' ? '通常PWモードに切り替えました' : `${slotName ? slotName.name : '限定PW'}モードに切り替えました`, 's');
  } catch (e) {
    toast('PW切り替えを中止しました: ' + e.message, 'e');
  } finally {
    hideProc();
    setAdminSwitching(false);
    _adminSwitching = false;
  }
}

// ============================================================
// 限定PW 対象メンバー管理
// ============================================================
let _limitedMembersCache = [];
let _allMembersForPicker  = [];

async function openLimitedMembersModal() {
  // モーダルタイトルを現在の限定PWスロット名に更新
  const slot = limitedSlots.find(s => s.id === currentPwType);
  const title = document.querySelector('#m-limited-members .mt');
  if (title) title.textContent = `🔐 ${slot ? slot.name : '限定PW'} 対象メンバー管理`;
  openM('m-limited-members');
  await refreshLimitedMemberList();
}

async function refreshLimitedMemberList() {
  const listEl = document.getElementById('lm-member-list');
  listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink3);">読み込み中...</div>';
  try {
    const res = await apiGet('getLimitedMembers');
    if (!res.ok) throw new Error(res.error);
    _limitedMembersCache = res.members || [];
    document.getElementById('lm-label-input').value = res.label || '';
    if (_limitedMembersCache.length === 0) {
      listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--ink3);font-size:13px;">対象メンバーが登録されていません</div>';
      return;
    }
    listEl.innerHTML = _limitedMembersCache.map((m, index) =>
      `<div class="lm-row">
        <span class="lm-uid">${esc(m.uid)}</span>
        <span class="lm-name">${esc(m.name)}</span>
        <span class="lm-date">${esc(m.addedAt)}</span>
        <button type="button" class="lm-del" data-remove-limited="${index}">削除</button>
      </div>`
    ).join('');
    listEl.querySelectorAll('[data-remove-limited]').forEach(button => {
      button.addEventListener('click', () => {
        const member = _limitedMembersCache[Number(button.dataset.removeLimited)];
        if (member) removeLimitedMember(member.uid);
      });
    });
  } catch (e) {
    listEl.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px;">エラー: ${esc(e.message)}</div>`;
  }
}

async function saveLimitedLabel() {
  const label = document.getElementById('lm-label-input').value.trim();
  try {
    const res = await apiGet('updateLimitedMemberLabel', { label });
    if (!res.ok) throw new Error(res.error);
    toast('期間ラベルを保存しました', 's');
  } catch (e) {
    toast('保存失敗: ' + e.message, 'e');
  }
}

async function removeLimitedMember(uid) {
  if (!await uiConfirm({
    type: 'danger', title: '対象メンバーから削除',
    message: `UID: ${uid} を対象メンバーから削除しますか？`,
    confirmText: '削除する',
  })) return;
  try {
    const res = await apiGet('removeLimitedMember', { uid });
    if (!res.ok) throw new Error(res.error);
    toast('削除しました', 's');
    await refreshLimitedMemberList();
  } catch (e) {
    toast('削除失敗: ' + e.message, 'e');
  }
}

async function clearAllLimitedMembers() {
  if (!await uiConfirm({
    type: 'danger', title: '全メンバーを削除',
    message: '対象メンバーを全員削除します。よろしいですか？\n（期間終了時に使用してください）',
    confirmText: '全員削除する',
  })) return;
  try {
    const res = await apiGet('clearLimitedMembers');
    if (!res.ok) throw new Error(res.error);
    toast('全メンバーを削除しました', 's');
    await refreshLimitedMemberList();
  } catch (e) {
    toast('削除失敗: ' + e.message, 'e');
  }
}

// ============================================================
// 限定PWスロット管理（追加・編集・削除）
// ============================================================
let _editingSlotId = null;

let _addSlotSelectedMembers = new Map(); // uid -> {uid, name}

function openAddLimitedSlotModal() {
  document.getElementById('add-slot-name').value = '';
  document.getElementById('add-slot-member-search').value = '';
  _addSlotSelectedMembers = new Map();
  document.getElementById('add-slot-selected-count').textContent = '';
  openM('m-add-limited-slot');
  _loadAddSlotMembers();
}

async function _loadAddSlotMembers() {
  const pickerEl = document.getElementById('add-slot-picker-list');
  pickerEl.innerHTML = '<div style="padding:10px;text-align:center;color:var(--ink3);font-size:12px;">読み込み中...</div>';
  try {
    if (_allMembersForPicker.length === 0) {
      const res = await apiGet('getMemberList');
      _allMembersForPicker = (res.ok && res.members) ? res.members : [];
    }
    renderAddSlotPicker(_allMembersForPicker);
  } catch (e) {
    pickerEl.innerHTML = `<div style="padding:10px;color:var(--red);font-size:12px;">エラー: ${esc(e.message)}</div>`;
  }
}

function filterAddSlotPicker() {
  const q = document.getElementById('add-slot-member-search').value.trim();
  const filtered = q ? _allMembersForPicker.filter(m => m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q)) : _allMembersForPicker;
  renderAddSlotPicker(filtered);
}

function renderAddSlotPicker(members) {
  const html = members.map((m, index) => {
    const selected = _addSlotSelectedMembers.has(m.uid);
    return `<div class="lm-row">
      <span class="lm-uid">${esc(m.uid)}</span>
      <span class="lm-name">${esc(m.name)}</span>
      ${selected
        ? `<button type="button" class="lm-del" data-toggle-slot-member="${index}">解除</button>`
        : `<button type="button" class="btn btn-p" style="padding:2px 8px;font-size:11px;" data-toggle-slot-member="${index}">追加</button>`
      }
    </div>`;
  }).join('') || '<div style="padding:10px;color:var(--ink3);font-size:13px;">該当なし</div>';
  const list = document.getElementById('add-slot-picker-list');
  list.innerHTML = html;
  list.querySelectorAll('[data-toggle-slot-member]').forEach(button => {
    button.addEventListener('click', () => {
      const member = members[Number(button.dataset.toggleSlotMember)];
      if (member) toggleAddSlotMember(member.uid, member.name);
    });
  });
  const count = _addSlotSelectedMembers.size;
  document.getElementById('add-slot-selected-count').textContent = count > 0 ? `選択中: ${count}名` : '';
}

function toggleAddSlotMember(uid, name) {
  if (_addSlotSelectedMembers.has(uid)) {
    _addSlotSelectedMembers.delete(uid);
  } else {
    _addSlotSelectedMembers.set(uid, { uid, name });
  }
  const q = document.getElementById('add-slot-member-search').value.trim();
  const filtered = q ? _allMembersForPicker.filter(m => m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q)) : _allMembersForPicker;
  renderAddSlotPicker(filtered);
}

async function confirmAddLimitedSlot() {
  const name = document.getElementById('add-slot-name').value.trim();
  if (!name) { toast('タブ名を入力してください', 'e'); return; }

  const selectedMembers = [..._addSlotSelectedMembers.values()];
  const tasks = [{ id: 'slot', label: `🔐 限定PW「${name}」を作成` }];
  if (selectedMembers.length > 0) tasks.push({ id: 'members', label: `👥 メンバー設定（${selectedMembers.length}名）` });

  closeM('m-add-limited-slot');
  showProc('限定PW を追加しています', '完了までそのままお待ちください');
  showProcSteps(tasks);

  async function runStep(id, fn) {
    setProcStep(id, 'running');
    try { const r = await fn(); setProcStep(id, 'done'); return r; }
    catch (e) { setProcStep(id, 'err', 'エラー: ' + e.message); throw e; }
  }

  try {
    const res = await runStep('slot', async () => {
      const r = await apiGet('addLimitedSlot', { name });
      if (!r.ok) throw new Error(r.error);
      return r;
    });

    limitedSlots.push({ id: res.id, name: res.name });
    renderPwTypeTabs();

    if (selectedMembers.length > 0) {
      setProcStep('members', 'running');
      let failed = 0;
      for (const m of selectedMembers) {
        try { await apiGet('addLimitedMember', { uid: m.uid, name: m.name, type: res.id }); }
        catch (_) { failed++; }
      }
      if (failed > 0) {
        setProcStep('members', 'err', `${failed}名失敗`);
        await new Promise(r => setTimeout(r, 600));
        hideProc();
        toast(`「${res.name}」を追加しましたが、${failed}名の設定に失敗しました`, 'e');
      } else {
        setProcStep('members', 'done');
        await new Promise(r => setTimeout(r, 600));
        hideProc();
        toast(`「${res.name}」を追加し、${selectedMembers.length}名のメンバーを設定しました`, 's');
      }
    } else {
      await new Promise(r => setTimeout(r, 400));
      hideProc();
      toast(`「${res.name}」を追加しました`, 's');
    }
  } catch (e) {
    hideProc();
    toast('追加失敗: ' + e.message, 'e');
  }
}

function openEditLimitedSlotModal(id) {
  _editingSlotId = id;
  const slot = limitedSlots.find(s => s.id === id);
  if (!slot) return;
  document.getElementById('edit-slot-name').value = slot.name;
  setVisible(document.getElementById('edit-slot-delete-btn'), true);
  openM('m-edit-limited-slot');
}

async function confirmUpdateLimitedSlot() {
  const name = document.getElementById('edit-slot-name').value.trim();
  if (!name) { toast('タブ名を入力してください', 'e'); return; }
  if (!_editingSlotId) return;
  try {
    const res = await apiGet('updateLimitedSlot', { id: _editingSlotId, name });
    if (!res.ok) throw new Error(res.error);
    const slot = limitedSlots.find(s => s.id === _editingSlotId);
    if (slot) slot.name = name;
    renderPwTypeTabs();
    closeM('m-edit-limited-slot');
    toast('タブ名を変更しました', 's');
  } catch (e) {
    toast('保存失敗: ' + e.message, 'e');
  }
}

async function confirmDeleteLimitedSlot() {
  if (!_editingSlotId) return;
  const slot = limitedSlots.find(s => s.id === _editingSlotId);
  const slotName = slot ? slot.name : _editingSlotId;

  // データ状態を確認
  showProc('データを確認しています...', '少々お待ちください');
  let check;
  try {
    check = await apiGet('checkLimitedSlotForDelete', { id: _editingSlotId });
    if (!check.ok) throw new Error(check.error);
  } catch (e) {
    hideProc();
    toast('確認失敗: ' + e.message, 'e');
    return;
  }
  hideProc();

  // シート削除が必要か判定（メンバー1人以上 かつ 申込日等すべて設定済み かつ 実施日1件以上 → シート保持）
  const deleteSheets = !(check.memberCount >= 1 && check.hasEventDates && check.calSlotCount >= 1);

  const msg = deleteSheets
    ? `「${slotName}」を削除しますか？\n\nメンバーまたはカレンダーのデータが未入力のため、\n関連するシートもすべて削除されます。\n\nこの操作は取り消せません。`
    : `「${slotName}」を削除しますか？\n（スプレッドシートのシートとデータは保持されます）`;
  if (!await uiConfirm({
    type: 'danger', title: '限定PWの削除', message: msg, confirmText: '削除する',
  })) return;

  showProc('削除しています...', '少々お待ちください');
  try {
    const res = await apiGet('deleteLimitedSlot', { id: _editingSlotId, deleteSheets });
    if (!res.ok) throw new Error(res.error);
    limitedSlots = limitedSlots.filter(s => s.id !== _editingSlotId);
    if (currentPwType === _editingSlotId) {
      currentPwType = limitedSlots.length > 0 ? limitedSlots[0].id : 'normal';
    }
    await loadAdminData();
    hideProc();
    closeM('m-edit-limited-slot');
    toast('削除しました', 's');
  } catch (e) {
    hideProc();
    toast('削除失敗: ' + e.message, 'e');
  }
}

async function openAddLimitedMemberPicker() {
  openM('m-limited-add');
  document.getElementById('lm-search').value = '';
  const pickerEl = document.getElementById('lm-picker-list');
  pickerEl.innerHTML = '<div style="padding:12px;text-align:center;color:var(--ink3);">読み込み中...</div>';
  try {
    if (_allMembersForPicker.length === 0) {
      const res = await apiGet('getMemberList');
      _allMembersForPicker = (res.ok && res.members) ? res.members : [];
    }
    renderLimitedPicker(_allMembersForPicker);
  } catch (e) {
    pickerEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px;">エラー: ${esc(e.message)}</div>`;
  }
}

function filterLimitedPicker() {
  const q = document.getElementById('lm-search').value.trim();
  const filtered = q ? _allMembersForPicker.filter(m => m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q)) : _allMembersForPicker;
  renderLimitedPicker(filtered);
}

function renderLimitedPicker(members) {
  const existingUids = new Set((_limitedMembersCache||[]).map(m => m.uid));
  const html = members.map((m, index) => {
    const already = existingUids.has(m.uid);
    return `<div class="lm-row">
      <span class="lm-uid">${esc(m.uid)}</span>
      <span class="lm-name">${esc(m.name)}</span>
      ${already
        ? '<span style="font-size:11px;color:var(--ink3);">登録済</span>'
        : `<button type="button" class="btn btn-p" style="padding:2px 8px;font-size:11px;" data-add-limited-member="${index}">追加</button>`
      }
    </div>`;
  }).join('') || '<div style="padding:12px;color:var(--ink3);font-size:13px;">該当なし</div>';
  const list = document.getElementById('lm-picker-list');
  list.innerHTML = html;
  list.querySelectorAll('[data-add-limited-member]').forEach(button => {
    button.addEventListener('click', () => {
      const member = members[Number(button.dataset.addLimitedMember)];
      if (member) addLimitedMember(member.uid, member.name);
    });
  });
}

async function addLimitedMember(uid, name) {
  try {
    const res = await apiGet('addLimitedMember', { uid, name });
    if (!res.ok) throw new Error(res.error);
    toast(`${name} を追加しました`, 's');
    _limitedMembersCache = [...(_limitedMembersCache||[]), { uid, name, addedAt: '' }];
    renderLimitedPicker(_allMembersForPicker.filter(m => {
      const q = document.getElementById('lm-search').value.trim();
      return !q || m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q);
    }));
    refreshLimitedMemberList();
  } catch (e) {
    toast('追加失敗: ' + e.message, 'e');
  }
}

// ============================================================
// 実施日クリック詳細
// ============================================================
function showSlotDetail(y,m,d) {
  const daySlots = slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  const dt = new Date(y,m-1,d);
  const dow = DOW7[dt.getDay()===0?6:dt.getDay()-1];
  const wn = getWeekNum(y,m,d);
  document.getElementById('sdc-title').textContent = m+'/'+d+'（'+dow+'）第'+wn+'週';
  document.getElementById('sdc-body').innerHTML = daySlots.map(s=>
    `<div class="sdc-row"><span class="sdc-time">${s.time}</span><span class="sdc-intv">${s.interval}分刻み</span></div>`
  ).join('');
  document.getElementById('slot-detail-card').classList.add('show');
}
function closeSlotDetail(){
  document.getElementById('slot-detail-card').classList.remove('show');
}

// ============================================================
// 日付クリック → 設定種別選択モーダル
// ============================================================
let daySelectTarget = null;

function openDaySelectModal(y,m,d) {
  if(d < 1) return;
  daySelectTarget = {y,m,d};
  const dt = new Date(y,m-1,d);
  const dow = DOW7[dt.getDay()===0?6:dt.getDay()-1];
  document.getElementById('m-day-select-title').textContent = m+'/'+d+'（'+dow+'） の設定';
  buildDaySelectContent(y,m,d);
  openM('m-day-select');
}

function buildDaySelectContent(y,m,d) {
  const isLimited = currentPwType !== 'normal';
  let isApply, isDeadline, isOpen, hasSlot;
  if (isLimited) {
    const ph = adminPhases[currentPhaseIndex] || {};
    isApply    = ph.apply    && ph.apply.y===y    && ph.apply.m===m    && ph.apply.d===d;
    isDeadline = ph.deadline && ph.deadline.y===y && ph.deadline.m===m && ph.deadline.d===d;
    isOpen     = ph.open     && ph.open.y===y     && ph.open.m===m     && ph.open.d===d;
    hasSlot    = (ph.slots||[]).some(s=>s.y===y&&s.m===m&&s.d===d);
  } else {
    isApply    = dates.apply    && dates.apply.y===y    && dates.apply.m===m    && dates.apply.d===d;
    isDeadline = dates.deadline && dates.deadline.y===y && dates.deadline.m===m && dates.deadline.d===d;
    isOpen     = dates.open     && dates.open.y===y     && dates.open.m===m     && dates.open.d===d;
    hasSlot    = slots.some(s=>s.y===y&&s.m===m&&s.d===d);
  }
  const hasAny = isApply||isDeadline||isOpen||hasSlot;
  setVisible(document.getElementById('m-day-reset-btn'), hasAny);

  let phaseTabs = '';
  if (isLimited) {
    const tabs = adminPhases.map((p, i) => {
      const active = i === currentPhaseIndex;
      return `<button onclick="switchPhaseInModal(${i})" style="padding:3px 9px;border:1px solid ${active?'var(--blue)':'var(--border)'};border-radius:5px;background:${active?'var(--blue)':'var(--surface)'};color:${active?'#fff':'var(--ink2)'};font-size:11px;font-weight:700;cursor:pointer;font-family:var(--sans);">フェーズ ${i+1}</button>`;
    }).join('');
    phaseTabs = `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border);align-items:center;">
      <span style="font-size:11px;color:var(--ink3);flex-shrink:0;">対象フェーズ：</span>${tabs}
      <button onclick="addNewPhaseFromModal()" style="padding:3px 8px;border:1px solid var(--blue);border-radius:5px;background:var(--blue-l);color:var(--blue);font-size:11px;font-weight:700;cursor:pointer;font-family:var(--sans);">＋</button>
    </div>`;
  }

  document.getElementById('m-day-select-btns').innerHTML = phaseTabs + `
    <button class="abtn" onclick="setDayAs('apply')" style="border-color:${isApply?'var(--green)':'var(--border)'};background:${isApply?'var(--green-l)':''};">
      <div class="ab-ic ic-g">&#128203;</div>
      <div class="ab-tx"><span class="ab-n" style="color:var(--green);">申込開始日</span><span class="ab-d">${isApply?'✓ 設定済み':'この日を申込開始日にする'}</span></div>
    </button>
    <button class="abtn" onclick="setDayAs('deadline')" style="border-color:${isDeadline?'var(--red)':'var(--border)'};background:${isDeadline?'var(--red-l)':''};">
      <div class="ab-ic" style="background:var(--red-l);">&#9203;</div>
      <div class="ab-tx"><span class="ab-n" style="color:var(--red);">締切日</span><span class="ab-d">${isDeadline?'✓ 設定済み':'この日を締切日にする'}</span></div>
    </button>
    <button class="abtn" onclick="setDayAs('open')" style="border-color:${isOpen?'var(--blue)':'var(--border)'};background:${isOpen?'var(--blue-l)':''};">
      <div class="ab-ic ic-p">&#128226;</div>
      <div class="ab-tx"><span class="ab-n" style="color:var(--blue);">シフト公開日</span><span class="ab-d">${isOpen?'✓ 設定済み':'この日をシフト公開日にする'}</span></div>
    </button>
    <button class="abtn" onclick="setDayAsSlot()" style="border-color:${hasSlot?'var(--purple)':'var(--border)'};background:${hasSlot?'var(--purple-l)':''};">
      <div class="ab-ic ic-t">&#127775;</div>
      <div class="ab-tx"><span class="ab-n" style="color:var(--purple);">実施日</span><span class="ab-d">${hasSlot?'✓ 設定済み（クリックで時間帯編集）':'この日を実施日にする'}</span></div>
    </button>`;
}

function switchPhaseInModal(i) {
  currentPhaseIndex = i;
  buildPhaseManageArea(true);
  buildCalScroll();
  if (daySelectTarget) buildDaySelectContent(daySelectTarget.y, daySelectTarget.m, daySelectTarget.d);
}

async function setDayAs(kind) {
  if(!daySelectTarget) return;
  const {y,m,d} = daySelectTarget;
  const isLimited = currentPwType !== 'normal';
  if (isLimited) {
    if (adminPhases.length === 0) {
      adminPhases.push({apply:null,deadline:null,open:null,applyRaw:null,deadlineRaw:null,openRaw:null,slots:[]});
      currentPhaseIndex = 0;
    }
    const ph = adminPhases[currentPhaseIndex];
    ph[kind] = {y,m,d};
    ph[kind+'Raw'] = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    closeM('m-day-select');
    buildPhaseManageArea(true);
    buildCalScroll();
    savePhases();
  } else {
    dates[kind] = {y,m,d};
    closeM('m-day-select');
    updDateViews();
    buildCalScroll();
    buildInfoArea();
    await saveNormalDates();
  }
}

function setDayAsSlot() {
  if(!daySelectTarget) return;
  const {y,m,d} = daySelectTarget;
  closeM('m-day-select');
  popupDay = {y,m,d};
  const isLimited = currentPwType !== 'normal';
  let exist;
  if (isLimited) {
    const ph = adminPhases[currentPhaseIndex] || {};
    exist = (ph.slots||[]).filter(s=>s.y===y&&s.m===m&&s.d===d);
  } else {
    exist = slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  }
  popupTimes = buildPopupTimes(exist);
  const dt=new Date(y,m-1,d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(y,m,d);
  document.getElementById('m-slot-edit-title').textContent=m+'/'+d+'（'+dow+'）第'+wn+'週 実施日設定';
  renderPopupModal(y,m,d);
  openM('m-slot-edit');
}

// popupTimes の1行から時間帯文字列を作る（スロットキーの一部になる）
function popupTimeStr(t){ return parseInt(t.sh)+':'+t.sm+'~'+parseInt(t.eh)+':'+t.em; }

// 実施日設定モーダルで使う行データ。既存スロットの前月対応も持ち込む。
// prev は null＝自動対応にまかせる / ''＝対応なしを明示 / 文字列＝前月の枠を指定
function buildPopupTimes(exist){
  if(exist.length===0) return [{sh:'07',sm:'00',eh:'08',em:'30',intv:15,prev:null}];
  return exist.map(s=>{
    const t=parseTimeStr(s.time,s.interval);
    const k=slotKeyOf(s);
    t.prev=Object.prototype.hasOwnProperty.call(slotMapping,k)?slotMapping[k]:null;
    return t;
  });
}

// 紐づけを出すのは通常PWで前月の枠があるときだけ。限定PWはフェーズ単位で
// 動くので前月の概念に乗らない
function mappingAvailable(){ return currentPwType==='normal' && prevSlotList().length>0; }

// 時間帯を変えると自動対応の相手も変わるので、選択欄を追従させるため描き直す
function onPopupTimeChanged(){
  if(popupDay && mappingAvailable()) renderPopupModal(popupDay.y,popupDay.m,popupDay.d);
}

function renderPopupModal(y,m,d){
  const area=document.getElementById('m-slot-edit-body');
  // 時・分・間隔は候補が決まりきっているので検索欄は出さない（search:false）
  const hourItems=HOURS_LIST.map(v=>({value:v,label:v}));
  const minItems =MINS_LIST.map(v=>({value:v,label:v}));
  const intvItems=INTV_LIST.map(v=>({value:String(v),label:v+'分'}));
  const showMap=mappingAvailable();
  const prevItems=()=>[{value:'',label:'（引き継がない）'}].concat(
    prevSlotList().map(ps=>({value:prevSlotKeyOf(ps),label:`${ps.week} ${ps.dateLabel} ${ps.time}`})));
  // 時刻欄は幅を揃える。押すと候補が出ることが分かるよう ▾ ぶんの余白も込みで 56px
  const tSt='width:56px;padding:5px 6px;font-family:var(--mono);';
  const rowsHtml=popupTimes.map((t,i)=>{
    // 自動対応（prev===null）のときは、その時間帯から決まる相手を選択済みにして見せる。
    // 「自動」という見えない状態を残すより、実際に何が保存されるかを出すほうが直せる
    const sel = (t.prev===null||t.prev===undefined) ? autoPrevKeyFor({y,m,d,time:popupTimeStr(t)}) : t.prev;
    const mapRow = !showMap ? '' : `
      <div class="sp-map-row">
        <span class="sp-map-lbl">前月から引き継ぐ枠</span>
        ${uiSelHtml('sp-map-'+i,{title:'前月から引き継ぐ枠',items:prevItems(),value:sel,
          cls:'sp-map-sel',onPick:v=>{popupTimes[i].prev=v;}})}
      </div>`;
    const timeSel=(f,items)=>uiSelHtml('sp-'+f+'-'+i,{title:'時刻',items,value:t[f],search:false,
      style:tSt,onPick:v=>{popupTimes[i][f]=v;onPopupTimeChanged();}});
    return `
    <div class="sp-time-block">
      <div class="sp-time-row">
        <div style="display:flex;gap:2px;">
          ${timeSel('sh',hourItems)}
          <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
          ${timeSel('sm',minItems)}
        </div>
        <span class="time-wave">〜</span>
        <div style="display:flex;gap:2px;">
          ${timeSel('eh',hourItems)}
          <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
          ${timeSel('em',minItems)}
        </div>
        ${uiSelHtml('sp-intv-'+i,{title:'区切りの間隔',items:intvItems,value:String(t.intv),search:false,
          cls:'intv-sel',onPick:v=>{popupTimes[i].intv=parseInt(v);}})}
        <button class="sp-del-btn" onclick="delSpTimeModal(${i})">&#10005;</button>
      </div>
      ${mapRow}
    </div>`;
  }).join('');
  const mapHint = !showMap ? '' :
    `<div class="sp-map-hint">奉仕者のフォームには前月の希望が初期値として入ります。時間帯が同じ枠を既定で選んでいるので、実施日をずらした月だけ直してください。</div>`;
  area.innerHTML=`<div class="sp-wrap">
    <div class="sp-body">${rowsHtml}</div>
    ${mapHint}
    <div style="padding:6px 12px;">
      <button class="sp-add-btn" onclick="addSpTimeModal()">&#65291; 時間帯を追加</button>
    </div>
    <div class="sp-ft">
      <button class="btn btn-g" onclick="closeSlotEditModal()" style="font-size:11px;padding:5px 12px;">キャンセル</button>
      <button class="btn" onclick="deleteSlotDay()" style="font-size:11px;padding:5px 12px;border-color:var(--red);background:var(--red-l);color:var(--red);">🗑 削除</button>
      <button class="btn btn-p" onclick="confirmSlotModal()" style="font-size:11px;padding:5px 12px;">確定</button>
    </div>
  </div>`;
}
function addSpTimeModal(){
  popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15,prev:null});
  renderPopupModal(popupDay.y,popupDay.m,popupDay.d);
}
function delSpTimeModal(i){
  popupTimes.splice(i,1);
  if(popupTimes.length===0)popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15,prev:null});
  renderPopupModal(popupDay.y,popupDay.m,popupDay.d);
}
function closeSlotEditModal(){closeM('m-slot-edit');popupDay=null;}
async function confirmSlotModal(){
  if(!popupDay)return;
  const{y,m,d}=popupDay;
  // global slots に反映（カレンダー表示共通）
  slots=slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
  popupTimes.forEach(t=>{
    const time=popupTimeStr(t);
    const slot={y,m,d,time,interval:parseInt(t.intv)||15};
    slots.push(slot);
    // モーダルで選んだ前月の枠を覚える。触っていない行（prev が null）は
    // 自動対応にまかせるので、ここでは何も書かない（保存時に埋まる）
    if(t.prev!==null&&t.prev!==undefined) slotMapping[slotKeyOf(slot)]=t.prev;
  });
  popupDay=null;
  closeM('m-slot-edit');
  if(currentPwType !== 'normal'){
    // 限定PW: 現在のフェーズに反映して即時保存
    if(adminPhases.length === 0){
      adminPhases.push({apply:null,deadline:null,open:null,applyRaw:null,deadlineRaw:null,openRaw:null,slots:[]});
      currentPhaseIndex = 0;
    }
    const ph=adminPhases[currentPhaseIndex];
    if(!ph.slots)ph.slots=[];
    ph.slots=ph.slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
    popupTimes.forEach(t=>{
      const time=parseInt(t.sh)+':'+t.sm+'~'+parseInt(t.eh)+':'+t.em;
      ph.slots.push({y,m,d,time,interval:parseInt(t.intv)||15});
    });
    syncSlotsFromPhases();
    buildCalScroll();
    buildPhaseManageArea(true);
    await savePhases();
  } else {
    // 通常PW: カレンダー・実施日一覧・情報エリアを更新
    buildCalScroll();
    buildSlotSetList();
    buildInfoArea();
    await saveNormalSlots();
  }
}

async function resetDaySettings() {
  if(!daySelectTarget) return;
  const {y,m,d} = daySelectTarget;
  const isLimited = currentPwType !== 'normal';
  closeM('m-day-select');
  if (isLimited) {
    const ph = adminPhases[currentPhaseIndex];
    if (ph) {
      ['apply','deadline','open'].forEach(k=>{
        if(ph[k]&&ph[k].y===y&&ph[k].m===m&&ph[k].d===d){ph[k]=null;ph[k+'Raw']=null;}
      });
      ph.slots = (ph.slots||[]).filter(s=>!(s.y===y&&s.m===m&&s.d===d));
    }
    syncSlotsFromPhases();
    buildPhaseManageArea(true);
    buildCalScroll();
    savePhases().then(()=>toast('設定をリセットしました','s')).catch(e=>toast('保存に失敗: '+e.message,'e'));
  } else {
    ['apply','deadline','open'].forEach(k=>{
      if(dates[k]&&dates[k].y===y&&dates[k].m===m&&dates[k].d===d) dates[k]=null;
    });
    slots = slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
    updDateViews();
    buildCalScroll();
    buildSlotSetList();
    buildInfoArea();
    // 日程と実施日の両方を消すので、保存も両方行う
    // （実施日だけローカルで消えて保存されず、リロードで復活する状態を避ける）
    showProc('設定をリセットしています...', '少々お待ちください');
    try {
      await postNormalDates();
      await postNormalSlots();
      hideProc();
      toast('設定をリセットしました','s');
      renderProgressStrip();
      afterCalEdit();
    } catch(e) {
      hideProc();
      toast('保存に失敗しました: '+e.message,'e');
    }
  }
}

// ============================================================
// カレンダー下の情報エリア
// ============================================================
function buildInfoArea() {
  const isLimited = currentPwType !== 'normal';
  // 日程一覧カード。中身は updDateViews が dv-* に描くので、ここは出す/隠すだけ。
  // 限定PWは日程をフェーズUIで表すので隠す
  // （以前は存在しない info-dates-rows を条件に入れていたため、この分岐ごと
  //   空振りして限定PWでもカードが出たままだった）
  const datesCard = document.getElementById('info-dates-card');
  setVisible(datesCard, !isLimited);
  // 実施日一覧カード（通常PW のみ）。中身は buildSlotSetList が描く
  const slotsCard = document.getElementById('info-slots-card');
  setVisible(slotsCard, !isLimited && slots.length > 0);
  // フェーズ管理カード（限定PW のみ）
  buildPhaseManageArea(isLimited);
  // 前月との紐づけを見直す入口（通常PWで前月の枠があるときだけ）
  renderMapReviewBtn();
}

// ============================================================
// フェーズ管理UI（限定PW）
// ============================================================
function syncSlotsFromPhases() {
  slots = [];
  adminPhases.forEach(ph => { (ph.slots||[]).forEach(s => slots.push(s)); });
}

function buildPhaseManageArea(isLimited) {
  const card = document.getElementById('phase-manage-card');
  if (!card) return;
  if (!isLimited) { setVisible(card, false); return; }
  setVisible(card, true);

  const phases = adminPhases || [];
  if (currentPhaseIndex >= phases.length) currentPhaseIndex = Math.max(0, phases.length - 1);

  const fmtVal = obj => {
    if (!obj) return '<span class="dgc-val unset">未設定</span>';
    const dt = new Date(obj.y, obj.m - 1, obj.d);
    const dow = DOW7[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
    return `<span>${obj.m}/${obj.d}（${dow}）</span>`;
  };

  const tabsHtml = phases.map((p, i) => {
    const active = i === currentPhaseIndex;
    return `<button onclick="switchPhase(${i})" style="padding:3px 9px;border:1px solid ${active?'var(--blue)':'var(--border)'};border-radius:5px;background:${active?'var(--blue)':'var(--surface)'};color:${active?'#fff':'var(--ink2)'};font-size:11px;font-weight:700;cursor:pointer;font-family:var(--sans);">フェーズ ${i+1}</button>`;
  }).join('');

  let contentHtml = '';
  if (phases.length === 0) {
    contentHtml = '<div style="padding:14px;text-align:center;color:var(--ink3);font-size:12px;">カレンダーの日付をクリックして申込開始日などを設定してください</div>';
  } else {
    const ph = phases[currentPhaseIndex];
    contentHtml += `<div class="date-grid-cards">
      <div class="dgc g"><span class="dgc-label">申込開始</span><span class="dgc-val">${fmtVal(ph.apply)}</span></div>
      <div class="dgc a"><span class="dgc-label">締切日</span><span class="dgc-val">${fmtVal(ph.deadline)}</span></div>
      <div class="dgc b"><span class="dgc-label">シフト公開</span><span class="dgc-val">${fmtVal(ph.open)}</span></div>
    </div>`;
    const phSlots = ph.slots || [];
    if (phSlots.length === 0) {
      contentHtml += '<div style="padding:8px 12px;font-size:11px;color:var(--ink3);border-top:1px solid var(--border);">実施日がありません。カレンダーの日付をクリックして追加できます。</div>';
    } else {
      const groups = {};
      phSlots.forEach(s => { const k=s.y+'/'+s.m+'/'+s.d; if(!groups[k])groups[k]={y:s.y,m:s.m,d:s.d,times:[]}; groups[k].times.push(s); });
      contentHtml += `<div style="border-top:1px solid var(--border);">${Object.values(groups).map(g => {
        const dt=new Date(g.y,g.m-1,g.d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1];
        const wn=getWeekNum(g.y,g.m,g.d);
        return `<div class="slc-group" style="cursor:pointer" onclick="openDaySelectModal(${g.y},${g.m},${g.d})">
          <div class="slc-date-row"><span class="slc-date">${g.m}/${g.d}（${dow}）</span><span class="slc-week">第${wn}週</span></div>
          <div class="slc-times">${g.times.map(t=>`<span class="slc-chip">${t.time}</span>`).join('')}</div>
        </div>`;
      }).join('')}</div>`;
    }
    if (phases.length > 1) {
      contentHtml += `<div style="padding:6px 12px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
        <button onclick="deleteCurPhase()" style="padding:3px 9px;border:1px solid var(--red-l);border-radius:5px;background:var(--red-l);color:var(--red);font-size:11px;font-weight:700;cursor:pointer;font-family:var(--sans);">🗑 このフェーズを削除</button>
      </div>`;
    }
  }

  card.innerHTML = `<div class="dsp-card">
    <div class="dsp-hd" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;row-gap:4px;">
      <span class="dsp-title" style="margin-right:auto;">フェーズ設定</span>
      ${tabsHtml}
      <button onclick="addNewPhase()" style="padding:3px 9px;border:1px solid var(--blue);border-radius:5px;background:var(--blue-l);color:var(--blue);font-size:11px;font-weight:700;cursor:pointer;font-family:var(--sans);">＋</button>
    </div>
    ${contentHtml}
  </div>`;
}

function switchPhase(i) {
  currentPhaseIndex = i;
  buildPhaseManageArea(true);
  buildCalScroll();
}

async function addNewPhase() {
  adminPhases.push({apply:null,deadline:null,open:null,applyRaw:null,deadlineRaw:null,openRaw:null,slots:[]});
  currentPhaseIndex = adminPhases.length - 1;
  buildPhaseManageArea(true);
  buildCalScroll();
  await savePhases();
}

async function addNewPhaseFromModal() {
  closeM('m-day-select');
  await addNewPhase();
}

async function deleteCurPhase() {
  if (!await uiConfirm({
    type: 'danger', title: 'フェーズの削除',
    message: `フェーズ ${currentPhaseIndex + 1} を削除しますか？`,
    confirmText: '削除する',
  })) return;
  adminPhases.splice(currentPhaseIndex, 1);
  if (currentPhaseIndex >= adminPhases.length) currentPhaseIndex = Math.max(0, adminPhases.length - 1);
  syncSlotsFromPhases();
  buildPhaseManageArea(true);
  buildCalScroll();
  await savePhases();
}

async function savePhases() {
  const ov = document.getElementById('tab-switch-ov');
  const ovTxt = document.getElementById('tab-sw-text');
  if (ov) { ov.classList.add('show'); if (ovTxt) ovTxt.textContent = 'フェーズを保存中...'; }
  try {
    const toYMD = obj => obj ? `${obj.y}/${String(obj.m).padStart(2,'0')}/${String(obj.d).padStart(2,'0')}` : '';
    const phasesForGas = adminPhases.map(p => ({
      apply:    toYMD(p.apply),
      deadline: toYMD(p.deadline),
      open:     toYMD(p.open),
      slots: (p.slots || []).map(s => ({
        y:        s.y,
        m:        s.m,
        d:        s.d,
        time:     s.time,
        interval: s.interval || 15
      }))
    }));
    const res = await apiPost({ action: 'updateLimitedCalendarSlots', type: currentPwType, phases: phasesForGas });
    if (!res.ok) throw new Error(res.error || '保存失敗');
    buildPhaseManageArea(true);
  } catch (e) {
    uiAlert({ type: 'danger', title: '保存に失敗しました', message: 'フェーズの保存に失敗しました。\n\n' + e.message });
  } finally {
    if (ov) ov.classList.remove('show');
  }
}

// 実施日（通常PW）の送信のみ。日程は送らない
// （hUpdateCalendarSlots 側も「渡されたものだけ更新」で日程を上書きしない前提）
// オーバーレイを自前で出したい呼び出し元（resetDaySettings）はこちらを使う
async function postNormalSlots() {
  const res = await apiPost({
    action: 'updateCalendarSlots', type: currentPwType, year: curY, month: curM,
    slots: slots.map(s => ({ y: s.y, m: s.m, d: s.d, time: s.time, interval: parseInt(s.interval) || 15 }))
  });
  if (!res.ok) throw new Error(res.error || '保存失敗');
  // 実施日と前月との紐づけは一体のもの（枠が変われば対応も変わる）なので同時に保存する。
  // 実施日だけ保存して紐づけが古いままだと、奉仕者のフォームに前月の希望が
  // 入らない・別の枠から入る、という分かりにくい形で表に出る
  if (currentPwType === 'normal') await postSlotMapping();
}

// 実施日（通常PW）の都度保存。確定・削除のたびに呼ばれる
async function saveNormalSlots() {
  showProc('実施日を保存しています...', '少々お待ちください');
  try {
    await postNormalSlots();
    hideProc();
    afterCalEdit();
  } catch (e) {
    hideProc();
    uiAlert({ type: 'danger', title: '保存に失敗しました', message: '実施日の保存に失敗しました。\n\n' + e.message });
  }
}

// 未公開の月の日程・実施日を変えると、サーバー側で承認が自動的に取り消される
// （承認者が見ていない予定表が自動公開されないようにするため）。
// 画面の承認表示が古いままだと「承認済みのはず」と誤読するので取り直す
function afterCalEdit() {
  loadCalApprovalStatus();
  loadPendingCounts();
}

// 日程（通常PW）の送信のみ。実施日の postNormalSlots() と対になる。
// null は「クリア」としてサーバーに反映される
async function postNormalDates() {
  // year/month は必須。省かれるとサーバーが nowJstYM()＝今月にフォールバックし、
  // 画面が編集している月（curY/curM。既定は来月）とは別の行に書いてしまう
  await apiGet('updateEventDates', {
    year: curY, month: curM,
    apply: dates.apply, deadline: dates.deadline, open: dates.open
  });
}

// ============================================================
// 前月との紐づけ（スロットマッピング）
// ============================================================
// 奉仕者のフォームには前月の希望が初期値として入る。そのとき「今月のこの枠は
// 前月のどの枠の続きか」を決めるのがこのマッピング（settings.slot_mapping_<type>）。
// 既定は「時間帯が同じものへ自動対応」で、サーバー側も未設定の枠は自動対応に
// フォールバックする（handlers_form.ts の buildLastMonthData）。
// 実施日をずらした月だけ手で直せばよい、という位置づけ。
//
// 実施日を決める場面と紐づけを決める場面は本来同じなので、実施日設定モーダルの
// 中で選べるようにしてある。あとから直せるように、実施日一覧にも現在の対応を
// 出し、まとめて見直すモーダルも用意した
let slotMapping = {};   // { 今月のスロットキー: 前月のスロットキー }（''＝対応なし）

// キーはサーバーの csToSlot と同形式にする
function slotKeyOf(s) {
  const dt = new Date(s.y, s.m - 1, s.d);
  const dl = s.m + '/' + s.d + '(' + DOW_SUN[dt.getDay()] + ')';
  return '第' + getWeekNum(s.y, s.m, s.d) + '週 ' + dl + ' ' + s.time;
}
function prevSlotKeyOf(ps) { return ps.week + ' ' + ps.dateLabel + ' ' + ps.time; }
function prevSlotList() { return (adminData && adminData.prevSlots) || []; }

// 既定の相手。サーバーの buildLastMonthData と同じ優先順で選ぶ
// （まず「第N週＋時間帯」が一致するもの、無ければ時間帯だけ一致するもの）。
// ここがずれると、画面に出ている対応と実際に適用される対応が食い違う
function autoPrevKeyFor(slot) {
  const wk = '第' + getWeekNum(slot.y, slot.m, slot.d) + '週';
  const list = prevSlotList();
  const m = list.find(ps => ps.week === wk && ps.time === slot.time)
         || list.find(ps => ps.time === slot.time);
  return m ? prevSlotKeyOf(m) : '';
}

// slots（今月の実施日）を正として作り直す。実施日を消したり時間を変えたりすると
// 古いキーが残るので、毎回ここで棚卸しする
function rebuildSlotMapping() {
  const next = {};
  slots.forEach(s => {
    const k = slotKeyOf(s);
    next[k] = Object.prototype.hasOwnProperty.call(slotMapping, k) ? slotMapping[k] : autoPrevKeyFor(s);
  });
  slotMapping = next;
}

// 紐づけの保存。サーバーは丸ごと置き換えるので、常に今月の全枠分を送る
async function postSlotMapping() {
  // 前月の枠が無い月は紐づける相手がいない。空の対応を送ると全枠に
  // 「引き継がない」を明示したことになり、サーバー側の自動対応まで
  // 潰してしまうので何もしない（データ未取得のときも同じ）
  if (prevSlotList().length === 0) return;
  rebuildSlotMapping();
  await apiGet('createFormSheet', { year: curY, month: curM, mapping: slotMapping });
}

// 日程（通常PW）の都度保存。日付を選んだ時点で保存する
async function saveNormalDates() {
  showProc('日程を保存しています...', '少々お待ちください');
  try {
    await postNormalDates();
    hideProc();
    renderProgressStrip();   // 日程が変われば段の進み具合と添え字も変わる
    afterCalEdit();
  } catch (e) {
    hideProc();
    uiAlert({ type: 'danger', title: '保存に失敗しました', message: '日程の保存に失敗しました。\n\n' + e.message });
  }
}

// ============================================================
// 日程設定
// ============================================================
function updDateViews() {
  const fmt = obj => {
    if(!obj) return '未設定';
    const dt=new Date(obj.y,obj.m-1,obj.d);
    return obj.m+'/'+obj.d+'（'+DOW7[dt.getDay()===0?6:dt.getDay()-1]+'）';
  };
  // 通常表示（日程一覧カード）
  const fmtCard = (obj) => obj ? `<span>${fmt(obj)}</span>` : '<span class="dgc-val unset">未設定</span>';
  document.getElementById('dv-apply').innerHTML    = fmtCard(dates.apply);
  document.getElementById('dv-deadline').innerHTML = fmtCard(dates.deadline);
  document.getElementById('dv-open').innerHTML     = fmtCard(dates.open);
}

// ============================================================
// 実施日設定
// ============================================================
function parseTimeStr(timeStr,interval){
  const p=timeStr.match(/(\d{1,2}):(\d{2})[~〜](\d{1,2}):(\d{2})/);
  if(!p) return {sh:'07',sm:'00',eh:'08',em:'30',intv:parseInt(interval)||15};
  return {sh:p[1].padStart(2,'0'),sm:p[2],eh:p[3].padStart(2,'0'),em:p[4],intv:parseInt(interval)||15};
}
function buildSlotSetList(){
  const el=document.getElementById('slot-set-list');
  if(slots.length===0){el.innerHTML='<div class="slot-empty">実施日がありません。カレンダーの日付をクリックして追加してください。</div>';return;}
  const groups={};
  slots.forEach(s=>{const k=s.y+'/'+s.m+'/'+s.d;if(!groups[k])groups[k]={y:s.y,m:s.m,d:s.d,times:[]};groups[k].times.push(s);});
  el.innerHTML=Object.values(groups).map(g=>{
    const dt=new Date(g.y,g.m-1,g.d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(g.y,g.m,g.d);
    const k=g.y+'/'+g.m+'/'+g.d;
    return `<div class="sdg">
      <div class="sdg-hd" style="display:flex;align-items:center;justify-content:space-between;">
        <span><span class="sdg-date">${g.m}/${g.d}（${dow}）</span><span class="sdg-wk">第${wn}週</span></span>
        <button onclick="editSlotFromList(${g.y},${g.m},${g.d})" style="padding:2px 7px;border:1px solid var(--blue);border-radius:4px;background:var(--blue-l);color:var(--blue);font-size:10px;font-weight:700;cursor:pointer;font-family:var(--sans);">✏ 編集</button>
      </div>
      <div class="sdg-times">${g.times.map((t,i)=>`<span class="stime">${t.time}</span><span class="sintv">${t.interval}分</span><button class="sdel" onclick="delSlot('${k}',${i})">✕</button>`).join('')}</div>
      ${slotMapLines(g.times)}
    </div>`;
  }).join('');
}

// 実施日一覧に前月との対応を添える。間違って紐づけたときは、
// ここに出ていれば気づけるし、そのまま「✏ 編集」で直せる
function slotMapLines(times){
  if(!mappingAvailable()) return '';
  return `<div class="sdg-maps">${times.map(t=>{
    const k=slotKeyOf(t);
    const prev=Object.prototype.hasOwnProperty.call(slotMapping,k)?slotMapping[k]:autoPrevKeyFor(t);
    const label=prev?esc(prev.replace(/^第\d+週\s*/,'')):'引き継がない';
    return `<div class="sdg-map"><span class="sdg-map-cur">${esc(t.time)}</span>`
      + `<span class="sdg-map-arr">←</span>`
      + `<span class="sdg-map-prev${prev?'':' none'}">${label}</span></div>`;
  }).join('')}</div>`;
}
async function delSlot(key,idx){
  const[y,m,d]=key.split('/').map(Number);
  const ds=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  slots=slots.filter(s=>s!==ds[idx]);
  buildSlotSetList(); buildCalScroll(); buildInfoArea();
  await saveNormalSlots();
}
function editSlotFromList(y,m,d){
  popupDay={y,m,d};
  const exist=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  popupTimes=buildPopupTimes(exist);
  const dt=new Date(y,m-1,d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(y,m,d);
  document.getElementById('m-slot-edit-title').textContent=m+'/'+d+'（'+dow+'）第'+wn+'週 実施日設定';
  renderPopupModal(y,m,d);
  openM('m-slot-edit');
}
async function deleteSlotDay(){
  if(!popupDay)return;
  const{y,m,d}=popupDay;
  if(currentPwType!=='normal'){
    if(adminPhases.length>0){
      const ph=adminPhases[currentPhaseIndex];
      if(ph.slots)ph.slots=ph.slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
      syncSlotsFromPhases();
      closeSlotEditModal();
      buildCalScroll();
      buildPhaseManageArea(true);
      await savePhases();
    } else {
      closeSlotEditModal();
    }
  } else {
    slots=slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
    closeSlotEditModal();
    buildSlotSetList(); buildCalScroll(); buildInfoArea();
    await saveNormalSlots();
  }
}
async function resetDates(){
  if(!await uiConfirm({
    type:'danger', title:'日程一覧のリセット',
    message:'日程一覧（申込開始・締切・シフト公開日）をリセットしますか？', confirmText:'リセットする',
  })) return;
  dates={apply:null,deadline:null,open:null};
  updDateViews();
  buildCalScroll();
  buildInfoArea();
  await saveNormalDates();
}
// ============================================================
// 前月との紐づけの見直し
// ============================================================
// 紐づけは実施日設定モーダルの中で決めるのが基本。ここは月全体を一覧で
// 見直して直すための入口（取り違えに後から気づいたとき用）
let mapReviewDraft = {};

function renderMapReviewBtn(){
  const b=document.getElementById('map-review-btn');
  setVisible(b, mappingAvailable() && slots.length > 0);
}

function openMapReviewModal(){
  if(!mappingAvailable()) return;
  rebuildSlotMapping();
  mapReviewDraft=Object.assign({},slotMapping);
  renderMapReviewModal();
  openM('m-map-review');
}

function renderMapReviewModal(){
  const body=document.getElementById('m-map-review-body');
  if(!body) return;
  const groups={};
  slots.forEach(s=>{const k=s.y+'/'+s.m+'/'+s.d;if(!groups[k])groups[k]={y:s.y,m:s.m,d:s.d,times:[]};groups[k].times.push(s);});
  const prevItems=[{value:'',label:'（引き継がない）'}].concat(
    prevSlotList().map(ps=>({value:prevSlotKeyOf(ps),label:ps.week+' '+ps.dateLabel+' '+ps.time})));
  const rows=Object.values(groups).map(g=>{
    const dt=new Date(g.y,g.m-1,g.d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1];
    return '<div class="map-date-hd">&#128197; '+g.m+'/'+g.d+'（'+dow+'） <span style="font-size:10px;opacity:.7;">第'+getWeekNum(g.y,g.m,g.d)+'週</span></div>'
      + g.times.map(t=>{
          const k=slotKeyOf(t);
          const sel=Object.prototype.hasOwnProperty.call(mapReviewDraft,k)?mapReviewDraft[k]:'';
          mapReviewDraft[k]=sel; // 触られなかった枠も「引き継がない」として確定させる
          return '<div class="map-row"><div class="map-cur">'+esc(t.time)+'</div><div class="map-arr">&#8592;</div>'
            + uiSelHtml('map-'+k,{title:'引き継ぐ前月の枠　'+t.time,items:prevItems,value:sel,
                cls:'map-sel',style:'min-width:0;font-size:11px;padding:4px 7px;',
                onPick:v=>{mapReviewDraft[k]=v;}})
            + '</div>';
        }).join('');
  }).join('<div style="height:6px;"></div>');
  body.innerHTML='<p style="font-size:12px;color:var(--ink2);margin-bottom:9px;">奉仕者のフォームに前月の希望を初期値として入れるときの対応です。左が今月の枠、右が引き継ぐ前月の枠です。</p>'+rows;
}

async function saveMapReview(){
  // 選んだ時点で mapReviewDraft に入っている（renderMapReviewModal の onPick）
  slotMapping=Object.assign({},mapReviewDraft);
  closeM('m-map-review');
  showProc('紐づけを保存しています...', '少々お待ちください');
  try{
    await postSlotMapping();
    hideProc();
    buildSlotSetList();
    toast('前月との紐づけを保存しました','s');
  }catch(e){
    hideProc();
    uiAlert({type:'danger',title:'保存に失敗しました',message:'紐づけの保存に失敗しました。\n\n'+e.message});
  }
}

// ============================================================
// 予定表公開ステータスバッジ
// ============================================================
let calPubStatus = null;
let calPubYM     = null;  // 実際に公開中のカレンダーの年月 {y,m}（公開できるのは常に1ヶ月だけ）

function applyCalPubStatus(r) {
  calPubStatus = r && r.ok !== false ? !!r.published : null;
  calPubYM = null;
  if (calPubStatus && r.publishedYM) {
    const [py, pm] = String(r.publishedYM).split('.').map(Number);
    if (py && pm) calPubYM = { y: py, m: pm };
  }
  updCalPubState();
}

async function loadCalPubStatus() {
  const requestType = currentPwType;
  try {
    const r = await apiGet('getCalPubStatus', { type: requestType });
    if (requestType !== currentPwType) return;
    applyCalPubStatus(r);
  } catch(e) {
    if (requestType !== currentPwType) return;
    calPubStatus = null; calPubYM = null;
    updCalPubState();
  }
}

// 表示中の「対象年月」と「実際に公開中の月」がズレていることが一目で分かるようにする。
// 公開できる月は常に1つだけで、別の月を公開すると前の月は自動的に非公開になる
function isCurMonthPublished() { return !!(calPubStatus && calPubYM && calPubYM.y === curY && calPubYM.m === curM); }

// ============================================================
// 予定表の承認状態
// ============================================================
// 予定表は承認されるまで apply_date が来ても自動公開されない。
// 承認待ちで止まっていることが管理画面から分からないと、当日まで
// 誰も気づかないので、進行状況ストリップに出す
let calApproval = null;   // getCalApprovalStatus の結果（対象年月のもの）

function applyCalApprovalStatus(r, expectedYear, expectedMonth) {
  if (expectedYear !== curY || expectedMonth !== curM) return;
  calApproval = (r && r.ok) ? Object.assign({}, r, {
    year: Number(r.year || expectedYear), month: Number(r.month || expectedMonth),
  }) : null;
  renderProgressStrip();
}

// 年月を明示する。省くとサーバーは「今の申込中の月」を返すため、
// 重なり期間に別の月の承認状態を読んでしまう（loadShiftStatus と同じ理由）
async function loadCalApprovalStatus() {
  const requestYear = curY, requestMonth = curM, requestType = currentPwType;
  try {
    const r = await apiGet('getCalApprovalStatus', { year: requestYear, month: requestMonth, type: requestType });
    if (requestType !== currentPwType) return;
    applyCalApprovalStatus(r, requestYear, requestMonth);
  } catch (e) {
    if (requestYear !== curY || requestMonth !== curM || requestType !== currentPwType) return;
    calApproval = null;
    renderProgressStrip();
  }
}

// 取得待ちで前の月のものが残っているときに読み違えない
function isCalApprovalForCurMonth() {
  return !!(calApproval && calApproval.year === curY && calApproval.month === curM);
}

// ============================================================
// 進行状況ストリップ
// ============================================================
// 月の作業は「日程設定 → 募集開始 → 受付 → シフト作成 → 公開」の一本道で、
// 今どこにいて次に何をするかは一意に決まる。それが従来は
//   受付状況     … ヘッダーのバッジ
//   予定表の公開 … カレンダー右上のバッジ
//   日程         … 下の方の日程一覧カード
//   シフトの状態 … このアプリには無い（シフト管理アプリを開くしかない）
// と散っていたので、1か所にまとめる。
let shiftStatus = null;   // getShiftPublishStatus の結果（表示中の対象年月のもの）

function applyShiftStatus(r, expectedYear, expectedMonth) {
  if (expectedYear !== curY || expectedMonth !== curM) return;
  shiftStatus = (r && r.ok) ? Object.assign({}, r, {
    year: Number(r.year || expectedYear), month: Number(r.month || expectedMonth),
  }) : null;
  renderProgressStrip();
}

// 対象年月を明示して取得する。前月のシフトが動いている最中に次月の申込を開始できるため、
// 年月を送らないとサーバーは常に「申込中の月」の状態を返してしまい、
// 重なり期間に前月の進行状況ストリップが読めなくなる
async function loadShiftStatus() {
  const requestYear = curY, requestMonth = curM, requestType = currentPwType;
  try {
    const r = await apiGet('getShiftPublishStatus', { year: requestYear, month: requestMonth, type: requestType });
    if (requestType !== currentPwType) return;
    applyShiftStatus(r, requestYear, requestMonth);
  } catch (e) {
    if (requestYear !== curY || requestMonth !== curM || requestType !== currentPwType) return;
    shiftStatus = null;
    renderProgressStrip();
  }
}

// shiftStatus が表示中の対象年月のものか（月を切り替えた直後の取得待ちで取り違えない）
function isShiftStatusForCurMonth() {
  return !!(shiftStatus && shiftStatus.year === curY && shiftStatus.month === curM);
}

function renderProgressStrip() {
  const wrap = document.getElementById('prog-strip');
  if (!wrap) return;
  // 限定PWは複数月が同時に走りうるので一本道にならない。ここでは扱わない。
  // ミニボタンも隠す（calStageInfo は currentPwType!=='normal' で null を返す）
  if (currentPwType !== 'normal') { setVisible(wrap, false); renderCalStageMini(); return; }
  setVisible(wrap, true);

  const toDate = o => (o && o.y && o.m && o.d) ? new Date(o.y, o.m - 1, o.d) : null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ad = toDate(dates.apply), dd = toDate(dates.deadline), od = toDate(dates.open);
  const hasDates = !!(ad && dd && od);
  const calOn = isCurMonthPublished();
  // シフトの状態は年月を指定して取ってくる。取得待ちで別の月のものが残っている
  // ときは、この月の状態として読んではいけない
  const ss = isShiftStatusForCurMonth() ? shiftStatus : null;
  const deadlinePassed = !!(dd && today > dd);
  const created  = !!(ss && ss.published);     // シフト作成完了
  const approved = !!(ss && ss.approvedAll);   // 確認者全員の確認完了
  const notified = !!(ss && ss.notified);      // 奉仕者へ公開・通知済み
  // 次の月の申込を先に開始すると、シフトがまだ動いている月は「申込中」ではなくなる。
  // その月の募集・受付は既に済んだものとして読む（さもないと募集開始まで巻き戻って見える）。
  // 「済んだ」根拠にシフトの作成完了フラグ（created）を使ってはいけない。
  // シフトの作成完了を取り消しただけで「予定表公開」まで巻き戻って見えてしまう。
  // 予定表は公開できる月が1つだけで、次の月を公開すると前の月の is_cal_published は
  // 落ちる（＝この月が公開されたという記録は残らない）ため、代わりに
  // 「申込中の月がこの月より後へ進んだ」ことを根拠にする
  const calMoved = !!(calPubYM && (calPubYM.y > curY || (calPubYM.y === curY && calPubYM.m > curM)));
  const calDone = calOn || calMoved || created;
  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  // 「予定表公開」「シフト作成」は、それぞれ内部に「作成完了→承認済み→公開済み」の
  // 3段階を持つ。以前はこれを1段に詰め込んで色だけで見分けさせていたが、
  // 色もマークも同じでは判別できない、という2026-08-05 のフィードバックを受けて
  // 独立した段に分けた（横スクロール対応済みのため段数が増えても収まる）
  const calReadyDone   = calDone || !!(ca && ca.ready);
  const calApproveDone = calDone || !!(ca && ca.approved);

  const st = {
    dates:        hasDates ? 'done' : 'now',
    calReady:     !hasDates ? 'todo' : (calReadyDone ? 'done' : 'now'),
    calApprove:   !calReadyDone ? 'todo' : (calApproveDone ? 'done' : 'waiting'),   // 承認待ち
    calPublish:   !calApproveDone ? 'todo' : (calDone ? 'done' : 'pending'),        // 承認済み・自動公開待ち
    apply:        !calDone ? 'todo' : (deadlinePassed ? 'done' : 'now'),
    shiftCreate:  !calDone ? 'todo' : (created ? 'done' : (deadlinePassed ? 'now' : 'todo')),
    shiftApprove: !created ? 'todo' : (approved ? 'done' : 'waiting'),             // 確認待ち
    shiftPublish: !approved ? 'todo' : (notified ? 'done' : 'pending'),            // 確認済み・自動公開待ち
  };
  // 丸の下に日付を小さく添える。段の名前だけだと「受付はいつまでか」が
  // 結局スクロールしないと分からないため
  const md = o => o ? (o.m + '/' + o.d) : '';
  const calApproveSub   = st.calApprove === 'waiting' ? '承認待ち' : '';
  const calPublishSub   = st.calPublish === 'pending' ? (dates.apply ? md(dates.apply) + '自動公開' : '公開待ち')
    : st.calPublish === 'done' ? md(dates.apply) : '';
  const shiftApproveSub = st.shiftApprove === 'waiting' ? '確認待ち' : '';
  const shiftPublishSub = st.shiftPublish === 'pending' ? (dates.open ? md(dates.open) + '自動公開' : '公開待ち')
    : st.shiftPublish === 'done' ? md(dates.open) : '';
  const steps = [
    ['dates',        '日程設定',     ''],
    ['calReady',     '設定完了',     ''],
    ['calApprove',   '承認',         calApproveSub],
    ['calPublish',   '予定表公開',   calPublishSub],
    ['apply',        '受付',         dd ? '〜' + md(dates.deadline) : ''],
    ['shiftCreate',  'シフト作成',   ''],
    ['shiftApprove', '確認',         shiftApproveSub],
    ['shiftPublish', 'シフト公開',   shiftPublishSub],
  ];
  // 段そのものを操作口にする。calStageInfo() が決める「今できる1操作」
  // （設定完了して依頼／承認する／設定中に戻す／今すぐ公開／非公開に戻す）を、
  // 状態遷移的に対応する段へ割り当てる
  const calInfo = calStageInfo();
  const calActionStep =
    st.calPublish === 'done'   ? 'calPublish'   // 公開中 → 非公開に戻す
    : st.calReady === 'now'    ? 'calReady'     // 未依頼 → 設定完了して依頼
    : st.calApprove === 'waiting' ? 'calApprove' // 承認待ち → 承認する/再依頼/設定中に戻す
    : null;                                      // pending（承認済み・自動公開待ち）は下で別処理
  const action = {
    shiftPublish: st.shiftPublish !== 'todo' ? 'toggleShiftPub()' : '',
  };
  if (st.calPublish === 'pending') {
    action.calPublish = 'openCalApprovalDetail()';
  } else if (calActionStep && calInfo) {
    action[calActionStep] = 'calStageAction()';
  }
  document.getElementById('prog-steps').innerHTML = steps.map(([k, label, sub], i) => {
    // 連結線は「手前の段が済んでいれば緑」。線をたどれば進み具合が読める
    const line = i ? `<div class="pline${st[steps[i - 1][0]] === 'done' ? ' done' : ''}"></div>` : '';
    // pending（承認済み・自動公開待ち）は done（実際に公開済み）と紛らわしいので、
    // 色だけでなくマークの形でも区別する
    const mark = st[k] === 'done' ? '✓' : st[k] === 'pending' ? '⏳' : (i + 1);
    const act = action[k] || '';
    const tip = !act ? ''
      : k === 'calPublish'   ? (st.calPublish === 'pending' ? 'クリックで承認状況を確認' : (calInfo ? calInfo.title : ''))
      : (k === 'calReady' || k === 'calApprove') ? (calInfo ? calInfo.title : '')
      : k === 'shiftPublish' ? (st.shiftPublish === 'done' ? 'シフトを非公開にする' : 'シフトの作成完了を取り消す')
      : '';
    return line + `<div class="pstep ${st[k]}${act ? ' pstep-click' : ''}"`
      + (act ? ` onclick="${act}" title="${tip}"` : '')
      + `><div class="pdot">${mark}</div>`
      + `<div class="plabel">${label}</div>`
      + (sub ? `<div class="psub">${sub}</div>` : '') + '</div>';
  }).join('');

  // 8段は画面幅によっては横に収まりきらない（.prog に overflow-x:auto を設定済み）。
  // 収まらないときは「今どこにいるか」が画面外に隠れないよう、進行中の段
  // （無ければ最後の段＝終わっている）を中央付近までスクロールする。
  // 予定表公開が済んだあとはシフト作成側の状態のほうが気になるはずなので、
  // 常に「一番進んでいる、まだ終わっていない段」を優先する
  const curIdx = steps.findIndex(([k]) => st[k] === 'now' || st[k] === 'waiting' || st[k] === 'pending');
  const targetIdx = curIdx >= 0 ? curIdx : steps.length - 1;
  const targetEl = wrap.querySelectorAll('.pstep')[targetIdx];
  if (targetEl) {
    const wrapRect = wrap.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    wrap.scrollLeft += (targetRect.left + targetRect.width / 2) - (wrapRect.left + wrapRect.width / 2);
  }

  renderCalStageMini();
}

// ============================================================
// 予定表の状態に応じた「今できる操作」を1つに決める
// ============================================================
// 4状態（① 設定中 → ② 承認待ち → ③ 承認済み・公開待ち → ④ 公開中）に
// 押せるボタンは原則1つ。月の右のミニボタンと、進行状況ストリップの
// 「予定表公開」段は同じ状態を別の場所に出しているだけなので、ここを
// 唯一の判定にして両方から参照する（実行される操作を必ず一致させる）
function calStageInfo() {
  if (currentPwType !== 'normal') return null;

  // 公開中かどうかは日程の有無と無関係に判定できる。日程ガードより先に見ないと、
  // 公開中の月で日程を丸ごとリセット（resetDates の一括リセットなど）しただけで
  // 「非公開に戻す」の導線がミニボタン・ストリップの両方から消えてしまう
  // （cal-pub-mini は通常PWでは常に非表示なので、代わりの導線が無くなる）
  const calOn = isCurMonthPublished();
  if (calOn) {
    return {
      text: '📅 非公開に戻す',
      title: '予定表を非公開にします。奉仕者はカレンダー情報（日程・実施日）を確認できなくなります。',
      cls: 'cal-stage-danger', fn: toggleCalPub,
    };
  }

  const toDate = o => (o && o.y && o.m && o.d) ? new Date(o.y, o.m - 1, o.d) : null;
  if (!(toDate(dates.apply) && toDate(dates.deadline) && toDate(dates.open))) return null;

  // 次の月へ申込が先に進んでいる、またはこの月のシフトが作成完了しているなら、
  // この月の予定表の作業はもう終わっている（この時点で calOn は必ず false）
  const calMoved = !!(calPubYM && (calPubYM.y > curY || (calPubYM.y === curY && calPubYM.m > curM)));
  const ss = isShiftStatusForCurMonth() ? shiftStatus : null;
  const created = !!(ss && ss.published);
  if (calMoved || created) return null;

  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  if (!ca) return null;

  if (!ca.ready) {
    const who = ca.required > 0
      ? ca.approvers.map(a => a.name).join('・') + ' へ承認の通知が届きます。'
      : '承認者が未登録のため、設定完了と同時に承認済みになります。';
    return { text: '📮 設定完了して承認を依頼', title: who, cls: 'can-approve', fn: setCalReady };
  }
  if (!ca.approved) {
    if (ca.canApprove) {
      return {
        text: '🕒 承認する',
        title: '予定表は承認されるまで申込開始日を過ぎても公開されません。',
        cls: 'can-approve', fn: approveCal,
      };
    }
    const who = ca.required > 0 ? ca.approvers.map(a => a.name).join('・') + ' の承認待ちです。' : '';
    // approvedSnapshot は承認のたびに上書きされ、hUnsetCalReady でも消えない
    // （承認フィールドだけ消す作り）ので、「過去に一度でも承認されたか」の目印になる。
    // 承認済みの月を修正した直後はここに来る（自動では承認外れの通知が飛ばないため、
    // 区域係が明示的に再依頼するまで奉仕監督には伝わらない）
    if (ca.approvedSnapshot) {
      return {
        text: '📮 承認を再依頼',
        title: who + '修正内容を承認者に再確認してもらいます。',
        cls: 'can-approve', fn: setCalReady,
        // 主操作（再依頼）の脇に、取り消し系の導線も残す。1状態＝主要ボタン1つは
        // 保ったまま、押せる操作を完全に失わせない（控えめな補助リンクとして出す）
        secondary: { text: '↩ 設定中に戻す', title: '設定中に戻します（承認待ちの記録は消えます）', fn: unsetCalReady },
      };
    }
    return {
      text: '↩ 設定中に戻す',
      title: who + 'まだ直したいときは設定中に戻せます。',
      cls: 'cal-stage-secondary', fn: unsetCalReady,
    };
  }
  // 承認済み・公開待ち：申込開始日を待てば自動公開される。即時公開はオーナーのみ
  // （手動公開の権限は hPublishCalendar 側でもオーナーのみに制限されている。
  //   そもそもボタンを出さないことで、押しても拒否される事態を避ける）
  if (ca.isOwner) {
    return {
      text: '🚀 今すぐ公開',
      title: '申込開始日を待たずに今すぐ公開します。',
      cls: 'can-approve', fn: openCalPubModal,
    };
  }
  return null;
}

function calStageAction() {
  const info = calStageInfo();
  if (info && info.fn) info.fn();
}

// 「表示中の月がズレている」通知の開閉。普段は1行だけにして、
// 詳細はクリックしたときだけ見せる（常時表示され続けるのが不安の原因だった）
function toggleCalPubNote() {
  const note = document.getElementById('cal-pub-note');
  if (note) note.classList.toggle('open');
}

// 「予定表公開」段が承認済み・自動公開待ちのときにクリックすると開く詳細。
// 承認者名・承認日時はサーバーに既にある（cal_approved_by_name/cal_approved_at）のに
// 今まで画面のどこにも出していなかった（2026-08-05 のフィードバック）
function openCalApprovalDetail() {
  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  if (!ca) return;
  // 申込開始日が未設定のままここに来ると自動公開は起きない。「未設定になると
  // 自動公開される」という逆の意味に読める文にしてはいけない
  const publishNote = ca.applyDate
    ? (ca.applyDate + ' になると自動的に奉仕者へ公開されます。')
    : '申込開始日が未設定のため、自動公開されません。日程を設定してください。';
  const msg = '承認者: ' + (ca.approvedByName || '不明') + '\n'
    + '承認日時: ' + (ca.approvedAt || '不明') + '\n\n'
    + publishNote;
  const title = curY + '年' + curM + '月の予定表　承認状況';
  if (ca.isOwner) {
    uiConfirm({
      type: 'info', title, message: msg,
      confirmText: '今すぐ公開する', cancelText: '閉じる',
    }).then(ok => { if (ok) openCalPubModal(); });
  } else {
    uiAlert({ type: 'info', title, message: msg });
  }
}

// 主操作の脇に添える控えめな補助操作（今は「承認を再依頼」の隣の「設定中に戻す」だけ）
function calStageSecondaryAction() {
  const info = calStageInfo();
  if (info && info.secondary && info.secondary.fn) info.secondary.fn();
}

// 承認の操作口。カレンダーの月の右、限定PWの公開ボタンと同じ位置に置く。
// 進行状況ストリップの下に帯で出すと、日程・実施日を見ながら操作したいのに
// 画面上部まで戻ることになるため、月の横に寄せた
function renderCalStageMini() {
  const btn = document.getElementById('cal-approve-mini');
  const txt = document.getElementById('cal-approve-mini-text');
  const sub = document.getElementById('cal-stage-secondary');
  if (!btn || !txt) return;
  const info = calStageInfo();
  if (!info) {
    setVisible(btn, false);
    setVisible(sub, false);
    return;
  }
  setVisible(btn, true);
  btn.disabled = false;
  btn.className = 'cal-approve-mini ' + info.cls;
  txt.textContent = info.text;
  btn.title = info.title;
  if (sub) {
    if (info.secondary) {
      setVisible(sub, true);
      sub.textContent = info.secondary.text;
      sub.title = info.secondary.title || '';
    } else {
      setVisible(sub, false);
    }
  }
}

// ============================================================
// 承認スナップショットとの突き合わせ（承認後に変わった箇所を出す）
// ============================================================
// cal_approved_snapshot の日付は calDatesJson と同じ ISO 文字列、実施日は
// csToSlot と同じ形で返ってくる。画面側の dates/slots は {y,m,d} オブジェクト・
// 配列なので、比較できる形にそろえてから突き合わせる
function isoToYMD(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function ymdEq(a, b) { return (!a && !b) || (!!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d); }
function ymdLabel(o) { return o ? (o.m + '/' + o.d) : '未設定'; }

// 前回承認した内容（snapshot）と、いま画面にある内容（dates/slots）を突き合わせ、
// 変わった項目だけの一覧を返す
function buildCalDiff(snapshot) {
  const diffs = [];
  if (!snapshot) return diffs;
  const sd = snapshot.dates || {};
  [
    ['申込開始',   isoToYMD(sd.apply),    dates.apply],
    ['締切',       isoToYMD(sd.deadline), dates.deadline],
    ['シフト公開', isoToYMD(sd.open),     dates.open],
  ].forEach(([label, before, after]) => {
    if (!ymdEq(before, after)) diffs.push({ label, before: ymdLabel(before), after: ymdLabel(after) });
  });

  const slotKey   = s => s.y + '-' + s.m + '-' + s.d + ' ' + s.time;
  const slotLabel = s => s ? (s.m + '/' + s.d + ' ' + s.time + '（' + (s.interval || 15) + '分刻み）') : 'なし';
  const before = {}; (snapshot.slots || []).forEach(s => { before[slotKey(s)] = s; });
  const after  = {}; slots.forEach(s => { after[slotKey(s)] = s; });
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.forEach(k => {
    const b = before[k], a = after[k];
    if (!b) diffs.push({ label: '実施日の追加', before: 'なし', after: slotLabel(a) });
    else if (!a) diffs.push({ label: '実施日の削除', before: slotLabel(b), after: 'なし' });
    else if ((b.interval || 15) !== (a.interval || 15)) {
      diffs.push({ label: '実施日 ' + a.m + '/' + a.d + ' ' + a.time,
        before: (b.interval || 15) + '分刻み', after: (a.interval || 15) + '分刻み' });
    }
  });
  return diffs;
}

// 予定表の承認。承認しても即公開ではなく、申込開始日が来たら自動で公開される。
// 「承認＝公開」と誤解されると、まだ直したい月を承認できなくなるので明示する。
// 前回承認した内容から変わった箇所があれば、承認前に並べて見せる
function approveCal() {
  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  if (!ca) return;
  const diffs = (ca.changedSinceApproval && ca.approvedSnapshot) ? buildCalDiff(ca.approvedSnapshot) : [];
  const who = ca.required > 0
    ? ca.approvers.map(a => a.name).join('・') + ' の承認待ちです。'
    : '承認者が未登録のため、どの管理者でも承認できます。';
  const diffHtml = diffs.length ? `
    <div class="fg">
      <label class="fl">⚠ 前回承認した内容からの変更点（${diffs.length}件）</label>
      <div class="cal-diff-box">
        ${diffs.map(d => `
          <div class="cal-diff-row">
            <div class="cal-diff-label">${esc(d.label)}</div>
            <div class="cal-diff-vals"><span class="cal-diff-before">${esc(d.before)}</span><span class="cal-diff-arrow">→</span><span class="cal-diff-after">${esc(d.after)}</span></div>
          </div>`).join('')}
      </div>
    </div>` : '';
  openM('m-cal-approve');
  document.getElementById('m-ca-body').innerHTML = `
    <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:10px;">
      <span style="background:var(--blue-l);color:var(--blue);padding:3px 10px;border-radius:20px;">${curY}年${curM}月</span> の予定表を承認します
    </div>
    <div style="font-size:12px;line-height:1.7;color:var(--ink2);margin-bottom:10px;">
      承認しても今すぐ公開はされません。${ca.applyDate ? '申込開始日（' + esc(ca.applyDate) + '）' : '申込開始日'}を迎えると自動で公開されます。<br>
      承認後に日程や実施日を変更すると、承認は自動的に取り消され、再承認が必要になります。
    </div>
    ${diffHtml}
    <div style="font-size:11px;color:var(--ink3);">${esc(who)}</div>`;
  document.getElementById('m-ca-ft').innerHTML = `
    <button class="btn btn-g" onclick="closeM('m-cal-approve')">キャンセル</button>
    <button class="btn btn-s" onclick="execApproveCal()">承認する</button>`;
}

async function execApproveCal() {
  closeM('m-cal-approve');
  showProc('予定表を承認しています...', '少々お待ちください');
  try {
    const r = await apiGet('approveCalendar', { year: curY, month: curM });
    if (!r.ok) throw new Error(r.error || '承認に失敗しました');
    await loadCalApprovalStatus();   // 取得完了後に描き直す（内部で renderProgressStrip する）
    hideProc();
    toast('予定表を承認しました', 's');
    loadPendingCounts();             // サイドバーの未承認バッジを減らす
  } catch (e) {
    hideProc();
    toast('承認に失敗しました: ' + e.message, 'e');
    loadCalApprovalStatus();
  }
}

// 「設定完了して承認を依頼」／「承認を再依頼」。承認者（奉仕監督）が登録されていれば
// プッシュ通知が届く。未登録なら hSetCalReady 側で即承認済みになる。
// 承認済みの月を修正すると承認だけ自動的に外れる（is_cal_ready は true のまま残る）ので、
// 確認ダイアログの文言は呼び出し前の ca.ready（is_cal_ready の現在値）で
// 初回の依頼か再依頼かを見分ける（サーバー判定と同じ根拠）。
// 実行後のトーストは、サーバーが実際にどちらとして扱ったか（reRequested）を使う。
// 通知は自動では飛ばさない（日程を連続で直すたびに通知が飛ぶと迷惑になるため）。
// 区域係がこのボタンを押した時だけ、その時点の内容で承認者へ通知が飛ぶ
async function setCalReady() {
  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  if (!ca) return;
  const isReapproval = !!ca.ready;
  const who = ca.required > 0
    ? ca.approvers.map(a => a.name).join('・') + (isReapproval ? ' へ再確認の通知が届きます。' : ' へ承認の通知が届きます。')
    : '承認者が未登録のため、そのまま承認済みになります。';
  const title = isReapproval ? '承認を再依頼' : '設定完了して承認を依頼';
  const message = isReapproval
    ? `${curY}年${curM}月の修正内容を、承認者に再確認してもらいますか？\n\n${who}`
    : `${curY}年${curM}月の日程・実施日の設定を完了し、承認を依頼しますか？\n\n${who}\n\n完了後もそのまま修正できます。`;
  if (!await uiConfirm({
    type: 'info', title, message,
    confirmText: isReapproval ? '再依頼する' : '設定完了する',
  })) return;

  showProc(isReapproval ? '再依頼しています...' : '設定完了にしています...', '少々お待ちください');
  try {
    const r = await apiGet('setCalReady', { year: curY, month: curM });
    if (!r.ok) throw new Error(r.error || '失敗しました');
    await loadCalApprovalStatus();
    hideProc();
    // どちらとして扱われたかはサーバー（is_cal_ready の現在値）が判定した r.reRequested を使う。
    // 確認ダイアログ表示時点の isReapproval とは理屈上ズレないはずだが、実行結果の文言は
    // 常にサーバーの判定を正とする
    toast(r.approved
      ? (r.reRequested ? '承認者未登録のため、そのまま承認済みになりました' : '設定完了にしました（承認者未登録のため承認済みです）')
      : (r.reRequested ? '承認を再依頼しました' : '設定完了にし、承認を依頼しました'), 's');
    loadPendingCounts();
  } catch (e) {
    hideProc();
    toast('エラー: ' + e.message, 'e');
    loadCalApprovalStatus();
  }
}

// 「設定中に戻す」。承認待ち・承認済みのいずれからも①設定中へ戻す
async function unsetCalReady() {
  const ca = isCalApprovalForCurMonth() ? calApproval : null;
  if (!ca) return;
  if (!await uiConfirm({
    type: 'warn', title: '設定中に戻す',
    message: `${curY}年${curM}月の予定表を「設定中」に戻しますか？\n\n承認待ち・承認済みの記録は消え、改めて設定完了の操作が必要になります。`,
    confirmText: '設定中に戻す',
  })) return;

  showProc('設定中に戻しています...', '少々お待ちください');
  try {
    const r = await apiGet('unsetCalReady', { year: curY, month: curM });
    if (!r.ok) throw new Error(r.error || '失敗しました');
    await loadCalApprovalStatus();
    hideProc();
    toast('設定中に戻しました', 's');
    loadPendingCounts();
  } catch (e) {
    hideProc();
    toast('エラー: ' + e.message, 'e');
    loadCalApprovalStatus();
  }
}

// 「公開」段のクリック。シフトだけを引っ込める操作。
// カレンダー（予定表）は公開したまま、シフトの公開状態だけを戻すので、
// 奉仕者は日程・実施日は見られるがシフト表は見えない状態になる。
// unpublishShift は「作成完了」フラグを落とすため、確認記録も破棄される
// （＝次に作成完了にしたとき確認をやり直す）。そこまで明示して確認を取る
async function toggleShiftPub() {
  // 表示中の月の状態が取れているかだけを見る。次の月の申込が先に始まっていても、
  // シフトが動いている月の公開状態は戻せる必要がある
  if (!isShiftStatusForCurMonth()) return;
  const ss = shiftStatus;
  const notified = !!ss.notified;
  const needsApproval = (ss.required || 0) > 0;
  const msg = (notified
      ? 'シフトを非公開にしますか？\n\n奉仕者はシフト表を確認できなくなります。\n予定表（日程・実施日）は公開したままです。'
      : 'シフトの作成完了を取り消しますか？\n\n公開予定日を迎えても奉仕者へ公開されなくなります。\n予定表（日程・実施日）は公開したままです。')
    + (needsApproval ? '\n\n確認者の確認記録もリセットされ、次に作成完了にしたとき改めて確認が必要になります。' : '');
  if (!await uiConfirm({
    type: 'danger',
    title: notified ? 'シフトを非公開にする' : 'シフト作成完了の取り消し',
    message: msg,
    confirmText: notified ? '非公開にする' : '取り消す',
  })) return;

  showProc(notified ? 'シフトを非公開にしています...' : '作成完了を取り消しています...', '少々お待ちください');
  try {
    // 実行者はセッションからサーバーが確定する。表示中の年月だけを送る。
    const r = await apiGet('unpublishShift', { year: curY, month: curM });
    if (!r.ok) throw new Error(r.error || '失敗しました');
    await loadShiftStatus();   // 取得完了後に描き直す（内部で renderProgressStrip する）
    hideProc();
    toast(notified ? 'シフトを非公開にしました' : '作成完了を取り消しました', 's');
  } catch (e) {
    hideProc();
    toast('エラー: ' + e.message, 'e');
    loadShiftStatus();
  }
}

function updCalPubState() {
  // 公開状態が変わると進行状況ストリップも変わる
  renderProgressStrip();
  // 限定PWは複数月が同時進行しうるため一本道の進行状況ストリップに乗らない。
  // 公開/非公開の操作口をミニボタンとして残す（通常PWでは非表示、ストリップ側に一本化）
  const mini = document.getElementById('cal-pub-mini');
  const miniText = document.getElementById('cal-pub-mini-text');
  if (mini && miniText) {
    if (currentPwType === 'normal') {
      setVisible(mini, false);
    } else {
      setVisible(mini, true);
      mini.className = 'cal-pub-mini' + (isCurMonthPublished() ? ' published' : ' unpublished');
      miniText.textContent = isCurMonthPublished() ? '📅 公開中' : '🔒 未公開';
    }
  }
  const note = document.getElementById('cal-pub-note');
  if (!note) return;
  if (currentPwType === 'normal' && calPubStatus && calPubYM && !isCurMonthPublished()) {
    document.getElementById('cal-pub-note-txt').textContent =
      '表示中の' + curY + '年' + curM + '月は未公開（申込受付中は' + calPubYM.y + '年' + calPubYM.m + '月）';
    // 「自動的に非公開になります」だけだと、シフト表自体が消えるように読めて
    // 不安の原因になっていた（2026-08-05 のフィードバック）。申込受付フラグの話であり、
    // 実施中のシフト表（is_shift_published）には影響しないことを明示する
    document.getElementById('cal-pub-note-detail').innerHTML =
      '申込を受け付けられる月は1つだけです。' + curY + '年' + curM + '月を公開すると、'
      + calPubYM.y + '年' + calPubYM.m + '月の申込受付は終了します。<br>'
      + '<span class="cpn-ok">✓ ' + calPubYM.y + '年' + calPubYM.m + '月のシフト表は、引き続き奉仕者に見えます（影響しません）</span>';
    setVisible(note, true);
  } else {
    setVisible(note, false);
    note.classList.remove('open'); // 次に出すときは閉じた状態から始める
  }
}

async function toggleCalPub() {
  if (calPubStatus === null) return;
  // 表示中の月が公開中のときだけ「非公開」操作。別の月が公開中なら、
  // 表示中の月を公開する導線（＝公開月の切り替え）にする
  if (isCurMonthPublished()) {
    if (!await uiConfirm({
      type: 'danger', title: '予定表を非公開にする',
      message: curY + '年' + curM + '月の予定表を非公開にしますか？\n\n奉仕者はカレンダー情報（日程・実施日）を確認できなくなります。',
      confirmText: '非公開にする',
    })) return;
    showProc('予定表を非公開にしています...', '少々お待ちください');
    try {
      // 年月を明示して「表示中の月だけ」を非公開にする。省略すると API 側は
      // その pw_type の公開中カレンダーを全て落とすため、複数月が同時に走りうる
      // 限定PWで、確認文が示した月以外まで巻き込んでしまう
      await apiGet('unpublishCalendar', { year: curY, month: curM });
      calPubStatus = false; calPubYM = null;
      updCalPubState();
      hideProc();
      toast('予定表を非公開にしました', 's');
    } catch(e) {
      hideProc();
      toast('エラー: ' + e.message, 'e');
      loadCalPubStatus();
    }
  } else {
    openCalPubModal();
  }
}

// ============================================================
// 予定表公開
// ============================================================
async function openCalPubModal(){
  const fmt=obj=>{if(!obj)return '<span style="color:var(--ink3)">未設定</span>';const dt=new Date(obj.y,obj.m-1,obj.d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1];return obj.m+'/'+obj.d+'（'+dow+'）';};
  const slotGroups={};
  slots.forEach(s=>{const k=s.m+'/'+s.d;if(!slotGroups[k])slotGroups[k]=[];slotGroups[k].push(s.time);});
  const slotKeys=Object.keys(slotGroups).sort((a,b)=>{const[am,ad]=a.split('/').map(Number),[bm,bd]=b.split('/').map(Number);return am!==bm?am-bm:ad-bd;});
  const slotHtml=slotKeys.length>0
    ? slotKeys.map(k=>`<div class="sumrow"><span class="sumk" style="color:var(--purple);">実施日</span><span class="sumv" style="color:var(--purple);">${k}（${slotGroups[k].length}枠）</span></div>`).join('')
    : '<div class="sumrow"><span class="sumk" style="color:var(--ink3);">実施日</span><span class="sumv" style="color:var(--ink3);">未設定</span></div>';
  openM('m-cal-pub');
  document.getElementById('m-cp-body').innerHTML=`
    <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:12px;">
      <span style="background:var(--blue-l);color:var(--blue);padding:3px 10px;border-radius:20px;">${curY}年${curM}月</span> のカレンダーを公開します
    </div>
    ${calPubYM && !(calPubYM.y===curY && calPubYM.m===curM) ? `<div style="font-size:12px;line-height:1.6;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--r);padding:8px 10px;margin-bottom:12px;">
      現在は <b>${calPubYM.y}年${calPubYM.m}月</b> が公開中です。公開できる月は1つだけなので、実行すると ${calPubYM.y}年${calPubYM.m}月 は自動的に非公開になります。
    </div>` : ''}
    <div class="fg">
      <label class="fl">受付日程・実施日</label>
      <div class="sumbox">
        <div class="sumrow"><span class="sumk">申込開始</span><span class="sumv" style="color:var(--green);">${fmt(dates.apply)}</span></div>
        <div class="sumrow"><span class="sumk" style="color:var(--red);">締切</span><span class="sumv" style="color:var(--red);">${fmt(dates.deadline)}</span></div>
        <div class="sumrow"><span class="sumk">シフト公開</span><span class="sumv" style="color:var(--blue);">${fmt(dates.open)}</span></div>
        ${slotHtml}
      </div>
    </div>
    <div class="exec-st" id="cp-st"><div class="spin"></div>予定表公開中...</div>
    <div class="done-box is-hidden" id="cp-done"><div class="done-icon">&#10003;</div><div class="done-title">公開完了</div></div>`;
  document.getElementById('m-cp-ft').innerHTML=`
    <button class="btn btn-g" onclick="closeM('m-cal-pub')">キャンセル</button>
    <button class="btn btn-s" id="cp-exec-btn" onclick="execCalPub()">${curY}年${curM}月を公開する</button>`;
}
async function execCalPub(){
  document.getElementById('cp-exec-btn').disabled=true;
  document.getElementById('cp-st').classList.add('show');
  try{
    await apiGet('publishCalendar', { year: curY, month: curM });
    document.getElementById('cp-st').classList.remove('show');
    setVisible(document.getElementById('cp-done'), true);
    document.getElementById('m-cp-ft').innerHTML=`<button class="btn btn-p" onclick="closeM('m-cal-pub')">閉じる</button>`;
    toast(curY+'年'+curM+'月の予定表を公開しました','s');
    loadCalPubStatus();
  }catch(e){
    document.getElementById('cp-st').classList.remove('show');
    document.getElementById('cp-exec-btn').disabled=false;
    toast('公開に失敗しました: '+e.message,'e');
  }
}

// ============================================================
// モーダル制御
// ============================================================
function openM(id){ document.getElementById(id).classList.add('open'); }
function closeM(id){ document.getElementById(id).classList.remove('open'); }
// オーバーレイクリックで閉じる
document.addEventListener('click', e => {
  if(e.target.classList.contains('ov')) closeM(e.target.id);
});

// ============================================================
// ユーティリティ
// ============================================================
function getWeekNum(y,m,d){
  const date=new Date(y,m-1,d),dow=date.getDay(),monDow=dow===0?6:dow-1;
  const mon=new Date(date); mon.setDate(d-monDow);
  const ms=new Date(y,m-1,1),msDow=ms.getDay(),msMon=msDow===0?6:msDow-1;
  const fm=new Date(ms); fm.setDate(1-msMon);
  return Math.floor((mon-fm)/(7*86400000))+1;
}
function toast(msg,type){
  const a=document.getElementById('ta');
  const el=document.createElement('div');
  el.className='toast'+(type?' '+type:'');
  el.textContent=(type==='s'?'✓ ':type==='e'?'⚠ ':'')+msg;
  a.appendChild(el);
  setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},3000);
}
(function(){
  // インストール済み（ホーム画面から起動）なら「ホームに追加」ボタン自体を隠す。
  // 以前は早期 return だけで openPwaModal が未定義のままボタンが残り、押しても無反応だった。
  if(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true){
    setVisible(document.getElementById('btn-pwa-install'), false);
    return;
  }
  let deferredPrompt=null;
  window.addEventListener('beforeinstallprompt', e=>{
    e.preventDefault(); deferredPrompt=e;
    setVisible(document.getElementById('pwa-auto-section'), true);
  });
  window.addEventListener('appinstalled', ()=>{ deferredPrompt=null; toast('インストールしました!','s'); closeM('m-pwa'); });
  window.openPwaModal=function(){
    setVisible(document.getElementById('pwa-auto-section'), !!deferredPrompt);
    openM('m-pwa');
  };
  window.pwaTriggerInstall=async function(){
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    const{outcome}=await deferredPrompt.userChoice; deferredPrompt=null;
  };
})();

// apiPost は js/api.js（共有通信層）で定義

// ============================================================
// お知らせ管理
// ============================================================
let _noticeEditId = null;
let _noticeCache  = [];
async function openNoticeModal() {
  openM('m-notice');
  await refreshNoticeModal();
}
async function refreshNoticeModal() {
  document.getElementById('m-notice-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const d = await apiGet('getNoticesAdmin');
    const notices = d.notices || [];
    _noticeCache = notices;
    let html = `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">${_noticeEditId ? '編集中 (ID:'+_noticeEditId+')' : '新規追加'}</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <input type="text" id="notice-title-in" placeholder="タイトル" class="fsel" style="font-size:13px;">
          <textarea id="notice-body-in" placeholder="内容" class="fsel" style="min-height:80px;resize:vertical;font-size:13px;font-family:inherit;"></textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div>
              <div style="font-size:10px;color:var(--ink3);margin-bottom:2px;">表示開始日</div>
              <input type="date" id="notice-start-in" class="fsel" style="font-size:12px;width:100%;">
            </div>
            <div>
              <div style="font-size:10px;color:var(--ink3);margin-bottom:2px;">表示終了日</div>
              <input type="date" id="notice-end-in" class="fsel" style="font-size:12px;width:100%;">
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            ${uiCheckChip('notice-display-in', '表示する', true)}
            <button class="btn btn-p" onclick="saveNotice()" style="font-size:11px;padding:5px 12px;">保存</button>
            ${_noticeEditId ? '<button class="btn btn-g" onclick="_noticeEditId=null;refreshNoticeModal()" style="font-size:11px;padding:5px 10px;">キャンセル</button>' : ''}
          </div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">お知らせ一覧（${notices.length}件）</div>`;
    if (notices.length === 0) {
      html += '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px;">お知らせはありません</div>';
    } else {
      html += notices.map(n => {
        const isOn = n.display === 'ON';
        const period = (n.startDate || n.endDate) ? `${n.startDate||''}〜${n.endDate||''}　` : '';
        return `
        <div style="border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;background:var(--surface);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="flex:1;">
              <div style="font-size:13px;font-weight:700;">${esc(n.title)}</div>
              <div style="font-size:11px;color:var(--ink3);margin-top:2px;">${esc(n.body||'').slice(0,60)}${(n.body||'').length>60?'…':''}</div>
              <div style="font-size:10px;color:var(--ink3);margin-top:2px;">${period}表示: <span style="color:${isOn?'var(--green)':'var(--red)'};">${isOn?'ON':'OFF'}</span></div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0;">
              <button class="btn ${isOn?'btn-d':'btn-p'}" onclick="toggleNotice(${n.id})" style="font-size:10px;padding:3px 8px;">${isOn?'非表示':'表示'}</button>
              <button class="btn btn-g" onclick="editNotice(${n.id})" style="font-size:10px;padding:3px 8px;">編集</button>
              <button class="btn btn-d" onclick="deleteNotice(${n.id})" style="font-size:10px;padding:3px 8px;">削除</button>
            </div>
          </div>
        </div>`;
      }).join('');
    }
    document.getElementById('m-notice-body').innerHTML = html;
    if (_noticeEditId) {
      const n = _noticeCache.find(x => String(x.id) === String(_noticeEditId));
      if (n) {
        document.getElementById('notice-title-in').value = n.title || '';
        document.getElementById('notice-body-in').value  = n.body  || '';
        document.querySelector('[data-chip="notice-display-in"]')?.classList.toggle('on', n.display === 'ON');
        document.getElementById('notice-start-in').value = (n.startDate || '').replace(/\//g, '-');
        document.getElementById('notice-end-in').value   = (n.endDate   || '').replace(/\//g, '-');
        document.getElementById('m-notice-body').scrollTop = 0;
      }
    }
    document.getElementById('m-notice-ft').innerHTML = `<button class="btn btn-g" onclick="closeM('m-notice')">閉じる</button>`;
  } catch (e) {
    document.getElementById('m-notice-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}
async function saveNotice() {
  const title     = document.getElementById('notice-title-in').value.trim();
  const body      = document.getElementById('notice-body-in').value.trim();
  const display   = uiChipOn('notice-display-in');
  const startDate = (document.getElementById('notice-start-in').value || '').replace(/-/g, '/');
  const endDate   = (document.getElementById('notice-end-in').value   || '').replace(/-/g, '/');
  if (!title) { toast('タイトルを入力してください', 'e'); return; }
  showProc('お知らせを保存しています...', '少々お待ちください');
  try {
    const payload = { action: 'saveNotice', title, body, display, startDate, endDate };
    if (_noticeEditId) payload.id = _noticeEditId;
    const res = await apiPost(payload);
    if (!res.ok) throw new Error(res.error || '保存失敗');
    _noticeEditId = null;
    await refreshNoticeModal();
    hideProc();
    toast('お知らせを保存しました', 's');
  } catch (e) { hideProc(); toast('保存失敗: ' + e.message, 'e'); }
}
function editNotice(id) {
  _noticeEditId = id;
  refreshNoticeModal();
}
async function deleteNotice(id) {
  if (!await uiConfirm({
    type: 'danger', title: 'お知らせの削除',
    message: 'このお知らせを削除しますか？', confirmText: '削除する',
  })) return;
  showProc('削除しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'deleteNotice', id });
    if (!res.ok) throw new Error(res.error || '削除失敗');
    await refreshNoticeModal();
    hideProc();
    toast('削除しました', 's');
  } catch (e) { hideProc(); toast('削除失敗: ' + e.message, 'e'); }
}
async function toggleNotice(id) {
  showProc('更新しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'toggleNotice', id });
    if (!res.ok) throw new Error(res.error || '切替失敗');
    await refreshNoticeModal();
    hideProc();
    toast(`表示を${res.display === 'ON' ? 'ON' : 'OFF'}にしました`, 's');
  } catch (e) { hideProc(); toast('切替失敗: ' + e.message, 'e'); }
}

// ============================================================
// 代理送信設定
// ============================================================
let _proxyMembers = [];
let _proxyDeleteContexts = [];
async function openProxyModal() {
  openM('m-proxy');
  await refreshProxyModal();
}
async function refreshProxyModal() {
  document.getElementById('m-proxy-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const [proxyRes, memberRes] = await Promise.all([
      apiGet('getProxySettings'), apiGet('getMemberList'), loadAvatars()]);
    _proxyMembers = (memberRes.members || []).filter(m => m.uid);
    const settings = proxyRes.settings || [];
    _proxyDeleteContexts = [];
    // 41名規模の一覧なので <select> ではなく検索付きピッカー（js/picker.js）
    const memberItems = _proxyMembers.map(m => ({
      value: m.uid, label: m.name, sub: m.furigana || '',
      search: (m.name || '') + ' ' + (m.furigana || ''),
    }));
    let html = `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">代理設定を追加</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">代理元（送ってもらう人）</div>
            ${uiSelHtml('proxy-from', { title: '代理元（送ってもらう人）', placeholder: '選択してください', items: memberItems, style: 'width:100%;' })}</div>
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">代理先（代わりに送る人）</div>
            ${uiSelHtml('proxy-to', { title: '代理先（代わりに送る人）', placeholder: '選択してください', items: memberItems, style: 'width:100%;' })}</div>
        </div>
        <button class="btn btn-p" onclick="addProxy()" style="font-size:11px;padding:5px 12px;">追加</button>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">設定一覧（${settings.length}件）</div>`;
    if (settings.length === 0) {
      html += '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px;">設定がありません</div>';
    } else {
      html += settings.map(s => {
        const fromM = _proxyMembers.find(m => m.uid === s.fromUid);
        const toM   = _proxyMembers.find(m => m.uid === s.toUid);
        const contextIndex = _proxyDeleteContexts.push({ fromUid: String(s.fromUid || ''), toUid: String(s.toUid || '') }) - 1;
        return `<div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-bottom:6px;background:var(--surface);display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:12px;display:flex;align-items:center;gap:6px;min-width:0;">
            ${avatarHtml(s.fromUid, fromM ? fromM.name : '', 22)}${esc(fromM?fromM.name:s.fromUid)}
            <span style="color:var(--ink3);">→</span>
            ${avatarHtml(s.toUid, toM ? toM.name : '', 22)}${esc(toM?toM.name:s.toUid)}
          </span>
          <button class="btn btn-d" data-delete-proxy="${contextIndex}" style="font-size:10px;padding:3px 8px;flex-shrink:0;">解除</button>
        </div>`;
      }).join('');
    }
    const body = document.getElementById('m-proxy-body');
    body.innerHTML = html;
    body.querySelectorAll('[data-delete-proxy]').forEach(button => {
      button.addEventListener('click', () => {
        const context = _proxyDeleteContexts[Number(button.dataset.deleteProxy)];
        if (context) deleteProxy(context.fromUid, context.toUid);
      });
    });
  } catch (e) {
    document.getElementById('m-proxy-body').innerHTML = `<div style="color:var(--red);">エラー: ${esc(e.message)}</div>`;
  }
}
async function addProxy() {
  const fromUid = uiSelVal('proxy-from');
  const toUid   = uiSelVal('proxy-to');
  if (!fromUid || !toUid) { toast('両方選択してください', 'e'); return; }
  if (fromUid === toUid)  { toast('同じ人は設定できません', 'e'); return; }
  showProc('代理設定を追加しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'saveProxySetting', fromUid, toUid });
    if (!res.ok) throw new Error(res.error || '追加失敗');
    await refreshProxyModal();
    hideProc();
    toast('代理設定を追加しました', 's');
  } catch (e) { hideProc(); toast('追加失敗: ' + e.message, 'e'); }
}
async function deleteProxy(fromUid, toUid) {
  if (!await uiConfirm({
    type: 'danger', title: '代理設定の解除',
    message: 'この代理設定を解除しますか？', confirmText: '解除する',
  })) return;
  showProc('解除しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'deleteProxySetting', fromUid, toUid });
    if (!res.ok) throw new Error(res.error || '削除失敗');
    await refreshProxyModal();
    hideProc();
    toast('解除しました', 's');
  } catch (e) { hideProc(); toast('解除失敗: ' + e.message, 'e'); }
}

// ============================================================
// 夫婦設定
// ============================================================
let _coupleMembers = [];
let _coupleDeleteContexts = [];
function _coupleSurname(furigana) {
  const idx = furigana.search(/[ 　]/); // 半角・全角スペース両対応
  return idx > 0 ? furigana.substring(0, idx) : furigana;
}
async function openCoupleModal() {
  openM('m-couple');
  await refreshCoupleModal();
}
async function refreshCoupleModal() {
  document.getElementById('m-couple-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const [coupleRes, memberRes] = await Promise.all([
      apiGet('getCoupleList'), apiGet('getMemberList'), loadAvatars()]);
    _coupleMembers = (memberRes.members || []).filter(m => m.uid);
    const couples  = coupleRes.couples || [];
    _coupleDeleteContexts = [];

    // 登録済みのUIDを除外対象に
    const registeredUids = new Set();
    couples.forEach(c => { registeredUids.add(c.husbandUid); registeredUids.add(c.wifeUid); });

    // 名字が2件以上存在するもののみ候補にする（単独名字は夫婦候補外）
    const surnameCounts = {};
    _coupleMembers.forEach(m => {
      const s = _coupleSurname(m.furigana);
      surnameCounts[s] = (surnameCounts[s] || 0) + 1;
    });
    const eligible = _coupleMembers.filter(m =>
      surnameCounts[_coupleSurname(m.furigana)] >= 2 && !registeredUids.has(m.uid)
    );

    // 名字が同じ人を探す操作なので、ふりがなでも検索できるようにする
    const coupleItem = m => ({
      value: m.uid, label: m.name, sub: m.furigana || '',
      search: (m.name || '') + ' ' + (m.furigana || ''),
    });
    const husbandItems = eligible.filter(m => m.gender === 'M').map(coupleItem);
    const wifeItems    = eligible.filter(m => m.gender !== 'M').map(coupleItem);

    let html = `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">夫婦ペアを追加</div>
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px;line-height:1.6;">追加すると、並び替えで夫が妻の直前に表示され、お互いに代理送信が可能になります。</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">夫</div>
            ${uiSelHtml('couple-husband', { title: '夫', placeholder: '選択してください', items: husbandItems, style: 'width:100%;' })}</div>
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">妻</div>
            ${uiSelHtml('couple-wife', { title: '妻', placeholder: '選択してください', items: wifeItems, style: 'width:100%;' })}</div>
        </div>
        <button class="btn btn-p" onclick="addCouple()" style="font-size:11px;padding:5px 12px;">追加</button>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">登録済み（${couples.length}組）</div>`;
    if (couples.length === 0) {
      html += '<div style="color:var(--ink3);font-size:12px;text-align:center;padding:16px;">登録がありません</div>';
    } else {
      html += couples.map(c => {
        const hm = _coupleMembers.find(m => m.uid === c.husbandUid);
        const wm = _coupleMembers.find(m => m.uid === c.wifeUid);
        const contextIndex = _coupleDeleteContexts.push({ husbandUid: String(c.husbandUid || ''), wifeUid: String(c.wifeUid || '') }) - 1;
        return `<div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-bottom:6px;background:var(--surface);display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span style="font-size:12px;display:flex;align-items:center;gap:6px;min-width:0;">
            ${avatarHtml(c.husbandUid, hm ? hm.name : '', 22)}👨 ${esc(hm ? hm.name : c.husbandUid)}
            <span style="color:var(--ink3);">＆</span>
            ${avatarHtml(c.wifeUid, wm ? wm.name : '', 22)}👩 ${esc(wm ? wm.name : c.wifeUid)}
          </span>
          <button class="btn btn-d" data-delete-couple="${contextIndex}" style="font-size:10px;padding:3px 8px;flex-shrink:0;">解除</button>
        </div>`;
      }).join('');
    }
    const body = document.getElementById('m-couple-body');
    body.innerHTML = html;
    body.querySelectorAll('[data-delete-couple]').forEach(button => {
      button.addEventListener('click', () => {
        const context = _coupleDeleteContexts[Number(button.dataset.deleteCouple)];
        if (context) deleteCouple(context.husbandUid, context.wifeUid);
      });
    });
  } catch (e) {
    document.getElementById('m-couple-body').innerHTML = `<div style="color:var(--red);">エラー: ${esc(e.message)}</div>`;
  }
}
async function addCouple() {
  const husbandUid = uiSelVal('couple-husband');
  const wifeUid    = uiSelVal('couple-wife');
  if (!husbandUid || !wifeUid) { toast('夫と妻を両方選択してください', 'e'); return; }
  if (husbandUid === wifeUid)  { toast('同じ人は設定できません', 'e'); return; }
  showProc('夫婦ペアを追加しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'saveCouple', husbandUid, wifeUid });
    if (!res.ok) {
      if (res.error === 'duplicate') { hideProc(); toast('すでに登録されています', 'e'); return; }
      throw new Error(res.error || '追加失敗');
    }
    await refreshCoupleModal();
    hideProc();
    toast('夫婦ペアを追加しました', 's');
  } catch (e) { hideProc(); toast('追加失敗: ' + e.message, 'e'); }
}
async function deleteCouple(husbandUid, wifeUid) {
  if (!await uiConfirm({
    type: 'danger', title: '夫婦ペアの解除',
    message: 'この夫婦設定を解除しますか？', confirmText: '解除する',
  })) return;
  showProc('解除しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'deleteCouple', husbandUid, wifeUid });
    if (!res.ok) throw new Error(res.error || '削除失敗');
    await refreshCoupleModal();
    hideProc();
    toast('解除しました', 's');
  } catch (e) { hideProc(); toast('解除失敗: ' + e.message, 'e'); }
}

// ============================================================
// 要望確認
// ============================================================
async function openRequestModal() {
  openM('m-request');
  await refreshRequestModal();
}
async function refreshRequestModal() {
  document.getElementById('m-request-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const d = await apiGet('getRequests');
    const all     = d.requests || [];
    const pending = all.filter(r => r.status === '未対応');
    const done    = all.filter(r => r.status !== '未対応');
    // ここで正確な件数が分かるので、サイドバーの表示もそろえる
    // （対応済みにした直後に getPendingCounts を呼び直さずに済む）
    setInboxCount('requests', pending.length);
    let html = `<div style="font-size:11px;color:var(--ink3);margin-bottom:10px;">未対応: ${pending.length}件 / 対応済み: ${done.length}件</div>`;
    if (pending.length === 0 && done.length === 0) {
      html += '<div style="color:var(--ink3);font-size:13px;text-align:center;padding:20px;">要望はありません 🎉</div>';
    } else {
      if (pending.length === 0) {
        html += '<div style="color:var(--ink3);font-size:13px;text-align:center;padding:12px;">未対応の要望はありません 🎉</div>';
      } else {
        html += pending.map(r => `
        <div style="border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;background:var(--surface);">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;font-weight:700;">${esc(r.name)}</span>
            <span style="font-size:10px;color:var(--ink3);">${esc(r.sentAt||'')}</span>
          </div>
          <div style="font-size:13px;color:var(--ink);white-space:pre-wrap;margin-bottom:8px;">${esc(r.body||'')}</div>
          <button class="btn btn-g" onclick="resolveRequest(${r.rowIndex})" style="font-size:11px;padding:4px 10px;">対応済みにする</button>
        </div>`).join('');
      }
      if (done.length > 0) {
        html += `<details style="margin-top:10px;"><summary style="font-size:11px;font-weight:700;color:var(--ink3);cursor:pointer;padding:4px 0;">対応済み (${done.length}件)</summary>`;
        html += done.map(r => `
          <div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-top:6px;background:var(--surface2);">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:700;color:var(--ink2);">${esc(r.name)}</span>
              <span style="font-size:10px;color:var(--ink3);">${esc(r.sentAt||'')}</span>
            </div>
            <div style="font-size:13px;color:var(--ink2);white-space:pre-wrap;">${esc(r.body||'')}</div>
          </div>`).join('');
        html += '</details>';
      }
    }
    document.getElementById('m-request-body').innerHTML = html;
  } catch (e) {
    document.getElementById('m-request-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}
async function resolveRequest(rowIndex) {
  showProc('対応済みにしています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'resolveRequest', rowIndex });
    if (!res.ok) throw new Error(res.error || '更新失敗');
    await refreshRequestModal();
    hideProc();
    toast('対応済みにしました', 's');
  } catch (e) { hideProc(); toast('更新失敗: ' + e.message, 'e'); }
}

// ============================================================
// バグ報告確認
// ============================================================
async function openBugReportModal() {
  openM('m-bug-report');
  await refreshBugReportModal();
}
async function refreshBugReportModal() {
  document.getElementById('m-bug-report-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const d = await apiGet('getBugReports');
    const all     = d.reports || [];
    const pending = all.filter(r => r.status === '未対応');
    const done    = all.filter(r => r.status !== '未対応');
    setInboxCount('bugs', pending.length);   // サイドバーの件数もそろえる
    let html = `<div style="font-size:11px;color:var(--ink3);margin-bottom:10px;">未対応: ${pending.length}件 / 対応済み: ${done.length}件</div>`;
    if (pending.length === 0 && done.length === 0) {
      html += '<div style="color:var(--ink3);font-size:13px;text-align:center;padding:20px;">バグ報告はありません 🎉</div>';
    } else {
      if (pending.length > 0) {
        html += '<div style="font-size:11px;font-weight:700;color:var(--red);margin-bottom:6px;">未対応</div>';
        html += pending.map(r => `
          <div style="border:1.5px solid var(--red);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;background:#fff5f5;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;font-weight:700;">${esc(r.name)}</span>
              <span style="font-size:10px;color:var(--ink3);">${esc(r.sentAt||'')}</span>
            </div>
            <div style="font-size:13px;color:var(--ink);white-space:pre-wrap;margin-bottom:8px;">${esc(r.body||'')}</div>
            <button class="btn btn-g" onclick="resolveBugReport(${r.rowIndex})" style="font-size:11px;padding:4px 10px;">対応済みにする</button>
          </div>`).join('');
      }
      if (done.length > 0) {
        html += `<details style="margin-top:10px;"><summary style="font-size:11px;font-weight:700;color:var(--ink3);cursor:pointer;padding:4px 0;">対応済み (${done.length}件)</summary>`;
        html += done.map(r => `
          <div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-top:6px;background:var(--surface2);">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
              <span style="font-size:12px;font-weight:700;color:var(--ink2);">${esc(r.name)}</span>
              <span style="font-size:10px;color:var(--ink3);">${esc(r.sentAt||'')}</span>
            </div>
            <div style="font-size:13px;color:var(--ink2);white-space:pre-wrap;">${esc(r.body||'')}</div>
          </div>`).join('');
        html += '</details>';
      }
    }
    document.getElementById('m-bug-report-body').innerHTML = html;
  } catch (e) {
    document.getElementById('m-bug-report-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}
async function resolveBugReport(rowIndex) {
  showProc('対応済みにしています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'resolveBugReport', rowIndex });
    if (!res.ok) throw new Error(res.error || '更新失敗');
    await refreshBugReportModal();
    hideProc();
    toast('対応済みにしました', 's');
  } catch (e) { hideProc(); toast('更新失敗: ' + e.message, 'e'); }
}

// ============================================================
// ログイン救済申請
//
// 承認しただけでは相手はログインできない。承認で発行されるパスコードを
// 管理者が電話・対面で本人に伝えて初めてログインできる仕組みにしてあるため、
// 「承認ボタンを押すだけ」の形骸化が起きないようになっている
// ============================================================
let _recSharedKey = null; // 現在の合言葉（管理者にのみ表示）

async function openRecoveryModal() {
  openM('m-recovery');
  await loadRecoveryRequests();
}

function copyRecoveryKey() {
  if (!_recSharedKey) return;
  navigator.clipboard.writeText(_recSharedKey)
    .then(() => toast('合言葉をコピーしました', 's'))
    .catch(() => toast('コピーできませんでした', 'e'));
}

async function loadRecoveryRequests() {
  const body = document.getElementById('m-recovery-body');
  body.innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const d = await apiPost({ action: 'getRecoveryRequests' });
    if (!d.ok) throw new Error(d.reason === 'unauthorized' ? '権限がありません' : (d.reason || '取得失敗'));
    const all     = d.requests || [];
    const pending = all.filter(r => r.status === 'pending');
    const active  = all.filter(r => r.status === 'approved');
    const past    = all.filter(r => !['pending','approved'].includes(r.status));

    // 現在の合言葉。奉仕者から「合言葉は何だったか」と聞かれたときに答えられるようにする
    _recSharedKey = d.sharedKey || null;
    let html = _recSharedKey
      ? `<div class="rec-key-box">
           <span class="rec-key-label">現在の合言葉</span>
           <span class="rec-key-val">${esc(_recSharedKey)}</span>
           <button class="btn btn-g" onclick="copyRecoveryKey()">コピー</button>
           <button class="btn btn-g" onclick="openRecoveryKeyModal()">変更</button>
         </div>`
      : `<div class="rec-key-box rec-key-unknown">
           <span class="rec-key-label">現在の合言葉</span>
           <span class="rec-key-val-none">確認できません</span>
           <button class="btn btn-g" onclick="openRecoveryKeyModal()">設定し直す</button>
         </div>
         <div class="rec-note" style="margin-bottom:12px;">
           以前は合言葉を暗号化して保存していたため、元の文字列を取り出せません。
           一度「設定し直す」で登録すると、以後はここで確認できるようになります。
         </div>`;

    html += '<div class="rec-note">承認したら、パスコードを<b>本人と確実に連絡が取れる手段</b>'
             + '（電話・LINEなど、普段その人とやりとりしている連絡先）でお伝えください。<br>'
             + '⚠️ <b>申請フォームに入力されたメールアドレス宛には送らないでください。</b>'
             + 'そのアドレスは申請者が自由に入力できるため、本人確認になりません。<br>'
             + '合言葉を知っていることも本人確認にはなりません。心当たりのない申請は却下してください。</div>';

    if (pending.length === 0 && active.length === 0 && past.length === 0) {
      html += '<div style="color:var(--ink3);font-size:13px;text-align:center;padding:20px;">申請はありません</div>';
    }

    if (pending.length > 0) {
      html += '<div class="rec-sec-title" style="color:var(--red);">未対応の申請</div>';
      html += pending.map(r => `
        <div class="rec-card rec-card-pending">
          <div class="rec-card-hd">
            <span class="rec-card-name">${esc(r.name)}</span>
            <span class="rec-card-time">${esc(fmtRecTime(r.created_at))}</span>
          </div>
          <div class="rec-card-mail">${esc(r.email || '(メールアドレス未入力)')}</div>
          ${r.matched
            ? `<div class="rec-tag rec-tag-ok">✅ メンバーと一致（${esc(recScopeLabel(r.role_scope))}）</div>`
            : '<div class="rec-tag rec-tag-ng">⚠️ 一致するメンバーが見つかりません。心当たりがなければ却下してください</div>'}
          <div class="rec-card-actions">
            ${r.matched
              ? `<button class="btn btn-p" onclick="approveRecoveryRequest(${r.id})">承認してパスコードを発行</button>`
              : ''}
            <button class="btn btn-g" onclick="rejectRecoveryRequest(${r.id})">却下</button>
          </div>
        </div>`).join('');
    }

    if (active.length > 0) {
      html += '<div class="rec-sec-title">パスコード発行済み（本人の入力待ち）</div>';
      // パスコードはここに出し続ける。本人と連絡が取れず時間が空いても
      // 再申請してもらう必要がないようにするため
      html += active.map(r => `
        <div class="rec-card">
          <div class="rec-card-hd">
            <span class="rec-card-name">${esc(r.name)}</span>
            <span class="rec-card-time">${esc(fmtRecTime(r.approved_at))} 承認</span>
          </div>
          <div class="rec-card-mail">承認者: ${esc(r.approved_by_name || '-')}</div>
          ${r.otp_plain ? `<div class="rec-otp-inline">
            <span class="rec-otp-inline-label">パスコード</span>
            <span class="rec-otp-inline-code">${esc(r.otp_plain)}</span>
            <button class="btn btn-g" onclick="copyRecoveryOtp('${esc(r.otp_plain)}')">コピー</button>
          </div>
          <div class="rec-tag">⏳ 本人の入力待ち　有効期限: ${esc(fmtRecTime(r.otp_expires_at))}まで</div>`
          : '<div class="rec-tag">⏳ 本人がパスコードを入力するのを待っています</div>'}
          <div class="rec-card-actions">
            <button class="btn btn-g" onclick="rejectRecoveryRequest(${r.id})">取り消す</button>
          </div>
        </div>`).join('');
    }

    if (past.length > 0) {
      html += `<details style="margin-top:10px;"><summary class="rec-sec-title" style="cursor:pointer;">過去の申請 (${past.length}件)</summary>`;
      html += past.map(r => `
        <div class="rec-card rec-card-past">
          <div class="rec-card-hd">
            <span class="rec-card-name">${esc(r.name)}</span>
            <span class="rec-card-time">${esc(recStatusLabel(r.status))}</span>
          </div>
          <div class="rec-card-mail">${esc(r.email || '')}　${esc(fmtRecTime(r.created_at))}</div>
        </div>`).join('');
      html += '</details>';
    }
    body.innerHTML = html;
    updateRecoveryBadge(pending.length);
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:13px;padding:12px;">読み込みに失敗しました: ' + esc(e.message) + '</div>';
  }
}

function recScopeLabel(s) {
  return s === 'admin' ? '管理者・7日間有効' : s === 'accountant' ? '会計者・30日間有効' : '奉仕者・30日間有効';
}
function recStatusLabel(s) {
  return { consumed: 'ログイン完了', rejected: '却下', expired: '期限切れ' }[s] || s;
}
function fmtRecTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
         String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ============================================================
// サイドバーの「未対応」件数
// ============================================================
// 要望・バグ報告・ログイン救済は、開くまで中身があるか分からなかった。
// 件数を出して「そもそも開く必要があるか」を見ただけで判断できるようにする。
// 一覧APIを3本叩くと全行のデータが返ってくるので、件数だけを返す
// getPendingCounts にまとめてある（呼び出しは1回）。
//
// 配布報告だけ扱いが違う。あれは「対応するもの」ではなく溜まっていくのが
// 正常なので、未対応ではなく今月の件数を中立な色で出す
function setInboxCount(key, n, neutral) {
  const row = document.getElementById('ibx-' + key);
  const cell = document.getElementById('ibx-c-' + key);
  if (!row || !cell) return;
  const has = n > 0;
  cell.textContent = has ? n : '－';
  row.classList.toggle('has-items', has);
  if (neutral) cell.classList.add('neutral');
}

function renderInboxCounts(c) {
  setInboxCount('calApproval',  c.calApproval  || 0);
  setInboxCount('recovery',     c.recovery     || 0);
  setInboxCount('requests',     c.requests     || 0);
  setInboxCount('bugs',         c.bugs         || 0);
  setInboxCount('distribution', c.distribution || 0, true);
  // 見出しの合計。配布報告は「対応するもの」ではないので合計に入れない
  const total = (c.calApproval || 0) + (c.recovery || 0) + (c.requests || 0) + (c.bugs || 0);
  const el = document.getElementById('inbox-total');
  if (el) el.textContent = total > 0 ? '合計 ' + total + '件' : '';
}

// 「今月の作業」の予定表カードのクリック。専用のモーダルは作らず、
// 予定表は「その月を見ながら判断する」ものなので、月の右の操作ボタン
// （cal-approve-mini。状態に応じて設定完了/承認/公開の操作が出る）まで連れて行く。
// サイドバーの「未対応」バッジは件数表示に専念させたため、入口はここ1つ
function goCalApproval() {
  const btn = document.getElementById('cal-approve-mini');
  if (btn && !btn.classList.contains('is-hidden')) {
    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  // ボタンが出ていない（日程未設定・限定PW・既に次の月へ進んだ月など）ときは、
  // 日程設定エリアへ連れて行く
  const card = document.getElementById('info-dates-card');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadPendingCounts() {
  try {
    const res = await apiGet('getPendingCounts');
    if (res && res.ok && res.counts) renderInboxCounts(res.counts);
  } catch (e) { console.warn('[loadPendingCounts]', e); }
}

// 救済申請モーダルは未対応の一覧を持っているので、その件数をそのまま使う
// （ここで getPendingCounts を呼び直す必要はない）
function updateRecoveryBadge(n) { setInboxCount('recovery', n); }

// ===== 管理・設定セクションの開閉 =====
// 数ヶ月に一度しか触らない区画なので畳めるようにする。
// 開閉は端末ごとの好みなので localStorage に覚えさせる
const SB_TOOLS_KEY = 'pwgws_admin_tools_open';
function toggleSbTools() {
  const t = document.getElementById('tools-toggle');
  if (!t) return;
  const open = !t.classList.contains('open');
  t.classList.toggle('open', open);
  t.querySelector('.sec-arrow').textContent = open ? '▾' : '▸';
  try { localStorage.setItem(SB_TOOLS_KEY, open ? '1' : '0'); } catch (_) {}
}
(function restoreSbTools() {
  let saved = null;
  try { saved = localStorage.getItem(SB_TOOLS_KEY); } catch (_) {}
  if (saved === '0') toggleSbTools();   // 既定は開いた状態
})();

async function approveRecoveryRequest(id) {
  if (!await uiConfirm({
    type: 'warn', title: 'アカウント復旧申請の承認',
    message: 'この申請を承認しますか？\n\n承認するとパスコードが表示されます。\n電話やLINEなど、本人と確実に連絡が取れる手段でお伝えください。',
    confirmText: '承認する',
  })) return;
  showProc('承認しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'approveRecoveryRequest', requestId: id });
    if (!res.ok) {
      const msgs = {
        unauthorized:   '権限がありません',
        already_handled:'この申請は既に処理済みです',
        expired:        'この申請は期限切れです',
        not_matched:    'メンバーと一致していないため承認できません',
        self_approval:  '自分自身の申請は承認できません。他の管理者に依頼してください',
      };
      throw new Error(msgs[res.reason] || res.reason || '承認に失敗しました');
    }
    hideProc();
    document.getElementById('m-recovery-otp-body').innerHTML =
      `<div class="rec-otp-name">${esc(res.name)} さんへ</div>
       <div class="rec-otp-code">${esc(res.otp)}</div>
       <div style="text-align:center;margin-bottom:12px;">
         <button class="btn btn-g" onclick="copyRecoveryOtp('${esc(res.otp)}')">コピー</button>
       </div>
       <div class="rec-note">
         このパスコードは <b>${Math.round(res.expiresInMin / 60)}時間</b> 有効です。<br>
         電話・LINEなど、<b>普段その方とやりとりしている連絡先</b>にお伝えください。<br>
         ⚠️ 申請フォームに入力されたメールアドレス宛には送らないでください。<br>
         この画面を閉じても、一覧の「パスコード発行済み」からいつでも確認できます。
       </div>`;
    openM('m-recovery-otp');
  } catch (e) { hideProc(); toast('承認失敗: ' + e.message, 'e'); }
}

async function rejectRecoveryRequest(id) {
  if (!await uiConfirm({
    type: 'danger', title: 'アカウント復旧申請の却下',
    message: 'この申請を却下しますか？', confirmText: '却下する',
  })) return;
  showProc('却下しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'rejectRecoveryRequest', requestId: id });
    if (!res.ok) throw new Error(res.reason || '却下に失敗しました');
    await loadRecoveryRequests();
    hideProc();
    toast('申請を却下しました', 's');
  } catch (e) { hideProc(); toast('却下失敗: ' + e.message, 'e'); }
}

function copyRecoveryOtp(otp) {
  navigator.clipboard.writeText(otp)
    .then(() => toast('パスコードをコピーしました', 's'))
    .catch(() => toast('コピーできませんでした。手入力してください', 'e'));
}

function openRecoveryKeyModal() {
  // 変更前に現在の合言葉を見せておく（同じものを入れ直す事故を防ぐ）
  document.getElementById('rec-newkey').value = '';
  document.getElementById('rec-key-msg').textContent = '';
  const cur = document.getElementById('rec-curkey');
  cur.textContent = _recSharedKey ? '現在の合言葉：' + _recSharedKey : '現在の合言葉は確認できません';
  openM('m-recovery-key');
}

async function saveRecoveryKey() {
  const key = document.getElementById('rec-newkey').value.trim();
  const msg = document.getElementById('rec-key-msg');
  if (key.length < 4) { msg.style.color = 'var(--red)'; msg.textContent = '4文字以上で入力してください。'; return; }
  showProc('合言葉を変更しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'setRecoverySharedKey', sharedKey: key });
    if (!res.ok) throw new Error(res.reason === 'too_short' ? '4文字以上で入力してください' : (res.reason || '変更に失敗しました'));
    closeM('m-recovery-key');
    await loadRecoveryRequests();   // 表示中の合言葉を新しいものに更新する
    hideProc();
    toast('合言葉を変更しました', 's');
  } catch (e) { hideProc(); toast('変更失敗: ' + e.message, 'e'); }
}

async function openDistributionReportModal() {
  openM('m-distrib-report');
  await refreshDistributionReportModal();
}
async function refreshDistributionReportModal() {
  document.getElementById('m-distrib-report-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const d = await apiGet('getDistributionReports');
    const reports = d.reports || [];
    let html = `<div style="font-size:11px;color:var(--ink3);margin-bottom:10px;">${reports.length}件</div>`;
    if (reports.length === 0) {
      html += '<div style="color:var(--ink3);font-size:13px;text-align:center;padding:20px;">配布報告はありません</div>';
    } else {
      html += reports.map(r => `
        <div style="border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:12px;font-weight:700;">${esc(r.reportDate||'')}${r.reportTime ? ' ' + esc(r.reportTime) : ''}</span>
            <span style="font-size:10px;color:var(--ink3);">${esc(r.name||'')}</span>
          </div>
          <div style="font-size:13px;color:var(--ink);white-space:pre-wrap;margin-bottom:4px;">${esc(r.items||'')}</div>
          ${r.notes ? `<div style="font-size:12px;color:var(--ink2);white-space:pre-wrap;">${esc(r.notes)}</div>` : ''}
          <div style="font-size:10px;color:var(--ink3);margin-top:6px;">送信: ${esc(r.createdAt||'')}</div>
        </div>`).join('');
    }
    document.getElementById('m-distrib-report-body').innerHTML = html;
  } catch (e) {
    document.getElementById('m-distrib-report-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}

// ============================================================
// ログ閲覧
//
// サーバーに溜まっている3種類のログを読むための画面。
// 既定は「管理者の操作」＝誰がいつ公開作業をしたかを確認するためのもの。
// 一度に全部は取らず、50件ずつ「もっと見る」で継ぎ足す
// ============================================================
const LOG_PAGE = 50;
const LOG_KIND_LABEL = {
  admin:   '管理者の操作',
  wish:    '希望提出',
  access:  'ログイン',
};
// 絞り込みの条件はタブごとに別物なので、タブを切り替えたら作り直す。
// 既定値の考え方：
//   admin  … 操作の指定なし＝サーバー側で「シフト枠保存」を隠す（従来どおり）
//   access … 失敗だけを表示。成功・試行は量が多く、ふだん見る必要が無い
function defaultLogFilter(kind) {
  return {
    ops: [], results: kind === 'access' ? ['失敗'] : [], apps: [],
    person: '', onlyUnreviewed: true,
  };
}
let logState = {
  kind: 'admin', offset: 0, total: 0, rows: [], loading: false, hasDate: true,
  filter: defaultLogFilter('admin'),
  options: {},        // タブごとの絞り込み選択肢（開いた最初の1回だけ取りに行く）
  expanded: {},       // 展開中の行 id
  details: {},        // 取得済みの詳細（同じ行を開き直しても取り直さない）
  openCats: {},       // 個別の操作を開いているカテゴリ
  purgeMonths: 6,     // アクセスログ整理の対象期間
};

function logFilterKey(kind, id) { return kind + ':' + id; }

function toggleLogFilterPanel() {
  const el = document.getElementById('log-filter-panel');
  const on = !el.classList.contains('on');
  el.classList.toggle('on', on);
  document.getElementById('log-filter-more').textContent = (on ? '▴' : '▾') + ' 条件で絞り込む';
}

// たたんでいる間、何で絞り込んでいるかを一行で見せる。
// 絞り込んでいることに気づかず「件数が少ない」と誤解するのを防ぐ。
// 「確認済みは隠す」は絞り込みというより見せ方の指定なので数えない
function updateLogFilterSummary() {
  const f = logState.filter;
  const from = document.getElementById('log-from').value;
  const to   = document.getElementById('log-to').value;
  const q    = document.getElementById('log-q').value.trim();
  const parts = [];
  if (from || to) parts.push('期間');
  if (q)          parts.push('文字');
  if (f.ops.length)     parts.push('操作' + f.ops.length);
  if (f.results.length) parts.push('結果' + f.results.length);
  if (f.apps.length)    parts.push('アプリ' + f.apps.length);
  if (f.person)         parts.push('人');
  const el = document.getElementById('log-filter-sum');
  el.textContent = parts.length ? '絞り込み中： ' + parts.join('・') : '';
  el.classList.toggle('on', parts.length > 0);
}

function openLogModal() {
  logState = {
    kind: 'admin', offset: 0, total: 0, rows: [], loading: false, hasDate: true,
    filter: defaultLogFilter('admin'), options: {}, expanded: {}, details: {},
    openCats: {}, purgeMonths: 6,
  };
  document.getElementById('log-from').value  = '';
  document.getElementById('log-to').value    = '';
  document.getElementById('log-q').value     = '';
  document.getElementById('log-filter-panel').classList.remove('on');
  document.getElementById('log-filter-more').textContent = '▾ 条件で絞り込む';
  document.getElementById('log-filter-groups').innerHTML = '';
  document.getElementById('log-content').innerHTML = '';
  setVisible(document.getElementById('log-date-note'), false);
  updateLogFilterSummary();
  document.querySelectorAll('#log-tabs .log-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.kind === 'admin');
  });
  openM('m-logs');
  loadLogs(true);
}

function switchLogKind(kind) {
  if (logState.loading || logState.kind === kind) return;
  logState.kind     = kind;
  logState.filter   = defaultLogFilter(kind);
  logState.expanded = {};
  logState.openCats = {};
  document.getElementById('log-q').value = '';
  document.querySelectorAll('#log-tabs .log-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.kind === kind);
  });
  renderLogFilterPanel();
  loadLogs(true);
}

function loadMoreLogs() { loadLogs(false); }

function showLogOv(text) {
  document.getElementById('log-ov-text').textContent = text;
  document.getElementById('log-ov').classList.add('on');
  document.querySelectorAll('#log-tabs .log-tab').forEach(b => b.disabled = true);
}
function hideLogOv() {
  document.getElementById('log-ov').classList.remove('on');
  document.querySelectorAll('#log-tabs .log-tab').forEach(b => b.disabled = false);
}

async function loadLogs(reset) {
  if (logState.loading) return;
  logState.loading = true;
  if (reset) { logState.offset = 0; logState.rows = []; }
  showLogOv(LOG_KIND_LABEL[logState.kind] + ' のログを読み込み中...');
  try {
    const f = logState.filter;
    const d = await apiGet('getLogs', {
      kind:   logState.kind,
      from:   document.getElementById('log-from').value || '',
      to:     document.getElementById('log-to').value   || '',
      q:      document.getElementById('log-q').value.trim(),
      ops:    f.ops, results: f.results, apps: f.apps, person: f.person,
      onlyUnreviewed: logState.kind === 'access' && f.onlyUnreviewed,
      // 選択肢はタブごとに1回だけ取りに行く（毎回だとサーバー側の読み取りが無駄に増える）
      withOptions: !logState.options[logState.kind],
      limit:  LOG_PAGE,
      offset: logState.offset,
    });
    if (!d.ok) throw new Error(d.error === 'unauthorized' ? '権限がありません' : (d.error || '取得に失敗しました'));
    if (d.options) { logState.options[logState.kind] = d.options; renderLogFilterPanel(); }
    logState.rows  = logState.rows.concat(d.rows || []);
    logState.total = d.total || logState.rows.length;
    logState.offset = logState.rows.length;
    // 日時が記録されていない種類のログでは、期間を指定させても効かないので
    // 入力を閉じ、なぜ使えないのかもその場に書いておく
    logState.hasDate = d.hasDate !== false;
    document.getElementById('log-from').disabled = !logState.hasDate;
    document.getElementById('log-to').disabled   = !logState.hasDate;
    setVisible(document.getElementById('log-date-note'), !logState.hasDate);
    updateLogFilterSummary();
    renderLogs();
  } catch (e) {
    document.getElementById('log-content').innerHTML =
      `<div class="log-empty" style="color:var(--red);">エラー: ${esc(e.message)}</div>`;
  } finally {
    logState.loading = false;
    hideLogOv();
  }
}

// ------------------------------------------------------------
// 絞り込みパネル（選択チップ）
//
// 値の候補はサーバーから受け取る。操作名をこちら側にも書くと二重管理になり、
// 追加した操作が画面から絞り込めない、という食い違いが起きるため。
// ただし「どの操作がどの作業に属するか」は画面の都合なので、分類だけここで持つ。
// 分類に無い操作（サーバー側で追加されたもの）は「その他」にまとめて必ず出す
// ------------------------------------------------------------
const LOG_OP_GROUPS = [
  { name: '公開・日程',   ops: ['カレンダー公開', 'カレンダー非公開', 'イベント日程更新', 'フォーム作成'] },
  { name: 'シフト',       ops: ['シフト作成完了', 'シフト作成完了の取り消し', 'シフト確認完了', 'シフト差し戻し', 'シフト枠保存', 'シフト枠保存（フォーム）'] },
  { name: '希望',         ops: ['シフト希望編集', 'スプレッドシート一括インポート'] },
  { name: 'メンバー',     ops: ['メンバー追加', 'メンバー更新', 'メンバー削除'] },
  { name: 'ログイン・設定', ops: ['救済ログイン承認', '救済ログイン却下', '救済セッション失効', '救済ログイン共通キー変更', '検証ルール保存', 'アクセスログ整理', 'ログイン失敗の確認'] },
];

// サーバーが返した操作一覧を分類に流し込む。分類漏れは「その他」へ
function logOpGroups(all) {
  const known = new Set();
  const groups = LOG_OP_GROUPS
    .map(g => {
      const ops = g.ops.filter(o => all.includes(o));
      ops.forEach(o => known.add(o));
      return { name: g.name, ops };
    })
    .filter(g => g.ops.length > 0);
  const rest = all.filter(o => !known.has(o));
  if (rest.length > 0) groups.push({ name: 'その他', ops: rest });
  return groups;
}

// ------------------------------------------------------------
// 選択チップ（チェックボックス・ラジオ・ドロップダウンの置き換え）
//
// 状態は class="on" が持つ。読み出しは uiChipOn / uiChipVal で行うため、
// 呼び出し側は input の .checked を触らない
// ------------------------------------------------------------
// 複数選択（チェックボックス相当）
function uiChipToggle(el) {
  if (el.classList.contains('dis')) return;
  el.classList.toggle('on');
}
// 単一選択（ラジオ・ドロップダウン相当）。同じ親の中で1つだけ on になる
function uiChipPick(el, onPicked) {
  if (el.classList.contains('dis')) return;
  [...el.parentNode.children].forEach(c => c.classList.remove('on'));
  el.classList.add('on');
  if (onPicked) onPicked(el.dataset.val);
}
function uiChipOn(key)   { return !!document.querySelector(`[data-chip="${key}"].on`); }
function uiChipVal(group){ return document.querySelector(`[data-group="${group}"].on`)?.dataset.val ?? ''; }

// 複数選択チップ1個（key で uiChipOn から読む）
function uiCheckChip(key, label, on, disabled) {
  return `<button type="button" class="uic lg${on ? ' on' : ''}${disabled ? ' dis' : ''}"` +
    ` data-chip="${esc(key)}" onclick="uiChipToggle(this)">${esc(label)}</button>`;
}
// 単一選択チップの並び（group で uiChipVal から読む）
function uiPickChips(group, items, current, disabled, onPicked) {
  return `<div class="uic-row">` + items.map(it =>
    `<button type="button" class="uic lg${it.value === current ? ' on' : ''}${disabled ? ' dis' : ''}"` +
    ` data-group="${esc(group)}" data-val="${esc(it.value)}"` +
    ` onclick="uiChipPick(this${onPicked ? ',' + onPicked : ''})">${esc(it.label)}</button>`).join('') +
    `</div>`;
}

function uiChip(label, on, onclick, extra) {
  return `<button class="uic${on ? ' on' : ''}" onclick="${onclick}">${esc(label)}` +
    (extra ? `<span class="uic-n">${esc(extra)}</span>` : '') + `</button>`;
}

// 配列に入れる／外す（チップは押した時点で状態を変え、表示は「この条件で表示」で反映する）
function toggleLogValue(name, value) {
  const arr = logState.filter[name];
  const i   = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1); else arr.push(value);
  renderLogFilterPanel();
}
// カテゴリごと入れる／外す。一部だけ選ばれている場合は「全部入れる」に倒す
function toggleLogOpGroup(idx) {
  const g = logOpGroups(logState.options[logState.kind].ops)[idx];
  const f = logState.filter;
  const all = g.ops.every(o => f.ops.includes(o));
  f.ops = all ? f.ops.filter(o => !g.ops.includes(o))
              : [...new Set(f.ops.concat(g.ops))];
  renderLogFilterPanel();
}
function toggleLogOpGroupOpen(idx) {
  logState.openCats[idx] = !logState.openCats[idx];
  renderLogFilterPanel();
}
function toggleLogPerson(id) {
  logState.filter.person = logState.filter.person === id ? '' : id;
  renderLogFilterPanel();
}
function toggleLogUnreviewed() {
  logState.filter.onlyUnreviewed = !logState.filter.onlyUnreviewed;
  renderLogFilterPanel();
}

function renderLogFilterPanel() {
  const kind = logState.kind;
  const o    = logState.options[kind];
  const f    = logState.filter;
  const box  = document.getElementById('log-filter-groups');
  if (!o) { box.innerHTML = '<div class="log-fg-empty">選択肢を読み込んでいます...</div>'; return; }

  let html = '';

  // 操作は20種類前後あり、平らに並べると読む気が起きない。作業のまとまりでたたむ
  if (kind === 'admin' && o.ops.length > 0) {
    html += `<div class="log-fg"><div class="log-fg-t">操作（何も選ばなければすべて表示）</div>`;
    logOpGroups(o.ops).forEach((g, i) => {
      const sel  = g.ops.filter(x => f.ops.includes(x)).length;
      const all  = sel === g.ops.length;
      const open = !!logState.openCats[i];
      // 行そのものは開閉。まとめて選ぶのは右端のボタンに分ける
      // （同じ場所に2つの意味を持たせると、どちらが起きるか予測できない）
      html += `<div class="lf-grp">
          <button class="lf-cat${sel > 0 ? ' sel' : ''}" onclick="toggleLogOpGroupOpen(${i})">
            <span class="lf-cat-cv">${open ? '▼' : '▶'}</span>
            <span>${esc(g.name)}</span>
            <span class="lf-cat-n">${sel > 0 ? sel + ' / ' + g.ops.length : g.ops.length + '件'}</span>
            <span class="lf-all${all ? ' on' : ''}" onclick="event.stopPropagation();toggleLogOpGroup(${i})">${all ? '解除' : 'すべて'}</span>
          </button>
          <div class="lf-ops${open ? ' on' : ''}">` +
        g.ops.map(op => uiChip(op, f.ops.includes(op), `toggleLogValue('ops','${esc(op)}')`)).join('') +
        `</div></div>`;
    });
    html += `</div>`;
  }

  if (kind === 'access') {
    if (o.results.length > 0) {
      html += `<div class="log-fg"><div class="log-fg-t">結果</div><div class="log-fg-b">` +
        o.results.map(v => uiChip(v, f.results.includes(v), `toggleLogValue('results','${esc(v)}')`)).join('') +
        `</div></div>`;
    }
    if (o.apps.length > 0) {
      html += `<div class="log-fg"><div class="log-fg-t">アプリ</div><div class="log-fg-b">` +
        o.apps.map(v => uiChip(v, f.apps.includes(v), `toggleLogValue('apps','${esc(v)}')`)).join('') +
        `</div></div>`;
    }
    html += `<div class="log-fg"><div class="log-fg-t">確認済み</div><div class="log-fg-b">` +
      uiChip('確認済みは隠す', f.onlyUnreviewed, 'toggleLogUnreviewed()') + `</div></div>`;
  }

  if (o.people && o.people.length > 0) {
    html += `<div class="log-fg"><div class="log-fg-t">人</div><div class="log-fg-b lf-scroll">` +
      o.people.map(pp => uiChip(pp.name, f.person === pp.id, `toggleLogPerson('${esc(pp.id)}')`)).join('') +
      `</div></div>`;
  }

  box.innerHTML = html || '<div class="log-fg-empty">このログに絞り込める項目はありません</div>';
  updateLogFilterSummary();
}

// チップは押した時点で logState.filter を変えているので、ここでは取りに行くだけ
function applyLogFilter() { loadLogs(true); }

function clearLogFilter() {
  logState.filter = defaultLogFilter(logState.kind);
  // access の既定は「失敗だけ」なので、クリア＝全件表示にする
  if (logState.kind === 'access') logState.filter.results = [];
  logState.openCats = {};
  // 期間と文字もこのパネルの条件なので、まとめて消す
  document.getElementById('log-from').value = '';
  document.getElementById('log-to').value   = '';
  document.getElementById('log-q').value    = '';
  renderLogFilterPanel();
  loadLogs(true);
}

function renderLogs() {
  const kind = logState.kind;
  const rows = logState.rows;
  const f    = logState.filter;
  let html = '';

  if (kind === 'access') {
    html += `<div class="log-hint">ログインの試行・成功・失敗の記録です。` +
      (f.results.length === 1 && f.results[0] === '失敗'
        ? '<b>いまは「失敗」だけを表示しています。</b>成功・試行も見るには「条件で絞り込む」から結果を選んでください。'
        : '身に覚えのないログイン失敗が並んでいないかの確認に使えます。') +
      `</div>`;
  }

  // シフト枠保存は10分単位でまとめて記録されるため、既定でも一覧に出す。
  // それでも多いと感じたときの逃げ道は案内しておく
  if (kind === 'admin' && f.ops.length === 0) {
    html += `<div class="log-hint">シフト枠保存は10分ごとにまとめて記録されます。多いと感じたら「条件で絞り込む」→ 操作 から外せます。</div>`;
  }

  if (!logState.hasDate) {
    html += `<div class="log-hint" style="color:var(--amber);">このログには日時が記録されていないため、期間での絞り込みと日時の表示はできません（新しい順に並びます）。</div>`;
  }

  html += `<div class="log-count">${logState.total}件中 ${rows.length}件を表示</div>`;

  if (rows.length === 0) {
    html += '<div class="log-empty">該当するログはありません</div>';
  } else {
    html += '<div class="log-list">' + rows.map(r => logRowHtml(kind, r)).join('') + '</div>';
    if (rows.length < logState.total) {
      html += `<div class="log-more"><button class="btn btn-g" onclick="loadMoreLogs()">もっと見る（残り${logState.total - rows.length}件）</button></div>`;
    }
  }

  // アクセスログだけは放っておくと際限なく増えるので、この場で整理できるようにする
  if (kind === 'access') html += logPurgeBoxHtml();

  document.getElementById('log-content').innerHTML = html;
}

function logRowHtml(kind, r) {
  let main = '', sub = '', foot = '';
  if (kind === 'admin') {
    main = `<span class="log-who">${esc(r.name || '（不明）')}</span> <span class="log-op">${esc(r.operation)}</span>`;
    sub  = r.detail;
  } else if (kind === 'wish') {
    main = `<span class="log-who">${esc(r.name || '（不明）')}</span> <span class="log-op">希望を提出</span>` +
           (r.isProxy ? '<span class="log-tag info">代理</span>' : '');
    sub  = [r.sendType, r.slotCount != null ? r.slotCount + '枠' : ''].filter(Boolean).join(' / ');
  } else {
    // 氏名が分かるのはログインに成功したときだけ。
    // 試行・失敗の行はメールアドレスしか無いので、それを見出しにする
    const cls = r.result === '成功' ? 'ok' : (r.result === '失敗' ? 'ng' : 'try');
    main = `<span class="log-who">${esc(r.name || r.email || '（不明）')}</span><span class="log-tag ${cls}">${esc(r.result || '－')}</span>` +
           (r.reviewedAt ? '<span class="log-tag ok">確認済み</span>' : '');
    sub  = [r.name ? r.email : '', r.appName, r.reason].filter(Boolean).join(' / ');
    // 失敗は消さずに「確認済み」で隠す。誰がいつ確認したかも残す
    if (r.result === '失敗') {
      foot = r.reviewedAt
        ? `<div class="log-rev">${esc(r.reviewedAt)} ${esc(r.reviewedBy || '')} が確認
             <button class="log-rev-btn" onclick="reviewAccessLog(${r.id},true)">取り消す</button></div>`
        : `<div class="log-rev"><button class="log-rev-btn" onclick="reviewAccessLog(${r.id},false)">確認済みにする</button></div>`;
    }
  }

  const open = !!logState.expanded[logFilterKey(kind, r.id)];
  const more = r.hasDetail
    ? `<button class="log-more-btn" onclick="toggleLogDetail(${r.id})">${open ? '▴ 閉じる' : '▾ 詳細'}</button>`
    : '';
  const det = open
    ? `<div class="log-det" id="log-det-${r.id}">${logDetailBodyHtml(kind, r.id)}</div>`
    : '';

  return `<div class="log-row">
      <div class="log-at">${esc(r.at)}</div>
      <div class="log-main">${main}${sub ? `<div class="log-detail">${esc(sub)}</div>` : ''}${foot}${det}</div>
      ${more}
    </div>`;
}

// ------------------------------------------------------------
// 行の展開（何がどう変わったか）
//
// 一覧には詳細を載せていない（集約されたシフト枠保存は変更が数百件ぶら下がる）。
// 開いたときに1件だけ取りに行き、取れたものは覚えておいて開き直しでは取り直さない
// ------------------------------------------------------------
async function toggleLogDetail(id) {
  const kind = logState.kind;
  const key  = logFilterKey(kind, id);
  if (logState.expanded[key]) { delete logState.expanded[key]; renderLogs(); return; }

  logState.expanded[key] = true;
  renderLogs();
  if (logState.details[key] !== undefined) return;

  try {
    const d = await apiGet('getLogDetail', { kind, id });
    if (!d.ok) throw new Error(d.error || '取得に失敗しました');
    logState.details[key] = d.detail;
  } catch (e) {
    logState.details[key] = { __error: e.message };
  }
  // 開いたまま別の操作をしている可能性があるので、閉じられていたら描き直さない
  if (logState.expanded[key]) renderLogs();
}

function logDetailBodyHtml(kind, id) {
  const d = logState.details[logFilterKey(kind, id)];
  if (d === undefined) return '<div class="log-det-load"><span class="spin"></span> 詳細を読み込み中...</div>';
  if (d && d.__error)  return `<div class="log-det-err">詳細の取得に失敗しました: ${esc(d.__error)}</div>`;
  return logDetailHtml(d);
}

// detail_json は操作ごとに形が違う。よく出る形（変更の一覧・提出した枠・
// カレンダーの日程）だけ整えて見せ、それ以外は素直に項目名と値を並べる
function logDetailHtml(d) {
  if (!d || typeof d !== 'object') return '<div class="log-det-err">詳細は記録されていません</div>';
  const skip = new Set(['changes', 'slots', 'dates', 'before', 'after', 'inserted', 'skipped', 'member', 'ids']);
  let h = '';

  const val = v => (v === null || v === undefined || v === '') ? '－'
    : (v === true ? 'あり' : (v === false ? 'なし' : String(v)));

  if (Array.isArray(d.changes) && d.changes.length > 0) {
    h += `<div class="log-det-t">変更（${d.changes.length}件）</div>` +
      d.changes.map(c => `<div class="log-det-chg">
          <span class="log-det-at">${esc(c.at || c.field || '')}</span>
          <span class="log-det-from">${esc(val(c.from))}</span>
          <span class="log-det-arw">→</span>
          <span class="log-det-to">${esc(val(c.to))}</span>
        </div>`).join('');
  }
  if (Array.isArray(d.slots) && d.slots.length > 0) {
    h += `<div class="log-det-t">送信した枠（${d.slots.length}件）</div><div class="log-det-slots">` +
      d.slots.map(s => `<span class="log-det-slot">${esc(s.date || '')} ${esc(s.time || '')}` +
        (s.comment ? `<i>${esc(s.comment)}</i>` : '') + `</span>`).join('') + '</div>';
  }
  ['inserted', 'skipped'].forEach(k => {
    if (!Array.isArray(d[k]) || d[k].length === 0) return;
    h += `<div class="log-det-t">${k === 'inserted' ? '投入' : 'スキップ'}（${d[k].length}件）</div><div class="log-det-slots">` +
      d[k].map(s => `<span class="log-det-slot">${esc(s.name || '')} ${esc(s.date || '')} ${esc(s.time || '')}` +
        (s.reason ? `<i>${esc(s.reason)}</i>` : '') + `</span>`).join('') + '</div>';
  });
  const dateRow = (label, o) => `<div class="log-det-kv"><span>${esc(label)}</span><b>` +
    `申込 ${esc(val(o.apply))}・締切 ${esc(val(o.deadline))}・公開 ${esc(val(o.open))}</b></div>`;
  if (d.dates)  h += `<div class="log-det-t">日程</div>` + dateRow('この時点', d.dates);
  if (d.before || d.after) {
    h += `<div class="log-det-t">日程</div>`;
    if (d.before) h += dateRow('変更前', d.before);
    if (d.after)  h += dateRow('変更後', d.after);
  }
  if (d.member && typeof d.member === 'object') {
    h += `<div class="log-det-t">内容</div>` +
      Object.entries(d.member).map(([k, v]) => `<div class="log-det-kv"><span>${esc(k)}</span><b>${esc(val(v))}</b></div>`).join('');
  }

  const rest = Object.entries(d).filter(([k, v]) =>
    !skip.has(k) && v !== null && v !== '' && typeof v !== 'object');
  if (rest.length > 0) {
    h += `<div class="log-det-t">その他</div>` +
      rest.map(([k, v]) => `<div class="log-det-kv"><span>${esc(k)}</span><b>${esc(val(v))}</b></div>`).join('');
  }
  return h || '<div class="log-det-err">詳細は記録されていません</div>';
}

// 失敗ログの確認済み切り替え。消さずに一覧から隠すだけ
async function reviewAccessLog(id, undo) {
  showLogOv(undo ? '確認済みを取り消しています...' : '確認済みにしています...');
  try {
    const d = await apiPost('reviewAccessLogs', { ids: [id], undo: !!undo });
    if (!d.ok) throw new Error(d.error || '更新に失敗しました');
    hideLogOv();
    toast(undo ? '確認済みを取り消しました' : '確認済みにしました', 's');
    loadLogs(true);
  } catch (e) {
    hideLogOv();
    toast('失敗: ' + e.message, 'e');
  }
}

function logPurgeBoxHtml() {
  return `<div class="log-purge">
      <b>アクセスログの整理</b><br>
      ログイン記録は<b>90日で自動的に削除</b>されます（毎日1回）。ここでは前倒しで整理できます。
      指定した時期より前の「試行」「成功」だけをまとめて削除します。
      <b>「失敗」の記録は不正アクセスの手がかりになるため、自動でも手動でも削除しません。</b>
      不要な失敗は各行の「確認済みにする」で一覧から隠せます。
      <div class="log-purge-row">` +
      [3, 6, 12, 24].map(m => uiChip(m < 12 ? m + 'ヶ月' : (m / 12) + '年',
        logState.purgeMonths === m, `setLogPurgeMonths(${m})`)).join('') + `
        <span>より前のものを削除</span>
        <button class="btn btn-d" onclick="purgeAccessLogs()">🗑 整理する</button>
      </div>
    </div>`;
}

// 指定月数より前のアクセスログを削除する。
// 消える前に必ず件数を数えて（dryRun）から確認を取る
function setLogPurgeMonths(m) { logState.purgeMonths = m; renderLogs(); }

async function purgeAccessLogs() {
  const months = logState.purgeMonths || 6;
  const cut = new Date();
  cut.setMonth(cut.getMonth() - months);
  const before = cut.getFullYear() + '-' +
    String(cut.getMonth() + 1).padStart(2, '0') + '-' +
    String(cut.getDate()).padStart(2, '0');

  showLogOv('削除対象を数えています...');
  let count = 0;
  try {
    const d = await apiPost('purgeAccessLogs', { before, dryRun: true });
    if (!d.ok) throw new Error(d.error === 'unauthorized' ? '権限がありません' : (d.error || '取得に失敗しました'));
    count = d.count || 0;
  } catch (e) {
    hideLogOv();
    toast('削除対象の確認に失敗: ' + e.message, 'e');
    return;
  }
  hideLogOv();

  if (count === 0) { toast('削除対象のログはありませんでした', 's'); return; }
  if (!await uiConfirm({
    type: 'danger',
    title: 'アクセスログの整理',
    message: `${before} より前の「試行」「成功」のログ ${count}件を削除します。\n` +
             '「失敗」の記録は削除されません。\n\nこの操作は取り消せません。',
    confirmText: '削除する',
  })) return;

  showLogOv('削除しています...');
  try {
    const d = await apiPost('purgeAccessLogs', { before });
    if (!d.ok) throw new Error(d.error || '削除に失敗しました');
    toast(`${d.count}件のログを削除しました`, 's');
    hideLogOv();
    await loadLogs(true);
  } catch (e) {
    hideLogOv();
    toast('削除に失敗: ' + e.message, 'e');
  }
}

// ============================================================
// 権限リスト同期
// ============================================================
async function execSyncAccess() {
  if (!await uiConfirm({
    type: 'warn', title: 'アクセス許可リストの同期',
    message: '公開ファイルの編集者・閲覧者をアクセス許可リストに同期しますか？',
    confirmText: '同期する',
  })) return;
  try {
    const res = await apiGet('syncAccessList');
    if (!res.ok) throw new Error(res.error || '同期失敗');
    toast(`同期完了（${res.added}件追加）`, 's');
  } catch (e) { toast('同期失敗: ' + e.message, 'e'); }
}

// ============================================================
// 写真管理モーダル
// ============================================================
let _photoMgmtCategory = 'exhibit';
let _photoMgmtYear = curY;
let _photoMgmtMonth = curM;

async function openPhotoMgmtModal(category) {
  _photoMgmtCategory = category;
  _photoMgmtYear  = curY;
  _photoMgmtMonth = curM;
  const titleEl = document.getElementById('m-photo-mgmt-title');
  titleEl.textContent = category === 'road' ? '🗺 道路許可書写真管理' : '🖼 展示内容写真管理';
  // ファイル入力リセット
  const inp = document.getElementById('photo-upload-input');
  if (inp) inp.value = '';
  openM('m-photo-mgmt');
  await loadPhotoMgmtList();
}

async function loadPhotoMgmtList() {
  const body = document.getElementById('m-photo-mgmt-body');
  body.innerHTML = '<div style="text-align:center;padding:20px;"><div class="spin"></div> 読み込み中...</div>';
  try {
    const res = await apiGet('getPhotos', { category: _photoMgmtCategory, year: _photoMgmtYear, month: _photoMgmtMonth });
    const photos = (res && res.photos) || [];
    // 通常PWは年月セレクタ、限定PWは年月という単位に馴染まないため
    // 現在選択中のスロット名を出すだけにする（写真は限定PWごとに完全に分けて保存される）
    const ymHtml = currentPwType === 'normal' ? buildPhotoYmSelector() : buildPhotoScopeLabel();
    if (!photos.length) {
      body.innerHTML = ymHtml + '<div style="text-align:center;padding:20px;color:var(--ink3);font-size:13px;">写真が登録されていません</div>';
      return;
    }
    let grid = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-top:10px;">';
    photos.forEach(p => {
      grid += '<div style="position:relative;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#f9fafb;">'
        + '<img src="' + p.url + '" alt="' + p.fileName + '" style="width:100%;height:100px;object-fit:cover;display:block;" loading="lazy">'
        + '<div style="padding:4px 6px;font-size:11px;color:var(--ink3);word-break:break-all;">' + p.fileName + '</div>'
        + '<button onclick="deletePhoto(\'' + p.fileId + '\')" style="position:absolute;top:4px;right:4px;background:rgba(239,68,68,0.85);border:none;color:#fff;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;">✕</button>'
        + '</div>';
    });
    grid += '</div>';
    body.innerHTML = ymHtml + grid;
  } catch(e) {
    body.innerHTML = '<div style="color:var(--red);padding:16px;">読み込みに失敗しました: ' + e.message + '</div>';
  }
}

function buildPhotoYmSelector() {
  // 年月セレクタ（前後6ヶ月）
  const items = [];
  for (let delta = -3; delta <= 3; delta++) {
    let y = curY, m = curM + delta;
    while (m < 1)  { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    items.push({ value: y + '_' + m, label: y + '年' + m + '月' });
  }
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
    + '<span style="font-size:12px;color:var(--ink2);font-weight:700;">対象月：</span>'
    + uiSelHtml('photo-ym', {
        title: '対象月', items, value: _photoMgmtYear + '_' + _photoMgmtMonth,
        style: 'font-size:13px;', onPick: v => onPhotoYmChange(v),
      })
    + '</div>';
}

async function onPhotoYmChange(val) {
  const parts = val.split('_');
  _photoMgmtYear  = parseInt(parts[0]);
  _photoMgmtMonth = parseInt(parts[1]);
  await loadPhotoMgmtList();
}

// 限定PW用：年月セレクタの代わりに、今どのスロットの写真を見ているかだけ示す
// （限定PWの写真はスロット単位で保存され、通常PWの写真とは完全に分離される）
function buildPhotoScopeLabel() {
  const slot = limitedSlots.find(s => s.id === currentPwType);
  return '<div style="font-size:12px;color:var(--ink2);font-weight:700;margin-bottom:4px;">'
    + '🔐 ' + esc(slot ? slot.name : '限定PW') + ' の写真（他の限定PW・通常PWとは別に保存されます）'
    + '</div>';
}

async function onPhotoFilesSelected(event) {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  const body = document.getElementById('m-photo-mgmt-body');

  // 既存写真数を確認してindexを決める
  let startIndex = 1;
  try {
    const res = await apiGet('getPhotos', { category: _photoMgmtCategory, year: _photoMgmtYear, month: _photoMgmtMonth });
    startIndex = ((res && res.photos) || []).length + 1;
  } catch(e) { console.warn('[onPhotoFilesSelected]', e); }

  const total = files.length;
  let completed = 0;
  let failed = 0;

  showProc('写真をアップロードしています...', total + '枚中 0枚完了');

  // base64変換を全ファイル並列で実行
  const base64List = await Promise.all(files.map(f => fileToBase64(f)));

  // アップロードを全ファイル並列で実行
  await Promise.all(files.map(async (file, i) => {
    try {
      await apiPost('uploadPhoto', {
        category: _photoMgmtCategory,
        type:     currentPwType,
        year:     _photoMgmtYear,
        month:    _photoMgmtMonth,
        base64:   base64List[i],
        mimeType: file.type || 'image/jpeg',
        index:    startIndex + i
      });
      completed++;
    } catch(e) {
      failed++;
      console.error('アップロード失敗:', file.name, e.message);
    }
    setProcMsg(undefined, total + '枚中 ' + (completed + failed) + '枚処理済み' + (failed > 0 ? '（' + failed + '枚失敗）' : ''));
  }));

  // リスト再読み込み
  const inp = document.getElementById('photo-upload-input');
  if (inp) inp.value = '';
  await loadPhotoMgmtList();
  hideProc();

  if (failed === 0) {
    toast(total + '枚のアップロードが完了しました', 's');
  } else if (completed > 0) {
    toast(completed + '枚完了、' + failed + '枚失敗しました', 'e');
  } else {
    toast('アップロードに失敗しました', 'e');
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function deletePhoto(fileId) {
  if (!await uiConfirm({
    type: 'danger', title: '写真の削除',
    message: 'この写真を削除しますか？', confirmText: '削除する',
  })) return;
  showProc('写真を削除しています...', '少々お待ちください');
  try {
    await apiGet('deletePhoto', { fileId });
    await loadPhotoMgmtList();
    hideProc();
    toast('削除しました', 's');
  } catch(e) {
    hideProc();
    toast('削除に失敗しました: ' + e.message, 'e');
  }
}


// ============================================================
// 立ち位置マスタ
// ============================================================
// 権限は「区域係での立ち位置」から決まる。立ち位置ごとに何ができるかを
// ここで決め、メンバー編集では立ち位置を選ぶだけで済むようにする。
// 立ち位置と実情がずれる人は、メンバー編集の個別設定で上書きする
let _posEdit = [];   // 編集中の立ち位置一覧（保存するまで DB には書かない）

const POS_CAPS = [
  { key: 'canAdmin',           label: '管理者' },
  { key: 'canAccountant',      label: '会計者' },
  { key: 'canApproveCalendar', label: '予定表承認' },
  { key: 'canApproveShift',    label: 'シフト確認' },
];

async function openPositionModal() {
  openM('m-position');
  const body = document.getElementById('m-position-body');
  body.innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  document.getElementById('m-position-ft').innerHTML = '';
  try {
    const res = await apiGet('getPositions');
    if (!res.ok) throw new Error(res.error || '取得失敗');
    _positions = res.positions || [];
    _posEdit = JSON.parse(JSON.stringify(_positions));
    renderPositionEditor();
  } catch (e) {
    body.innerHTML = '<div style="padding:20px;color:var(--red);">エラー: ' + esc(e.message) + '</div>';
  }
}

function renderPositionEditor() {
  document.getElementById('m-position-body').innerHTML = `
    <div style="font-size:11px;color:var(--ink3);line-height:1.6;margin-bottom:10px;">
      立ち位置ごとに「何ができるか」を決めます。メンバーの権限はここで決めた内容から自動で決まります。<br>
      ※「予定表承認」「シフト確認」は管理者権限が前提です（管理者でない立ち位置に付けても効きません）。
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${_posEdit.map((p, i) => `
        <div style="border:1px solid var(--border);border-radius:var(--r);padding:10px;">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
            <input class="mf-inp" style="flex:1;" type="text" value="${esc(p.name || '')}"
              placeholder="立ち位置の名前" oninput="_posEdit[${i}].name=this.value">
            <button class="btn" style="font-size:11px;padding:5px 10px;border-color:var(--red);background:var(--red-l);color:var(--red);"
              onclick="removePositionRow(${i})">🗑</button>
          </div>
          <div class="uic-row">
            ${POS_CAPS.map(c => `<button type="button" class="uic${p[c.key] ? ' on' : ''}"
              onclick="togglePosCap(${i},'${c.key}',this)">${c.label}</button>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <button class="sp-add-btn" style="margin-top:10px;" onclick="addPositionRow()">&#65291; 立ち位置を追加</button>`;

  document.getElementById('m-position-ft').innerHTML = `
    <button class="btn btn-g" onclick="openPositionSyncPreview()" title="個別設定を外して、全員の権限を立ち位置から決め直します">⚖ 権限を立ち位置から再計算</button>
    <button class="btn btn-g" onclick="closeM('m-position')">閉じる</button>
    <button class="btn btn-p" onclick="savePositions()">保存</button>`;
}

function togglePosCap(i, key, el) {
  _posEdit[i][key] = !_posEdit[i][key];
  el.classList.toggle('on');
}
function addPositionRow() {
  _posEdit.push({ id: null, name: '', canAdmin: false, canAccountant: false, canApproveCalendar: false, canApproveShift: false });
  renderPositionEditor();
}
async function removePositionRow(i) {
  const p = _posEdit[i];
  // 既に保存されている立ち位置を消すと、その立ち位置だった人は「立ち位置なし」に戻り、
  // 個別設定が無ければ権限を失う。消す前にそれを伝える
  if (p.id && !await uiConfirm({
    type: 'danger', title: '立ち位置の削除',
    message: '「' + (p.name || '') + '」を削除しますか？\n\nこの立ち位置だった方は「立ち位置なし」に戻り、個別設定が無ければ権限が外れます。',
    confirmText: '削除する',
  })) return;
  _posEdit.splice(i, 1);
  renderPositionEditor();
}

async function savePositions() {
  showProc('立ち位置を保存しています...', '権限を計算し直しています');
  try {
    const res = await apiGet('savePositions', { positions: _posEdit });
    if (!res.ok) throw new Error(res.error || '保存失敗');
    const re = await apiGet('getPositions');
    _positions = (re && re.ok) ? (re.positions || []) : [];
    _posEdit = JSON.parse(JSON.stringify(_positions));
    renderPositionEditor();
    hideProc();
    toast('立ち位置を保存しました', 's');
  } catch (e) {
    hideProc();
    toast('保存に失敗しました: ' + e.message, 'e');
  }
}

// ------------------------------------------------------------
// 個別設定を落として立ち位置由来へ一本化する（移行用の一括切替）
// 取り返しがつかないので、誰がどう変わるかを見せてから実行する
// ------------------------------------------------------------
async function openPositionSyncPreview() {
  showProc('変更内容を確認しています...', '少々お待ちください');
  let changes;
  try {
    const res = await apiGet('previewPositionSync');
    if (!res.ok) throw new Error(res.error || '取得失敗');
    changes = res.changes || [];
    hideProc();
  } catch (e) {
    hideProc();
    toast('確認に失敗しました: ' + e.message, 'e');
    return;
  }

  const lost = changes.filter(c => c.diff.some(d => !d.to));
  const body = changes.length === 0
    ? '現在の権限は、すでに立ち位置どおりです。個別設定を外しても変わりません。'
    : changes.map(c => c.name + '（' + c.position + '）：' +
        c.diff.map(d => d.cap + (d.to ? ' を付与' : ' を解除')).join('、')).join('\n');

  if (!await uiConfirm({
    type: lost.length ? 'danger' : 'warn',
    title: '権限を立ち位置から再計算',
    message: '全員の個別設定を外し、権限を立ち位置だけで決め直します。\n\n' +
      (changes.length ? '【変わる人】\n' + body : body) +
      (lost.length ? '\n\n⚠️ 権限が外れる方がいます。立ち位置の割り当てが済んでいるか確認してください。' : ''),
    confirmText: '再計算する',
  })) return;

  showProc('権限を計算し直しています...', '少々お待ちください');
  try {
    const res = await apiGet('applyPositionSync');
    if (!res.ok) throw new Error(res.error || '実行失敗');
    hideProc();
    toast('権限を立ち位置から再計算しました', 's');
  } catch (e) {
    hideProc();
    toast('実行に失敗しました: ' + e.message, 'e');
  }
}

// ============================================================
// メンバー管理モーダル
// ============================================================
let _memberList = [];
let _memberEditRowIndex = null; // 編集中のrowIndex
let _positions = [];            // 立ち位置マスタ（メンバー編集の選択肢に使う）

const positionName = id => _positions.find(p => String(p.id) === String(id))?.name || '';

// 一覧の権限バッジ。
//
// 権限は立ち位置から決まるので、立ち位置バッジと権限バッジを両方並べると
// 同じことを二度言うことになり、1人あたりのバッジが増えすぎる。
// ここでは立ち位置から予測される状態と食い違う人だけを出す：
//   ＋管理者 … 立ち位置には無いのに持っている（個別付与、または立ち位置なしの管理者）
//   −管理者 … 立ち位置には有るのに外されている
// 立ち位置どおりの人はバッジが出ないので、例外の人だけが目に留まる
function capDiffBadges(m) {
  const pos = _positions.find(p => String(p.id) === String(m.positionId));
  const posAdmin = !!pos?.canAdmin;
  return CAP_DEFS.map(c => {
    // 承認系は管理者権限が前提（サーバーの resolveCaps と同じ扱い）
    const expected = c.key.startsWith('approve') ? (posAdmin && !!pos?.[c.pos]) : !!pos?.[c.pos];
    const actual   = !!m[c.cur];
    if (actual === expected) return '';
    return actual
      ? `<span class="role-badge ${c.cls}">＋${c.label}</span>`
      : `<span class="role-badge rb-off">−${c.label}</span>`;
  }).join('');
}

async function openMemberModal() {
  openM('m-member');
  document.getElementById('m-member-body').innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink3);">読み込み中...</div>';
  setVisible(document.getElementById('m-member-add-btn'), true);
  try {
    const [res, posRes] = await Promise.all([apiGet('getMemberListAll'), apiGet('getPositions'), loadAvatars()]);
    if (!res.ok) throw new Error(res.error || '取得失敗');
    _memberList = res.members || [];
    _positions  = (posRes && posRes.ok) ? (posRes.positions || []) : [];
    renderMemberList();
  } catch(e) {
    document.getElementById('m-member-body').innerHTML = '<div style="padding:20px;color:var(--red);">エラー: ' + esc(e.message) + '</div>';
  }
}

// ============================================================
// メンバーのアイコン
//
// 一覧に出すだけで、管理者が差し替えることはしない（本人が設定するもの）。
// 不適切な画像が設定されていないかを見て回れるようにするのが目的。
// 未設定の人が必ずいるので、無いときは頭文字の丸で埋める
// ============================================================
let _avatars = {};

async function loadAvatars() {
  try {
    const res = await apiGet('getAvatars');
    if (res.ok) _avatars = res.avatars || {};
  } catch (_) { /* アイコンは無くても困らないので握りつぶす */ }
}

function avatarHtml(uid, name, px) {
  const size = px || 26;
  const img  = uid ? _avatars[uid] : '';
  const st   = `width:${size}px;height:${size}px;`;
  if (img) return `<img class="mav" src="${escHtml(img)}" alt="" style="${st}">`;
  const ch = (name || '?').trim().charAt(0);
  return `<span class="mav mav-none" style="${st}font-size:${Math.round(size * 0.45)}px;">${esc(ch)}</span>`;
}

function renderMemberList() {
  _memberEditRowIndex = null;
  setVisible(document.getElementById('m-member-add-btn'), true);
  const valid   = _memberList.filter(m => m.valid);
  const invalid = _memberList.filter(m => !m.valid);

  let html = '<div style="padding:12px 14px 0;font-size:11px;color:var(--ink3);">計 ' + _memberList.length + ' 名（有効 ' + valid.length + ' 名 / 無効 ' + invalid.length + ' 名）</div>';

  const renderSection = (list, label, labelColor) => {
    if (!list.length) return '';
    let s = '<div style="padding:8px 14px 4px;font-size:11px;font-weight:700;color:' + labelColor + ';">' + label + '</div>';
    list.forEach(m => {
      s += `
      <div class="member-row" data-row="${m.rowIndex}">
        <div class="member-info">
          ${avatarHtml(m.uid, m.name)}
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-kana">${esc(m.furigana)}</span>
          <span class="member-gender-badge ${m.gender === 'M' ? 'mgb-m' : 'mgb-f'}">${m.gender === 'M' ? '男' : '女'}</span>
          ${m.isResponsible ? '<span class="role-badge rb-resp">責任者</span>' : ''}
          ${m.isCart        ? `<span class="role-badge rb-cart">カート${(m.cartCapacity ?? 2)}台</span>` : ''}
          ${positionName(m.positionId) ? '<span class="role-badge rb-pos">' + esc(positionName(m.positionId)) + '</span>' : ''}
          ${capDiffBadges(m)}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-edit-member" onclick="openMemberEditForm(${m.rowIndex})">編集</button>
          <button class="btn-delete-member" onclick="confirmDeleteMember(${m.rowIndex})">削除</button>
        </div>
      </div>`;
    });
    return s;
  };

  html += renderSection(valid, '✅ 有効メンバー', 'var(--green)');
  html += renderSection(invalid, '⛔ 無効メンバー', 'var(--ink3)');
  document.getElementById('m-member-body').innerHTML = html;
}

function openMemberAddForm() {
  _memberEditRowIndex = null;
  setVisible(document.getElementById('m-member-add-btn'), false);
  const isOwner = !_currentUser?.uid; // uidが空＝オーナーアカウント
  _mfMember = null; _mfIsOwner = isOwner;
  document.getElementById('m-member-body').innerHTML = buildMemberForm(null, isOwner);
  renderMfPermRows();
}

function openMemberEditForm(rowIndex) {
  _memberEditRowIndex = rowIndex;
  setVisible(document.getElementById('m-member-add-btn'), false);
  const m = _memberList.find(x => x.rowIndex === rowIndex);
  if (!m) return;
  const isOwner = !_currentUser?.uid;
  _mfMember = m; _mfIsOwner = isOwner;
  document.getElementById('m-member-body').innerHTML = buildMemberForm(m, isOwner);
  renderMfPermRows();
}

// ------------------------------------------------------------
// 権限は立ち位置から決まり、能力ごとに個別設定で上書きできる。
// 個別設定は3状態：'' 立ち位置に従う ／ '1' 個別に付与 ／ '0' 個別に外す。
// 「立ち位置に従う」を選んだとき実際にどうなるかは立ち位置を変えると変わるので、
// 選択肢のラベルに現在の立ち位置での結果（付与／なし）を添えて、
// 立ち位置チップを押すたびに描き直す
// ------------------------------------------------------------
// cur＝実際に効いている権限のプロパティ名、cls＝一覧のバッジの色
const CAP_DEFS = [
  { key: 'admin',           label: '管理者',     pos: 'canAdmin',           mk: 'ovAdmin',            cur: 'isAdmin',         cls: 'rb-admin' },
  { key: 'accountant',      label: '会計者',     pos: 'canAccountant',      mk: 'ovAccountant',       cur: 'isAccountant',    cls: 'rb-acct'  },
  { key: 'approveCalendar', label: '予定表承認', pos: 'canApproveCalendar', mk: 'ovApproveCalendar',  cur: 'isCalApprover',   cls: 'rb-appr'  },
  { key: 'approveShift',    label: 'シフト確認', pos: 'canApproveShift',    mk: 'ovApproveShift',     cur: 'isShiftApprover', cls: 'rb-appr'  },
];
let _mfMember  = null;   // 編集中のメンバー（権限行を描き直すときに参照する）
let _mfIsOwner = false;

const ovStr = v => v === true ? '1' : v === false ? '0' : '';

function renderMfPermRows() {
  const el = document.getElementById('mf-perm-rows');
  if (!el) return;
  const pos = _positions.find(p => String(p.id) === uiChipVal('mf-pos'));
  // 描き直しても選択中の個別設定を失わないよう、いま画面にある値を先に読む
  // （まだ描かれていない初回は、保存されている値を使う）
  el.innerHTML = CAP_DEFS.map(c => {
    const cur = document.querySelector(`[data-group="mf-ov-${c.key}"].on`)?.dataset.val
             ?? ovStr(_mfMember?.[c.mk]);
    return `<div class="mf-perm">
      <span class="mf-perm-l">${c.label}</span>
      ${uiPickChips('mf-ov-' + c.key, [
        { value: '',  label: '立ち位置に従う（' + (pos?.[c.pos] ? '付与' : 'なし') + '）' },
        { value: '1', label: '付与' },
        { value: '0', label: '外す' },
      ], cur, !_mfIsOwner)}
    </div>`;
  }).join('');
}

function buildMemberForm(m, isOwner) {
  const isEdit = !!m;
  const emailReadonly = isEdit && !isOwner;
  // 編集のときだけアイコンを大きく出す。追加のときはまだ本人が存在しない。
  // 差し替えはできない（本人がフォームアプリで設定するもの）ので、その旨を添える
  const avBlock = isEdit ? `
    <div class="mf-av">
      ${avatarHtml(m.uid, m.name, 96)}
      <div class="mf-av-tx">
        <div class="mf-av-n">${esc(m.name || '')}</div>
        <div class="mf-av-d">${_avatars[m.uid]
          ? 'アイコンは本人がフォームアプリで設定します'
          : 'アイコンは表示されません（本人が未設定、または非表示の設定です）'}</div>
      </div>
    </div>` : '';

  return `
  <div style="padding:14px 16px;">
    <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:14px;">${isEdit ? '✏️ メンバー編集' : '➕ メンバー追加'}</div>
    ${avBlock}
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div class="mf-row">
        <label class="mf-lbl">名前 <span class="req">*</span></label>
        <input id="mf-name" class="mf-inp" type="text" value="${esc(m?.name || '')}" placeholder="例：山田 太郎">
      </div>
      <div class="mf-row">
        <label class="mf-lbl">フリガナ <span class="req">*</span></label>
        <input id="mf-furigana" class="mf-inp" type="text" value="${esc(m?.furigana || '')}" placeholder="例：ヤマダ タロウ">
      </div>
      <div class="mf-row">
        <label class="mf-lbl">性別 <span class="req">*</span></label>
        ${uiPickChips('mf-gender',
          [{ value: 'M', label: '男' }, { value: 'F', label: '女' }],
          (!m || m.gender === 'M') ? 'M' : 'F')}
      </div>
      <div class="mf-row">
        <label class="mf-lbl">メールアドレス
          ${emailReadonly ? '<span style="font-size:10px;color:var(--ink3);font-weight:400;margin-left:4px;">（オーナーアカウントのみ変更可）</span>' : ''}
        </label>
        ${emailReadonly
          ? `<div style="padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);font-size:13px;color:var(--ink2);">${esc(m?.email || '（未設定）')}</div>`
          : `<input id="mf-email" class="mf-inp" type="email" value="${esc(m?.email || '')}" placeholder="例：taro@example.com（任意）">`
        }
      </div>
      <div class="mf-row">
        <label class="mf-lbl">役割</label>
        <div class="uic-row">
          ${uiCheckChip('mf-resp', '責任者', !!m?.isResponsible)}
        </div>
      </div>
      <div class="mf-row">
        <label class="mf-lbl">カートを運べる台数
          <span style="font-size:10px;color:var(--ink3);font-weight:400;margin-left:4px;">（1つの場所に2台。持ち込み・持ち帰りの担当を決めるのに使います）</span>
        </label>
        ${uiPickChips('mf-cartcap',
          [{ value: '0', label: '運ばない' }, { value: '2', label: '2台' }, { value: '4', label: '4台' }],
          String(m?.cartCapacity ?? (m?.isCart ? 2 : 0)))}
      </div>
      <div class="mf-row">
        <label class="mf-lbl">立ち位置
          ${!isOwner ? '<span style="font-size:10px;color:var(--ink3);font-weight:400;margin-left:4px;">（オーナーアカウントのみ変更可）</span>' : ''}
        </label>
        ${uiPickChips('mf-pos',
          [{ value: '', label: 'なし' }].concat(_positions.map(p => ({ value: String(p.id), label: p.name }))),
          String(m?.positionId || ''), !isOwner, 'renderMfPermRows')}
      </div>
      <div class="mf-row">
        <label class="mf-lbl">権限</label>
        <div id="mf-perm-rows"></div>
        ${isOwner ? '<div style="font-size:11px;color:var(--ink3);line-height:1.6;">※ 権限は立ち位置から決まります。この人だけ扱いを変えたいときに「付与」「外す」で上書きしてください。<br>※ 権限は先に与えられますが、本人がログインできるのはメールアドレス登録後です。<br>※ 「予定表承認」「シフト確認」は管理者権限が前提です。</div>' : ''}
      </div>
      ${isEdit ? `
      <div class="mf-row">
        <label class="mf-lbl">ステータス</label>
        ${uiPickChips('mf-valid',
          [{ value: '1', label: '有効' }, { value: '0', label: '無効' }],
          m.valid ? '1' : '0')}
        ${m.valid ? '<div style="font-size:11px;color:var(--amber);line-height:1.6;">⚠️ 無効にすると、この方に関する代理送信設定・管理者権限・会計者権限は自動的に削除されます。</div>' : ''}
      </div>` : ''}
      <div id="mf-err" class="is-hidden" style="color:var(--red);font-size:12px;padding:6px 10px;background:var(--red-l);border-radius:var(--r);"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
      <button class="btn btn-g" onclick="renderMemberList()">キャンセル</button>
      <button class="btn btn-p" onclick="saveMemberForm(${isEdit}, ${isOwner})">保存</button>
    </div>
  </div>`;
}

async function saveMemberForm(isEdit, isOwner) {
  const name     = (document.getElementById('mf-name')?.value || '').trim();
  const furigana = (document.getElementById('mf-furigana')?.value || '').trim();
  const gender   = uiChipVal('mf-gender');
  const email    = (document.getElementById('mf-email')?.value || '').trim();
  const isResp   = uiChipOn('mf-resp');
  // カートは台数で持つ。旧来の isCart は「0より大きいか」としてサーバー側で同期する
  const cartCap  = uiChipVal('mf-cartcap') || '0';
  const isCart   = cartCap !== '0';
  // 立ち位置と、能力ごとの個別設定（'' 立ち位置に従う ／ '1' 付与 ／ '0' 外す）
  const perm = {
    positionId:        uiChipVal('mf-pos'),
    ovAdmin:           uiChipVal('mf-ov-admin'),
    ovAccountant:      uiChipVal('mf-ov-accountant'),
    ovApproveCalendar: uiChipVal('mf-ov-approveCalendar'),
    ovApproveShift:    uiChipVal('mf-ov-approveShift'),
  };
  const validVal = uiChipVal('mf-valid');
  // 追加フォームにはステータスの選択が無いので、その場合は有効として扱う
  const valid    = validVal ? validVal === '1' : true;

  const errEl = document.getElementById('mf-err');
  if (!name || !furigana || !gender) {
    setVisible(errEl, true);
    errEl.textContent = '名前・フリガナ・性別は必須です。';
    return;
  }
  setVisible(errEl, false);

  showProc(isEdit ? 'メンバー情報を更新しています...' : 'メンバーを追加しています...', '少々お待ちください');
  try {
    let res;
    if (isEdit) {
      res = await apiGet('updateMember', {
        rowIndex: _memberEditRowIndex,
        name, furigana, gender, email,
        isResponsible: isResp ? '1' : '',
        isCart: isCart ? '1' : '',
        cartCapacity: cartCap,
        ...perm,
        valid: valid ? '1' : '0'
      });
    } else {
      res = await apiGet('addMember', {
        name, furigana, gender, email,
        isResponsible: isResp ? '1' : '',
        isCart: isCart ? '1' : '',
        cartCapacity: cartCap,
        ...perm
      });
    }
    if (!res.ok) throw new Error(res.error || '保存失敗');
    // メンバー追加・更新後は限定PW用pickerの候補キャッシュを破棄する。
    // 次回表示時に名称・ふりがな・有効状態をサーバーから取り直す。
    _allMembersForPicker = [];
    // 一覧を再取得して再描画
    const listRes = await apiGet('getMemberListAll');
    if (listRes.ok) {
      _memberList = listRes.members || [];
      renderMemberList();
    }
    hideProc();
    toast(isEdit ? 'メンバー情報を更新しました' : 'メンバーを追加しました', 's');
  } catch(e) {
    hideProc();
    setVisible(errEl, true);
    errEl.textContent = 'エラー: ' + e.message;
  }
}

function closeMemberForm() {
  closeM('m-member');
}

async function confirmDeleteMember(rowIndex) {
  const m = _memberList.find(x => x.rowIndex === rowIndex);
  if (!m) return;
  if (!await uiConfirm({
    type: 'danger', title: 'メンバーの削除',
    message: `「${m.name}」を削除しますか？\n\nこの操作は元に戻せません。`,
    confirmText: '削除する',
  })) return;

  showProc('メンバーを削除しています...', '少々お待ちください');
  try {
    const res = await apiGet('deleteMember', { rowIndex });
    if (!res.ok) throw new Error(res.error || '削除失敗');
    _allMembersForPicker = [];
    const listRes = await apiGet('getMemberListAll');
    if (listRes.ok) {
      _memberList = listRes.members || [];
      renderMemberList();
    }
    hideProc();
    toast(`「${m.name}」を削除しました`, 's');
  } catch(e) {
    hideProc();
    toast('削除に失敗しました: ' + e.message, 'e');
  }
}

// ============================================================
// 処理中フルスクリーンオーバーレイ
// ============================================================
function showProc(title, sub) {
  document.getElementById('proc-title').textContent = title || '処理しています...';
  document.getElementById('proc-sub').textContent = sub !== undefined ? sub : '少々お待ちください';
  setVisible(document.getElementById('proc-spin'), true);
  setVisible(document.getElementById('proc-steps'), false);
  document.getElementById('proc-steps').innerHTML = '';
  setVisible(document.getElementById('proc-close-btn'), false);
  document.getElementById('proc-ov').classList.add('show');
}
function hideProc() {
  document.getElementById('proc-ov').classList.remove('show');
}
function setProcMsg(title, sub) {
  if (title !== undefined) document.getElementById('proc-title').textContent = title;
  if (sub !== undefined) document.getElementById('proc-sub').textContent = sub;
}
function showProcSteps(tasks) {
  const el = document.getElementById('proc-steps');
  el.innerHTML = tasks.map(t =>
    `<div class="proc-step-row"><span class="proc-step-ic" id="psic-${t.id}">⏸</span><span class="proc-step-lbl">${t.label}</span><span class="proc-step-st" id="psst-${t.id}">待機中</span></div>`
  ).join('');
  setVisible(el, true);
}
function setProcStep(id, state, errMsg) {
  const ic = document.getElementById('psic-' + id);
  const st = document.getElementById('psst-' + id);
  if (!ic || !st) return;
  if (state === 'running') { ic.textContent = '⏳'; st.textContent = '実行中...'; st.className = 'proc-step-st running'; }
  else if (state === 'done') { ic.textContent = '✅'; st.textContent = '完了'; st.className = 'proc-step-st done'; }
  else if (state === 'err') { ic.textContent = '❌'; st.textContent = errMsg || 'エラー'; st.className = 'proc-step-st err'; }
}
async function refreshAdminData() {
  return loadAdminData({ year: curY, month: curM, type: currentPwType, rethrow: true });
}

