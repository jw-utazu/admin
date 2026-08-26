// ============================================================
// PW_GWS 共通セッション（3アプリ共有）
//
// admin / shift-form / shift-create はすべて同一オリジン
// （jw-utazu.github.io）のため localStorage を共有できる。
// ここには「誰でログインしたか」とサーバー発行の不透明なセッショントークンを保存する。
// 権限は各アプリが起動時にサーバー（action=auth）へ必ず問い合わせて取得する
// —— localStorage は利用者が書き換えられるため、権限を信用してはいけない。
//
// このファイルは admin / shift-form の両リポジトリに同じ内容で置く。
// 変更したら参照する全 HTML の ?v= を +1 すること。
// ============================================================

const PWGWS_SESSION_KEY  = 'pwgws_session';
const PWGWS_RECOVERY_KEY = 'pwgws_recovery_session';
const PWGWS_LOGIN_URL    = 'https://jw-utazu.github.io/shift-form/login.html';

// 複数アカウント：一度ログインを通ったアカウントを配列で覚えておき、
// pwgws_session（＝現在の指し先）を差し替えることで切り替える。
// 保存するのは email / name / picture / token / expiresAt だけで、権限は入れない
// （権限は各アプリが切り替えのたびにサーバーへ問い合わせて取り直す）。
// admin と shift-form は同一オリジンで localStorage を共有しているため、
// 片方で切り替えるともう片方も切り替わる。これは意図した動作
// （「今このブラウザで誰として動いているか」を常に1つに保つため）
const PWGWS_ACCOUNTS_KEY = 'pwgws_accounts';

// 各アプリが自分用に持っているログインキャッシュ。
// アカウントを切り替えるときにこれらを消さないと、起動処理が
// 先にこちらを見て前のアカウントで復元してしまう
const PWGWS_APP_SESSION_KEYS = ['adminUser', 'shiftapp_session'];

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

function pwgwsSaveSession(email, name, picture, token, expiresAt) {
  try {
    email = String(email || '').trim().toLowerCase();
    if (!email) return;
    const previous = pwgwsGetAccounts().filter(a => a.email === email)[0] || {};
    const acc = {
      email: email, name: name || previous.name || '', picture: picture || previous.picture || '',
      token: token || previous.token || '', expiresAt: expiresAt || previous.expiresAt || '', savedAt: Date.now()
    };
    // 一覧を先に読む。指し先を書き換えてから読むと、複数アカウント対応より前から
    // ログインしていた人の「今のアカウント」が新しい方に上書きされて拾えなくなり、
    // 追加したつもりが乗っ取りになってしまう
    const list = pwgwsStripCurrent(pwgwsGetAccounts().filter(a => a.email !== email));
    list.push(acc);
    localStorage.setItem(PWGWS_ACCOUNTS_KEY, JSON.stringify(list));
    localStorage.setItem(PWGWS_SESSION_KEY, JSON.stringify(acc));
    localStorage.removeItem(PWGWS_RECOVERY_KEY);
    // 強制再ログインはここまで来て初めて「完了」とする。
    // ログイン画面で離脱した人には次回もう一度求めることになる
    localStorage.setItem(PWGWS_RELOGIN_FLAG, '1');
  } catch (_) {}
}

// current は「今どれが選ばれているか」を読むたびに計算した印なので、
// 保存するときは落とす（保存すると古い印が残って一覧の✓がずれる）
function pwgwsStripCurrent(list) {
  return list.map(a => ({
    email: a.email, name: a.name || '', picture: a.picture || '', token: a.token || '',
    expiresAt: a.expiresAt || '', savedAt: a.savedAt || 0
  }));
}

// 保存済みアカウントの一覧。current: true が現在の指し先
function pwgwsGetAccounts() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(PWGWS_ACCOUNTS_KEY) || '[]'); } catch (_) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter(a => a && a.email);
  // 複数アカウント対応より前からログインしている人は一覧が空なので、
  // 今のセッションを1件目として拾い上げる（次の保存でファイルに書かれる）
  const cur = pwgwsGetSession();
  if (cur && !list.some(a => a.email === cur.email)) list.unshift(cur);
  return list.map(a => Object.assign({}, a, { current: !!(cur && a.email === cur.email) }));
}

// 保存済みアカウントに切り替える。Google の再認証は求めない
// （権限は切り替え後に各アプリがサーバーへ問い合わせて確認する）。
// 切り替えられたら true。呼び出し側は true なら location.reload() すること
function pwgwsSwitchAccount(email) {
  const target = pwgwsGetAccounts().filter(a => a.email === email)[0];
  if (!target) return false;
  try {
    localStorage.setItem(PWGWS_SESSION_KEY, JSON.stringify({
      email: target.email, name: target.name || '', picture: target.picture || '',
      token: target.token || '', expiresAt: target.expiresAt || '', savedAt: Date.now()
    }));
  } catch (_) { return false; }
  // 各アプリのログインキャッシュを消さないと前のアカウントで復元されてしまう
  pwgwsClearAppSessions();
  // 救済ログインは Google が使えない人のための別経路。
  // 通常アカウントへ切り替えた時点で役目が終わるので破棄する
  try { localStorage.removeItem(PWGWS_RECOVERY_KEY); } catch (_) {}
  return true;
}

// 一覧から1件だけ消す（間違えて追加したアカウントの削除用）。
// 現在の指し先を消した場合は残りの先頭へ切り替える。切り替え先が無ければ
// 完全ログアウトと同じ状態になるので、呼び出し側でログイン画面へ送ること
function pwgwsRemoveAccount(email) {
  const rest = pwgwsStripCurrent(pwgwsGetAccounts().filter(a => a.email !== email));
  try { localStorage.setItem(PWGWS_ACCOUNTS_KEY, JSON.stringify(rest)); } catch (_) {}
  const cur = pwgwsGetSession();
  if (cur && cur.email === email) {
    if (rest.length > 0) return pwgwsSwitchAccount(rest[0].email);
    pwgwsClearSession();
    return false;
  }
  return true;
}

// 各アプリが自分用に持っているログインキャッシュを消す
function pwgwsClearAppSessions() {
  PWGWS_APP_SESSION_KEYS.forEach(k => {
    try { localStorage.removeItem(k); } catch (_) {}
  });
}

// ログアウト。保存済みアカウントの一覧・救済ログインも併せて破棄する。
// 一覧を残すと「ログアウトしたのに一覧から誰にでも入れる」状態になるため、
// ログアウトは常に全アカウントを対象にする
function pwgwsClearSession() {
  try { localStorage.removeItem(PWGWS_SESSION_KEY); } catch (_) {}
  try { localStorage.removeItem(PWGWS_RECOVERY_KEY); } catch (_) {}
  try { localStorage.removeItem(PWGWS_ACCOUNTS_KEY); } catch (_) {}
  pwgwsClearAppSessions();
}

// 「別のアカウントを追加」。共通ログイン画面を追加モードで開く。
// 追加モードでは保存済みセッションで素通りせず、必ず Google の選択画面を出す
function pwgwsGoToAddAccount() {
  location.href = PWGWS_LOGIN_URL + '?add=1&return=' + encodeURIComponent(location.href);
}

function pwgwsGetRecoveryToken() {
  try { return localStorage.getItem(PWGWS_RECOVERY_KEY) || ''; } catch (_) { return ''; }
}

// 通常ログインと救済ログインは同時に有効にしない。救済ログインへ切り替えたら、
// Google セッションの現在ポインタとアプリ固有キャッシュを消す。
function pwgwsSaveRecoveryToken(token, expectedGoogleIdentity) {
  if (!token) return false;
  try {
    // 同じタブでGoogle認証と救済OTPが並行して完了した場合も、後から返った
    // 救済レスポンスで新しいGoogle sessionを上書きしない。
    const googleSession = pwgwsGetSession();
    const currentGoogleIdentity = googleSession
      ? googleSession.email + ':' + (googleSession.token || '')
      : '';
    if (arguments.length > 1 && currentGoogleIdentity !== String(expectedGoogleIdentity || '')) return false;
    localStorage.removeItem(PWGWS_SESSION_KEY);
    localStorage.setItem(PWGWS_RECOVERY_KEY, token);
  } catch (_) { return false; }
  pwgwsClearAppSessions();
  return true;
}

function pwgwsGetSessionToken() {
  const recovery = pwgwsGetRecoveryToken();
  if (recovery) return recovery;
  const s = pwgwsGetSession();
  return s && s.token ? s.token : '';
}

// 401 を受けたトークンだけを無効化する。403 は権限不足でありログアウト理由ではない。
function pwgwsInvalidateCurrentToken() {
  try {
    if (localStorage.getItem(PWGWS_RECOVERY_KEY)) {
      localStorage.removeItem(PWGWS_RECOVERY_KEY);
    } else {
      const cur = pwgwsGetSession();
      if (cur) {
        cur.token = '';
        cur.expiresAt = '';
        localStorage.setItem(PWGWS_SESSION_KEY, JSON.stringify(cur));
        const list = pwgwsStripCurrent(pwgwsGetAccounts()).map(a => {
          if (a.email === cur.email) { a.token = ''; a.expiresAt = ''; }
          return a;
        });
        localStorage.setItem(PWGWS_ACCOUNTS_KEY, JSON.stringify(list));
      }
    }
  } catch (_) {}
  pwgwsClearAppSessions();
}

// 別タブでログイン先・トークンが切り替わったら、古い principal の画面を残さない。
const PWGWS_INITIAL_IDENTITY = (function() {
  const s = pwgwsGetSession();
  return pwgwsGetRecoveryToken() || (s ? s.email + ':' + (s.token || '') : '');
})();
let pwgwsStorageReloading = false;
function pwgwsReloadForSessionChange() {
  if (pwgwsStorageReloading) return;
  pwgwsStorageReloading = true;
  // アプリ側へ先に通知し、旧 principal で進行中の通信と操作を止めてから再読込する。
  try { window.dispatchEvent(new Event('pwgws:session-changing')); } catch (_) {}
  location.reload();
}
window.addEventListener('storage', function(e) {
  if (pwgwsStorageReloading || [PWGWS_SESSION_KEY, PWGWS_RECOVERY_KEY].indexOf(e.key) < 0) return;
  const s = pwgwsGetSession();
  const now = pwgwsGetRecoveryToken() || (s ? s.email + ':' + (s.token || '') : '');
  if (now !== PWGWS_INITIAL_IDENTITY) {
    // storage event は変更したタブ自身には発火しないため、切替元の通常 reload と競合しない。
    pwgwsReloadForSessionChange();
  }
});

// 共通ログイン画面へ送る。戻り先を渡して、ログイン後に元のアプリへ戻す
function pwgwsGoToLogin(reason) {
  const url = PWGWS_LOGIN_URL + '?return=' + encodeURIComponent(location.href) +
              (reason ? '&reason=' + encodeURIComponent(reason) : '');
  location.replace(url);
}

// 各アプリは認証画面を持たず、未認証なら必ず共通ログイン画面へ送る。
// この関数は互換のために残してある（常に true）
function pwgwsShouldRedirectToLogin() { return true; }

// ============================================================
// アカウント切り替えメニュー
//
// 3アプリで同じ見た目・同じ挙動にするため、UIもこの共有ファイルに置く。
// 各アプリはヘッダーのアイコンから pwgwsOpenAccountMenu(el, opts) を呼ぶだけでよい。
// CSS は各アプリのスタイルシートに散らさず、初回に一度だけ差し込む
// ============================================================
const PWGWS_FORM_URL = 'https://jw-utazu.github.io/shift-form/';

function pwgwsInjectMenuCss() {
  if (document.getElementById('pwgws-acc-css')) return;
  const st = document.createElement('style');
  st.id = 'pwgws-acc-css';
  st.textContent = [
    '.pwgws-acc-back{position:fixed;inset:0;z-index:9000;background:transparent;}',
    '.pwgws-acc{position:fixed;z-index:9001;min-width:250px;max-width:min(320px,calc(100vw - 16px));',
    'background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:6px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.16);font-size:13px;color:#222;}',
    '.pwgws-acc-hd{padding:6px 10px 4px;font-size:11px;color:#8a9099;}',
    '.pwgws-acc-it{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;',
    'background:transparent;border-radius:8px;cursor:pointer;text-align:left;font:inherit;color:inherit;}',
    '.pwgws-acc-it:hover{background:#f3f5f8;}',
    '.pwgws-acc-it.on{background:#f0f4ff;}',
    '.pwgws-acc-ic{flex:0 0 28px;width:28px;height:28px;border-radius:50%;overflow:hidden;',
    'background:#dfe4ea;color:#555;display:flex;align-items:center;justify-content:center;',
    'font-size:12px;font-weight:700;}',
    '.pwgws-acc-ic img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.pwgws-acc-tx{flex:1 1 auto;min-width:0;}',
    '.pwgws-acc-nm{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.pwgws-acc-em{font-size:11px;color:#8a9099;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.pwgws-acc-ck{flex:0 0 auto;color:#2f6fed;font-weight:700;}',
    '.pwgws-acc-rm{flex:0 0 auto;border:0;background:transparent;color:#b0b6be;cursor:pointer;',
    'font-size:14px;line-height:1;padding:4px 6px;border-radius:6px;}',
    '.pwgws-acc-rm:hover{background:#ffe9e9;color:#d33;}',
    '.pwgws-acc-sep{height:1px;background:#eceff3;margin:6px 4px;}',
    '@media (prefers-color-scheme:dark){',
    '.pwgws-acc{background:#22262b;border-color:#363b42;color:#e8eaed;}',
    '.pwgws-acc-it:hover{background:#2c3138;}.pwgws-acc-it.on{background:#2a3446;}',
    '.pwgws-acc-sep{background:#363b42;}}'
  ].join('');
  document.head.appendChild(st);
}

function pwgwsCloseAccountMenu() {
  const b = document.getElementById('pwgws-acc-back');
  if (b) b.remove();
  const m = document.getElementById('pwgws-acc-menu');
  if (m) m.remove();
}

function pwgwsAccIconHtml(a) {
  const initial = ((a.name || a.email || '?').trim()[0] || '?').toUpperCase();
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // 画像が読めなかったらイニシャルに落とす（Googleの写真URLは期限切れになることがある）
  return a.picture
    ? '<span class="pwgws-acc-ic" data-initial="' + esc(initial) + '">' +
      '<img src="' + esc(a.picture) + '" alt=""></span>'
    : '<span class="pwgws-acc-ic">' + esc(initial) + '</span>';
}

// anchorEl の下にメニューを開く。
// opts.onSignOut … 「ログアウト」を押したときの処理（各アプリのログアウトを渡す）
function pwgwsOpenAccountMenu(anchorEl, opts) {
  opts = opts || {};
  // 開いているときにもう一度押したら閉じる（トグル）
  if (document.getElementById('pwgws-acc-menu')) { pwgwsCloseAccountMenu(); return; }
  pwgwsInjectMenuCss();

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const accounts = pwgwsGetAccounts();

  let html = '<div class="pwgws-acc-hd">アカウント</div>';
  accounts.forEach(a => {
    html += '<div class="pwgws-acc-it' + (a.current ? ' on' : '') + '"' +
            ' data-email="' + esc(a.email) + '" role="button" tabindex="0">' +
            pwgwsAccIconHtml(a) +
            '<span class="pwgws-acc-tx">' +
              '<span class="pwgws-acc-nm">' + esc(a.name || a.email) + '</span>' +
              '<span class="pwgws-acc-em">' + esc(a.email) + '</span>' +
            '</span>' +
            (a.current
              ? '<span class="pwgws-acc-ck">' + ic('check') + '</span>'
              : '<button class="pwgws-acc-rm" data-remove="' + esc(a.email) + '" ' +
                'title="この端末から削除">' + ic('x') + '</button>') +
            '</div>';
  });
  html += '<div class="pwgws-acc-sep"></div>';
  html += '<button class="pwgws-acc-it" data-act="add"><span class="pwgws-acc-ic">＋</span>' +
          '<span class="pwgws-acc-tx"><span class="pwgws-acc-nm">別のアカウントを追加</span></span></button>';
  html += '<button class="pwgws-acc-it" data-act="signout"><span class="pwgws-acc-ic">' + ic('log-out') + '</span>' +
          '<span class="pwgws-acc-tx"><span class="pwgws-acc-nm">ログアウト</span>' +
          '<span class="pwgws-acc-em">すべてのアカウントからログアウトします</span></span></button>';

  const back = document.createElement('div');
  back.className = 'pwgws-acc-back';
  back.id = 'pwgws-acc-back';
  const menu = document.createElement('div');
  menu.className = 'pwgws-acc';
  menu.id = 'pwgws-acc-menu';
  menu.innerHTML = html;
  document.body.appendChild(back);
  document.body.appendChild(menu);
  menu.querySelectorAll('.pwgws-acc-ic img').forEach(img => {
    img.addEventListener('error', () => {
      const icon = img.parentElement;
      if (icon) icon.textContent = icon.dataset.initial || '?';
    }, { once: true });
  });

  // 位置決め：アイコンの下・右端そろえ。画面外にはみ出さないように収める。
  // position:fixed なので、ヘッダーが sticky でもスクロールでズレない
  const r = anchorEl.getBoundingClientRect();
  const w = menu.offsetWidth;
  let left = Math.min(r.right - w, window.innerWidth - w - 8);
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  const h = menu.offsetHeight;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';

  back.addEventListener('click', pwgwsCloseAccountMenu);
  const onKey = e => { if (e.key === 'Escape') { pwgwsCloseAccountMenu(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  menu.addEventListener('click', e => {
    const rm = e.target.closest('.pwgws-acc-rm');
    if (rm) {
      e.stopPropagation();
      const email = rm.dataset.remove;
      if (!confirm(email + ' をこの端末のアカウント一覧から削除します。\nよろしいですか？')) return;
      pwgwsRemoveAccount(email);
      pwgwsCloseAccountMenu();
      pwgwsOpenAccountMenu(anchorEl, opts);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      pwgwsCloseAccountMenu();
      if (act.dataset.act === 'add') pwgwsGoToAddAccount();
      else if (typeof opts.onSignOut === 'function') opts.onSignOut();
      return;
    }
    const it = e.target.closest('.pwgws-acc-it[data-email]');
    if (it) {
      const email = it.dataset.email;
      const cur = pwgwsGetSession();
      pwgwsCloseAccountMenu();
      if (cur && cur.email === email) return; // 今のアカウントなら何もしない
      if (pwgwsSwitchAccount(email)) pwgwsReloadForSessionChange();
    }
  });
}
