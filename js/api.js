// ============================================================
// PW_GWS admin 共有通信層（index.html / shift-create.html から利用）
// このファイルを変更したら、参照する両HTMLの <script src="js/api.js?v=N">
// の N を必ず +1 すること（GitHub Pages のキャッシュ対策）
// ============================================================
const API_URL   = 'https://nqtswiynoxawccldqcwi.supabase.co/functions/v1/api';
const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xdHN3aXlub3hhd2NjbGRxY3dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzQxNjIsImV4cCI6MjA5ODMxMDE2Mn0.M-AnCBnXBI1FIyouoa5ttF6mb8PF2YqHfv180PqQWQU';
const CLIENT_ID = '538467678510-7ltuvmuj0d1mmgngtj980me3daenqmm7.apps.googleusercontent.com';

// session.js（共通セッション）が読み込めなかった場合の安全網。
// このアプリは認証画面を持たないため、最低限リダイレクトだけは動くようにしておく
if (typeof pwgwsGetSession !== 'function') {
  console.warn('[session] session.js が読み込めませんでした。最低限の動作で継続します');
  window.pwgwsGetSession           = function () { return null; };
  window.pwgwsSaveSession          = function () {};
  window.pwgwsClearSession         = function () {
    try { localStorage.removeItem('pwgws_session'); } catch (_) {}
    try { localStorage.removeItem('pwgws_recovery_session'); } catch (_) {}
  };
  window.pwgwsGoToLogin            = function (reason) {
    location.replace('https://jw-utazu.github.io/shift-form/login.html?return=' +
      encodeURIComponent(location.href) + (reason ? '&reason=' + encodeURIComponent(reason) : ''));
  };
  window.pwgwsShouldRedirectToLogin = function () { return true; };
  // 読み込めなかった以上、強制再ログインの基準時刻も分からない。
  // 誤って全員をログアウトさせないよう、何もしない扱いにする
  window.pwgwsEnforceRelogin        = function () { return false; };
  // 複数アカウント：切り替えはできないが、押しても何も起きないだけで済むようにする
  window.PWGWS_FORM_URL             = 'https://jw-utazu.github.io/shift-form/';
  window.pwgwsGetAccounts           = function () { return []; };
  window.pwgwsSwitchAccount         = function () { return false; };
  window.pwgwsRemoveAccount         = function () { return false; };
  window.pwgwsGoToAddAccount        = function () { window.pwgwsGoToLogin(); };
  window.pwgwsOpenAccountMenu       = function () {
    alert('アカウント機能を読み込めませんでした。ページを再読み込みしてください。');
  };
}

// ============================================================
// ログイン中の管理者を返す。
// 保持している変数名がページごとに違う（index.html は _currentUser、
// shift-create.html は adminUser）ため、両方を見て拾う。
// 未定義の変数は参照するだけで ReferenceError になるので typeof で確かめる
// ============================================================
function currentAdmin() {
  if (typeof _currentUser !== 'undefined' && _currentUser) return _currentUser;
  if (typeof adminUser   !== 'undefined' && adminUser)     return adminUser;
  return null;
}

// 操作ログに「誰が」を残すため、リクエストに管理者UID・名前・メールを付ける。
// これが欠けると admin_op_logs の実行者が空欄になり、後から追跡できない
function attachAdmin(payload) {
  const u = currentAdmin();
  if (!u) return payload;
  // オーナーは uid を持たないので、uid と名前はそれぞれ独立して付ける
  // （uid の有無で名前まで落とすと、オーナーの操作が名無しで記録される）
  if (u.uid)  payload.adminUid  = payload.adminUid  || u.uid;
  if (u.name) payload.adminName = payload.adminName || u.name;
  // オーナーアカウントは uid を持たないため、権限確認用にメールアドレスも送る
  if (u.email) payload.adminEmail = payload.adminEmail || u.email;
  return payload;
}

// ============================================================
// API通信（fetch方式・リダイレクト追従対応・Android Chrome対応）
// ============================================================
function apiGet(action, params) {
  // type パラメータを自動付与（認証系・メンバー取得など type 不要なアクションはサーバー側で無視する）
  const p = attachAdmin(Object.assign({ type: currentPwType }, params || {}));
  let url = API_URL+'?action='+action;
  url += '&params='+encodeURIComponent(JSON.stringify(p));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  return fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'Authorization': 'Bearer ' + ANON_KEY } })
    .then(r => { clearTimeout(timer); return r.json(); })
    .then(d => {
      if (d && d.error && !d.ok) throw new Error(d.error);
      return d;
    })
    .catch(err => {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('通信タイムアウト（サーバーが応答しませんでした）');
      throw new Error(err.message || '通信エラー（サーバーへの接続に失敗）');
    });
}

// ============================================================
// apiPost ヘルパー（POST方式・写真アップロード等の大容量データ用）
// ============================================================
function apiPost(actionOrPayload, params) {
  let payload;
  if (typeof actionOrPayload === 'string') {
    payload = Object.assign({ action: actionOrPayload }, params);
  } else {
    payload = actionOrPayload;
  }
  attachAdmin(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  return fetch(API_URL, {
    method: 'POST',
    redirect: 'follow',
    signal: controller.signal,
    headers: { 'Authorization': 'Bearer ' + ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(r => r.json())
    .then(d => {
      clearTimeout(timer);
      if (d && d.error && !d.ok) throw new Error(d.error);
      return d;
    })
    .catch(err => {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('通信タイムアウト（サーバーが応答しませんでした）');
      throw new Error(err.message || '通信エラー（サーバーへの接続に失敗）');
    });
}

// ============================================================
// 認証GET（shift-create.html から利用）
// ============================================================
function apiAuthGet(email, source) {
  const url = API_URL + '?action=auth&source=' + encodeURIComponent(source) + '&email=' + encodeURIComponent(email);
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  return fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'Authorization': 'Bearer ' + ANON_KEY } })
    .then(r => { clearTimeout(timer); return r.json(); })
    .catch(err => { clearTimeout(timer); throw new Error(err.name === 'AbortError' ? '通信タイムアウト' : (err.message || '通信エラー')); });
}
