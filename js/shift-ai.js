// ============================================================
// シフト原案生成（AI原案）— 事前計算・生成ループ・差分反映
//
// PW_GWS/shift_real.mjs（試作。実データで error 0 / 選好98点）から移植。
// 氏名は一切送らない — プロンプトへ渡すのは uid だけ（計画書
// 「2026-08-26_シフト原案生成の本実装.md」1節）。
//
// このファイルは shift-create.js のグローバル状態（shiftDates / applicants /
// memberFlags / locations / curYM / currentPwType）を読む前提で書かれている。
// このファイルを変更したら shift-create.html の ?v= を +1 すること
// ============================================================

const SC_AI_RULE_DEFAULTS = {
  cellTarget: 3, cellMin: 2, cartsPerPlace: 2,
  usePrevMonth: true, prevMonths: 2,
  dropWifeWithHusband: true, allowCartDoubleDuty: false,
  allowMixedCartPair: false, avoidRespCartOverlap: false,
};

// ---- 時刻ユーティリティ（shift_real.mjs 32-43, 181-183 相当）----
function scAiSplitTime(tr, intv) {
  const mt = String(tr || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)[~〜]([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!mt) return [];
  const iv = Number(intv) || 15;
  const s = +mt[1] * 60 + +mt[2], e = +mt[3] * 60 + +mt[4];
  const out = [];
  for (let t = s; t < e && out.length < 96; t += iv) {
    const f = m => Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
    out.push(f(t) + '~' + f(t + iv));
  }
  return out;
}
function scAiSlotRange(t) {
  const m = /^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$/.exec(t) || [];
  return { s: +m[1] * 60 + +m[2], e: +m[3] * 60 + +m[4] };
}
function scAiFmtHM(v) {
  return (v === Infinity || v === -Infinity || v == null || isNaN(v)) ? '' : Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0');
}

// 周期の自動計算（shift_real.mjs 152-156）
function scAiAutoCycle(n) {
  const t = n / 3, ds = [];
  for (let d = 1; d <= n; d++) if (n % d === 0) ds.push(d);
  return ds.reduce((a, c) => Math.abs(c - t) < Math.abs(a - t) ? c : a);
}

// 備考の緩いパーサ（shift_real.mjs 168-180）
function scAiNoteWindow(raw) {
  const s = String(raw || '').trim().replace(/[〜～]/g, '~').replace(/\s+/g, '');
  if (!s) return null;
  const hm = x => { const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(x); return m ? (+m[1]) * 60 + (+(m[2] || 0)) : NaN; };
  let m;
  if ((m = /^(\d{1,2}(?::\d{2})?)時?~(\d{1,2}(?::\d{2})?)時?(のみ参加|のみ|可)?$/.exec(s))
    && !isNaN(hm(m[1])) && !isNaN(hm(m[2]))) return { s: hm(m[1]), e: hm(m[2]) };
  if ((m = /^(\d{1,2}(?::\d{2})?)時?(から参加|から|~|以降)(参加|可)?$/.exec(s))
    && !isNaN(hm(m[1]))) return { s: hm(m[1]), e: Infinity };
  if (/^~|まで|以前/.test(s) && (m = /^~?(\d{1,2}(?::\d{2})?)時?(まで参加|まで|以前)?$/.exec(s))
    && !isNaN(hm(m[1]))) return { s: -Infinity, e: hm(m[1]) };
  return null;
}
// 周内位置 p が3周すべてで参加できる位置か（shift_real.mjs 186-198）
function scAiOkPositions(b, win) {
  if (!win) return [...Array(b.cyc).keys()];
  const out = [];
  for (let p = 0; p < b.cyc; p++) {
    let all = true;
    for (let r = 0; r < b.reps; r++) {
      const t = scAiSlotRange(b.slotTimes[r * b.cyc + p]);
      if (t.s < win.s || t.e > win.e) { all = false; break; }
    }
    if (all) out.push(p);
  }
  return out;
}
// 3周そろう位置が無い人が入れる (周,位置) の一覧（shift_real.mjs 200-207）
function scAiOkRepPositions(b, win) {
  const out = [];
  for (let r = 0; r < b.reps; r++) for (let p = 0; p < b.cyc; p++) {
    const t = scAiSlotRange(b.slotTimes[r * b.cyc + p]);
    if (t.s >= win.s && t.e <= win.e) out.push({ rep: r, pos: p });
  }
  return out;
}

// ---- ルール解決（全体 → PW → 年月 → ブロック。狭いほうが勝つ）----
function scAiResolveRules(rules, ym, blockKey) {
  const r = rules || {};
  const g = r.global || {}, pw = r.pw || {}, mo = (r.month || {})[ym] || {}, bl = blockKey ? ((r.block || {})[blockKey] || {}) : {};
  return Object.assign({}, SC_AI_RULE_DEFAULTS, g, pw, mo, bl);
}

// ---- ブロック構築（shift_real.mjs 66-162 相当）----
// shiftDates（既存のシフト作成画面のブロック配列）を、原案生成用の構造に組み直す。
// カレンダー・場所は改めて取得せず、shift-create.js が既に読み込んだ状態を使う。
function scAiBuildBlocks(shiftDates, rules, ym) {
  const DAYW = ['日', '月', '火', '水', '木', '金', '土'];
  const blocks = (shiftDates || []).map(d => {
    const label = d.date + '(' + d.weekday + ') ' + d.time;
    const places = (d.usedPlaces && d.usedPlaces.length ? d.usedPlaces : (d.place ? [d.place.p1, d.place.p2].filter(Boolean) : [])).filter(Boolean);
    return { dateKey: d.date, time: d.time, label, weekday: d.weekday,
      slotTimes: scAiSplitTime(d.time, d.interval), places: places.length ? places : [''] };
  });

  // 同じ日で連続するブロックをグループ化（shift_real.mjs 79-103）
  const rng = t => { const m = /^(\d{1,2}):(\d{2})[~〜](\d{1,2}):(\d{2})$/.exec(t) || []; return { s: +m[1] * 60 + +m[2], e: +m[3] * 60 + +m[4] }; };
  const byDate = {};
  blocks.forEach(b => (byDate[b.dateKey] = byDate[b.dateKey] || []).push(b));
  Object.values(byDate).forEach(list => {
    list.sort((a, b) => rng(a.time).s - rng(b.time).s);
    const groups = [[]];
    list.forEach((b, i) => {
      if (i > 0 && rng(list[i - 1].time).e !== rng(b.time).s) groups.push([]);
      groups[groups.length - 1].push(b);
    });
    groups.forEach(g => g.forEach((b, i) => {
      b.isHead = i === 0; b.isTail = i === g.length - 1;
      b.respIdx = Math.min((b.isTail && !b.isHead) ? 1 : 0, b.slotTimes.length - 1);
      b.needBring = b.isHead; b.needTake = b.isTail;
      // 連続する時間帯の直前ブロック。場所ごとのカート番号を入れ替えずに引き継ぐために使う
      b.groupPrev = i > 0 ? g[i - 1] : null;
    }));
  });

  // 周期・列・セル人数はルール（block > month > pw > global）で決める
  blocks.forEach(b => {
    const blockKey = ym + '|' + b.dateKey + '|' + b.time;
    const rr = scAiResolveRules(rules, ym, blockKey);
    const n = b.slotTimes.length;
    b.cyc = Number.isInteger(rr.cycle) && rr.cycle > 0 && n % rr.cycle === 0 ? rr.cycle : scAiAutoCycle(n);
    b.reps = n / b.cyc;
    b.cols = b.places.length;
    b.cellTarget = rr.cellTarget;
    b.cellMin = rr.cellMin;
    b.rules = rr;
    b.blockKey = blockKey;
  });
  return blocks;
}

// ---- 割当計画（shift_real.mjs 209-355 相当）----
// 戻り値: { plan, cartWarn, unreadNotes, winOf }
// opts.prevCartCount … 前月のカート担当回数（uid → 回数）。当月の回数が同じときの比較に使う
// opts.cartNumbers   … カート番号マスタ（設定タブの並び順）。場所ごとの番号の自動決定に使う
function scAiBuildPlan(blocks, applicants, memberFlags, couples, prevCount, prevLoaded, opts) {
  const o = opts || {};
  const isM = u => (memberFlags[u] || {}).gender === 'M';
  const AP = {}; (applicants || []).forEach(a => AP[a.uid] = a);
  const appliedUids = {};
  const winOf = {};
  const cartNgOf = {};
  const unreadNotes = [];
  blocks.forEach(b => {
    appliedUids[b.label] = (applicants || []).filter(a => (a.appliedSlots || []).some(s => s.slot === b.label)).map(a => a.uid);
    (applicants || []).forEach(a => (a.appliedSlots || []).forEach(s => {
      if (s.slot !== b.label) return;
      if (s.cartNg) cartNgOf[a.uid + '|' + b.label] = true;
      const w = scAiNoteWindow(s.note);
      winOf[a.uid + '|' + b.label] = w;
      if (s.note && !w) unreadNotes.push(a.uid + '（' + b.label + '）: ' + s.note);
    }));
  });

  const assignedCnt = {};
  const plan = {};
  blocks.forEach((b, bi) => {
    const pool = appliedUids[b.label].filter(u => AP[u]);
    const remainingAfter = u => blocks.slice(bi + 1).filter(x => appliedUids[x.label].includes(u)).length;
    const usePrev = !!b.rules.usePrevMonth;
    const rank = (x, y) => (assignedCnt[x] || 0) - (assignedCnt[y] || 0)
      || (usePrev ? (prevCount[x] || 0) - (prevCount[y] || 0) : 0)
      || remainingAfter(x) - remainingAfter(y)
      || (x < y ? -1 : 1);

    const normal = [], extras = [];
    pool.forEach(u => {
      const w = winOf[u + '|' + b.label];
      if (scAiOkPositions(b, w).length) normal.push(u);
      else {
        const rp = scAiOkRepPositions(b, w);
        if (rp.length) extras.push({ uid: u, at: rp });
      }
    });
    const headCap = b.cyc * b.cols;
    const subCap = Math.max(0, Math.round(b.cyc * b.cols * (b.cellTarget - 1)));
    const heads = normal.filter(isM).sort(rank).slice(0, headCap);
    const droppedWives = new Set();
    if (b.rules.dropWifeWithHusband) {
      (couples || []).forEach(cp => {
        const h = cp[0], w = cp[1];
        if (normal.indexOf(h) >= 0 && heads.indexOf(h) < 0) droppedWives.add(w);
      });
    }
    const subs = normal.filter(u => !isM(u) && !droppedWives.has(u)).sort(rank).slice(0, subCap);
    const keptExtras = extras.filter(e => !droppedWives.has(e.uid));
    const used = new Set([...heads, ...subs, ...keptExtras.map(e => e.uid)]);
    [...used].forEach(u => assignedCnt[u] = (assignedCnt[u] || 0) + 1);
    plan[b.label] = { heads, subs, extras: keptExtras, droppedWives: [...droppedWives],
      dropped: pool.filter(u => !used.has(u)) };
  });

  // カート担当・責任者（shift_real.mjs 282-355 相当。選び方は 2026-09-26 に変更）
  // - 担当回数は人ごとに数える（持ち込み・持ち帰りをそれぞれ1回）。当月の回数が
  //   少ない人を優先し、同じなら前月の回数が少ない人を優先する
  // - 回数が一番少ない人が1人で全台運べる（4台の人）なら1人で担当。運べない
  //   （2台の人）なら、組める相手のうち回数が一番少ない人と2人で担当する。
  //   組める相手がいなければ次に回数が少ない人で同じことを試す
  //   （以前は「4台の人がいれば必ずその人」だったため4台の人に偏っていた）
  // - 回数が同じなら 1人目の枠（兄弟）→ 以降の申込ブロックが少ない人 の順に優先
  // - 申込で「カート不可」にしている人は選ばない
  const cartCap = u => {
    const f = memberFlags[u] || {};
    const n = Number(f.cartCapacity);
    return Number.isFinite(n) && n > 0 ? n : (f.cartFlag ? 2 : 0);
  };
  const prevCart = o.prevCartCount || {};
  const cartCnt = {};
  const cartWarn = [];
  const placeCartOf = scAiAssignPlaceCarts(blocks, o.cartNumbers, cartWarn);
  blocks.forEach((b, bi) => {
    const pl = plan[b.label];
    const roster = pl.heads.concat(pl.subs);
    const need = b.cols * b.rules.cartsPerPlace;
    const bStart = scAiSlotRange(b.slotTimes[0]).s;
    const bEnd = scAiSlotRange(b.slotTimes[b.slotTimes.length - 1]).e;
    const canStart = u => { const w = winOf[u + '|' + b.label]; return !w || w.s <= bStart; };
    const canEnd = u => { const w = winOf[u + '|' + b.label]; return !w || w.e >= bEnd; };
    const remainingAfter = u => blocks.slice(bi + 1).filter(x => appliedUids[x.label].includes(u)).length;
    const prefer = (x, y) => (cartCnt[x] || 0) - (cartCnt[y] || 0)
      || (b.rules.usePrevMonth ? (prevCart[x] || 0) - (prevCart[y] || 0) : 0)
      || (pl.heads.indexOf(x) < 0) - (pl.heads.indexOf(y) < 0)
      || remainingAfter(x) - remainingAfter(y)
      || (x < y ? -1 : 1);
    const pairable = (x, y) => x !== y && cartCap(x) * 2 >= need && cartCap(y) * 2 >= need
      && (b.rules.allowMixedCartPair || cartCap(x) === cartCap(y));
    // 優先順に並べた担当案（1人 or 2人）の一覧
    const teams = (pool, exclude) => {
      const p = pool.filter(u => cartCap(u) > 0 && !exclude.has(u) && !cartNgOf[u + '|' + b.label]).sort(prefer);
      const out = [];
      p.forEach(u => {
        if (cartCap(u) >= need) out.push([u]);
        else p.filter(y => pairable(u, y)).forEach(y => out.push([u, y]));
      });
      return out;
    };
    const pick = (pool, exclude) => teams(pool, exclude)[0] || null;

    // 持ち帰りは、残りの人で持ち込みも決められる案を優先する
    // （2台の人を2人使った結果、持ち込みの相手が残らなくなるのを避ける）
    let take = [];
    if (b.needTake) {
      const opts = teams(roster.filter(canEnd), new Set());
      take = (b.needBring && opts.find(t => pick(roster.filter(canStart), new Set(t)))) || opts[0] || null;
    }
    let bring = b.needBring ? pick(roster.filter(canStart), new Set(take || [])) : [];
    if (b.needBring && !bring && b.rules.allowCartDoubleDuty) {
      bring = pick(roster.filter(canStart), new Set());
      if (bring) cartWarn.push(b.label + ': 持ち込みの候補が足りず、持ち帰りと兼任しています（' + bring.join('・') + '）');
    }
    if (b.needTake && !take) cartWarn.push(b.label + ': 持ち帰りの担当を決められませんでした');
    if (b.needBring && !bring) cartWarn.push(b.label + ': 持ち込みの担当を決められませんでした');
    take = take || []; bring = bring || [];
    [...take, ...bring].forEach(u => cartCnt[u] = (cartCnt[u] || 0) + 1);

    // 2人で運ぶときは、持ち込みの2人を周1で別々の列に、持ち帰りの2人を最終周で
    // 別々の列に置かせる（それぞれ自分が最初／最後にいる場所のカートを運ぶため）
    // 持ち込みと持ち帰りを兼ねる人がいるときは指定しない（同じ兄弟に周1と最終周で
    // 別々の列を指示すると「固定枠は3周とも同じ列」と矛盾するため）
    const dual = bring.some(u => take.indexOf(u) >= 0);
    const twoCols = list => (!dual && list.length === 2 && b.cols >= 2) ? [0, 1] : [];

    const posBan = {};
    bring.forEach(u => (posBan[u] = posBan[u] || new Set()).add(0));
    take.forEach(u => (posBan[u] = posBan[u] || new Set()).add(b.cyc - 1));

    const cartAssigned = new Set([...bring, ...take]);
    const respOk = u => (memberFlags[u] || {}).respFlag
      && scAiOkPositions(b, winOf[u + '|' + b.label]).indexOf(b.respIdx) >= 0
      && !(posBan[u] && posBan[u].has(b.respIdx))
      && !(b.rules.avoidRespCartOverlap && cartAssigned.has(u));
    const r1 = take.filter(u => pl.heads.indexOf(u) >= 0 && respOk(u))[0] || pl.heads.filter(respOk)[0] || '';
    if (!r1) cartWarn.push(b.label + ': 責任者を決められませんでした');

    pl.cart = { need, bring, take, bringCols: twoCols(bring), takeCols: twoCols(take), posBan, r1,
      placeCart: (placeCartOf[b.label] || []).slice() };
  });

  return { plan, cartWarn, unreadNotes, winOf };
}

// ---- 場所ごとのカート番号（2026-09-26 相談で決定）----
// - マスタの番号を並び順に cartsPerPlace 台ずつの組にする（①②・③④）。余りは使わない
// - 連続しない時間帯ごとに、次の順で一番小さくなる割り当てを選ぶ
//   1. 選んだ組のこれまでの使用回数の合計（マスタに余分な組があるときに順番に回す）
//   2. 「その組をその場所に置いた回数」の合計（組と場所の組み合わせを均等にする）
//   3. 同じ曜日・同じ時間帯での 2 の回数（曜日ごとの固定化を防ぐ）
//   4. ブロック名から作る疑似乱数（単純な交互にしない。毎回同じ結果になる）
// - 連続する時間帯は、直前の時間帯と同じ場所には同じ番号をそのまま引き継ぐ
// 戻り値: { [block.label]: string[]（列ごとの "1,2" 形式。決められない列は ''）}
function scAiAssignPlaceCarts(blocks, cartNumbers, warn) {
  const out = {};
  const nums = (cartNumbers || []).map(x => String(x).trim()).filter(Boolean);
  const useCnt = {}, placeCnt = {}, slotCnt = {};
  const lexLess = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return false; };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  blocks.forEach(b => {
    const cpp = Number(b.rules.cartsPerPlace) || 2;
    const groups = [];
    for (let i = 0; i + cpp <= nums.length; i += cpp) groups.push(nums.slice(i, i + cpp).join(','));
    const prev = b.groupPrev ? out[b.groupPrev.label] : null;
    const res = b.places.map((p, ci) => {
      if (!prev) return '';
      const pi = b.groupPrev.places.indexOf(p);
      return pi >= 0 ? (prev[pi] || '') : '';
    });
    const free = res.map((v, ci) => v ? -1 : ci).filter(ci => ci >= 0);
    // 使用回数の少ない組だけを候補にする（使用回数の合計が最優先なので、多い組は選ばれない。
    // マスタが大きくても総当たりが膨らまないよう上限も設ける）
    const unused = groups.filter(g => res.indexOf(g) < 0).sort((x, y) => (useCnt[x] || 0) - (useCnt[y] || 0));
    const cut = unused.length > free.length ? (useCnt[unused[free.length - 1]] || 0) : Infinity;
    const avail = unused.filter(g => (useCnt[g] || 0) <= cut).slice(0, Math.max(free.length, 8));
    const wt = b.weekday + '|' + b.time;
    let best = null;
    const walk = (k, used, chosen) => {
      if (k === free.length || used.size === avail.length) {
        const sc = [0, 0, 0];
        chosen.forEach((g, i) => {
          const pk = g + '|' + b.places[free[i]];
          sc[0] += useCnt[g] || 0; sc[1] += placeCnt[pk] || 0; sc[2] += slotCnt[wt + '|' + pk] || 0;
        });
        sc.push(hash(b.label + '#' + chosen.join('/')));
        // 列を多く埋められる案を最優先（番号が足りないときだけ差が出る）
        sc.unshift(-chosen.length);
        if (!best || lexLess(sc, best.sc)) best = { sc, chosen: chosen.slice() };
        return;
      }
      avail.forEach(g => {
        if (used.has(g)) return;
        used.add(g); chosen.push(g);
        walk(k + 1, used, chosen);
        used.delete(g); chosen.pop();
      });
    };
    if (free.length) walk(0, new Set(), []);
    (best ? best.chosen : []).forEach((g, i) => {
      const pk = g + '|' + b.places[free[i]];
      res[free[i]] = g;
      useCnt[g] = (useCnt[g] || 0) + 1;
      placeCnt[pk] = (placeCnt[pk] || 0) + 1;
      slotCnt[wt + '|' + pk] = (slotCnt[wt + '|' + pk] || 0) + 1;
    });
    if (res.some(v => !v)) warn.push(b.label + ': カート番号が足りないため、場所ごとの番号を一部決められませんでした');
    out[b.label] = res;
  });
  return out;
}

// 番号の並びをそろえて1つにまとめる（"3,4" と "1,2" → "1,2,3,4"）
function scAiJoinCartNums(list, order) {
  const all = [];
  (list || []).forEach(v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => { if (all.indexOf(x) < 0) all.push(x); }));
  const idx = x => { const i = (order || []).indexOf(x); return i < 0 ? Infinity : i; };
  return all.sort((a, c) => idx(a) - idx(c) || (a < c ? -1 : a > c ? 1 : 0)).join(',');
}

// 担当者が最初（which='first'）／最後（'last'）に入っている列。見つからなければ -1。
// 同じ時点を比べるため、見つかったスロット番号も返す
function scAiCartCol(slots, uid, which) {
  const n = slots.length;
  for (let k = 0; k < n; k++) {
    const si = which === 'first' ? k : n - 1 - k;
    const ci = ((slots[si] || {}).places || []).findIndex(cell => (cell || []).indexOf(uid) >= 0);
    if (ci >= 0) return { ci, si };
  }
  return { ci: -1, si: -1 };
}

// 担当者ごとの運ぶ番号。1人なら全部、2人ならそれぞれが最初／最後にいる場所の番号。
// 2人が同じ場所にいるときは、より先に（持ち帰りは、より後まで）いる人がその場所、
// もう一人が残りの場所の番号を運ぶ
function scAiCartNumsFor(slots, list, placeCart, which, order) {
  if (!list.length) return [];
  if (list.length === 1) return [scAiJoinCartNums(placeCart, order)];
  const at = list.map(u => scAiCartCol(slots, u, which));
  const cols = placeCart.map((_, ci) => ci);
  const own = [[], []];
  if (at[0].ci >= 0 && at[1].ci >= 0 && at[0].ci !== at[1].ci) {
    own[0].push(at[0].ci); own[1].push(at[1].ci);
  } else if (at[0].ci >= 0 || at[1].ci >= 0) {
    const better = (x, y) => which === 'first' ? x.si <= y.si : x.si >= y.si;
    const w = at[1].ci < 0 ? 0 : at[0].ci < 0 ? 1 : (better(at[0], at[1]) ? 0 : 1);
    own[w].push(at[w].ci);
  }
  cols.forEach(ci => {
    if (own[0].indexOf(ci) >= 0 || own[1].indexOf(ci) >= 0) return;
    (own[1].length <= own[0].length ? own[1] : own[0]).push(ci);
  });
  return own.map(cs => scAiJoinCartNums(cs.sort((a, c) => a - c).map(ci => placeCart[ci]), order));
}

// 2人で運ぶとき、指定した列（周1の最初／最終周の最後）に別々に置かれたかの自前検証。
// 守られなくても番号は scAiCartNumsFor が補正して決めるので warn にとどめる
function scAiCheckCartColumns(blocks, plan, sd) {
  const out = [];
  blocks.forEach((b, bi) => {
    const slots = (sd[bi] || {}).slots || [];
    const ct = plan[b.label].cart;
    [['first', ct.bring, ct.bringCols, '持ち込み'], ['last', ct.take, ct.takeCols, '持ち帰り']].forEach(([which, list, cols, lbl]) => {
      if (!cols || cols.length !== 2) return;
      const at = list.map(u => scAiCartCol(slots, u, which).ci);
      if (at[0] >= 0 && at[1] >= 0 && at[0] !== at[1]) return;
      out.push({ level: 'warn', rule: 'cartColumn',
        msg: b.label + ' の' + lbl + '担当 ' + list.join('・') + ' が' + (which === 'first' ? '最初' : '最後') + 'に同じ場所へ配置されています',
        uids: list.slice() });
    });
  });
  return out;
}

// ---- input 契約の組み立て（計画書 3-4）----
function scAiBuildInputContract(blocks, plan, winOf, prevIssues, scoreHints) {
  const contractBlocks = blocks.map(b => {
    const pl = plan[b.label];
    const posLimits = [];
    [...pl.heads, ...pl.subs].forEach(u => {
      const w = winOf[u + '|' + b.label];
      if (!w) return;
      const ok = scAiOkPositions(b, w);
      if (ok.length < b.cyc) posLimits.push({ uid: u, only: ok, win: { s: w.s, e: w.e } });
    });

    return {
      label: b.label, cyc: b.cyc, reps: b.reps, cols: b.cols,
      slotTimes: b.slotTimes.slice(), places: b.places.slice(), respIdx: b.respIdx,
      heads: pl.heads.slice(), subs: pl.subs.slice(),
      extras: pl.extras.map(e => {
        const w = winOf[e.uid + '|' + b.label];
        return { uid: e.uid, at: e.at.map(x => ({ rep: x.rep, pos: x.pos })), win: w ? { s: w.s, e: w.e } : undefined };
      }),
      couples: [], // 後段で埋める（呼び出し側が全体COUPLESと突き合わせる）
      posLimits,
      r1: pl.cart.r1 || '',
      cartBring: (pl.cart.bring || []).slice(),
      cartTake: (pl.cart.take || []).slice(),
      // 2人で運ぶときだけ。担当者と同じ並びで「周1で置く列」「最終周で置く列」を指定する
      cartBringCols: (pl.cart.bringCols || []).slice(),
      cartTakeCols: (pl.cart.takeCols || []).slice(),
      // 既定（3名/2名）と異なる場合だけ Gateway 側が指示文を足す。既定のときは
      // 実測98点のプロンプトと完全一致させるため、あえて省略できるようにしてある
      cellTarget: b.cellTarget, cellMin: b.cellMin,
    };
  });
  return { blocks: contractBlocks, issues: prevIssues || [], scoreHints: scoreHints || [] };
}

// ---- 生成結果 → shiftDates 形式へ展開（shift_real.mjs 456-476 相当）----
function scAiToShiftDates(blocks, plan, draft, cartOrder) {
  return blocks.map((b, bi) => {
    const d = (draft.blocks || [])[bi] || {};
    // time / watch は validateShift（例: noteTime・bringFirst・respSlot 判定）と
    // 保存API（handlers_shift.ts の allowedWorkerTimes 検査）の両方が読む必須フィールド。
    // AI は見守りフラグを決めないので、ここで手動編集時の autoWatch（shift-create.js）と
    // 同じ規則「1人目がいて3名そろったセルは見守りON」で付ける
    const slots = b.slotTimes.map(st => ({ time: st, places: b.places.map(() => []), watch: b.places.map(() => false) }));
    for (let p = 0; p < b.cyc; p++) {
      const pos = (d.positions || [])[p] || {};
      for (let r = 0; r < b.reps; r++) {
        const rep = (pos.reps || [])[r] || {};
        for (let c = 0; c < b.cols; c++) {
          const cell = (rep.places || [])[c];
          const uids = (Array.isArray(cell) ? cell : [cell]).filter(Boolean);
          slots[r * b.cyc + p].places[c] = uids;
          slots[r * b.cyc + p].watch[c] = uids.length >= 3;
        }
      }
    }
    const ct = plan[b.label].cart;
    // カート番号: 場所ごとの番号は事前計算済み。運ぶ番号は配置が決まった今ここで決める
    const placeCart = b.places.map((_, ci) => (ct.placeCart || [])[ci] || '');
    // 全部の場所の番号が決まったときだけ自動の番号を使う（一部だけだと手入力済みの番号を空で消すため）
    const autoCart = placeCart.length > 0 && placeCart.every(Boolean);
    const kc = autoCart ? scAiCartNumsFor(slots, ct.bring, placeCart, 'first', cartOrder) : [];
    const oc = autoCart ? scAiCartNumsFor(slots, ct.take, placeCart, 'last', cartOrder) : [];
    return {
      date: b.dateKey, time: b.time, weekday: b.weekday, places: b.places.slice(), slots,
      responsible: { r1: ct.r1 || '', r2: '' },
      cart: { ki1: ct.bring[0] || '', kc1: kc[0] || '', ki2: ct.bring[1] || '', kc2: kc[1] || '',
              ko1: ct.take[0] || '', oc1: oc[0] || '', ko2: ct.take[1] || '', oc2: oc[1] || '' },
      usedPlaces: b.places.slice(),
      placeCart,
      autoCart,
    };
  });
}

// 備考の参加時間の自前検証（shift_real.mjs 530-547）
function scAiCheckNoteTimes(blocks, sd, winOf) {
  const out = [];
  blocks.forEach((b, bi) => {
    const slots = (sd[bi] || {}).slots || [];
    b.slotTimes.forEach((st, si) => {
      const t = scAiSlotRange(st);
      ((slots[si] || {}).places || []).forEach(cell => (cell || []).forEach(u => {
        const w = winOf[u + '|' + b.label];
        if (!w || (t.s >= w.s && t.e <= w.e)) return;
        out.push({ level: 'error', rule: 'noteTimeX',
          msg: u + ' は ' + (scAiFmtHM(w.s) || '開始') + '〜' + (scAiFmtHM(w.e) || '終了')
            + ' しか参加できないのに ' + b.label + ' の ' + st + ' に配置されています',
          uids: [u] });
      }));
    });
  });
  return out;
}

// セルの人数が cellTarget（上限）を超えていないかの自前検証（2026-08-26 実機確認で発覚。
// 例外者を足した結果セルが目標人数を超える不具合があったため、プロンプトの指示だけに
// 頼らずアプリ側でも機械的に検出し、超えていれば error として再生成にフィードバックする）
function scAiCheckCellOverflow(blocks, sd) {
  const out = [];
  blocks.forEach((b, bi) => {
    const slots = (sd[bi] || {}).slots || [];
    slots.forEach((s, si) => {
      (s.places || []).forEach((cell, ci) => {
        const n = (cell || []).length;
        if (n > b.cellTarget) {
          out.push({ level: 'error', rule: 'cellOverflow',
            msg: b.label + ' の周' + (Math.floor(si / b.cyc) + 1) + '位置' + (si % b.cyc) + ' の '
              + (b.places[ci] || '') + ' が上限' + b.cellTarget + '名を超えています（' + n + '名）',
            uids: (cell || []).slice() });
        }
      });
    });
  });
  return out;
}

// 例外者以外の人が、指定していない周だけ抜けたり足されたりしていないかの自前検証
// （2026-08-26 実機確認で発覚。「本人の申告なく途中で入ったり抜けたりしない」の担保）
function scAiCheckRosterConsistency(blocks, plan, sd) {
  const out = [];
  blocks.forEach((b, bi) => {
    const slots = (sd[bi] || {}).slots || [];
    const pl = plan[b.label];
    const extraAt = {}; // "rep|pos" -> Set(uid)
    (pl.extras || []).forEach(e => (e.at || []).forEach(x => {
      const k = x.rep + '|' + x.pos;
      (extraAt[k] = extraAt[k] || new Set()).add(e.uid);
    }));
    for (let p = 0; p < b.cyc; p++) {
      let baseSet = null;
      for (let r = 0; r < b.reps; r++) {
        const si = r * b.cyc + p;
        const cellUids = ((slots[si] || {}).places || []).reduce((a, c) => a.concat(c || []), []);
        const extras = extraAt[r + '|' + p] || new Set();
        const core = new Set(cellUids.filter(u => !extras.has(u)));
        if (baseSet === null) { baseSet = core; continue; }
        const same = baseSet.size === core.size && [...baseSet].every(u => core.has(u));
        if (!same) {
          const added = [...core].filter(u => !baseSet.has(u));
          const removed = [...baseSet].filter(u => !core.has(u));
          out.push({ level: 'error', rule: 'rosterInconsistent',
            msg: b.label + ' の位置' + p + 'で、周' + (r + 1) + 'の顔ぶれが周1と一致しません（例外者以外）: '
              + (added.length ? '追加=' + added.join(',') + ' ' : '')
              + (removed.length ? '削除=' + removed.join(',') : ''),
            uids: [...added, ...removed] });
        }
      }
    }
  });
  return out;
}

// validateShift の issue.msg は氏名を埋め込んで組み立てられている
// （validation.js の nameOf 復元）。Gateway へ送る前に uid だけの文へ詰め替える。
// これを怠ると2回目以降の生成で必ず氏名混入検査（サーバー側 422）に落ちる
function scAiSanitizeIssues(issues) {
  return (issues || []).map(i => ({
    level: i.level, rule: i.rule,
    msg: i.rule + (i.uids && i.uids.length ? '（' + i.uids.join(',') + '）' : ''),
    uids: i.uids || [],
  }));
}

// ---- 生成ループ ----
// onProgress(loop, maxLoop, statusText) が呼ばれるたびに setLoading 等でUIを更新する想定
async function scAiRunGenerationLoop(blocks, plan, winOf, applicants, memberFlags, couples, conflictMapArg, opts) {
  const onProgress = (opts && opts.onProgress) || function () {};
  const maxLoop = (opts && opts.maxLoop) || 5;
  const SCORE_META = blocks.map(b => ({ cyc: b.cyc, reps: b.reps, cols: b.cols,
    heads: plan[b.label].heads, subs: plan[b.label].subs, extras: plan[b.label].extras }));

  let prevIssues = null, scoreHints = [], best = null, stall = 0;
  for (let loop = 1; loop <= maxLoop; loop++) {
    onProgress(loop, maxLoop, 'AI原案を生成中…（' + loop + '/' + maxLoop + '回目）');
    const contract = scAiBuildInputContract(blocks, plan, winOf, prevIssues, scoreHints);
    // 全ブロック共通の夫婦一覧をブロックごとの名簿に合わせて絞り込む
    contract.blocks.forEach((cb, bi) => {
      const roster = new Set([...plan[blocks[bi].label].heads, ...plan[blocks[bi].label].subs]);
      cb.couples = (couples || []).filter(([a, c]) => roster.has(a) && roster.has(c));
    });

    let res;
    try {
      res = await apiGet('draftShift', { input: contract });
    } catch (e) {
      if (best) break;
      throw e;
    }
    if (!res || !res.ok || !res.result) { if (best) break; throw new Error((res && res.error) || 'AI原案の生成に失敗しました'); }

    const sd = scAiToShiftDates(blocks, plan, res.result, opts && opts.cartOrder);
    const vout = validateShift(sd, { applicants, memberFlags, conflictMap: conflictMapArg || {}, pwType: currentPwType });
    const issues = vout.issues.filter(i => i.scope === 'live').concat(scAiCheckNoteTimes(blocks, sd, winOf))
      .concat(scAiCheckCellOverflow(blocks, sd)).concat(scAiCheckRosterConsistency(blocks, plan, sd))
      .concat(scAiCheckCartColumns(blocks, plan, sd));
    const errs = issues.filter(i => i.level === 'error');
    const warns = issues.filter(i => i.level === 'warn');
    const sc = computeShiftScore(sd, { memberFlags, couples, meta: SCORE_META });

    if (!best || errs.length < best.errs || (errs.length === best.errs && sc.total > best.score)) {
      best = { loop, errs: errs.length, warns: warns.length, score: sc.total, sd, issues, sc, usage: res.usage, modelUsed: res.modelUsed };
    }
    if (!errs.length && sc.total >= 95) break;
    stall = (best.loop === loop) ? 0 : stall + 1;
    if (stall >= 2) break;
    prevIssues = scAiSanitizeIssues(errs.concat(warns).slice(0, 20));
    scoreHints = errs.length ? [] : shiftScoreHints(sc, 4);
  }
  if (!best) throw new Error('AI原案の生成に失敗しました');
  return best;
}

// ---- 反映用ペイロードの組み立て ----
// 場所ごとのカート番号を自動で決められたブロック（autoCart）は、担当者・運ぶ番号・
// 場所ごとの番号をすべて原案の値で置き換える。決められなかったブロック（マスタの
// 番号が足りない等）は従来どおり、番号は既存の値を引き継ぎ、担当者が変わった枠
// だけ空にして人に入力し直してもらう
function scAiMergePayload(currentBlock, sdBlock) {
  const curCart = (currentBlock && currentBlock.cart) || {};
  if (sdBlock.autoCart) {
    return {
      responsible: sdBlock.responsible,
      cart: Object.assign({}, curCart, sdBlock.cart),
      placeCart: sdBlock.placeCart.slice(),
      usedPlaces: (currentBlock && currentBlock.usedPlaces) || sdBlock.usedPlaces,
      slots: sdBlock.slots,
    };
  }
  const cart = Object.assign({}, curCart, {
    ki1: sdBlock.cart.ki1 || '', ki2: sdBlock.cart.ki2 || '',
    ko1: sdBlock.cart.ko1 || '', ko2: sdBlock.cart.ko2 || '',
  });
  if (cart.ki1 !== curCart.ki1) cart.kc1 = '';
  if (cart.ki2 !== curCart.ki2) cart.kc2 = '';
  if (cart.ko1 !== curCart.ko1) cart.oc1 = '';
  if (cart.ko2 !== curCart.ko2) cart.oc2 = '';
  return {
    responsible: sdBlock.responsible,
    cart,
    placeCart: (currentBlock && currentBlock.placeCart) || [],
    usedPlaces: (currentBlock && currentBlock.usedPlaces) || sdBlock.usedPlaces,
    slots: sdBlock.slots,
  };
}

// ---- 前月の配置回数（計画書5-2: getShiftTableで前月分を数える）----
// 「現在公開中のシフト」を前月実績として使う（前月＝今作っている月の1つ前、という
// 前提が成り立つのは、次の月を作っている間はまだ前の月が公開中であるという通常運用のとき）。
// 公開中の月が対象の前月と一致しない場合は使わない
async function scAiLoadPrevMonthCount(type, targetYear, targetMonth) {
  try {
    const res = await apiGet('getShiftTable', { type });
    if (!res || !res.ok || !res.published || !res.dates) return { count: {}, cartCount: {}, loaded: false, year: null, month: null };
    const wantY = targetMonth === 1 ? targetYear - 1 : targetYear;
    const wantM = targetMonth === 1 ? 12 : targetMonth - 1;
    if (res.year !== wantY || res.month !== wantM) return { count: {}, cartCount: {}, loaded: false, year: res.year, month: res.month };
    const count = {}, cartCount = {};
    // カート担当の回数（持ち込み・持ち帰りをそれぞれ1回）
    (res.dates || []).forEach(d => {
      const c = d.cart || {};
      [...(c.bring || []), ...(c.take || [])].forEach(ent => {
        if (ent && ent.uid) cartCount[ent.uid] = (cartCount[ent.uid] || 0) + 1;
      });
    });
    (res.dates || []).forEach(d => (d.slots || []).forEach(s => {
      Object.values(s.places || {}).forEach(list => (list || []).forEach(ent => {
        if (ent && ent.uid) count[ent.uid] = (count[ent.uid] || 0) + 1;
      }));
    }));
    return { count, cartCount, loaded: true, year: res.year, month: res.month };
  } catch (_) {
    return { count: {}, cartCount: {}, loaded: false, year: null, month: null };
  }
}
