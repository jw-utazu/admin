// ============================================================
// 月次運用・シフト一覧／確認（フェーズ4）
// 詳細な配置編集と公開操作は shift-create.html に残し、ここでは
// 対象月の作成結果・確認状況・実施枠を実データで確認できるようにする。
// ============================================================
(function () {
  let state = {
    key: '', loading: false, loaded: false, error: '', data: null, status: null,
    approversOpen: true,
  };
  let requestSeq = 0;

  function escapeShift(value) {
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

  function shiftParams() {
    return { year: contextYear(), month: contextMonth(), type: contextType() };
  }

  function shiftCreateHref() {
    const type = contextType();
    const params = new URLSearchParams({ year: String(contextYear()), month: String(contextMonth()) });
    if (type !== 'normal') params.set('type', type);
    return `./shift-create.html?${params.toString()}`;
  }

  function datesOf(data) {
    return data && Array.isArray(data.dates) ? data.dates : [];
  }

  function statusInfo(status) {
    if (!status) return { label: '確認中', className: '', detail: '対象月の公開状態を確認しています。' };
    if (status.notified) {
      return { label: '公開済み', className: 'done', detail: '確認者の確認が完了し、奉仕者へ公開されています。' };
    }
    if (status.rejected && !status.published) {
      const rejected = typeof status.rejected === 'object' ? status.rejected : {};
      const by = rejected.by ? `（${rejected.by}）` : '';
      return { label: '差し戻し', className: 'alert', detail: `確認者から修正依頼があります${by}。シフト管理アプリで内容を確認してください。` };
    }
    if (status.approvedAll) {
      return { label: '確認完了', className: 'wait', detail: status.openDate ? `確認完了。公開予定日：${status.openDate}` : '確認が完了しました。公開条件を確認してください。' };
    }
    if (status.published) {
      const required = Number(status.required || 0);
      const approved = Number(status.approvedCount || 0);
      return { label: '確認待ち', className: 'wait', detail: required > 0 ? `作成完了。確認者 ${approved}/${required}名の確認が完了しています。` : '作成完了。公開前の確認を進めてください。' };
    }
    return { label: '作成中', className: 'current', detail: 'シフトを作成中です。配置を続ける場合はシフト管理アプリを開いてください。' };
  }

  function rowStatus(status) {
    const info = statusInfo(status);
    if (status && status.notified) return { label: '公開済み', className: 'done' };
    if (status && status.rejected && !status.published) return { label: '差し戻し', className: 'alert' };
    if (status && status.approvedAll) return { label: '公開待ち', className: 'wait' };
    if (status && status.published) return { label: '確認待ち', className: 'wait' };
    return { label: info.label === '確認中' ? '状態確認中' : info.label, className: info.className };
  }

  function placeNames(data, block) {
    const candidates = [];
    if (Array.isArray(block && block.usedPlaces)) candidates.push(...block.usedPlaces);
    if (block && block.place && typeof block.place === 'object') candidates.push(block.place.p1, block.place.p2);
    const names = candidates.map(value => {
      if (value && typeof value === 'object') return value.name || value.label || '';
      return value;
    }).map(value => String(value || '').trim()).filter(Boolean);
    if (names.length) return [...new Set(names)];
    const locations = data && Array.isArray(data.locations) ? data.locations : [];
    return [...new Set(locations.filter(location => location && !location.startYM && !location.endYM).map(location => {
      if (typeof location === 'string') return location;
      return location && (location.name || location.label) || '';
    }).map(value => String(value).trim()).filter(Boolean))];
  }

  function uidList(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(String);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (value && Array.isArray(value.uids)) return value.uids.filter(Boolean).map(String);
    return [];
  }

  function slotCells(slot) {
    if (!slot || !slot.places) return [];
    if (Array.isArray(slot.places)) return slot.places;
    if (typeof slot.places === 'object') return Object.values(slot.places);
    return [];
  }

  function blockSummary(data, block) {
    const assigned = new Set();
    let assignmentCount = 0;
    let emptyCount = 0;
    (block && Array.isArray(block.slots) ? block.slots : []).forEach(slot => {
      slotCells(slot).forEach(cell => {
        const uids = uidList(cell);
        if (!uids.length) emptyCount++;
        assignmentCount += uids.length;
        uids.forEach(uid => assigned.add(uid));
      });
    });
    const places = placeNames(data, block);
    return {
      assignmentCount,
      uniqueAssigned: assigned.size,
      emptyCount,
      places,
      slots: block && Array.isArray(block.slots) ? block.slots.length : 0,
    };
  }

  function dateParts(value) {
    const hit = String(value || '').match(/(\d{1,2})\D+(\d{1,2})/);
    return hit ? { month: Number(hit[1]), day: Number(hit[2]) } : { month: 99, day: 99 };
  }

  function timeValue(value) {
    const hit = String(value || '').match(/(\d{1,2}):(\d{2})/);
    return hit ? Number(hit[1]) * 60 + Number(hit[2]) : 9999;
  }

  function sortedBlocks(data) {
    return datesOf(data).map((block, index) => ({ block, index, summary: blockSummary(data, block) })).sort((a, b) => {
      const da = dateParts(a.block && a.block.date);
      const db = dateParts(b.block && b.block.date);
      return da.month - db.month || da.day - db.day || timeValue(a.block && a.block.time) - timeValue(b.block && b.block.time) || a.index - b.index;
    });
  }

  function dateText(block) {
    const date = String(block && block.date || '日付未設定');
    const weekday = block && block.weekday ? `（${block.weekday}）` : '';
    return date + weekday;
  }

  function renderHeader(info) {
    const status = document.getElementById('monthly-shifts-status');
    const detail = document.getElementById('monthly-shifts-detail');
    const link = document.getElementById('monthly-shifts-open');
    if (status) {
      status.textContent = info.label;
      status.className = `monthly-status ${info.className || ''}`;
    }
    if (detail) {
      if (state.loading) detail.textContent = '対象月のシフトを読み込んでいます。';
      else if (state.error) detail.textContent = 'シフト一覧を取得できませんでした。再読み込みを試してください。';
      else detail.textContent = info.detail;
    }
    if (link) {
      link.href = shiftCreateHref();
      const status = state.status;
      const label = !status ? 'シフト管理アプリを開く'
        : status.notified ? '公開済みシフトを確認する'
        : status.rejected && !status.published ? '差し戻し内容を確認する'
        : status.approvedAll ? '公開条件を確認する'
        : status.published ? '確認状況を確認する'
        : 'シフト作成を続ける';
      link.innerHTML = escapeShift(label) + ' <span>›</span>';
    }
  }

  function statCard(label, value, note, alert) {
    return `<div class="monthly-shift-stat${alert ? ' alert' : ''}"><small>${escapeShift(label)}</small><b>${escapeShift(value)}</b><span>${escapeShift(note)}</span></div>`;
  }

  function renderStats(data) {
    const el = document.getElementById('monthly-shifts-stats');
    if (!el) return;
    if (state.loading || !data) {
      el.innerHTML = [
        statCard('実施日', '—', '読み込み中'),
        statCard('時間帯', '—', '読み込み中'),
        statCard('配置件数', '—', '読み込み中'),
      ].join('');
      return;
    }
    const rows = sortedBlocks(data);
    const days = new Set(rows.map(row => `${row.block.date}(${row.block.weekday || ''})`));
    const assignments = rows.reduce((sum, row) => sum + row.summary.assignmentCount, 0);
    const empty = rows.reduce((sum, row) => sum + row.summary.emptyCount, 0);
    el.innerHTML = [
      statCard('実施日', days.size, days.size ? '設定済みの日数' : '実施日未設定'),
      statCard('時間帯', rows.length, rows.length ? '作成対象の時間帯' : '時間帯未設定'),
      statCard('配置件数', assignments, empty ? `未配置セル ${empty}件` : '未配置セルなし', !!empty),
    ].join('');
  }

  function renderList(data) {
    const list = document.getElementById('monthly-shifts-list');
    const result = document.getElementById('monthly-shifts-result');
    if (!list) return;
    if (state.loading) {
      if (result) result.textContent = '読み込み中';
      list.innerHTML = '<div class="monthly-shifts-loading">シフト一覧を読み込んでいます…</div>';
      return;
    }
    if (state.error) {
      if (result) result.textContent = '取得エラー';
      list.innerHTML = '<div class="monthly-shifts-error">シフト一覧を取得できませんでした。<br><button type="button" class="monthly-secondary-button" data-monthly-shifts-action="reload">再読み込み</button></div>';
      return;
    }
    if (!data) {
      if (result) result.textContent = 'タブを開くと取得';
      list.innerHTML = '<div class="monthly-shifts-empty">シフト一覧タブを開くと、対象月のデータを取得します。</div>';
      return;
    }
    const rows = sortedBlocks(data);
    if (result) result.textContent = `${rows.length}枠を表示`;
    if (!rows.length) {
      list.innerHTML = '<div class="monthly-shifts-empty">対象月の実施日・時間帯はまだ設定されていません。日程タブで実施日を設定してください。</div>';
      return;
    }
    const stateForRows = rowStatus(state.status);
    list.innerHTML = rows.map(row => {
      const block = row.block || {};
      const summary = row.summary;
      const placeText = summary.places.length ? summary.places.join('・') : '場所設定なし';
      const assignmentText = summary.assignmentCount
        ? `配置 ${summary.assignmentCount}件・${summary.uniqueAssigned}名`
        : '未配置';
      const emptyText = summary.emptyCount ? `・未配置セル ${summary.emptyCount}件` : '';
      const time = block.time || (block.slots || []).map(slot => slot.time).filter(Boolean).join('・') || '時間帯未設定';
      const rowLabel = dateText(block) + ' ' + time + 'を含む対象月のシフト管理を開く';
      return '<a class="monthly-shift-row" href="' + escapeShift(shiftCreateHref()) + '" target="_blank" rel="noopener" aria-label="' + escapeShift(rowLabel) + '">' +
        '<span class="monthly-shift-date"><strong>' + escapeShift(dateText(block)) + '</strong><small>' + escapeShift(time) + '</small></span>' +
        '<span class="monthly-shift-detail"><strong>' + escapeShift(placeText) + '</strong><small>' + escapeShift(assignmentText + emptyText) + '</small></span>' +
        '<span class="monthly-status ' + escapeShift(stateForRows.className || '') + '">' + escapeShift(stateForRows.label) + '</span>' +
        '<span class="monthly-shift-row-action" aria-hidden="true">対象月を開く ›</span></a>';
    }).join('');
  }

  function renderApprovers(status) {
    const count = document.getElementById('monthly-shifts-approver-count');
    const body = document.getElementById('monthly-shift-approvers-body');
    const list = document.getElementById('monthly-shift-approvers');
    const toggle = document.querySelector('[data-monthly-shifts-action="toggle-approvers"]');
    if (!count || !body || !list || !toggle) return;
    if (state.loading || !status) {
      count.textContent = '確認中';
      list.innerHTML = '<div class="monthly-shift-note">確認者の状態を読み込んでいます。</div>';
    } else if (state.error) {
      count.textContent = '確認不可';
      list.innerHTML = '<div class="monthly-shift-note">公開状態を取得できませんでした。シフト管理アプリで確認してください。</div>';
    } else {
      const approvers = Array.isArray(status.approvers) ? status.approvers : [];
      const required = Number(status.required || approvers.length || 0);
      const approved = Number(status.approvedCount || approvers.filter(item => item && item.approved).length || 0);
      count.textContent = required ? `${approved}/${required}名` : '確認者なし';
      if (status.approvalSkipped) {
        list.innerHTML = `<div class="monthly-shift-note">オーナーによる確認省略で公開できます。${escapeShift(status.doneByName || '')}</div>`;
      } else if (!approvers.length) {
        list.innerHTML = '<div class="monthly-shift-note">確認者は設定されていません。公開条件はシフト管理アプリで確認してください。</div>';
      } else {
        const rejected = status.rejected && !status.published && typeof status.rejected === 'object' ? status.rejected : null;
        const rejection = rejected
          ? `<div class="monthly-shift-note">差し戻し${rejected.note ? `：${escapeShift(rejected.note)}` : '：修正内容を確認してください。'}</div>`
          : '';
        list.innerHTML = rejection + approvers.map(item => {
          const name = String(item && item.name || '確認者');
          const approvedBy = item && item.approved;
          const at = item && item.at ? `・${item.at}` : '';
          return `<div class="monthly-approver-row"><span class="monthly-approver-mark ${approvedBy ? 'done' : ''}">${approvedBy ? '✓' : '○'}</span><span class="monthly-approver-name">${escapeShift(name)}</span><span class="monthly-approver-state ${approvedBy ? 'done' : ''}">${approvedBy ? `確認済み${escapeShift(at)}` : '未確認'}</span></div>`;
        }).join('');
      }
    }
    visible(body, state.approversOpen);
    toggle.classList.toggle('open', state.approversOpen);
    toggle.setAttribute('aria-expanded', state.approversOpen ? 'true' : 'false');
  }

  function renderMonthlyShifts() {
    const info = statusInfo(state.status);
    renderHeader(info);
    renderStats(state.data);
    renderList(state.data);
    renderApprovers(state.status);
  }

  function setBusy(on) {
    document.querySelectorAll('[data-monthly-tab], [data-monthly-shifts-action="reload"], [data-monthly-shifts-action="toggle-approvers"]').forEach(el => {
      if (el.tagName === 'BUTTON') el.disabled = on;
    });
  }

  async function loadMonthlyShifts(force) {
    const key = contextKey();
    if (!key || !contextYear() || !contextMonth()) return;
    if (state.loading && state.key === key) return;
    if (!force && state.key === key && state.loaded) {
      renderMonthlyShifts();
      return;
    }
    if (state.loading && state.key !== key) requestSeq++;
    const seq = ++requestSeq;
    state = { key, loading: true, loaded: false, error: '', data: null, status: null, approversOpen: state.approversOpen };
    setBusy(true);
    renderMonthlyShifts();
    let overlay = false;
    if (typeof showProc === 'function') {
      showProc('シフト一覧を読み込んでいます...', '作成結果・確認状況・実施枠を確認しています');
      overlay = true;
    }
    try {
      if (typeof apiGet !== 'function') throw new Error('通信機能を読み込めませんでした');
      const params = shiftParams();
      const [shiftRes, statusRes] = await Promise.all([
        apiGet('getShiftCreateData', params),
        apiGet('getShiftPublishStatus', params),
      ]);
      if (!shiftRes || !shiftRes.ok) throw new Error(shiftRes && shiftRes.error || 'シフトデータの取得に失敗しました');
      if (!statusRes || !statusRes.ok) throw new Error(statusRes && statusRes.error || '公開状態の取得に失敗しました');
      if (seq !== requestSeq || key !== contextKey()) return;
      state.data = shiftRes;
      state.status = statusRes;
      state.loaded = true;
    } catch (error) {
      if (seq !== requestSeq) return;
      state.error = error && error.message ? error.message : '通信エラーが発生しました';
    } finally {
      if (seq !== requestSeq) return;
      state.loading = false;
      setBusy(false);
      if (overlay && typeof hideProc === 'function') hideProc();
      renderMonthlyShifts();
    }
  }

  function toggleMonthlyShiftsApprovers() {
    state.approversOpen = !state.approversOpen;
    renderApprovers(state.status);
  }

  window.renderMonthlyShifts = renderMonthlyShifts;
  window.loadMonthlyShifts = loadMonthlyShifts;
  window.toggleMonthlyShiftsApprovers = toggleMonthlyShiftsApprovers;
})();
