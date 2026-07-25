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
  consecBlock: { label: '前後ブロックの連続配置',           level: 'warn',  scope: 'live',    on: true  },
  bringFirst:  { label: '持ち込み担当が最初のスロットに配置', level: 'warn', scope: 'live',    on: true  },
  takeLast:    { label: '持ち帰り担当が最後のスロットに配置', level: 'warn', scope: 'live',    on: true  },
  respSlot:    { label: '責任者が開始スロットに未配置',     level: 'warn',  scope: 'live',    on: true  },
  samePlace:   { label: '同一ブロック内で場所が偏っている',  level: 'warn',  scope: 'live',    on: false },
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
    groups.forEach(g => g.forEach((b, i) => {
      info[vKey(b)] = {
        date, time: b.time, group: g, posInGroup: i,
        isHead: i === 0, isTail: i === g.length - 1,
        prev: i > 0 ? g[i - 1] : null,
        next: i < g.length - 1 ? g[i + 1] : null,
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

// uid -> [{ri, li}]（同じ人が複数スロットに入るのは通常の運用）
function blockAssign(block) {
  const map = {};
  (block.slots || []).forEach((slot, ri) => {
    (slot.places || []).forEach((uids, li) => {
      (uids || []).forEach(uid => { if (uid) (map[uid] = map[uid] || []).push({ ri, li }); });
    });
  });
  return map;
}
function respUids(block) { const r = block.responsible || {}; return [r.r1, r.r2].filter(Boolean); }
function bringUids(block) { const c = block.cart || {}; return [c.ki1, c.ki2].filter(Boolean); }
function takeUids(block)  { const c = block.cart || {}; return [c.ko1, c.ko2].filter(Boolean); }
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
  // 責任者は同じ場所に留まる運用なので除外する。列数より入るスロット数が
  // 多い場合は同じ場所の重複が避けられないため、その分は許容する
  const colCount = cols.length;
  Object.entries(assign).forEach(([uid, pos]) => {
    if (resp.includes(uid)) return;
    const distinct = new Set(pos.map(x => x.li)).size;
    const ideal = Math.min(pos.length, colCount);
    if (distinct < ideal) {
      push('samePlace', { uids: [uid], ri: pos[0].ri, li: pos[0].li,
        msg: `${nm(uid)} が ${pos.length} スロット入っていますが場所が ${distinct} か所です（${ideal} か所に分散できます）` });
    }
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
