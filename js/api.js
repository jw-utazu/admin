// ============================================================
// PW_GWS admin 共有通信層（index.html / shift-create.html から利用）
// このファイルを変更したら、参照する両HTMLの <script src="js/api.js?v=N">
// の N を必ず +1 すること（GitHub Pages のキャッシュ対策）
// ============================================================
const API_URL   = 'https://nqtswiynoxawccldqcwi.supabase.co/functions/v1/api';
const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xdHN3aXlub3hhd2NjbGRxY3dpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3MzQxNjIsImV4cCI6MjA5ODMxMDE2Mn0.M-AnCBnXBI1FIyouoa5ttF6mb8PF2YqHfv180PqQWQU';
const CLIENT_ID = '538467678510-7ltuvmuj0d1mmgngtj980me3daenqmm7.apps.googleusercontent.com';

// ============================================================
// API通信（fetch方式・リダイレクト追従対応・Android Chrome対応）
// ============================================================
function apiGet(action, params) {
  // type パラメータを自動付与（認証系・メンバー取得など type 不要なアクションはサーバー側で無視する）
  const p = Object.assign({ type: currentPwType }, params || {});
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
  // 管理者UID・名前を自動付与
  if (_currentUser && _currentUser.uid) {
    payload.adminUid  = payload.adminUid  || _currentUser.uid;
    payload.adminName = payload.adminName || _currentUser.name;
  }
  // オーナーアカウントは uid を持たないため、権限確認用にメールアドレスも送る
  if (_currentUser && _currentUser.email) {
    payload.adminEmail = payload.adminEmail || _currentUser.email;
  }
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
