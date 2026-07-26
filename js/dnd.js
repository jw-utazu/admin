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
const DND_TOUCH_SLOP     = 14;   // 長押し待ちの間に許す指のぶれ（px）
const DND_HOLD_MS        = 350;  // タッチはこの時間押し続けたら開始
const DND_EDGE           = 48;   // 端から何pxで自動スクロールするか

let _dnd = null;   // { uid, name, fromEl, ghost, started, x, y, holdTimer, scrollTimer }
let _dndClickBlock = 0;  // この時刻まではクリックを無視する（下の「後始末」参照）

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
           holdTimer: null, scrollTimer: null, pointerType: e.pointerType, pointerId: e.pointerId };
  // タッチは長押しで開始（すぐ始めるとスクロールできなくなる）
  if (e.pointerType === 'touch') {
    _dnd.holdTimer = setTimeout(() => { if (_dnd) dndStart(_dnd.lx ?? e.clientX, _dnd.ly ?? e.clientY); }, DND_HOLD_MS);
  }
}, true);

function dndStart(x, y) {
  if (!_dnd || _dnd.started) return;
  _dnd.started = true;
  clearTimeout(_dnd.holdTimer);
  // ポインタを掴んでおく。掴まないと、指が元の要素から外れたり
  // 表が描き直されたりした瞬間に move/up が届かなくなる
  try { document.documentElement.setPointerCapture(_dnd.pointerId); } catch (_) {}
  if (_dnd.pointerType === 'touch' && navigator.vibrate) navigator.vibrate(15);
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
  if (_dnd.pointerId !== undefined && e.pointerId !== _dnd.pointerId) return;
  if (!_dnd.started) {
    const d = Math.abs(e.clientX - _dnd.x) + Math.abs(e.clientY - _dnd.y);
    // 指は止めているつもりでも数px揺れる。マウスより広く見る
    if (_dnd.pointerType === 'touch') {
      _dnd.lx = e.clientX; _dnd.ly = e.clientY;
      if (d > DND_TOUCH_SLOP) dndCancel();   // 長押し前に動いたらスクロール優先
      return;
    }
    if (d <= DND_MOVE_THRESHOLD) return;
    dndStart(e.clientX, e.clientY);
  }
  e.preventDefault();
  _dnd.lx = e.clientX; _dnd.ly = e.clientY;
  dndMoveGhost(e.clientX, e.clientY);
  dndHighlight(dndHitTest(e.clientX, e.clientY));
}, { passive: false });

// ドラッグ中は画面のスクロールを止める。
// pointermove の preventDefault ではスクロールは止まらないので、
// touchmove 側で明示的に止める必要がある（Android で必須）
document.addEventListener('touchmove', e => {
  if (dndActive()) e.preventDefault();
}, { passive: false });

// 長押し中に出る「テキスト選択・コンテキストメニュー」を抑える。
// これが出ると Android はポインタ操作を打ち切ってしまい、ドラッグが始まらない
document.addEventListener('contextmenu', e => { if (_dnd) e.preventDefault(); });

function dndMoveGhost(x, y) {
  if (!_dnd || !_dnd.ghost) return;
  _dnd.ghost.style.left = (x + 12) + 'px';
  _dnd.ghost.style.top  = (y + 12) + 'px';
  dndMoveMsg(x, y);
}

// ドラッグ中、指の下に理由付きのラベルを出す（エラーは赤／注意は黄）
function dndSetMsg(text, kind) {
  if (!_dnd) return;
  if (!text) { if (_dnd.msgEl) { _dnd.msgEl.remove(); _dnd.msgEl = null; } return; }
  if (!_dnd.msgEl) {
    const m = document.createElement('div');
    m.className = 'dnd-msg';
    document.body.appendChild(m);
    _dnd.msgEl = m;
  }
  _dnd.msgEl.textContent = text;
  _dnd.msgEl.classList.toggle('warn', kind === 'warn');
  dndMoveMsg(_dnd.lx, _dnd.ly);
}

function dndMoveMsg(x, y) {
  if (!_dnd || !_dnd.msgEl || x === undefined) return;
  _dnd.msgEl.style.left = (x + 12) + 'px';
  _dnd.msgEl.style.top  = (y + 34) + 'px';
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
  if (cs === _dnd.fromEl) return null;   // つかんだ場所に戻しただけ
  if (cs) return cs.dataset.value ? { kind: 'swap', el: cs } : { kind: 'move', el: cs };

  const cell = el.closest('.cell-w');
  if (cell) {
    // 同じセルの中で位置を変えても意味がないので何もしない
    if (_dnd.fromEl && cell.contains(_dnd.fromEl)) return null;
    const free = [...cell.querySelectorAll('.cs')].find(s => !s.dataset.value);
    return free ? { kind: 'move', el: free } : { kind: 'full', el: cell };
  }
  return null;
}

function dndHighlight(hit) {
  document.querySelectorAll('.dnd-over,.dnd-swap,.dnd-ng,.dnd-warn').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-swap', 'dnd-ng', 'dnd-warn'));
  if (!hit) { dndSetMsg(''); return; }
  if (hit.kind === 'remove') {
    const lp = document.getElementById('lp'); if (lp) lp.classList.add('dnd-over');
    dndSetMsg(''); return;
  }
  if (hit.kind === 'full') { hit.el.classList.add('dnd-ng'); dndSetMsg('この場所は3名までです', 'ng'); return; }
  const bad = dndReject(hit, _dnd.uid, _dnd.fromEl);
  const cell = hit.el.closest('.cell-w');
  if (bad) { if (cell) cell.classList.add('dnd-ng'); dndSetMsg(bad, 'ng'); return; }
  const warn = dndWarnMsg(hit, _dnd.uid);
  if (warn) {
    if (hit.kind === 'swap') hit.el.classList.add('dnd-warn'); else if (cell) cell.classList.add('dnd-warn');
    dndSetMsg(warn, 'warn');
    return;
  }
  dndSetMsg('');
  // 入れ替えは相手だけ、移動はセル全体を光らせて、どちらになるか分かるようにする
  if (hit.kind === 'swap') hit.el.classList.add('dnd-swap');
  else if (cell) cell.classList.add('dnd-over');
}

// 落とせない理由（エラー・落とせない）。落とせるなら空文字
// uid・fromEl は引数で受け取る（確定処理では _dnd を破棄したあとに呼ぶため）
function dndReject(hit, uid, fromEl) {
  if (!hit || !hit.el || hit.kind === 'remove') return '';
  if (hit.kind === 'full') return 'この場所は3名までです';
  const cell = hit.el.closest('.cell-w');
  if (!cell) return '';
  const inCell = [...cell.querySelectorAll('.cs')].some(s => s !== hit.el && s.dataset.value === uid);
  if (inCell) return 'すでにこの場所に入っています';

  // 同一スロット行の重複は物理的に不可能なので、どこであれ落とせない
  // （コンボボックスは「移動」として自動処理するが、DnDでは元位置を空にする
  //   保証がない＝ドロップ先から動かした本人以外に既にいる場合は拒否する）
  const bi = hit.el.dataset.bi, ri = +hit.el.dataset.ri;
  const rowDup = [...document.querySelectorAll(`#tb-${bi} .cs`)]
    .some(s => +s.dataset.ri === ri && s !== hit.el && s !== fromEl && s.dataset.value === uid);
  if (rowDup) return 'この時間はすでに別の場所に配置されています';

  // 入れ替え：相手が移動元の行で別の場所にも重複してしまう場合も拒否
  if (hit.kind === 'swap' && fromEl) {
    const tgtVal = hit.el.dataset.value;
    if (tgtVal) {
      const fbi = fromEl.dataset.bi, fri = +fromEl.dataset.ri;
      const tgtDup = [...document.querySelectorAll(`#tb-${fbi} .cs`)]
        .some(s => +s.dataset.ri === fri && s !== fromEl && s !== hit.el && s.dataset.value === tgtVal);
      if (tgtDup) return '入れ替え先の人がこの時間の別の場所に配置済みです';
    }
  }
  return '';
}

// 落とせるが注意が必要な理由（連続配置・他PW重複・固定枠は基本兄弟）。無ければ空文字
// コンボボックスの候補分類（buildCandidates／validation.js）と同じ基準を使う
function dndWarnMsg(hit, uid) {
  if (!hit || !hit.el || hit.kind === 'remove' || hit.kind === 'full') return '';
  if (typeof buildCandidates !== 'function') return '';
  const key = hit.el.id + '|' + uid;
  if (_dnd.warnCache && _dnd.warnCache.key === key) return _dnd.warnCache.msg;
  let msg = '';
  const bi = +hit.el.dataset.bi, ri = +hit.el.dataset.ri, li = +hit.el.dataset.li, pi = +hit.el.dataset.pi;
  const tab = (window._dateTabs || [])[activeDateIdx];
  const block = tab ? (shiftDates || []).filter(d => d.date === tab.date)[bi] : null;
  if (block) {
    if (typeof syncCurrentBlock === 'function') syncCurrentBlock();
    const base = filterAppliedForSlot(block.date, block.time);
    const cands = buildCandidates(base, block, ri, li, {
      groups: buildBlockGroups(shiftDates), shiftDates, memberFlags, conflictMap,
      assignCounts: slotAssignCounts, applicants,
    }, '', pi);
    const c = cands.find(x => x.uid === uid);
    if (c) {
      if (c.state === 'consec') msg = '連続配置になります';
      else if (c.state === 'crosspw') msg = '他のPWに配置済みです';
      else if (c.fixedNg) msg = '固定枠は通常兄弟です';
    }
  }
  _dnd.warnCache = { key, msg };
  return msg;
}

// ===== 確定 =====
document.addEventListener('pointerup', e => {
  if (!_dnd) return;
  if (_dnd.pointerId !== undefined && e.pointerId !== _dnd.pointerId) return;
  if (!_dnd.started) { dndCancel(); return; }
  const hit = dndHitTest(e.clientX, e.clientY);
  const uid = _dnd.uid, fromEl = _dnd.fromEl;
  // 指を離すと、落とした場所の要素に click が合成されて飛んでくる。
  // そのままだと落とした先の奉仕者ピッカーが勝手に開くので、少しの間だけ止める
  _dndClickBlock = Date.now() + 400;
  dndCancel();
  if (!hit) return;

  const bad = dndReject(hit, uid, fromEl);
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

document.addEventListener('click', e => {
  if (Date.now() < _dndClickBlock) { e.stopPropagation(); e.preventDefault(); }
}, true);

function dndCancel() {
  if (!_dnd) return;
  clearTimeout(_dnd.holdTimer);
  clearInterval(_dnd.scrollTimer);
  try { document.documentElement.releasePointerCapture(_dnd.pointerId); } catch (_) {}
  if (_dnd.ghost) _dnd.ghost.remove();
  if (_dnd.msgEl) _dnd.msgEl.remove();
  document.body.classList.remove('dnd-on');
  document.querySelectorAll('.dnd-over,.dnd-swap,.dnd-ng,.dnd-warn').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-swap', 'dnd-ng', 'dnd-warn'));
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
