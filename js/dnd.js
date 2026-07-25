// ============================================================
// シフト表のドラッグ＆ドロップ
//
// 設計の要：「上書き」という動作を作らない。
// ドロップは指を離した瞬間に確定するため、上書きにすると狙いを外したときに
// 人が黙って消える。どのドロップでも移動か入れ替えにしかならないようにして、
// 「上書きか入れ替えか」を利用者が意識しなくて済むようにしている。
// 人を外すのは、左メニューへ戻したときだけ。
//
//   セルの空き位置へ … 移動
//   人の上へ         … 入れ替え
//   満杯のセルへ     … 受け付けない
//   左メニューへ     … 配置から外す
//
// マウスとタッチの両方で動かすため Pointer Events を使う
// （HTML5 の drag&drop API はタッチで動かない）。
// タッチでは長押しで開始し、通常のスクロールを妨げない。
//
// このファイルを変更したら shift-create.html の ?v= を +1 すること
// ============================================================

const DND_MOVE_THRESHOLD = 5;    // これ以上動いたらドラッグ開始（マウス）
const DND_HOLD_MS        = 350;  // タッチはこの時間押し続けたら開始
const DND_EDGE           = 48;   // 端から何pxで自動スクロールするか

let _dnd = null;   // { uid, name, fromEl, ghost, started, x, y, holdTimer, scrollTimer }

function dndActive() { return !!(_dnd && _dnd.started); }

// ===== 開始 =====
document.addEventListener('pointerdown', e => {
  if (e.button !== undefined && e.button !== 0) return;
  const cs = e.target.closest && e.target.closest('.cs');
  const mr = e.target.closest && e.target.closest('#lp-members .mr-wrap');
  let uid = '', name = '', fromEl = null;

  if (cs && cs.dataset.value) {
    uid = cs.dataset.value; name = cs.textContent; fromEl = cs;
  } else if (mr && mr.dataset.uid) {
    uid = mr.dataset.uid; name = mr.dataset.name || '';
  } else return;

  _dnd = { uid, name, fromEl, ghost: null, started: false, x: e.clientX, y: e.clientY,
           holdTimer: null, scrollTimer: null, pointerType: e.pointerType };
  // タッチは長押しで開始（すぐ始めるとスクロールできなくなる）
  if (e.pointerType === 'touch') {
    _dnd.holdTimer = setTimeout(() => { if (_dnd) dndStart(e.clientX, e.clientY); }, DND_HOLD_MS);
  }
}, true);

function dndStart(x, y) {
  if (!_dnd || _dnd.started) return;
  _dnd.started = true;
  document.body.classList.add('dnd-on');
  const g = document.createElement('div');
  g.className = 'dnd-ghost';
  g.textContent = _dnd.name || _dnd.uid;
  document.body.appendChild(g);
  _dnd.ghost = g;
  dndMoveGhost(x, y);
  closePicker && closePicker();
  _dnd.scrollTimer = setInterval(() => dndAutoScroll(), 50);
}

// ===== 移動 =====
document.addEventListener('pointermove', e => {
  if (!_dnd) return;
  if (!_dnd.started) {
    const far = Math.abs(e.clientX - _dnd.x) + Math.abs(e.clientY - _dnd.y) > DND_MOVE_THRESHOLD;
    if (_dnd.pointerType === 'touch') { if (far) dndCancel(); return; } // 長押し前に動いたらスクロール優先
    if (!far) return;
    dndStart(e.clientX, e.clientY);
  }
  e.preventDefault();
  _dnd.lx = e.clientX; _dnd.ly = e.clientY;
  dndMoveGhost(e.clientX, e.clientY);
  dndHighlight(dndHitTest(e.clientX, e.clientY));
}, { passive: false });

function dndMoveGhost(x, y) {
  if (!_dnd || !_dnd.ghost) return;
  _dnd.ghost.style.left = (x + 12) + 'px';
  _dnd.ghost.style.top  = (y + 12) + 'px';
}

// 表が横に長いので、端に寄せたら自動でスクロールする
function dndAutoScroll() {
  if (!_dnd || !_dnd.started || _dnd.lx === undefined) return;
  const wrap = document.querySelector('#main-content .tbl-wrap');
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  if (_dnd.lx > r.right - DND_EDGE) wrap.scrollLeft += 12;
  else if (_dnd.lx < r.left + DND_EDGE) wrap.scrollLeft -= 12;
  if (_dnd.ly > r.bottom - DND_EDGE) wrap.scrollTop += 8;
  else if (_dnd.ly < r.top + DND_EDGE) wrap.scrollTop -= 8;
}

// ===== 落とし先の判定 =====
// 人の上なら「入れ替え」、セルの空き部分なら「移動」。左メニューなら「外す」
function dndHitTest(x, y) {
  if (_dnd && _dnd.ghost) _dnd.ghost.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (_dnd && _dnd.ghost) _dnd.ghost.style.display = '';
  if (!el || !el.closest) return null;

  if (el.closest('#lp')) return _dnd.fromEl ? { kind: 'remove' } : null;

  const cs = el.closest('.cs');
  if (cs && cs !== _dnd.fromEl) {
    return cs.dataset.value ? { kind: 'swap', el: cs } : { kind: 'move', el: cs };
  }
  const cell = el.closest('.cell-w');
  if (cell) {
    const free = [...cell.querySelectorAll('.cs')].find(s => !s.dataset.value);
    return free ? { kind: 'move', el: free } : { kind: 'full', el: cell };
  }
  return null;
}

function dndHighlight(hit) {
  document.querySelectorAll('.dnd-over,.dnd-swap,.dnd-ng').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-swap', 'dnd-ng'));
  if (!hit) return;
  if (hit.kind === 'remove') { const lp = document.getElementById('lp'); if (lp) lp.classList.add('dnd-over'); return; }
  if (hit.kind === 'full') { hit.el.classList.add('dnd-ng'); return; }
  const bad = dndReject(hit, _dnd.uid);
  const cell = hit.el.closest('.cell-w');
  if (bad) { if (cell) cell.classList.add('dnd-ng'); return; }
  // 入れ替えは相手だけ、移動はセル全体を光らせて、どちらになるか分かるようにする
  if (hit.kind === 'swap') hit.el.classList.add('dnd-swap');
  else if (cell) cell.classList.add('dnd-over');
}

// 落とせない理由。落とせるなら空文字
// uid は引数で受け取る（確定処理では _dnd を破棄したあとに呼ぶため）
function dndReject(hit, uid) {
  if (!hit || !hit.el || hit.kind === 'remove') return '';
  if (hit.kind === 'full') return 'この場所は3名までです';
  const cell = hit.el.closest('.cell-w');
  if (!cell) return '';
  const inCell = [...cell.querySelectorAll('.cs')].some(s => s !== hit.el && s.dataset.value === uid);
  if (inCell) return 'すでにこの場所に入っています';
  return '';
}

// ===== 確定 =====
document.addEventListener('pointerup', e => {
  if (!_dnd) return;
  if (!_dnd.started) { dndCancel(); return; }
  const hit = dndHitTest(e.clientX, e.clientY);
  const uid = _dnd.uid, fromEl = _dnd.fromEl;
  dndCancel();
  if (!hit) return;

  const bad = dndReject(hit, uid);
  if (bad) { toast(bad, 'e'); return; }

  if (hit.kind === 'remove') {
    if (!fromEl) return;
    setPsValue(fromEl, '');
    toast(`${buildNameMap()[uid] || uid} を外しました`, 's');
    return;
  }
  dndApply(fromEl, hit.el, uid);
}, true);

document.addEventListener('pointercancel', () => dndCancel(), true);

function dndCancel() {
  if (!_dnd) return;
  clearTimeout(_dnd.holdTimer);
  clearInterval(_dnd.scrollTimer);
  if (_dnd.ghost) _dnd.ghost.remove();
  document.body.classList.remove('dnd-on');
  document.querySelectorAll('.dnd-over,.dnd-swap,.dnd-ng').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-swap', 'dnd-ng'));
  _dnd = null;
}

// 移動または入れ替え。人が消える経路は作らない
function dndApply(fromEl, targetEl, uid) {
  const bi = +targetEl.dataset.bi;
  const nm = buildNameMap();
  const tgtVal = targetEl.dataset.value || '';

  if (!fromEl) {
    // 左メニューから：空き位置に入れるだけ
    setPsDom(targetEl, uid);
    compactCell(bi, +targetEl.dataset.ri, +targetEl.dataset.li);
    mu(bi);
    toast(`${nm[uid] || uid} を配置しました`, 's');
    return;
  }
  // 表の中：移動元に相手を入れる（空なら移動、人がいれば入れ替え）
  setPsDom(targetEl, uid);
  setPsDom(fromEl, tgtVal);
  compactCell(+fromEl.dataset.bi, +fromEl.dataset.ri, +fromEl.dataset.li);
  compactCell(bi, +targetEl.dataset.ri, +targetEl.dataset.li);
  mu(bi);
  toast(tgtVal ? `${nm[uid] || uid} と ${nm[tgtVal] || tgtVal} を入れ替えました`
               : `${nm[uid] || uid} を移動しました`, 's');
}
