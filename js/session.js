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

// ── 全員に再ログインさせるための仕組み ──
// この時刻より前に保存されたセッションは無効とみなし、ログイン画面へ送る。
// Googleのアイコンなど「ログインを通った瞬間にしか取れない情報」を
// 全員分そろえたいときに使う。
//
// もう一度全員を再ログインさせたくなったら、
//   1. PWGWS_SESSION_MIN_SAVED_AT を「今」の時刻に更新する
//   2. PWGWS_RELOGIN_FLAG の末尾の番号を +1 する
// の2つをセットで行うこと。
// 定数を過ぎた後はこの判定が常に空振りするだけなので、コードは残しておいてよい。
const PWGWS_SESSION_MIN_SAVED_AT = Date.parse('2026-08-02T22:45:00+09:00');
const PWGWS_RELOGIN_FLAG = 'pwgws_relogin_done_1';

// 基準時刻より前の古いセッションを破棄する。破棄したら true を返す。
// 各アプリは起動処理の先頭でこれを呼び、true なら自分のアプリ固有の
// セッションも捨ててログイン画面へ送ること
// （共通セッションだけ消してもアプリ側のセッションが残っていると
//   ログイン画面を経由せず再開できてしまうため）
function pwgwsEnforceRelogin() {
  try {
    // 再ログイン済みなら二度と発動しない。savedAt は利用者の端末時計の値なので、
    // 日付が大きくずれている端末を延々とログイン画面に送り返さないための歯止め
    if (localStorage.getItem(PWGWS_RELOGIN_FLAG)) return false;
    // 救済ログイン中の人はそもそもGoogleログインができない。
    // ここで追い出すと救済申請からやり直しになってしまうため対象外にする
    if (localStorage.getItem(PWGWS_RECOVERY_KEY)) return false;
    const s = JSON.parse(localStorage.getItem(PWGWS_SESSION_KEY) || 'null');
    if (s && (s.savedAt || 0) >= PWGWS_SESSION_MIN_SAVED_AT) return false;
    pwgwsClearSession();
    return true;
  } catch (_) { return false; }
}

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
    // 強制再ログインはここまで来て初めて「完了」とする。
    // ログイン画面で離脱した人には次回もう一度求めることになる
    localStorage.setItem(PWGWS_RELOGIN_FLAG, '1');
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

// 各アプリは認証画面を持たず、未認証なら必ず共通ログイン画面へ送る。
// この関数は互換のために残してある（常に true）
function pwgwsShouldRedirectToLogin() { return true; }
