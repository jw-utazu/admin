// ============================================================
// 月次運用・申込状況（フェーズ3）
// 詳細な希望セル編集は shift-create.html に残し、ここでは既存APIの
// 実データを確認しやすい一覧へ整形する。
// ============================================================
(function () {
  let state = {
    key: '', loading: false, loaded: false, error: '', data: null, flags: {},
    unsubmittedOpen: true,
  };
  let requestSeq = 0;

  function escapeWish(value) {
    if (typeof escHtml === 'function') return escHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function visible(el, on) {
    if (!el) return;
    if (typeof setVisible === 'function') setVisible(el, on);
    else el.classList.toggle('is-hidden', !on);
  }

  function contextType() {
    return typeof currentPwType === 'undefined' ? 'normal' : currentPwType;
  }

  function contextYear() {
    return typeof curY === 'undefined' ? 0 : Number(curY);
  }

  function contextMonth() {
    return typeof curM === 'undefined' ? 0 : Number(curM);
  }

  function contextKey() {
    return `${contextType()}:${contextYear()}-${contextMonth()}`;
  }

  function wishParams() {
    return { year: contextYear(), month: contextMonth(), type: contextType() };
  }

  function shiftCreateHref() {
    const type = contextType();
    return './shift-create.html' + (type !== 'normal' ? `?type=${encodeURIComponent(type)}` : '');
  }

  function activeDates() {
    if (typeof getMonthlyActiveDates === 'function') return getMonthlyActiveDates();
    const type = contextType();
    if (type !== 'normal' && typeof adminPhases !== 'undefined' && Array.isArray(adminPhases)) {
      const index = typeof currentPhaseIndex === 'undefined' ? 0 : currentPhaseIndex;
      if (adminPhases[index]) return adminPhases[index];
    }
    return typeof dates !== 'undefined' ? (dates || {}) : {};
  }

  function dateValue(value, endOfDay) {
    if (!value || !Number(value.y) || !Number(value.m) || !Number(value.d)) return null;
    const date = new Date(Number(value.y), Number(value.m) - 1, Number(value.d));
    if (endOfDay) date.setHours(23, 59, 59, 999);
    return date;
  }

  function dateText(value) {
    if (typeof getMonthlyDateText === 'function') return getMonthlyDateText(value);
    if (!dateValue(value)) return '未設定';
    return `${value.m}月${value.d}日`;
  }

  function wishStatus() {
    const d = activeDates();
    const deadline = dateValue(d.deadline, true);
    const apply = dateValue(d.apply, false);
    if (!deadline) return { label: '締切未設定', className: 'alert', detail: '希望締切が未設定です。日程タブで確認してください。' };
    const now = new Date();
    if (apply && now < apply) {
      return { label: '受付開始前', className: 'wait', detail: `受付開始：${dateText(d.apply)}・締切：${dateText(d.deadline)}` };
    }
    if (now > deadline) {
      return { label: '受付終了', className: 'done', detail: `締切：${dateText(d.deadline)}・詳細な修正は希望確認画面から行います。` };
    }
    return { label: '受付中', className: 'current', detail: `締切：${dateText(d.deadline)}` };
  }

  function setBusy(on) {
    document.querySelectorAll('[data-monthly-tab], [data-monthly-wishes-action="reload"], [data-monthly-wishes-action="toggle-unsubmitted"]').forEach(el => {
      if (el.tagName === 'BUTTON') el.disabled = on;
    });
  }

  function membersOf(data) {
    return data && Array.isArray(data.members) ? data.members : [];
  }

  function slotsOf(data) {
    return data && Array.isArray(data.slots) ? data.slots : [];
  }

  function matrixOf(data) {
    return data && data.matrix && typeof data.matrix === 'object' ? data.matrix : {};
  }

  function memberUid(member) {
    return String(member && (member.uid || member.id) || '');
  }

  function memberName(member, flags) {
    const uid = memberUid(member);
    return String(member && member.name || flags[uid] && flags[uid].name || '氏名未登録');
  }

  function memberFurigana(member, flags) {
    const uid = memberUid(member);
    return String(member && (member.furigana || member.reading) || flags[uid] && flags[uid].furigana || '');
  }

  function selectedSlotsFor(uid, data) {
    const row = matrixOf(data)[uid] || {};
    return slotsOf(data).filter(slot => !!row[slot]);
  }

  function commentFor(uid, data, selected) {
    const row = matrixOf(data)[uid] || {};
    const comments = [];
    selected.forEach(slot => {
      const value = row[slot];
      const comment = value && typeof value === 'object' ? String(value.comment || '').trim() : '';
      if (comment && !comments.includes(comment)) comments.push(comment);
    });
    return comments.join(' / ');
  }

  function wishRows(data, flags) {
    return membersOf(data).map(member => {
      const uid = memberUid(member);
      const selected = selectedSlotsFor(uid, data);
      return {
        uid,
        name: memberName(member, flags),
        furigana: memberFurigana(member, flags),
        selected,
        comment: commentFor(uid, data, selected),
      };
    }).sort((a, b) => a.furigana.localeCompare(b.furigana) || a.name.localeCompare(b.name));
  }

  function unsubmittedRows(rows, flags) {
    const submitted = new Set(rows.map(row => row.uid));
    return Object.entries(flags || {}).filter(([uid]) => !submitted.has(String(uid))).map(([uid, info]) => ({
      uid: String(uid),
      name: String(info && info.name || '氏名未登録'),
      furigana: String(info && info.furigana || ''),
    })).sort((a, b) => a.furigana.localeCompare(b.furigana) || a.name.localeCompare(b.name));
  }

  function countValue(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function summary(data, flags) {
    const rows = wishRows(data, flags);
    const submitted = countValue(data && data.appliedCount, rows.length);
    const flagCount = Object.keys(flags || {}).length;
    const total = countValue(data && data.totalMembers, Math.max(submitted, rows.length) + Math.max(flagCount - rows.length, 0));
    const selectedCount = rows.reduce((sum, row) => sum + row.selected.length, 0);
    return { rows, submitted, total, unsubmitted: Math.max(total - submitted, 0), selectedCount };
  }

  function renderHeader(info, data, flags) {
    const status = document.getElementById('monthly-wishes-status');
    const detail = document.getElementById('monthly-wishes-detail');
    const link = document.getElementById('monthly-wishes-open');
    if (status) {
      status.textContent = info.label;
      status.className = `monthly-status ${info.className || ''}`;
    }
    if (detail) {
      if (state.loading) detail.textContent = '対象月の申込状況を読み込んでいます。';
      else if (state.error) detail.textContent = '申込状況を取得できませんでした。再読み込みを試してください。';
      else {
        const result = summary(data, flags);
        detail.textContent = `${info.detail}・提出済み ${result.submitted}名／全${result.total}名`;
      }
    }
    if (link) link.href = shiftCreateHref();
  }

  function renderStats(data, flags) {
    const el = document.getElementById('monthly-wishes-stats');
    if (!el) return;
    if (state.error) {
      el.innerHTML = ['提出済み', '未提出', '希望枠数'].map(label => `<div class="monthly-wish-stat"><small>${label}</small><b>—</b><span>取得エラー</span></div>`).join('');
      return;
    }
    if (state.loading || !data) {
      el.innerHTML = ['提出済み', '未提出', '希望枠数'].map(label => `<div class="monthly-wish-stat"><small>${label}</small><b>—</b><span>読み込み中</span></div>`).join('');
      return;
    }
    const result = summary(data, flags);
    el.innerHTML = [
      `<div class="monthly-wish-stat"><small>提出済み</small><b>${result.submitted}</b><span>全${result.total}名中</span></div>`,
      `<div class="monthly-wish-stat${result.unsubmitted ? ' alert' : ''}"><small>未提出</small><b>${result.unsubmitted}</b><span>${result.unsubmitted ? '確認が必要です' : '未提出者なし'}</span></div>`,
      `<div class="monthly-wish-stat"><small>希望枠数</small><b>${result.selectedCount}</b><span>提出された希望セル</span></div>`,
    ].join('');
  }

  function renderSubmitted(data, flags) {
    const list = document.getElementById('monthly-wishes-list');
    const resultLabel = document.getElementById('monthly-wishes-result');
    if (!list) return;
    if (state.loading) {
      if (resultLabel) resultLabel.textContent = '読み込み中';
      list.innerHTML = '<div class="monthly-wishes-loading">申込状況を読み込んでいます…</div>';
      return;
    }
    if (state.error) {
      if (resultLabel) resultLabel.textContent = '取得エラー';
      list.innerHTML = '<div class="monthly-wishes-error">申込状況を取得できませんでした。<br><button type="button" class="monthly-secondary-button" data-monthly-wishes-action="reload">再読み込み</button></div>';
      return;
    }
    if (!data) {
      if (resultLabel) resultLabel.textContent = 'タブを開くと取得';
      list.innerHTML = '<div class="monthly-wishes-empty">申込状況タブを開くと、対象月のデータを取得します。</div>';
      return;
    }
    const slots = slotsOf(data);
    const rows = wishRows(data, flags);
    if (resultLabel) resultLabel.textContent = `${rows.length}名を表示`;
    if (!slots.length) {
      list.innerHTML = '<div class="monthly-wishes-empty">この月の実施日枠がまだ設定されていません。日程タブで実施日を設定してください。</div>';
      return;
    }
    if (!rows.length) {
      list.innerHTML = '<div class="monthly-wishes-empty">提出済みの希望はありません。未提出者一覧と、希望確認画面を確認してください。</div>';
      return;
    }
    const header = '<div class="monthly-wishes-row header" role="row"><div role="columnheader">氏名</div><div role="columnheader">希望時間</div><div role="columnheader">状態・コメント</div></div>';
    const body = rows.map(row => {
      const shownSlots = row.selected.slice(0, 3).map(escapeWish).join('・');
      const more = row.selected.length > 3 ? ` ほか${row.selected.length - 3}件` : '';
      const timeText = shownSlots ? `${shownSlots}${more}` : '希望枠なし';
      const comment = row.comment ? escapeWish(row.comment) : 'コメントなし';
      return `<div class="monthly-wishes-row" role="row"><div class="monthly-wish-person" role="cell">${escapeWish(row.name)}</div><div class="monthly-wish-times" role="cell"><strong>${row.selected.length}枠</strong><small>${timeText}</small></div><div class="monthly-wish-comment${row.comment ? '' : ' empty'}" role="cell"><span class="monthly-wish-state">提出済み</span><span>コメント：${comment}</span></div></div>`;
    }).join('');
    list.innerHTML = header + body;
  }

  function renderUnsubmitted(data, flags) {
    const count = document.getElementById('monthly-unsubmitted-count');
    const body = document.getElementById('monthly-unsubmitted-body');
    const list = document.getElementById('monthly-unsubmitted-list');
    const toggle = document.querySelector('[data-monthly-wishes-action="toggle-unsubmitted"]');
    if (!count || !body || !list || !toggle) return;
    if (state.loading || !data) {
      count.textContent = '確認中';
      list.innerHTML = '<div class="monthly-unsubmitted-note">未提出者を確認しています。</div>';
    } else if (state.error) {
      count.textContent = '確認不可';
      list.innerHTML = '<div class="monthly-unsubmitted-note">希望確認画面で未提出者を確認してください。</div>';
    } else {
      const result = summary(data, flags);
      const rows = unsubmittedRows(result.rows, flags);
      count.textContent = `${result.unsubmitted}名`;
      if (!rows.length && result.unsubmitted === 0) {
        list.innerHTML = '<div class="monthly-unsubmitted-note">未提出者はいません。</div>';
      } else if (!rows.length) {
        list.innerHTML = '<div class="monthly-unsubmitted-note">未提出者名簿を取得できませんでした。希望確認画面で確認してください。</div>';
      } else {
        list.innerHTML = rows.map(row => `<span class="monthly-unsubmitted-item">${escapeWish(row.name)}</span>`).join('');
      }
    }
    visible(body, state.unsubmittedOpen);
    toggle.classList.toggle('open', state.unsubmittedOpen);
    toggle.setAttribute('aria-expanded', state.unsubmittedOpen ? 'true' : 'false');
  }

  function renderMonthlyWishes() {
    const info = wishStatus();
    renderHeader(info, state.data, state.flags);
    renderStats(state.data, state.flags);
    renderSubmitted(state.data, state.flags);
    renderUnsubmitted(state.data, state.flags);
  }

  async function loadMonthlyWishes(force) {
    const key = contextKey();
    if (!key || !contextYear() || !contextMonth()) return;
    if (state.loading && state.key === key) return;
    if (!force && state.key === key && state.loaded) {
      renderMonthlyWishes();
      return;
    }
    if (state.loading && state.key !== key) {
      requestSeq++;
      state.loading = false;
    }
    const seq = ++requestSeq;
    state = { key, loading: true, loaded: false, error: '', data: null, flags: {}, unsubmittedOpen: state.unsubmittedOpen };
    setBusy(true);
    renderMonthlyWishes();
    let overlay = false;
    if (typeof showProc === 'function') {
      showProc('申込状況を読み込んでいます...', '提出済み・未提出の情報を確認しています');
      overlay = true;
    }
    try {
      if (typeof apiGet !== 'function') throw new Error('通信機能を読み込めませんでした');
      const params = wishParams();
      const flagsPromise = apiGet('getMemberFlags', { type: params.type }).catch(() => ({ ok: false, flags: {} }));
      const [wishRes, flagsRes] = await Promise.all([
        apiGet('getWishData', params),
        flagsPromise,
      ]);
      if (!wishRes || !wishRes.ok) throw new Error(wishRes && wishRes.error || '希望データの取得に失敗しました');
      if (seq !== requestSeq || key !== contextKey()) return;
      state.data = wishRes;
      state.flags = flagsRes && flagsRes.ok && flagsRes.flags && typeof flagsRes.flags === 'object' ? flagsRes.flags : {};
      state.loaded = true;
    } catch (error) {
      if (seq !== requestSeq) return;
      state.error = error && error.message ? error.message : '通信エラーが発生しました';
    } finally {
      if (seq !== requestSeq) return;
      state.loading = false;
      setBusy(false);
      if (overlay && typeof hideProc === 'function') hideProc();
      renderMonthlyWishes();
    }
  }

  function toggleMonthlyWishesUnsubmitted() {
    state.unsubmittedOpen = !state.unsubmittedOpen;
    renderUnsubmitted(state.data, state.flags);
  }

  window.renderMonthlyWishes = renderMonthlyWishes;
  window.loadMonthlyWishes = loadMonthlyWishes;
  window.toggleMonthlyWishesUnsubmitted = toggleMonthlyWishesUnsubmitted;
})();
