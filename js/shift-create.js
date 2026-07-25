// API_URL / ANON_KEY / CLIENT_ID は js/api.js（共有通信層）で定義

let currentPwType = (() => { try { return new URLSearchParams(location.search).get('type') || 'normal'; } catch(e) { return 'normal'; } })();
let adminUser     = null;
let memberFlags   = {};
let applicants    = [];
let shiftDates    = [];
let locations     = [];
let cartNumbers   = [];
let cartPresets   = [];
let conflictMap   = {}; // uid -> { hasLimitedApply|hasNormalApply: dates[], hasLimitedSlot|hasNormalSlot: dates[] }
// 設定タブ（タブ3）専用：タブ2「シフト作成」のlocations/cartNumbers/cartPresets（年月で絞り込まれた値）とは
// 完全に分離し、設定タブを開いている間はタブ2側の再読み込みに影響されないようにする
let settingsLocations    = [];
let settingsCartNumbers  = [];
let settingsCartPresets  = [];
let memoMap       = {};
let respCounts    = {}; // UID別：当月の責任者 配置回数（保存済みデータのみ反映）
let cartCounts    = {}; // UID別：当月のカート担当 配置回数（保存済みデータのみ反映）
let slotAssignCounts = {}; // UID別：当月のシフト割当回数（1コマにつき1回。同一コマ内の複数行への配置はまとめて1回）
let defaultSlot   = 15;
let shiftPublished = false;
let activeDateIdx = 0;
let activeTimeIdx = 0;
let curYM         = null;
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

// ============================================================
// 認証
// ============================================================
function initAuth() {
  try { const u = JSON.parse(localStorage.getItem('adminUser') || 'null'); if (u && u.isAdmin) { adminUser = u; showApp(); return; } } catch (_) {}
  showLogin();
}
function showLogin() { document.getElementById('login-screen').style.display = 'flex'; document.getElementById('app-screen').style.display = 'none'; renderGsiButton(); }
function renderGsiButton() {
  if (typeof google !== 'undefined' && google.accounts) {
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onGoogleLogin });
    google.accounts.id.renderButton(document.getElementById('gsi-btn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
  } else { setTimeout(renderGsiButton, 100); }
}
async function onGoogleLogin(resp) {
  try {
    setLoading(true, '認証中...');
    const payload = JSON.parse(atob(resp.credential.split('.')[1]));
    const d = await apiAuthGet(payload.email, 'admin');
    if (!d.ok || !d.isAdmin) { setLoading(false); toast('管理者権限がありません', 'e'); return; }
    adminUser = { email: payload.email, name: d.name || payload.email, uid: d.uid || '', isAdmin: true, picture: payload.picture || '' };
    localStorage.setItem('adminUser', JSON.stringify(adminUser));
    setLoading(false); showApp();
  } catch (e) { setLoading(false); toast('ログインエラー: ' + e.message, 'e'); }
}
function signOut() { try { localStorage.removeItem('adminUser'); } catch (_) {} toast('ログアウトしました', 's'); setTimeout(() => location.reload(), 800); }
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
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
      apiGet('getShiftPublishStatus'),
      apiGet('getLimitedSlots', {})
    ]);
    shiftPublished = statusRes.ok && statusRes.published;
    updatePublishBtn();
    pwTypeList = slotsRes.ok ? (slotsRes.slots || []) : [];
    renderPwTabsSc();
    setLoading(false);
  }
  catch (e) { setLoading(false); toast('読み込みエラー: ' + e.message, 'e'); }
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
    // 公開状態は常に更新
    const statusRes = await apiGet('getShiftPublishStatus');
    shiftPublished = statusRes.ok && statusRes.published;
    updatePublishBtn();

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
  if (name === 'create' && !createLoaded) loadCreateData();
  if (name === 'settings' && !settingsLoaded) loadSettingsData();
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
    apiGet('getWishData', {}),
    Object.keys(memberFlags).length > 0 ? Promise.resolve({ ok: true, flags: memberFlags }) : apiGet('getMemberFlags'),
    apiGet('getShiftCreateData', {})
  ]);
  const year  = res.year  || new Date().getFullYear();
  const month = res.month || new Date().getMonth() + 1;
  if (!curYM) curYM = { year, month };
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
  const tbl = document.querySelector('#wish-table-wrap table.wish-tbl');
  if (!tbl) return;
  const assignMap = buildAssignmentMap({ dates: shiftDates });
  const counts = {};
  tbl.querySelectorAll('td[data-slot]').forEach(td => {
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
  tbl.querySelectorAll('td[data-assign-total]').forEach(td => {
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

  // 総申込スロット数を計算
  const totalSlots = {};
  members.forEach(m => {
    totalSlots[m.uid] = sortedSlots.filter(slot => matrix[m.uid] && matrix[m.uid][slot]).length;
  });

  // 割当済みスロット数を計算
  const totalAssigned = {};
  members.forEach(m => {
    totalAssigned[m.uid] = sortedSlots.filter(slot => assignMap[m.uid] && assignMap[m.uid].has(slot)).length;
  });

  // 未申込者を抽出（memberFlagsの全メンバーのうち、matrixにいない人）
  const appliedUids = new Set(members.map(m => m.uid));
  const notAppliedMembers = Object.entries(memberFlags)
    .filter(([uid]) => !appliedUids.has(uid))
    .map(([uid, f]) => ({ uid, name: f.name, furigana: f.furigana || '' }))
    .sort((a, b) => a.furigana.localeCompare(b.furigana) || a.name.localeCompare(b.name));

  let html = '<div class="wish-snap-outer"><table class="wish-tbl">';
  html += '<thead>';
  html += '<tr><th class="col-name th-date" rowspan="2" style="position:sticky;top:0;left:0;z-index:11;">氏名</th>';
  dg.forEach(g => { html += `<th class="th-date" colspan="${g.times.length}" style="position:sticky;top:0;z-index:3;">${esc(g.date)}</th>`; });
  html += '<th class="th-date" rowspan="2" style="position:sticky;top:0;right:50px;z-index:11;min-width:50px;">合計</th>';
  html += '<th class="th-date" rowspan="2" style="position:sticky;top:0;right:0;z-index:11;min-width:50px;background:var(--purple-l);color:var(--purple);">割当</th></tr>';
  html += '<tr>';
  sortedSlots.forEach(slot => { const si = slot.indexOf(' '); html += `<th class="th-time" style="position:sticky;top:28px;z-index:3;">${esc(si >= 0 ? slot.slice(si + 1) : slot)}</th>`; });
  html += '</tr></thead><tbody>';

  members.forEach(m => {
    const row = matrix[m.uid] || {};
    html += '<tr><td class="col-name" style="position:sticky;left:0;z-index:2;">' + esc(m.name) + '</td>';
    sortedSlots.forEach(slot => {
      const val = row[slot];
      const isAssigned = !!(assignMap[m.uid] && assignMap[m.uid].has(slot));
      const hc = typeof val === 'object' && val.comment;
      const comment = hc ? val.comment : '';
      // data-uid / data-slot / data-applied は refreshWishAssign() の差分更新用
      const dataAttr = `data-uid="${esc(m.uid)}" data-slot="${esc(slot)}" data-applied="${val ? 1 : 0}"`;
      html += `<td class="${wishCellClass(!!val, isAssigned)}" style="cursor:pointer;" ${dataAttr} onclick="openWishEdit(this,'${esc(m.uid)}','${esc(m.name)}','${esc(slot)}',${val ? 'true' : 'false'},'${esc(comment)}')">${wishCellInner(!!val, isAssigned, !!hc)}</td>`;
    });
    html += `<td class="cell-data" style="position:sticky;right:50px;background:var(--green4);font-weight:700;color:var(--green);z-index:2;">${totalSlots[m.uid] || 0}</td>`;
    html += `<td class="cell-data" data-assign-total="${esc(m.uid)}" style="position:sticky;right:0;background:var(--purple-l);font-weight:700;color:var(--purple);z-index:2;">${totalAssigned[m.uid] || 0}</td>`;
    html += '</tr>';
  });

  // 申込数集計行
  html += '<tr style="background:var(--green4);"><td class="col-name" style="font-weight:700;color:var(--green-d);position:sticky;left:0;z-index:2;">申込数</td>';
  sortedSlots.forEach(slot => { let c = 0; members.forEach(m => { if (matrix[m.uid] && matrix[m.uid][slot]) c++; }); html += `<td class="cell-data" style="font-weight:700;color:var(--green);">${c}</td>`; });
  html += '<td class="cell-data" style="position:sticky;right:50px;background:var(--green4);z-index:2;"></td>';
  html += '<td class="cell-data" style="position:sticky;right:0;background:var(--purple-l);z-index:2;"></td></tr>';
  html += '</tbody></table></div>';

  // 未申込一覧（折りたたみ）
  if (notAppliedMembers.length > 0) {
    html += `<div class="wish-not-applied-toggle" onclick="toggleWishNotApplied(this)">
      <span>未申込（${notAppliedMembers.length}名）</span>
      <span class="wish-not-applied-arrow">▶</span>
    </div>`;
    html += `<div class="wish-not-applied-body">`;
    html += notAppliedMembers.map(m => `<div class="wna-item">・${esc(m.name)}</div>`).join('');
    html += `</div>`;
  }

  document.getElementById('wish-table-wrap').innerHTML = html;
}
// 参加希望 編集モーダル（希望確認タブのセルクリックで開く）
let wishEditCtx = null;
// 割当状態（isAssigned）はセルの class から読み取る。refreshWishAssign() が
// onclick 属性を書き換えずに済むようにするため
function openWishEdit(el, uid, name, slot, applied, comment) {
  const isAssigned = !!(el && el.classList.contains('cell-on'));
  wishEditCtx = { uid, name, slot, applied, isAssigned };
  document.getElementById('we-title').textContent = name + '｜' + slot;
  document.getElementById('we-comment').value = comment || '';
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
    if (!confirm(`${ctx.name} さんは既にこのスロットにシフト割当済みです。\n不参加に変更しますか？\n※シフト側の割当は自動では変更されません。`)) return;
  }
  const si   = ctx.slot.indexOf(' ');
  const date = si >= 0 ? ctx.slot.slice(0, si) : ctx.slot;
  const time = si >= 0 ? ctx.slot.slice(si + 1) : '';
  const comment = document.getElementById('we-comment').value;
  setLoading(true, '保存中...');
  try {
    const res = await apiGet('adminSetWish', {
      uid: ctx.uid, name: ctx.name, date, time, applied, comment,
      adminUid: adminUser?.uid || '', adminName: adminUser?.name || ''
    });
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
    const res = await apiGet('getApplicants', {});
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
    const [flagsRes, appRes, shiftRes] = await Promise.all([
      apiGet('getMemberFlags'), apiGet('getApplicants', {}), apiGet('getShiftCreateData', {})
    ]);
    const year  = shiftRes.year  || appRes.year  || new Date().getFullYear();
    const month = shiftRes.month || appRes.month || new Date().getMonth() + 1;
    curYM = { year, month };
    document.getElementById('hdr-title').textContent = 'シフト管理アプリ — ' + year + '年' + month + '月';
    memberFlags  = flagsRes.ok ? flagsRes.flags    : {};
    applicants   = appRes.ok  ? appRes.applicants  : [];
    shiftDates   = shiftRes.ok ? shiftRes.dates    : [];
    locations    = shiftRes.locations    || [];
    cartNumbers  = shiftRes.cartNumbers  || [];
    cartPresets  = shiftRes.cartPresets  || [];
    conflictMap  = shiftRes.conflictMap  || {};
    memoMap = {};
    if (shiftRes.memoMap) Object.assign(memoMap, shiftRes.memoMap);
    defaultSlot  = shiftRes.defaultSlot  || 15;
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
  document.getElementById('dtabs').innerHTML = tabs + '<div style="flex:1;"></div><button class="tb-btn" style="margin-right:4px;white-space:nowrap;" onclick="reloadCreateData()">🔄 再読み込み</button><div class="save-st" id="gst" style="display:none;margin-right:8px;"><div class="save-dot"></div><span id="gst-txt">未保存あり</span></div><button class="tb-btn" style="border-color:var(--purple);color:var(--purple);font-weight:700;margin-right:4px;white-space:nowrap;" onclick="saveAll()">💾 すべて保存</button>';
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
  const notApplied = applicants.filter(a => !applied.find(b => b.uid === a.uid));
  // mu() から毎回呼ばれるため、「未申込」セクションの開閉状態を再描画で失わないようにする
  const naOpen = !!document.querySelector('#lp-members .lp-sec-toggle.open');

  document.getElementById('lp-date-label').textContent = tab.date + '（' + tab.weekday + '）' + (blockTime ? ' ' + blockTime : '');
  document.getElementById('lp-count').textContent = applied.length;
  document.getElementById('lp-total').textContent = '名申込 / 全' + applicants.length + '名';

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
    return `<div class="mr-wrap"><div class="mr"><div class="m-dot ${dotClass}"></div><div class="m-name">${esc(a.name)}${bothBadge}</div><div class="lp-badges"><div class="lp-badge-col">${badgeA}${badgeR}</div><div class="lp-badge-col">${badgeK}${badgeW}</div></div></div>${commentHtml}</div>`;
  }).join('');
  if (notApplied.length > 0) {
    html += `<div class="lp-sec lp-sec-toggle${naOpen ? ' open' : ''}" onclick="toggleNotApplied(this)"><span>未申込</span><span class="lp-sec-arrow">▶</span></div>`;
    html += `<div class="lp-not-applied" style="display:${naOpen ? '' : 'none'};">`;
    html += notApplied.map(a => `<div class="mr-wrap"><div class="mr"><div class="m-dot d-off"></div><div class="m-name off">${esc(a.name)}</div></div></div>`).join('');
    html += `</div>`;
  }
  document.getElementById('lp-members').innerHTML = html;
}

function bKey(b) { return b.date + '_' + b.time; }

function buildBlock(block, bi) {
  const applied     = filterAppliedForSlot(block.date, block.time);
  const respMembers = applied.filter(a => a.respFlag);
  const cartMembers = applied.filter(a => a.cartFlag);
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
    ${buildRespArea(bi, block.responsible || {}, respMembers)}
    ${buildCartArea(bi, block.cart || {}, cartMembers)}
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

function buildRespArea(bi, resp, respMembers) {
  const nm = buildNameMap();
  function sel(id, val) {
    let o = '<option value="">—</option>';
    respMembers.forEach(a => { o += `<option value="${esc(a.uid)}"${a.uid === val ? ' selected' : ''}>${esc(a.name)}</option>`; });
    if (val && !respMembers.find(a => a.uid === val)) o += `<option value="${esc(val)}" selected>${esc(nm[val] || val)}</option>`;
    return `<select class="ra-sel" id="${id}" onchange="mu(${bi})">${o}</select>`;
  }
  return `<div class="resp-area"><div class="area-title">責任者（最大2名）</div><div class="ra-row">
    <div class="ra-item"><span class="ra-label">担当①</span>${sel('resp1-'+bi, resp.r1||'')}</div>
    <div class="ra-item"><span class="ra-label">担当②</span>${sel('resp2-'+bi, resp.r2||'')}</div>
  </div></div>`;
}

function buildCartArea(bi, cart, cartMembers) {
  const nm = buildNameMap();
  const nums = cartNumbers.length > 0 ? cartNumbers : ['1','2','3','4'];
  const h1 = nums.slice(0, Math.ceil(nums.length / 2)).join(',');
  const h2 = nums.slice(Math.ceil(nums.length / 2)).join(',');
  const al = nums.join(',');
  const numOpts = [['—',''],['①②', h1],['③④', h2],['①②③④', al]].map(([l, v]) => `<option value="${esc(v)}">${l}</option>`).join('');

  function cSel(id, val) {
    let o = '<option value="">—</option>';
    cartMembers.forEach(a => { o += `<option value="${esc(a.uid)}"${a.uid === val ? ' selected' : ''}>${esc(a.name)}</option>`; });
    if (val && !cartMembers.find(a => a.uid === val)) o += `<option value="${esc(val)}" selected>${esc(nm[val] || val)}</option>`;
    const nid = id.replace('ci', 'cn').replace('co', 'con');
    return `<select class="cart-sel" id="${id}" onchange="ucn('${id}','${nid}');mu(${bi})">${o}</select>`;
  }
  function nSel(id, val, dis) {
    const opts = numOpts.replace(`value="${esc(val)}"`, `value="${esc(val)}" selected`);
    return `<select class="cart-num" id="${id}"${dis ? ' disabled' : ''} onchange="mu(${bi})">${opts}</select>`;
  }
  const { ki1='', kc1='', ki2='', kc2='', ko1='', oc1='', ko2='', oc2='' } = cart;
  return `<div class="cart-area"><div class="area-title cart-title">カート担当者（最大各2名・空白可）</div>
    <div class="tbl-wrap">
    <table class="cart-tbl">
      <thead><tr><th style="width:90px;"></th><th colspan="2">持ち込み</th><th colspan="2">持ち帰り</th></tr></thead>
      <tbody>
        <tr><td class="row-lbl">担当者</td><td>${cSel('ci1-'+bi,ki1)}</td><td>${cSel('ci2-'+bi,ki2)}</td><td>${cSel('co1-'+bi,ko1)}</td><td>${cSel('co2-'+bi,ko2)}</td></tr>
        <tr><td class="row-lbl">カート番号</td><td>${nSel('cn1-'+bi,kc1,!ki1)}</td><td>${nSel('cn2-'+bi,kc2,!ki2)}</td><td>${nSel('con1-'+bi,oc1,!ko1)}</td><td>${nSel('con2-'+bi,oc2,!ko2)}</td></tr>
      </tbody>
    </table>
    </div>
  </div>`;
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

function delCol(bi, li) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = shiftDates.filter(d => d.date === tab.date)[bi];
  if (!block) return;
  syncBlockStateFromDom(bi, block);
  if ((block.usedPlaces || []).length <= 1) { toast('最後の列は削除できません', 'e'); return; }
  const hasContent = (block.slots || []).some(s => ((s.places||[])[li] || []).length > 0);
  const label = block.usedPlaces[li] || '（場所未設定）';
  if (!confirm(`列「${label}」を削除しますか？` + (hasContent ? '\n※ この列に配置された奉仕者も削除されます。' : ''))) return;
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
    html += `</div></th>`;
  });
  html += '</tr>';

  // カート番号選択行（列番号で紐づけ）
  html += '<tr class="th-cart-row"><td class="td-slot-time" style="font-size:10px;color:var(--ink3);font-weight:700;padding:3px 8px;">カート番号</td>';
  colPlaces.forEach((loc, li) => {
    const savedVal = placeCart[li] || '';
    let opts0 = '<option value="">—</option>';
    cartPresets.forEach(p => { opts0 += `<option value="${esc(p)}"${p === savedVal ? ' selected' : ''}>${esc(p)}</option>`; });
    html += `<td class="cart-cell" style="background:${pc[li % pc.length]}20;"><select class="cart-sel-place" id="pc-${bi}-${li}-0" onchange="mu(${bi})" style="width:100%;">${opts0}</select></td>`;
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

function buildPS(bi, ri, li, pi, val, sa, nm, watchOn, dateKey) {
  const id = `ps-${bi}-${ri}-${li}-${pi}`;

  // conflictInfo のラベルを option text に付与
  function conflictSuffix(uid) {
    const ci = conflictMap[uid];
    if (!ci || !dateKey) return '';
    const parts = [];
    if ((ci.hasLimitedApply || []).includes(dateKey)) parts.push('⚠限定申込');
    if ((ci.hasNormalApply  || []).includes(dateKey)) parts.push('⚠通常申込');
    if ((ci.hasLimitedSlot  || []).includes(dateKey)) parts.push('⚠限定割当');
    if ((ci.hasNormalSlot   || []).includes(dateKey)) parts.push('⚠通常割当');
    return parts.length ? ' [' + parts.join(' ') + ']' : '';
  }

  let o = '<option value="">—</option>';
  sa.forEach(a => { o += `<option value="${esc(a.uid)}"${a.uid === val ? ' selected' : ''}>${esc(a.name)}${conflictSuffix(a.uid)}</option>`; });
  if (val && !sa.find(a => a.uid === val)) o += `<option value="${esc(val)}" selected>${esc(nm[val] || val)}${conflictSuffix(val)}</option>`;
  const onchangeAttr = pi === 0 ? `mu(${bi});onPs0Change(${bi},${ri},${li});` : `mu(${bi})`;
  const sel = `<select class="cs" id="${id}" data-bi="${bi}" data-ri="${ri}" data-li="${li}" data-pi="${pi}" onchange="${onchangeAttr}">${o}</select>`;
  if (pi !== 0) return sel;
  // 一番左（1人目）の選択欄にのみ見守りチェックボックスを付与
  const cbId = `watch-${bi}-${ri}-${li}`;
  const isDisabled = !val;
  const isChecked = !!(watchOn && val);
  const cb = `<label class="watch-label"><input type="checkbox" class="watch-cb" id="${cbId}" data-bi="${bi}" data-ri="${ri}" data-li="${li}"${isDisabled ? ' disabled' : ''}${isChecked ? ' checked' : ''} onchange="mu(${bi})"> 見守り</label>`;
  return `<div class="ps-watch-wrap">${sel}${cb}</div>`;
}

function onPs0Change(bi, ri, li) {
  const sel = document.getElementById(`ps-${bi}-${ri}-${li}-0`);
  const cb  = document.getElementById(`watch-${bi}-${ri}-${li}`);
  if (!sel || !cb) return;
  if (sel.value) {
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
  }
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
  if (hasUnsavedChanges() && !confirm('未保存の変更が失われます。続行しますか？')) return;
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
    else if (createLoaded && res.lastUpdated !== _scKnownTs) {
      _scKnownTs = res.lastUpdated;
      await syncShiftCreateData();
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
  try { res = await apiGet('getShiftCreateData', {}); } catch (e) { return; }
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
    if (key === activeKey) {
      if (bs[key] === false) { activeConflict = true; return; } // 未保存編集中は上書きしない
      shiftDates[idx] = fresh;
      activeChanged = true;
    } else if (bs[key] !== false) {
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
  else if (activeChanged) { renderBlock(); toast('他の管理者の変更を反映しました', 's'); }
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
    const res = await apiGet('getShiftCreateData', {});
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

function toggleNotApplied(el) {
  el.classList.toggle("open");
  const next = el.nextElementSibling;
  if (next && next.classList.contains("lp-not-applied")) {
    next.style.display = next.style.display === "none" ? "" : "none";
  }
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

function ucn(si, ni) { const s = document.getElementById(si), n = document.getElementById(ni); if (!s || !n) return; n.disabled = !s.value; if (!s.value) n.value = ''; }

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
  const responsible = { r1: (document.getElementById('resp1-'+bi)||{}).value||'', r2: (document.getElementById('resp2-'+bi)||{}).value||'' };
  const cart = { ki1:(document.getElementById('ci1-'+bi)||{}).value||'', kc1:(document.getElementById('cn1-'+bi)||{}).value||'', ki2:(document.getElementById('ci2-'+bi)||{}).value||'', kc2:(document.getElementById('cn2-'+bi)||{}).value||'', ko1:(document.getElementById('co1-'+bi)||{}).value||'', oc1:(document.getElementById('con1-'+bi)||{}).value||'', ko2:(document.getElementById('co2-'+bi)||{}).value||'', oc2:(document.getElementById('con2-'+bi)||{}).value||'' };
  // 現在の列状態を同期して収集（colPlacesは空欄含む固定列、インデックスはDOMと一致）
  // 中身は列番号（インデックス）で紐づけて収集する
  const colPlaces = getColPlaces(bi, block);
  const usedPlaces = [...colPlaces];
  const placeCart = colPlaces.map((loc, li) => {
    const sel = document.getElementById(`pc-${bi}-${li}-0`);
    return sel ? sel.value : ((block.placeCart || [])[li] || '');
  });
  const slots = (block.slots || []).map((slot, ri) => {
    const places = [];
    const watch = [];
    colPlaces.forEach((loc, li) => {
      const cw = document.getElementById(`cw-${bi}-${ri}-${li}`);
      const uids = [];
      if (cw) {
        cw.querySelectorAll('select.cs').forEach(s => { if (s.value) uids.push(s.value); });
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
    await apiGet('saveShiftBlock', { date: block.date, time: block.time, responsible: data.responsible, cart: data.cart, placeCart: data.placeCart, usedPlaces: data.usedPlaces, slots: data.slots });
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

function updatePublishBtn() {
  const btn = document.getElementById('publish-btn');
  if (!btn) return;
  if (shiftPublished) {
    btn.textContent = '🔒 シフト非公開にする';
    btn.className = 'hbtn pub-off';
  } else {
    btn.textContent = '📣 シフト公開';
    btn.className = 'hbtn pub';
  }
}

async function togglePublish() {
  if (shiftPublished) {
    if (!confirm('シフトを非公開にしますか？\n非公開後はメンバーがシフトを確認できなくなります。')) return;
    try {
      await apiGet('unpublishShift', {});
      shiftPublished = false;
      updatePublishBtn();
      toast('シフトを非公開にしました', 's');
    } catch (e) { toast('非公開化に失敗しました: ' + e.message, 'e'); }
  } else {
    if (!confirm('シフトを公開しますか？\n公開後は全メンバーがシフトを確認できます。')) return;
    try {
      await apiGet('publishShift', {});
      shiftPublished = true;
      updatePublishBtn();
      toast('シフトを公開しました', 's');
    } catch (e) { toast('公開に失敗しました: ' + e.message, 'e'); }
  }
}

// 左パネルリサイズ
const LP_MIN = 140, LP_MAX = 360;
let lpCollapsed = false, lpWidth = 196;
function toggleLp() {
  lpCollapsed = !lpCollapsed;
  const w = document.getElementById('lpWrap'), t = document.getElementById('lpToggle');
  if (lpCollapsed) { w.classList.add('collapsed'); t.textContent = '▶'; }
  else { w.classList.remove('collapsed'); w.style.width = lpWidth + 'px'; t.textContent = '◀'; }
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
    const [lr, cr, pr, sr] = await Promise.all([apiGet('getLocations', {}), apiGet('getCartNumbers'), apiGet('getCartPresets'), apiGet('getDefaultSlot')]);
    settingsLocations    = lr.ok ? lr.locations    : [];
    settingsCartNumbers  = cr.ok ? cr.cartNumbers  : [];
    settingsCartPresets  = pr.ok ? pr.cartPresets  : [];
    defaultSlot  = sr.ok ? sr.defaultSlot  : 15;
    renderLocationList(); renderCartTags(); renderCartPresets();
    const sel = document.getElementById('default-slot-sel'); if (sel) sel.value = String(defaultSlot);
    settingsLoaded = true; setLoading(false);
  } catch (e) { setLoading(false); toast('設定読み込みエラー: ' + e.message, 'e'); }
}

function renderLocationList() {
  const list = document.getElementById('location-list');
  if (!list) return;
  if (settingsLocations.length === 0) { list.innerHTML = '<div style="font-size:12px;color:var(--ink3);padding:8px 0;">場所が登録されていません</div>'; return; }
  list.innerHTML = settingsLocations.map((loc, i) => `
    <div class="setting-row">
      <div><div class="setting-name">${esc(loc.name)}</div>
      <div class="setting-detail">${loc.startYM || loc.endYM ? `期間: ${loc.startYM || '〜'} 〜 ${loc.endYM || '〜'}` : '常時有効'}</div></div>
      <div class="setting-actions">
        <button class="s-btn" onclick="openEditLocModal(${i})">編集</button>
        <button class="s-btn del" onclick="deleteLocation(${i})">削除</button>
      </div>
    </div>`).join('');
}
function showAddLocationForm() { document.getElementById('new-loc-name').value = ''; document.getElementById('new-loc-start').value = ''; document.getElementById('new-loc-end').value = ''; document.getElementById('add-location-form').style.display = ''; }
function hideAddLocationForm() { document.getElementById('add-location-form').style.display = 'none'; }
function addLocation() {
  const name = document.getElementById('new-loc-name').value.trim();
  if (!name) { toast('場所名を入力してください', 'e'); return; }
  settingsLocations.push({ name, startYM: document.getElementById('new-loc-start').value.trim(), endYM: document.getElementById('new-loc-end').value.trim() });
  renderLocationList(); hideAddLocationForm();
}
function deleteLocation(i) { if (!confirm(`「${settingsLocations[i].name}」を削除しますか？`)) return; settingsLocations.splice(i, 1); renderLocationList(); }
function openEditLocModal(i) { document.getElementById('edit-loc-idx').value = i; document.getElementById('edit-loc-name').value = settingsLocations[i].name; document.getElementById('edit-loc-start').value = settingsLocations[i].startYM||''; document.getElementById('edit-loc-end').value = settingsLocations[i].endYM||''; document.getElementById('edit-loc-modal').classList.add('on'); }
function closeEditLocModal() { document.getElementById('edit-loc-modal').classList.remove('on'); }
function saveEditLocation() {
  const i = parseInt(document.getElementById('edit-loc-idx').value);
  const name = document.getElementById('edit-loc-name').value.trim();
  if (!name) { toast('場所名を入力してください', 'e'); return; }
  settingsLocations[i] = { name, startYM: document.getElementById('edit-loc-start').value.trim(), endYM: document.getElementById('edit-loc-end').value.trim() };
  renderLocationList(); closeEditLocModal();
}
async function saveLocations() {
  try { await apiGet('saveLocations', { locations: settingsLocations }); toast('場所設定を保存しました', 's'); createLoaded = false; }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
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

function renderCartPresets() {
  const el = document.getElementById('cart-preset-list');
  if (!el) return;
  el.innerHTML = settingsCartPresets.map((p, i) =>
    `<span class="tag">${esc(p)}<button class="del-t" onclick="deleteCartPreset(${i})">×</button></span>`).join('');
}
function addCartPreset() {
  const v = document.getElementById('new-cart-preset').value.trim();
  if (!v) return;
  if (settingsCartPresets.includes(v)) { toast('すでに追加されています', 'e'); return; }
  settingsCartPresets.push(v); renderCartPresets();
  document.getElementById('new-cart-preset').value = '';
}
function deleteCartPreset(i) { settingsCartPresets.splice(i, 1); renderCartPresets(); }
async function saveCartPresets() {
  try { await apiGet('saveCartPresets', { cartPresets: settingsCartPresets }); toast('カートプリセットを保存しました', 's'); createLoaded = false; }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}

async function saveDefaultSlot() {
  const v = parseInt(document.getElementById('default-slot-sel').value);
  try { await apiGet('saveDefaultSlot', { defaultSlot: v }); defaultSlot = v; toast('デフォルトスロット分数を保存しました', 's'); }
  catch (e) { toast('保存に失敗しました: ' + e.message, 'e'); }
}

async function execCreateShiftSheet() {
  if (!confirm('現在のシフトデータをバックアップし、3シートをクリアします。\n実行してもよいですか？')) return;
  setLoading(true, 'シフト作成枠を作成中...');
  try {
    const res = await apiGet('createShiftSheet', curYM ? { year: curYM.year, month: curYM.month } : {});
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
