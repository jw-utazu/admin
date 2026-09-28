// ============================================================
// シフト原案の探索エンジン（2026-09-28）
//
// 配置を LLM に任せていた原案生成を、ブラウザ内の探索に置き換えたもの。
// 計画書「2026-09-28_シフト原案の探索エンジン化.md」参照。
//
// 入力は scAiBuildInputContract() の1ブロック分（Gateway に送っていた契約と同じ）、
// 出力も LLM と同じ { positions: [{ reps: [{ places: [[uid,…],…] }] }] } なので、
// 後段の scAiToShiftDates()・validateShift()・computeShiftScore() はそのまま使える。
//
// DOM とグローバル状態には触れない。Node でも new Function(src) で読み込んで
// テストできる（shift-score.js と同じ流儀）。
// このファイルを変更したら shift-create.html の ?v= を +1 すること
// ============================================================

// 規則の重み。絶対に守る規則（hard）を破る案は、なるべく守る規則を
// いくら満たしても選ばれない。両立しないときだけ軽いほうから破る
var SC_SOLVER_W = {
  hard: 10000,     // 人数上限・夫婦・責任者・時間制約・3スロット連続・例外者の連続
  cart: 3000,      // 持ち込みが最初の枠／持ち帰りが最後の枠
  cellMin: 300,    // セルの人数が下限未満（1人あたり）
  cartCol: 200,    // 2人で運ぶカート担当が同じ列
  consec2: 500,    // 上下のスロットに続けて入る（組み合わせの分散より優先）
  extraMiss: 80,   // 例外者を入れられる周に入れていない
  extraFirst: 900, // 例外者を一度も配置しない（回数より先に、各人を入れる）
  samePlace: 60,   // 固定枠以外の人が全周同じ列
  mix: 40,         // 兄弟だけのセル・夫婦を含まない兄弟2名＋姉妹1名のセル
  partner: 20,     // 同じ人と2回目に組む（夫婦・固定枠どうしは除く）
  partner3: 150,   // 同じ人と3回目以降に組む
  sameGroup: 150,  // セルの顔ぶれが別の周とまったく同じ
  balance: 30,     // 同じ周の中でのセル人数のばらつき（平均との差の2乗）
};

// relaxed（両立しなかった規則）として画面に報告する規則
var SC_SOLVER_REPORT = { overflow: 1, couple: 1, resp: 1, posLimit: 1, consec3: 1, extraConsec: 1, extraMiss: 1, bringFirst: 1, takeLast: 1 };

function scSolverHash(str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// 決定的な擬似乱数（mulberry32）。同じ種なら同じ列を返す
function scSolverRng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 契約1ブロックから、探索で使う番号付きの構造を作る
function scSolverPrep(cb) {
  var cyc = cb.cyc, reps = cb.reps, cols = cb.cols, C = cyc * cols;
  var heads = (cb.heads || []).filter(Boolean).slice(0, C);
  var others = (cb.otherBrothers || []).concat(cb.subs || []).filter(function (u) { return u && heads.indexOf(u) < 0; });
  var extras = (cb.extras || []).filter(function (e) { return e && e.uid; });
  var male = {}, female = {};
  heads.concat(cb.otherBrothers || []).forEach(function (u) { male[u] = true; });
  (cb.subs || []).forEach(function (u) { female[u] = true; });

  var only = {};
  (cb.posLimits || []).forEach(function (pl) { if (pl && Array.isArray(pl.only)) only[pl.uid] = pl.only; });
  var allCells = [];
  for (var k = 0; k < C; k++) allCells.push(k);
  var posOk = function (u, p) { return !only[u] || only[u].indexOf(p) >= 0; };
  var otherDom = others.map(function (u) {
    var d = allCells.filter(function (k2) { return posOk(u, Math.floor(k2 / cols)); });
    return d.length ? d : allCells.slice();
  });
  var extraDom = extras.map(function (e) {
    var byRep = [];
    for (var r = 0; r < reps; r++) {
      byRep.push(allCells.filter(function (k2) {
        return (e.at || []).some(function (x) { return x.rep === r && x.pos === Math.floor(k2 / cols); });
      }));
    }
    return byRep;
  });

  // 人の通し番号: 固定枠 0..H-1、固定枠以外 H..H+N-1、例外者 H+N..
  var H = heads.length, N = others.length, E = extras.length;
  var uids = heads.concat(others, extras.map(function (e) { return e.uid; }));
  var id = {};
  uids.forEach(function (u, i) { if (!(u in id)) id[u] = i; });
  var roster = {};
  heads.concat(others).forEach(function (u) { roster[u] = true; });
  var couples = (cb.couples || []).filter(function (cp) { return roster[cp[0]] && roster[cp[1]]; })
    .map(function (cp) { return [id[cp[0]], id[cp[1]]]; });
  var spouse = {};
  couples.forEach(function (cp) { spouse[cp[0]] = cp[1]; spouse[cp[1]] = cp[0]; });
  var sex = uids.map(function (u) { return male[u] ? 1 : female[u] ? 2 : 0; });

  var idsOf = function (list) { return (list || []).filter(function (u) { return u in id && id[u] < H + N; }).map(function (u) { return id[u]; }); };
  return {
    cb: cb, cyc: cyc, reps: reps, cols: cols, C: C, H: H, N: N, E: E, uids: uids,
    heads: heads, others: others, extras: extras, otherDom: otherDom, extraDom: extraDom,
    couples: couples, spouse: spouse, sex: sex,
    headOnly: heads.map(function (u) { return only[u] || null; }),
    r1: cb.r1 && (cb.r1 in id) ? id[cb.r1] : -1,
    respIdx: Math.min(Math.max(0, cb.respIdx || 0), cyc - 1),
    bring: idsOf(cb.cartBring), take: idsOf(cb.cartTake),
    bringCols: Array.isArray(cb.cartBringCols) && cb.cartBringCols.length === 2 ? cb.cartBringCols : null,
    takeCols: Array.isArray(cb.cartTakeCols) && cb.cartTakeCols.length === 2 ? cb.cartTakeCols : null,
    cellTarget: Number(cb.cellTarget) > 0 ? Number(cb.cellTarget) : 3,
    cellMin: Number(cb.cellMin) > 0 ? Number(cb.cellMin) : 0,
  };
}

// 状態: headAt[h]=セル, at[r][i]=固定枠以外 i の周 r のセル, ex[r][j]=例外者 j のセル（-1=置かない）
function scSolverCellOf(m, s, pid, r) {
  if (pid < m.H) return s.headAt[pid];
  if (pid < m.H + m.N) return s.at[r][pid - m.H];
  return s.ex[r][pid - m.H - m.N];
}

// 評価。report を渡すと破った規則を書き込む（最終結果の説明用）
function scSolverEval(m, s, report) {
  var W = SC_SOLVER_W, cost = 0, C = m.C, cyc = m.cyc, cols = m.cols, reps = m.reps, last = reps - 1;
  var add = function (w, rule, pids, rep) {
    cost += w;
    if (report && SC_SOLVER_REPORT[rule]) report.push({ rule: rule, uids: pids.map(function (p) { return m.uids[p]; }), rep: rep });
  };
  var headIn = [];
  for (var k = 0; k < C; k++) headIn.push(-1);
  for (var h = 0; h < m.H; h++) headIn[s.headAt[h]] = h;

  // セルごとの顔ぶれ
  var members = [];
  for (var r = 0; r < reps; r++) {
    var row = [];
    for (var k2 = 0; k2 < C; k2++) row.push(headIn[k2] >= 0 ? [headIn[k2]] : []);
    for (var i = 0; i < m.N; i++) row[s.at[r][i]].push(m.H + i);
    for (var j = 0; j < m.E; j++) if (s.ex[r][j] >= 0) row[s.ex[r][j]].push(m.H + m.N + j);
    members.push(row);
  }

  // 人数（上限・下限・均等）と男女構成
  for (var r2 = 0; r2 < reps; r2++) {
    var total = 0;
    for (var k0 = 0; k0 < C; k0++) total += members[r2][k0].length;
    var avg = total / C;
    for (var k3 = 0; k3 < C; k3++) {
      var cell = members[r2][k3], n = cell.length;
      if (n > m.cellTarget) add(W.hard * (n - m.cellTarget), 'overflow', cell, r2);
      if (n < m.cellMin) cost += W.cellMin * (m.cellMin - n);
      cost += W.balance * (n - avg) * (n - avg);
      var male = 0, known = 0, hasCouple = false;
      for (var a = 0; a < n; a++) {
        var sx = m.sex[cell[a]];
        if (sx) { known++; if (sx === 1) male++; }
        var sp = m.spouse[cell[a]];
        if (sp !== undefined && cell.indexOf(sp) >= 0) hasCouple = true;
      }
      if (known) {
        var mixed = male > 0 && male < known;
        var mmf = male === 2 && known === 3 && !hasCouple;
        cost += W.mix * (mixed && !mmf ? 0 : (male === 0 ? 0.5 : 1));
      }
    }
  }

  // 連続スロット（固定枠は位置が変わらないので対象外）
  for (var p = m.H; p < m.H + m.N + m.E; p++) {
    var isExtra = p >= m.H + m.N, prev = -9, run = 1;
    for (var r3 = 0; r3 < reps; r3++) {
      var c3 = scSolverCellOf(m, s, p, r3);
      if (c3 < 0) { prev = -9; run = 1; continue; }
      var slot = r3 * cyc + Math.floor(c3 / cols);
      if (slot === prev + 1) {
        run++;
        if (isExtra) add(W.hard, 'extraConsec', [p], r3);
        else if (run === 3) add(W.hard, 'consec3', [p], r3);
        else cost += W.consec2;
      } else run = 1;
      prev = slot;
    }
  }

  // 夫婦: 周1と最終周は同じセル、間の周は別セル（1列なら全周同じセル）
  for (var q = 0; q < m.couples.length; q++) {
    var hh = m.couples[q][0], ww = m.couples[q][1], first = -1;
    for (var r4 = 0; r4 < reps; r4++) {
      var ch = scSolverCellOf(m, s, hh, r4), cw = scSolverCellOf(m, s, ww, r4);
      var together = ch === cw;
      if (r4 === 0) first = together ? ch : -1;
      var need = cols < 2 || r4 === 0 || r4 === last;
      var ok = need ? together && (r4 === 0 || ch === first) : !together;
      if (!ok) add(W.hard, 'couple', [hh, ww], r4);
    }
  }

  // 責任者・固定枠の時間制約
  if (m.r1 >= 0) {
    var cr = scSolverCellOf(m, s, m.r1, 0);
    if (Math.floor(cr / cols) !== m.respIdx) add(W.hard, 'resp', [m.r1], 0);
  }
  for (var h2 = 0; h2 < m.H; h2++) {
    var lim = m.headOnly[h2];
    if (lim && lim.indexOf(Math.floor(s.headAt[h2] / cols)) < 0) add(W.hard, 'posLimit', [h2], 0);
  }

  // カート: 持ち込みは最初の枠、持ち帰りは最後の枠に置かない
  m.bring.forEach(function (b) { if (Math.floor(scSolverCellOf(m, s, b, 0) / cols) === 0) add(W.cart, 'bringFirst', [b], 0); });
  m.take.forEach(function (t) { if (Math.floor(scSolverCellOf(m, s, t, last) / cols) === cyc - 1) add(W.cart, 'takeLast', [t], last); });
  var colPenalty = function (list, want, rep) {
    if (!want || list.length !== 2) return;
    var c0 = scSolverCellOf(m, s, list[0], rep) % cols, c1 = scSolverCellOf(m, s, list[1], rep) % cols;
    if (c0 === c1) cost += W.cartCol;
    else if (c0 !== want[0]) cost += W.cartCol / 10;
  };
  colPenalty(m.bring, m.bringCols, 0);
  colPenalty(m.take, m.takeCols, last);

  // 場所の分散（固定枠以外が全周同じ列にならない）
  if (cols >= 2 && reps >= 2) {
    for (var i2 = 0; i2 < m.N; i2++) {
      var col0 = s.at[0][i2] % cols, same = true;
      for (var r5 = 1; r5 < reps; r5++) if (s.at[r5][i2] % cols !== col0) { same = false; break; }
      if (same) cost += W.samePlace;
    }
  }

  // 例外者をなるべく多くの周に入れる
  for (var j2 = 0; j2 < m.E; j2++) {
    var extraAvailable = 0, extraAssigned = 0;
    for (var r6 = 0; r6 < reps; r6++) {
      if (!m.extraDom[j2][r6].length) continue;
      extraAvailable++;
      if (s.ex[r6][j2] < 0) add(W.extraMiss, 'extraMiss', [m.H + m.N + j2], r6);
      else extraAssigned++;
    }
    if (extraAvailable && !extraAssigned) cost += W.extraFirst;
  }

  // 組み合わせの多様さ（固定枠以外の人が、夫婦以外の同じ人と何度も組まない）
  var seen = {};
  for (var r7 = 0; r7 < reps; r7++) for (var k4 = 0; k4 < C; k4++) {
    var cl = members[r7][k4];
    for (var x = 0; x < cl.length; x++) for (var y = x + 1; y < cl.length; y++) {
      var u = cl[x], v = cl[y];
      if (u < m.H && v < m.H) continue;
      if (m.spouse[u] === v) continue;
      var key = u < v ? u + ',' + v : v + ',' + u;
      // 2回目は軽く、3回目以降は重く（同じ相手と毎周組むのを特に避ける）
      if (seen[key]) cost += seen[key] >= 2 ? W.partner3 : W.partner;
      seen[key] = (seen[key] || 0) + 1;
    }
  }
  // 同じ顔ぶれ（夫婦2人だけのセルは除く）が別の周にもう一度できる
  var groups = {};
  for (var r8 = 0; r8 < reps; r8++) for (var k5 = 0; k5 < C; k5++) {
    var gl = members[r8][k5];
    if (gl.length < 2) continue;
    if (gl.length === 2 && m.spouse[gl[0]] === gl[1]) continue;
    // 顔ぶれの鍵。通し番号が53未満なら 2^番号 の和（順序によらず一意で速い）
    var gk = 0;
    for (var g2 = 0; g2 < gl.length; g2++) gk += gl[g2] < 53 ? Math.pow(2, gl[g2]) : NaN;
    if (gk !== gk) gk = gl.slice().sort(function (a1, b1) { return a1 - b1; }).join(',');
    if (groups[gk]) cost += W.sameGroup; else groups[gk] = 1;
  }
  return cost;
}

function scSolverRandomState(m, rng) {
  var cells = [];
  for (var k = 0; k < m.C; k++) cells.push(k);
  for (var i = cells.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
  var s = { headAt: cells.slice(0, m.H), at: [], ex: [] };
  for (var r = 0; r < m.reps; r++) {
    s.at.push(m.otherDom.map(function (d) { return d[Math.floor(rng() * d.length)]; }));
    s.ex.push(m.extraDom.map(function (d) { var dd = d[r]; return dd.length ? dd[Math.floor(rng() * dd.length)] : -1; }));
  }
  return s;
}
function scSolverCopy(s) {
  return { headAt: s.headAt.slice(), at: s.at.map(function (a) { return a.slice(); }), ex: s.ex.map(function (a) { return a.slice(); }) };
}

// 状態を1手だけ変える。戻り値は元に戻す関数（変えられなかったら null）
function scSolverMove(m, s, rng) {
  var x = rng(), r = Math.floor(rng() * m.reps);
  if (x < 0.12 && m.C > 1) {
    // 固定枠のセルを入れ替える（空きセルとの入れ替えも含む）
    var k1 = Math.floor(rng() * m.C), k2 = Math.floor(rng() * m.C);
    if (k1 === k2) return null;
    var h1 = s.headAt.indexOf(k1), h2 = s.headAt.indexOf(k2);
    if (h1 < 0 && h2 < 0) return null;
    if (h1 >= 0) s.headAt[h1] = k2;
    if (h2 >= 0) s.headAt[h2] = k1;
    return function () { if (h1 >= 0) s.headAt[h1] = k1; if (h2 >= 0) s.headAt[h2] = k2; };
  }
  if (m.E && x > 0.85) {
    var j = Math.floor(rng() * m.E), d = m.extraDom[j][r];
    if (!d.length) return null;
    var old = s.ex[r][j], nv = rng() < 0.25 ? -1 : d[Math.floor(rng() * d.length)];
    if (nv === old) return null;
    s.ex[r][j] = nv;
    return function () { s.ex[r][j] = old; };
  }
  if (!m.N) return null;
  var i = Math.floor(rng() * m.N);
  if (x < 0.5) {
    // 1人を別のセルへ
    var dom = m.otherDom[i], o = s.at[r][i], nc = dom[Math.floor(rng() * dom.length)];
    if (nc === o) return null;
    s.at[r][i] = nc;
    return function () { s.at[r][i] = o; };
  }
  // 同じ周の2人を入れ替える
  var i2 = Math.floor(rng() * m.N);
  var a = s.at[r][i], b = s.at[r][i2];
  if (i === i2 || a === b) return null;
  if (m.otherDom[i].indexOf(b) < 0 || m.otherDom[i2].indexOf(a) < 0) return null;
  s.at[r][i] = b; s.at[r][i2] = a;
  return function () { s.at[r][i] = a; s.at[r][i2] = b; };
}

// 状態 → LLM と同じ出力形式
function scSolverToPositions(m, s) {
  var positions = [];
  for (var p = 0; p < m.cyc; p++) {
    var reps = [];
    for (var r = 0; r < m.reps; r++) {
      var places = [];
      for (var c = 0; c < m.cols; c++) {
        var k = p * m.cols + c, h = s.headAt.indexOf(k);
        var rest = [];
        for (var i = 0; i < m.N; i++) if (s.at[r][i] === k) rest.push(m.others[i]);
        for (var j = 0; j < m.E; j++) if (s.ex[r][j] === k) rest.push(m.extras[j].uid);
        places.push(h >= 0 ? [m.heads[h]].concat(rest) : (rest.length ? [''].concat(rest) : []));
      }
      reps.push({ places: places });
    }
    positions.push({ reps: reps });
  }
  return positions;
}

// 1ブロックを解く。同じ入力＋同じ variant なら同じ結果になるよう、反復回数で止める。
// 時間（opts.maxMs、既定20秒）は極端に遅い端末で固まらないための安全弁で、
// これに達したときだけ結果が変わりうる。その場合は timedOut を立てて画面に知らせる
function scSolveBlock(cb, opts) {
  var o = opts || {};
  var m = scSolverPrep(cb);
  var rng = scSolverRng(scSolverHash(String(cb.label || '')) ^ Math.imul((o.variant || 0) + 1, 0x9E3779B9));
  var chains = o.chains || 8, iters = o.iters || 12000, maxMs = o.maxMs || 20000;
  var started = Date.now();
  var best = null, bestCost = Infinity, timedOut = false;
  for (var ch = 0; ch < chains; ch++) {
    var s = scSolverRandomState(m, rng), cost = scSolverEval(m, s);
    if (cost < bestCost) { bestCost = cost; best = scSolverCopy(s); }
    var T0 = 300, T1 = 0.5;
    for (var it = 0; it < iters; it++) {
      var undo = scSolverMove(m, s, rng);
      if (!undo) continue;
      var nc = scSolverEval(m, s);
      var T = T0 * Math.pow(T1 / T0, it / iters);
      if (nc <= cost || rng() < Math.exp((cost - nc) / T)) {
        cost = nc;
        if (cost < bestCost) { bestCost = cost; best = scSolverCopy(s); }
      } else undo();
      if ((it & 1023) === 0 && Date.now() - started > maxMs) { timedOut = true; break; }
    }
    if (bestCost === 0 || timedOut) break;
  }
  if (!best) { best = scSolverRandomState(m, rng); bestCost = scSolverEval(m, best); }
  var report = [];
  scSolverEval(m, best, report);
  return { positions: scSolverToPositions(m, best), relaxed: report, cost: bestCost, timedOut: timedOut, elapsedMs: Date.now() - started };
}

// 全ブロックを解く。ブロックごとに制御を返し、進捗表示を更新できるようにする
async function scSolveDraft(contract, opts) {
  var o = opts || {};
  var list = (contract && contract.blocks) || [];
  var blocks = [], relaxed = [], timedOut = [];
  for (var i = 0; i < list.length; i++) {
    if (o.onProgress) o.onProgress(i, list.length);
    await new Promise(function (res) { setTimeout(res, 0); });
    var r = scSolveBlock(list[i], o);
    blocks.push({ positions: r.positions });
    if (r.timedOut) timedOut.push(list[i].label);
    r.relaxed.forEach(function (x) { relaxed.push(Object.assign({ block: i, label: list[i].label }, x)); });
  }
  return { draft: { blocks: blocks }, relaxed: relaxed, timedOut: timedOut };
}
