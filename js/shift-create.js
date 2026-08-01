// API_URL / ANON_KEY / CLIENT_ID は js/api.js（共有通信層）で定義

let currentPwType = (() => { try { return new URLSearchParams(location.search).get('type') || 'normal'; } catch(e) { return 'normal'; } })();
let adminUser     = null;
let memberFlags   = {};
let applicants    = [];
let shiftDates    = [];
let locations     = [];
let cartNumbers   = [];
let conflictMap   = {}; // uid -> { hasLimitedApply|hasNormalApply: dates[], hasLimitedSlot|hasNormalSlot: dates[] }
// 設定タブ（タブ3）専用：タブ2「シフト作成」の locations / cartNumbers（年月で絞り込まれた値）とは
// 完全に分離し、設定タブを開いている間はタブ2側の再読み込みに影響されないようにする
let settingsLocations    = [];
let settingsCartNumbers  = [];
let settingsVRules       = {};  // 検証ルールの上書き設定 { ruleId: {on, level} }
let memoMap       = {};
let respCounts    = {}; // UID別：当月の責任者 配置回数（保存済みデータのみ反映）
let cartCounts    = {}; // UID別：当月のカート担当 配置回数（保存済みデータのみ反映）
let slotAssignCounts = {}; // UID別：当月のシフト割当回数（1コマにつき1回。同一コマ内の複数行への配置はまとめて1回）
let defaultSlot   = 15;
let shiftPublished = false;
let shiftOpenDate  = ''; // 公開予定日（M/D形式）。作成完了していても、この日を迎えるまで奉仕者には見えない
// シフトの確認（承認）状況。確認者（メンバー管理で「確認者」に指定された管理者）全員が
// 確認完了にするまで奉仕者へは公開されない。required=0 なら確認者未登録＝確認不要
// オーナーアカウントは確認を省略して公開できる（approvalSkipped でその旨を表示する）
let shiftApproval = {
  approvers: [], required: 0, approvedCount: 0,
  isApprover: false, approvedByMe: false, approvedAll: false, notified: false,
  isOwner: false, approvalSkipped: false, doneByName: '', rejected: null
};
let activeDateIdx = 0;
let activeTimeIdx = 0;
let curYM         = null;  // 編集中の年月（ヘッダーの対象年月セレクタで切り替える）
let ymList        = [];    // カレンダーが存在する年月 [{year,month,calPublished,shiftPublished}]
let ymLoaded      = false; // ymList / publishedYM を取得済みか（未取得のうちは公開ボタンを制限しない）
let publishedYM   = null;  // 申込を受け付け中のカレンダーの年月 {year,month}（通常PWでは常に最大1ヶ月）
let shiftPubYMs   = [];    // シフトが作成完了になっている年月 [{year,month}]（申込中の月とずれうる）
let createLoaded  = false;
let settingsLoaded = false;
const bs = {};
window._blockCols = {};
let _scKnownTs   = null; // シフト作成データのリアルタイム同期用（最終更新タイムスタンプ）
let _scKnownWishTs = null; // シフト希望データのリアルタイム同期用（最終更新タイムスタンプ）
let _scPollTimer = null;
let _scPollListening = false;
let wishLoaded   = false;

// ===== オートセーブ =====
const _saveTimers    = {}; // bKey -> setTimeoutのid（デバウンス待ち）
const _saveInFlight   = {}; // bKey -> 保存中フラグ
const _savePending    = {}; // bKey -> 保存中に追加の編集が入った場合に立てるフラグ
const _saveRetried    = {}; // bKey -> 失敗時の自動リトライ（1回のみ）を予約済みか
const AUTOSAVE_DEBOUNCE_MS = 500;
const AUTOSAVE_RETRY_MS    = 5000;

// apiGet / apiAuthGet は js/api.js（共有通信層）で定義

// 年月依存のAPI（getWishData / getApplicants / getShiftCreateData / createShiftSheet と
// 公開操作系 publishShift / unpublishShift / approveShift / rejectShift / getShiftPublishStatus）には
// 必ず編集中の年月を渡す。curYM が未確定な初回読み込み時だけ付けず、サーバー既定
// （＝申込中カレンダーの年月）に従う。
// 公開操作系に年月が要るのは、前月のシフトが動いている最中に次月の申込を開始できるため。
// 年月を送らないと、重なり期間はサーバーが常に「申込中の月」を対象にしてしまい、
// 前月のシフトの取り消し・確認完了・差し戻しができなくなる
function ymP(extra) {
  return Object.assign({}, extra || {}, curYM ? { year: curYM.year, month: curYM.month } : {});
}

// ============================================================
// 認証
// ============================================================
async function initAuth() {
  try { const u = JSON.parse(localStorage.getItem('adminUser') || 'null'); if (u && u.isAdmin) { adminUser = u; showApp(); return; } } catch (_) {}
  // Googleアカウントが使えない管理者のための救済セッション（有効期限はサーバー側で検証）
  if (await tryRecoveryLogin()) return;

  // 共通ログイン画面でログイン済みなら引き継ぐ（管理者権限は必ずサーバーで確認する）
  const shared = pwgwsGetSession();
  if (shared) {
    try {
      setLoading(true, '権限を確認中...');
      const d = await apiAuthGet(shared.email, 'admin');
      setLoading(false);
      if (d.ok && d.isAdmin) {
        adminUser = { email: shared.email, name: d.name || shared.name || shared.email,
                      uid: d.uid || '', isAdmin: true, picture: shared.picture || '' };
        localStorage.setItem('adminUser', JSON.stringify(adminUser));
        showApp();
        return;
      }
    } catch (_) { setLoading(false); }
  }

  // 未ログイン・管理者権限なし：共通ログイン画面へ送る
  // （このアプリ内に認証画面は持たない）
  pwgwsGoToLogin(shared ? 'noadmin' : '');
}
async function tryRecoveryLogin() {
  let token = '';
  try { token = localStorage.getItem('pwgws_recovery_session') || ''; } catch (_) {}
  if (!token) return false;
  try {
    const res = await apiPost({ action: 'validateRecoverySession', sessionToken: token });
    if (!res.ok || !res.isAdmin) return false;
    adminUser = { email: '', name: res.name, uid: res.uid || '', isAdmin: true, picture: '', isRecoverySession: true };
    showApp();
    return true;
  } catch (_) { return false; }
}
function signOut() {
  try { localStorage.removeItem('adminUser'); } catch (_) {}
  // 共通セッション・救済ログインも併せて破棄する（3アプリ共通のログアウト）
  pwgwsClearSession();
  toast('ログアウトしました', 's');
  setTimeout(() => pwgwsGoToLogin(), 800);
}
function showApp() {

  document.getElementById('app-screen').style.display = 'flex';
  const icon = document.getElementById('acc-icon');
  if (icon && adminUser && adminUser.picture) {
    const img = document.createElement('img');
    img.src = adminUser.picture;
    img.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;';
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.onerror = () => { icon.innerHTML = '👤'; };
    icon.innerHTML = '';
    icon.appendChild(img);
  }
  loadInitData();
}

// ============================================================
// 初期読み込み
// ============================================================
async function loadInitData() {
  setLoading(true, 'データを読み込み中...');
  try {
    const [, statusRes, slotsRes] = await Promise.all([
      loadWishDataInternal(),
      fetchPublishStatus(),
      apiGet('getLimitedSlots', {}),
      loadYmList()
    ]);
    applyPublishStatus(statusRes);
    pwTypeList = slotsRes.ok ? (slotsRes.slots || []) : [];
    renderPwTabsSc();
    setLoading(false);
  }
  catch (e) { setLoading(false); toast('読み込みエラー: ' + e.message, 'e'); }
}

// ============================================================
// 対象年月セレクタ
// ============================================================
// カレンダーが存在する年月の一覧と、公開中カレンダーの年月を取得する。
// 限定PWはフェーズが複数月にまたがるため対象外（セレクタを出さない）
async function loadYmList() {
  if (currentPwType !== 'normal') { ymList = []; publishedYM = null; shiftPubYMs = []; ymLoaded = false; renderYmSelect(); return; }
  try {
    const r = await apiGet('getCalendarSheetList', {});
    ymList = r && r.ok ? (r.list || []) : [];
    ymLoaded = true;
  } catch (e) { ymList = []; ymLoaded = false; }
  // 通常PWの申込中カレンダーは常に最大1件だが、念のため最新の月を採用する
  // （サーバー側 getCurrentCal と同じ「年月の降順で先頭」の解釈に合わせる）
  const pubs = ymList.filter(c => c.calPublished);
  publishedYM = pubs.length > 0 ? { year: pubs[pubs.length - 1].year, month: pubs[pubs.length - 1].month } : null;
  // 作成完了になっている月。前月のシフトが動いている最中に次月の申込を開始すると
  // 前月は「申込中」ではなくなるため、申込中の月だけを操作対象にすると
  // 前月のシフトの取り消し・確認完了・差し戻しができなくなる
  shiftPubYMs = ymList.filter(c => c.shiftPublished).map(c => ({ year: c.year, month: c.month }));
  renderYmSelect();
  updatePublishBtn();
}

function ymKey(o) { return o ? o.year + '.' + o.month : ''; }
function isPublishedYM(o) { return !!(o && publishedYM && publishedYM.year === o.year && publishedYM.month === o.month); }
// シフトが作成完了になっている月か（申込は次の月に移っていてもシフトは動いていることがある）
function isShiftPubYM(o) { return !!o && shiftPubYMs.some(x => x.year === o.year && x.month === o.month); }

function renderYmSelect() {
  const wrap = document.getElementById('sc-ym-wrap');
  const sel  = document.getElementById('sc-ym-sel');
  if (!wrap || !sel) return;
  if (currentPwType !== 'normal' || ymList.length === 0) { wrap.style.display = 'none'; return; }
  const cur = ymKey(curYM);
  let html = ymList.map(c => {
    const v = c.year + '.' + c.month;
    // 申込中の月とシフトが動いている月は別々になりうるので、それぞれ区別して示す
    const tag = c.calPublished ? '（申込中）' : c.shiftPublished ? '（シフト公開中）' : '';
    return `<option value="${v}"${v === cur ? ' selected' : ''}>${c.year}年${c.month}月${tag}</option>`;
  }).join('');
  // 一覧に無い年月（カレンダー未作成の月）を表示している場合も選択肢として残す
  if (cur && !ymList.some(c => c.year + '.' + c.month === cur)) {
    html += `<option value="${cur}" selected>${curYM.year}年${curYM.month}月</option>`;
  }
  sel.innerHTML = html;
  wrap.style.display = 'flex';
  renderYmNote();
}

// 「いま奉仕者に公開されているのはどの月か」を常に明示する。
// 申込中の月とシフトが動いている月がずれることがあるので、その場合は両方書く
function renderYmNote() {
  const note = document.getElementById('sc-ym-note');
  if (!note) return;
  if (currentPwType !== 'normal' || !curYM || !ymLoaded) { note.textContent = ''; note.className = 'ym-note'; return; }
  const pubTxt = publishedYM ? publishedYM.year + '年' + publishedYM.month + '月' : '';
  if (isPublishedYM(curYM)) {
    note.textContent = 'この月が申込中';
    note.className = 'ym-note ok';
  } else if (isShiftPubYM(curYM)) {
    note.textContent = 'この月のシフトが公開中' + (pubTxt ? '（申込は ' + pubTxt + '）' : '');
    note.className = 'ym-note ok';
  } else if (publishedYM) {
    note.textContent = '申込中は ' + pubTxt + '（表示中の月は未公開）';
    note.className = 'ym-note warn';
  } else {
    note.textContent = '公開中の月はありません';
    note.className = 'ym-note warn';
  }
}

function setYmSwitching(on) {
  const sel = document.getElementById('sc-ym-sel');
  if (sel) sel.disabled = !!on;
  document.querySelectorAll('.main-tabs .mtab').forEach(b => { b.disabled = !!on; });
  document.querySelectorAll('#pw-tabs .pw-tab-sc').forEach(b => { b.disabled = !!on; });
}

async function onYmChange(val) {
  const parts = (val || '').split('.');
  const y = parseInt(parts[0]), m = parseInt(parts[1]);
  if (!y || !m) return;
  if (curYM && curYM.year === y && curYM.month === m) return;
  await flushPendingSave(activeTimeIdx);
  curYM = { year: y, month: m };
  resetMonthState();
  renderYmNote();
  updatePublishBtn();

  setYmSwitching(true);
  setLoading(true, y + '年' + m + '月 のデータを読み込み中...');
  try {
    const wishOn   = splitMode || document.getElementById('tab-wish').classList.contains('on');
    const createOn = splitMode || document.getElementById('tab-create').classList.contains('on');
    if (wishOn) await loadWishDataInternal();
    setLoading(false);
    // loadCreateData は自前でオーバーレイを表示する
    if (createOn) await loadCreateData();
  } catch (e) {
    toast('読み込みエラー: ' + e.message, 'e');
  } finally {
    setLoading(false);
    setYmSwitching(false);
    renderYmSelect();
  }
}

// 月を切り替えるとシフト・申込は全て別データになるため、キャッシュと編集状態を捨てる
function resetMonthState() {
  createLoaded = false;
  wishLoaded   = false;
  applicants   = [];
  shiftDates   = [];
  Object.keys(bs).forEach(k => delete bs[k]);
  Object.keys(_saveTimers).forEach(k => { clearTimeout(_saveTimers[k]); delete _saveTimers[k]; });
  Object.keys(_saveInFlight).forEach(k => delete _saveInFlight[k]);
  Object.keys(_savePending).forEach(k => delete _savePending[k]);
  Object.keys(_saveRetried).forEach(k => delete _saveRetried[k]);
  Object.keys(_srvSig).forEach(k => delete _srvSig[k]);
  window._blockCols  = {};
  window._cartUnlock = {};
  clearUndo();
  activeDateIdx = 0;
  activeTimeIdx = 0;
  // 更新監視の基準は月ごとに取り直す
  _scKnownTs = null;
  _scKnownWishTs = null;
}

// ============================================================
// タブ切り替え
// ============================================================
// ============================================================
// PWタイプタブ（通常PW / 限定PW切り替え）
// ============================================================
let pwTypeList = [];  // [{id:'limited2', name:'テストPW'}, ...]

function renderPwTabsSc() {
  const bar = document.getElementById('pw-tabs');
  if (!bar) return;
  if (pwTypeList.length === 0) { bar.style.display = 'none'; return; }
  let html = `<button class="pw-tab-sc${currentPwType === 'normal' ? ' on' : ''}" onclick="switchPwTypeSc('normal')">通常PW</button>`;
  pwTypeList.forEach(s => {
    html += `<button class="pw-tab-sc${currentPwType === s.id ? ' on' : ''}" onclick="switchPwTypeSc('${s.id}')">${esc(s.name)}</button>`;
  });
  bar.innerHTML = html;
  bar.style.display = 'flex';
}

async function switchPwTypeSc(type) {
  if (currentPwType === type) return;
  await flushPendingSave(activeTimeIdx);
  currentPwType = type;
  renderPwTabsSc();

  // キャッシュ・状態をリセット
  curYM = null;
  createLoaded = false;
  settingsLoaded = false;
  memberFlags = {};
  applicants = [];
  shiftDates = [];
  Object.keys(bs).forEach(k => delete bs[k]);
  Object.keys(_saveTimers).forEach(k => { clearTimeout(_saveTimers[k]); delete _saveTimers[k]; });
  Object.keys(_saveInFlight).forEach(k => delete _saveInFlight[k]);
  Object.keys(_savePending).forEach(k => delete _savePending[k]);
  Object.keys(_saveRetried).forEach(k => delete _saveRetried[k]);
  window._blockCols = {};
  // 更新監視のタイムスタンプは pw_type ごとに別キーなので基準を取り直す
  _scKnownTs = null;
  _scKnownWishTs = null;

  const label = type === 'normal' ? '通常PW' : (pwTypeList.find(s => s.id === type)?.name || '限定PW');
  setLoading(true, label + ' のデータを読み込み中...');
  try {
    // 公開状態・対象年月の候補は常に更新
    const [statusRes] = await Promise.all([fetchPublishStatus(), loadYmList()]);
    applyPublishStatus(statusRes);

    // 表示中のタブ（分割表示なら両方）を再読み込み
    const wishOn     = splitMode || document.getElementById('tab-wish').classList.contains('on');
    const createOn   = splitMode || document.getElementById('tab-create').classList.contains('on');
    const settingsOn = document.getElementById('tab-settings').classList.contains('on');
    if (wishOn) await loadWishDataInternal();
    setLoading(false);
    // loadCreateData / loadSettingsData は自前でオーバーレイを表示する
    if (createOn)   await loadCreateData();
    if (settingsOn) await loadSettingsData();
  } catch (e) {
    setLoading(false);
    toast('読み込みエラー: ' + e.message, 'e');
  }
}

function switchMainTab(name, btn) {
  if (splitMode && (name === 'wish' || name === 'create')) return;
  if (splitMode && name === 'settings') {
    splitMode = false;
    document.getElementById('content-wrapper').classList.remove('split');
    const sb = document.getElementById('split-btn');
    if (sb) { sb.classList.remove('on'); sb.textContent = '⬛ 分割表示'; }
  }
  document.querySelectorAll('.main-tabs .mtab').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('on'));
  document.getElementById('tab-' + name).classList.add('on');
  // 年月を切り替えると各タブのデータは無効になる（resetMonthState でフラグを落とす）ため、
  // 未読み込みのタブを開いたときに読み直す
  updateCreateToolsVis();
  // 非表示のまま組まれた表は高さを測れず段差が既定値のままなので、
  // 見えるようになったこの時点で測り直す
  if (name === 'wish') fixWishHeadOffset();
  if (name === 'wish' && !wishLoaded) loadWishData();
  if (name === 'create' && !createLoaded) loadCreateData();
  if (name === 'settings' && !settingsLoaded) loadSettingsData();
}

// 「元に戻す」「チェック」はシフト作成タブ専用。作成タブ表示中（分割表示中も含む）だけ出す
function updateCreateToolsVis() {
  const el = document.getElementById('create-tools');
  if (!el) return;
  const on = splitMode || document.getElementById('tab-create').classList.contains('on');
  el.style.display = on ? 'flex' : 'none';
}
// ===== 分割表示 =====
let splitMode = false;
function toggleSplitView() {
  splitMode = !splitMode;
  const wrapper = document.getElementById('content-wrapper');
  const btn = document.getElementById('split-btn');
  const rsz = document.getElementById('split-rsz');
  if (splitMode) {
    document.getElementById('tab-wish').style.flex = '';
    document.getElementById('tab-create').style.flex = '';
    wrapper.classList.add('split');
    btn.classList.add('on');
    btn.textContent = '⊡ 分割解除';
    if (rsz) rsz.style.display = 'block';
    updateCreateToolsVis();
    if (!createLoaded) loadCreateData();
  } else {
    wrapper.classList.remove('split');
    btn.classList.remove('on');
    btn.textContent = '⬛ 分割表示';
    if (rsz) rsz.style.display = 'none';
    document.getElementById('tab-wish').style.flex = '';
    document.getElementById('tab-create').style.flex = '';
    switchMainTab('wish', document.getElementById('mtab-wish'));
  }
}
// ===== 比較モード =====
let compareMode = false, cmpDateIdx = 0, cmpTimeIdx = 0;
function toggleCompareMode() {
  compareMode = !compareMode;
  const panel = document.getElementById('cmp-panel');
  const btn = document.getElementById('cmp-toggle-btn');
  const rsz = document.getElementById('cmp-rsz');
  if (compareMode) {
    panel.classList.add('on');
    if (rsz) rsz.style.display = 'block';
    btn.textContent = '⊡ 比較解除';
    btn.style.cssText = 'border-color:var(--purple);color:var(--purple);white-space:nowrap;';
    populateCmpDateSel();
  } else {
    panel.classList.remove('on');
    if (rsz) rsz.style.display = 'none';
    btn.textContent = '⬜ 比較';
    btn.style.cssText = 'border-color:var(--teal);color:var(--teal);white-space:nowrap;';
    const rmWrap = document.querySelector('#tab-create .rm-wrap');
    if (rmWrap) rmWrap.style.flex = '';
    panel.style.flex = '';
  }
}
function populateCmpDateSel() {
  const sel = document.getElementById('cmp-date-sel');
  if (!sel) return;
  const dt = window._dateTabs || [];
  sel.innerHTML = '<option value="">日付を選択...</option>';
  dt.forEach((t, i) => { sel.innerHTML += `<option value="${i}">${esc(t.date)}（${esc(t.weekday)}）</option>`; });
  document.getElementById('cmp-time-sel').innerHTML = '<option value="">時間帯を選択...</option>';
}
function onCmpDateChange() {
  const dateSel = document.getElementById('cmp-date-sel');
  const timeSel = document.getElementById('cmp-time-sel');
  const i = parseInt(dateSel.value);
  if (isNaN(i)) {
    timeSel.innerHTML = '<option value="">時間帯を選択...</option>';
    document.getElementById('cmp-content').innerHTML = '<div style="padding:24px;color:var(--ink3);text-align:center;">比較する日付・時間帯を選択してください</div>';
    return;
  }
  cmpDateIdx = i;
  const tab = (window._dateTabs || [])[i];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  timeSel.innerHTML = '<option value="">時間帯を選択...</option>';
  dayBlocks.forEach((b, bi) => { timeSel.innerHTML += `<option value="${bi}">${esc(b.time)}</option>`; });
  document.getElementById('cmp-content').innerHTML = '<div style="padding:24px;color:var(--ink3);text-align:center;">時間帯を選択してください</div>';
}
function onCmpTimeChange() {
  const timeSel = document.getElementById('cmp-time-sel');
  const bi = parseInt(timeSel.value);
  if (isNaN(bi)) return;
  cmpTimeIdx = bi;
  renderCmpBlock();
}
function renderCmpBlock() {
  const tab = (window._dateTabs || [])[cmpDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  const block = dayBlocks[cmpTimeIdx];
  if (!block) return;
  document.getElementById('cmp-content').innerHTML = buildCmpBlock(block);
}
function getCmpColPlaces(block) {
  if (block.usedPlaces && block.usedPlaces.length > 0) return [...block.usedPlaces];
  if (block.place && (block.place.p1 || block.place.p2)) return [block.place.p1, block.place.p2].filter(Boolean);
  return locations.filter(l => !l.startYM && !l.endYM).map(l => l.name);
}
function buildCmpBlock(block) {
  const nm = buildNameMap();
  const cols = getCmpColPlaces(block);
  const slots = block.slots || [];
  const resp = block.responsible || {};
  const cart = block.cart || {};
  const pc = ['#e0f2fe','#fef9c3','#fce7f3','#dcfce7','#ede9fe'];
  const r1name = resp.r1 ? (nm[resp.r1] || resp.r1) : '—';
  const r2name = resp.r2 ? (nm[resp.r2] || resp.r2) : '—';
  const { ki1='', ki2='', ko1='', ko2='' } = cart;
  let html = `<div class="tb">`;
  html += `<div class="tb-hd"><span class="tb-time" style="color:var(--purple);">${esc(block.date)}（${esc(block.weekday)}） ${esc(block.time)}</span></div>`;
  html += `<div class="resp-area"><div class="area-title">責任者（最大2名）</div><div class="ra-row">
    <div class="ra-item"><span class="ra-label">担当①</span><span style="font-size:13px;font-weight:700;">${esc(r1name)}</span></div>
    <div class="ra-item"><span class="ra-label">担当②</span><span style="font-size:13px;font-weight:700;">${esc(r2name)}</span></div>
  </div></div>`;
  html += `<div class="cart-area"><div class="area-title cart-title">カート担当者</div>
    <div class="tbl-wrap"><table class="cart-tbl">
      <thead><tr><th style="width:90px;"></th><th colspan="2">持ち込み</th><th colspan="2">持ち帰り</th></tr></thead>
      <tbody><tr><td class="row-lbl">担当者</td>
        <td style="font-weight:700;">${esc(ki1 ? (nm[ki1]||ki1) : '—')}</td><td style="font-weight:700;">${esc(ki2 ? (nm[ki2]||ki2) : '—')}</td>
        <td style="font-weight:700;">${esc(ko1 ? (nm[ko1]||ko1) : '—')}</td><td style="font-weight:700;">${esc(ko2 ? (nm[ko2]||ko2) : '—')}</td>
      </tr></tbody>
    </table></div>
  </div>`;
  if (slots.length === 0) {
    html += `<div style="padding:12px;color:var(--ink3);font-size:12px;">スロットなし</div>`;
  } else if (cols.length === 0) {
    html += `<div style="padding:12px;color:var(--ink3);font-size:12px;">場所が設定されていません</div>`;
  } else {
    html += `<div class="tbl-wrap"><table class="shift-tbl"><thead><tr><th class="th-slot-time">場所</th>`;
    cols.forEach((loc, li) => { html += `<th class="th-place" style="background:${pc[li%pc.length]};">${esc(loc||'—')}</th>`; });
    html += `</tr></thead><tbody>`;
    slots.forEach(slot => {
      html += `<tr><td class="td-slot-time">${esc(slot.time)}</td>`;
      cols.forEach((loc, li) => {
        const uids = Array.isArray(slot.places) ? ((slot.places || [])[li] || []) : ((slot.places && slot.places[loc]) ? slot.places[loc] : []);
        const names = uids.map(uid => nm[uid]||uid).filter(Boolean);
        html += `<td class="cell-w" style="background:${pc[li%pc.length]}20;">`;
        html += names.length > 0 ? names.map(n => `<div style="padding:2px 0;font-size:12px;">${esc(n)}</div>`).join('') : `<div style="color:var(--ink3);">—</div>`;
        html += `</td>`;
      });
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;
  }
  html += `</div>`;
  return html;
}
function toggleAccMenu() {
  document.getElementById('acc-menu').classList.toggle('on');
}
document.addEventListener('click', e => {
  const wrap = document.querySelector('.acc-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('acc-menu').classList.remove('on');
});

// ============================================================
// TAB1: 希望確認
// ============================================================
async function loadWishData() {
  document.getElementById('wish-table-wrap').innerHTML = '<div class="empty-msg">読み込み中...</div>';
  setLoading(true, 'シフト希望を取得中...');
  try { await loadWishDataInternal(); } catch (e) { toast('読み込みエラー: ' + e.message, 'e'); } finally { setLoading(false); }
}
async function loadWishDataInternal() {
  // getWishData と getMemberFlags と getShiftCreateData を並行取得
  const [res, flagsRes, shiftRes] = await Promise.all([
    apiGet('getWishData', ymP()),
    Object.keys(memberFlags).length > 0 ? Promise.resolve({ ok: true, flags: memberFlags }) : apiGet('getMemberFlags'),
    apiGet('getShiftCreateData', ymP())
  ]);
  const year  = res.year  || new Date().getFullYear();
  const month = res.month || new Date().getMonth() + 1;
  if (!curYM) { curYM = { year, month }; renderYmSelect(); }
  document.getElementById('hdr-title').textContent = 'シフト管理アプリ — ' + year + '年' + month + '月';
  document.getElementById('ws-ym').textContent     = year + '年' + month + '月';
  if (!res.ok) throw new Error(res.error || '取得失敗');
  // memberFlagsを更新（未取得だった場合）
  if (flagsRes.ok && Object.keys(memberFlags).length === 0) memberFlags = flagsRes.flags || {};
  document.getElementById('ws-applied').textContent = res.appliedCount || 0;
  document.getElementById('ws-total').textContent   = res.totalMembers || 0;
  if (!res.members || res.members.length === 0 || !res.slots || res.slots.length === 0) {
    document.getElementById('wish-table-wrap').innerHTML = '<div class="empty-msg">データがありません。<br>シフト希望シートが作成されているか確認してください。</div>';
  } else { buildWishTable(res, shiftRes.ok ? shiftRes : null); }
  wishLoaded = true;
  // 取得直後にローカルの shiftDates（未保存の編集を含む）で割当表示を上書きする
  if (createLoaded) refreshWishAssign();
  // 直前に自分で再読み込みした内容を「他者の変更」として再検知しないよう基準を取り直す
  _scKnownWishTs = null;
  if (!_scPollTimer) startShiftCreateSync();
}
function buildAssignmentMap(shiftRes) {
  const map = {};
  if (!shiftRes || !shiftRes.dates) return map;
  shiftRes.dates.forEach(block => {
    const blockKey = block.date + '(' + block.weekday + ') ' + block.time;
    (block.slots || []).forEach(slot => {
      Object.values(slot.places || {}).forEach(uids => {
        (uids || []).forEach(uid => {
          if (!uid) return;
          if (!map[uid]) map[uid] = new Set();
          map[uid].add(blockKey);
        });
      });
    });
  });
  return map;
}
function wishCellClass(applied, isAssigned) {
  if (applied) return isAssigned ? 'cell-data cell-on' : 'cell-data';
  return isAssigned ? 'cell-data cell-on' : 'cell-data cell-off';
}
function wishCellInner(applied, isAssigned, hasComment) {
  if (!applied && !isAssigned) return '';
  return `<span class="check-mark">〇</span>${applied && hasComment ? '<span class="note-mark">📝</span>' : ''}`;
}

// シフト作成側の割当が変わったときに、希望確認テーブルの「割当」列と紫セル（cell-on）だけを
// 差分更新する。テーブル全体を作り直さないのでスクロール位置が保たれ、分割表示中でも軽い。
// 参照するのはローカルの shiftDates なので、未保存の編集もそのまま反映される。
function refreshWishAssign() {
  // 未申込者テーブルも含め、希望確認タブ内の全テーブルを対象にする
  const wrap = document.getElementById('wish-table-wrap');
  if (!wrap || !wrap.querySelector('table.wish-tbl')) return;
  const assignMap = buildAssignmentMap({ dates: shiftDates });
  const counts = {};
  wrap.querySelectorAll('td[data-slot]').forEach(td => {
    const uid = td.dataset.uid, slot = td.dataset.slot;
    const isAssigned = !!(assignMap[uid] && assignMap[uid].has(slot));
    if (isAssigned) counts[uid] = (counts[uid] || 0) + 1;
    const applied = td.dataset.applied === '1';
    const cls = wishCellClass(applied, isAssigned);
    if (td.className !== cls) td.className = cls;
    // 申込ありのセルは〇と📝が常に出ているため中身の書き換えは不要
    if (!applied) {
      const inner = wishCellInner(false, isAssigned, false);
      if (td.innerHTML !== inner) td.innerHTML = inner;
    }
  });
  wrap.querySelectorAll('td[data-assign-total]').forEach(td => {
    const n = String(counts[td.dataset.assignTotal] || 0);
    if (td.textContent !== n) td.textContent = n;
  });
}

function buildWishTable(data, shiftRes) {
  const { members, slots, matrix } = data;
  const assignMap = buildAssignmentMap(shiftRes);

  // 日付+時間帯をカレンダー順にソート
  const sortedSlots = [...slots].sort((a, b) => {
    const spA = a.indexOf(' '), spB = b.indexOf(' ');
    const dpA = spA >= 0 ? a.slice(0, spA) : a;
    const dpB = spB >= 0 ? b.slice(0, spB) : b;
    const taStr = spA >= 0 ? a.slice(spA + 1) : '';
    const tbStr = spB >= 0 ? b.slice(spB + 1) : '';
    const slA = dpA.indexOf('/'), slB = dpB.indexOf('/');
    const ma = parseInt(dpA.slice(0, slA)), dda = parseInt(dpA.slice(slA + 1));
    const mb = parseInt(dpB.slice(0, slB)), ddb = parseInt(dpB.slice(slB + 1));
    if (ma !== mb) return ma - mb;
    if (dda !== ddb) return dda - ddb;
    const toMin = s => { const m = s.match(/^(\d+):(\d+)/); return m ? +m[1]*60 + +m[2] : 0; };
    return toMin(taStr) - toMin(tbStr);
  });

  // 日付グループ構築
  const dg = []; const seen = new Set();
  sortedSlots.forEach(slot => {
    const si = slot.indexOf(' '), dk = si >= 0 ? slot.slice(0, si) : slot;
    const sl = dk.indexOf('/');
    const paren = dk.indexOf('(');
    const dateNum = sl >= 0 ? dk.slice(0, paren >= 0 ? paren : undefined) : dk;
    if (!seen.has(dk)) { seen.add(dk); dg.push({ date: dk, dateNum, times: [] }); }
    dg.find(g => g.date === dk).times.push(slot);
  });

  // 申込スロット数・割当済みスロット数（matrixに無いuid＝未申込は0になる）
  const slotCountFor   = uid => sortedSlots.filter(slot => matrix[uid] && matrix[uid][slot]).length;
  const assignCountFor = uid => sortedSlots.filter(slot => assignMap[uid] && assignMap[uid].has(slot)).length;

  // 未申込者を抽出（memberFlagsの全メンバーのうち、matrixにいない人）
  // 受付終了後に個別連絡で希望を追加できるよう、セルをクリック編集可能にする
  const appliedUids = new Set(members.map(m => m.uid));
  const notAppliedMembers = Object.entries(memberFlags)
    .filter(([uid]) => !appliedUids.has(uid))
    .map(([uid, f]) => ({ uid, name: f.name, furigana: f.furigana || '' }))
    .sort((a, b) => a.furigana.localeCompare(b.furigana) || a.name.localeCompare(b.name));

  const buildHeadRows = () => {
    let h = '<tr><th class="col-name th-date" rowspan="2" style="position:sticky;top:0;left:0;z-index:11;">氏名</th>';
    dg.forEach(g => { h += `<th class="th-date" colspan="${g.times.length}" style="position:sticky;top:0;z-index:3;">${esc(g.date)}</th>`; });
    h += '<th class="th-date" rowspan="2" style="position:sticky;top:0;right:50px;z-index:11;min-width:50px;">合計</th>';
    h += '<th class="th-date" rowspan="2" style="position:sticky;top:0;right:0;z-index:11;min-width:50px;background:var(--purple-l);color:var(--purple);">割当</th></tr><tr>';
    // top は日付行の高さと一致していないといけない。28px 決め打ちだと余白や
    // 文字サイズを変えた瞬間にズレ、隙間から下の行がちらついて見える。
    // 実際の高さを描画後に --th-date-h へ入れる（fixWishHeadOffset）
    // 既定値は実測が効かなかったときの保険。日付行はスマホで約27.5px・PCで約29.5px
    // なので、どちらでも隙間側に倒れないよう小さめ（26px＝必ず重なる）にしてある
    sortedSlots.forEach(slot => { const si = slot.indexOf(' '); h += `<th class="th-time" style="position:sticky;top:var(--th-date-h,26px);z-index:3;">${esc(si >= 0 ? slot.slice(si + 1) : slot)}</th>`; });
    h += '</tr>';
    return h;
  };

  const buildRow = (uid, name) => {
    const row = matrix[uid] || {};
    let r = '<tr><td class="col-name" style="position:sticky;left:0;z-index:2;">' + esc(name) + '</td>';
    sortedSlots.forEach(slot => {
      const val = row[slot];
      const isAssigned = !!(assignMap[uid] && assignMap[uid].has(slot));
      const hc = typeof val === 'object' && val.comment;
      // onclick に埋めるので改行は \n のままでは JS 文字列が切れる。エスケープしてから渡す
      const comment = hc ? String(val.comment).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n') : '';
      // data-uid / data-slot / data-applied は refreshWishAssign() の差分更新用
      const dataAttr = `data-uid="${esc(uid)}" data-slot="${esc(slot)}" data-applied="${val ? 1 : 0}"`;
      r += `<td class="${wishCellClass(!!val, isAssigned)}" style="cursor:pointer;" ${dataAttr} onclick="openWishEdit(this,'${esc(uid)}','${esc(name)}','${esc(slot)}',${val ? 'true' : 'false'},'${esc(comment)}')">${wishCellInner(!!val, isAssigned, !!hc)}</td>`;
    });
    r += `<td class="cell-data" style="position:sticky;right:50px;background:var(--green4);font-weight:700;color:var(--green);z-index:2;">${slotCountFor(uid)}</td>`;
    r += `<td class="cell-data" data-assign-total="${esc(uid)}" style="position:sticky;right:0;background:var(--purple-l);font-weight:700;color:var(--purple);z-index:2;">${assignCountFor(uid)}</td>`;
    r += '</tr>';
    return r;
  };

  let html = '<div class="wish-snap-outer"><table class="wish-tbl">';
  html += '<thead>' + buildHeadRows() + '</thead><tbody>';
  members.forEach(m => { html += buildRow(m.uid, m.name); });

  // 申込数集計行
  html += '<tr style="background:var(--green4);"><td class="col-name" style="font-weight:700;color:var(--green-d);position:sticky;left:0;z-index:2;">申込数</td>';
  sortedSlots.forEach(slot => { let c = 0; members.forEach(m => { if (matrix[m.uid] && matrix[m.uid][slot]) c++; }); html += `<td class="cell-data" style="font-weight:700;color:var(--green);">${c}</td>`; });
  html += '<td class="cell-data" style="position:sticky;right:50px;background:var(--green4);z-index:2;"></td>';
  html += '<td class="cell-data" style="position:sticky;right:0;background:var(--purple-l);z-index:2;"></td></tr>';
  html += '</tbody></table></div>';

  // 未申込一覧（折りたたみ）：セルをクリックすると希望を追加できる
  if (notAppliedMembers.length > 0) {
    html += `<div class="wish-not-applied-toggle" onclick="toggleWishNotApplied(this)">
      <span>未申込（${notAppliedMembers.length}名）／クリックして希望を追加できます</span>
      <span class="wish-not-applied-arrow">▶</span>
    </div>`;
    html += `<div class="wish-not-applied-body">`;
    html += '<div class="wish-snap-outer-na"><table class="wish-tbl">';
    html += '<thead>' + buildHeadRows() + '</thead><tbody>';
    notAppliedMembers.forEach(m => { html += buildRow(m.uid, m.name); });
    html += '</tbody></table></div>';
    html += `</div>`;
  }

  document.getElementById('wish-table-wrap').innerHTML = html;
  fixWishHeadOffset();
}

// 2段の固定見出し（日付／時間帯）の段差を実測値で合わせる。
// 時間帯行の top が日付行の高さに足りないと段の間に隙間ができ、そこを
// 本文がスクロールして通り抜けてちらつく。
// わざと 1px 余分に詰めて必ず重なる側へ倒す。重なりは背景が不透明なので
// 見えないが、隙間は必ず見える。ぴったり合わせようとすると端数（実測 29.5px
// のような値）やフォント読み込み後の高さ変化で簡単に隙間側へ倒れる
function fixWishHeadOffset() {
  const wrap = document.getElementById('wish-table-wrap');
  if (!wrap) return;
  const dateTh = wrap.querySelector('.th-date[colspan]') || wrap.querySelector('.th-date');
  if (!dateTh) return;
  const h = dateTh.getBoundingClientRect().height;
  // タブが非表示のときは 0 になる。その値を入れると見出しが重なって潰れる
  if (h > 0) wrap.style.setProperty('--th-date-h', Math.max(0, Math.floor(h) - 1) + 'px');
}
// 文字サイズや折り返しが変わると段差も変わるので、幅の変化に追随させる
window.addEventListener('resize', () => fixWishHeadOffset());
// 表を組んだ時点ではまだ Noto Sans JP が来ておらず、あとから行の高さが
// 変わることがある。フォント確定後にもう一度測り直す
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fixWishHeadOffset());

// 参加希望 編集モーダル（希望確認タブのセルクリックで開く）
let wishEditCtx = null;
// 割当状態（isAssigned）はセルの class から読み取る。refreshWishAssign() が
// onclick 属性を書き換えずに済むようにするため
// ===== 希望編集モーダルの備考（選択式） =====
// 奉仕者フォーム（shift-form/js/app.js）と同じ文言を作る。
// ここで自由入力を許すと表記がずれ、validation.js の判定から漏れるため、
// 時刻の入る備考はすべて選択で組み立てる。
const WE_NOTE_TYPES = [
  { key: 'none',    label: 'なし' },
  { key: 'late',    label: '遅れて参加' },
  { key: 'early',   label: '早めに退出' },
  { key: 'partial', label: '一部のみ' },
  { key: 'other',   label: 'その他' }
];
function weMin(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? (+m[1]) * 60 + (+m[2]) : -1; }
function weParseNote(s) {
  s = (s || '').trim();
  if (!s) return { type: 'none', from: '', to: '', text: '' };
  let m = s.match(/^(\d{1,2}:\d{2})\s*[〜~]\s*(\d{1,2}:\d{2})のみ参加$/);
  if (m && weMin(m[1]) < weMin(m[2])) return { type: 'partial', from: m[1], to: m[2], text: '' };
  m = s.match(/^(\d{1,2}:\d{2})から参加$/);
  if (m) return { type: 'late', from: m[1], to: '', text: '' };
  m = s.match(/^(\d{1,2}:\d{2})まで参加$/);
  if (m) return { type: 'early', from: '', to: m[1], text: '' };
  return { type: 'other', from: '', to: '', text: s };   // 旧・自由入力はここに入る
}
function weBuildNote(st) {
  if (st.type === 'late')    return st.from ? st.from + 'から参加' : '';
  if (st.type === 'early')   return st.to   ? st.to   + 'まで参加' : '';
  if (st.type === 'partial') return (st.from && st.to && weMin(st.from) < weMin(st.to))
    ? st.from + '〜' + st.to + 'のみ参加' : '';
  if (st.type === 'other')   return (st.text || '').trim();
  return '';
}
// スロットの区切り時間はシフト作成データから引く（未読込なら15分）
function weInterval(slot) {
  const si = slot.indexOf(' ');
  const dk = si >= 0 ? slot.slice(0, si) : slot;
  const pp = dk.indexOf('(');
  const date = pp >= 0 ? dk.slice(0, pp) : dk;
  const time = si >= 0 ? slot.slice(si + 1) : '';
  const b = (shiftDates || []).find(d => d.date === date && d.time === time);
  return (b && b.interval) || 15;
}
function weTimeOptions(slot) {
  const si = slot.indexOf(' ');
  const m = String(si >= 0 ? slot.slice(si + 1) : '').match(/(\d{1,2}):(\d{2})\s*[~〜]\s*(\d{1,2}):(\d{2})/);
  if (!m) return [];
  const step = weInterval(slot);
  const st = (+m[1]) * 60 + (+m[2]), en = (+m[3]) * 60 + (+m[4]);
  const out = [];
  for (let t = st + step; t < en; t += step) out.push(Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'));
  return out;
}
function weNormalize(st, opts) {
  if (st.type !== 'partial') return st;
  if (st.from && (opts.indexOf(st.from) < 0 || st.from === opts[opts.length - 1])) st.from = '';
  if (st.to && (opts.indexOf(st.to) < 0 || (st.from && weMin(st.to) <= weMin(st.from)))) st.to = '';
  return st;
}
function weRenderNote(st) {
  const box  = document.getElementById('we-note');
  const opts = weTimeOptions(wishEditCtx ? wishEditCtx.slot : '');
  weNormalize(st, opts);
  const types = WE_NOTE_TYPES.filter(t =>
    t.key === 'none' || t.key === 'other' || (t.key === 'partial' ? opts.length >= 2 : opts.length >= 1));
  const sel = (which, cur, suffix, list) =>
    '<span class="we-sel-item"><select class="we-sel" data-which="' + which + '" onchange="weOnInput(this)">'
    + '<option value="">--:--</option>'
    + list.map(o => '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>').join('')
    + '</select><span class="we-sel-suffix">' + suffix + '</span></span>';
  const showFrom = st.type === 'late'  || st.type === 'partial';
  const showTo   = st.type === 'early' || st.type === 'partial';
  const fromList = st.type === 'partial' ? opts.slice(0, -1) : opts;
  const toList   = st.type !== 'partial' ? opts
                 : (st.from ? opts.filter(o => weMin(o) > weMin(st.from)) : opts.slice(1));
  box.dataset.ntype = st.type; box.dataset.nfrom = st.from || ''; box.dataset.nto = st.to || '';
  box.innerHTML =
      '<div class="we-chips">' + types.map(t =>
        '<button type="button" class="we-chip' + (st.type === t.key ? ' on' : '') + '"'
        + ' data-type="' + t.key + '" onclick="weSetType(this)">' + t.label + '</button>').join('') + '</div>'
    + (showFrom || showTo
        ? '<div class="we-detail">'
          + (showFrom ? sel('from', st.from, st.type === 'partial' ? '〜' : 'から参加', fromList) : '')
          + (showTo   ? sel('to',   st.to,   st.type === 'partial' ? 'のみ参加' : 'まで参加', toList) : '')
          + '</div>'
        : '')
    + (st.type === 'partial' && st.from && !st.to
        ? '<div class="we-warn">終了時刻も選んでください（未選択だと備考は保存されません）</div>' : '')
    + (st.type === 'other'
        ? '<textarea class="we-other" maxlength="50" placeholder="その他の連絡事項（50字まで）">' + esc(st.text || '') + '</textarea>'
        : '');
}
function weReadState() {
  const box = document.getElementById('we-note');
  const ta  = box.querySelector('.we-other');
  return { type: box.dataset.ntype || 'none', from: box.dataset.nfrom || '',
           to: box.dataset.nto || '', text: ta ? ta.value : '' };
}
function weSetType(el) {
  const st = weReadState();
  st.type = el.dataset.type;
  if (st.type === 'late')  st.to   = '';
  if (st.type === 'early') st.from = '';
  if (st.type === 'none')  { st.from = ''; st.to = ''; }
  if (st.type !== 'other') st.text = '';
  weRenderNote(st);
  if (st.type === 'other') { const ta = document.querySelector('#we-note .we-other'); if (ta) ta.focus(); }
}
function weOnInput(el) {
  const box = document.getElementById('we-note');
  box.dataset[el.dataset.which === 'from' ? 'nfrom' : 'nto'] = el.value;
  if (box.dataset.ntype === 'partial') weRenderNote(weReadState());
}

function openWishEdit(el, uid, name, slot, applied, comment) {
  const isAssigned = !!(el && el.classList.contains('cell-on'));
  wishEditCtx = { uid, name, slot, applied, isAssigned };
  document.getElementById('we-title').textContent = name + '｜' + slot;
  // comment は「カート不可」と備考が改行で連結された文字列（保存側と同じ規則）
  const raw = comment || '';
  const hasCartNg = raw.includes('カート不可');
  // カート担当に登録されていない人には出さない。ただし既に「カート不可」が
  // 入っているデータでは、隠して黙って消してしまわないよう表示する
  const isCartUser = !!(memberFlags[uid] || {}).cartFlag;
  document.getElementById('we-cart-row').style.display = (isCartUser || hasCartNg) ? '' : 'none';
  document.getElementById('we-cartng').checked = hasCartNg;
  weRenderNote(weParseNote(raw.replace('カート不可', '').trim()));
  const toggleBtn = document.getElementById('we-toggle-btn');
  const saveBtn   = document.getElementById('we-save-btn');
  if (applied) {
    toggleBtn.textContent = '不参加にする';
    toggleBtn.className = 's-btn del';
    saveBtn.style.display = '';
  } else {
    toggleBtn.textContent = '参加にする';
    toggleBtn.className = 's-btn green';
    saveBtn.style.display = 'none';
  }
  document.getElementById('wish-edit-modal').classList.add('on');
}
function closeWishEditModal() { document.getElementById('wish-edit-modal').classList.remove('on'); wishEditCtx = null; }
async function submitWishChange(applied) {
  if (!wishEditCtx) return;
  const ctx = wishEditCtx;
  if (!applied && ctx.isAssigned) {
    if (!await uiConfirm({
      type: 'warn', title: '割当済みの奉仕者を不参加にする',
      message: `${ctx.name} さんは既にこのスロットにシフト割当済みです。\n不参加に変更しますか？\n\n※シフト側の割当は自動では変更されません。`,
      confirmText: '不参加にする',
    })) return;
  }
  const si   = ctx.slot.indexOf(' ');
  const date = si >= 0 ? ctx.slot.slice(0, si) : ctx.slot;
  const time = si >= 0 ? ctx.slot.slice(si + 1) : '';
  // 保存形式は奉仕者フォームと同じ（1行目にカート不可、2行目に備考）
  const note = weBuildNote(weReadState());
  let comment = document.getElementById('we-cartng').checked ? 'カート不可' : '';
  if (note) comment += (comment ? '\n' : '') + note;
  setLoading(true, '保存中...');
  try {
    const res = await apiGet('adminSetWish', ymP({
      uid: ctx.uid, name: ctx.name, date, time, applied, comment,
      adminUid: adminUser?.uid || '', adminName: adminUser?.name || ''
    }));
    if (!res.ok) throw new Error(res.error || '保存に失敗しました');
    closeWishEditModal();
    toast('更新しました', 's');
    await loadWishDataInternal();
    await refreshApplicantsForCreate();
  } catch (e) { toast('保存エラー: ' + e.message, 'e'); } finally { setLoading(false); }
}

// 希望（申込）が変わったら、シフト作成側の申込者リスト・バッジ・セレクトの候補者を作り直す。
// 編集中のDOMは syncCurrentBlock() で shiftDates に書き戻してから再描画するので失われない。
async function refreshApplicantsForCreate() {
  if (!createLoaded) return;
  try {
    const res = await apiGet('getApplicants', ymP());
    if (!res || !res.ok) return;
    applicants = res.applicants || [];
    syncCurrentBlock();
    recalcCounts();
    buildLeftPanel();
    // 未保存の編集がある間は作り直さない（入力中のフォーカスが飛ぶため）。
    // セレクトの候補者は次のブロック切り替え時に更新される
    const tab = (window._dateTabs || [])[activeDateIdx];
    const block = tab ? shiftDates.filter(d => d.date === tab.date)[activeTimeIdx] : null;
    if (!block || bs[bKey(block)] !== false) renderBlock();
  } catch (e) { console.warn('[refreshApplicantsForCreate]', e); }
}
function toggleWishApplied() { if (wishEditCtx) submitWishChange(!wishEditCtx.applied); }
function saveWishComment()   { submitWishChange(true); }
function toggleWishNotApplied(el) {
  el.classList.toggle('open');
  const body = el.nextElementSibling;
  if (body) {
    const isHidden = getComputedStyle(body).display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
  }
}

// ============================================================
// TAB2: シフト作成
// ============================================================
async function loadCreateData() {
  setLoading(true, 'シフトデータを読み込み中...');
  try {
    Object.keys(bs).forEach(k => delete bs[k]); // 再読み込み時は保存状態をクリア
    Object.keys(_saveTimers).forEach(k => { clearTimeout(_saveTimers[k]); delete _saveTimers[k]; });
    Object.keys(_saveInFlight).forEach(k => delete _saveInFlight[k]);
    Object.keys(_savePending).forEach(k => delete _savePending[k]);
    Object.keys(_saveRetried).forEach(k => delete _saveRetried[k]);
    window._blockCols = {};
    window._cartUnlock = {};
    clearUndo();
    const [flagsRes, appRes, shiftRes, ackRes, ruleRes] = await Promise.all([
      apiGet('getMemberFlags'), apiGet('getApplicants', ymP()), apiGet('getShiftCreateData', ymP()),
      apiGet('getValidationAcks', {}).catch(() => ({ ok: false })),
      apiGet('getValidationRules', {}).catch(() => ({ ok: false }))
    ]);
    setValidationAcks(ackRes.ok ? (ackRes.acks || []) : []);
    setValidationConfig(ruleRes.ok ? (ruleRes.rules || {}) : {});
    const year  = shiftRes.year  || appRes.year  || new Date().getFullYear();
    const month = shiftRes.month || appRes.month || new Date().getMonth() + 1;
    const ymChanged = ymKey(curYM) !== (year + '.' + month);
    curYM = { year, month };
    if (ymChanged) renderYmSelect();
    document.getElementById('hdr-title').textContent = 'シフト管理アプリ — ' + year + '年' + month + '月';
    memberFlags  = flagsRes.ok ? flagsRes.flags    : {};
    applicants   = appRes.ok  ? appRes.applicants  : [];
    shiftDates   = shiftRes.ok ? shiftRes.dates    : [];
    locations    = shiftRes.locations    || [];
    cartNumbers  = shiftRes.cartNumbers  || [];
    conflictMap  = shiftRes.conflictMap  || {};
    memoMap = {};
    if (shiftRes.memoMap) Object.assign(memoMap, shiftRes.memoMap);
    defaultSlot  = shiftRes.defaultSlot  || 15;
    Object.keys(_srvSig).forEach(k => delete _srvSig[k]);
    shiftDates.forEach(b => { _srvSig[bKey(b)] = blockSig(b); });
    recalcCounts();
    buildCreateTabs();
    buildLeftPanel();
    refreshWishAssign();
    if (shiftDates.length > 0) { activeDateIdx = 0; activeTimeIdx = 0; buildTimeTabs(); }
    else { document.getElementById('main-content').innerHTML = '<div style="padding:24px;color:var(--ink3);text-align:center;">シフトデータがありません。<br>管理アプリの「募集開始処理」から「🗂 シフト作成準備」を実行してください。</div>'; }
    createLoaded = true;
    setLoading(false);
    startShiftCreateSync();
  } catch (e) { setLoading(false); toast('読み込みエラー: ' + e.message, 'e'); }
}

function buildCreateTabs() {
  const dt = []; const seen = new Set();
  shiftDates.forEach(d => { const k = d.date + '(' + d.weekday + ')'; if (!seen.has(k)) { seen.add(k); dt.push({ date: d.date, weekday: d.weekday }); } });
  window._dateTabs = dt;
  const tabs = dt.map((t, i) =>
    `<button class="dtab${i === 0 ? ' on' : ''}" onclick="switchDateTab(${i})">${esc(t.date)}（${esc(t.weekday)}）</button>`
  ).join('');
  // 「元に戻す」「チェック」はメインタブ行（分割表示ボタンの隣）に常設してあるのでここには置かない。
  // 「すべて保存」は置かない：編集は 0.5 秒のデバウンスで自動保存され、失敗しても
  // 自動リトライとブロック単位の「⚠ 保存失敗（タップで再試行）」が受け持つ。
  // 全ブロックを描き直して書き戻すため、押すと未編集のブロックまで更新扱いになり、
  // 他の管理者側で無用な同期が走るという副作用の方が大きかった
  // 並びは「… 保存ステータス → 再読み込み」。再読み込みは右端に固定する
  document.getElementById('dtabs').innerHTML = tabs + '<div class="dtabs-spacer" style="flex:1;"></div><div class="save-st" id="gst" style="display:none;margin-right:8px;"><div class="save-dot"></div><span id="gst-txt">未保存あり</span></div><button class="tb-btn" style="white-space:nowrap;" onclick="reloadCreateData()">🔄 再読み込み</button>';
  if (compareMode) populateCmpDateSel();
}

async function switchDateTab(i) {
  syncCurrentBlock();
  await flushPendingSave(activeTimeIdx);
  document.querySelectorAll('.dtab').forEach((b, idx) => b.className = 'dtab' + (idx === i ? ' on' : ''));
  activeDateIdx = i;
  activeTimeIdx = 0;
  buildTimeTabs();
  buildLeftPanel();
}

function buildTimeTabs() {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  const ttabEl = document.getElementById('dtabs-time');
  if (!ttabEl) return;
  ttabEl.innerHTML = dayBlocks.map((block, bi) =>
    `<button class="ttab${bi === activeTimeIdx ? ' on' : ''}" onclick="switchTimeTab(${bi})">${esc(block.time)}</button>`
  ).join('');
  renderBlock();
}

async function switchTimeTab(bi) {
  syncCurrentBlock();
  await flushPendingSave(activeTimeIdx);
  document.querySelectorAll('.ttab').forEach((b, idx) => b.className = 'ttab' + (idx === bi ? ' on' : ''));
  activeTimeIdx = bi;
  buildLeftPanel();
  renderBlock();
}

function renderBlock() {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  const block = dayBlocks[activeTimeIdx];
  if (!block) {
    document.getElementById('main-content').innerHTML = '<div style="padding:24px;color:var(--ink3);text-align:center;">データがありません</div>';
    return;
  }
  document.getElementById('main-content').innerHTML = buildBlock(block, activeTimeIdx);
  const key = bKey(block);
  if (bs[key]) markSaved(activeTimeIdx);
  else if (bs[key] === false) {
    // 未保存のまま作り直した場合はステータス表示も復元する
    const st = document.getElementById('st-' + activeTimeIdx);
    if (st) { st.style.display = ''; st.textContent = '● 未保存'; st.className = 'tb-st'; }
  }
  ug();
  refreshValidationUI();
}

// 指定した日付・時間帯に申込んでいる人だけを絞り込む共通ロジック
// （appliedSlotsのdate部分がdateと一致し、blockTimeが指定されていれば開始時刻も一致するもののみ）
function filterAppliedForSlot(date, blockTime) {
  return applicants.filter(a => a.appliedSlots && a.appliedSlots.some(s => {
    const sk = typeof s === 'object' ? s.slot : s;
    const dp = sk.indexOf('/'); const pp = sk.indexOf('(');
    const dn = dp >= 0 ? sk.slice(0, pp >= 0 ? pp : sk.indexOf(' ')) : sk;
    if (dn !== date) return false;
    if (!blockTime) return true;
    const startT = blockTime.split('~')[0];
    return sk.includes(') ' + startT) || sk.includes(' ' + startT);
  }));
}

function recalcCounts() {
  respCounts = {};
  cartCounts = {};
  slotAssignCounts = {};
  shiftDates.forEach(block => {
    const resp = block.responsible || {};
    [resp.r1, resp.r2].filter(Boolean).forEach(uid => { respCounts[uid] = (respCounts[uid] || 0) + 1; });
    const cart = block.cart || {};
    [cart.ki1, cart.ki2, cart.ko1, cart.ko2].filter(Boolean).forEach(uid => { cartCounts[uid] = (cartCounts[uid] || 0) + 1; });
    // シフト割当は1コマ内に複数行あるため、同一コマ内では重複排除して1回だけ数える
    const blockUids = new Set();
    (block.slots || []).forEach(slot => {
      Object.values(slot.places || {}).forEach(uids => { (uids || []).forEach(uid => { if (uid) blockUids.add(uid); }); });
    });
    blockUids.forEach(uid => { slotAssignCounts[uid] = (slotAssignCounts[uid] || 0) + 1; });
  });
}

function buildLeftPanel() {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  const block = dayBlocks[activeTimeIdx];
  const blockTime = block ? block.time : '';

  // その時間帯に申込がある人のみ
  const applied = filterAppliedForSlot(tab.date, blockTime);

  document.getElementById('lp-date-label').textContent = tab.date + '（' + tab.weekday + '）' + (blockTime ? ' ' + blockTime : '');

  const memoKey = block ? (tab.date + '_' + block.time) : '';
  const memo = memoKey ? (memoMap[memoKey] || '') : '';
  const memoHtml = memo
    ? `<div style="margin:6px 12px;padding:6px 8px;background:#fef9c3;border:1px solid #fde68a;border-radius:var(--r);font-size:11px;color:#92400e;white-space:pre-wrap;">${esc(memo)}</div>`
    : '';

  // 現在のブロックに割り当て済みの UID セットを構築
  const assignedUids = new Set();
  if (block) {
    (block.slots || []).forEach(slot => {
      Object.values(slot.places || {}).forEach(uids => {
        (uids || []).forEach(uid => { if (uid) assignedUids.add(uid); });
      });
    });
    const resp = block.responsible || {};
    if (resp.r1) assignedUids.add(resp.r1);
    if (resp.r2) assignedUids.add(resp.r2);
    const cart = block.cart || {};
    ['ki1','ki2','ko1','ko2'].forEach(k => { if (cart[k]) assignedUids.add(cart[k]); });
  }

  let html = memoHtml + '<div class="lp-sec">申込者</div>';
  html += applied.map(a => {
    const badgeA = `<span class="sc-badge sc-a">申${a.appliedCount}</span>`;
    const badgeR = a.respFlag ? `<span class="sc-badge sc-r">責${respCounts[a.uid] || 0}</span>` : '';
    const badgeK = a.cartFlag ? `<span class="sc-badge sc-k">カ${cartCounts[a.uid] || 0}</span>` : '';
    const badgeW = `<span class="sc-badge sc-w">割${slotAssignCounts[a.uid] || 0}</span>`;
    // 選択中時間帯のコメント・カート不可を取得
    const slotObj = blockTime ? (a.appliedSlots || []).find(s => {
      const sk = typeof s === 'object' ? s.slot : s;
      const startT = blockTime.split('~')[0];
      return sk.includes(') ' + startT) || sk.includes(' ' + startT);
    }) : null;
    const cartNg = slotObj && typeof slotObj === 'object' ? slotObj.cartNg : false;
    const note   = slotObj && typeof slotObj === 'object' ? slotObj.note   : '';
    const cartNgHtml = cartNg ? `<span style="font-size:10px;color:var(--red);font-weight:700;">🚫カート不可</span>` : '';
    const noteHtml   = note   ? `<span style="font-size:10px;color:var(--ink2);">📝${esc(note)}</span>` : '';
    const commentHtml = (cartNg || note) ? `<div style="display:flex;flex-wrap:wrap;gap:3px;padding:1px 0 3px 14px;">${cartNgHtml}${noteHtml}</div>` : '';
    const bothBadge = a.sameDayBoth ? `<span class="badge-both" title="同日の通常PWにも申込があります。どちらか一方のシフトにしか入れません。">両方</span>` : '';
    const dotClass = assignedUids.has(a.uid) ? 'd-on' : 'd-off';
    return `<div class="mr-wrap" data-uid="${esc(a.uid)}" data-name="${esc(a.name)}" title="ドラッグしてシフト表に配置できます"><div class="mr"><div class="m-dot ${dotClass}"></div><div class="m-name${vGenderCls(a.uid)}">${esc(a.name)}${bothBadge}</div><div class="lp-badges"><div class="lp-badge-col">${badgeA}${badgeR}</div><div class="lp-badge-col">${badgeW}${badgeK}</div></div></div>${commentHtml}</div>`;
  }).join('');
  // 「未申込」セクションは置かない。この一覧から人を掴むことはできず（申込が無いので
  // シフトには入れられない）、名前を眺める以外の用途が無かった。
  // 誰が申し込んでいないかは希望確認タブの未申込一覧で見られる
  document.getElementById('lp-members').innerHTML = html;
}

function bKey(b) { return b.date + '_' + b.time; }

// サーバー上の内容を表す署名。これを比較して「実際に変わったか」を判定する。
// 時刻や場所名など表示だけの差分では警告を出さないよう、保存対象だけを対象にする
const _srvSig = {};
function blockSig(b) {
  return JSON.stringify({
    responsible: b.responsible || {},
    cart: b.cart || {},
    placeCart: b.placeCart || [],
    usedPlaces: b.usedPlaces || [],
    slots: (b.slots || []).map(s => ({ t: s.time, p: s.places || [], w: s.watch || [] })),
  });
}

function buildBlock(block, bi) {
  return `<div class="tb" id="tb-${bi}">
    <div class="tb-hd">
      <span class="tb-time">${esc(block.date)}（${esc(block.weekday)}） ${esc(block.time)}</span>
      <div class="tb-acts">
        <span class="tb-st" id="st-${bi}" style="display:none;">● 未保存</span>
      </div>
    </div>
    <div class="sc-sync-banner" id="sync-banner-${bi}" style="display:none;">
      <span>⚠️ 他の管理者がこの時間帯を更新しました。保存すると上書きされます。</span>
      <button class="tb-btn" onclick="acceptSyncUpdate(${bi})">最新を確認</button>
    </div>
    <div class="v-bar" id="v-bar-${bi}"></div>
    ${buildRespArea(bi, block.responsible || {})}
    ${buildCartArea(bi, block.cart || {})}
    ${buildPlaceSelectUI(bi, block)}
    ${buildSlotTable(bi, block)}
  </div>`;
}

function buildNameMap() {
  const m = {};
  Object.entries(memberFlags).forEach(([uid, f]) => { m[uid] = f.name; });
  applicants.forEach(a => { m[a.uid] = a.name; });
  return m;
}

// 責任者・カート担当も、シフト表内の奉仕者欄（js/picker.js）と同じ
// ボタン＋ポップオーバーにする。候補は開いたときに毎回組み立て直すので、
// 未保存の編集（syncCurrentBlock）も反映される
function buildRespArea(bi, resp) {
  const nm = buildNameMap();
  function sel(id, val) {
    // data-role は dnd.js が「同じ役の欄」を集めるのに使う（責任者①②で1組）
    return `<button type="button" class="role-sel${val ? '' : ' empty'}${val ? vGenderCls(val) : ''}" id="${id}"`
         + ` data-value="${esc(val)}" data-bi="${bi}" data-role="resp"`
         + ` title="${val ? 'ドラッグして入れ替え・移動できます' : 'クリックして選択（表の人をここへドラッグしても入ります）'}"`
         + ` onclick="openRespPicker(this)">${esc(val ? (nm[val] || val) : '—')}</button>`;
  }
  return `<div class="resp-area"><div class="area-title">責任者（最大2名）</div><div class="ra-row">
    <div class="ra-item"><span class="ra-label">担当①</span><span class="ra-col">${sel('resp1-'+bi, resp.r1||'')}${ghostHtml(bi, 'resp', 'resp1-'+bi, resp.r1||'')}</span></div>
    <div class="ra-item"><span class="ra-label">担当②</span>${sel('resp2-'+bi, resp.r2||'')}</div>
  </div></div>`;
}

// シフト表内の奉仕者ピッカー（openMemberPicker）と同じ組み立て方。
// 「月内の担当回数が少ない人を上に」＋「優先」バッジも揃える
function openRespPicker(el) {
  const bi = +el.dataset.bi;
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  syncCurrentBlock(); // 未保存の編集も候補の判定に反映させる
  const cur = el.dataset.value || '';
  const nm  = buildNameMap();
  const cf  = uid => (typeof conflictLabel === 'function' ? conflictLabel(conflictMap, uid, block.date) : '');
  const respMembers = filterAppliedForSlot(block.date, block.time).filter(a => a.respFlag);
  const sorted = [...respMembers].sort((a, b) => {
    const ca = respCounts[a.uid] || 0, cb = respCounts[b.uid] || 0;
    if (ca !== cb) return ca - cb;
    return vByFurigana(a.uid, b.uid);
  });
  const items = [{ value: '', label: '—（未選択）', html: '<span class="pk-none">—（未選択）</span>' }];
  sorted.forEach(a => {
    const n = respCounts[a.uid] || 0;
    const badges = `<span class="pk-b b-w">責${n}</span>` + (n === 0 ? '<span class="pk-b b-p">優先</span>' : '');
    items.push({
      value: a.uid, label: a.name, search: a.name,
      html: `<span class="pk-nm${vGenderCls(a.uid)}">${esc(a.name)}</span>${badges}`,
      sub: cf(a.uid) ? esc(cf(a.uid).trim()) : '',
    });
  });
  // 保存済みだが今月は申込していない人（希望を取り下げた等）も、現在値なら候補に残す
  if (cur && !respMembers.find(a => a.uid === cur)) {
    items.splice(1, 0, { value: cur, label: nm[cur] || cur, html: `<span class="pk-nm${vGenderCls(cur)}">${esc(nm[cur] || cur)}</span>` });
  }
  openPicker(el, {
    title: `責任者　${block.time}`,
    search: true, value: cur, items,
    onPick: v => { setPsDom(el, v); mu(bi); },
  });
}

// ===== ゴースト提案 =====
// 該当スロットに入っている人から候補を出し、確定はワンクリックに委ねる。
// 自動で値を入れてしまうと確認されないまま通過するので、あえて値は入れない
function ghostHtml(bi, role, targetId, cur) {
  if (cur || typeof suggestRole !== 'function') return '';
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return '';
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return '';
  const list = suggestRole(block, role, {
    groups: buildBlockGroups(shiftDates), memberFlags, applicants,
    respCounts, cartCounts,
  });
  if (!list.length) return '';
  const c = list[0];
  const why = c.reason ? c.reason : `月${c.count}回`;
  return `<span class="ghost">候補：<span class="ghost-name">${esc(c.name)}</span><span>（${esc(why)}）</span>`
       + `<button type="button" class="ghost-btn" onclick="applyGhost('${esc(targetId)}','${esc(c.uid)}',${bi})">✓ 採用</button></span>`;
}

function applyGhost(targetId, uid, bi) {
  const el = document.getElementById(targetId);
  if (!el) return;
  setPsDom(el, uid);
  syncRoleCartNum(el);
  mu(bi);
  renderBlock();
}

// カート担当欄に対応するカート番号チップ。責任者欄には無いので null
// （欄とチップを結ぶ id の規則をここ一箇所に閉じ込める）
function roleCartNumEl(el) {
  if (!el || !el.dataset.role || el.dataset.role === 'resp') return null;
  return document.getElementById(el.id.replace('ci', 'cn').replace('co', 'con'));
}

// カート担当欄の値が変わったら、その列のカート番号チップの有効／無効をそろえる
// （dnd.js からも呼ばれる）
function syncRoleCartNum(el) {
  const n = roleCartNumEl(el);
  if (n) ucn(el.id, n.id);
}

function buildCartArea(bi, cart) {
  // この時間帯に持ち込み／持ち帰りが必要かを連続グループから判定し、
  // 不要な側は入力できないようにしておく（例外運用のため解除ボタンを添える）
  const tab   = (window._dateTabs || [])[activeDateIdx];
  const block = tab ? shiftDates.filter(d => d.date === tab.date)[bi] : null;
  const gi    = block && typeof buildBlockGroups === 'function'
    ? buildBlockGroups(shiftDates)[bKey(block)] : null;
  const need  = typeof cartNeeded === 'function' ? cartNeeded(gi) : { bring: true, take: true };

  function cSel(id, val, role) {
    const nm = buildNameMap();
    return `<button type="button" class="role-sel${val ? '' : ' empty'}${val ? vGenderCls(val) : ''}" id="${id}"`
         + ` data-value="${esc(val)}" data-bi="${bi}" data-role="${role}"`
         + ` title="${val ? 'ドラッグして入れ替え・移動できます' : 'クリックして選択（表の人をここへドラッグしても入ります）'}"`
         + ` onclick="openCartRolePicker(this)">${esc(val ? (nm[val] || val) : '—')}</button>`;
  }
  const { ki1='', kc1='', ki2='', kc2='', ko1='', oc1='', ko2='', oc2='' } = cart;
  const unlocked = window._cartUnlock || {};
  const bringOff = !need.bring && !unlocked[bi + '-bring'];
  const takeOff  = !need.take  && !unlocked[bi + '-take'];
  const naCell = (side, span) => `<td class="na-col" colspan="${span}"><div class="na-note">`
    + `<span>${side === 'bring' ? '連続する前の時間帯から引き継ぐため不要' : '連続する次の時間帯へ引き継ぐため不要'}</span>`
    + `<button type="button" class="na-unlock" onclick="unlockCart(${bi},'${side}')">例外的に入力</button></div></td>`;

  const bringRow1 = bringOff ? naCell('bring', 2) : `<td>${cSel('ci1-'+bi,ki1,'bring')}${ghostHtml(bi,'bring','ci1-'+bi,ki1)}</td><td>${cSel('ci2-'+bi,ki2,'bring')}</td>`;
  const takeRow1  = takeOff  ? naCell('take', 2)  : `<td>${cSel('co1-'+bi,ko1,'take')}${ghostHtml(bi,'take','co1-'+bi,ko1)}</td><td>${cSel('co2-'+bi,ko2,'take')}</td>`;
  const bringRow2 = bringOff ? '<td class="na-col" colspan="2"></td>' : `<td>${cartChip('cn1-'+bi,kc1,!ki1,bi)}</td><td>${cartChip('cn2-'+bi,kc2,!ki2,bi)}</td>`;
  const takeRow2  = takeOff  ? '<td class="na-col" colspan="2"></td>' : `<td>${cartChip('con1-'+bi,oc1,!ko1,bi)}</td><td>${cartChip('con2-'+bi,oc2,!ko2,bi)}</td>`;

  return `<div class="cart-area"><div class="area-title cart-title">カート担当者（最大各2名・空白可）</div>
    <div class="tbl-wrap">
    <table class="cart-tbl">
      <thead><tr><th style="width:90px;"></th><th colspan="2">持ち込み</th><th colspan="2">持ち帰り</th></tr></thead>
      <tbody>
        <tr><td class="row-lbl">担当者</td>${bringRow1}${takeRow1}</tr>
        <tr><td class="row-lbl">カート番号</td>${bringRow2}${takeRow2}</tr>
      </tbody>
    </table>
    </div>
  </div>`;
}

// カート担当（持ち込み／持ち帰り）のピッカー。openRespPicker と同じ組み立て方に、
// 同日の前後の連続グループで持ち帰り／持ち込みを担当した人と同一人物なら
// 最優先で出す判定を加える（車でカートを運んだままにできるため）
function openCartRolePicker(el) {
  const bi   = +el.dataset.bi;
  const role = el.dataset.role; // 'bring' | 'take'
  const tab  = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  syncCurrentBlock(); // 未保存の編集も候補の判定に反映させる
  const cur = el.dataset.value || '';
  const nm  = buildNameMap();
  const cf  = uid => (typeof conflictLabel === 'function' ? conflictLabel(conflictMap, uid, block.date) : '');
  const cartMembers = filterAppliedForSlot(block.date, block.time).filter(a => a.cartFlag);

  const gi = typeof buildBlockGroups === 'function' ? buildBlockGroups(shiftDates)[bKey(block)] : null;
  const priority = new Set();
  if (role === 'bring' && gi && gi.prevGroupTail) {
    const c = gi.prevGroupTail.cart || {};
    [c.ko1, c.ko2].filter(Boolean).forEach(u => priority.add(u));
  } else if (role === 'take' && gi && gi.nextGroupHead) {
    const c = gi.nextGroupHead.cart || {};
    [c.ki1, c.ki2].filter(Boolean).forEach(u => priority.add(u));
  }

  const sorted = [...cartMembers].sort((a, b) => {
    const pa = priority.has(a.uid) ? 0 : 1, pb = priority.has(b.uid) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ca = cartCounts[a.uid] || 0, cb = cartCounts[b.uid] || 0;
    if (ca !== cb) return ca - cb;
    return vByFurigana(a.uid, b.uid);
  });
  const items = [{ value: '', label: '—（未選択）', html: '<span class="pk-none">—（未選択）</span>' }];
  sorted.forEach(a => {
    const n = cartCounts[a.uid] || 0;
    const badges = `<span class="pk-b b-w">カ${n}</span>`
                 + (priority.has(a.uid) ? '<span class="pk-b b-p">🔗前後グループと同一</span>' : (n === 0 ? '<span class="pk-b b-p">優先</span>' : ''));
    items.push({
      value: a.uid, label: a.name, search: a.name,
      html: `<span class="pk-nm${vGenderCls(a.uid)}">${esc(a.name)}</span>${badges}`,
      sub: cf(a.uid) ? esc(cf(a.uid).trim()) : '',
    });
  });
  if (cur && !cartMembers.find(a => a.uid === cur)) {
    items.splice(1, 0, { value: cur, label: nm[cur] || cur, html: `<span class="pk-nm${vGenderCls(cur)}">${esc(nm[cur] || cur)}</span>` });
  }
  openPicker(el, {
    title: `カート担当（${role === 'bring' ? '持ち込み' : '持ち帰り'}）　${block.time}`,
    search: true, value: cur, items,
    onPick: v => {
      setPsDom(el, v);
      syncRoleCartNum(el);
      mu(bi);
    },
  });
}

// 不要としてグレー化した欄を、その場限りで入力可能に戻す
function unlockCart(bi, side) {
  window._cartUnlock = window._cartUnlock || {};
  window._cartUnlock[bi + '-' + side] = true;
  renderBlock();
}

// ===== カート番号チップ（クリックでトグル式ポップオーバー） =====
function cartNumList() { return cartNumbers.length > 0 ? cartNumbers : ['1','2','3','4']; }
function circledNum(n) {
  const M = { '1':'①','2':'②','3':'③','4':'④','5':'⑤','6':'⑥','7':'⑦','8':'⑧','9':'⑨' };
  return M[String(n).trim()] || String(n);
}
function cartLabel(v) {
  const arr = String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  return arr.length ? arr.map(circledNum).join('') : '—';
}

function cartChip(id, val, dis, bi) {
  const lbl = cartLabel(val);
  return `<button type="button" class="cart-chip${val ? '' : ' empty'}" id="${id}" data-value="${esc(val || '')}"`
       + ` data-bi="${bi}"${dis ? ' disabled' : ''} onclick="openCartPicker(this)">${esc(lbl)}</button>`;
}

// ===== 同じカートを2か所に置かせない =====
// カートは1台しか無いので、同じ番号を同時に2か所へは置けない。判定はこのブロック
// （同じ日・同じ時間帯）の中だけで行う。別の時間帯は持ち帰ってまた持ち込むので対象外。
//
// 番号のチップは2つの層に分かれていて、層をまたいだ重複は見ない：
//   場所別カート番号行（pc-*）… どの場所に何号車を置くか。列どうしで重複不可
//   担当欄（cn*／con*）        … 誰が何号車を運ぶか。持ち込み欄どうし・持ち帰り欄
//     どうしで重複不可。①を持ち込んだ人と①を持ち帰る人は同じ番号になるのが
//     普通の運用なので、持ち込み↔持ち帰りをまたぐ重複は許す
function cartNums(v) { return String(v || '').split(',').map(x => x.trim()).filter(Boolean); }

function cartLayerOf(el) {
  const id = (el && el.id) || '';
  if (id.startsWith('pc-')) return 'place';
  if (id.startsWith('con')) return 'take';
  if (id.startsWith('cn'))  return 'bring';
  return '';
}

// 同じ層にある他のカート番号チップ（自分は除く）
function cartPeerChips(el) {
  const layer = cartLayerOf(el), bi = el.dataset.bi;
  let list;
  if (layer === 'place') list = [...document.querySelectorAll(`#tb-${bi} .cart-cell .cart-chip`)];
  else if (layer === 'bring' || layer === 'take') {
    list = (layer === 'bring' ? ['cn1-', 'cn2-'] : ['con1-', 'con2-'])
      .map(p => document.getElementById(p + bi)).filter(Boolean);
  } else return [];
  return list.filter(x => x !== el);
}

// そのチップが何を指しているか（重複メッセージ用）。
// 場所はいま選ばれている場所名を読む。担当欄の1人目・2人目は「①」と書くと
// カート番号の丸数字と紛らわしいので「1人目」と書く
function cartChipLabel(el) {
  const layer = cartLayerOf(el);
  if (layer === 'place') {
    const m = /^pc-(\d+)-(\d+)-/.exec(el.id || '');
    const sel = m ? document.getElementById(`place-sel-${m[1]}-${m[2]}`) : null;
    return (sel && sel.value) || '場所未設定の列';
  }
  if (!layer) return '';
  const m = /(\d)-\d+$/.exec(el.id || '');
  return (layer === 'bring' ? '持ち込み' : '持ち帰り') + (m && m[1] === '2' ? '2人目' : '1人目');
}

// 同じ層で既に使われている番号 → 使っている場所・欄の名前
function cartUsedElsewhere(el) {
  const used = {};
  cartPeerChips(el).forEach(p => {
    cartNums(p.dataset.value).forEach(n => { if (!used[n]) used[n] = cartChipLabel(p); });
  });
  return used;
}

function openCartPicker(el) {
  const cur   = cartNums(el.dataset.value);
  const layer = cartLayerOf(el);
  const used  = cartUsedElsewhere(el);
  const items = cartNumList().map(n => {
    const s = String(n);
    // いまこの欄に入っている番号は必ず選べる（＝外せる）ままにする。
    // 過去に保存されたデータに重複が残っていても解除できなくなるのを防ぐ
    const where = cur.includes(s) ? '' : used[s];
    return {
      value: s, label: circledNum(n), html: `<span style="font-size:15px;">${circledNum(n)}</span>`,
      disabled: !!where,
      sub: where ? esc(where + (layer === 'place' ? ' に設置中' : ' が運びます')) : '',
    };
  });
  openPicker(el, {
    title: 'カート番号を選択（複数可）', multi: true, value: cur, items,
    note: (layer === 'place' ? '別の場所に設置中の番号は選べません。' : '同じ側の別の欄で使用中の番号は選べません。')
        + '入れ替えるときは番号の枠をドラッグしてください',
    onToggle: vals => {
      const next = cartNumList().filter(n => vals.includes(String(n))); // 設定タブの並び順に整える
      setCartValue(el, next.join(','));
    },
  });
}

function setCartDom(el, v) {
  el.dataset.value = v;
  el.textContent = cartLabel(v);
  el.classList.toggle('empty', !v);
}

function setCartValue(el, v) {
  setCartDom(el, v);
  mu(+el.dataset.bi);
}

function initBlockCols(bi, block) {
  const key = bKey(block);
  if (window._blockCols[key] !== undefined) return;
  const permanentLocs = locations.filter(l => !l.startYM && !l.endYM);
  let cols;
  if (block.usedPlaces && block.usedPlaces.length > 0) {
    cols = [...block.usedPlaces];
  } else if (block.place && (block.place.p1 || block.place.p2)) {
    cols = [block.place.p1 || '', block.place.p2 || ''];
  } else {
    cols = permanentLocs.map(l => l.name);
    if (cols.length < 2 && locations.length >= 2) { while (cols.length < 2) cols.push(''); }
    if (cols.length === 0) cols = [''];
  }
  window._blockCols[key] = cols;
}

function getColPlaces(bi, block) {
  initBlockCols(bi, block);
  const key = bKey(block);
  const cols = [...window._blockCols[key]];
  let synced = false;
  for (let li = 0; li < cols.length; li++) {
    const dom = document.getElementById(`place-sel-${bi}-${li}`);
    if (dom !== null) { cols[li] = dom.value; synced = true; }
  }
  if (synced) window._blockCols[key] = [...cols];
  return cols;
}

// 現在のDOM入力をブロック状態に書き戻す（列操作・再描画で未保存編集を失わないため）
function syncBlockStateFromDom(bi, block) {
  const data = collectBlock(bi);
  if (!data) return;
  block.responsible = data.responsible;
  block.cart        = data.cart;
  block.slots       = data.slots;
  block.placeCart   = data.placeCart;
  block.usedPlaces  = data.usedPlaces;
}

function addColEnd(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  insColAt(bi, block, block.usedPlaces ? block.usedPlaces.length : 0, true);
}

// 指定位置に列を挿入（li の位置＝その列の左に入る）
function insCol(bi, li) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  insColAt(bi, block, li, false);
}

function insColAt(bi, block, li, isEnd) {
  syncBlockStateFromDom(bi, block);
  const pos = isEnd ? block.usedPlaces.length : li;
  block.usedPlaces.splice(pos, 0, '');
  block.placeCart.splice(pos, 0, '');
  (block.slots || []).forEach(s => { s.places.splice(pos, 0, []); s.watch.splice(pos, 0, false); });
  window._blockCols[bKey(block)] = [...block.usedPlaces];
  mu(bi); renderBlock();
}

async function delCol(bi, li) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  syncBlockStateFromDom(bi, block);
  if ((block.usedPlaces || []).length <= 1) { toast('最後の列は削除できません', 'e'); return; }
  const hasContent = (block.slots || []).some(s => ((s.places||[])[li] || []).length > 0);
  const label = block.usedPlaces[li] || '（場所未設定）';
  if (!await uiConfirm({
    type: 'danger', title: '列の削除',
    message: `列「${label}」を削除しますか？` + (hasContent ? '\n\n※ この列に配置された奉仕者も削除されます。' : ''),
    confirmText: '削除する',
  })) return;
  block.usedPlaces.splice(li, 1);
  block.placeCart.splice(li, 1);
  (block.slots || []).forEach(s => { s.places.splice(li, 1); s.watch.splice(li, 1); });
  window._blockCols[bKey(block)] = [...block.usedPlaces];
  mu(bi); renderBlock();
}

function buildPlaceSelectUI(bi, block) {
  return ''; // ヘッダーセル内に統合
}

function onPlaceChange(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  // 中身は列番号で紐づくため、場所名の変更で内容は動かさない（DOM状態を保持したまま同期のみ）
  syncBlockStateFromDom(bi, block);
  window._blockCols[bKey(block)] = [...block.usedPlaces];
  mu(bi); renderBlock();
}

function buildSlotTable(bi, block) {
  const slots   = block.slots || [];
  const nm      = buildNameMap();
  const allApplied = applicants.filter(a => a.appliedSlots && a.appliedSlots.some(s => { const sk = typeof s === 'object' ? s.slot : s; const dp = sk.indexOf('/'); const pp = sk.indexOf('('); const dn = dp >= 0 ? sk.slice(0, pp >= 0 ? pp : sk.indexOf(' ')) : sk; return dn === block.date; }));
  const sa = allApplied.filter(a => a.appliedSlots && a.appliedSlots.some(s => { const sk = typeof s === 'object' ? s.slot : s; const sp = sk.indexOf(') '); const timeStr = sp >= 0 ? sk.slice(sp + 2) : sk; return timeStr === block.time; }));
  const placeCart = block.placeCart || [];
  if (slots.length === 0) return '<div style="padding:12px;color:var(--ink3);font-size:12px;">スロットなし</div>';
  const pc = ['#e0f2fe','#fef9c3','#fce7f3','#dcfce7','#ede9fe'];

  const allLocs = locations.map(l => l.name);
  // 空欄("")を含む固定列配列 — これを全セクションで統一して使う
  // 中身（奉仕者・カート番号）は列番号で紐づき、場所名は列のラベルにすぎない
  initBlockCols(bi, block);
  const colPlaces = [...window._blockCols[bKey(block)]];

  function makeLocSel(li, val) {
    let o = '<option value="">—</option>';
    allLocs.forEach(n => { o += `<option value="${esc(n)}"${n === val ? ' selected' : ''}>${esc(n)}</option>`; });
    return `<select id="place-sel-${bi}-${li}" class="cart-sel-place" onchange="onPlaceChange(${bi})" style="width:100%;font-weight:700;font-size:12px;">${o}</select>`;
  }

  // ヘッダー行（場所名ドロップダウン ＋ 列削除ボタン）
  let html = '<div class="tbl-wrap"><table class="shift-tbl"><thead>';
  html += '<tr><th class="th-slot-time">場所</th>';
  colPlaces.forEach((loc, li) => {
    html += `<th class="th-place" style="background:${pc[li % pc.length]};padding:4px 6px;">`;
    html += `<div class="col-ins-zone"><button class="col-ins-btn" onclick="insCol(${bi},${li})" title="ここに列を挿入">＋</button></div>`;
    if (li === colPlaces.length - 1) {
      html += `<div class="col-ins-zone right"><button class="col-ins-btn" onclick="addColEnd(${bi})" title="右端に列を追加">＋</button></div>`;
    }
    html += `<div style="display:flex;align-items:center;gap:3px;">`;
    html += makeLocSel(li, loc);
    html += `<button class="col-del-btn" onclick="delCol(${bi},${li})" title="この列を削除">✕</button>`;
    // スマホ用。指ではホバーできず .col-ins-zone の ＋ が出せないので、
    // 「この列の右に1列足す」ボタンを見出しに常設する（CSS で PC 幅では隠す）
    html += `<button class="col-add-m" onclick="insCol(${bi},${li + 1})" title="右に列を追加">＋</button>`;
    html += `</div></th>`;
  });
  html += '</tr>';

  // カート番号選択行（列番号で紐づけ）
  html += '<tr class="th-cart-row"><td class="td-slot-time" style="font-size:10px;color:var(--ink3);font-weight:700;padding:3px 8px;">カート番号</td>';
  colPlaces.forEach((loc, li) => {
    html += `<td class="cart-cell" style="background:${pc[li % pc.length]}20;">${cartChip(`pc-${bi}-${li}-0`, placeCart[li] || '', false, bi)}</td>`;
  });
  html += '</tr></thead><tbody>';

  // スロット行（奉仕者3固定・列番号で紐づけ）
  slots.forEach((slot, ri) => {
    html += '<tr><td class="td-slot-time">' + esc(slot.time) + '</td>';
    colPlaces.forEach((loc, li) => {
      const uids = (slot.places || [])[li] || [];
      const watchOn = !!((slot.watch || [])[li]);
      html += `<td class="cell-w" style="background:${pc[li % pc.length]}20;"><div class="cell-wrap" id="cw-${bi}-${ri}-${li}">`;
      for (let pi = 0; pi < 3; pi++) { html += buildPS(bi, ri, li, pi, uids[pi] || '', sa, nm, watchOn, block.date); }
      html += '</div></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';

  // ResizeObserver で cell-wrap の幅を監視して縦横切替
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const container = document.getElementById('main-content');
    if (!container) return;
    container.querySelectorAll('.cell-wrap').forEach(el => {
      applyCellWrapLayout(el);
      const td = el.closest('td') || el;
      if (!td._ro) { td._ro = new ResizeObserver(() => applyCellWrapLayout(el)); td._ro.observe(td); }
    });
  }));

  return html;
}

// 性別を表す左の縦線。メンバー管理画面と同じ色（青＝兄弟／赤＝姉妹）を使い、
// 凡例を覚え直さなくて済むようにしている
function vGenderCls(uid) {
  const g = ((memberFlags || {})[uid] || {}).gender || '';
  return g === 'M' ? ' g-m' : (g ? ' g-f' : '');
}

function buildPS(bi, ri, li, pi, val, sa, nm, watchOn, dateKey) {
  const id = `ps-${bi}-${ri}-${li}-${pi}`;
  // <select> ではなくボタン＋ポップオーバー（js/picker.js）。
  // option のスタイル制約から外れるので、性別・警告・月内回数を候補に出せる
  const label = val ? (nm[val] || val) : '—';
  const sel = `<button type="button" class="cs${val ? '' : ' empty'}${val ? vGenderCls(val) : ''}" id="${id}"`
            + ` data-value="${esc(val)}" data-bi="${bi}" data-ri="${ri}" data-li="${li}" data-pi="${pi}"`
            + ` onclick="openMemberPicker(this)">${esc(label)}</button>`;
  if (pi !== 0) return sel;
  // 一番左（1人目）の選択欄にのみ見守りチェックボックスを付与
  const cbId = `watch-${bi}-${ri}-${li}`;
  const isDisabled = !val;
  const isChecked = !!(watchOn && val);
  // title はスマホで必要。狭い幅では文字を消して 👁 アイコンだけにするため（CSS 側）
  const cb = `<label class="watch-label" title="見守り"><input type="checkbox" class="watch-cb" id="${cbId}" data-bi="${bi}" data-ri="${ri}" data-li="${li}"${isDisabled ? ' disabled' : ''}${isChecked ? ' checked' : ''} onchange="onWatchChange(this,${bi})"> 見守り</label>`;
  return `<div class="ps-watch-wrap">${sel}${cb}</div>`;
}

// ===== 奉仕者コンボボックス（js/picker.js のポップオーバーを使う） =====
function openMemberPicker(el) {
  const bi = +el.dataset.bi, ri = +el.dataset.ri, li = +el.dataset.li;
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  syncCurrentBlock(); // 未保存の編集も候補の判定に反映させる
  const cur  = el.dataset.value || '';
  const base = filterAppliedForSlot(block.date, block.time);
  const pi = +el.dataset.pi;
  const cands = buildCandidates(base, block, ri, li, {
    groups: buildBlockGroups(shiftDates), shiftDates, memberFlags, conflictMap,
    assignCounts: slotAssignCounts, applicants,
  }, cur, pi);
  // 保存済みだが今月は申込していない人（希望を取り下げた等）も、現在値なら候補に残す
  if (cur && !cands.find(c => c.uid === cur)) {
    const g = (memberFlags[cur] || {}).gender || '';
    cands.unshift({ uid: cur, name: (buildNameMap()[cur] || cur), state: 'ok', reason: '申込なし',
      group: VSTATE_GROUP.ok, count: slotAssignCounts[cur] || 0, gender: g,
      fixedNg: pi === 0 && !!g && g !== 'M' });
  }
  // 同一スロットの同じ場所にいる人は選べないので一覧から外す（件数だけ下に注記）。
  // 別の場所にいる人は「移動・入れ替え」として選べるようにする
  const blocked = cands.filter(c => c.state === 'blocked');
  const items = [{ value: '', label: '—（未選択）', html: '<span class="pk-none">—（未選択）</span>', group: '' }];
  cands.filter(c => c.state !== 'blocked').forEach(c => {
    const badges = (c.respFlag ? '<span class="pk-b b-r">責</span>' : '')
                 + (c.cartFlag ? '<span class="pk-b b-k">カ</span>' : '')
                 + `<span class="pk-b b-w">割${c.count}</span>`
                 + (c.count === 0 ? '<span class="pk-b b-p">優先</span>' : '')
                 + (c.cartNg ? '<span class="pk-b b-n">🚫カート不可</span>' : '')
                 + (c.noteNg ? '<span class="pk-b b-n">📝時間外</span>' : '')
                 + (c.fixedNg ? '<span class="pk-b b-n">固定枠は兄弟のみ</span>' : '');
    items.push({
      value: c.uid,
      move: c.state === 'move',
      label: c.name,
      search: (c.name || '') + ' ' + (c.furigana || ''),
      group: c.group,
      // 1番目（固定枠）に姉妹は入れない。一覧からは消さず、選べない形で見せて
      // 「なぜ選べないのか」が分かるようにする
      disabled: c.state === 'blocked' || !!c.fixedNg,
      html: `<span class="pk-nm${c.gender === 'M' ? ' g-m' : (c.gender ? ' g-f' : '')}">${esc(c.name)}</span>${badges}`,
      sub: (c.reason ? esc(c.reason) : '') + (c.note ? ' 📝' + esc(c.note) : ''),
    });
  });
  openPicker(el, {
    title: `${block.time}　${block.usedPlaces[li] || '（場所未設定）'}　${(block.slots[ri] || {}).time || ''}`
         + (pi === 0 ? '　［固定枠］' : ''),
    search: true, value: cur, items,
    note: [
      pi === 0 ? '1番目（固定枠）に入れるのは兄弟だけです' : '',
      blocked.length ? `同じ場所に配置済みの ${blocked.length} 名は表示していません` : '',
    ].filter(Boolean).join('／'),
    onPick: (v, it) => { if (it && it.move) movePsValue(el, v); else setPsValue(el, v); },
  });
}

// 見た目の差し替えだけを行う
function setPsDom(el, v) {
  el.dataset.value = v;
  el.textContent = v ? (buildNameMap()[v] || v) : '—';
  el.classList.toggle('empty', !v);
  el.classList.remove('g-m', 'g-f');
  const g = v ? vGenderCls(v).trim() : '';
  if (g) el.classList.add(g);
}

// セルの途中が空いたら左へ詰める。
// 保存時（collectBlock）は空欄を飛ばして詰めて保存するため、画面でも同じ形に
// そろえておかないと「2番目が空白なのに3番目に人がいる」状態が見えてしまう
function compactCell(bi, ri, li) {
  const cw = document.getElementById(`cw-${bi}-${ri}-${li}`);
  if (!cw) return;
  const els = [...cw.querySelectorAll('.cs')];
  // 1番目は固定枠。空いても2番目を繰り上げない
  const rest = els.slice(1).map(e => e.dataset.value || '').filter(Boolean);
  rest.sort(vByFurigana);
  els.slice(1).forEach((e, i) => setPsDom(e, rest[i] || ''));
  onPs0Change(bi, ri, li);
  autoWatch(bi, ri, li);
}

// 2・3番目はふりがな順にそろえる（1番目＝固定枠は対象外）
function vByFurigana(a, b) {
  const fa = (memberFlags[a] || {}).furigana || '', fb = (memberFlags[b] || {}).furigana || '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  const na = (memberFlags[a] || {}).name || a, nb = (memberFlags[b] || {}).name || b;
  return na < nb ? -1 : (na > nb ? 1 : 0);
}

// 値の差し替え（未保存フラグは呼び出し側でまとめて立てる）
function assignPs(el, v) {
  setPsDom(el, v);
  compactCell(+el.dataset.bi, +el.dataset.ri, +el.dataset.li);
}

function setPsValue(el, v) {
  assignPs(el, v);
  mu(+el.dataset.bi);
}

// 同じ時間に既にいる人を選んだときは、重複させずに「移動」する。
// 移動先に誰かいれば、その人が元の位置に入る（＝入れ替え）。
// 1操作として扱うので、元に戻す（Ctrl+Z）も1回で戻る
function movePsValue(el, uid) {
  const bi = +el.dataset.bi, ri = +el.dataset.ri;
  const src = [...document.querySelectorAll(`#tb-${bi} .cs`)]
    .find(s => s !== el && +s.dataset.ri === ri && s.dataset.value === uid);
  const prev = el.dataset.value || '';
  // 入れ替えの結果、相手が1番目（固定枠）に入ってしまう場合は操作ごと断る。
  // 黙って相手を外すと人が消えたように見えるため、何もせず理由を出す
  if (src && prev && +src.dataset.pi === 0) {
    const g = (memberFlags[prev] || {}).gender || '';
    if (g && g !== 'M') { toast('入れ替えると1番目（固定枠）に姉妹が入ります', 'e'); return; }
  }
  // 先に移動元を空けてから入れる。移動元のセルは詰めて空白を残さない
  if (src) { setPsDom(src, prev); compactCell(bi, ri, +src.dataset.li); }
  assignPs(el, uid);
  mu(bi);
  const nm = buildNameMap();
  toast(prev && src ? `${nm[uid] || uid} と ${nm[prev] || prev} を入れ替えました`
                    : `${nm[uid] || uid} を移動しました`, 's');
}

// 1つのセルに3名そろったら見守りを自動でONにする。
// 手動で切り替えたセルには以後触らない（data-manual）
function autoWatch(bi, ri, li) {
  const cw = document.getElementById(`cw-${bi}-${ri}-${li}`);
  const cb = document.getElementById(`watch-${bi}-${ri}-${li}`);
  if (!cw || !cb || cb.dataset.manual === '1') return;
  const els = [...cw.querySelectorAll('.cs')];
  const n = els.filter(s => s.dataset.value).length;
  if (n >= 3 && els[0] && els[0].dataset.value) { cb.disabled = false; cb.checked = true; }
  else if (cb.checked) cb.checked = false;
}

// 手動で見守りを操作したことを記録する
function onWatchChange(cb, bi) {
  cb.dataset.manual = '1';
  mu(bi);
}

function onPs0Change(bi, ri, li) {
  const sel = document.getElementById(`ps-${bi}-${ri}-${li}-0`);
  const cb  = document.getElementById(`watch-${bi}-${ri}-${li}`);
  if (!sel || !cb) return;
  if (sel.dataset.value) {
    cb.disabled = false;
  } else {
    cb.disabled = true;
    cb.checked = false;
  }
}

function mu(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  // この時点の block はまだ変更前の状態（syncCurrentBlock はこのあと）なので、
  // ここで積めば「1操作ぶん戻す」履歴になる
  pushUndo(bi, block);
  bs[bKey(block)] = false;
  const st = document.getElementById('st-' + bi);
  if (st) { st.style.display = ''; st.textContent = '● 未保存'; st.className = 'tb-st'; st.onclick = null; st.style.cursor = ''; }
  ug();
  scheduleAutoSave(bi);
  // 左メニューのバッジ・割当ドットと希望タブの割当表示を、保存完了を待たずに即時反映する。
  // buildLeftPanel / refreshWishAssign は main-content を触らないので入力中のフォーカスは失われない
  if (bi === activeTimeIdx) {
    syncCurrentBlock();
    recalcCounts();
    buildLeftPanel();
    refreshWishAssign();
    refreshValidationUI();
  }
}

// ============================================================
// 元に戻す（Ctrl+Z / Ctrl+Shift+Z）
//
// mu() が呼ばれるたびに「変更前」のブロック内容をスナップショットとして積む。
// メモリ上だけなのでリロードで消える。他管理者の同期マージが入ったら
// 巻き戻しで相手の変更まで消してしまうためスタックを捨てる。
// 戻す対象が別のブロックなら自動でタブを切り替え、どこが戻ったかを示す。
// ============================================================
const _undoStack = [];
const _redoStack = [];
let _undoBusy = false;   // undo適用中に mu() が新しい履歴を積まないようにする

function pushUndo(bi, block) {
  if (_undoBusy || !block) return;
  const snap = {
    key: bKey(block), date: block.date, time: block.time,
    data: JSON.stringify({
      responsible: block.responsible, cart: block.cart,
      slots: block.slots, placeCart: block.placeCart, usedPlaces: block.usedPlaces,
    }),
  };
  const top = _undoStack[_undoStack.length - 1];
  if (top && top.key === snap.key && top.data === snap.data) return; // 変化なし
  _undoStack.push(snap);
  _redoStack.length = 0;
  updateUndoBtn();
}

function clearUndo() { _undoStack.length = 0; _redoStack.length = 0; updateUndoBtn(); }

function updateUndoBtn() {
  const b = document.getElementById('undo-btn');
  if (b) b.disabled = _undoStack.length === 0;
}

function snapshotOf(block) {
  return JSON.stringify({
    responsible: block.responsible, cart: block.cart,
    slots: block.slots, placeCart: block.placeCart, usedPlaces: block.usedPlaces,
  });
}

async function applySnapshot(snap) {
  const di = (window._dateTabs || []).findIndex(t => t.date === snap.date);
  if (di < 0) { toast('戻し先の日付が見つかりません', 'e'); return false; }
  if (di !== activeDateIdx) await switchDateTab(di);
  const bi = shiftDates.filter(d => d.date === snap.date).findIndex(b => b.time === snap.time);
  if (bi < 0) { toast('戻し先の時間帯が見つかりません', 'e'); return false; }
  if (bi !== activeTimeIdx) await switchTimeTab(bi);
  const block = shiftDates.filter(d => d.date === snap.date)[bi];
  const d = JSON.parse(snap.data);
  block.responsible = d.responsible; block.cart = d.cart; block.slots = d.slots;
  block.placeCart = d.placeCart; block.usedPlaces = d.usedPlaces;
  window._blockCols[bKey(block)] = [...(d.usedPlaces || [])];
  renderBlock();
  mu(bi);
  const tb = document.getElementById('tb-' + bi);
  if (tb) { tb.classList.add('undo-flash'); setTimeout(() => tb.classList.remove('undo-flash'), 900); }
  return true;
}

async function doUndo() {
  if (_undoStack.length === 0) { toast('元に戻す操作がありません'); return; }
  const snap = _undoStack.pop();
  syncCurrentBlock();
  const cur = shiftDates.filter(d => d.date === snap.date).find(b => b.time === snap.time);
  if (cur) _redoStack.push({ key: snap.key, date: snap.date, time: snap.time, data: snapshotOf(cur) });
  _undoBusy = true;
  const ok = await applySnapshot(snap);
  _undoBusy = false;
  updateUndoBtn();
  if (ok) toast(`元に戻しました：${snap.date} ${snap.time}`, 's');
}

async function doRedo() {
  if (_redoStack.length === 0) { toast('やり直す操作がありません'); return; }
  const snap = _redoStack.pop();
  syncCurrentBlock();
  const cur = shiftDates.filter(d => d.date === snap.date).find(b => b.time === snap.time);
  if (cur) _undoStack.push({ key: snap.key, date: snap.date, time: snap.time, data: snapshotOf(cur) });
  _undoBusy = true;
  const ok = await applySnapshot(snap);
  _undoBusy = false;
  updateUndoBtn();
  if (ok) toast(`やり直しました：${snap.date} ${snap.time}`, 's');
}

document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = (e.key || '').toLowerCase();
  if (k !== 'z' && k !== 'y') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // 文字入力中は邪魔しない
  e.preventDefault();
  if (k === 'y' || e.shiftKey) doRedo(); else doUndo();
});

// ============================================================
// 整合性検証（js/validation.js）の実行と表示
// 判定ロジックはすべて validation.js 側にあり、ここは描画だけを行う。
// select を作り直さずフラグ用の要素だけを差し替えるので、
// 入力中のフォーカスは失われない。
// ============================================================
let _vResult = { issues: [], acked: [], byBlock: {}, groups: {} };
// 「✓ 確認済み」ボタンから参照する。onclick には配列の添字だけを渡し、
// キー文字列をHTML属性に埋め込まないようにする
let _vAllIssues = [];

function refreshValidationUI() {
  if (typeof validateShift !== 'function') return;
  _vResult = validateShift(shiftDates, {
    applicants, memberFlags, conflictMap, pwType: currentPwType
  });
  _vAllIssues = _vResult.issues.concat(_vResult.acked || []);
  _vAllIssues.forEach((x, i) => { x._i = i; });
  paintTabBadges();
  paintBlockValidation();
}

function vFlagHtml(x) {
  return `<div class="v-flag v-${x.level}" title="${esc(x.label)}">`
       + `<span>${x.level === 'error' ? '⛔' : '⚠️'}</span>`
       + `<span class="v-msg">${esc(x.msg)}</span>`
       + `<button class="v-ack" onclick="ackIssue(${x._i})" title="意図的な配置として、この警告を出さないようにする">✓</button>`
       + `</div>`;
}

// 「確認済み」の登録・解除。表示は即座に切り替え、保存は裏で行う
// （失敗したら元に戻して知らせる）
async function ackIssue(i) {
  const x = _vAllIssues[i];
  if (!x) return;
  vAddAck(x.key, { by: (adminUser && adminUser.name) || '', at: new Date().toISOString() });
  refreshValidationUI();
  if (document.getElementById('preflight-modal').classList.contains('on')) openPreflight();
  try {
    await apiGet('ackValidationIssue', { issueKey: x.key, date: x.date, time: x.time, ruleId: x.rule,
      adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || '' });
  } catch (e) {
    vRemoveAck(x.key);
    refreshValidationUI();
    toast('確認済みの保存に失敗しました: ' + e.message, 'e');
  }
}

async function unackIssue(i) {
  const x = _vAllIssues[i];
  if (!x) return;
  const info = vAckInfo(x.key);
  vRemoveAck(x.key);
  refreshValidationUI();
  openPreflight();
  try {
    await apiGet('ackValidationIssue', { issueKey: x.key, unack: true });
  } catch (e) {
    vAddAck(x.key, info || {});
    refreshValidationUI();
    toast('解除に失敗しました: ' + e.message, 'e');
  }
}
function vCount(list) {
  const err = list.filter(x => x.level === 'error').length;
  return { err, warn: list.length - err };
}
function vBadgeHtml(c) {
  if (!c.err && !c.warn) return '';
  const txt = (c.err ? '⛔' + c.err : '') + (c.err && c.warn ? ' ' : '') + (c.warn ? '⚠' + c.warn : '');
  return `<span class="v-badge${c.err ? ' v-err' : ''}">${txt}</span>`;
}
function vLive(block) { return (_vResult.byBlock[bKey(block)] || []).filter(x => x.scope === 'live'); }

// 表示中ブロックの警告を、該当セルの下とブロック上部のバーに出す
function paintBlockValidation() {
  const main = document.getElementById('main-content');
  if (!main) return;
  main.querySelectorAll('.v-flag').forEach(el => el.remove());
  const bar = document.getElementById('v-bar-' + activeTimeIdx);
  if (bar) bar.innerHTML = '';
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const block = shiftDates.filter(d => d.date === tab.date)[activeTimeIdx];
  if (!block) return;
  const rest = [];
  vLive(block).forEach(x => {
    const cw = (x.ri !== null && x.li !== null)
      ? document.getElementById(`cw-${activeTimeIdx}-${x.ri}-${x.li}`) : null;
    if (cw && cw.parentElement) cw.parentElement.insertAdjacentHTML('beforeend', vFlagHtml(x));
    else rest.push(x);
  });
  if (bar) bar.innerHTML = rest.map(vFlagHtml).join('');
}

// 日付タブ・時間帯タブに件数バッジを付ける
function paintTabBadges() {
  const dt = window._dateTabs || [];
  document.querySelectorAll('#dtabs .dtab').forEach((btn, i) => {
    const t = dt[i];
    if (!t) return;
    const old = btn.querySelector('.v-badge');
    if (old) old.remove();
    let list = [];
    shiftDates.filter(d => d.date === t.date).forEach(b => { list = list.concat(vLive(b)); });
    btn.insertAdjacentHTML('beforeend', vBadgeHtml(vCount(list)));
  });
  const tab = dt[activeDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  document.querySelectorAll('#dtabs-time .ttab').forEach((btn, bi) => {
    const b = dayBlocks[bi];
    if (!b) return;
    const old = btn.querySelector('.v-badge');
    if (old) old.remove();
    btn.insertAdjacentHTML('beforeend', vBadgeHtml(vCount(vLive(b))));
  });
}

// ===== 公開前チェックパネル =====
// live / publish 両方の指摘をまとめて一覧する。ここからそのまま公開もできる
function openPreflight() {
  syncCurrentBlock();
  if (!document.getElementById('preflight-modal').classList.contains('on')) refreshValidationUI();
  const showAcked = document.getElementById('pf-show-acked').checked;
  const issues = _vResult.issues.concat(showAcked ? (_vResult.acked || []) : []).sort((a, b) => {
    if (a.acked !== b.acked) return a.acked ? 1 : -1;
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1;
    return (a.blockKey || '￿').localeCompare(b.blockKey || '￿');
  });
  const c = vCount(_vResult.issues);
  const nAck = (_vResult.acked || []).length;
  document.getElementById('pf-summary').innerHTML = (_vResult.issues.length === 0
    ? '<span style="color:var(--green);font-weight:700;">✅ 指摘はありません</span>'
    : `⛔ エラー ${c.err} 件／⚠️ 警告 ${c.warn} 件`)
    + (nAck ? `<span style="color:var(--ink3);font-weight:500;">（確認済み ${nAck} 件）</span>` : '');

  const grouped = {};
  issues.forEach(x => { (grouped[x.blockKey] = grouped[x.blockKey] || []).push(x); });
  let html = '';
  Object.keys(grouped).forEach(k => {
    const first = grouped[k][0];
    const title = k ? `${esc(first.date)} ${esc(first.time)}` : '全体';
    const jump = k ? `<button class="pf-jump" onclick="vJump('${esc(first.date)}','${esc(first.time)}')">開く</button>` : '';
    html += `<div class="pf-grp"><span>${title}</span>${jump}</div>`;
    grouped[k].forEach(x => {
      const info = x.acked ? (vAckInfo(x.key) || {}) : null;
      const meta = info
        ? `<span class="pf-ack-meta">確認済み${info.by ? '：' + esc(info.by) : ''}${info.at ? '（' + esc(String(info.at).slice(0, 10)) + '）' : ''}</span>`
        : '';
      const btn = x.acked
        ? `<button class="pf-jump" onclick="unackIssue(${x._i})">解除</button>`
        : `<button class="pf-jump" onclick="ackIssue(${x._i})" title="意図的な配置として、この警告を出さないようにする">✓ 確認済み</button>`;
      html += `<div class="pf-row${x.acked ? ' acked' : ''}"><span class="pf-ico">${x.level === 'error' ? '⛔' : '⚠️'}</span>`
           +  `<span class="pf-msg">${esc(x.msg)}<span class="pf-rule">${esc(x.label)}${meta}</span></span>${btn}</div>`;
    });
  });
  document.getElementById('pf-list').innerHTML = html || '<div class="pf-ok">整合性の問題は見つかりませんでした</div>';

  // 「何も出ない」が「壊れている」ではなく「調べたうえで問題なし」と読めるように、
  // 何をどれだけ検査したのかを必ず表示する
  const nDates  = new Set(shiftDates.map(b => b.date)).size;
  const nBlocks = shiftDates.length;
  let nAssign = 0;
  shiftDates.forEach(b => { nAssign += Object.keys(typeof blockAssign === 'function' ? blockAssign(b) : {}).length; });
  const ruleNames = Object.keys(VRULES).filter(id => vRule(id).on).map(id => VRULES[id].label);
  document.getElementById('pf-footer').innerHTML =
    `<details class="pf-det"><summary class="pf-scope">${ruleNames.length}ルールを ${nDates}日程・${nBlocks}ブロック・のべ${nAssign}名の配置に適用しました</summary>`
    + `<div class="pf-rules">${esc(ruleNames.join('／'))}</div></details>`;

  const pubBtn = document.getElementById('pf-publish-btn');
  // 確認者は「確認完了」、作成担当者は「作成完了」をこのパネルからも実行できる
  if (shiftApproval.isApprover) {
    pubBtn.style.display = (shiftPublished && !shiftApproval.approvedByMe) ? '' : 'none';
    pubBtn.textContent = c.err > 0 ? '⚠️ エラーのまま確認完了にする' : '☑️ 確認完了にする';
    pubBtn.className = c.err > 0 ? 's-btn del' : 's-btn green';
    pubBtn.onclick = () => { closePreflight(); approveShift(true); };
  } else {
    pubBtn.style.display = shiftPublished ? 'none' : '';
    pubBtn.textContent = c.err > 0 ? '⚠️ エラーのまま公開する' : '📣 シフトを公開する';
    pubBtn.className = c.err > 0 ? 's-btn del' : 's-btn green';
    pubBtn.onclick = () => doPublish();
  }
  document.getElementById('preflight-modal').classList.add('on');
}
function closePreflight() { document.getElementById('preflight-modal').classList.remove('on'); }

async function vJump(date, time) {
  closePreflight();
  const di = (window._dateTabs || []).findIndex(t => t.date === date);
  if (di < 0) return;
  if (di !== activeDateIdx) await switchDateTab(di);
  const bi = shiftDates.filter(d => d.date === date).findIndex(b => b.time === time);
  if (bi >= 0) await switchTimeTab(bi);
}

// ============================================================
// オートセーブ（デバウンス）
// mu(bi) からブロック単位でタイマーを(再)設定する。0.5秒操作が止まったら保存を実行する。
// 保存中に追加の編集が入った場合は完了後にもう一度保存し直し、同一ブロックへの
// 保存リクエストが重ならないようにする（saveShiftBlockはdelete→insertのため
// 並行実行すると書き込み順序が入れ替わりデータ不整合を起こしうる）。
// ============================================================
function scheduleAutoSave(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = tab ? shiftDates.filter(d => d.date === tab.date)[bi] : null;
  if (!block) return;
  const key = bKey(block);
  clearTimeout(_saveTimers[key]);
  _saveTimers[key] = setTimeout(() => { delete _saveTimers[key]; runAutoSave(bi); }, AUTOSAVE_DEBOUNCE_MS);
}

async function runAutoSave(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = tab ? shiftDates.filter(d => d.date === tab.date)[bi] : null;
  if (!block) return;
  const key = bKey(block);
  if (_saveInFlight[key]) { _savePending[key] = true; return; }
  _saveInFlight[key] = true;
  try {
    await saveBlock(bi);
  } finally {
    _saveInFlight[key] = false;
    if (_savePending[key]) { _savePending[key] = false; runAutoSave(bi); }
  }
}

// 離脱前に保留中の保存を確定させる（デバウンス待ち中に別ブロックへ切り替える場合の安全弁）
async function flushPendingSave(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = tab ? shiftDates.filter(d => d.date === tab.date)[bi] : null;
  if (!block) return;
  const key = bKey(block);
  if (_saveTimers[key]) { clearTimeout(_saveTimers[key]); delete _saveTimers[key]; }
  if (bs[key] === false) await runAutoSave(bi);
}

// 未送信の変更（デバウンス待ち・保存失敗）が残ったままタブを閉じようとしたら警告する
window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; }
});

function markSaved(bi) {
  const st = document.getElementById('st-' + bi);
  if (st) { st.style.display = ''; st.textContent = '✓ 保存済み'; st.className = 'tb-st saved'; st.onclick = null; st.style.cursor = ''; }
}
function ug() {
  const u = Object.values(bs).some(v => !v);
  document.getElementById('gst').className = u ? 'save-st' : 'save-st saved';
  document.getElementById('gst-txt').textContent = u ? '未保存あり' : '保存済み';
  document.getElementById('gst').style.display = Object.keys(bs).length > 0 ? '' : 'none';
}

// 未保存の変更があるか判定（bsの値に1つでもfalseがあれば未保存あり）
function hasUnsavedChanges() {
  return Object.values(bs).some(v => !v);
}

// シフト作成タブの再読み込みボタン
async function reloadCreateData() {
  if (hasUnsavedChanges() && !await uiConfirm({
    type: 'danger', title: '未保存の変更があります',
    message: '未保存の変更が失われます。続行しますか？', confirmText: '破棄して続行',
  })) return;
  await loadCreateData();
}

// ============================================================
// リアルタイム同期（ポーリング）
// 他の管理者が saveShiftBlock で保存すると touchShift() が settings テーブルの
// shift_updated_at_<pw_type> を更新する。それを軽量エンドポイント getShiftLastUpdated で
// 定期チェックし、変化があればブロック単位でマージする（表示中ブロックが未保存編集中の
// 場合は上書きせず競合バナーを出す）。バックエンドは shift-form/js/app.js の
// checkShiftUpdate と同じ仕組みを流用している。
// 希望（shift_wishes）側は touchWish() が wish_updated_at_<pw_type> を更新し、
// 同じエンドポイントの wishUpdated で返ってくる。変化があれば希望確認タブと
// 申込者リストだけを再取得する（シフト作成側のブロックには触れない）。
// ============================================================
async function checkShiftCreateUpdate() {
  if (!createLoaded && !wishLoaded) return;
  try {
    const res = await apiGet('getShiftLastUpdated');
    if (!res || !res.ok) return;
    const wishTs = res.wishUpdated || '';
    // 初回（または再読み込み直後）は基準値を控えるだけで同期処理は走らせない
    if (_scKnownTs === null) _scKnownTs = res.lastUpdated;
    else if (res.lastUpdated !== _scKnownTs) {
      _scKnownTs = res.lastUpdated;
      // 作成完了・確認完了・差し戻しも touchShift でタイムスタンプを動かすため、
      // 他の係の操作を待たずにヘッダーの確認状況を追随させる
      await refreshPublishState();
      if (createLoaded) await syncShiftCreateData();
    }
    if (_scKnownWishTs === null) _scKnownWishTs = wishTs;
    else if (wishLoaded && wishTs !== _scKnownWishTs) {
      _scKnownWishTs = wishTs;
      await syncWishData();
    }
  } catch (e) { console.warn('[checkShiftCreateUpdate]', e); }
}

// 他の管理者の希望編集・奉仕者のシフト希望提出を反映する。
// シフト作成側で編集中の内容は syncCurrentBlock() 経由で保持される
async function syncWishData() {
  const outer = document.querySelector('#wish-table-wrap .wish-snap-outer');
  const sx = outer ? outer.scrollLeft : 0, sy = outer ? outer.scrollTop : 0;
  try { await loadWishDataInternal(); } catch (e) { console.warn('[syncWishData]', e); return; }
  const o2 = document.querySelector('#wish-table-wrap .wish-snap-outer');
  if (o2) { o2.scrollLeft = sx; o2.scrollTop = sy; }
  await refreshApplicantsForCreate();
  toast('シフト希望の変更を反映しました', 's');
}

function startShiftCreateSync() {
  clearInterval(_scPollTimer);
  _scKnownTs = null;
  _scKnownWishTs = null;
  _scPollTimer = setInterval(checkShiftCreateUpdate, 10000);
  if (!_scPollListening) {
    _scPollListening = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkShiftCreateUpdate(); });
  }
  checkShiftCreateUpdate();
}

// 変更があったブロックだけをマージする。日付タブ構成が変わるような構造的な変更
// （シフト作成枠の新規作成・削除など）は対象外とし、既存の「🔄 再読み込み」に委ねる。
async function syncShiftCreateData() {
  let res;
  try { res = await apiGet('getShiftCreateData', ymP()); } catch (e) { return; }
  if (!res || !res.ok) return;

  const activeTab   = (window._dateTabs || [])[activeDateIdx];
  const activeBlock = activeTab ? shiftDates.filter(d => d.date === activeTab.date)[activeTimeIdx] : null;
  const activeKey   = activeBlock ? bKey(activeBlock) : null;
  let activeChanged  = false;
  let activeConflict = false;

  (res.dates || []).forEach(fresh => {
    const key = bKey(fresh);
    const idx = shiftDates.findIndex(d => bKey(d) === key);
    if (idx === -1) return; // 新規追加された枠は対象外（🔄 再読み込みで反映）
    const sig = blockSig(fresh);
    const changed = _srvSig[key] !== undefined && _srvSig[key] !== sig;
    _srvSig[key] = sig;
    if (key === activeKey) {
      // 未保存の編集中でも、サーバー側の中身が変わっていなければ警告しない
      if (bs[key] === false) { if (changed) activeConflict = true; return; }
      if (!changed) return;
      shiftDates[idx] = fresh;
      activeChanged = true;
    } else if (bs[key] !== false && changed) {
      shiftDates[idx] = fresh;
    }
  });

  conflictMap = res.conflictMap || conflictMap;
  memoMap = {};
  if (res.memoMap) Object.assign(memoMap, res.memoMap);
  defaultSlot = res.defaultSlot || defaultSlot;
  recalcCounts();
  buildLeftPanel();
  refreshWishAssign();

  if (activeConflict) showSyncConflictBanner(activeTimeIdx);
  else if (activeChanged) {
    // 他管理者の変更が入った以上、過去へ巻き戻すと相手の編集まで消してしまう
    clearUndo();
    renderBlock();
    toast('他の管理者の変更を反映しました', 's');
  }
}

function showSyncConflictBanner(bi) {
  const el = document.getElementById('sync-banner-' + bi);
  if (el) el.style.display = 'flex';
}

// 競合バナーの「最新を確認」：ユーザー起動の明示的な再取得なのでオーバーレイ表示する
async function acceptSyncUpdate(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  setLoading(true, '最新のデータを読み込み中...');
  try {
    const res = await apiGet('getShiftCreateData', ymP());
    const fresh = res && res.ok ? (res.dates || []).find(d => bKey(d) === bKey(block)) : null;
    if (fresh) {
      const key = bKey(block);
      const idx = shiftDates.findIndex(d => bKey(d) === key);
      shiftDates[idx] = fresh;
      bs[key] = true;
      if (_saveTimers[key]) { clearTimeout(_saveTimers[key]); delete _saveTimers[key]; }
      recalcCounts();
      buildLeftPanel();
      refreshWishAssign();
      renderBlock();
    }
  } catch (e) { toast('読み込みエラー: ' + e.message, 'e'); }
  finally { setLoading(false); }
}

function applyCellWrapLayout(el) {
  // cell-wrap内の3つのドロップダウンが横並びで各100px以上を確保できるかで縦横を切替
  // 横並び時: 各100px×3 + gap 4px×2(=8px) = 308px が境界（308px以上で横、未満で縦）
  const THRESHOLD = 100 * 3 + 4 * 2; // 308px
  const w = el.clientWidth; // cell-wrapの内容幅(paddingなし)
  if (w <= 0) return; // 非表示タブ内などサイズ未確定時は判定しない
  if (w < THRESHOLD) {
    el.classList.add('vertical');
  } else {
    el.classList.remove('vertical');
  }
}

// 担当者が空ならカート番号チップを無効化して値も消す
function ucn(si, ni) {
  const s = document.getElementById(si), n = document.getElementById(ni);
  if (!s || !n) return;
  const v = s.dataset.value || '';
  n.disabled = !v;
  if (!v) { n.dataset.value = ''; n.textContent = '—'; n.classList.add('empty'); }
}

// タブ切り替え前に現在のDOM入力をshiftDatesに書き戻す（未保存データを保持）
function syncCurrentBlock() {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return;
  const dayBlocks = shiftDates.filter(d => d.date === tab.date);
  const block = dayBlocks[activeTimeIdx];
  if (!block) return;
  const data = collectBlock(activeTimeIdx);
  if (!data) return;
  block.responsible = data.responsible;
  block.cart        = data.cart;
  block.slots       = data.slots;
  block.placeCart   = data.placeCart;
  block.usedPlaces  = data.usedPlaces;
  if (data.usedPlaces && data.usedPlaces.length) {
    block.place = { p1: data.usedPlaces[0] || '', p2: data.usedPlaces[1] || '' };
  }
}

function collectBlock(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return null;
  // 責任者・カート担当者・カート番号は、いずれもボタン＋ポップオーバーで値は data-value
  const chipV = id => { const e = document.getElementById(id); return (e && e.dataset.value) || ''; };
  const keep  = (dom, saved) => (document.getElementById(dom) ? chipV(dom) : (saved || ''));
  const responsible = { r1: keep('resp1-'+bi, ''), r2: keep('resp2-'+bi, '') };
  const oc = block.cart || {};
  const cart = {
    ki1: keep('ci1-'+bi, oc.ki1), ki2: keep('ci2-'+bi, oc.ki2),
    ko1: keep('co1-'+bi, oc.ko1), ko2: keep('co2-'+bi, oc.ko2),
    kc1: keep('cn1-'+bi,  oc.kc1), kc2: keep('cn2-'+bi,  oc.kc2),
    oc1: keep('con1-'+bi, oc.oc1), oc2: keep('con2-'+bi, oc.oc2),
  };
  // 現在の列状態を同期して収集（colPlacesは空欄含む固定列、インデックスはDOMと一致）
  // 中身は列番号（インデックス）で紐づけて収集する
  const colPlaces = getColPlaces(bi, block);
  const usedPlaces = [...colPlaces];
  const placeCart = colPlaces.map((loc, li) => {
    const el = document.getElementById(`pc-${bi}-${li}-0`);
    return el ? (el.dataset.value || '') : ((block.placeCart || [])[li] || '');
  });
  const slots = (block.slots || []).map((slot, ri) => {
    const places = [];
    const watch = [];
    colPlaces.forEach((loc, li) => {
      const cw = document.getElementById(`cw-${bi}-${ri}-${li}`);
      const uids = [];
      if (cw) {
        // 1番目（固定枠）が空のときもその位置を保つため、空欄を捨てずに集める。
        // 末尾の空欄だけ落とす（保存側は sort に位置を書き込む）
        cw.querySelectorAll('.cs').forEach(s => uids.push(s.dataset.value || ''));
        while (uids.length && !uids[uids.length - 1]) uids.pop();
      } else {
        ((slot.places || [])[li] || []).forEach(u => { if (u) uids.push(u); });
      }
      places.push(uids);
      const cb = document.getElementById(`watch-${bi}-${ri}-${li}`);
      watch.push(cb ? !!cb.checked : !!((slot.watch || [])[li]));
    });
    return { time: slot.time, places, watch };
  });
  return { responsible, cart, placeCart, usedPlaces, slots };
}

async function saveBlock(bi) {
  const tab   = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  const key = bKey(block);
  const st  = document.getElementById('st-' + bi);
  if (st) { st.style.display = ''; st.textContent = '保存中...'; st.className = 'tb-st'; st.onclick = null; st.style.cursor = ''; }
  try {
    const data = collectBlock(bi);
    const res = await apiGet('saveShiftBlock', ymP({ date: block.date, time: block.time, responsible: data.responsible, cart: data.cart, placeCart: data.placeCart, usedPlaces: data.usedPlaces, slots: data.slots }));
    // 自分の保存でタイムスタンプが動くため、基準値を取り直して
    // 自分の変更が「他の管理者の更新」として跳ね返らないようにする
    if (res && res.lastUpdated) _scKnownTs = res.lastUpdated;
    _srvSig[key] = blockSig(data);
    block.responsible = data.responsible;
    block.cart = data.cart;
    block.slots = data.slots;
    block.place = { p1: (data.usedPlaces || [])[0] || '', p2: (data.usedPlaces || [])[1] || '' };
    block.usedPlaces = data.usedPlaces || [];
    block.placeCart = data.placeCart || [];
    recalcCounts();
    bs[key] = true; _saveRetried[key] = false; markSaved(bi); ug();
    buildLeftPanel();
    refreshWishAssign();
  } catch (e) {
    bs[key] = false;
    if (st) {
      st.style.display = '';
      st.textContent = '⚠ 保存失敗（タップで再試行）';
      st.className = 'tb-st err';
      st.style.cursor = 'pointer';
      st.onclick = () => { st.onclick = null; runAutoSave(bi); };
    }
    toast('保存に失敗しました: ' + e.message, 'e');
    if (!_saveRetried[key]) {
      _saveRetried[key] = true;
      setTimeout(() => { _saveRetried[key] = false; runAutoSave(bi); }, AUTOSAVE_RETRY_MS);
    }
  }
}

async function saveAll() {
  const tabs = window._dateTabs || [];
  const origDateIdx = activeDateIdx;
  const origTimeIdx = activeTimeIdx;
  // 現在表示中のブロックを最初に保存（DOM が正しい状態のうちに収集する）
  await saveBlock(origTimeIdx);
  for (let di = 0; di < tabs.length; di++) {
    activeDateIdx = di;
    const dayBlocks = shiftDates.filter(d => d.date === tabs[di].date);
    for (let bi = 0; bi < dayBlocks.length; bi++) {
      if (di === origDateIdx && bi === origTimeIdx) continue;
      activeTimeIdx = bi;
      buildTimeTabs();
      await saveBlock(bi);
    }
  }
  activeDateIdx = origDateIdx;
  activeTimeIdx = origTimeIdx;
  buildTimeTabs();
  toast('すべて保存しました', 's');
}

// 公開状態を変える操作のあとに使う。作成完了フラグが変わると年月セレクタの
// 「（シフト公開中）」表示と、どの月を公開操作できるかの判定も変わるため合わせて取り直す
async function refreshPublishState() {
  applyPublishStatus(await fetchPublishStatus());
  await loadYmList();
}

// 公開状態＋確認状況を取得する。確認者かどうかの判定にログイン中の管理者UID、
// オーナー（確認省略可）かどうかの判定にメールアドレスが必要
function fetchPublishStatus() {
  return apiGet('getShiftPublishStatus', ymP({
    adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || '',
    adminEmail: (adminUser && adminUser.email) || ''
  }));
}

function applyPublishStatus(res) {
  if (!res || !res.ok) return;
  shiftPublished = !!res.published;
  shiftOpenDate  = res.openDate || '';
  shiftApproval = {
    approvers:   res.approvers || [],
    required:    res.required || 0,
    approvedCount: res.approvedCount || 0,
    isApprover:  !!res.isApprover,
    approvedByMe: !!res.approvedByMe,
    approvedAll: !!res.approvedAll,
    approvalSkipped: !!res.approvalSkipped,
    isOwner:     !!res.isOwner,
    notified:    !!res.notified,
    doneByName:  res.doneByName || '',
    rejected:    res.rejected || null
  };
  updatePublishBtn();
}

function updatePublishBtn() {
  const btn = document.getElementById('publish-btn');
  if (!btn) return;
  const rejBtn    = document.getElementById('reject-btn');
  const apprLabel = document.getElementById('publish-approval');
  const openLabel = document.getElementById('publish-open-date');
  const hide = el => { if (el) { el.textContent = ''; el.style.display = 'none'; } };

  // 公開（作成完了）は「申込中の月」か「シフトが作成完了になっている月」に対してのみ行える。
  // それ以外の月を表示しているときに押せてしまうと、まだ準備段階の月のフラグを立ててしまう
  if (isOffPublishedMonth()) {
    btn.textContent = '✅ シフト作成完了';
    btn.className = 'hbtn pub';
    btn.disabled = true;
    btn.title = publishedYM
      ? ('申込中カレンダーは ' + publishedYM.year + '年' + publishedYM.month + '月 です。表示中の月は公開操作できません（管理アプリで対象月の予定表を公開してください）')
      : '公開中のカレンダーがありません。管理アプリで予定表を公開してください';
    hide(openLabel);
    hide(apprLabel);
    if (rejBtn) rejBtn.style.display = 'none';
    return;
  }

  const a = shiftApproval;
  btn.disabled = false;
  btn.title = '';

  if (a.isApprover) {
    // 確認者：作成完了を押すのは作成担当者。確認者は「確認完了」と「差し戻し」だけを行う
    if (!shiftPublished) {
      btn.textContent = '☑️ 確認完了にする';
      btn.className = 'hbtn appr';
      btn.disabled = true;
      btn.title = '作成担当者が「シフト作成完了」にすると確認できます';
    } else if (a.approvedByMe) {
      btn.textContent = '✅ 確認済み';
      btn.className = 'hbtn appr';
      btn.disabled = true;
      btn.title = 'あなたの確認は完了しています';
    } else {
      btn.textContent = '☑️ 確認完了にする';
      btn.className = 'hbtn appr';
      btn.title = 'シフト内容を確認し、公開を承認します';
    }
    if (rejBtn) {
      rejBtn.style.display = shiftPublished ? '' : 'none';
      rejBtn.className = 'hbtn rej';
      rejBtn.title = '作成完了を取り消して作成担当者に修正を依頼します';
    }
  } else {
    // 作成担当者（およびオーナー）
    if (rejBtn) rejBtn.style.display = 'none';
    if (shiftPublished) {
      btn.textContent = '↩️ 作成完了を取り消す';
      btn.className = 'hbtn pub-off';
    } else {
      btn.textContent = '✅ シフト作成完了';
      btn.className = 'hbtn pub';
    }
  }

  // 確認状況・差し戻し状況の表示
  if (apprLabel) {
    if (a.rejected && !shiftPublished) {
      apprLabel.textContent = '⚠️ 差し戻し（' + (a.rejected.by || '確認者') + ' ' + (a.rejected.at || '') + '）';
      apprLabel.style.color = 'var(--red)';
      apprLabel.title = a.rejected.note ? '理由: ' + a.rejected.note : '理由の記入はありません';
      apprLabel.style.display = '';
    } else if (a.approvalSkipped && shiftPublished) {
      apprLabel.textContent = '⚠️ 確認省略（オーナー）';
      apprLabel.style.color = 'var(--amber)';
      apprLabel.title = 'オーナーアカウントが確認者の確認を省略して公開しました\n確認者: '
        + (a.approvers.map(x => x.name).join('・') || 'なし');
      apprLabel.style.display = '';
    } else if (a.required > 0 && shiftPublished) {
      const detail = a.approvers.map(x => (x.approved ? '✅ ' : '⬜ ') + x.name + (x.at ? '（' + x.at + '）' : '')).join('\n');
      apprLabel.textContent = a.approvedAll
        ? ('✅ 確認完了 ' + a.approvedCount + '/' + a.required + (a.notified ? '・公開済み' : ''))
        : ('⏳ 確認 ' + a.approvedCount + '/' + a.required);
      apprLabel.style.color = a.approvedAll ? 'var(--green)' : 'var(--amber)';
      apprLabel.title = '確認状況\n' + detail + '\n\nクリックで詳細を表示';
      apprLabel.style.display = '';
    } else {
      hide(apprLabel);
    }
  }
  if (openLabel) {
    openLabel.textContent = shiftOpenDate ? ('公開予定日: ' + shiftOpenDate) : '';
    openLabel.style.display = shiftOpenDate ? '' : 'none';
  }
}

// ヘッダーの確認状況ラベルをクリックしたときに開く一覧。
// 誰が確認済みで誰が未確認かを（tooltip ではなく）画面上で確認できるようにする
function openApprovalModal() {
  const a = shiftApproval;
  const box = document.getElementById('approval-modal');
  if (!box) return;
  const sub  = document.getElementById('apv-sub');
  const list = document.getElementById('apv-list');

  const ym = curYM ? (curYM.year + '年' + curYM.month + '月') : '';
  sub.textContent = (ym ? ym + 'のシフト　' : '')
    + (shiftPublished
        ? '作成完了' + (a.doneByName ? '（' + a.doneByName + '）' : '')
        : '作成完了になっていません');

  let html = '';
  if (a.rejected && !shiftPublished) {
    html += '<div class="apv-note rej">⚠️ ' + esc(a.rejected.by || '確認者') + ' さんが差し戻しました'
         + (a.rejected.at ? '（' + esc(a.rejected.at) + '）' : '')
         + '<br>理由: ' + esc(a.rejected.note || '（記入なし）') + '</div>';
  }
  if (a.approvalSkipped && shiftPublished) {
    html += '<div class="apv-note warn">⚠️ オーナーアカウントが確認者の確認を省略して作成完了にしました。'
         + '下記の確認者には確認依頼が送られていません。</div>';
  }
  if (a.required === 0) {
    html += '<div class="apv-note warn">確認者が登録されていません（確認なしで公開されます）。'
         + '確認者は管理アプリのメンバー管理で「シフト確認者」に指定します。</div>';
  } else {
    html += a.approvers.map(x => {
      const at = x.approved ? esc(x.at || '') : (shiftPublished ? '確認待ち' : '—');
      return '<div class="apv-row' + (x.approved ? ' done' : '') + '">'
        + '<span class="apv-ico">' + (x.approved ? '✅' : '⬜') + '</span>'
        + '<span class="apv-name">' + esc(x.name) + '</span>'
        + '<span class="apv-at' + (x.approved ? '' : ' wait') + '">' + at + '</span></div>';
    }).join('');
    html += '<div style="font-size:11px;color:var(--ink3);margin-top:8px;">確認済み '
         + a.approvedCount + ' / ' + a.required + ' 名</div>';
  }
  list.innerHTML = html;
  box.classList.add('on');
}

function closeApprovalModal() {
  const box = document.getElementById('approval-modal');
  if (box) box.classList.remove('on');
}

// 表示中の月が公開操作の対象外か（限定PW・未取得のうちは制限しない）。
// 対象になるのは「申込中の月」と「シフトが作成完了になっている月」の両方。
// 前月のシフトが動いている最中に次月の申込を開始すると前月は申込中ではなくなるが、
// そのシフトの取り消し・確認完了・差し戻しは引き続きできる必要がある
function isOffPublishedMonth() {
  if (currentPwType !== 'normal' || !ymLoaded || !curYM) return false;
  return !isPublishedYM(curYM) && !isShiftPubYM(curYM);
}

// ヘッダーの1つのボタンが、押した人の役割で意味を変える：
//   確認者（メンバー管理で「確認者」に指定された管理者） … 確認完了
//   それ以外の管理者（作成担当者）                       … 作成完了 / 取り消し
async function togglePublish() {
  if (isOffPublishedMonth()) return;
  if (shiftApproval.isApprover) { await approveShift(); return; }

  if (shiftPublished) {
    const msg = shiftApproval.required > 0
      ? 'シフト作成完了を取り消しますか？\n\n確認者の確認記録もリセットされ、次に作成完了にしたとき改めて確認が必要になります。'
      : 'シフト作成完了を取り消しますか？\n\n公開予定日を迎えていた場合、奉仕者はシフトを確認できなくなります。';
    if (!await uiConfirm({
      type: 'danger', title: 'シフト作成完了の取り消し', message: msg, confirmText: '取り消す',
    })) return;
    try {
      await apiGet('unpublishShift', ymP({
        adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || ''
      }));
      await refreshPublishState();
      toast('作成完了を取り消しました', 's');
    } catch (e) { toast('取り消しに失敗しました: ' + e.message, 'e'); }
  } else {
    // 公開前に整合性チェックを通す。エラーが残っていればパネルを開いて
    // 内容を確認させ、そのうえで公開するかを選ばせる
    syncCurrentBlock();
    refreshValidationUI();
    if (_vResult.issues.some(x => x.level === 'error')) { openPreflight(); return; }
    const names = shiftApproval.approvers.map(x => x.name).join('・');
    const isOwnerSkip = shiftApproval.required > 0 && shiftApproval.isOwner;
    const msg = isOwnerSkip
      // オーナーは確認を省略して公開できる。黙って抜けないよう明示する
      ? ('オーナー権限で確認者の確認を省略して公開します。\n確認者（' + names + '）への確認依頼は送られません。\n\nシフト作成完了にしますか？\n公開予定日を迎えると自動的に奉仕者へ公開・通知されます。')
      : shiftApproval.required > 0
      ? ('シフト作成完了にしますか？\n\n確認者（' + names + '）に確認依頼の通知が送られます。\n全員の確認が完了し、公開予定日を迎えると奉仕者へ自動的に公開・通知されます。')
      : 'シフト作成完了にしますか？\n\n公開予定日を迎えると自動的に奉仕者へ公開・通知されます（予定日を過ぎている場合は即座に公開・通知されます）。';
    if (!await uiConfirm({
      type: isOwnerSkip ? 'danger' : 'warn', title: 'シフト作成完了', message: msg,
      confirmText: '作成完了にする',
    })) return;
    await doPublish();
  }
}

async function doPublish() {
  closePreflight();
  setLoading(true, 'シフトを作成完了にしています...');
  try {
    const res = await apiGet('publishShift', ymP({
      adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || '',
      adminEmail: (adminUser && adminUser.email) || ''
    }));
    await refreshPublishState();
    toast(res && res.approvalRequired ? 'シフト作成完了にしました。確認者へ確認依頼を送信しました'
        : res && res.approvalSkipped  ? 'シフト作成完了にしました（オーナー権限で確認を省略）'
        : 'シフト作成完了にしました', 's');
  } catch (e) { toast('処理に失敗しました: ' + e.message, 'e'); }
  finally { setLoading(false); }
}

// 確認者が押す「確認完了」。force=true は公開前チェックパネルから承認する場合
// （既にエラー内容を一覧で確認済みなのでチェックで止めない）
async function approveShift(force) {
  if (!shiftPublished) return;
  if (shiftApproval.approvedByMe) return;
  // 確認者にも整合性チェックの結果を見せてから承認させる
  if (!force) {
    syncCurrentBlock();
    refreshValidationUI();
    if (_vResult.issues.some(x => x.level === 'error')) {
      toast('エラーの指摘が残っています。内容を確認してください', 'e');
      openPreflight();
      return;
    }
  }
  const rest = Math.max(0, shiftApproval.required - shiftApproval.approvedCount - 1);
  if (!await uiConfirm({
    type: 'warn', title: 'シフトの確認完了',
    message: 'シフト内容を確認しました（確認完了）にしますか？\n\n' + (rest > 0
      ? '残り ' + rest + ' 名の確認が完了すると公開できる状態になります。'
      : 'あなたの確認で全員そろいます。公開予定日を迎えると奉仕者へ自動的に公開・通知されます。'),
    confirmText: '確認完了にする',
  })) return;
  setLoading(true, '確認完了として登録しています...');
  try {
    const res = await apiGet('approveShift', ymP({
      adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || ''
    }));
    if (!res.ok) throw new Error(res.error || '登録に失敗しました');
    await refreshPublishState();
    toast(res.allApproved
      ? (res.published ? '確認が揃い、奉仕者へ公開しました' : '確認が揃いました。公開予定日に自動公開されます')
      : '確認完了にしました（あと ' + Math.max(0, (res.approval?.required || 0) - (res.approval?.approvedCount || 0)) + ' 名）', 's');
  } catch (e) { toast('確認完了にできませんでした: ' + e.message, 'e'); }
  finally { setLoading(false); }
}

// 確認者が押す「差し戻す」。作成完了を取り消して作成担当者へ通知する
async function rejectShift() {
  if (isOffPublishedMonth() || !shiftApproval.isApprover || !shiftPublished) return;
  const note = prompt('差し戻す理由を入力してください（作成担当者に通知されます）', '');
  if (note === null) return;
  const extra = shiftApproval.notified
    ? '\n\n※ このシフトは既に奉仕者へ公開されています。差し戻すと奉仕者から見えなくなります。'
    : '';
  if (!await uiConfirm({
    type: 'danger', title: 'シフトの差し戻し',
    message: 'シフトを差し戻しますか？\n\n作成完了が取り消され、確認記録もリセットされます。' + extra,
    confirmText: '差し戻す',
  })) return;
  setLoading(true, '差し戻しています...');
  try {
    const res = await apiGet('rejectShift', ymP({
      note, adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || ''
    }));
    if (!res.ok) throw new Error(res.error || '差し戻しに失敗しました');
    await refreshPublishState();
    toast('差し戻しました。作成担当者へ通知しました', 's');
  } catch (e) { toast('差し戻しに失敗しました: ' + e.message, 'e'); }
  finally { setLoading(false); }
}

// ===== スマートフォン表示 =====
// css/shift-create.css の @media (max-width:700px) と同じ境界。
// 分割表示・比較パネルのように横幅を前提にした機能は、この幅では成立しない
const SC_MOBILE_Q = window.matchMedia('(max-width:700px)');
function isScMobile() { return SC_MOBILE_Q.matches; }

// 幅が境界をまたいだら、その幅で成立しない表示状態を解除する
SC_MOBILE_Q.addEventListener('change', () => {
  if (isScMobile()) {
    if (splitMode)   toggleSplitView();
    if (compareMode) toggleCompareMode();
  }
  applyLpForWidth();
});

// 左パネルリサイズ
const LP_MIN = 140, LP_MAX = 360;
let lpCollapsed = false, lpWidth = 196;

// 開閉は PC・スマホ共通で collapsed の付け外し。違いは CSS 側で、
// スマホでは開いても枠は幅0のまま、中身だけが本文の上に重なる
function toggleLp() {
  lpCollapsed = !lpCollapsed;
  setLpCollapsed(lpCollapsed);
}

function setLpCollapsed(collapsed) {
  lpCollapsed = collapsed;
  const w = document.getElementById('lpWrap'), t = document.getElementById('lpToggle');
  if (!w || !t) return;
  if (collapsed) { w.classList.add('collapsed'); t.textContent = '▶'; }
  else {
    w.classList.remove('collapsed');
    // スマホは CSS の width:0!important が効くので、幅は触らない
    if (!isScMobile()) w.style.width = lpWidth + 'px';
    t.textContent = '◀';
  }
  syncLpBackdrop();
}

// 引き出しが開いている間だけ、外をタップして閉じるための覆いを出す
function syncLpBackdrop() {
  const bd = document.getElementById('lp-backdrop'), w = document.getElementById('lpWrap');
  if (bd && w) bd.classList.toggle('on', isScMobile() && !w.classList.contains('collapsed'));
}

// スマホでは画面の大半を覆ってしまうので、初期状態は閉じておく
function applyLpForWidth() {
  if (isScMobile()) { if (!lpCollapsed) setLpCollapsed(true); else syncLpBackdrop(); }
  else syncLpBackdrop();
}
applyLpForWidth();

// ドラッグ中に左パネルを閉じる（js/dnd.js から呼ぶ）。
// スマホでは引き出しが表を覆っているので、掴んだままでは運ぶ先が見えない
function closeLpForDrag() {
  if (isScMobile() && !lpCollapsed) setLpCollapsed(true);
}
document.getElementById('lpResize').addEventListener('mousedown', e => {
  e.preventDefault(); document.getElementById('lpResize').classList.add('dragging');
  const sx = e.clientX, sw = document.getElementById('lpWrap').offsetWidth;
  const mv = e => { const w = Math.min(LP_MAX, Math.max(LP_MIN, sw + (e.clientX - sx))); lpWidth = w; document.getElementById('lpWrap').style.width = w + 'px'; };
  const up = () => { document.getElementById('lpResize').classList.remove('dragging'); document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
});

// ===== 分割・比較パネル リサイズ =====
(function() {
  function initRsz(bar, getA, getB, minA, minB) {
    bar.addEventListener('mousedown', e => {
      e.preventDefault();
      bar.classList.add('dragging');
      const panA = getA(), panB = getB();
      const startX = e.clientX, startW = panA.offsetWidth;
      const total = panA.offsetWidth + panB.offsetWidth;
      const mv = e => {
        const w = Math.max(minA, Math.min(total - minB, startW + (e.clientX - startX)));
        panA.style.flex = `0 0 ${w}px`;
        panB.style.flex = '1 1 0';
      };
      const up = () => {
        bar.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }
  const sr = document.getElementById('split-rsz');
  if (sr) initRsz(sr, () => document.getElementById('tab-wish'), () => document.getElementById('tab-create'), 240, 240);
  const cr = document.getElementById('cmp-rsz');
  if (cr) initRsz(cr, () => document.querySelector('#tab-create .rm-wrap'), () => document.getElementById('cmp-panel'), 200, 200);
})();

// ============================================================
// TAB3: 設定
// ============================================================
async function loadSettingsData() {
  setLoading(true, '設定を読み込み中...');
  try {
    const [lr, cr, sr, vr] = await Promise.all([apiGet('getLocations', {}), apiGet('getCartNumbers'), apiGet('getDefaultSlot'), apiGet('getValidationRules', {}).catch(() => ({ ok: false }))]);
    settingsVRules = vr.ok ? (vr.rules || {}) : {};
    setValidationConfig(settingsVRules);
    settingsLocations    = lr.ok ? lr.locations    : [];
    settingsCartNumbers  = cr.ok ? cr.cartNumbers  : [];
    defaultSlot  = sr.ok ? sr.defaultSlot  : 15;
    renderLocationList(); renderCartTags(); renderValidationRules();
    const sel = document.getElementById('default-slot-sel'); if (sel) sel.value = String(defaultSlot);
    settingsLoaded = true; setLoading(false);
  } catch (e) { setLoading(false); toast('設定読み込みエラー: ' + e.message, 'e'); }
}

// ------------------------------------------------------------
// 場所管理
// 有効範囲は3択：
//   always … 常時有効（開始・終了なし）
//   period … 期間指定（startYM 〜 endYM。年月は選択式ピッカーで入力する）
//   pw     … 限定PW に紐づけ（linkPwType。期間は使わず、その限定PWの
//            シフト作成でのみ表示される）
// ------------------------------------------------------------
function locMode(loc) { return loc.linkPwType ? 'pw' : ((loc.startYM || loc.endYM) ? 'period' : 'always'); }
function pwTypeName(id) { const s = pwTypeList.find(p => p.id === id); return s ? s.name : id; }
function ymLabel(ym) { const m = /^(\d{4})[.\-/](\d{1,2})$/.exec(String(ym || '').trim()); return m ? `${m[1]}年${parseInt(m[2], 10)}月` : ''; }

function locScopeHtml(loc) {
  const mode = locMode(loc);
  if (mode === 'pw')     return `<span class="loc-badge pw">🎯 ${esc(pwTypeName(loc.linkPwType))} 専用</span>`;
  if (mode === 'period') return `<span class="loc-badge period">📅 ${ymLabel(loc.startYM) || '開始未指定'} 〜 ${ymLabel(loc.endYM) || 'ずっと'}</span>`;
  return '<span class="loc-badge always">🔁 常時有効</span>';
}

function renderLocationList() {
  const list = document.getElementById('location-list');
  if (!list) return;
  if (settingsLocations.length === 0) { list.innerHTML = '<div style="font-size:12px;color:var(--ink3);padding:8px 0;">場所が登録されていません</div>'; return; }
  list.innerHTML = settingsLocations.map((loc, i) => `
    <div class="setting-row">
      <div style="flex:1;min-width:0;"><div class="setting-name">${esc(loc.name)}</div>
      <div class="setting-detail" style="margin-top:2px;">${locScopeHtml(loc)}</div></div>
      <div class="setting-actions">
        <button class="s-btn" onclick="openLocModal(${i})">編集</button>
        <button class="s-btn del" onclick="deleteLocation(${i})">削除</button>
      </div>
    </div>`).join('');
}
async function deleteLocation(i) {
  if (!await uiConfirm({
    type: 'danger', title: '場所の削除',
    message: `「${settingsLocations[i].name}」を削除しますか？`, confirmText: '削除する',
  })) return;
  settingsLocations.splice(i, 1); renderLocationList();
}

// ===== 追加・編集モーダル（追加と編集で同じモーダルを使う） =====
let locForm    = { idx: -1, name: '', mode: 'always', startYM: '', endYM: '', linkPwType: '' };
let _ympTarget = null;  // 年月ピッカーの編集対象 'start' | 'end' | null（閉じている）
let _ympYear   = 0;     // 年月ピッカーが表示している年

function openLocModal(i) {
  const src = i >= 0 ? settingsLocations[i] : { name: '', startYM: '', endYM: '', linkPwType: '' };
  locForm = { idx: i, name: src.name || '', mode: locMode(src), startYM: src.startYM || '', endYM: src.endYM || '', linkPwType: src.linkPwType || '' };
  document.getElementById('loc-modal-title').textContent = i >= 0 ? '📍 場所を編集' : '📍 場所を追加';
  document.getElementById('loc-save-btn').textContent    = i >= 0 ? '保存' : '追加';
  document.getElementById('loc-name').value = locForm.name;
  // 限定PWタブで編集中の場所は、既にその限定PW専用。さらに別の限定PWへ
  // 紐づける意味がないので「限定PW」の選択肢は通常PWタブでのみ出す
  const segPw = document.getElementById('loc-seg-pw');
  segPw.style.display = (currentPwType === 'normal' || locForm.linkPwType) ? '' : 'none';
  _ympTarget = null;
  applyLocMode(locForm.mode);
  document.getElementById('loc-modal').classList.add('on');
  setTimeout(() => { const n = document.getElementById('loc-name'); if (n) n.focus(); }, 50);
}
function closeLocModal() { closeYmp(); document.getElementById('loc-modal').classList.remove('on'); }

function applyLocMode(mode) {
  locForm.mode = mode;
  document.querySelectorAll('#loc-scope-seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  document.getElementById('loc-pane-always').classList.toggle('on', mode === 'always');
  document.getElementById('loc-pane-period').classList.toggle('on', mode === 'period');
  document.getElementById('loc-pane-pw').classList.toggle('on', mode === 'pw');
  if (mode !== 'period') closeYmp();
  if (mode === 'pw') renderLocPwSelect();
  renderYmFields();
}

function renderLocPwSelect() {
  const box = document.getElementById('loc-pw-wrap');
  if (!box) return;
  if (pwTypeList.length === 0) {
    box.innerHTML = '<div class="loc-note">限定PWが登録されていません。先に限定PWを追加してから紐づけてください。</div>';
    return;
  }
  if (!locForm.linkPwType || !pwTypeList.some(p => p.id === locForm.linkPwType)) locForm.linkPwType = pwTypeList[0].id;
  box.innerHTML = `<label>紐づける限定PW</label>
    <select id="loc-pw-sel" onchange="locForm.linkPwType=this.value">
      ${pwTypeList.map(p => `<option value="${esc(p.id)}"${locForm.linkPwType === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>
    <div class="loc-note" style="margin-top:8px;">この場所は選んだ限定PWのシフト作成でのみ表示されます（年月の指定は不要）。設定の編集はこのタブから行えます。</div>`;
}

function renderYmFields() {
  const set = (id, ym, ph, on) => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = (ym ? `<span>${ymLabel(ym) || esc(ym)}</span>` : `<span class="ph">${ph}</span>`) + '<span class="ar">▼</span>';
    el.classList.toggle('on', on);
  };
  set('loc-start-btn', locForm.startYM, '指定なし', _ympTarget === 'start');
  set('loc-end-btn',   locForm.endYM,   '指定なし', _ympTarget === 'end');
}

function toggleYmp(target) {
  if (_ympTarget === target) { closeYmp(); return; }
  _ympTarget = target;
  const cur = target === 'start' ? locForm.startYM : locForm.endYM;
  const m = /^(\d{4})/.exec(cur || '');
  _ympYear = m ? parseInt(m[1], 10) : new Date().getFullYear();
  document.getElementById('ymp').classList.add('on');
  renderYmp(); renderYmFields();
}
function closeYmp() {
  _ympTarget = null;
  const p = document.getElementById('ymp'); if (p) p.classList.remove('on');
  renderYmFields();
}
function ympYear(d) { _ympYear += d; renderYmp(); }

function renderYmp() {
  const box = document.getElementById('ymp');
  if (!box || !_ympTarget) return;
  const s = locForm.startYM, e = locForm.endYM;
  const d = new Date();
  const nowYM = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
  let g = '';
  for (let mo = 1; mo <= 12; mo++) {
    const ym = _ympYear + '.' + String(mo).padStart(2, '0');
    const cls = [];
    if (ym === s || ym === e) cls.push('sel');
    else if (s && e && ym > s && ym < e) cls.push('in');
    if (ym === nowYM) cls.push('now');
    g += `<button type="button" class="${cls.join(' ')}" onclick="pickYm('${ym}')">${mo}月</button>`;
  }
  box.innerHTML = `
    <div class="ymp-hd">
      <button type="button" class="ymp-nav" onclick="ympYear(-1)">‹</button>
      <b>${_ympYear}年 <span style="font-weight:400;color:var(--ink3);font-size:10px;">${_ympTarget === 'start' ? '開始' : '終了'}を選択</span></b>
      <button type="button" class="ymp-nav" onclick="ympYear(1)">›</button>
    </div>
    <div class="ymp-grid">${g}</div>
    <div class="ymp-ft">
      <span class="hint">${s || e ? `${ymLabel(s) || '指定なし'} 〜 ${ymLabel(e) || 'ずっと'}` : '未設定（どちらか一方だけでも可）'}</span>
      <button type="button" class="s-btn" onclick="pickYm('')">指定なし</button>
    </div>`;
}

function pickYm(ym) {
  const isStart = _ympTarget === 'start';
  if (isStart) locForm.startYM = ym; else locForm.endYM = ym;
  // 開始＞終了の逆転を防ぐ（今選んだ側に合わせる）
  if (locForm.startYM && locForm.endYM && locForm.startYM > locForm.endYM) {
    if (isStart) locForm.endYM = locForm.startYM; else locForm.startYM = locForm.endYM;
  }
  // 開始を選んだ直後で終了が未設定なら、そのまま終了の選択へ進む
  if (ym && isStart && !locForm.endYM) { _ympTarget = 'end'; renderYmp(); renderYmFields(); return; }
  closeYmp();
}

function saveLocForm() {
  const name = document.getElementById('loc-name').value.trim();
  if (!name) { toast('場所名を入力してください', 'e'); return; }
  if (locForm.mode === 'pw') {
    if (pwTypeList.length === 0) { toast('紐づけられる限定PWがありません', 'e'); return; }
    if (!locForm.linkPwType)     { toast('紐づける限定PWを選んでください', 'e'); return; }
  }
  if (locForm.mode === 'period' && !locForm.startYM && !locForm.endYM) { toast('開始または終了の年月を選択してください', 'e'); return; }
  const rec = {
    name,
    startYM:    locForm.mode === 'period' ? locForm.startYM    : '',
    endYM:      locForm.mode === 'period' ? locForm.endYM      : '',
    linkPwType: locForm.mode === 'pw'     ? locForm.linkPwType : ''
  };
  if (locForm.idx >= 0) settingsLocations[locForm.idx] = rec; else settingsLocations.push(rec);
  renderLocationList(); closeLocModal();
}
async function saveLocations() {
  try { await apiGet('saveLocations', { locations: settingsLocations }); toast('場所設定を保存しました', 's'); createLoaded = false; }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}

// ===== 検証ルール設定 =====
// VRULES の既定値を土台に、変更したぶんだけ settings へ保存する
function renderValidationRules() {
  const box = document.getElementById('vrule-list');
  if (!box || typeof VRULES !== 'object') return;
  box.innerHTML = Object.keys(VRULES).map(id => {
    const def = VRULES[id];
    const cur = Object.assign({}, def, settingsVRules[id] || {});
    const scope = def.scope === 'publish' ? '公開前のみ' : '編集中';
    return `<div class="vr-row">
      <label class="vr-on"><input type="checkbox" data-rule="${id}" data-f="on"${cur.on ? ' checked' : ''} onchange="onVRuleChange(this)"></label>
      <div class="vr-main"><div class="vr-label">${esc(def.label)}</div><div class="vr-meta">${scope}</div></div>
      <select class="vr-level" data-rule="${id}" data-f="level" onchange="onVRuleChange(this)">
        <option value="error"${cur.level === 'error' ? ' selected' : ''}>⛔ エラー</option>
        <option value="warn"${cur.level === 'warn' ? ' selected' : ''}>⚠️ 警告</option>
      </select>
    </div>`;
  }).join('');
}

function onVRuleChange(el) {
  const id = el.dataset.rule, f = el.dataset.f;
  const v = f === 'on' ? el.checked : el.value;
  settingsVRules[id] = settingsVRules[id] || {};
  settingsVRules[id][f] = v;
  // 既定値と同じに戻したら上書きを消しておく（保存内容を最小限に保つ）
  if (VRULES[id][f] === v) {
    delete settingsVRules[id][f];
    if (Object.keys(settingsVRules[id]).length === 0) delete settingsVRules[id];
  }
}

async function saveValidationRules() {
  try {
    await apiGet('saveValidationRules', { rules: settingsVRules,
      adminUid: (adminUser && adminUser.uid) || '', adminName: (adminUser && adminUser.name) || '' });
    setValidationConfig(settingsVRules);
    if (createLoaded) refreshValidationUI();
    toast('検証ルールを保存しました', 's');
  } catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}

async function resetValidationRules() {
  if (!await uiConfirm({
    type: 'danger', title: '検証ルールのリセット',
    message: '検証ルールを既定値に戻しますか？', confirmText: '既定値に戻す',
  })) return;
  settingsVRules = {};
  renderValidationRules();
  saveValidationRules();
}

function renderCartTags() {
  document.getElementById('cart-tag-list').innerHTML = settingsCartNumbers.map((n, i) =>
    `<span class="tag">${esc(n)}<button class="del-t" onclick="deleteCartNum(${i})">×</button></span>`).join('');
}
function addCartNum() { const v = document.getElementById('new-cart-num').value.trim(); if (!v) return; if (settingsCartNumbers.includes(v)) { toast('すでに追加されています', 'e'); return; } settingsCartNumbers.push(v); renderCartTags(); document.getElementById('new-cart-num').value = ''; }
function deleteCartNum(i) { settingsCartNumbers.splice(i, 1); renderCartTags(); }
async function saveCartNumbers() {
  try { await apiGet('saveCartNumbers', { cartNumbers: settingsCartNumbers }); toast('カート番号を保存しました', 's'); createLoaded = false; }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}


async function saveDefaultSlot() {
  const v = parseInt(document.getElementById('default-slot-sel').value);
  try { await apiGet('saveDefaultSlot', { defaultSlot: v }); defaultSlot = v; toast('デフォルトスロット分数を保存しました', 's'); }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}

async function execCreateShiftSheet() {
  if (!await uiConfirm({
    type: 'danger', title: 'シフト作成枠の作成',
    message: '現在のシフトデータをバックアップし、3シートをクリアします。\n\n実行してもよいですか？',
    confirmText: '実行する',
  })) return;
  setLoading(true, 'シフト作成枠を作成中...');
  try {
    const res = await apiGet('createShiftSheet', ymP());
    if (!res.ok) throw new Error(res.error || '失敗');
    toast('シフト作成枠を作成しました（' + (res.yearMonth || '') + '）', 's');
    createLoaded = false;
  } catch (e) { toast('エラー: ' + e.message, 'e'); }
  finally { setLoading(false); }
}

// ============================================================
// ユーティリティ
// ============================================================
function setLoading(on, msg) { document.getElementById('loading-overlay').style.display = on ? 'flex' : 'none'; if (msg) document.getElementById('lo-msg').textContent = msg; }
function toast(msg, type) { const ta = document.getElementById('ta'), t = document.createElement('div'); t.className = 'toast' + (type ? ' ' + type : ''); t.textContent = msg; ta.appendChild(t); setTimeout(() => t.remove(), 2800); }
function esc(str) { return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

initAuth();
