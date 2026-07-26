// ============================================================
// 汎用ポップオーバー・ピッカー
//
// シフト作成画面の「奉仕者コンボボックス」と「カート番号トグルチップ」で
// 共有する土台。DOM は1つだけ作って使い回す（セルごとに要素を持たない）。
//
// openPicker(anchorEl, opts)
//   opts.title    見出し
//   opts.search   検索欄を出すか
//   opts.multi    複数選択（トグル）にするか
//   opts.items    [{ value, label, html, sub, disabled, group, selected }]
//   opts.value    単一選択時の現在値／複数選択時は配列
//   opts.onPick   (value, item) => void  単一選択で確定したとき
//   opts.onToggle (values[]) => void 複数選択で変わったとき（都度呼ぶ）
//   opts.onClose  () => void
//
// このファイルを変更したら shift-create.html の ?v= を +1 すること
// ============================================================

let _pkEl = null;      // ポップオーバー本体
let _pkOpts = null;
let _pkAnchor = null;
let _pkValues = [];    // multi のときの選択値
let _pkIdx = -1;       // キーボード操作中の候補位置

function _pkBuild() {
  if (_pkEl) return _pkEl;
  const d = document.createElement('div');
  d.className = 'pk';
  d.innerHTML = '<div class="pk-hd"><span class="pk-title"></span><button class="pk-x" type="button">✕</button></div>'
              + '<input class="pk-search" type="text" placeholder="名前で検索（ふりがな可）">'
              + '<div class="pk-list"></div>'
              + '<div class="pk-note"></div>';
  document.body.appendChild(d);
  d.querySelector('.pk-x').addEventListener('click', () => closePicker());
  d.addEventListener('pointerdown', e => e.stopPropagation());
  d.querySelector('.pk-search').addEventListener('input', () => _pkRender());
  d.querySelector('.pk-search').addEventListener('keydown', _pkKey);
  _pkEl = d;
  return d;
}

// タブレット（指操作）かどうか。検索欄の自動フォーカスの可否に使う
const _pkCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

// 外側をタップ／クリック・ESC で閉じる
// mousedown ではなく pointerdown を見る。Android では mousedown が
// 指を離したあとに遅れて合成されるため、閉じる判定が実際の操作とずれる
document.addEventListener('pointerdown', e => {
  if (!_pkEl || !_pkEl.classList.contains('on')) return;
  if (_pkEl.contains(e.target)) return;
  if (_pkAnchor && _pkAnchor.contains(e.target)) return;
  closePicker();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && _pkEl && _pkEl.classList.contains('on')) { e.stopPropagation(); closePicker(); }
});

// Android でソフトキーボードが開くと resize が起きる。
// ここで閉じてしまうと「開いた瞬間に消える」ように見えるので、閉じずに位置だけ直す。
// 画面の向きを変えたときだけは、位置の前提が崩れるので閉じる
let _pkRT = null;
function _pkReposition() {
  if (!_pkEl || !_pkEl.classList.contains('on') || !_pkAnchor) return;
  clearTimeout(_pkRT);
  _pkRT = setTimeout(() => { if (_pkAnchor) _pkPosition(_pkAnchor); }, 60);
}
window.addEventListener('resize', _pkReposition);
if (window.visualViewport) window.visualViewport.addEventListener('resize', _pkReposition);
window.addEventListener('orientationchange', () => closePicker());

function openPicker(anchorEl, opts) {
  const el = _pkBuild();
  _pkOpts = opts || {};
  _pkAnchor = anchorEl;
  _pkValues = _pkOpts.multi ? (_pkOpts.value || []).slice() : [];
  _pkIdx = -1;
  el.querySelector('.pk-title').textContent = _pkOpts.title || '';
  const note = el.querySelector('.pk-note');
  note.textContent = _pkOpts.note || '';
  note.style.display = _pkOpts.note ? '' : 'none';
  const s = el.querySelector('.pk-search');
  s.style.display = _pkOpts.search ? '' : 'none';
  s.value = '';
  el.classList.add('on');
  _pkRender();
  _pkPosition(anchorEl);
  // 指操作の端末では自動フォーカスしない。
  // 開いた直後にソフトキーボードが立ち上がって候補一覧が隠れてしまうため、
  // 検索したいときだけ利用者に検索欄を触ってもらう
  if (_pkOpts.search && !_pkCoarse) setTimeout(() => s.focus(), 0);
}

function closePicker() {
  if (!_pkEl || !_pkEl.classList.contains('on')) return;
  _pkEl.classList.remove('on');
  const cb = _pkOpts && _pkOpts.onClose;
  _pkAnchor = null;
  _pkOpts = null;
  if (cb) cb();
}

// アンカーの下に出す。画面からはみ出すときは上・左にずらす
// はみ出しの判定には visualViewport を使う。ソフトキーボードが出ている間は
// innerHeight が変わらないため、それだけを見るとキーボードの下に隠れてしまう
function _pkPosition(anchorEl) {
  const el = _pkEl, r = anchorEl.getBoundingClientRect();
  const vv = window.visualViewport;
  const vw = vv ? vv.width : window.innerWidth;
  const vh = vv ? vv.height : window.innerHeight;
  const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
  el.style.visibility = 'hidden';
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = r.left, top = r.bottom + 4;
  if (left + w > ox + vw - 8)  left = Math.max(ox + 8, ox + vw - w - 8);
  if (top + h > oy + vh - 8)   top = Math.max(oy + 8, r.top - h - 4);
  el.style.left = left + 'px';
  el.style.top  = top + 'px';
  el.style.visibility = '';
}

function _pkFiltered() {
  const q = (_pkEl.querySelector('.pk-search').value || '').trim().toLowerCase();
  const items = (_pkOpts.items || []);
  if (!q) return items;
  return items.filter(it => (it.search || it.label || '').toLowerCase().includes(q));
}

function _pkRender() {
  const list = _pkEl.querySelector('.pk-list');
  const items = _pkFiltered();
  let html = '', lastGroup = null;
  items.forEach((it, i) => {
    if (it.group && it.group !== lastGroup) { html += `<div class="pk-grp">${it.group}</div>`; lastGroup = it.group; }
    const on = _pkOpts.multi ? _pkValues.includes(it.value) : (it.value === _pkOpts.value);
    html += `<button type="button" class="pk-it${on ? ' on' : ''}${it.disabled ? ' dis' : ''}${i === _pkIdx ? ' cur' : ''}" data-i="${i}"${it.disabled ? ' disabled' : ''}>`
         +  (_pkOpts.multi ? `<span class="pk-cb">${on ? '☑' : '☐'}</span>` : '')
         +  `<span class="pk-body">${it.html || it.label}</span>`
         +  (it.sub ? `<span class="pk-sub">${it.sub}</span>` : '')
         +  `</button>`;
  });
  list.innerHTML = html || '<div class="pk-empty">該当する候補がありません</div>';
  list.querySelectorAll('.pk-it').forEach(b => {
    b.addEventListener('click', () => _pkChoose(items[+b.dataset.i]));
  });
}

function _pkChoose(it) {
  if (!it || it.disabled) return;
  if (_pkOpts.multi) {
    const i = _pkValues.indexOf(it.value);
    if (i >= 0) _pkValues.splice(i, 1); else _pkValues.push(it.value);
    _pkRender();
    if (_pkOpts.onToggle) _pkOpts.onToggle(_pkValues.slice());
  } else {
    const cb = _pkOpts.onPick;
    const v = it.value;
    closePicker();
    if (cb) cb(v, it);
  }
}

function _pkKey(e) {
  const items = _pkFiltered();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    for (let n = 0; n < items.length; n++) {
      _pkIdx = (_pkIdx + step + items.length) % items.length;
      if (!items[_pkIdx].disabled) break;
    }
    _pkRender();
    const cur = _pkEl.querySelector('.pk-it.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_pkIdx >= 0) _pkChoose(items[_pkIdx]);
    else if (items.filter(x => !x.disabled).length === 1) _pkChoose(items.find(x => !x.disabled));
  }
}
