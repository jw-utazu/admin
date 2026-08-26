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
//   opts.items    [{ value, label, labelClass, badges, sub, disabled, group, selected }]
//   opts.value    単一選択時の現在値／複数選択時は配列
//   opts.onPick   (value, item) => void  単一選択で確定したとき
//   opts.onToggle (values[]) => void 複数選択で変わったとき（都度呼ぶ）
//   opts.onClose  () => void
//
// ファイル後半に、<select> を置き換えるための uiSelect 系がある。
//
// このファイルを変更したら shift-create.html と index.html の ?v= を +1 すること
// ============================================================

let _pkEl = null;      // ポップオーバー本体
let _pkOpts = null;
let _pkAnchor = null;
let _pkValues = [];    // multi のときの選択値
let _pkIdx = -1;       // キーボード操作中の候補位置

function _pkSetVisible(el, on) {
  if (el) el.classList.toggle('is-hidden', !on);
}

function _pkBuild() {
  if (_pkEl) return _pkEl;
  const d = document.createElement('div');
  d.className = 'pk';
  d.innerHTML = '<div class="pk-hd"><span class="pk-title"></span><button class="pk-x" type="button">' + ic('x') + '</button></div>'
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
  _pkSetVisible(note, !!_pkOpts.note);
  const s = el.querySelector('.pk-search');
  _pkSetVisible(s, !!_pkOpts.search);
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
  return items.filter(it => String(it.search || it.label || '').toLowerCase().includes(q));
}

function _pkRender() {
  const list = _pkEl.querySelector('.pk-list');
  const items = _pkFiltered();
  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pk-empty';
    empty.textContent = '該当する候補がありません';
    list.appendChild(empty);
    return;
  }
  let lastGroup = null;
  items.forEach((it, i) => {
    if (it.group && it.group !== lastGroup) {
      const group = document.createElement('div');
      group.className = 'pk-grp';
      group.textContent = String(it.group);
      list.appendChild(group);
      lastGroup = it.group;
    }
    const on = _pkOpts.multi ? _pkValues.includes(it.value) : (it.value === _pkOpts.value);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pk-it' + (on ? ' on' : '') + (it.disabled ? ' dis' : '') + (i === _pkIdx ? ' cur' : '');
    button.dataset.i = String(i);
    button.disabled = !!it.disabled;
    if (_pkOpts.multi) {
      const check = document.createElement('span');
      check.className = 'pk-cb';
      check.innerHTML = on ? ic('square-check', { color: '#15803D' }) : ic('square', { color: '#A1A1AA' });
      button.appendChild(check);
    }
    const body = document.createElement('span');
    body.className = 'pk-body';
    const label = document.createElement('span');
    label.className = it.labelClass || '';
    label.textContent = String(it.label == null ? '' : it.label);
    body.appendChild(label);
    // バッジもHTML文字列にせずDOM化する。氏名・備考などが
    // 呼び出し側から渡っても、実行可能なマークアップにはならない。
    (it.badges || []).forEach(badgeSpec => {
      const badge = document.createElement('span');
      badge.className = badgeSpec.className || 'pk-b';
      badge.textContent = String(badgeSpec.text == null ? '' : badgeSpec.text);
      if (badgeSpec.title) badge.title = String(badgeSpec.title);
      body.appendChild(badge);
    });
    button.appendChild(body);
    if (it.sub) {
      const sub = document.createElement('span');
      sub.className = 'pk-sub';
      sub.textContent = String(it.sub);
      button.appendChild(sub);
    }
    button.addEventListener('click', () => _pkChoose(items[i]));
    list.appendChild(button);
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

// ============================================================
// 年月ピッカー
//
// openMonthPicker(anchorEl, { title, year, month, note, onPick(y, m) })
//
// 年は ‹ › で送り、月は12マスから選ぶ。年と月の <select> を2つ並べる形と
// 違って「今どの年を見ているか」と「近い月」が同時に見えるので、
// ‹ › の送りでは遠い月へ行きにくい、という不満に応えられる。
// ポップオーバーの位置決め・外側タップで閉じる処理は上のものを使い回す
// ============================================================

let _pkYmY = 0;   // 今めくっている年

function openMonthPicker(anchorEl, opts) {
  const el = _pkBuild();
  _pkOpts = opts || {};
  _pkAnchor = anchorEl;
  _pkYmY = _pkOpts.year;
  el.querySelector('.pk-title').textContent = _pkOpts.title || '対象年月';
  const note = el.querySelector('.pk-note');
  note.textContent = _pkOpts.note || '';
  _pkSetVisible(note, !!_pkOpts.note);
  _pkSetVisible(el.querySelector('.pk-search'), false);
  el.classList.add('on');
  _pkRenderYm();
  _pkPosition(anchorEl);
}

function _pkRenderYm() {
  const o = _pkOpts, list = _pkEl.querySelector('.pk-list');
  const now = new Date(), ty = now.getFullYear(), tm = now.getMonth() + 1;
  let cells = '';
  for (let m = 1; m <= 12; m++) {
    const on    = _pkYmY === o.year && m === o.month;  // 今の対象月
    const today = _pkYmY === ty && m === tm;           // 実際の今月
    cells += '<button type="button" class="pk-ym-m' + (on ? ' on' : '') + (today ? ' today' : '')
           + '" data-m="' + m + '">' + m + '月</button>';
  }
  list.innerHTML =
      '<div class="pk-ym-hd"><button type="button" class="pk-ym-nav" data-y="-1">&#8249;</button>'
    + '<span class="pk-ym-y">' + _pkYmY + '年</span>'
    + '<button type="button" class="pk-ym-nav" data-y="1">&#8250;</button></div>'
    + '<div class="pk-ym-grid">' + cells + '</div>'
    + '<button type="button" class="pk-ym-now">' + ty + '年' + tm + '月（今月）へ</button>';
  list.querySelectorAll('.pk-ym-nav').forEach(b =>
    b.addEventListener('click', () => { _pkYmY += parseInt(b.dataset.y); _pkRenderYm(); }));
  list.querySelectorAll('.pk-ym-m').forEach(b =>
    b.addEventListener('click', () => _pkPickYm(_pkYmY, parseInt(b.dataset.m))));
  list.querySelector('.pk-ym-now').addEventListener('click', () => _pkPickYm(ty, tm));
}

function _pkPickYm(y, m) {
  const cb = _pkOpts.onPick;   // closePicker が _pkOpts を捨てるので先に取る
  closePicker();
  if (cb) cb(y, m);
}

// ============================================================
// uiSelect — <select> の置き換え
//
// ボタンを1つ描き、押すと上のピッカーが開く。候補と確定処理は key で
// 登録しておき、DOM には現在値だけ持たせる（41人ぶんの候補を DOM に
// 埋め込まない）。HTML を文字列で組み立てている箇所からそのまま使える。
//
//   html += uiSelHtml('proxy-from', {
//     title: '送信元', placeholder: '-- 選択 --',
//     items: members.map(m => ({ value: m.id, label: m.name, search: m.kana })),
//     value: '',
//     onPick: v => { ... },          // <select> の onchange にあたる
//   });
//
//   uiSelVal(key)                 現在値
//   uiSelSet(key, v)              値だけ差し替える（onPick は呼ばれない）
//   uiSelReload(key, items, v)    候補ごと入れ替える（連動する2段目など）
//
// 値の置き場は DOM（data-val）。同じ HTML を作り直しても値が正しく
// 戻るようにするため、登録側（_uiSel）には候補と処理だけを置く
// ============================================================

const _uiSel = {};

function _uiEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function _uiSelHit(key, v) {
  return ((_uiSel[key] || {}).items || []).find(it => String(it.value) === String(v));
}

function _uiSelEl(key) {
  const wanted = String(key);
  return Array.from(document.querySelectorAll('[data-uisel]'))
    .find(el => el.dataset.uisel === wanted) || null;
}

function uiSelHtml(key, spec) {
  _uiSel[key] = spec = spec || {};
  const v = spec.value == null ? '' : String(spec.value);
  const hit = _uiSelHit(key, v);
  return '<button type="button" class="uisel' + (hit ? '' : ' empty') + (spec.cls ? ' ' + spec.cls : '') + '"'
       + ' data-uisel="' + _uiEsc(key) + '" data-val="' + _uiEsc(v) + '"'
       + (spec.style ? ' style="' + _uiEsc(spec.style) + '"' : '')
       + (spec.disabled ? ' disabled' : '')
       + '><span class="uisel-t">' + _uiEsc(hit ? (hit.label || hit.value) : (spec.placeholder || '選択')) + '</span>'
       + '<span class="uisel-c">▾</span></button>';
}

function _uiSelApply(el, key, v) {
  const val = v == null ? '' : String(v);
  const hit = _uiSelHit(key, val);
  el.dataset.val = val;
  el.querySelector('.uisel-t').textContent = hit ? (hit.label || hit.value) : ((_uiSel[key] || {}).placeholder || '選択');
  el.classList.toggle('empty', !hit);
}

function uiSelVal(key) { const el = _uiSelEl(key); return el ? el.dataset.val : ''; }

function uiSelSet(key, v) { const el = _uiSelEl(key); if (el) _uiSelApply(el, key, v); }

function uiSelReload(key, items, v) {
  const sp = _uiSel[key];
  if (!sp) return;
  sp.items = items || [];
  const el = _uiSelEl(key);
  if (el) _uiSelApply(el, key, v === undefined ? el.dataset.val : v);
}

// 候補が多いときだけ検索欄を出す（spec.search で明示もできる）
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('[data-uisel]');
  if (!btn || btn.disabled) return;
  const key = btn.dataset.uisel;
  const sp = _uiSel[key];
  if (!sp) return;
  const items = sp.items || [];
  openPicker(btn, {
    title: sp.title || '',
    note: sp.note || '',
    search: sp.search === undefined ? items.length > 12 : sp.search,
    value: btn.dataset.val,
    items,
    onPick: (v, it) => { _uiSelApply(btn, key, v); if (sp.onPick) sp.onPick(v, it); },
  });
});
