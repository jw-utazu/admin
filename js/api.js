// ============================================================
// PW_GWS admin 共有通信層（index.html / shift-create.html から利用）
// すべてのAPI呼び出しをPOSTに統一し、サーバー発行sessionをheaderで送る。
// ============================================================
const API_URL   = 'https://nqtswiynoxawccldqcwi.supabase.co/functions/v1/api';
const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xdHN3aXlub3hhd2NjbGRxY3dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzQxNjIsImV4cCI6MjA5ODMxMDE2Mn0.M-AnCBnXBI1FIyouoa5ttF6mb8PF2YqHfv180PqQWQU';
const CLIENT_ID = '538467678510-7ltuvmuj0d1mmgngtj980me3daenqmm7.apps.googleusercontent.com';

// session.js が読み込めなかった場合も、認証なしで処理を続けない。
if (typeof pwgwsGetSession !== 'function') {
  console.warn('[session] session.js を読み込めませんでした');
  window.pwgwsGetSession = function () { return null; };
  window.pwgwsGetSessionToken = function () { return ''; };
  window.pwgwsSaveSession = function () {};
  window.pwgwsInvalidateCurrentToken = function () {};
  window.pwgwsClearSession = function () {
    try { localStorage.removeItem('pwgws_session'); } catch (_) {}
    try { localStorage.removeItem('pwgws_recovery_session'); } catch (_) {}
  };
  window.pwgwsGoToLogin = function (reason) {
    location.replace('https://jw-utazu.github.io/shift-form/login.html?return=' +
      encodeURIComponent(location.href) + (reason ? '&reason=' + encodeURIComponent(reason) : ''));
  };
  window.pwgwsShouldRedirectToLogin = function () { return true; };
  window.pwgwsEnforceRelogin = function () { return false; };
  window.PWGWS_FORM_URL = 'https://jw-utazu.github.io/shift-form/';
  window.pwgwsGetAccounts = function () { return []; };
  window.pwgwsSwitchAccount = function () { return false; };
  window.pwgwsRemoveAccount = function () { return false; };
  window.pwgwsGoToAddAccount = function () { window.pwgwsGoToLogin(); };
  window.pwgwsOpenAccountMenu = function () {
    alert('アカウント機能を読み込めませんでした。ページを再読み込みしてください。');
  };
}

function apiRequest(action, params, timeoutMs) {
  const payload = Object.assign({ action: action }, params || {});
  if (typeof currentPwType !== 'undefined' && payload.type === undefined) payload.type = currentPwType;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 180000);
  const headers = {
    'Authorization': 'Bearer ' + ANON_KEY,
    'Content-Type': 'application/json'
  };
  const sessionToken = pwgwsGetSessionToken();
  if (sessionToken) headers['X-PWGWS-Session'] = sessionToken;

  return fetch(API_URL, {
    method: 'POST', redirect: 'follow', signal: controller.signal,
    headers: headers, body: JSON.stringify(payload)
  }).then(async r => {
    clearTimeout(timer);
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (r.status === 401) {
      pwgwsInvalidateCurrentToken();
      pwgwsGoToLogin('セッションの有効期限が切れました。もう一度ログインしてください。');
      throw new Error('認証セッションが無効です');
    }
    if (r.status === 403) throw new Error((data && (data.message || data.error)) || 'この操作を行う権限がありません');
    if (!r.ok) throw new Error((data && (data.message || data.error)) || ('通信エラー (' + r.status + ')'));
    if (data && data.error && !data.ok) throw new Error(data.error);
    return data;
  }).catch(err => {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('通信タイムアウト（サーバーが応答しませんでした）');
    throw new Error(err.message || '通信エラー（サーバーへの接続に失敗）');
  });
}

// 呼び出し側との互換のため名称は残すが、URLへparamsを載せずPOSTする。
function apiGet(action, params) { return apiRequest(action, params, 180000); }
function apiPost(actionOrPayload, params) {
  if (typeof actionOrPayload === 'string') return apiRequest(actionOrPayload, params, 180000);
  const payload = Object.assign({}, actionOrPayload || {});
  const action = payload.action;
  delete payload.action;
  return apiRequest(action, payload, 180000);
}

// email は旧呼び出しとの互換引数。本人性はheaderのsessionから復元する。
function apiAuthGet(_email, source) { return apiRequest('auth', { source: source }, 30000); }
