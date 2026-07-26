// ============================================================
// シフト整合性検証モジュール
//
// DOM に一切触らない純粋関数だけを置く。shift-create.js から
// validateShift() を呼び、返ってきた issues を描画側が使う。
// 「候補を出す（ゴースト提案）」も「違反を検出する」も同じルールを
// 向きを変えて使うだけなので、判定ロジックはすべてここに集約する。
//
// scope:
//   'live'    … 編集中にセル横・タブバッジへ即時表示する
//   'publish' … 公開前チェックにのみ出す（編集中は邪魔しない）
// level:
//   'error'   … 公開前に確認ダイアログを出す
//   'warn'    … 表示のみ。公開は妨げない
// ============================================================

const VRULES = {
  dupSlot:     { label: '同一スロットの重複配置',           level: 'error', scope: 'live',    on: true  },
  crossPw:     { label: '通常PW／限定PWの二重配置',         level: 'error', scope: 'live',    on: true  },
  cartNg:      { label: 'カート不可の人がカート担当',       level: 'error', scope: 'live',    on: true  },
  noPlace:     { label: '場所未設定の列に配置',             level: 'error', scope: 'live',    on: true  },
  consecSlot:  { label: '上下のスロットに連続配置',         level: 'warn',  scope: 'live',    on: true  },
  consecBlock: { label: '前後の時間帯に連続配置',           level: 'warn',  scope: 'live',    on: true  },
  bringFirst:  { label: '持ち込み担当が最初のスロットに配置', level: 'warn', scope: 'live',    on: true  },
  takeLast:    { label: '持ち帰り担当が最後のスロットに配置', level: 'warn', scope: 'live',    on: true  },
  respSlot:    { label: '責任者が開始スロットに未配置',     level: 'warn',  scope: 'live',    on: true  },
  samePlace:   { label: '同一ブロック内で場所が偏っている',  level: 'warn',  scope: 'live',    on: false },
  sisterFixed: { label: '固定枠（一番左）に姉妹が入っている', level: 'warn', scope: 'live',    on: true  },
  respEmpty:   { label: '責任者が未設定',                   level: 'error', scope: 'publish', on: true  },
  cartNumDup:  { label: '同じカート番号の重複割当',         level: 'error', scope: 'publish', on: true  },
  notApplied:  { label: '申込のない人が配置されている',     level: 'warn',  scope: 'publish', on: true  },
  unassigned:  { label: '申込したが一度も配置されていない', level: 'warn',  scope: 'publish', on: true  },
};

// 設定タブからの上書き用（{ ruleId: { on, level } }）。未設定なら VRULES の既定値
let _vCfg = {};
function setValidationConfig(cfg) { _vCfg = cfg || {}; }
function vRule(id) { return Object.assign({}, VRULES[id], _vCfg[id] || {}); }

// 「確認済み」にされた警告。key -> { by, at }
// 意図的な配置だと確認されたものは通常の一覧から外れるが、
// 公開前チェックの「確認済みも表示」で掘り起こして解除できる
let _vAcks = new Map();
function setValidationAcks(list) {
  _vAcks = new Map();
  (list || []).forEach(a => {
    if (typeof a === 'string') _vAcks.set(a, {});
    else if (a && a.key) _vAcks.set(a.key, { by: a.by || '', at: a.at || '' });
  });
}
function vAddAck(key, info) { _vAcks.set(key, info || {}); }
function vRemoveAck(key) { _vAcks.delete(key); }
function vAckInfo(key) { return _vAcks.get(key) || null; }

// ===== 時刻ユーティリティ =====
function vT(hm) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(hm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}
function vRange(tr) {
  const p = String(tr || '').split('~');
  return { s: vT(p[0]), e: vT(p[1]) };
}
function vKey(b) { return b.date + '_' + b.time; }

// ============================================================
// 連続グループの判定
// 同一日付のブロックを開始時刻順に並べ、「前ブロックの終了時刻 ===
// 次ブロックの開始時刻」なら連続とみなす。1スロットでも空けば非連続。
// 先頭＝カート持ち込みあり／末尾＝カート持ち帰りあり／単独＝両方あり。
// ============================================================
function buildBlockGroups(shiftDates) {
  const byDate = {};
  (shiftDates || []).forEach(b => { (byDate[b.date] = byDate[b.date] || []).push(b); });
  const info = {};
  Object.keys(byDate).forEach(date => {
    const list = byDate[date].slice().sort((a, b) => vRange(a.time).s - vRange(b.time).s);
    const groups = [[]];
    list.forEach((b, i) => {
      if (i > 0 && vRange(list[i - 1].time).e !== vRange(b.time).s) groups.push([]);
      groups[groups.length - 1].push(b);
    });
    // 同日内で1つ前／1つ後ろの連続グループ（間が空いていても対象）。
    // カート担当を持ち帰り→持ち込みで同一人物に引き継がせたいときの参照用
    groups.forEach((g, gi) => g.forEach((b, i) => {
      info[vKey(b)] = {
        date, time: b.time, group: g, posInGroup: i,
        isHead: i === 0, isTail: i === g.length - 1,
        prev: i > 0 ? g[i - 1] : null,
        next: i < g.length - 1 ? g[i + 1] : null,
        prevGroupTail: gi > 0 ? groups[gi - 1][groups[gi - 1].length - 1] : null,
        nextGroupHead: gi < groups.length - 1 ? groups[gi + 1][0] : null,
      };
    }));
  });
  return info;
}

// カート担当が必要なブロックか（不要な欄はUI側でグレー化する）
function cartNeeded(gi) {
  if (!gi) return { bring: true, take: true };
  return { bring: gi.isHead, take: gi.isTail };
}

// 責任者が入るスロット番号
//   先頭・中間・単独 → 0番目（最初のスロット）
//   末尾            → 1番目（0番目は持ち帰り担当が使うため）
function respSlotIdx(gi) { return (gi && gi.isTail && !gi.isHead) ? 1 : 0; }
// 持ち込み担当は駐車の時間が要るので0番目には入らない。持ち帰り担当は
// 車を取りに行くため最後のスロットには入らない
const BRING_SLOT_IDX = 1;
const TAKE_SLOT_IDX  = 0;

// ============================================================
// ブロック内の配置の取り出し
// ============================================================
// 検証1回のあいだ blockAssign の結果を使い回す（前後ブロックの参照で何度も呼ばれるため）
function assignOf(ctx, block) {
  if (!block) return {};
  if (!ctx._ac) return blockAssign(block);
  if (!ctx._ac.has(block)) ctx._ac.set(block, blockAssign(block));
  return ctx._ac.get(block);
}

// uid -> [{ri, li, pi}]（同じ人が複数スロットに入るのは通常の運用）
// pi は セル内の並び順。pi===0（一番左）は責任者・カート担当など
// 固定的に同じ場所へ立つ人の位置として運用されている
function blockAssign(block) {
  const map = {};
  (block.slots || []).forEach((slot, ri) => {
    (slot.places || []).forEach((uids, li) => {
      (uids || []).forEach((uid, pi) => { if (uid) (map[uid] = map[uid] || []).push({ ri, li, pi }); });
    });
  });
  return map;
}
function respUids(block) { const r = block.responsible || {}; return [r.r1, r.r2].filter(Boolean); }
function bringUids(block) { const c = block.cart || {}; return [c.ki1, c.ki2].filter(Boolean); }
function takeUids(block)  { const c = block.cart || {}; return [c.ko1, c.ko2].filter(Boolean); }
// uid -> そのブロック内で入っているスロット行番号の昇順配列
// 通常は一つ飛ばし（0,2,4…）で入るので、隣り合う行に入っていたら注意対象になる
function rowsByUid(block) {
  const m = {};
  (block.slots || []).forEach((s, ri) => {
    (s.places || []).forEach(col => (col || []).forEach(u => {
      if (!u) return;
      (m[u] = m[u] || new Set()).add(ri);
    }));
  });
  const out = {};
  Object.keys(m).forEach(u => { out[u] = [...m[u]].sort((a, b) => a - b); });
  return out;
}

// 連続している行の最大の長さと、その並び
function longestRun(rows) {
  let run = 1, best = 1, cur = [rows[0]], bestRows = [rows[0]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] === rows[i - 1] + 1) { run++; cur.push(rows[i]); }
    else { run = 1; cur = [rows[i]]; }
    if (run > best) { best = run; bestRows = cur.slice(); }
  }
  return { len: best, rows: bestRows };
}

// 見守り担当（各セルの1人目かつ watch が立っている人）
function watchUids(block) {
  const s = new Set();
  (block.slots || []).forEach(slot => {
    (slot.watch || []).forEach((on, li) => {
      if (!on) return;
      const uid = ((slot.places || [])[li] || [])[0];
      if (uid) s.add(uid);
    });
  });
  return s;
}

// ============================================================
// 検証本体
// ctx = { applicants, memberFlags, conflictMap, pwType }
// ============================================================
function validateShift(shiftDates, ctx) {
  const groups = buildBlockGroups(shiftDates);
  const nameOf = buildVNameMap(ctx);
  const c = Object.assign({}, ctx, { groups, nameOf, _ac: new Map() });
  let issues = [];
  (shiftDates || []).forEach(block => { issues = issues.concat(validateBlock(block, c)); });
  issues = issues.concat(validateGlobal(shiftDates, c));

  issues.forEach(x => { x.acked = _vAcks.has(x.key); });
  const live  = issues.filter(x => !x.acked);
  const acked = issues.filter(x => x.acked);
  const byBlock = {};
  live.forEach(x => { if (x.blockKey) (byBlock[x.blockKey] = byBlock[x.blockKey] || []).push(x); });
  return { issues: live, acked, byBlock, groups };
}

// ============================================================
// 配置候補の分類（コンボボックスの並び順・除外・注意表示に使う）
//
// base    : その時間帯に申込んでいる人の配列 [{uid, name, ...}]
// current : いまその欄に入っている uid（自分自身は重複扱いにしない）
// ctx     : { groups, shiftDates, memberFlags, conflictMap, assignCounts }
//
// state:
//   'ok'      … 通常の候補
//   'consec'  … 前後のブロックにも入っている（責任者・見守りは免除）
//   'crosspw' … 同日に他のPWで配置済み
//   'blocked' … 同一スロット行に既にいる（物理的に不可能なので選ばせない）
// ============================================================
const VSTATE_ORDER = { ok: 0, consec: 1, crosspw: 2, move: 3, blocked: 4 };
const VSTATE_GROUP = {
  ok:      '候補',
  consec:  '連続配置になります ⚠',
  crosspw: '他のPWに配置済み ⚠',
  move:    '別の場所から移動（入れ替え）',
  blocked: 'この時間に配置済み（選択不可）',
};

function buildCandidates(base, block, ri, li, ctx, current, pi) {
  const groups = ctx.groups || buildBlockGroups(ctx.shiftDates || [block]);
  const gi = groups[vKey(block)];
  const slot = (block.slots || [])[ri] || {};
  const flags = ctx.memberFlags || {};
  const counts = ctx.assignCounts || {};

  // 同一スロット行にいる人を数える。自分自身の1件分は差し引く
  // あわせて「その行のどこにいるか」を控えておく（移動・入れ替えに使う）
  const rowCount = {}, rowPos = {};
  (slot.places || []).forEach((uids, ci) => {
    (uids || []).forEach((u, pi) => {
      if (!u) return;
      rowCount[u] = (rowCount[u] || 0) + 1;
      if (rowPos[u] === undefined) rowPos[u] = { li: ci, pi };
    });
  });
  if (current) rowCount[current] = (rowCount[current] || 0) - 1;

  // 連続判定。責任者・見守りは連続が正常な運用なので免除する
  // ①上下のスロット行（通常は一つ飛ばしで入るので隣接は注意）
  const rows = rowsByUid(block);
  const inAdjacentRow = uid => {
    const rs = rows[uid];
    return !!rs && (rs.includes(ri - 1) || rs.includes(ri + 1));
  };
  // ②前後の時間帯（別ブロック）
  const inNeighborBlock = uid => {
    const check = b => {
      if (!b) return false;
      if (!assignOf(ctx, b)[uid]) return false;
      if (respUids(b).includes(uid) || watchUids(b).has(uid)) return false;
      return true;
    };
    return check(gi && gi.prev) || check(gi && gi.next);
  };
  const exemptHere = new Set(respUids(block).concat([...watchUids(block)]));

  const out = (base || []).map(a => {
    const uid = a.uid;
    let state = 'ok', reason = '', at = null;
    if ((rowCount[uid] || 0) > 0) {
      // 同じ時間に既にいる人。重複はできないが、ここへ「移動」することはできる
      at = rowPos[uid] || null;
      state = (at && at.li !== li) ? 'move' : 'blocked';
      reason = state === 'move'
        ? `${(block.usedPlaces || [])[at.li] || '別の場所'} から移動`
        : '同じ時間に配置済み';
    } else {
      const ci = (ctx.conflictMap || {})[uid];
      const pw = ci ? ((ci.slotDates || {})[block.date] || []) : [];
      if (pw.length) { state = 'crosspw'; reason = pw.join('・') + 'に配置済み'; }
      else if (!exemptHere.has(uid) && inAdjacentRow(uid)) { state = 'consec'; reason = '上下のスロットに配置'; }
      else if (!exemptHere.has(uid) && inNeighborBlock(uid)) { state = 'consec'; reason = '前後の時間帯にも配置'; }
    }
    const w = wishOf(ctx, uid, block.date, block.time);
    return {
      uid, name: a.name, state, reason, at,
      furigana: (flags[uid] || {}).furigana || '',
      gender:   (flags[uid] || {}).gender   || '',
      respFlag: !!a.respFlag, cartFlag: !!a.cartFlag,
      count:    counts[uid] || 0,
      cartNg:   !!(w && w.cartNg),
      note:     (w && w.note) || '',
      group:    VSTATE_GROUP[state],
      fixedNg:  pi === 0 && (flags[uid] || {}).gender && (flags[uid] || {}).gender !== 'M',
    };
  });

  // 未配置の人・割当が少ない人を上に出して、偏りを自然に是正できるようにする。
  // 一番左（固定枠）の欄では兄弟を先に並べる
  const fixedSlot = pi === 0;
  out.sort((a, b) => {
    if (VSTATE_ORDER[a.state] !== VSTATE_ORDER[b.state]) return VSTATE_ORDER[a.state] - VSTATE_ORDER[b.state];
    if (fixedSlot) {
      const ma = a.gender === 'M' ? 0 : 1, mb = b.gender === 'M' ? 0 : 1;
      if (ma !== mb) return ma - mb;
    }
    if (a.count !== b.count) return a.count - b.count;
    if (a.furigana !== b.furigana) return a.furigana < b.furigana ? -1 : 1;
    return (a.name || '') < (b.name || '') ? -1 : 1;
  });
  return out;
}

// 責任者・カート担当のゴースト提案
// 「先にスロット表へ入れる → その中から役割の候補を出す」という運用に合わせ、
// 該当スロットに入っている人だけを候補にする。月内回数の少ない順。
function suggestRole(block, role, ctx) {
  const gi = (ctx.groups || {})[vKey(block)];
  const need = cartNeeded(gi);
  if (role === 'bring' && !need.bring) return [];
  if (role === 'take'  && !need.take)  return [];
  const slots = block.slots || [];
  if (!slots.length) return [];
  // 単独（非連続）ブロックでは持ち帰り担当は責任者が兼任する
  if (role === 'take' && gi && gi.isHead && gi.isTail) {
    const r1 = (block.responsible || {}).r1;
    if (r1) return [{ uid: r1, name: ((ctx.memberFlags || {})[r1] || {}).name || r1, count: 0, reason: '責任者との兼任' }];
  }
  const ri = role === 'resp' ? Math.min(respSlotIdx(gi), slots.length - 1)
           : role === 'bring' ? Math.min(BRING_SLOT_IDX, slots.length - 1)
           : Math.min(TAKE_SLOT_IDX, slots.length - 1);
  const uids = [];
  ((slots[ri] || {}).places || []).forEach(col => (col || []).forEach(u => { if (u && !uids.includes(u)) uids.push(u); }));

  const flags = ctx.memberFlags || {};
  const taken = new Set(respUids(block).concat(bringUids(block), takeUids(block)));
  const counts = role === 'resp' ? (ctx.respCounts || {}) : (ctx.cartCounts || {});

  // カート担当は、同日の前後にある別の連続グループで持ち帰り／持ち込みをした人と
  // 同一人物なら、既に車でカートを運んでいるため引き継ぎの手間がなく最優先にする
  const handover = new Set();
  if (role === 'bring' && gi && gi.prevGroupTail) {
    const c = gi.prevGroupTail.cart || {};
    [c.ko1, c.ko2].filter(Boolean).forEach(u => handover.add(u));
  } else if (role === 'take' && gi && gi.nextGroupHead) {
    const c = gi.nextGroupHead.cart || {};
    [c.ki1, c.ki2].filter(Boolean).forEach(u => handover.add(u));
  }

  return uids
    .filter(uid => {
      const f = flags[uid] || {};
      if (role === 'resp' && !f.respFlag) return false;
      if (role !== 'resp' && !f.cartFlag) return false;
      if (taken.has(uid)) return false;                          // 既に別の役に就いている
      if (role !== 'resp') {                                     // カート不可の人は出さない
        const w = wishOf(ctx, uid, block.date, block.time);
        if (w && w.cartNg) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ha = handover.has(a) ? 0 : 1, hb = handover.has(b) ? 0 : 1;
      if (ha !== hb) return ha - hb;
      return (counts[a] || 0) - (counts[b] || 0);
    })
    .map(uid => ({
      uid, name: (flags[uid] || {}).name || uid, count: counts[uid] || 0,
      reason: handover.has(uid) ? '前後グループの担当と同一人物' : undefined,
    }));
}

// 候補リスト表示用：他PWでの状況を短いラベルにする
// 「申込」は同日に複数PWへ出すこと自体が正常なので注意喚起のみ。
// 「配置済み」は同日1つまでなので警告として出す
function conflictLabel(conflictMap, uid, date) {
  const ci = (conflictMap || {})[uid];
  if (!ci || !date) return '';
  const s = (ci.slotDates  || {})[date] || [];
  const a = (ci.applyDates || {})[date] || [];
  if (s.length) return ` [⚠${s.join('・')}に配置済]`;
  if (a.length) return ` [${a.join('・')}に申込]`;
  return '';
}

function buildVNameMap(ctx) {
  const m = {};
  Object.entries(ctx.memberFlags || {}).forEach(([uid, f]) => { m[uid] = f.name; });
  (ctx.applicants || []).forEach(a => { m[a.uid] = a.name; });
  return uid => m[uid] || uid;
}

// 指定日時のその人の希望（カート不可・コメント）を引く
function wishOf(ctx, uid, date, time) {
  const a = (ctx.applicants || []).find(x => x.uid === uid);
  if (!a) return null;
  const startT = String(time || '').split('~')[0];
  return (a.appliedSlots || []).find(s => {
    // 日付部分の切り出しは shift-create.js の filterAppliedForSlot と同じ規則
    // （"7/5(土) 16:30~17:30" → "7/5"）。前方一致にすると 7/1 が 7/15 に当たる
    const sk = typeof s === 'object' ? s.slot : s;
    const dp = sk.indexOf('/'), pp = sk.indexOf('(');
    const dn = dp >= 0 ? sk.slice(0, pp >= 0 ? pp : sk.indexOf(' ')) : sk;
    if (dn !== date) return false;
    return sk.includes(') ' + startT) || sk.includes(' ' + startT);
  }) || null;
}

function mkIssue(rule, block, o) {
  const r = vRule(rule);
  const uids = (o.uids || []).slice().sort();
  return {
    rule, level: o.level || r.level, scope: r.scope, label: r.label,
    msg: o.msg, date: block.date, time: block.time, blockKey: vKey(block),
    ri: o.ri === undefined ? null : o.ri, li: o.li === undefined ? null : o.li,
    uids,
    // 「確認済み」の同一性キー。関係者や位置が変われば別の警告として再度出る
    key: [vKey(block), rule, uids.join(','), o.ri === undefined ? '' : o.ri, o.li === undefined ? '' : o.li].join('|'),
  };
}

function validateBlock(block, ctx) {
  const out = [];
  const gi = ctx.groups[vKey(block)];
  const nm = ctx.nameOf;
  const assign = assignOf(ctx, block);
  const slots = block.slots || [];
  const cols = block.usedPlaces || [];
  const resp = respUids(block);
  const push = (rule, o) => { if (vRule(rule).on) out.push(mkIssue(rule, block, o)); };

  // --- 同一スロット行の重複（別の場所列も含む。物理的に不可能） ---
  slots.forEach((slot, ri) => {
    const seen = {};
    (slot.places || []).forEach((uids, li) => {
      (uids || []).forEach(uid => { if (uid) (seen[uid] = seen[uid] || []).push(li); });
    });
    Object.entries(seen).forEach(([uid, lis]) => {
      if (lis.length < 2) return;
      const where = lis.map(li => cols[li] || '（場所未設定）').join('・');
      push('dupSlot', { uids: [uid], ri, li: lis[0],
        msg: `${nm(uid)} が ${slot.time} に重複して配置されています（${where}）` });
    });
  });

  // --- 他のPWタイプとの同日二重配置（責任者・カート担当も対象） ---
  const involved = new Set(Object.keys(assign));
  resp.concat(bringUids(block), takeUids(block)).forEach(uid => involved.add(uid));
  involved.forEach(uid => {
    const ci = (ctx.conflictMap || {})[uid];
    const names = ci ? ((ci.slotDates || {})[block.date] || []) : [];
    if (!names.length) return;
    const at = (assign[uid] || [])[0] || {};
    push('crossPw', { uids: [uid], ri: at.ri, li: at.li,
      msg: `${nm(uid)} は同日の ${names.join('・')} にも配置されています（同日は1つのPWのみ）` });
  });

  // --- カート不可の人がカート担当 ---
  bringUids(block).concat(takeUids(block)).forEach(uid => {
    const w = wishOf(ctx, uid, block.date, block.time);
    if (w && w.cartNg) push('cartNg', { uids: [uid], msg: `${nm(uid)} は「カート不可」で希望を出しています` });
  });

  // --- 場所未設定の列に人が入っている ---
  cols.forEach((loc, li) => {
    if (loc) return;
    const has = slots.some(s => (((s.places || [])[li]) || []).some(Boolean));
    if (has) push('noPlace', { li, msg: `${li + 1}列目の場所が未設定のまま奉仕者が配置されています` });
  });

  // --- 上下のスロットに連続配置（責任者・見守りは免除） ---
  // 通常は一つ飛ばしで入る運用なので、隣り合う行に入っていたら知らせる
  const exemptSlot = new Set(resp.concat([...watchUids(block)]));
  const rows = rowsByUid(block);
  Object.keys(rows).forEach(uid => {
    if (exemptSlot.has(uid)) return;
    const r = longestRun(rows[uid]);
    if (r.len < 2) return;
    const times = r.rows.map(i => (slots[i] || {}).time).filter(Boolean);
    push('consecSlot', { uids: [uid], level: r.len >= 3 ? 'error' : 'warn', ri: r.rows[0],
      msg: `${nm(uid)} が ${r.len} スロット連続で配置されています（${times.join(' → ')}）` });
  });

  // --- 前後ブロックの連続配置（責任者・見守りは免除） ---
  if (gi) {
    const exempt = new Set(resp.concat([...watchUids(block)]));
    Object.keys(assign).forEach(uid => {
      if (exempt.has(uid)) return;
      const inBlock = b => !!b && !!assignOf(ctx, b)[uid];
      // 連続の末尾でのみ報告する（同じ連続を2回出さないため）
      if (!inBlock(gi.prev)) return;
      if (inBlock(gi.next)) return;
      // 免除対象の人が混ざるブロックがあれば、そこで連続は途切れたものとして扱う
      let run = 1, times = [block.time];
      for (let p = gi.prev; p; p = (ctx.groups[vKey(p)] || {}).prev) {
        if (!inBlock(p)) break;
        const pr = respUids(p), pw = watchUids(p);
        if (pr.includes(uid) || pw.has(uid)) break;
        run++; times.unshift(p.time);
      }
      if (run < 2) return;
      push('consecBlock', { uids: [uid], level: run >= 3 ? 'error' : 'warn',
        msg: `${nm(uid)} が ${run} コマ連続で配置されています（${times.join(' / ')}）` });
    });
  }

  // --- カート担当・責任者のスロット位置 ---
  const need = cartNeeded(gi);
  const lastRi = slots.length - 1;
  if (need.bring) {
    bringUids(block).forEach(uid => {
      if ((assign[uid] || []).some(x => x.ri === 0)) {
        push('bringFirst', { uids: [uid], ri: 0,
          msg: `持ち込み担当の ${nm(uid)} が最初のスロットに配置されています（駐車の時間が取れません）` });
      }
    });
  }
  if (need.take && lastRi >= 0) {
    takeUids(block).forEach(uid => {
      if ((assign[uid] || []).some(x => x.ri === lastRi)) {
        push('takeLast', { uids: [uid], ri: lastRi,
          msg: `持ち帰り担当の ${nm(uid)} が最後のスロットに配置されています（車を取りに行けません）` });
      }
    });
  }
  if (resp.length > 0 && slots.length > 0) {
    const ri = Math.min(respSlotIdx(gi), lastRi);
    const ok = resp.some(uid => (assign[uid] || []).some(x => x.ri === ri));
    if (!ok) {
      push('respSlot', { uids: resp, ri,
        msg: `責任者が ${slots[ri].time} に配置されていません` });
    }
  }

  // --- 同一ブロック内の場所の偏り（既定OFF） ---
  // 同じ場所に留まるのが前提の人は対象外にする：
  //   ・セルの一番左（pi===0）に入っている人＝固定枠。責任者・カート担当は
  //     役職の登録有無にかかわらずここに入る運用なので、位置で判定する
  //   ・責任者・カート担当として登録されている人
  // 列数より入るスロット数が多い場合は同じ場所の重複が避けられないため許容する
  const fixedUids = new Set(resp.concat(bringUids(block), takeUids(block)));
  const colCount = cols.length;
  Object.entries(assign).forEach(([uid, pos]) => {
    if (fixedUids.has(uid)) return;
    if (pos.some(x => x.pi === 0)) return;
    const distinct = new Set(pos.map(x => x.li)).size;
    const ideal = Math.min(pos.length, colCount);
    if (distinct < ideal) {
      push('samePlace', { uids: [uid], ri: pos[0].ri, li: pos[0].li,
        msg: `${nm(uid)} が ${pos.length} スロット入っていますが場所が ${distinct} か所です（${ideal} か所に分散できます）` });
    }
  });

  // --- 固定枠（各セルの一番左）は兄弟が入る運用 ---
  // 見守り担当の保存先でもあり、責任者・カート担当もここに入る位置なので、
  // 姉妹が入っている場合は知らせる（例外はありうるので警告にとどめる）
  slots.forEach((slot, ri) => {
    (slot.places || []).forEach((uids, li) => {
      const uid = (uids || [])[0];
      if (!uid) return;
      const g = ((ctx.memberFlags || {})[uid] || {}).gender || '';
      if (g && g !== 'M') {
        push('sisterFixed', { uids: [uid], ri, li,
          msg: `${nm(uid)} が固定枠（一番左）に入っています（${slot.time}／通常は兄弟）` });
      }
    });
  });

  // --- 公開前チェック：責任者未設定 ---
  if (Object.keys(assign).length > 0 && resp.length === 0) {
    push('respEmpty', { msg: '責任者が設定されていません' });
  }

  // --- 公開前チェック：同じカート番号の重複 ---
  const c = block.cart || {};
  [['持ち込み', [c.kc1, c.kc2]], ['持ち帰り', [c.oc1, c.oc2]]].forEach(([lbl, vals]) => {
    const seen = {};
    vals.filter(Boolean).forEach(v => {
      String(v).split(',').map(x => x.trim()).filter(Boolean).forEach(n => { seen[n] = (seen[n] || 0) + 1; });
    });
    const dup = Object.keys(seen).filter(n => seen[n] > 1);
    if (dup.length) push('cartNumDup', { msg: `${lbl}のカート番号 ${dup.join('・')} が重複しています` });
  });

  // --- 公開前チェック：申込のない人の配置 ---
  Object.keys(assign).forEach(uid => {
    if (!wishOf(ctx, uid, block.date, block.time)) {
      push('notApplied', { uids: [uid], ri: assign[uid][0].ri, li: assign[uid][0].li,
        msg: `${nm(uid)} はこの時間帯に申込がありません` });
    }
  });

  return out;
}

// ブロックをまたぐ検証
function validateGlobal(shiftDates, ctx) {
  const out = [];
  if (!vRule('unassigned').on) return out;
  const assigned = new Set();
  (shiftDates || []).forEach(b => {
    Object.keys(blockAssign(b)).forEach(uid => assigned.add(uid));
    respUids(b).concat(bringUids(b), takeUids(b)).forEach(uid => assigned.add(uid));
  });
  (ctx.applicants || []).forEach(a => {
    if (assigned.has(a.uid)) return;
    const r = vRule('unassigned');
    out.push({
      rule: 'unassigned', level: r.level, scope: r.scope, label: r.label,
      msg: `${a.name} は ${a.appliedCount} 件申込していますが、一度も配置されていません`,
      date: '', time: '', blockKey: '', ri: null, li: null, uids: [a.uid],
      key: ['*', 'unassigned', a.uid, '', ''].join('|'),
    });
  });
  return out;
}
