// ============================================================
// シフト表のドラッグ＆ドロップ
//
// 設計の要：人の上に落としたら「置き換え」。
// 当初は入れ替えにしていたが、実際に使うと置き換えたい場面のほうが多かった。
// 危ないのは上書きそのものではなく「誰が消えたのか分からないこと」なので、
// 誰が誰に変わったかを必ず見せることを条件に置き換えを許している：
//   落とす前  … 消える人に取り消し線を引き、「〇〇 を置き換え」と指の下に出す
//   落とした後 … 「〇〇 を △△ に置き換えました」と両方の名前で知らせる
//   やり直し   … 1操作ぶんの履歴を積むので 元に戻す（Ctrl+Z）で戻せる
//
//   セルの空き位置へ   … 移動
//   人の上へ           … 置き換え（元いた人は外れる）
//   満杯のセルの余白へ … 指に一番近い人を置き換え（空きが無いので誰かと交代になる）
//   左メニューへ       … 配置から外す
//
// すでに本人が入っている欄に本人を落としても変化が無いので、警告も出さずに
// 受け流す（掴んだ場所に戻したときと同じ扱い）。
//
// 責任者・カート担当欄（.role-sel）も同じ操作で編集できる。ただし役割は
// スロット表の配置とは別の層で、同じ人が両方に入るのが通常の運用なので、
// 層をまたぐドロップでは元の位置が残る（表の人を責任者欄へ落とす＝その人を
// 責任者にする。表の配置はそのまま）。
//   役割欄どうし             … 移動・置き換え
//   表・左メニュー → 役割欄  … その役に就ける（元の配置はそのまま）
//   役割欄 → 表              … その場所に配置する（役割はそのまま）
//   役割欄 → 左メニュー      … その役から外す
//
// カート番号の枠（.cart-chip）はさらに別の層で、運ぶのは人ではなく番号。
// カートは1台しか無いので同じ番号を2か所へは置けず、ピッカーでは他所で使用中の
// 番号を選べないようにしてある。その制限の下で置き場所を入れ替えるための操作。
//   番号の入った枠へ … 入れ替え（相手の番号がこちらへ来る。消えるものは無い）
//   空の枠へ         … 移動
//   層をまたぐ入れ替え（場所の番号 ↔ 担当欄の番号）は意味が違うので受け付けない
// 担当者を動かすとその人が運ぶ番号も一緒に動く（dndApplyRole）。番号の枠を直接
// 掴んだときだけ番号だけが動く、と操作の起点で区別している
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

// 責任者・カート担当欄かどうか。スロット表（.cs）とは別の層として扱う
function dndIsRole(el) { return !!el && el.classList && el.classList.contains('role-sel'); }
// カート番号の枠かどうか。人ではなく番号を運ぶので、また別の層として扱う
function dndIsCart(el) { return !!el && el.classList && el.classList.contains('cart-chip'); }
function dndRoleName(role) {
  return role === 'resp' ? '責任者' : role === 'bring' ? '持ち込み担当' : '持ち帰り担当';
}
// 同じ役の欄（担当①②）をまとめて返す
function dndRoleGroup(el) {
  return [...document.querySelectorAll(`#tb-${el.dataset.bi} .role-sel[data-role="${el.dataset.role}"]`)];
}
function dndBlock(bi) {
  const tab = (window._dateTabs || [])[activeDateIdx];
  if (!tab) return null;
  return (shiftDates || []).filter(d => d.date === tab.date)[bi] || null;
}
// 横に長いスロット表の外枠（カート担当表の .tbl-wrap と区別する）
function dndSlotWrap() {
  const t = document.querySelector('#main-content .shift-tbl');
  return t ? t.closest('.tbl-wrap') : null;
}

// 左メニューで、押した点がどの奉仕者の行かを決める。
// 名前の文字だけでなく行のどこを押しても掴めるように、要素の親子関係だけに頼らず
// 押した Y 座標がどの行の範囲に入るかでも判定する（丸印・バッジ・行の余白・
// 行間の境界線のように、名前と別の要素の上を押しても同じ行として扱う）
function dndMemberRow(e) {
  const direct = e.target.closest && e.target.closest('#lp-members .mr-wrap[data-uid]');
  if (direct) return direct;
  const lp = document.getElementById('lp-members');
  if (!lp || !lp.contains(e.target)) return null;
  return [...lp.querySelectorAll('.mr-wrap[data-uid]')].find(r => {
    const b = r.getBoundingClientRect();
    return e.clientY >= b.top && e.clientY <= b.bottom;
  }) || null;
}

// ===== 開始 =====
document.addEventListener('pointerdown', e => {
  if (e.button !== undefined && e.button !== 0) return;
  const cc = e.target.closest && e.target.closest('.cart-chip');
  const cs = e.target.closest && e.target.closest('.cs');
  const rs = e.target.closest && e.target.closest('.role-sel');
  const mr = dndMemberRow(e);
  let uid = '', name = '', fromEl = null, srcEl = null, kind = 'person';

  if (cc && cc.dataset.value && !cc.disabled) {
    // カート番号には uid が無い。ゴーストに出すラベル（①②）だけを name に入れる
    kind = 'cart'; name = cartLabel(cc.dataset.value); fromEl = cc; srcEl = cc;
  } else if (cs && cs.dataset.value) {
    uid = cs.dataset.value; name = cs.textContent; fromEl = cs; srcEl = cs;
  } else if (rs && rs.dataset.value) {
    uid = rs.dataset.value; name = rs.textContent; fromEl = rs; srcEl = rs;
  } else if (mr) {
    uid = mr.dataset.uid; name = mr.dataset.name || ''; srcEl = mr;
  } else return;

  _dnd = { kind, uid, name, fromEl, srcEl, ghost: null, started: false, x: e.clientX, y: e.clientY,
           holdTimer: null, scrollTimer: null, pointerType: e.pointerType, pointerId: e.pointerId };
  // タッチは長押しで開始（すぐ始めるとスクロールできなくなる）
  if (e.pointerType === 'touch') {
    // 押したことが指で分かるように、掴む対象をすぐ薄く光らせる。
    // 「長押ししたのに無反応」なのか「掴む対象を外している」のかを見分けられる
    srcEl.classList.add('dnd-press');
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
  // 掴んでいる本人を光らせたまま運ぶ。どの人を持っているかがゴーストだけでなく
  // 元の位置でも分かる。マウスはここで初めて付ける（pointerdown で付けると
  // ピッカーを開くだけのクリックでも一瞬光ってしまう）
  _dnd.srcEl.classList.add('dnd-press');
  document.body.classList.add('dnd-on');
  const g = document.createElement('div');
  g.className = 'dnd-ghost';
  g.textContent = _dnd.name || _dnd.uid;
  document.body.appendChild(g);
  _dnd.ghost = g;
  dndMoveGhost(x, y);
  closePicker && closePicker();
  // スマホでは左パネルが表を覆っている。掴んだ瞬間に閉じないと運ぶ先が見えない
  if (typeof closeLpForDrag === 'function') closeLpForDrag();
  dndShowDropBar();
  _dnd.scrollTimer = setInterval(() => dndAutoScroll(), 50);
}

// ===== スマホ用の受け皿バー =====
// 左パネルを閉じて運ぶので、これまで「外す」に使っていた左パネルへの
// ドロップ先が無くなる。その代わりと、掴み直したいときの取り消し口を兼ねる。
// 掴む元がセル（fromEl あり）なら「外す」、一覧からなら「取り消し」
function dndDropBarEl() {
  let el = document.getElementById('dnd-drop-bar');
  if (!el) {
    el = document.createElement('div');
    el.className = 'dnd-drop-bar';
    el.id = 'dnd-drop-bar';
    document.body.appendChild(el);
  }
  return el;
}

function dndShowDropBar() {
  if (!_dnd) return;
  // 出す条件は「指かどうか」ではなく「左パネルが引き出しかどうか」。
  // 引き出し＝ドラッグ開始時に閉じるので、左パネルへ落として外すことが
  // できなくなる。その穴埋めが目的なので、指でもマウスでも同じように要る
  // （PC のウィンドウを狭めた場合も引き出しになる）。
  // 逆に左パネルが出たままの幅なら、そこへ落とせば外せるので出さない
  if (!(typeof isScMobile === 'function' && isScMobile())) return;
  const el = dndDropBarEl();
  const isCancel = !_dnd.fromEl;
  el.innerHTML = isCancel ? (ic('x') + ' ここへ離すと取り消し') : (ic('trash-2') + ' ここへ離すと外します');
  el.classList.toggle('cancel', isCancel);
  el.classList.remove('hot');
  el.classList.add('on');
  _dnd.dropBar = el;
}

function dndHideDropBar() {
  const el = document.getElementById('dnd-drop-bar');
  if (el) el.classList.remove('on', 'hot');
}

// 指がバーの上にあるか。バーは pointer-events:none なので
// elementFromPoint には出てこない。座標で判定する
function dndOverDropBar(x, y) {
  const el = _dnd && _dnd.dropBar;
  if (!el || !el.classList.contains('on')) return false;
  const b = el.getBoundingClientRect();
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
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

// ドラッグ中、指の下に理由付きのラベルを出す（エラーは赤／注意は黄／案内は紫）
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
  _dnd.msgEl.classList.toggle('info', kind === 'info');
  dndMoveMsg(_dnd.lx, _dnd.ly);
}

function dndMoveMsg(x, y) {
  if (!_dnd || !_dnd.msgEl || x === undefined) return;
  _dnd.msgEl.style.left = (x + 12) + 'px';
  _dnd.msgEl.style.top  = (y + 34) + 'px';
}

// 表が横に長いので、端に寄せたら自動でスクロールする。
// 横に動くのはスロット表の外枠、縦に動くのは本文全体（#main-content）で別物。
// 責任者・カート担当欄は表の上にあるので、縦が動かないと下の行から掴んだ人を
// 役割欄まで運べない
function dndAutoScroll() {
  if (!_dnd || !_dnd.started || _dnd.lx === undefined) return;
  // 受け皿バーの上では動かさない。バーは画面下端にあるので、
  // そのままだと「下端に近い＝下へスクロール」と誤って判定される
  if (dndOverDropBar(_dnd.lx, _dnd.ly)) return;
  const wrap = dndSlotWrap();
  if (wrap) {
    const r = wrap.getBoundingClientRect();
    if (_dnd.lx > r.right - DND_EDGE) wrap.scrollLeft += 12;
    else if (_dnd.lx < r.left + DND_EDGE) wrap.scrollLeft -= 12;
  }
  const box = document.getElementById('main-content');
  if (box) {
    const b = box.getBoundingClientRect();
    if (_dnd.ly > b.bottom - DND_EDGE) box.scrollTop += 8;
    else if (_dnd.ly < b.top + DND_EDGE) box.scrollTop -= 8;
  }
}

// 表を作り直しても横スクロール位置を保つ。ドラッグ直後に表が左端へ飛ぶと
// いま落とした場所を見失う
function dndRerenderBlock() {
  const box = document.getElementById('main-content');
  const top = box ? box.scrollTop : 0;
  const before = dndSlotWrap();
  const left = before ? before.scrollLeft : 0;
  renderBlock();
  if (box) box.scrollTop = top;
  const after = dndSlotWrap();
  if (after) after.scrollLeft = left;
}

// ===== 落とし先の判定 =====
// 人の上なら「入れ替え」、セルの空き部分なら「移動」。左メニューなら「外す」
function dndHitTest(x, y) {
  // 受け皿バーは他のどの落とし先より優先する（画面下端に重ねてあるため）
  if (dndOverDropBar(x, y)) return _dnd.fromEl ? { kind: 'remove', dropBar: true } : { kind: 'cancel' };
  if (_dnd && _dnd.ghost) _dnd.ghost.classList.add('is-hidden');
  const el = document.elementFromPoint(x, y);
  if (_dnd && _dnd.ghost) _dnd.ghost.classList.remove('is-hidden');
  if (!el || !el.closest) return null;

  if (_dnd.kind === 'cart') return dndCartHit(el);

  if (el.closest('#lp')) return _dnd.fromEl ? { kind: 'remove' } : null;

  const role = dndRoleTarget(el);
  if (role) {
    if (dndNoChange(role)) return null;
    return { kind: role.dataset.value ? 'over' : 'move', el: role, role: true };
  }

  const cs = el.closest('.cs');
  // cs が null のときに素通りさせないと、左メニューから（fromEl も null）
  // セルの余白へ落とす操作が無反応になる
  if (cs && dndNoChange(cs)) return null;
  if (cs) return { kind: cs.dataset.value ? 'over' : 'move', el: cs };

  const cell = el.closest('.cell-w');
  if (cell) {
    // 同じセルの中で位置を変えても意味がないので何もしない
    if (_dnd.fromEl && cell.contains(_dnd.fromEl)) return null;
    return dndFreeInCell(cell, _dnd.uid, x, y);
  }
  return null;
}

// 落としても何も変わらない欄か。掴んだ場所に戻した場合と、すでに本人が
// 入っている欄（本人を本人に置き換えても意味が無い）。どちらも警告は出さない
function dndNoChange(el) {
  return el === _dnd.fromEl || el.dataset.value === _dnd.uid;
}

// 責任者・カート担当欄を返す。欄そのものは小さいので、ラベルや枡の余白を
// 押しても同じ欄として扱う（カート番号の枡には .role-sel が無いので null）
function dndRoleTarget(el) {
  const direct = el.closest('.role-sel');
  if (direct) return direct;
  const box = el.closest('.ra-item, .cart-tbl td');
  return box ? box.querySelector('.role-sel') : null;
}

// カート番号の落とし先。番号が入っている枠なら「入れ替え」、空の枠なら「移動」。
// 枠そのものは小さいので、枡の余白を押しても同じ枠として扱う。
// 担当者が居ない担当欄の枠は無効（disabled）なので落とせない
function dndCartHit(el) {
  let chip = el.closest('.cart-chip');
  if (!chip) {
    const box = el.closest('.cart-cell, .cart-tbl td');
    chip = box ? box.querySelector('.cart-chip') : null;
  }
  if (!chip || chip.disabled || chip === _dnd.fromEl) return null;
  return { kind: chip.dataset.value ? 'swap' : 'move', el: chip, cart: true };
}

// カート番号を落とせない理由。落とせるなら空文字。
// 場所の番号（どこに置くか）と担当欄の番号（誰が運ぶか）は意味が違うので
// 層をまたいだ入れ替えは受け付けない。持ち込み↔持ち帰りの入れ替えだけは、
// 入れ替えた結果 同じ側に同じ番号が並んでしまうときに拒否する
function dndCartReject(hit, fromEl) {
  if (!fromEl || typeof cartLayerOf !== 'function') return '';
  const a = cartLayerOf(fromEl), b = cartLayerOf(hit.el);
  if (!a || !b) return '';
  if (a === 'place' || b === 'place') {
    return a === b ? '' : '場所のカート番号と担当欄のカート番号は入れ替えられません';
  }
  if (a === b) return '';   // 同じ側どうしの入れ替えは重複を作らない
  const dup = dndCartSwapDup(fromEl, hit.el) || dndCartSwapDup(hit.el, fromEl);
  return dup ? `入れ替えると ${dup} が重複します` : '';
}

// dstEl に srcEl の番号を入れたときに重複する番号（無ければ空文字）。
// srcEl 自身はこの操作で別の値になるので、重複の数に入れない
function dndCartSwapDup(dstEl, srcEl) {
  const incoming = cartNums(srcEl.dataset.value);
  const used = {};
  cartPeerChips(dstEl).forEach(p => {
    if (p === srcEl) return;
    cartNums(p.dataset.value).forEach(n => { used[n] = true; });
  });
  const n = incoming.find(x => used[x]);
  return n ? circledNum(n) : '';
}

// 誰の上でもない、セルの余白へ落としたときの行き先。
// 空きがあればそこへ入れる（姉妹は1番目＝固定枠に入れないので後ろの空きを優先）。
// 3人埋まっていれば指に一番近い人を置き換える。位置を決め打ちすると誰が消えるか
// 予想できないので、いちばん近い人＝狙った相手として扱う（取り消し線で確認できる）
function dndFreeInCell(cell, uid, x, y) {
  if (!cell) return null;
  const els = [...cell.querySelectorAll('.cs')];
  const frees = els.filter(s => !s.dataset.value);
  if (frees.length === 0) {
    const near = dndNearest(els, x, y);
    return !near || near.dataset.value === uid ? null : { kind: 'over', el: near };
  }
  const free = frees.find(s => !(+s.dataset.pi === 0 && dndIsSister(uid))) || frees[0];
  return { kind: 'move', el: free };
}

// 指に一番近い欄。枠の中なら距離0になるので、重なっていても素直に選ばれる
function dndNearest(els, x, y) {
  let best = null, bestD = Infinity;
  els.forEach(el => {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = el; }
  });
  return best;
}

function dndHighlight(hit) {
  document.querySelectorAll('.dnd-over,.dnd-replace,.dnd-swap,.dnd-ng,.dnd-warn').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-replace', 'dnd-swap', 'dnd-ng', 'dnd-warn'));
  // 受け皿バーは指が乗っているときだけ色を変える。落とすとどうなるかを
  // 離す前に見せる（赤＝外す／灰＝取り消し）
  const bar = document.getElementById('dnd-drop-bar');
  if (bar) bar.classList.toggle('hot', !!hit && (hit.dropBar || hit.kind === 'cancel'));
  if (!hit || hit.kind === 'cancel') { dndSetMsg(''); return; }
  if (hit.kind === 'remove') {
    // 受け皿バー経由のときはバー自身が色で示すので、左パネルは光らせない
    if (!hit.dropBar) { const lp = document.getElementById('lp'); if (lp) lp.classList.add('dnd-over'); }
    dndSetMsg(''); return;
  }
  // 光らせる範囲。表はセル全体、役割欄・カート番号の枠は枠そのもの
  const box = (hit.role || hit.cart) ? hit.el : (hit.el.closest('.cell-w') || hit.el);
  const bad = dndReject(hit, _dnd.uid, _dnd.fromEl);
  if (bad) { box.classList.add('dnd-ng'); dndSetMsg(bad, 'ng'); return; }
  // カート番号の入れ替えは、消えるのではなく相手の番号がこちらへ来る。
  // 取り消し線（置き換え）と混同させないよう別の見た目にする
  if (hit.cart) {
    box.classList.add(hit.kind === 'swap' ? 'dnd-swap' : 'dnd-over');
    dndSetMsg(dndDropNote(hit), 'info');
    return;
  }
  // 置き換えは消える人だけに取り消し線、移動はセル全体を光らせて、
  // どちらになるか・誰が消えるかを指を離す前に見せる
  if (hit.kind === 'over') hit.el.classList.add('dnd-replace');
  else box.classList.add('dnd-over');
  const warn = dndWarnMsg(hit, _dnd.uid);
  const note = dndDropNote(hit);
  if (warn) {
    (hit.kind === 'over' ? hit.el : box).classList.add('dnd-warn');
    dndSetMsg(note ? `${warn}／${note}` : warn, 'warn');
    return;
  }
  dndSetMsg(note, 'info');
}

// 落とす前に伝えること。消える人の名前と、層をまたぐと元の位置が残ること。
// 役割とスロット表は別の層なので、またぐドロップを移動だと思って落とすと
// 二重に入ったように見える
function dndDropNote(hit) {
  if (!_dnd || !hit || !hit.el) return '';
  if (hit.cart) {
    const to = cartChipLabel(hit.el);
    return hit.kind === 'swap'
      ? `${cartLabel(hit.el.dataset.value)} と入れ替え（${to}）`
      : `${to} へ移動`;
  }
  const parts = [];
  if (hit.kind === 'over') {
    const p = hit.el.dataset.value;
    parts.push(`${buildNameMap()[p] || p} を置き換え`);
  }
  const from = _dnd.fromEl;
  if (from && hit.role && !dndIsRole(from)) parts.push(`${dndRoleName(hit.el.dataset.role)}にする（配置はそのまま）`);
  else if (from && !hit.role && dndIsRole(from)) parts.push(`${dndRoleName(from.dataset.role)}のまま配置`);
  return parts.join('／');
}

// 姉妹かどうか。性別が未設定の人は判定できないので姉妹とはみなさない
// （コンボボックスの候補判定 buildCandidates／validation.js と同じ基準）
function dndIsSister(uid) {
  const g = ((typeof memberFlags !== 'undefined' ? memberFlags : {})[uid] || {}).gender || '';
  return !!g && g !== 'M';
}

// 落とせない理由（エラー・落とせない）。落とせるなら空文字
// uid・fromEl は引数で受け取る（確定処理では _dnd を破棄したあとに呼ぶため）
function dndReject(hit, uid, fromEl) {
  if (!hit || !hit.el || hit.kind === 'remove') return '';
  if (hit.cart) return dndCartReject(hit, fromEl);
  if (hit.role) return dndRoleReject(hit, uid, fromEl);
  const cell = hit.el.closest('.cell-w');
  if (!cell) return '';
  // 掴んだ本人は除く。除かないと、同じセルの中での入れ替え（1番目と2・3番目の
  // 並べ直し）が「すでにこの場所に入っています」で弾かれてしまう
  const inCell = [...cell.querySelectorAll('.cs')].some(s => s !== hit.el && s !== fromEl && s.dataset.value === uid);
  if (inCell) return 'すでにこの場所に入っています';

  // 固定枠（セルの1番目）は兄弟だけ
  if (+hit.el.dataset.pi === 0 && dndIsSister(uid)) return '1番目（固定枠）には兄弟しか入れられません';

  // 同一スロット行の重複は物理的に不可能なので、どこであれ落とせない
  // （置き換えで消える人と、移動元として空く欄は数に入れない）
  const bi = hit.el.dataset.bi, ri = +hit.el.dataset.ri;
  const rowDup = [...document.querySelectorAll(`#tb-${bi} .cs`)]
    .some(s => +s.dataset.ri === ri && s !== hit.el && s !== fromEl && s.dataset.value === uid);
  if (rowDup) return 'この時間はすでに別の場所に配置されています';
  return '';
}

// 責任者・カート担当欄に落とせない理由。落とせるなら空文字。
// ピッカーで選べないもの（役の登録が無い・同じ役の重複）はドロップでも入れられない。
// 移動元の欄はこの操作で空くので、重複の数に入れない
function dndRoleReject(hit, uid, fromEl) {
  const role = hit.el.dataset.role;
  const f = (typeof memberFlags !== 'undefined' ? memberFlags : {})[uid] || {};
  if (role === 'resp' && !f.respFlag) return '責任者に登録されていません';
  if (role !== 'resp' && !f.cartFlag) return 'カート担当に登録されていません';
  const dup = dndRoleGroup(hit.el).some(s => s !== hit.el && s !== fromEl && s.dataset.value === uid);
  if (dup) return `すでに${dndRoleName(role)}に入っています`;
  return '';
}

// 落とせるが注意が必要な理由（カート不可・備考の時間と合わない・申込が無い）。
// 判定の基準は公開前チェック（validation.js の cartNg／noteCart／noteResp）と同じ
function dndRoleWarn(el, uid) {
  const block = dndBlock(+el.dataset.bi);
  if (!block || typeof wishOf !== 'function') return '';
  const w = wishOf({ applicants }, uid, block.date, block.time);
  if (!w) return 'この時間帯に申込がありません';
  const o = typeof w === 'object' ? w : {};
  const role = el.dataset.role;
  if (role !== 'resp' && o.cartNg) return '「カート不可」で希望を出しています';
  const win = typeof vNoteWindow === 'function' ? vNoteWindow(o.note) : null;
  if (!win) return '';
  const br = vRange(block.time);
  if (role === 'bring') return win.s > br.s ? `「${o.note}」の希望です（開始時刻にカートを持ち込めません）` : '';
  if (role === 'take')  return win.e < br.e ? `「${o.note}」の希望です（終了時刻までカートを持ち帰れません）` : '';
  return `「${o.note}」の希望です（時間帯の全体は担当できません）`;
}

// その位置にその人を置いた場合の候補分類を1件返す（buildCandidates と同じ基準）
function dndCandAt(el, uid) {
  if (!el || !uid || typeof buildCandidates !== 'function') return null;
  const ri = +el.dataset.ri, li = +el.dataset.li, pi = +el.dataset.pi;
  const block = dndBlock(+el.dataset.bi);
  if (!block) return null;
  if (typeof syncCurrentBlock === 'function') syncCurrentBlock();
  const base = filterAppliedForSlot(block.date, block.time);
  const cands = buildCandidates(base, block, ri, li, {
    groups: buildBlockGroups(shiftDates), shiftDates, memberFlags, conflictMap,
    assignCounts: slotAssignCounts, applicants,
  }, '', pi);
  return cands.find(x => x.uid === uid) || null;
}

// 落とせるが注意が必要な理由（備考の時間外・連続配置・他PW重複）。無ければ空文字
// コンボボックスの候補分類（buildCandidates／validation.js）と同じ基準を使う
function dndWarnMsg(hit, uid) {
  if (!hit || !hit.el || hit.kind === 'remove' || hit.cart) return '';
  const key = hit.el.id + '|' + uid;
  if (_dnd.warnCache && _dnd.warnCache.key === key) return _dnd.warnCache.msg;
  if (hit.role) {
    const m = dndRoleWarn(hit.el, uid);
    _dnd.warnCache = { key, msg: m };
    return m;
  }
  if (typeof buildCandidates !== 'function') return '';
  let msg = '';
  const c = dndCandAt(hit.el, uid);
  if (c) {
    // 固定枠に姉妹を入れる操作は dndReject で拒否しているので、ここでは扱わない
    if (c.state === 'notetime') msg = c.reason || '備考の参加時間外です';
    else if (c.state === 'consec') msg = '連続配置になります';
    else if (c.state === 'crosspw') msg = '他のPWに配置済みです';
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
  if (!hit || hit.kind === 'cancel') return;

  const bad = dndReject(hit, uid, fromEl);
  if (bad) { toast(bad, 'e'); return; }

  if (hit.kind === 'remove') {
    if (!fromEl) return;
    const nm = buildNameMap()[uid] || uid;
    if (dndIsRole(fromEl)) {
      const rn = dndRoleName(fromEl.dataset.role);
      setPsDom(fromEl, '');
      syncRoleCartNum(fromEl);
      mu(+fromEl.dataset.bi);
      dndRerenderBlock();
      toast(`${nm} を${rn}から外しました`, 's');
      return;
    }
    setPsValue(fromEl, '');
    toast(`${nm} を外しました`, 's');
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
  dndHideDropBar();
  clearTimeout(_dnd.holdTimer);
  clearInterval(_dnd.scrollTimer);
  try { document.documentElement.releasePointerCapture(_dnd.pointerId); } catch (_) {}
  if (_dnd.ghost) _dnd.ghost.remove();
  if (_dnd.msgEl) _dnd.msgEl.remove();
  document.body.classList.remove('dnd-on');
  document.querySelectorAll('.dnd-over,.dnd-replace,.dnd-swap,.dnd-ng,.dnd-warn,.dnd-press').forEach(el =>
    el.classList.remove('dnd-over', 'dnd-replace', 'dnd-swap', 'dnd-ng', 'dnd-warn', 'dnd-press'));
  _dnd = null;
}

// 移動または置き換え。消えた人が誰かは必ず知らせる
function dndApply(fromEl, targetEl, uid) {
  if (dndIsCart(targetEl)) { dndApplyCart(fromEl, targetEl); return; }
  if (dndIsRole(targetEl)) { dndApplyRole(fromEl, targetEl, uid); return; }
  const bi = +targetEl.dataset.bi;
  const nm = buildNameMap();
  const tgtVal = targetEl.dataset.value || '';
  const sameLayer = fromEl && !dndIsRole(fromEl);   // 表の中での操作か

  setPsDom(targetEl, uid);
  // 表の中での操作だけ移動元が空く。左メニュー・役割欄からは元の位置が残る
  if (sameLayer) {
    setPsDom(fromEl, '');
    compactCell(+fromEl.dataset.bi, +fromEl.dataset.ri, +fromEl.dataset.li);
  }
  compactCell(bi, +targetEl.dataset.ri, +targetEl.dataset.li);
  mu(bi);
  const who = nm[uid] || uid;
  toast(tgtVal    ? `${nm[tgtVal] || tgtVal} を ${who} に置き換えました`
      : sameLayer ? `${who} を移動しました`
      : fromEl    ? `${who} を配置しました（${dndRoleName(fromEl.dataset.role)}のままです）`
                  : `${who} を配置しました`, 's');
}

// カート番号の移動・入れ替え。どの番号がどこへ動いたかを必ず知らせる。
// 人と違って置き換え（消える）は無い。相手に番号が入っていれば必ず入れ替えになる
function dndApplyCart(fromEl, targetEl) {
  const src = fromEl.dataset.value || '';
  const dst = targetEl.dataset.value || '';
  setCartDom(targetEl, src);
  setCartDom(fromEl, dst);
  mu(+targetEl.dataset.bi);
  const a = cartChipLabel(fromEl), b = cartChipLabel(targetEl);
  toast(dst ? `${cartLabel(src)} と ${cartLabel(dst)} を入れ替えました（${a} ${ic('arrow-left-right')} ${b}）`
            : `${cartLabel(src)} を ${a} から ${b} へ移しました`, 's');
}

// 責任者・カート担当欄への確定。役割欄どうしなら移動・置き換え、
// 左メニュー・スロット表からなら役に就けるだけで元の位置はそのまま残す
function dndApplyRole(fromEl, targetEl, uid) {
  const nm = buildNameMap();
  const tgtVal = targetEl.dataset.value || '';
  const sameLayer = dndIsRole(fromEl);
  // カート番号は「その人が運ぶカート」なので、人と一緒に動かす。位置に残すと
  // 動かしたとたんに別のカートを運ぶことになってしまう。責任者欄との行き来には
  // 運ぶカートが無いので、その場合は番号を位置に残す
  const bothCart = sameLayer && fromEl.dataset.role !== 'resp' && targetEl.dataset.role !== 'resp';
  const fromNum = bothCart ? roleCartNumEl(fromEl) : null;
  const tgtNum  = bothCart ? roleCartNumEl(targetEl) : null;
  const fromNumVal = fromNum ? (fromNum.dataset.value || '') : '';

  setPsDom(targetEl, uid);
  syncRoleCartNum(targetEl);
  if (sameLayer) {
    setPsDom(fromEl, '');
    syncRoleCartNum(fromEl);
  }
  // 番号は担当者をそろえたあとに入れ直す（空いた欄の番号は syncRoleCartNum が消すため）
  if (tgtNum) setCartDom(tgtNum, fromNumVal);

  mu(+targetEl.dataset.bi);
  // ゴースト提案（候補：〜）は欄が空のときだけ出る。作り直して食い違いを消す
  dndRerenderBlock();
  const who = nm[uid] || uid;
  const sameRole = sameLayer && fromEl.dataset.role === targetEl.dataset.role;
  toast(tgtVal    ? `${nm[tgtVal] || tgtVal} を ${who} に置き換えました`
      : sameRole  ? `${who} を移動しました`
                  : `${who} を${dndRoleName(targetEl.dataset.role)}にしました`, 's');
}
