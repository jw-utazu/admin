// 選好スコア（層2）— 原案生成のときだけ使う採点機。
//
// validateShift()（層1）は「やってはいけないこと」の減点表であり、
// error 0 の案どうしを区別できない。こちらは「どう組むのが良いか」を採点する。
//
// 2026-08-26 全面改訂。2026年7〜8月に人が組んだ7ブロックを機械解析して確認した
// 次の構造を採点軸にした（詳細は 計画書/2026-08-23_シフト作成の暗黙知（過去実績の分析）.md）:
//   ・1周 = スロット数 ÷ 3。その周をそのまま3回繰り返す（実測 7/7 ブロックで成立）
//   ・各セルの先頭は必ず兄弟。3周とも同じ周内位置・同じ列に固定（実測 100%）
//   ・2番目以降（姉妹）だけが周ごとに列を入れ替わる（2列ブロックで 6/7 名）
//   ・夫婦は周1と周3で同セル、周2で別セル（2列ブロック 4件中 3件）
//   ・時間制約のある人は入れる周にだけ足す。隣接連続になっても許容する
//
// Node でもブラウザでも動く素の関数。new Function(src) で読み込んで使う。
//
// computeShiftScore(shiftDates, ctx)
//   ctx.memberFlags : { uid: { gender, respFlag, cartFlag } }
//   ctx.couples     : [[夫uid, 妻uid], ...]
//   ctx.meta        : [{ cyc, reps, cols, heads, subs, extras }]  ブロックと同じ並び
//   → { total: 0〜100, items: [{ key, label, note, score, weight, count, hints }] }

var SCORE_SPEC = {
  cycleCopy:      { w: 4, label: '周のコピー',     note: '同じ周内位置の顔ぶれは3周とも同じにする' },
  headFixed:      { w: 4, label: '固定枠の兄弟',   note: 'セルの先頭は兄弟。3周とも同じ位置・同じ列に置く' },
  rosterUsed:     { w: 3, label: '名簿どおりか',   note: '割り当てると決めた人を全員入れ、それ以外は入れない' },
  cellSize:       { w: 3, label: '1セルの人数',   note: '3名が基本。2名まで可、1名は避ける' },
  cellMix:        { w: 2, label: 'セルの男女構成', note: '兄弟と姉妹で組む' },
  sisterRotation: { w: 2, label: '姉妹の列移動',   note: '姉妹は周ごとに列を替えて多くの人と組む' },
  couplePattern:  { w: 2, label: '夫婦の組み方',   note: '周1と周3は同じセル、周2は別のセル' },
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
      for (var c = 0; c < meta.cols; c++) cols[c] = ((s.places || [])[c] || []).filter(Boolean);
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
    var flat = function (cols) { var o = []; cols.forEach(function (c) { o = o.concat(c); }); return o; };

    // --- 周のコピー: 位置 p の顔ぶれが3周とも同じか（例外者は数えない）---
    for (var p = 0; p < meta.cyc; p++) {
      var base = flat(g[p][0]).filter(function (u) { return !exempt[u]; }).sort().join(',');
      for (var r = 1; r < meta.reps; r++) {
        var cur = flat(g[p][r]).filter(function (u) { return !exempt[u]; }).sort().join(',');
        add('cycleCopy', cur === base ? 1 : 0, 1, cur === base ? null
          : b.date + ' 位置' + p + ' の顔ぶれが周1と周' + (r + 1) + 'で違います');
      }
    }

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
    (meta.heads || []).concat(meta.subs || []).forEach(function (u) { planned[u] = true; });
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
        var n2 = cell.filter(function (u) { return !exempt[u]; }).length;
        add('cellSize', n2 === 3 ? 1 : n2 === 2 ? 0.8 : n2 === 1 ? 0.2 : 0, 1, n2 === 3 ? null
          : b.date + ' 周' + (r4 + 1) + '位置' + p4 + ' の ' + ((b.places || [])[c4] || '') + ' が' + n2 + '名です');
        var known = cell.filter(function (u) { return ssGender(ctx, u); });
        if (!known.length) continue;
        var m = known.filter(function (u) { return ssIsM(ctx, u); }).length;
        var mixed = m > 0 && m < known.length;
        add('cellMix', mixed ? 1 : 0.5, 1, mixed ? null
          : (m ? '兄弟だけのセルがあります（' + b.date + '）' : '姉妹だけのセルがあります（' + b.date + '）'));
      }

    // --- 姉妹の列移動（2列以上のときだけ意味がある）---
    if (meta.cols >= 2) {
      var subCols = {};
      for (var p5 = 0; p5 < meta.cyc; p5++) for (var r5 = 0; r5 < meta.reps; r5++)
        for (var c5 = 0; c5 < meta.cols; c5++)
          g[p5][r5][c5].slice(1).forEach(function (u) {
            if (exempt[u]) return;                       // 例外者は出る周が1つなので対象外
            (subCols[u] = subCols[u] || {})[c5] = true;
          });
      Object.keys(subCols).forEach(function (u) {
        var moved = Object.keys(subCols[u]).length > 1;
        add('sisterRotation', moved ? 1 : 0, 1, moved ? null
          : u + ' が ' + b.date + ' で同じ列にとどまっています（周ごとに列を替える）');
      });
    }

    // --- 夫婦: 周1と最終周は同セル、間の周は別セル ---
    couples.forEach(function (cp) {
      var a = cp[0], z = cp[1];
      if (!seen[a] || !seen[z]) return;
      var together = function (r) {
        for (var p6 = 0; p6 < meta.cyc; p6++) for (var c6 = 0; c6 < meta.cols; c6++) {
          var cell = g[p6][r][c6];
          if (cell.indexOf(a) >= 0 && cell.indexOf(z) >= 0) return true;
        }
        return false;
      };
      for (var r6 = 0; r6 < meta.reps; r6++) {
        // 列が1つしかないブロックでは夫婦を別セルにしようがない。
        // 実績でも1列ブロックは3周とも同席なので、そこを減点してはいけない
        var want = meta.cols < 2 ? true : (r6 === 0 || r6 === meta.reps - 1);
        var got = together(r6);
        add('couplePattern', got === want ? 1 : 0, 1, got === want ? null
          : a + ' と ' + z + ' は ' + b.date + ' の周' + (r6 + 1) + 'で'
            + (want ? '同じセルにする' : '別のセルにする') + 'べきです');
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
