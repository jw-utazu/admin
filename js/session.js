// ============================================================
// PW_GWS 共通セッション（3アプリ共有）
//
// admin / shift-form / shift-create はすべて同一オリジン
// （jw-utazu.github.io）のため localStorage を共有できる。
// ここに保存するのは「誰でログインしたか」だけで、権限は保存しない。
// 権限は各アプリが起動時にサーバー（action=auth）へ必ず問い合わせて取得する
// —— localStorage は利用者が書き換えられるため、権限を信用してはいけない。
//
// このファイルは admin / shift-form の両リポジトリに同じ内容で置く。
// 変更したら参照する全 HTML の ?v= を +1 すること。
// ============================================================

const PWGWS_SESSION_KEY  = 'pwgws_session';
const PWGWS_RECOVERY_KEY = 'pwgws_recovery_session';
const PWGWS_LOGIN_URL    = 'https://jw-utazu.github.io/shift-form/login.html';

// ログイン中のアカウント情報 {email, name, picture} を返す（無ければ null）
function pwgwsGetSession() {
  try {
    const s = JSON.parse(localStorage.getItem(PWGWS_SESSION_KEY) || 'null');
    return (s && s.email) ? s : null;
  } catch (_) { return null; }
}

function pwgwsSaveSession(email, name, picture) {
  try {
    localStorage.setItem(PWGWS_SESSION_KEY, JSON.stringify({
      email: email, name: name || '', picture: picture || '', savedAt: Date.now()
    }));
  } catch (_) {}
}

// ログアウト。救済ログインのセッションも併せて破棄する
function pwgwsClearSession() {
  try { localStorage.removeItem(PWGWS_SESSION_KEY); } catch (_) {}
  try { localStorage.removeItem(PWGWS_RECOVERY_KEY); } catch (_) {}
}

function pwgwsGetRecoveryToken() {
  try { return localStorage.getItem(PWGWS_RECOVERY_KEY) || ''; } catch (_) { return ''; }
}

// 共通ログイン画面へ送る。戻り先を渡して、ログイン後に元のアプリへ戻す
function pwgwsGoToLogin(reason) {
  const url = PWGWS_LOGIN_URL + '?return=' + encodeURIComponent(location.href) +
              (reason ? '&reason=' + encodeURIComponent(reason) : '');
  location.replace(url);
}

// 共通ログイン画面へのリダイレクトを行うべきか。
// ?direct=1 が付いている場合は従来の各アプリのログイン画面を使う（緊急脱出口）。
// 共通ログイン画面に不具合が出てもアプリに入れなくならないように必ず残しておくこと
function pwgwsShouldRedirectToLogin() {
  try {
    if (new URLSearchParams(location.search).get('direct') === '1') return false;
  } catch (_) {}
  return true;
}
