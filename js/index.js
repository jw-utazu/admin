// ============================================================
// 設定
// ============================================================
// API_URL / ANON_KEY / CLIENT_ID は js/api.js（共有通信層）で定義
// ALLOWED配列は廃止（管理者一覧はサーバー側で判定）
const DOW7      = ['月','火','水','木','金','土','日'];
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
let scY   = curY, scM  = curM;            // 日程設定カレンダー月
let _currentUser = null;                   // ログイン中の管理者情報
let slotY = curY, slotM = curM;           // 実施日カレンダー月
let calY  = _initNow.getFullYear(), calM  = _initNow.getMonth() + 1;  // カレンダー表示月（限定PW専用）
let adminData   = null;
let adminPhases = [];  // 限定PWフェーズ一覧（getAdminData で取得）
let currentPhaseIndex = 0; // 現在編集中のフェーズ番号
let activeKind  = null;  // 'apply'|'deadline'|'open'|null
let dateEditMode = false;
let slotMode    = false;
let slots       = [];    // [{y,m,d,time,interval}]
let dates       = {apply:null, deadline:null, open:null};
let datesBak    = null;  // キャンセル用バックアップ
let popupDay    = null;
let popupTimes  = [];
let sheetListData = [];
let fcN         = 1;
let mappingResult = {};
let fcAdminData = null;  // フォーム作成時に取得したデータ

// ============================================================
// Google OAuth
// ============================================================
function signIn() {
  const tc = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: 'email profile openid',
    callback: r => {
      if (r.error) { showAuthErr('ログインに失敗しました。'); return; }
      fetchUser(r.access_token);
    }
  });
  // prompt: '' で前回アカウントを自動選択、初回は選択画面
  tc.requestAccessToken({ prompt: '' });
}

// 救済ログインのセッションで管理アプリに入る（Googleアカウントが使えない管理者向け）。
// 有効期限はサーバー側で検証される。shift-form と同一オリジンのため localStorage を共有できる
async function tryRecoveryLogin() {
  let token = '';
  try { token = localStorage.getItem('pwgws_recovery_session') || ''; } catch (_) {}
  if (!token) return false;
  try {
    const res = await apiPost({ action: 'validateRecoverySession', sessionToken: token });
    if (!res.ok || !res.isAdmin) return false;
    _currentUser = { uid: res.uid || '', name: res.name, email: '', isRecoverySession: true };
    document.getElementById('auth').style.display = 'none';
    document.getElementById('loading').classList.add('show');
    setLoadingStep(3, 'データを読み込み中...');
    const av = document.getElementById('av');
    av.textContent = ([...res.name || '?'][0] || '?').toUpperCase();
    const now = new Date();
    const _nm = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    curY = _nm.getFullYear(); curM = _nm.getMonth() + 1;
    scY = curY; scM = curM; slotY = curY; slotM = curM;
    calY = now.getFullYear(); calM = now.getMonth() + 1;
    loadAdminData();
    if (res.daysLeft <= 3) {
      setTimeout(() => alert('この一時ログインはあと ' + res.daysLeft + '日で終了します。\n' +
        'Googleアカウントの再設定、またはメールアドレスの変更を済ませてください。'), 1500);
    }
    return true;
  } catch (e) { return false; }
}

// 自動ログイン（救済セッション → One Tap → localStorageフォールバック）
async function tryAutoLogin() {
  // Googleアカウントが使えない管理者のための救済セッションを最優先で確認
  if (await tryRecoveryLogin()) return;

  // まずlocalStorageに保存済みユーザーがあれば即復元
  try {
    const saved = localStorage.getItem('adminUser');
    if (saved) {
      const u = JSON.parse(saved);
      if (u && u.email) {
        processUser(u, false); // 保存しなおさない
        return;
      }
    }
  } catch(e) { console.warn('[auto-login]', e); }

  // 共通ログイン画面でログイン済みなら引き継ぐ（管理者権限は processUser 内で
  // サーバーに問い合わせて確認するため、ここでは本人確認だけを引き継ぐ）
  const shared = pwgwsGetSession();
  if (shared) { processUser({ email: shared.email, name: shared.name, picture: shared.picture }); return; }

  // 未ログイン：共通ログイン画面へ送る。
  // ?direct=1 が付いている場合は従来のログイン画面を出す（緊急脱出口）
  if (pwgwsShouldRedirectToLogin()) { pwgwsGoToLogin(); return; }

  // One Tap（PCブラウザ向け）
  if (!window.google || !google.accounts) return;
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: r => {
      try {
        const p = JSON.parse(atob(r.credential.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        processUser({ email: p.email, name: p.name, picture: p.picture });
      } catch(e) { console.warn('[one-tap]', e); }
    },
    auto_select: true,
    cancel_on_tap_outside: false,
  });
  google.accounts.id.prompt();
}
setTimeout(tryAutoLogin, 800);
function fetchUser(token) {
  document.getElementById('auth').style.display = 'none';
  document.getElementById('loading').classList.add('show');
  setLoadingStep(1, 'Googleアカウントを確認中...');
  fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => r.json()).then(u => processUser({ email: u.email, name: u.name, picture: u.picture }))
    .catch(() => showAuthErr('ユーザー情報の取得に失敗しました。'));
}
function processUser(u, save = true) {
  _processUserWithGasAuth(u, save);
}
async function _processUserWithGasAuth(u, save) {
  if (!document.getElementById('loading').classList.contains('show')) {
    document.getElementById('auth').style.display = 'none';
    document.getElementById('loading').classList.add('show');
  }
  setLoadingStep(2, '管理者権限を確認中...');
  try {
    // fetch方式（リダイレクト追従対応・Android Chrome対応）
    const url = API_URL + '?action=auth&source=admin&email=' + encodeURIComponent(u.email);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'Authorization': 'Bearer ' + ANON_KEY } })
      .then(r => { clearTimeout(timer); return r.json(); })
      .catch(err => {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('タイムアウト');
        throw new Error('通信エラー');
      });
    if (!res.ok) { showAuthErr('このアカウントはアクセスが許可されていません。'); return; }
    if (!res.isAdmin) { showAuthErr('このアカウントには管理者権限がありません。'); return; }
    // ログインユーザー情報を保持（uid空＝オーナーアカウント）
    _currentUser = { uid: res.uid || '', name: u.name, email: u.email };
  } catch(e) { showAuthErr('認証に失敗しました: ' + e.message); return; }
  // ログイン情報をlocalStorageに保存（次回自動ログイン用）
  if (save) {
    try { localStorage.setItem('adminUser', JSON.stringify({ email: u.email, name: u.name, picture: u.picture, isAdmin: true })); } catch(e) {}
    // 他の2アプリでもログイン済みとして扱えるよう共通セッションにも保存する
    pwgwsSaveSession(u.email, u.name, u.picture);
  }
  const av = document.getElementById('av');
  if (u.picture) {
    const img = document.createElement('img');
    img.src = u.picture;
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
  scY = curY; scM = curM;
  slotY = curY; slotM = curM;
  calY = now.getFullYear(); calM = now.getMonth() + 1;
  setLoadingStep(3, 'データを読み込み中...');
  loadAdminData();
}
function signOut() {
  try { localStorage.removeItem('adminUser'); } catch(e) {}
  // 共通セッション・救済ログインも併せて破棄する（3アプリ共通のログアウト）
  pwgwsClearSession();
  google.accounts.id.disableAutoSelect();
  // ログアウト後は共通ログイン画面へ戻す。
  // 共通ログイン画面が使えない場合は従来どおりこのアプリのログイン画面を表示する
  if (pwgwsShouldRedirectToLogin()) { pwgwsGoToLogin(); return; }
  document.getElementById('app').style.display  = 'none';
  document.getElementById('auth').style.display = 'flex';
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
function showAuthErr(msg) {
  document.getElementById('loading').classList.remove('show');
  document.getElementById('auth').style.display = 'flex';
  const el = document.getElementById('auth-err');
  el.textContent = msg;
  el.classList.add('show');
}

// apiGet は js/api.js（共有通信層）で定義

// ============================================================
// データ読み込み
// ============================================================
async function loadAdminData() {
  updYmTitle();
  apiGet('setupTriggers').catch(() => {});
  let d;
  try {
    d = await apiGet('adminData', { year: curY, month: curM });
  } catch(e) {
    // エラー時はローディングを閉じて認証画面に戻す
    document.getElementById('loading').classList.remove('show');
    document.getElementById('auth').style.display = 'flex';
    showAuthErr('データの読み込みに失敗しました: ' + e.message);
    return;
  }
  adminData = d;
  // サーバーから対象月の年月を取得（ただしUI上の対象月はcurY/curMを使う）
  // slots・datesはサーバーから読み取る
  if (d.eventDates) {
    const toObj = str => {
      if (!str) return null;
      const p = str.split('/');
      return p.length===2 ? {y:curY, m:parseInt(p[0]), d:parseInt(p[1])} : null;
    };
    dates.apply    = toObj(d.eventDates['申込開始']);
    dates.deadline = toObj(d.eventDates['締切']);
    dates.open     = toObj(d.eventDates['シフト公開']);
  }
  if (d.currentSlots) {
    slots = d.currentSlots.map(s=>({y:s.y||curY,m:s.m||curM,d:s.d,time:s.time,interval:parseInt(s.interval)||15}));
  }
  if (d.limitedSlots) {
    limitedSlots = d.limitedSlots;
  }
  if (d.phases) {
    adminPhases = d.phases;
    currentPhaseIndex = 0;
    if (currentPwType !== 'normal') syncSlotsFromPhases();
  }
  renderPwTypeTabs();
  renderAll();
  loadCalPubStatus();
  loadAutoPublishSettings();
  // 描画完了後にローディングを非表示・appを表示
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById('ld-bar').style.width = '100%';
      setTimeout(() => {
        document.getElementById('loading').classList.remove('show');
        document.getElementById('app').style.display = 'flex';
      }, 400);
    });
  });
}

function renderAll() {
  const isLimited = currentPwType !== 'normal';
  // 年月ナビは限定PWでは不要なため非表示
  const nav = document.getElementById('cal-ym-nav');
  if (nav) nav.style.visibility = isLimited ? 'hidden' : 'visible';
  const slotsArea = document.getElementById('info-slots-card');
  if (slotsArea) slotsArea.style.display = isLimited ? 'none' : '';
  const datesArea = document.getElementById('info-dates-card');
  if (datesArea) datesArea.style.display = isLimited ? 'none' : '';
  // 限定PWでもカレンダーエリアを表示
  const calArea = document.getElementById('cal-scroll-area');
  if (calArea) calArea.style.display = '';
  // cal-view-nav は限定PWのみ表示（通常PWは前月+管理月の2ヶ月固定のため不要）
  const calViewNavBar = document.getElementById('cal-view-nav-bar');
  if (calViewNavBar) calViewNavBar.style.display = isLimited ? '' : 'none';
  updYmTitle();
  updStatus();
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
  updCalPubBadge();
}
function updCalViewLabel() {
  const el = document.getElementById('cal-view-label');
  if(el) el.textContent = calY+'年'+calM+'月';
}
function toggleYmDropdown() {
  const dd = document.getElementById('ym-dropdown');
  if (!dd.classList.contains('open')) {
    // セレクト初期化
    const yr = document.getElementById('ym-year');
    const mo = document.getElementById('ym-month');
    yr.innerHTML=''; mo.innerHTML='';
    for(let y=curY-2;y<=curY+3;y++) yr.innerHTML+=`<option value="${y}"${y===curY?' selected':''}>${y}年</option>`;
    for(let m=1;m<=12;m++) mo.innerHTML+=`<option value="${m}"${m===curM?' selected':''}>${m}月</option>`;
    dd.classList.add('open');
  } else {
    dd.classList.remove('open');
  }
}
function applyYmChange() {
  curY = parseInt(document.getElementById('ym-year').value);
  curM = parseInt(document.getElementById('ym-month').value);
  scY=curY; scM=curM; slotY=curY; slotM=curM;
  document.getElementById('ym-dropdown').classList.remove('open');
  loadAdminData();
}

// ============================================================
// 受付状況
// ============================================================
function updStatus() {
  const badge = document.getElementById('status-badge');
  const dot   = document.getElementById('status-dot');
  const txt   = document.getElementById('status-text');
  const s     = calcStatus();
  badge.className = 'status-badge ' + (s==='受付中'?'sb-open':s==='受付終了'?'sb-end':'sb-prep');
  dot.className   = 'sb-dot '       + (s==='受付中'?'sb-dot-open':s==='受付終了'?'sb-dot-end':'sb-dot-prep');
  txt.textContent = s;
}
function calcStatus() {
  const today = new Date(); today.setHours(0,0,0,0);
  const t = today.getTime();
  const toDate = obj => obj ? new Date(obj.y,obj.m-1,obj.d).getTime() : null;
  const ap = toDate(dates.apply), dl = toDate(dates.deadline);
  const nextM = new Date(curM===12?curY+1:curY, curM===12?0:curM, 1).getTime();
  if (!ap || t < ap) return '準備中';
  if (t >= nextM) return '準備中';
  if (ap && dl && t >= ap && t <= dl) return '受付中';
  if (dl && t > dl) return '受付終了';
  return '準備中';
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
  curM += dir;
  if (curM > 12) { curM = 1; curY++; }
  if (curM < 1)  { curM = 12; curY--; }
  scY = curY; scM = curM;
  slotY = curY; slotM = curM;
  // 通常PW: ローディングオーバーレイを出してデータ再取得
  const isLimited = currentPwType !== 'normal';
  if (!isLimited) {
    const ov = document.getElementById('tab-switch-ov');
    const txtEl = document.getElementById('tab-sw-text');
    if (txtEl) txtEl.textContent = curY + '年' + curM + '月のデータを読み込み中...';
    if (ov) ov.classList.add('show');
    loadAdminDataWithOverlay().finally(() => {
      if (ov) ov.classList.remove('show');
    });
  } else {
    calY = curY; calM = curM;
    updYmTitle();
    buildCalScroll();
    buildInfoArea();
  }
}
function chCalM(dir) {
  calM += dir;
  if (calM > 12) { calM = 1; calY++; }
  if (calM < 1)  { calM = 12; calY--; }
  buildCalScroll();
}

async function loadAdminDataWithOverlay() {
  updYmTitle();
  apiGet('setupTriggers').catch(() => {});
  let d;
  try {
    d = await apiGet('adminData', { year: curY, month: curM });
  } catch(e) {
    toast('データの読み込みに失敗しました: ' + e.message, 'e');
    return;
  }
  adminData = d;
  if (d.eventDates) {
    const toObj = str => {
      if (!str) return null;
      const p = str.split('/');
      return p.length===2 ? {y:curY, m:parseInt(p[0]), d:parseInt(p[1])} : null;
    };
    dates.apply    = toObj(d.eventDates['申込開始']);
    dates.deadline = toObj(d.eventDates['締切']);
    dates.open     = toObj(d.eventDates['シフト公開']);
  } else {
    dates.apply = dates.deadline = dates.open = null;
  }
  if (d.currentSlots) {
    slots = d.currentSlots.map(s=>({y:s.y||curY,m:s.m||curM,d:s.d,time:s.time,interval:parseInt(s.interval)||15}));
  } else {
    slots = [];
  }
  if (d.phases) {
    adminPhases = d.phases;
    currentPhaseIndex = 0;
    if (currentPwType !== 'normal') syncSlotsFromPhases();
  }
  renderAll();
  loadCalPubStatus();
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
    if(mode==='sched') cls+=' date-mode';
    if(mode==='slot'&&slotMode) cls+=' slm';
    if(mode==='slot'&&hasSlot) cls+=' slot-picked';
    // 日程設定モード中のハイライト
    if(mode==='sched'&&isApply&&dateEditMode) cls+=' sel-apply';
    if(mode==='sched'&&isDL&&dateEditMode) cls+=' sel-deadline';
    if(mode==='sched'&&isOpen&&dateEditMode) cls+=' sel-open';
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
    if(mode==='sched'&&dateEditMode) oc=`onclick="onScClick(${y},${m},${d})"`;
    if(mode==='slot'&&slotMode) oc=`onclick="onSlotClick(${y},${m},${d},this)"`;
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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// esc は escHtml の別名（旧実装同様 null/undefined/0/false/'' は '' として扱う）
function esc(s) { return escHtml(s || ''); }

function renderPwTypeTabs() {
  const bar = document.getElementById('pw-type-bar');
  if (!bar) return;
  const isNormal = currentPwType === 'normal';
  let html = `<button class="pw-type-tab pw-tab-first${isNormal ? ' active normal-tab' : ''}" onclick="switchPwType('normal')">通常PW</button>`;

  limitedSlots.forEach((slot, idx) => {
    const isActive = currentPwType === slot.id;
    html += `<button class="pw-type-tab${isActive ? ' active' : ''}" onclick="switchPwType('${escHtml(slot.id)}')">${escHtml(slot.name)}<span class="lt-edit-ic" onclick="openEditLimitedSlotModal('${escHtml(slot.id)}');event.stopPropagation()">✏</span></button>`;
  });

  html += `<button class="pw-type-tab pw-tab-add" onclick="openAddLimitedSlotModal()">＋</button>`;
  bar.innerHTML = html;

  // 限定PW 対象メンバー管理ボタンの表示切り替え
  const btnLm = document.getElementById('btn-limited-members');
  if (btnLm) btnLm.style.display = currentPwType !== 'normal' ? '' : 'none';

  // 通常PW専用ボタン（メンバー管理・お知らせ・要望・バグ報告・代理・夫婦）の表示切り替え
  document.querySelectorAll('.abtn.normal-only').forEach(b => {
    b.style.display = currentPwType === 'normal' ? '' : 'none';
  });

  // シフト管理アプリへのリンクに現在のPWタイプを引き継ぐ
  const btnSc = document.getElementById('btn-shift-create');
  if (btnSc) btnSc.href = './shift-create.html' + (currentPwType !== 'normal' ? '?type=' + encodeURIComponent(currentPwType) : '');
}

// ============================================================
// PW モード切り替え
// ============================================================
async function switchPwType(type) {
  if (currentPwType === type) return;

  // 年月ドロップダウンは通常PWのみ表示
  const ymDd = document.getElementById('ym-dropdown');
  if (ymDd) {
    ymDd.classList.remove('open');
    ymDd.style.display = type !== 'normal' ? 'none' : '';
  }

  // ローディングオーバーレイを表示し、タブを全て無効化
  const ov = document.getElementById('tab-switch-ov');
  const txtEl = document.getElementById('tab-sw-text');
  const label = type === 'normal' ? '通常PW' : (limitedSlots.find(s => s.id === type)?.name || '限定PW');
  if (txtEl) txtEl.textContent = `${label} のデータを読み込み中...`;
  if (ov) ov.classList.add('show');
  document.querySelectorAll('#pw-type-bar .pw-type-tab').forEach(btn => btn.disabled = true);

  // currentPwType を更新（apiGet の type パラメータに使用）
  const prevType = currentPwType;
  currentPwType = type;
  currentPhaseIndex = 0;

  try {
    // データ取得完了後に画面を切り替える（loadAdminData 内で renderPwTypeTabs/renderAll が呼ばれる）
    await loadAdminData();
    const slotName = limitedSlots.find(s => s.id === type);
    toast(type === 'normal' ? '通常PWモードに切り替えました' : `${slotName ? slotName.name : '限定PW'}モードに切り替えました`, 's');
  } catch (e) {
    currentPwType = prevType;
    renderPwTypeTabs();
    toast('データ読み込みエラー: ' + e.message, 'e');
  } finally {
    if (ov) ov.classList.remove('show');
    // renderPwTypeTabs で再描画されるが、エラー時のために念のため解除
    document.querySelectorAll('#pw-type-bar .pw-type-tab').forEach(btn => btn.disabled = false);
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
    listEl.innerHTML = _limitedMembersCache.map(m =>
      `<div class="lm-row">
        <span class="lm-uid">${m.uid}</span>
        <span class="lm-name">${m.name}</span>
        <span class="lm-date">${m.addedAt}</span>
        <button class="lm-del" onclick="removeLimitedMember('${m.uid}')">削除</button>
      </div>`
    ).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="padding:16px;color:var(--red);font-size:12px;">エラー: ${e.message}</div>`;
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
  if (!confirm(`UID: ${uid} を対象メンバーから削除しますか？`)) return;
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
  if (!confirm('全メンバーを削除します。よろしいですか？\n（期間終了時に使用してください）')) return;
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
    pickerEl.innerHTML = `<div style="padding:10px;color:var(--red);font-size:12px;">エラー: ${e.message}</div>`;
  }
}

function filterAddSlotPicker() {
  const q = document.getElementById('add-slot-member-search').value.trim();
  const filtered = q ? _allMembersForPicker.filter(m => m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q)) : _allMembersForPicker;
  renderAddSlotPicker(filtered);
}

function renderAddSlotPicker(members) {
  const html = members.map(m => {
    const selected = _addSlotSelectedMembers.has(m.uid);
    return `<div class="lm-row">
      <span class="lm-uid">${m.uid}</span>
      <span class="lm-name">${m.name}</span>
      ${selected
        ? `<button class="lm-del" onclick="toggleAddSlotMember('${m.uid}','${m.name.replace(/'/g,"\\'")}')">解除</button>`
        : `<button class="btn btn-p" style="padding:2px 8px;font-size:11px;" onclick="toggleAddSlotMember('${m.uid}','${m.name.replace(/'/g,"\\'")}')">追加</button>`
      }
    </div>`;
  }).join('') || '<div style="padding:10px;color:var(--ink3);font-size:13px;">該当なし</div>';
  document.getElementById('add-slot-picker-list').innerHTML = html;
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
  document.getElementById('edit-slot-delete-btn').style.display = '';
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

  let msg;
  if (deleteSheets) {
    msg = `「${slotName}」を削除しますか？\n\nメンバーまたはカレンダーのデータが未入力のため、\n関連するシートもすべて削除されます。\n\nこの操作は取り消せません。`;
  } else {
    msg = `「${slotName}」を削除しますか？\n（スプレッドシートのシートとデータは保持されます）`;
  }
  if (!confirm(msg)) return;

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
    pickerEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px;">エラー: ${e.message}</div>`;
  }
}

function filterLimitedPicker() {
  const q = document.getElementById('lm-search').value.trim();
  const filtered = q ? _allMembersForPicker.filter(m => m.name.includes(q) || (m.furigana||'').includes(q) || m.uid.includes(q)) : _allMembersForPicker;
  renderLimitedPicker(filtered);
}

function renderLimitedPicker(members) {
  const existingUids = new Set((_limitedMembersCache||[]).map(m => m.uid));
  const html = members.map(m => {
    const already = existingUids.has(m.uid);
    return `<div class="lm-row">
      <span class="lm-uid">${m.uid}</span>
      <span class="lm-name">${m.name}</span>
      ${already
        ? '<span style="font-size:11px;color:var(--ink3);">登録済</span>'
        : `<button class="btn btn-p" style="padding:2px 8px;font-size:11px;" onclick="addLimitedMember('${m.uid}','${m.name.replace(/'/g,"\\'")}')">追加</button>`
      }
    </div>`;
  }).join('') || '<div style="padding:12px;color:var(--ink3);font-size:13px;">該当なし</div>';
  document.getElementById('lm-picker-list').innerHTML = html;
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
  document.getElementById('m-day-reset-btn').style.display = hasAny ? 'inline-flex' : 'none';

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

function setDayAs(kind) {
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
    datesBak = JSON.parse(JSON.stringify(dates));
    dates[kind] = {y,m,d};
    closeM('m-day-select');
    updDateViews();
    buildCalScroll();
    buildInfoArea();
    datesChanged = true;
    updSaveDatesBtn();
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
  popupTimes = exist.length>0
    ? exist.map(s=>parseTimeStr(s.time,s.interval))
    : [{sh:'07',sm:'00',eh:'08',em:'30',intv:15}];
  const dt=new Date(y,m-1,d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(y,m,d);
  document.getElementById('m-slot-edit-title').textContent=m+'/'+d+'（'+dow+'）第'+wn+'週 実施日設定';
  renderPopupModal(y,m,d);
  openM('m-slot-edit');
}

function renderPopupModal(y,m,d){
  const area=document.getElementById('m-slot-edit-body');
  const timeOpts=h=>HOURS_LIST.map(v=>`<option value="${v}"${v===h?' selected':''}>${v}</option>`).join('');
  const minOpts =mn=>MINS_LIST.map(v=>`<option value="${v}"${v===mn?' selected':''}>${v}</option>`).join('');
  const intvOpts=i=>INTV_LIST.map(v=>`<option value="${v}"${v===i?' selected':''}>${v}分</option>`).join('');
  const rowsHtml=popupTimes.map((t,i)=>`
    <div class="sp-time-row">
      <div style="display:flex;gap:2px;">
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].sh=this.value">${timeOpts(t.sh)}</select>
        <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].sm=this.value">${minOpts(t.sm)}</select>
      </div>
      <span class="time-wave">〜</span>
      <div style="display:flex;gap:2px;">
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].eh=this.value">${timeOpts(t.eh)}</select>
        <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].em=this.value">${minOpts(t.em)}</select>
      </div>
      <select class="intv-sel" onchange="popupTimes[${i}].intv=parseInt(this.value)">${intvOpts(t.intv)}</select>
      <button class="sp-del-btn" onclick="delSpTimeModal(${i})">&#10005;</button>
    </div>`).join('');
  area.innerHTML=`<div class="sp-wrap">
    <div class="sp-body">${rowsHtml}</div>
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
  popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15});
  renderPopupModal(popupDay.y,popupDay.m,popupDay.d);
}
function delSpTimeModal(i){
  popupTimes.splice(i,1);
  if(popupTimes.length===0)popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15});
  renderPopupModal(popupDay.y,popupDay.m,popupDay.d);
}
function closeSlotEditModal(){closeM('m-slot-edit');popupDay=null;}
async function confirmSlotModal(){
  if(!popupDay)return;
  const{y,m,d}=popupDay;
  // global slots に反映（カレンダー表示共通）
  slots=slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
  popupTimes.forEach(t=>{
    const time=parseInt(t.sh)+':'+t.sm+'~'+parseInt(t.eh)+':'+t.em;
    slots.push({y,m,d,time,interval:parseInt(t.intv)||15});
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
    buildCalGrid('cg-slot',slotY,slotM,'slot');
    buildCalScroll();
    buildSlotSetList();
    buildInfoArea();
  }
}

function resetDaySettings() {
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
    apiGet('updateEventDates',{apply:dates.apply,deadline:dates.deadline,open:dates.open})
      .then(()=>toast('設定をリセットしました','s'))
      .catch(e=>toast('保存に失敗しました: '+e.message,'e'));
  }
}

// ============================================================
// カレンダー下の情報エリア
// ============================================================
function buildInfoArea() {
  // 受付日程カード
  const datesCard = document.getElementById('info-dates-card');
  const datesRows = document.getElementById('info-dates-rows');
  const fmt = obj => {
    if(!obj) return '<span style="color:var(--ink3)">未設定</span>';
    const dt=new Date(obj.y,obj.m-1,obj.d);
    const dow=DOW7[dt.getDay()===0?6:dt.getDay()-1];
    return obj.m+'/'+obj.d+'（'+dow+'）';
  };
  const isLimited = currentPwType !== 'normal';
  if(datesCard && datesRows){
    // 限定PWは日程表示をフェーズUIで代替するので通常PWのみ表示
    if(!isLimited && (dates.apply||dates.deadline||dates.open)){
      datesCard.style.display='block';
      datesRows.innerHTML=`
        <div class="info-row"><span class="info-label">申込開始</span><span class="info-val green">${fmt(dates.apply)}</span></div>
        <div class="info-row"><span class="info-label">締切</span><span class="info-val amber">${fmt(dates.deadline)}</span></div>
        <div class="info-row"><span class="info-label">シフト公開</span><span class="info-val blue">${fmt(dates.open)}</span></div>`;
    } else if(isLimited){
      datesCard.style.display='none';
    }
  }
  // 実施日一覧カード（通常PW のみ）
  const slotsCard = document.getElementById('info-slots-card');
  const slotsBody = document.getElementById('info-slots-body');
  if(slotsCard) slotsCard.style.display = isLimited ? 'none' : (slots.length > 0 ? 'block' : 'none');
  if(!isLimited && slotsCard && slotsBody && slots.length>0){
    const groups={};
    slots.forEach(s=>{const k=s.y+'/'+s.m+'/'+s.d;if(!groups[k])groups[k]={y:s.y,m:s.m,d:s.d,times:[]};groups[k].times.push(s);});
    slotsBody.innerHTML=Object.values(groups).map(g=>{
      const dt=new Date(g.y,g.m-1,g.d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1];
      const wn=getWeekNum(g.y,g.m,g.d);
      return `<div class="slc-group">
        <div class="slc-date-row"><span class="slc-date">${g.m}/${g.d}（${dow}）</span><span class="slc-week">第${wn}週</span></div>
        <div class="slc-times">${g.times.map(t=>`<span class="slc-chip">${t.time}</span>`).join('')}</div>
      </div>`;
    }).join('');
  }
  // フェーズ管理カード（限定PW のみ）
  buildPhaseManageArea(isLimited);
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
  if (!isLimited) { card.style.display = 'none'; return; }
  card.style.display = 'block';

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
  if (!confirm(`フェーズ ${currentPhaseIndex + 1} を削除しますか？`)) return;
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
  if (ov) { ov.style.display = 'flex'; if (ovTxt) ovTxt.textContent = 'フェーズを保存中...'; }
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
    alert('フェーズの保存に失敗しました: ' + e.message);
  } finally {
    if (ov) ov.style.display = 'none';
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
  // 編集表示
  const fmtE = (obj, id) => {
    const el=document.getElementById(id);
    if(!el) return;
    el.textContent=obj?fmt(obj):'クリックして選択';
    el.style.color=obj?'var(--ink)':'var(--ink3)';
  };
  fmtE(dates.apply,    'de-apply');
  fmtE(dates.deadline, 'de-deadline');
  fmtE(dates.open,     'de-open');
}
function toggleDateEdit() {
  if(!dateEditMode){
    datesBak = JSON.parse(JSON.stringify(dates));
    dateEditMode=true;
    document.getElementById('date-view').style.display='none';
    document.getElementById('date-edit').style.display='block';
    document.getElementById('date-edit-btn').className='edit-toggle-btn edit-mode';
    document.getElementById('date-edit-btn').textContent='✕ 閉じる';
    document.getElementById('sc-lbl').textContent=scY+'年'+scM+'月';
    buildCalGrid('cg-sched',scY,scM,'sched');
  } else {
    cancelDateEdit();
  }
}
function cancelDateEdit() {
  if(datesBak) dates=JSON.parse(JSON.stringify(datesBak));
  dateEditMode=false;
  activeKind=null;
  document.getElementById('date-view').style.display='block';
  document.getElementById('date-edit').style.display='none';
  document.getElementById('date-edit-btn').className='edit-toggle-btn view-mode';
  document.getElementById('date-edit-btn').textContent='✎ 編集';
  updDateViews();
  buildCalScroll();
}
function setActiveKind(k) {
  activeKind=k;
  document.querySelectorAll('#date-edit-rows .date-row').forEach(el=>el.classList.remove('active'));
  document.getElementById('dr-'+k).classList.add('active');
  document.getElementById('dsp-hint').textContent={apply:'申込開始日をカレンダーから選択',deadline:'締切日をカレンダーから選択',open:'シフト公開日をカレンダーから選択'}[k];
}
function onScClick(y,m,d) {
  if(!activeKind) return;
  dates[activeKind]={y,m,d};
  updDateViews();
  buildCalGrid('cg-sched',scY,scM,'sched');
}
function chScM(dir){
  scM+=dir; if(scM>12){scM=1;scY++;} if(scM<1){scM=12;scY--;}
  document.getElementById('sc-lbl').textContent=scY+'年'+scM+'月';
  buildCalGrid('cg-sched',scY,scM,'sched');
}
let datesChanged = false;
function updSaveDatesBtn() {
  const btn = document.getElementById('save-dates-btn');
  if (!btn) return;
  btn.disabled = !datesChanged;
  btn.className = 'save-dates-btn' + (datesChanged ? ' active' : '');
}
async function saveDates() {
  showProc('設定を保存しています...', '少々お待ちください');
  try {
    await apiGet('saveDates', { apply: dates.apply, deadline: dates.deadline, open: dates.open });
    datesChanged = false;
    updSaveDatesBtn();
    setProcMsg('再読み込み中...', 'データを更新しています');
    try { await refreshAdminData(); } catch (e) { console.warn('[refreshAdminData]', e); }
    hideProc();
    toast('日程を保存しました', 's');
  } catch (e) {
    hideProc();
    toast('保存に失敗しました: ' + e.message, 'e');
  }
}

// ============================================================
// 実施日設定
// ============================================================
function toggleSlotMode() {
  slotMode=!slotMode;
  const btn=document.getElementById('slot-mode-btn');
  const area=document.getElementById('slot-cal-area');
  btn.className='slot-toggle-btn '+(slotMode?'on':'off');
  btn.innerHTML=slotMode?'&#10005; 選択を終了':'&#128197; 実施日を選択';
  area.style.display=slotMode?'block':'none';
  if(slotMode){
    document.getElementById('slot-mlbl').textContent=slotY+'年'+slotM+'月';
    buildCalGrid('cg-slot',slotY,slotM,'slot');
  } else {
    closeSlotEditModal();
  }
}
function chSlotM(dir){
  slotM+=dir; if(slotM>12){slotM=1;slotY++;} if(slotM<1){slotM=12;slotY--;}
  document.getElementById('slot-mlbl').textContent=slotY+'年'+slotM+'月';
  buildCalGrid('cg-slot',slotY,slotM,'slot');
}
function onSlotClick(y,m,d,el) {
  if(!slotMode) return;
  popupDay={y,m,d};
  const exist=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  popupTimes=exist.length>0
    ? exist.map(s=>parseTimeStr(s.time,s.interval))
    : [{sh:'07',sm:'00',eh:'08',em:'30',intv:15}];
  const dt=new Date(y,m-1,d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(y,m,d);
  document.getElementById('m-slot-edit-title').textContent=m+'/'+d+'（'+dow+'）第'+wn+'週 実施日設定';
  renderPopupModal(y,m,d);
  openM('m-slot-edit');
}
function parseTimeStr(timeStr,interval){
  const p=timeStr.match(/(\d{1,2}):(\d{2})[~〜](\d{1,2}):(\d{2})/);
  if(!p) return {sh:'07',sm:'00',eh:'08',em:'30',intv:parseInt(interval)||15};
  return {sh:p[1].padStart(2,'0'),sm:p[2],eh:p[3].padStart(2,'0'),em:p[4],intv:parseInt(interval)||15};
}
function renderPopup(y,m,d){
  const area=document.getElementById('popup-area');
  const dt=new Date(y,m-1,d),dow=DOW7[dt.getDay()===0?6:dt.getDay()-1],wn=getWeekNum(y,m,d);
  const timeOpts = h => HOURS_LIST.map(v=>`<option value="${v}"${v===h?' selected':''}>${v}</option>`).join('');
  const minOpts  = m => MINS_LIST.map(v=>`<option value="${v}"${v===m?' selected':''}>${v}</option>`).join('');
  const intvOpts = i => INTV_LIST.map(v=>`<option value="${v}"${v===i?' selected':''}>${v}分</option>`).join('');
  const rowsHtml=popupTimes.map((t,i)=>`
    <div class="sp-time-row">
      <div style="display:flex;gap:2px;">
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].sh=this.value">${timeOpts(t.sh)}</select>
        <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].sm=this.value">${minOpts(t.sm)}</select>
      </div>
      <span class="time-wave">〜</span>
      <div style="display:flex;gap:2px;">
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].eh=this.value">${timeOpts(t.eh)}</select>
        <span style="padding:0 2px;font-size:13px;color:var(--ink3);display:flex;align-items:center;">:</span>
        <select class="time-sel" style="width:50px;" onchange="popupTimes[${i}].em=this.value">${minOpts(t.em)}</select>
      </div>
      <select class="intv-sel" onchange="popupTimes[${i}].intv=parseInt(this.value)">${intvOpts(t.intv)}</select>
      <button class="sp-del-btn" onclick="delSpTime(${i})">&#10005;</button>
    </div>`).join('');
  area.innerHTML=`<div class="sp-wrap">
    <div class="sp-hd">
      <span class="sp-title">${m}/${d}（${dow}）</span>
      <span class="sp-week-badge">第${wn}週</span>
    </div>
    <div class="sp-body">${rowsHtml}</div>
    <div style="padding:6px 12px;">
      <button class="sp-add-btn" onclick="addSpTime()">&#65291; 時間帯を追加</button>
    </div>
    <div class="sp-ft">
      <button class="btn btn-g" onclick="closePopup()" style="font-size:11px;padding:5px 12px;">キャンセル</button>
      <button class="btn btn-p" onclick="confirmSlot()" style="font-size:11px;padding:5px 12px;">確定</button>
    </div>
  </div>`;
}
function addSpTime(){
  popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15});
  renderPopup(popupDay.y,popupDay.m,popupDay.d);
}
function delSpTime(i){
  popupTimes.splice(i,1);
  if(popupTimes.length===0) popupTimes.push({sh:'07',sm:'00',eh:'08',em:'30',intv:15});
  renderPopup(popupDay.y,popupDay.m,popupDay.d);
}
function closePopup(){document.getElementById('popup-area').innerHTML='';popupDay=null;}
function confirmSlot(){
  const{y,m,d}=popupDay;
  slots=slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
  popupTimes.forEach(t=>{
    const time=parseInt(t.sh)+':'+t.sm+'~'+parseInt(t.eh)+':'+t.em;
    // intervalは必ず整数に
    slots.push({y,m,d,time,interval:parseInt(t.intv)||15});
  });
  closePopup();
  buildCalGrid('cg-slot',slotY,slotM,'slot');
  buildCalScroll();
  buildSlotSetList();
  buildInfoArea();
}
function buildSlotSetList(){
  const el=document.getElementById('slot-set-list');
  if(slots.length===0){el.innerHTML='<div class="slot-empty">実施日がありません。「実施日を選択」から追加してください。</div>';return;}
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
    </div>`;
  }).join('');
}
function delSlot(key,idx){
  const[y,m,d]=key.split('/').map(Number);
  const ds=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  slots=slots.filter(s=>s!==ds[idx]);
  buildSlotSetList(); buildCalScroll(); buildInfoArea();
}
function resetDaySlots(key){
  const[y,m,d]=key.split('/').map(Number);
  slots=slots.filter(s=>!(s.y===y&&s.m===m&&s.d===d));
  buildSlotSetList(); buildCalScroll(); buildInfoArea();
}
function editSlotFromList(y,m,d){
  popupDay={y,m,d};
  const exist=slots.filter(s=>s.y===y&&s.m===m&&s.d===d);
  popupTimes=exist.length>0
    ? exist.map(s=>parseTimeStr(s.time,s.interval))
    : [{sh:'07',sm:'00',eh:'08',em:'30',intv:15}];
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
  }
}
function resetAllSlots(){
  if(!confirm('実施日一覧を全てリセットしますか？')) return;
  slots=[];
  buildSlotSetList(); buildCalScroll(); buildInfoArea();
}
function resetDates(){
  if(!confirm('日程一覧（申込開始・締切・シフト公開日）をリセットしますか？')) return;
  dates={apply:null,deadline:null,open:null};
  datesChanged=true;
  buildInfoArea();
}
// ============================================================
// シフトフォーム作成（ボタン押下時にデータ取得）
// ============================================================
async function openFormModal(){
  openM('m-form');
  document.getElementById('m-form-body').innerHTML='<div class="loading-row"><div class="spin"></div>データを読み込み中...</div>';
  document.getElementById('m-form-ft').innerHTML='<button class="btn btn-g" onclick="closeM(\'m-form\')">閉じる</button>';
  try {
    const d = await apiGet('adminData', { year: curY, month: curM });
    fcAdminData = d;
    fcN=1;
    renderFormModal(d);
  } catch(e){ document.getElementById('m-form-body').innerHTML='<div style="color:var(--red);font-size:12px;">読み込みに失敗しました: '+e.message+'</div>'; }
}
function renderFormModal(d){
  // 対象月選択
  let ymOpts='';
  for(let y=curY-1;y<=curY+2;y++) for(let m=1;m<=12;m++){
    const sel=(y===curY&&m===curM);
    ymOpts+=`<option value="${y}-${m}"${sel?' selected':''}>${y}年${m}月</option>`;
  }
  // 紐付けUI
  const curSlots=d.currentSlots||[], prevSlots=d.prevSlots||[];
  const groups={};
  curSlots.forEach(s=>{const k=s.dateLabel;if(!groups[k])groups[k]={dl:s.dateLabel,wk:s.week,times:[]};groups[k].times.push(s.time);});
  const prevGroups={};
  prevSlots.forEach(s=>{const k=s.dateLabel;if(!prevGroups[k])prevGroups[k]={dl:s.dateLabel,wk:s.week,times:[]};prevGroups[k].times.push(s.time);});
  mappingResult={};
  curSlots.forEach(cs=>{
    const key=cs.week+' '+cs.dateLabel+' '+cs.time;
    const matched=prevSlots.find(ps=>ps.time===cs.time);
    mappingResult[key]=matched?matched.week+' '+matched.dateLabel+' '+matched.time:'';
  });
  let mapHtml='';
  if(prevSlots.length===0){
    // 前月データなくても手動入力エリアを提供
    mapHtml='<div style="color:var(--ink2);font-size:12px;padding:8px 10px;background:var(--amber-l);border:1px solid #fcd34d;border-radius:var(--r);margin-bottom:8px;">前月のシートが見つかりませんでした。紐付けは不要です。</div>';
  } else {
    Object.values(groups).forEach(g=>{
      mapHtml+=`<div class="map-date-hd">&#128197; ${g.dl} <span style="font-size:10px;opacity:.7;">${g.wk}</span></div>`;
      g.times.forEach(time=>{
        const key=g.wk+' '+g.dl+' '+time;
        const def=mappingResult[key]||'';
        let opts='<option value="">（なし）</option>';
        Object.values(prevGroups).forEach(pg=>{
          opts+=`<optgroup label="${pg.wk}　${pg.dl}">`;
          pg.times.forEach(pt=>{const pk=pg.wk+' '+pg.dl+' '+pt;opts+=`<option value="${pk}"${pk===def?' selected':''}>${pg.dl}　${pt}</option>`;});
          opts+='</optgroup>';
        });
        mapHtml+=`<div class="map-row"><div class="map-cur">${time}</div><div class="map-arr">&#8594;</div><select class="fsel map-sel" data-key="${key}" style="font-size:11px;padding:4px 7px;">${opts}</select></div>`;
      });
      mapHtml+='<div style="height:6px;"></div>';
    });
  }
  // シート配置
  const newName=curY+'.'+String(curM).padStart(2,'0')+'シフト希望';
  const existing=(d.sheetNames||[]).filter(n=>n!==newName);
  const pos=Math.min(3,existing.length+1);
  sheetListData=[...existing]; sheetListData.splice(pos-1,0,{name:newName,isNew:true});
  // スロット一覧
  const slotSummary=slots.length>0
    ? slots.map(s=>`<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;border-bottom:1px solid var(--border);"><span style="font-family:var(--mono);">${s.m}/${s.d} ${s.time}</span><span style="color:var(--ink3);">${parseInt(s.interval)||15}分</span></div>`).join('')
    : '<div style="color:var(--ink3);font-size:11px;">実施日が設定されていません</div>';

  document.getElementById('m-form-body').innerHTML=`
    <div class="steps">
      <div class="si"><div class="sc on" id="s1">1</div><div class="sl on" id="sl1">年月</div></div>
      <div class="sln" id="ln1"></div>
      <div class="si"><div class="sc" id="s2">2</div><div class="sl" id="sl2">紐付け</div></div>
      <div class="sln" id="ln2"></div>
      <div class="si"><div class="sc" id="s3">3</div><div class="sl" id="sl3">確認</div></div>
    </div>
    <div id="p1">
      <div class="fg"><label class="fl">対象年月</label><select class="fsel" id="fc-ym-sel">${ymOpts}</select></div>
    </div>
    <div id="p2" style="display:none;">
      <p style="font-size:12px;color:var(--ink2);margin-bottom:9px;">各日付・時間帯と前月の対応スロットを紐付けてください。</p>
      ${mapHtml}
    </div>
    <div id="p3" style="display:none;">
      <div class="sumbox">
        <div class="sumrow"><span class="sumk">対象月</span><span class="sumv" id="fc-s-ym">--</span></div>
        <div class="sumrow"><span class="sumk">紐付け</span><span class="sumv" id="fc-s-map">--</span></div>
      </div>
      <div class="fg">
        <label class="fl">実施日一覧</label>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:8px 10px;max-height:120px;overflow-y:auto;">${slotSummary}</div>
      </div>
      <div class="exec-st" id="fc-st"><div class="spin"></div>処理中...</div>
      <div class="done-box" id="fc-done" style="display:none;"><div class="done-icon">&#10003;</div><div class="done-title">作成完了</div><div class="done-sub" id="fc-done-sub"></div></div>
    </div>`;
  document.getElementById('m-form-ft').innerHTML=`
    <button class="btn btn-g" id="fc-bk" style="display:none;" onclick="fcStep(-1)">戻る</button>
    <button class="btn btn-g" onclick="closeMReset('m-form','resetFC')">キャンセル</button>
    <button class="btn btn-p" id="fc-nx" onclick="fcStep(1)">次へ</button>`;
  renderSheetPlace();
  updFcSteps();
}
function renderSheetPlace(){
  const el=document.getElementById('sheet-place-list'); if(!el) return;
  el.innerHTML=sheetListData.map((o,i)=>{
    const nm=typeof o==='string'?o:o.name, isNew=o.isNew||false;
    return `<div style="display:flex;align-items:center;gap:7px;padding:7px 10px;border:${isNew?'1.5px solid var(--blue)':'1px solid var(--border)'};border-radius:var(--r);font-size:12px;background:${isNew?'var(--blue-l)':'var(--surface2)'};${isNew?'font-weight:700;color:var(--blue)':''};">
      <span style="font-size:10px;color:${isNew?'var(--blue)':'var(--ink3)'};width:38px;text-align:right;">${i+1}番目</span>
      <span style="flex:1;">${nm}</span>
      ${isNew?`<span style="font-size:10px;background:var(--blue);color:#fff;padding:1px 7px;border-radius:10px;">新規</span>`:''}
      ${isNew?`<div style="display:flex;flex-direction:column;gap:2px;">
        <button onclick="moveSheet(-1)" style="width:20px;height:18px;border:1px solid var(--border);border-radius:3px;background:none;cursor:pointer;font-size:10px;"${i===0?' disabled':''}>&#9650;</button>
        <button onclick="moveSheet(1)" style="width:20px;height:18px;border:1px solid var(--border);border-radius:3px;background:none;cursor:pointer;font-size:10px;"${i===sheetListData.length-1?' disabled':''}>&#9660;</button>
      </div>`:''}
    </div>`;
  }).join('');
}
function moveSheet(dir){
  const idx=sheetListData.findIndex(o=>o.isNew);
  const t=idx+dir; if(t<0||t>=sheetListData.length) return;
  const tmp=sheetListData[idx]; sheetListData[idx]=sheetListData[t]; sheetListData[t]=tmp;
  renderSheetPlace();
}
function fcStep(dir){
  if(dir===1&&fcN===3){execFormCreate();return;}
  if(dir===1&&fcN===2){
    document.querySelectorAll('.map-sel').forEach(s=>{mappingResult[s.dataset.key]=s.value;});
    const ymVal=document.getElementById('fc-ym-sel')?.value||curY+'-'+curM;
    const[fy,fm]=ymVal.split('-').map(Number);
    const cnt=Object.values(mappingResult).filter(v=>v).length;
    document.getElementById('fc-s-ym').textContent=fy+'年'+fm+'月';
    document.getElementById('fc-s-map').textContent=cnt+'件';
  }
  fcN=Math.min(3,Math.max(1,fcN+dir));
  updFcSteps();
}
function updFcSteps(){
  for(let i=1;i<=3;i++){
    const p=document.getElementById('p'+i); if(p) p.style.display=i===fcN?'block':'none';
    const c=document.getElementById('s'+i),l=document.getElementById('sl'+i);
    if(c){c.className='sc'+(i<fcN?' dn':i===fcN?' on':'');c.innerHTML=i<fcN?'&#10003;':i;}
    if(l) l.className='sl'+(i===fcN?' on':'');
    if(i<3){const ln=document.getElementById('ln'+i);if(ln)ln.className='sln'+(i<fcN?' dn':'');}
  }
  const nx=document.getElementById('fc-nx'),bk=document.getElementById('fc-bk');
  if(nx){nx.textContent=fcN===3?'作成する':'次へ';nx.className='btn '+(fcN===3?'btn-d':'btn-p');}
  if(bk) bk.style.display=fcN>1?'inline-flex':'none';
}
function resetFC(){ fcN=1; }
async function execFormCreate(){
  const ymVal=document.getElementById('fc-ym-sel')?.value||curY+'-'+curM;
  const[fy,fm]=ymVal.split('-').map(Number);
  const nx=document.getElementById('fc-nx'),bk=document.getElementById('fc-bk');
  if(nx) nx.disabled=true;
  if(bk) bk.style.display='none';
  document.getElementById('fc-st').classList.add('show');
  try{
    await apiGet('createForm',{mapping:mappingResult,year:fy,month:fm});
    document.getElementById('fc-st').classList.remove('show');
    document.getElementById('fc-done').style.display='block';
    document.getElementById('fc-done-sub').textContent=fy+'年'+fm+'月のフォームを作成しました。';
    document.getElementById('m-form-ft').innerHTML=`
      <button class="btn btn-g" onclick="closeMReset('m-form','resetFC')">閉じる</button>
      <button class="btn btn-d" onclick="execFormCreate()">再作成</button>`;
    toast('フォームを作成しました','s');
  }catch(e){
    document.getElementById('fc-st').classList.remove('show');
    if(nx){nx.disabled=false;}
    if(bk) bk.style.display='inline-flex';
    toast('作成に失敗しました: '+e.message,'e');
  }
}

// ============================================================
// 予定表公開ステータスバッジ
// ============================================================
let calPubStatus = null;
let calPubYM     = null;  // 実際に公開中のカレンダーの年月 {y,m}（公開できるのは常に1ヶ月だけ）

async function loadCalPubStatus() {
  const badge = document.getElementById('cal-pub-badge');
  const text  = document.getElementById('cal-pub-badge-text');
  if (!badge || !text) return;
  try {
    const r = await apiGet('getCalPubStatus');
    calPubStatus = r.published;
    calPubYM = null;
    if (r.published && r.publishedYM) {
      const [py, pm] = r.publishedYM.split('.').map(Number);
      if (py && pm) calPubYM = { y: py, m: pm };
    }
    updCalPubBadge();
  } catch(e) {
    calPubStatus = null; calPubYM = null;
    badge.className = 'cal-pub-badge loading';
    text.textContent = '確認中...';
  }
}

// 表示中の「対象年月」と「実際に公開中の月」がズレていることが一目で分かるようにする。
// 公開できる月は常に1つだけで、別の月を公開すると前の月は自動的に非公開になる
function isCurMonthPublished() { return !!(calPubStatus && calPubYM && calPubYM.y === curY && calPubYM.m === curM); }

function updCalPubBadge() {
  const badge = document.getElementById('cal-pub-badge');
  const text  = document.getElementById('cal-pub-badge-text');
  const note  = document.getElementById('cal-pub-note');
  if (!badge || !text) return;
  if (calPubStatus === null) {
    badge.className = 'cal-pub-badge loading';
    text.textContent = '確認中...';
    if (note) note.style.display = 'none';
    return;
  }
  if (!calPubStatus || !calPubYM) {
    badge.className = 'cal-pub-badge unpublished';
    text.textContent = '🔒 公開中の月はありません';
  } else if (isCurMonthPublished()) {
    badge.className = 'cal-pub-badge published';
    text.textContent = '📅 ' + calPubYM.y + '年' + calPubYM.m + '月 公開中';
  } else {
    badge.className = 'cal-pub-badge mismatch';
    text.textContent = '⚠️ 公開中は ' + calPubYM.y + '年' + calPubYM.m + '月';
  }
  if (note) {
    if (calPubStatus && calPubYM && !isCurMonthPublished()) {
      note.innerHTML = '表示中の <b>' + curY + '年' + curM + '月</b> は未公開です。奉仕者とシフト作成アプリに出ているのは <b>'
        + calPubYM.y + '年' + calPubYM.m + '月</b> です（公開できる月は1つだけ。この月を公開すると '
        + calPubYM.y + '年' + calPubYM.m + '月 は自動的に非公開になります）';
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  }
}

async function toggleCalPub() {
  if (calPubStatus === null) return;
  // 表示中の月が公開中のときだけ「非公開」操作。別の月が公開中なら、
  // 表示中の月を公開する導線（＝公開月の切り替え）にする
  if (isCurMonthPublished()) {
    if (!confirm('予定表を非公開にしますか？\n奉仕者はカレンダー情報（日程・実施日）を確認できなくなります。')) return;
    const badge = document.getElementById('cal-pub-badge');
    const text  = document.getElementById('cal-pub-badge-text');
    badge.className = 'cal-pub-badge loading';
    text.textContent = '処理中...';
    try {
      await apiGet('unpublishCalendar');
      calPubStatus = false; calPubYM = null;
      updCalPubBadge();
      toast('予定表を非公開にしました', 's');
    } catch(e) {
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
    <div class="done-box" id="cp-done" style="display:none;"><div class="done-icon">&#10003;</div><div class="done-title">公開完了</div></div>`;
  document.getElementById('m-cp-ft').innerHTML=`
    <button class="btn btn-g" onclick="closeM('m-cal-pub')">キャンセル</button>
    <button class="btn btn-s" id="cp-exec-btn" onclick="execCalPub()">${curY}年${curM}月を公開する</button>`;
}
async function execCalPub(){
  document.getElementById('cp-exec-btn').disabled=true;
  document.getElementById('cp-st').classList.add('show');
  try{
    await apiGet('publishCalendar',{year:curY,month:curM});
    document.getElementById('cp-st').classList.remove('show');
    document.getElementById('cp-done').style.display='block';
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
function closeMReset(id, resetFn){ closeM(id); if(resetFn==='resetFC') resetFC(); }
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
function copyUrl(){
  navigator.clipboard.writeText('https://jw-utazu.github.io/shift-form/').then(()=>toast('URLをコピーしました','s'));
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
  if(window.matchMedia('(display-mode: standalone)').matches) return;
  let deferredPrompt=null;
  window.addEventListener('beforeinstallprompt', e=>{
    e.preventDefault(); deferredPrompt=e;
    const s=document.getElementById('pwa-auto-section'); if(s) s.style.display='block';
  });
  window.addEventListener('appinstalled', ()=>{ deferredPrompt=null; toast('インストールしました!','s'); closeM('m-pwa'); });
  window.openPwaModal=function(){
    if(window.matchMedia('(display-mode: standalone)').matches){ toast('すでにインストール済みです','s'); return; }
    const s=document.getElementById('pwa-auto-section'); if(s) s.style.display=deferredPrompt?'block':'none';
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
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;"><input type="checkbox" id="notice-display-in" checked> 表示ON</label>
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
        document.getElementById('notice-display-in').checked = n.display === 'ON';
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
  const display   = document.getElementById('notice-display-in').checked;
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
  if (!confirm('このお知らせを削除しますか？')) return;
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
async function openProxyModal() {
  openM('m-proxy');
  await refreshProxyModal();
}
async function refreshProxyModal() {
  document.getElementById('m-proxy-body').innerHTML = '<div class="loading-row"><div class="spin"></div>読み込み中...</div>';
  try {
    const [proxyRes, memberRes] = await Promise.all([apiGet('getProxySettings'), apiGet('getMemberList')]);
    _proxyMembers = (memberRes.members || []).filter(m => m.uid);
    const settings = proxyRes.settings || [];
    const memberOpts = _proxyMembers.map(m => `<option value="${m.uid}">${esc(m.name)}</option>`).join('');
    let html = `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">代理設定を追加</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">代理元（送ってもらう人）</div>
            <select id="proxy-from-sel" class="fsel" style="font-size:12px;"><option value="">-- 選択 --</option>${memberOpts}</select></div>
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">代理先（代わりに送る人）</div>
            <select id="proxy-to-sel" class="fsel" style="font-size:12px;"><option value="">-- 選択 --</option>${memberOpts}</select></div>
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
        return `<div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-bottom:6px;background:var(--surface);display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:12px;">${esc(fromM?fromM.name:s.fromUid)} → ${esc(toM?toM.name:s.toUid)}</span>
          <button class="btn btn-d" onclick="deleteProxy(${s.rowIndex})" style="font-size:10px;padding:3px 8px;">解除</button>
        </div>`;
      }).join('');
    }
    document.getElementById('m-proxy-body').innerHTML = html;
  } catch (e) {
    document.getElementById('m-proxy-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}
async function addProxy() {
  const fromUid = document.getElementById('proxy-from-sel').value;
  const toUid   = document.getElementById('proxy-to-sel').value;
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
async function deleteProxy(rowIndex) {
  if (!confirm('この代理設定を解除しますか？')) return;
  showProc('解除しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'deleteProxySetting', rowIndex });
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
    const [coupleRes, memberRes] = await Promise.all([apiGet('getCoupleList'), apiGet('getMemberList')]);
    _coupleMembers = (memberRes.members || []).filter(m => m.uid);
    const couples  = coupleRes.couples || [];

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

    const husbandOpts = eligible.filter(m => m.gender === 'M').map(m => `<option value="${m.uid}">${esc(m.name)}</option>`).join('');
    const wifeOpts    = eligible.filter(m => m.gender !== 'M').map(m => `<option value="${m.uid}">${esc(m.name)}</option>`).join('');

    let html = `
      <div style="margin-bottom:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--ink2);margin-bottom:8px;">夫婦ペアを追加</div>
        <div style="font-size:11px;color:var(--ink3);margin-bottom:8px;line-height:1.6;">追加すると、並び替えで夫が妻の直前に表示され、お互いに代理送信が可能になります。</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">夫</div>
            <select id="couple-husband-sel" class="fsel" style="font-size:12px;"><option value="">-- 選択 --</option>${husbandOpts}</select></div>
          <div><div style="font-size:10px;color:var(--ink3);margin-bottom:4px;">妻</div>
            <select id="couple-wife-sel" class="fsel" style="font-size:12px;"><option value="">-- 選択 --</option>${wifeOpts}</select></div>
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
        return `<div style="border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;margin-bottom:6px;background:var(--surface);display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:12px;">👨 ${esc(hm ? hm.name : c.husbandUid)} &nbsp;＆&nbsp; 👩 ${esc(wm ? wm.name : c.wifeUid)}</span>
          <button class="btn btn-d" onclick="deleteCouple(${c.rowIndex})" style="font-size:10px;padding:3px 8px;">解除</button>
        </div>`;
      }).join('');
    }
    document.getElementById('m-couple-body').innerHTML = html;
  } catch (e) {
    document.getElementById('m-couple-body').innerHTML = `<div style="color:var(--red);">エラー: ${e.message}</div>`;
  }
}
async function addCouple() {
  const husbandUid = document.getElementById('couple-husband-sel').value;
  const wifeUid    = document.getElementById('couple-wife-sel').value;
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
async function deleteCouple(rowIndex) {
  if (!confirm('この夫婦設定を解除しますか？')) return;
  showProc('解除しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'deleteCouple', rowIndex });
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
async function openRecoveryModal() {
  openM('m-recovery');
  await loadRecoveryRequests();
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

    let html = '<div class="rec-note">承認したら、パスコードを<b>本人と確実に連絡が取れる手段</b>'
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

// メニューボタンの未対応バッジ
function updateRecoveryBadge(n) {
  const el = document.getElementById('rec-badge');
  if (!el) return;
  if (n > 0) { el.textContent = n; el.style.display = ''; }
  else { el.style.display = 'none'; }
}

async function approveRecoveryRequest(id) {
  if (!confirm('この申請を承認しますか？\n\n承認するとパスコードが表示されます。\n電話やLINEなど、本人と確実に連絡が取れる手段でお伝えください。')) return;
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
  if (!confirm('この申請を却下しますか？')) return;
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
  document.getElementById('rec-newkey').value = '';
  document.getElementById('rec-key-msg').textContent = '';
  openM('m-recovery-key');
}

async function saveRecoveryKey() {
  const key = document.getElementById('rec-newkey').value.trim();
  const msg = document.getElementById('rec-key-msg');
  if (key.length < 4) { msg.style.color = 'var(--red)'; msg.textContent = '4文字以上で入力してください。'; return; }
  showProc('合言葉を変更しています...', '少々お待ちください');
  try {
    const res = await apiPost({ action: 'setRecoverySharedKey', sharedKey: key });
    if (!res.ok) throw new Error(res.reason || '変更に失敗しました');
    hideProc();
    closeM('m-recovery-key');
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
// 権限リスト同期
// ============================================================
async function execSyncAccess() {
  if (!confirm('公開ファイルの編集者・閲覧者をアクセス許可リストに同期しますか？')) return;
  try {
    const res = await apiGet('syncAccessList');
    if (!res.ok) throw new Error(res.error || '同期失敗');
    toast(`同期完了（${res.added}件追加）`, 's');
  } catch (e) { toast('同期失敗: ' + e.message, 'e'); }
}

// ============================================================
// 月次一括処理
// ============================================================
let monthlyChecks = { calpub: true, form: true, shift: true };

function openMonthlyModal() {
  document.getElementById('mc-calpub').checked = true;
  document.getElementById('mc-form').checked = true;
  document.getElementById('mc-shift').checked = true;
  monthlyStep(1);
  openM('m-monthly');
}

function monthlyStep(n) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById('mstep-' + i);
    if (el) el.className = 'monthly-step' + (i === n ? ' on' : '');
  }
  if (n === 2) buildMstep2();
  if (n === 3) buildMstep3();
  if (n === 4) buildMstep4();
}

function monthlyGoStep3or4() {
  monthlyChecks.calpub = document.getElementById('mc-calpub').checked;
  monthlyChecks.form   = document.getElementById('mc-form').checked;
  monthlyChecks.shift  = document.getElementById('mc-shift').checked;
  if (monthlyChecks.form) {
    monthlyStep(3);
  } else {
    monthlyStep(4);
  }
}

async function buildMstep3() {
  const body = document.getElementById('mstep3-body');
  body.innerHTML = '<div class="loading-row"><div class="spin"></div>前月データを読み込み中...</div>';
  try {
    const d = await apiGet('adminData', { year: curY, month: curM });
    // 現在編集中のslots（ローカル）からcurSlotsを生成（カレンダーシートの保存済みデータは使わない）
    const _DOW = ['日','月','火','水','木','金','土'];
    function _weekNum(y, m, d) {
      const date = new Date(y, m-1, d);
      const dow = date.getDay();
      const monDow = dow === 0 ? 6 : dow - 1;
      const thisMonday = new Date(date); thisMonday.setDate(d - monDow);
      const monthStart = new Date(y, m-1, 1);
      const msDay = monthStart.getDay();
      const msMon = msDay === 0 ? 6 : msDay - 1;
      const firstMonday = new Date(monthStart); firstMonday.setDate(1 - msMon);
      return Math.floor((thisMonday - firstMonday) / (7 * 86400000)) + 1;
    }
    const curSlots = slots.map(s => {
      const dt = new Date(s.y, s.m - 1, s.d);
      const dateLabel = s.m + '/' + s.d + '(' + _DOW[dt.getDay()] + ')';
      const week = '第' + _weekNum(s.y, s.m, s.d) + '週';
      return { week, dateLabel, time: s.time, interval: s.interval, y: s.y, m: s.m, d: s.d };
    });
    const prevSlots = d.prevSlots || [];
    const groups    = {}, prevGroups  = {};
    curSlots.forEach(s  => { const k = s.dateLabel; if (!groups[k])     groups[k]     = { dl: s.dateLabel, wk: s.week, times: [] }; groups[k].times.push(s.time); });
    prevSlots.forEach(s => { const k = s.dateLabel; if (!prevGroups[k]) prevGroups[k] = { dl: s.dateLabel, wk: s.week, times: [] }; prevGroups[k].times.push(s.time); });
    monthlyMappingResult = {};
    curSlots.forEach(cs => {
      const key     = cs.week + ' ' + cs.dateLabel + ' ' + cs.time;
      const matched = prevSlots.find(ps => ps.time === cs.time);
      monthlyMappingResult[key] = matched ? matched.week + ' ' + matched.dateLabel + ' ' + matched.time : '';
    });
    let mapHtml = '';
    if (prevSlots.length === 0) {
      mapHtml = '<div style="color:var(--ink2);font-size:12px;padding:8px 10px;background:var(--amber-l);border:1px solid #fcd34d;border-radius:var(--r);">前月のデータが見つかりませんでした。紐付けは不要です。</div>';
    } else {
      Object.values(groups).forEach(g => {
        mapHtml += `<div class="map-date-hd">📅 ${g.dl} <span style="font-size:10px;opacity:.7;">${g.wk}</span></div>`;
        g.times.forEach(time => {
          const key = g.wk + ' ' + g.dl + ' ' + time;
          const def = monthlyMappingResult[key] || '';
          let opts  = '<option value="">（なし）</option>';
          Object.values(prevGroups).forEach(pg => {
            opts += `<optgroup label="${pg.wk}　${pg.dl}">`;
            pg.times.forEach(pt => {
              const pk = pg.wk + ' ' + pg.dl + ' ' + pt;
              opts += `<option value="${pk}"${pk === def ? ' selected' : ''}>${pg.dl}　${pt}</option>`;
            });
            opts += '</optgroup>';
          });
          mapHtml += `<div class="map-row"><div class="map-cur">${time}</div><div class="map-arr">&#8594;</div><select class="fsel map-sel-m" data-key="${key}" style="font-size:11px;padding:4px 7px;">${opts}</select></div>`;
        });
        mapHtml += '<div style="height:6px;"></div>';
      });
    }
    body.innerHTML = '<p style="font-size:12px;color:var(--ink2);margin-bottom:9px;">各時間帯と前月の対応スロットを紐付けてください。</p>' + mapHtml;
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:12px;">読み込みに失敗しました: ' + e.message + '</div>';
  }
}

let monthlyMappingResult = {};

function buildMstep2() {
  const fmt = obj => {
    if (!obj) return '<span style="color:var(--ink3)">未設定</span>';
    const dt = new Date(obj.y, obj.m - 1, obj.d);
    const dow = ['日','月','火','水','木','金','土'][dt.getDay()];
    return obj.m + '/' + obj.d + '（' + dow + '）';
  };
  const slotGroups = {};
  slots.forEach(s => {
    const k = s.m + '/' + s.d;
    if (!slotGroups[k]) slotGroups[k] = [];
    slotGroups[k].push(s.time);
  });
  const slotKeys = Object.keys(slotGroups).sort((a,b) => {
    const [am,ad]=a.split('/').map(Number), [bm,bd]=b.split('/').map(Number);
    return am!==bm ? am-bm : ad-bd;
  });
  let html = '<div style="font-size:12px;color:var(--ink2);margin-bottom:6px;">以下の設定で処理を実行します</div>';
  if (currentPwType !== 'normal') {
    // 限定PW: 日程はフェーズ（adminPhases）に保存されている
    adminPhases.forEach((ph, i) => {
      if (adminPhases.length > 1) html += `<div style="font-size:11px;font-weight:700;color:var(--ink2);margin-top:${i>0?'8px':'0'};">第${i+1}フェーズ</div>`;
      html += '<div class="ms-info-row"><span class="ms-info-k">申込開始</span><span class="ms-info-v" style="color:var(--green);">' + fmt(ph.apply) + '</span></div>';
      html += '<div class="ms-info-row"><span class="ms-info-k">締切日</span><span class="ms-info-v" style="color:var(--red);">' + fmt(ph.deadline) + '</span></div>';
      html += '<div class="ms-info-row"><span class="ms-info-k">シフト公開</span><span class="ms-info-v" style="color:var(--blue);">' + fmt(ph.open) + '</span></div>';
    });
  } else {
    html += '<div class="ms-info-row"><span class="ms-info-k">申込開始</span><span class="ms-info-v" style="color:var(--green);">' + fmt(dates.apply) + '</span></div>';
    html += '<div class="ms-info-row"><span class="ms-info-k">締切日</span><span class="ms-info-v" style="color:var(--red);">' + fmt(dates.deadline) + '</span></div>';
    html += '<div class="ms-info-row"><span class="ms-info-k">シフト公開</span><span class="ms-info-v" style="color:var(--blue);">' + fmt(dates.open) + '</span></div>';
  }
  if (slotKeys.length > 0) {
    slotKeys.forEach(k => {
      html += '<div class="ms-info-row"><span class="ms-info-k" style="color:var(--purple);">実施日</span><span class="ms-info-v" style="color:var(--purple);">' + k + '（' + slotGroups[k].length + '枠）</span></div>';
    });
  } else {
    html += '<div class="ms-info-row"><span class="ms-info-k">実施日</span><span class="ms-info-v" style="color:var(--ink3);">未設定</span></div>';
  }
  document.getElementById('mstep2-dates').innerHTML = html;
}

function buildMstep4() {
  monthlyChecks.calpub = document.getElementById('mc-calpub').checked;
  monthlyChecks.form   = document.getElementById('mc-form').checked;
  monthlyChecks.shift  = document.getElementById('mc-shift').checked;
  const tasks = [
    { id: 'calregen', label: '🔄 日程・実施日を保存' }
  ];
  if (monthlyChecks.calpub) tasks.push({ id: 'calpub', label: '📅 予定表公開' });
  if (monthlyChecks.form)   tasks.push({ id: 'form',   label: '📝 シフトフォーム作成' });
  if (monthlyChecks.shift)  tasks.push({ id: 'shift',  label: '🗂 シフト作成準備' });
  document.getElementById('mstep4-list').innerHTML = tasks.map(t =>
    `<div class="ms-prog-row" id="mpr-${t.id}">
      <span class="ms-prog-ic" id="mpic-${t.id}">⏳</span>
      <span class="ms-prog-label">${t.label}</span>
      <span class="ms-prog-st" id="mpst-${t.id}">待機中</span>
    </div>`
  ).join('');
  document.getElementById('mstep4-done').style.display = 'none';
  const _backStep = monthlyChecks.form ? 3 : 2;
  document.getElementById('mstep4-nav').innerHTML =
    `<button class="ms-btn sec" onclick="monthlyStep(${_backStep})" id="mstep4-back">← 戻る</button>` +
    '<button class="ms-btn primary" onclick="execMonthly()" id="mstep4-exec">実行</button>';
}

async function execMonthly() {
  document.getElementById('mstep4-back').style.display = 'none';
  document.getElementById('mstep4-exec').style.display = 'none';

  const tasks = [{ id: 'calregen', label: '💾 日程・実施日を保存' }];
  if (monthlyChecks.calpub) tasks.push({ id: 'calpub', label: '📅 予定表公開' });
  if (monthlyChecks.form)   tasks.push({ id: 'form',   label: '📝 シフトフォーム作成' });
  if (monthlyChecks.shift)  tasks.push({ id: 'shift',  label: '🗂 シフト作成準備' });

  closeM('m-monthly');
  showProc('募集開始処理を実行しています', '完了までそのままお待ちください');
  showProcSteps(tasks);

  async function runTask(id, fn) {
    setProcStep(id, 'running');
    try { await fn(); setProcStep(id, 'done'); }
    catch (e) { setProcStep(id, 'err', 'エラー: ' + e.message); throw e; }
  }

  try {
    // ① 必須：日程・実施日を保存
    if (currentPwType !== 'normal') {
      // 限定PW: フェーズ形式（PHASE/DATE）でカレンダーシートに保存
      const toYMD = obj => obj ? `${obj.y}/${String(obj.m).padStart(2,'0')}/${String(obj.d).padStart(2,'0')}` : '';
      const phasesForGas = adminPhases.map(p => ({
        apply:    toYMD(p.apply),
        deadline: toYMD(p.deadline),
        open:     toYMD(p.open),
        slots: (p.slots || []).map(s => ({ y: s.y, m: s.m, d: s.d, time: s.time, interval: s.interval || 15 }))
      }));
      await runTask('calregen', () => apiPost({ action: 'updateLimitedCalendarSlots', type: currentPwType, phases: phasesForGas }));
    } else {
      // 通常PW: フラット形式（B3/B4/B5 + Row9以降）でカレンダーシートに保存（カレンダー履歴への追記も含む）
      const cleanSlots = slots.map(s => ({ ...s, interval: parseInt(s.interval) || 15, y: parseInt(s.y), m: parseInt(s.m), d: parseInt(s.d) }));
      await runTask('calregen', () => apiGet('updateCalendarSlots', { slots: cleanSlots, year: curY, month: curM, apply: dates.apply, deadline: dates.deadline, open: dates.open }));
    }
    if (monthlyChecks.calpub) await runTask('calpub', () => apiGet('publishCalendar', { year: curY, month: curM }));
    if (monthlyChecks.form) {
      document.querySelectorAll('.map-sel-m').forEach(s => { monthlyMappingResult[s.dataset.key] = s.value; });
      await runTask('form', () => apiGet('createFormSheet', { year: curY, month: curM, mapping: monthlyMappingResult }));
    }
    if (monthlyChecks.shift) await runTask('shift', () => apiGet('createShiftSheet', { year: curY, month: curM }));

    datesChanged = false;
    updSaveDatesBtn();
    document.getElementById('proc-steps').style.display = 'none';
    setProcMsg('再読み込み中...', '処理が完了しました。データを更新しています');
    try { await refreshAdminData(); } catch (e) { console.warn('[refreshAdminData]', e); }
    hideProc();
    toast('募集開始処理が完了しました', 's');
  } catch (e) {
    document.getElementById('proc-spin').style.display = 'none';
    setProcMsg('エラーが発生しました', 'ネットワークの状態を確認して、もう一度最初からお試しください');
    document.getElementById('proc-close-btn').style.display = '';
    toast('処理中にエラーが発生しました', 'e');
  }
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
    // 年月セレクタ
    const ymHtml = buildPhotoYmSelector();
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
  let opts = '';
  for (let delta = -3; delta <= 3; delta++) {
    let y = curY, m = curM + delta;
    while (m < 1)  { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    const sel = (y === _photoMgmtYear && m === _photoMgmtMonth) ? ' selected' : '';
    opts += '<option value="' + y + '_' + m + '"' + sel + '>' + y + '年' + m + '月</option>';
  }
  return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
    + '<span style="font-size:12px;color:var(--ink2);font-weight:700;">対象月：</span>'
    + '<select style="font-size:13px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;" onchange="onPhotoYmChange(this.value)">' + opts + '</select>'
    + '</div>';
}

async function onPhotoYmChange(val) {
  const parts = val.split('_');
  _photoMgmtYear  = parseInt(parts[0]);
  _photoMgmtMonth = parseInt(parts[1]);
  await loadPhotoMgmtList();
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
  if (!confirm('この写真を削除しますか？')) return;
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
// メンバー管理モーダル
// ============================================================
let _memberList = [];
let _memberEditRowIndex = null; // 編集中のrowIndex

async function openMemberModal() {
  openM('m-member');
  document.getElementById('m-member-body').innerHTML = '<div style="padding:20px;text-align:center;color:var(--ink3);">読み込み中...</div>';
  document.getElementById('m-member-add-btn').style.display = '';
  try {
    const res = await apiGet('getMemberListAll');
    if (!res.ok) throw new Error(res.error || '取得失敗');
    _memberList = res.members || [];
    renderMemberList();
  } catch(e) {
    document.getElementById('m-member-body').innerHTML = '<div style="padding:20px;color:var(--red);">エラー: ' + esc(e.message) + '</div>';
  }
}

function renderMemberList() {
  _memberEditRowIndex = null;
  document.getElementById('m-member-add-btn').style.display = '';
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
          <span class="member-name">${esc(m.name)}</span>
          <span class="member-kana">${esc(m.furigana)}</span>
          <span class="member-gender-badge ${m.gender === 'M' ? 'mgb-m' : 'mgb-f'}">${m.gender === 'M' ? '男' : '女'}</span>
          ${m.isResponsible ? '<span class="role-badge rb-resp">責任者</span>' : ''}
          ${m.isCart        ? '<span class="role-badge rb-cart">カート</span>' : ''}
          ${m.isAdmin       ? '<span class="role-badge rb-admin">管理者</span>' : ''}
          ${m.isShiftApprover ? '<span class="role-badge rb-appr">確認者</span>' : ''}
          ${m.isAccountant  ? '<span class="role-badge rb-acct">会計者</span>' : ''}
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
  document.getElementById('m-member-add-btn').style.display = 'none';
  const isOwner = !_currentUser?.uid; // uidが空＝オーナーアカウント
  document.getElementById('m-member-body').innerHTML = buildMemberForm(null, isOwner);
}

function openMemberEditForm(rowIndex) {
  _memberEditRowIndex = rowIndex;
  document.getElementById('m-member-add-btn').style.display = 'none';
  const m = _memberList.find(x => x.rowIndex === rowIndex);
  if (!m) return;
  const isOwner = !_currentUser?.uid;
  document.getElementById('m-member-body').innerHTML = buildMemberForm(m, isOwner);
}

function buildMemberForm(m, isOwner) {
  const isEdit = !!m;
  const emailReadonly = isEdit && !isOwner;
  return `
  <div style="padding:14px 16px;">
    <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:14px;">${isEdit ? '✏️ メンバー編集' : '➕ メンバー追加'}</div>
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
        <div style="display:flex;gap:12px;align-items:center;padding:6px 0;">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="radio" name="mf-gender" value="M" ${(!m || m.gender === 'M') ? 'checked' : ''}> 男
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="radio" name="mf-gender" value="F" ${(m?.gender === 'F') ? 'checked' : ''}> 女
          </label>
        </div>
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
        <div style="display:flex;gap:16px;padding:6px 0;">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="mf-resp" ${m?.isResponsible ? 'checked' : ''}> 責任者
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="mf-cart" ${m?.isCart ? 'checked' : ''}> カート担当
          </label>
        </div>
      </div>
      <div class="mf-row">
        <label class="mf-lbl">権限
          ${!isOwner ? '<span style="font-size:10px;color:var(--ink3);font-weight:400;margin-left:4px;">（オーナーアカウントのみ変更可）</span>' : ''}
        </label>
        <div style="display:flex;gap:16px;padding:6px 0;">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;${isOwner ? 'cursor:pointer;' : 'opacity:.6;'}">
            <input type="checkbox" id="mf-admin" ${m?.isAdmin ? 'checked' : ''} ${isOwner ? '' : 'disabled'}> 管理者
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;${isOwner ? 'cursor:pointer;' : 'opacity:.6;'}">
            <input type="checkbox" id="mf-acct" ${m?.isAccountant ? 'checked' : ''} ${isOwner ? '' : 'disabled'}> 会計者
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;${isOwner ? 'cursor:pointer;' : 'opacity:.6;'}">
            <input type="checkbox" id="mf-approver" ${m?.isShiftApprover ? 'checked' : ''} ${isOwner ? '' : 'disabled'}> シフト確認者
          </label>
        </div>
        ${isOwner ? '<div style="font-size:11px;color:var(--ink3);line-height:1.6;">※ 権限は先に付与できますが、本人がログインできるのはメールアドレス登録後です。<br>※ 「シフト確認者」は管理者権限が前提です。作成担当者が「シフト作成完了」にした後、確認者全員が「確認完了」にするまで奉仕者へ公開されません。</div>' : ''}
      </div>
      ${isEdit ? `
      <div class="mf-row">
        <label class="mf-lbl">ステータス</label>
        <div style="display:flex;gap:12px;align-items:center;padding:6px 0;">
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="radio" name="mf-valid" value="1" ${m.valid ? 'checked' : ''}> 有効
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;">
            <input type="radio" name="mf-valid" value="0" ${!m.valid ? 'checked' : ''}> 無効
          </label>
        </div>
        ${m.valid ? '<div style="font-size:11px;color:var(--amber);line-height:1.6;">⚠️ 無効にすると、この方に関する代理送信設定・管理者権限・会計者権限は自動的に削除されます。</div>' : ''}
      </div>` : ''}
      <div id="mf-err" style="display:none;color:var(--red);font-size:12px;padding:6px 10px;background:var(--red-l);border-radius:var(--r);"></div>
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
  const gender   = document.querySelector('input[name="mf-gender"]:checked')?.value || '';
  const email    = (document.getElementById('mf-email')?.value || '').trim();
  const isResp   = document.getElementById('mf-resp')?.checked || false;
  const isCart   = document.getElementById('mf-cart')?.checked || false;
  const isAdmin  = document.getElementById('mf-admin')?.checked || false;
  const isAcct   = document.getElementById('mf-acct')?.checked || false;
  const isAppr   = document.getElementById('mf-approver')?.checked || false;
  const validVal = document.querySelector('input[name="mf-valid"]:checked')?.value;
  const valid    = validVal !== undefined ? validVal === '1' : true;

  const errEl = document.getElementById('mf-err');
  if (!name || !furigana || !gender) {
    errEl.style.display = '';
    errEl.textContent = '名前・フリガナ・性別は必須です。';
    return;
  }
  errEl.style.display = 'none';

  const adminUid  = _currentUser?.uid  || '';
  const adminName = _currentUser?.name || '';

  showProc(isEdit ? 'メンバー情報を更新しています...' : 'メンバーを追加しています...', '少々お待ちください');
  try {
    let res;
    if (isEdit) {
      res = await apiGet('updateMember', {
        rowIndex: _memberEditRowIndex,
        name, furigana, gender, email,
        isResponsible: isResp ? '1' : '',
        isCart: isCart ? '1' : '',
        isAdmin: isAdmin ? '1' : '',
        isAccountant: isAcct ? '1' : '',
        isShiftApprover: isAppr ? '1' : '',
        valid: valid ? '1' : '0',
        isOwner: isOwner ? '1' : '',
        adminUid, adminName
      });
    } else {
      res = await apiGet('addMember', {
        name, furigana, gender, email,
        isResponsible: isResp ? '1' : '',
        isCart: isCart ? '1' : '',
        isAdmin: isAdmin ? '1' : '',
        isAccountant: isAcct ? '1' : '',
        isShiftApprover: isAppr ? '1' : '',
        isOwner: isOwner ? '1' : '',
        adminUid, adminName
      });
    }
    if (!res.ok) throw new Error(res.error || '保存失敗');
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
    errEl.style.display = '';
    errEl.textContent = 'エラー: ' + e.message;
  }
}

function closeMemberForm() {
  closeM('m-member');
}

async function confirmDeleteMember(rowIndex) {
  const m = _memberList.find(x => x.rowIndex === rowIndex);
  if (!m) return;
  if (!confirm(`「${m.name}」を削除しますか？\nこの操作は元に戻せません。`)) return;

  const adminUid  = _currentUser?.uid  || '';
  const adminName = _currentUser?.name || '';
  showProc('メンバーを削除しています...', '少々お待ちください');
  try {
    const res = await apiGet('deleteMember', { rowIndex, adminUid, adminName });
    if (!res.ok) throw new Error(res.error || '削除失敗');
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
  document.getElementById('proc-spin').style.display = '';
  document.getElementById('proc-steps').style.display = 'none';
  document.getElementById('proc-steps').innerHTML = '';
  document.getElementById('proc-close-btn').style.display = 'none';
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
  el.style.display = 'flex';
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
  const d = await apiGet('adminData');
  adminData = d;
  if (d.eventDates) {
    const toObj = str => { if (!str) return null; const p = str.split('/'); return p.length === 2 ? { y: curY, m: parseInt(p[0]), d: parseInt(p[1]) } : null; };
    dates.apply    = toObj(d.eventDates['申込開始']);
    dates.deadline = toObj(d.eventDates['締切']);
    dates.open     = toObj(d.eventDates['シフト公開']);
  }
  if (d.currentSlots) slots = d.currentSlots.map(s => ({ y: s.y || curY, m: s.m || curM, d: s.d, time: s.time, interval: parseInt(s.interval) || 15 }));
  if (d.phases) {
    adminPhases = d.phases;
    currentPhaseIndex = 0;
    if (currentPwType !== 'normal') syncSlotsFromPhases();
  }
  renderAll();
  loadCalPubStatus();
  loadAutoPublishSettings();
}

// ============================================================
// 自動公開トグル
// ============================================================
async function loadAutoPublishSettings() {
  try {
    const r = await apiGet('getAutoPublishSettings');
    if (!r.ok) return;
    const calChk = document.getElementById('auto-pub-cal-chk');
    if (calChk) calChk.checked = r.calAuto;
  } catch (e) { console.warn('[loadAutoPublishSettings]', e); }
}

async function onAutoPublishChange() {
  const calAuto = document.getElementById('auto-pub-cal-chk')?.checked || false;
  try {
    const r = await apiGet('setAutoPublishSettings', { calAuto });
    if (!r.ok) throw new Error(r.error);
    toast('自動公開設定を保存しました', 's');
  } catch (e) {
    toast('自動公開設定の保存に失敗: ' + e.message, 'e');
    // 失敗時は元の状態に戻す
    loadAutoPublishSettings();
  }
}

