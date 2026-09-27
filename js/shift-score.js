// 選好スコア（層2）— 原案生成のときだけ使う採点機。
//
// validateShift()（層1）は「やってはいけないこと」の減点表であり、
// error 0 の案どうしを区別できない。こちらは「どう組むのが良いか」を採点する。
//
// 2026-08-26 全面改訂。2026年7〜8月に人が組んだ7ブロックを機械解析して確認した
// 次の構造を採点軸にした（詳細は 計画書/2026-08-23_シフト作成の暗黙知（過去実績の分析）.md）:
//   ・各セルの先頭は固定枠の兄弟。固定枠以外は兄弟・姉妹とも配置し、周ごとに組み合わせる
//   ・固定枠以外は、同じ人同士で場所だけを替える形を避けて組み合わせの多様さを優先
//   ・指定された夫婦は周1と最終周で同じセル、間の周は別セルに置く
//   ・時間制約のある人は入れる周にだけ足す。隣接連続になっても許容する
//
// Node でもブラウザでも動く素の関数。new Function(src) で読み込んで使う。
//
// computeShiftScore(shiftDates, ctx)
//   ctx.memberFlags : { uid: { gender, respFlag, cartFlag } }
//   ctx.couples     : [[夫uid, 妻uid], ...]
//   ctx.meta        : [{ cyc, reps, cols, heads, otherBrothers, subs, extras }]  ブロックと同じ並び
//   → { total: 0〜100, items: [{ key, label, note, score, weight, count, hints }] }

var SCORE_SPEC = {
  headFixed:      { w: 4, label: '固定枠の兄弟',   note: 'セルの先頭は兄弟。3周とも同じ位置・同じ列に置く' },
  rosterUsed:     { w: 3, label: '名簿どおりか',   note: '選定した人を各周1回ずつ入れ、それ以外は入れない' },
  cellSize:       { w: 3, label: '1セルの人数',   note: '3名が基本。2名まで可、1名は避ける' },
  cellMix:        { w: 2, label: 'セルの男女構成', note: '兄弟だけのセルや、夫婦ペアを含まない兄弟2名・姉妹1名を避ける（夫婦1組＋兄弟は可）' },
  partnerVariety: { w: 4, label: '組み合わせの多様さ', note: '固定枠以外は周ごとに異なる人と組む' },
  couplePattern:  { w: 2, label: '夫婦の組み方',   note: '周1と最終周は同じセル、間の周は別セル' },
};

function ssGender(ctx, uid) {
  var f = (ctx.memberFlags || {})[uid];
  return f && f.gender ? f.gender : '';
}
function ssIsM(ctx, uid) { return ssGender(ctx, uid) === 'M'; }

// ブロックを [周内位置][周][列] = uid配列 に組み直す
function ssGrid(block, meta) {
  var slots = block.slots || [];
  var g = [];
  for (var p = 0; p < meta.cyc; p++) {
    g[p] = [];
    for (var r = 0; r < meta.reps; r++) {
      var s = slots[r * meta.cyc + p] || {};
      var cols = [];
      for (var c = 0; c < meta.cols; c++) cols[c] = ((s.places || [])[c] || []).map(function (u) { return u || ''; });
      g[p][r] = cols;
    }
  }
  return g;
}

function computeShiftScore(shiftDates, ctx) {
  ctx = ctx || {};
  var blocks = shiftDates || [];
  var metas = ctx.meta || [];
  var couples = ctx.couples || [];
  var acc = {};
  Object.keys(SCORE_SPEC).forEach(function (k) { acc[k] = { hit: 0, total: 0, bad: [] }; });
  var add = function (k, v, max, detail) {
    acc[k].hit += v; acc[k].total += max;
    if (detail && v < max) acc[k].bad.push(detail);
  };

  blocks.forEach(function (b, bi) {
    var meta = metas[bi];
    if (!meta || !meta.cyc) return;
    var g = ssGrid(b, meta);
    var exempt = {};
    (meta.extras || []).forEach(function (e) { exempt[e.uid || e] = true; });
    var flat = function (cols) { var o = []; cols.forEach(function (c) { o = o.concat(c); }); return o.filter(Boolean); };

    // --- 固定枠: 先頭は兄弟で、3周とも同じ位置・同じ列 ---
    var headAt = {};                       // uid -> "p|c" の集合
    for (var p2 = 0; p2 < meta.cyc; p2++) {
      for (var r2 = 0; r2 < meta.reps; r2++) {
        for (var c2 = 0; c2 < meta.cols; c2++) {
          var head = g[p2][r2][c2][0];
          if (!head) continue;
          add('headFixed', ssIsM(ctx, head) ? 1 : 0, 1,
            ssIsM(ctx, head) ? null : head + ' が ' + b.date + ' の固定枠（セルの先頭）に入っています');
          (headAt[head] = headAt[head] || {})[p2 + '|' + c2] = true;
        }
      }
    }
    Object.keys(headAt).forEach(function (u) {
      var n = Object.keys(headAt[u]).length;
      add('headFixed', n === 1 ? 1 : 0, 1, n === 1 ? null
        : u + ' が ' + b.date + ' で周によって別の位置・列に動いています');
    });

    // --- 名簿どおりか ---
    var planned = {};
    (meta.heads || []).concat(meta.otherBrothers || [], meta.subs || []).forEach(function (u) { planned[u] = true; });
    (meta.extras || []).forEach(function (e) { planned[e.uid || e] = true; });
    var seen = {};
    for (var p3 = 0; p3 < meta.cyc; p3++) for (var r3 = 0; r3 < meta.reps; r3++)
      flat(g[p3][r3]).forEach(function (u) { seen[u] = true; });
    Object.keys(planned).forEach(function (u) {
      add('rosterUsed', seen[u] ? 1 : 0, 1, seen[u] ? null
        : u + ' を ' + b.date + ' に入れる予定でしたが配置されていません');
    });
    Object.keys(seen).forEach(function (u) {
      add('rosterUsed', planned[u] ? 1 : 0, 1, planned[u] ? null
        : u + ' は ' + b.date + ' の名簿に無いのに配置されています');
    });

    // --- セルの人数と男女構成 ---
    for (var p4 = 0; p4 < meta.cyc; p4++) for (var r4 = 0; r4 < meta.reps; r4++)
      for (var c4 = 0; c4 < meta.cols; c4++) {
        var cell = g[p4][r4][c4];
        // 例外者（時間制約で最終周にだけ足す人）は基本形の外なので人数に数えない
        var n2 = cell.filter(function (u) { return u && !exempt[u]; }).length;
        add('cellSize', n2 === 3 ? 1 : n2 === 2 ? 0.8 : n2 === 1 ? 0.2 : 0, 1, n2 === 3 ? null
          : b.date + ' 周' + (r4 + 1) + '位置' + p4 + ' の ' + ((b.places || [])[c4] || '') + ' が' + n2 + '名です');
        var known = cell.filter(function (u) { return u && ssGender(ctx, u); });
        if (!known.length) continue;
        var m = known.filter(function (u) { return ssIsM(ctx, u); }).length;
        var hasCouple = couples.some(function (cp) { return known.indexOf(cp[0]) >= 0 && known.indexOf(cp[1]) >= 0; });
        var mixed = m > 0 && m < known.length;
        var maleMaleFemale = m === 2 && known.length === 3 && !hasCouple;
        var mixScore = mixed && !maleMaleFemale ? 1 : (m === 0 ? 0.5 : 0);
        add('cellMix', mixScore, 1, mixScore ? null
          : (m === known.length ? '兄弟だけのセルがあります（' + b.date + '）'
            : (maleMaleFemale ? '夫婦ペアを含まない兄弟2名・姉妹1名のセルがあります（' + b.date + '）'
              : '姉妹だけのセルがあります（' + b.date + '）')));
      }

    // --- 固定枠以外の組み合わせ: 場所替えだけで同じ人と組み続ける形を避ける ---
    var fixed = {};
    (meta.heads || []).forEach(function (u) { fixed[u] = true; });
    var spousePairs = {};
    couples.forEach(function (cp) { spousePairs[JSON.stringify(cp.slice().sort())] = true; });
    var encounters = {}, partners = {};
    for (var p5 = 0; p5 < meta.cyc; p5++) for (var r5 = 0; r5 < meta.reps; r5++)
      for (var c5 = 0; c5 < meta.cols; c5++) {
        var group = g[p5][r5][c5].filter(function (u) { return u && !exempt[u]; });
        group.forEach(function (u) {
          if (fixed[u]) return;
          group.forEach(function (v) {
            if (u === v || spousePairs[JSON.stringify([u, v].sort())]) return;
            encounters[u] = (encounters[u] || 0) + 1;
            (partners[u] = partners[u] || {})[v] = true;
          });
        });
      }
    Object.keys(encounters).forEach(function (u) {
      var unique = Object.keys(partners[u] || {}).length;
      var ratio = unique / encounters[u];
      add('partnerVariety', ratio, 1, ratio >= 1 ? null
        : u + ' が ' + b.date + ' で周ごとに同じ人と組んでいます（場所だけでなく組み合わせを変える）');
    });

    // --- 夫婦: 周1と最終周は同じセル、間の周は別セル ---
    couples.forEach(function (cp) {
      var a = cp[0], z = cp[1];
      if (!seen[a] || !seen[z]) return;
      var togetherCell = function (r) {
        for (var p6 = 0; p6 < meta.cyc; p6++) for (var c6 = 0; c6 < meta.cols; c6++) {
          var cell = g[p6][r][c6];
          if (cell.indexOf(a) >= 0 && cell.indexOf(z) >= 0) return p6 + '|' + c6;
        }
        return '';
      };
      var firstCell = togetherCell(0);
      for (var r6 = 0; r6 < meta.reps; r6++) {
        var got = togetherCell(r6);
        var togetherRequired = meta.cols < 2 || r6 === 0 || r6 === meta.reps - 1;
        var matched = togetherRequired ? !!got && (r6 === 0 || got === firstCell) : !got;
        add('couplePattern', matched ? 1 : 0, 1, matched ? null
          : a + ' と ' + z + ' は ' + b.date + ' の周' + (r6 + 1) + 'で'
            + (togetherRequired ? '周1と同じセルにするべきです' : '別セルにするべきです'));
      }
    });
  });

  var items = [], wsum = 0, ssum = 0;
  Object.keys(SCORE_SPEC).forEach(function (k) {
    var a = acc[k], spec = SCORE_SPEC[k];
    if (!a.total) return;
    var ratio = a.hit / a.total;
    wsum += spec.w; ssum += spec.w * ratio;
    items.push({ key: k, label: spec.label, note: spec.note,
      score: Math.round(ratio * 100), weight: spec.w, count: a.total,
      hints: a.bad.slice(0, 5) });
  });
  items.sort(function (x, y) { return (x.score - y.score) || (y.weight - x.weight); });
  return { total: wsum ? Math.round(ssum / wsum * 100) : 0, items: items };
}

// 弱い項目を、再生成へ返すための短い指示文にする
function shiftScoreHints(res, max) {
  var out = [];
  (res.items || []).forEach(function (it) {
    if (it.score >= 90 || out.length >= (max || 4)) return;
    out.push('[' + it.label + ' ' + it.score + '点] ' + (it.hints[0] || it.note));
  });
  return out;
}
