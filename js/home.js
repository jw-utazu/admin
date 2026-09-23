// ============================================================
// 新ホーム（フェーズ1）
//
// 月次状態は index.js の状態を読み、既存のカレンダー・モーダル・別ページへ接続する。
// 対応一覧だけは既存の getRequests / getBugReports / getRecoveryRequests を使って
// 選択一覧を作る。承認・対応済みなどの更新は従来の関数に委譲する。
// ============================================================
(function () {
  const HOME_DOW = ['月', '火', '水', '木', '金', '土', '日'];
  let homeInboxCounts = null;
  let homeView = 'home';
  let toolReturnView = 'home';
  const inboxState = {
    filter: 'all', statusFilter: 'pending', selectedKey: '', loading: false, loaded: false,
    errors: {}, items: { recovery: [], requests: [], bugs: [] },
  };

  function escapeHome(value) {
    if (typeof escHtml === 'function') return escHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function setHomeVisible(el, visible) {
    if (typeof setVisible === 'function') setVisible(el, visible);
    else if (el) el.classList.toggle('is-hidden', !visible);
  }

  function dateKey(value) {
    if (!value || !value.y || !value.m || !value.d) return '';
    return [value.y, String(value.m).padStart(2, '0'), String(value.d).padStart(2, '0')].join('-');
  }

  function dateLabel(value, includeWeekday) {
    if (!value || !value.y || !value.m || !value.d) return '未設定';
    const dt = new Date(value.y, value.m - 1, value.d);
    const weekday = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
    return `${value.m}/${value.d}${includeWeekday ? `（${HOME_DOW[weekday]}）` : ''}`;
  }

  function fullDateLabel(value) {
    if (!value) return '未設定';
    const dt = new Date(value.y, value.m - 1, value.d);
    const weekday = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
    return `${value.m}月${value.d}日（${HOME_DOW[weekday]}）`;
  }

  function dateAtStart(value) {
    if (!value || !value.y || !value.m || !value.d) return null;
    const dt = new Date(value.y, value.m - 1, value.d);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function isPast(value) {
    const dt = dateAtStart(value);
    if (!dt) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today > dt;
  }

  function currentPwLabel() {
    if (currentPwType === 'normal') return '通常PW';
    const slot = (limitedSlots || []).find(item => item.id === currentPwType);
    return slot && slot.name ? slot.name : '限定PW';
  }

  function stripIconMarkup(value) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  function renderHomeIcons() {
    if (typeof ic !== 'function') return;
    document.querySelectorAll('[data-home-icon]').forEach(el => {
      const markup = ic(el.dataset.homeIcon);
      if (markup) el.innerHTML = markup;
    });
  }

  function statusForCurrentMonth() {
    const hasDates = !!(dates && dates.apply && dates.deadline && dates.open);
    const limitedPhase = currentPwType !== 'normal' && Array.isArray(adminPhases)
      ? adminPhases[currentPhaseIndex] : null;
    const limitedPhaseSlots = limitedPhase && Array.isArray(limitedPhase.slots) ? limitedPhase.slots : [];
    const approval = typeof isCalApprovalForCurMonth === 'function' && isCalApprovalForCurMonth()
      ? calApproval : null;
    const shift = typeof isShiftStatusForCurMonth === 'function' && isShiftStatusForCurMonth()
      ? shiftStatus : null;
    const calendarOn = typeof isCurMonthPublished === 'function' && isCurMonthPublished();
    const calendarMoved = !!(calPubYM && (calPubYM.y > curY || (calPubYM.y === curY && calPubYM.m > curM)));
    const created = !!(shift && shift.published);
    const approved = !!(shift && shift.approvedAll);
    const notified = !!(shift && shift.notified);
    const scheduleReady = hasDates && (calendarOn || calendarMoved || created || !!(approval && (approval.ready || approval.approved)));
    const wishesDone = scheduleReady && (isPast(dates.deadline) || created || approved || notified);

    if (currentPwType !== 'normal') {
      const hasSlots = limitedPhaseSlots.length > 0;
      return {
        stages: [
          { label: '対象期間', state: 'done', sub: `${curY}年${curM}月` },
          { label: '実施日', state: hasSlots ? 'done' : 'current', sub: hasSlots ? `${slots.length}枠` : '未設定' },
          { label: '希望', state: 'todo', sub: '限定PW' },
          { label: '確認', state: 'todo', sub: '未確認' },
          { label: '公開', state: 'todo', sub: '状態を確認' },
        ],
        current: hasSlots ? '実施日を確認中' : '実施日が未設定',
        normal: false,
        hasSlots,
        shift,
      };
    }

    const stages = [
      { label: '日程設定', state: scheduleReady ? 'done' : 'current', sub: hasDates ? '設定済み' : '未設定', dateKind: 'apply' },
      { label: '希望受付', state: !scheduleReady ? 'todo' : wishesDone ? 'done' : 'current', sub: dates.deadline ? `締切 ${dateLabel(dates.deadline, false)}` : '未設定', dateKind: 'deadline' },
      { label: 'シフト作成', state: !wishesDone ? 'todo' : created ? 'done' : 'current', sub: created ? '作成完了' : '未完了' },
      { label: '確認', state: !created ? 'todo' : approved ? 'done' : 'wait', sub: !created ? '未開始' : approved ? '確認完了' : '確認待ち' },
      { label: '公開', state: !approved ? 'todo' : notified ? 'done' : 'current', sub: notified ? '公開済み' : dates.open ? `予定 ${dateLabel(dates.open, false)}` : '公開待ち', dateKind: 'open' },
    ];
    let current = '日程を設定する';
    if (scheduleReady && !wishesDone) current = '希望受付中';
    if (wishesDone && !created) current = 'シフト作成中';
    if (created && !approved) current = '確認待ち';
    if (approved && !notified) current = '公開待ち';
    if (notified) current = '公開済み';
    return { stages, current, normal: true, hasDates, approval, shift, created, approved, notified, calendarOn, wishesDone };
  }

  function primaryActionForMonth(state) {
    if (!state.normal) {
      return {
        status: state.hasSlots ? '実施日設定済み' : '実施日未設定',
        statusClass: state.hasSlots ? 'current' : 'alert',
        title: state.hasSlots ? '限定PWの実施日を確認する' : '限定PWの実施日を設定する',
        detail: state.hasSlots
          ? '選択中のフェーズの実施日と時間帯を確認します。'
          : '月次運用で対象フェーズの申込日・締切日・実施日を設定します。',
        action: 'monthly',
        label: state.hasSlots ? 'フェーズを確認する' : '日程を設定する',
      };
    }
    if (!state.hasDates) {
      return {
        status: '日程未設定', statusClass: 'alert',
        title: '日程を設定して、月の作業を始める',
        detail: '申込開始・希望締切・シフト公開日を確認してから、承認へ進みます。',
        action: 'monthly', label: '日程を設定する',
      };
    }

    if (state.normal && typeof calStageInfo === 'function') {
      const info = calStageInfo();
      const text = stripIconMarkup(info && info.text);
      if (info && text && text.indexOf('非公開') < 0) {
        return {
          status: state.current, statusClass: state.current === '確認待ち' ? 'wait' : 'current',
          title: text, detail: info.title || '月次運用で現在の状態と次の操作を確認します。',
          action: 'calendar-stage', label: text,
        };
      }
    }

    if (!state.shift) {
      return {
        status: state.current, statusClass: 'current',
        title: 'シフト管理アプリで作成を続ける', detail: '希望を確認しながら、担当者と役割を割り当てます。',
        action: 'shift', label: 'シフト作成を開く',
      };
    }
    if (!state.created) {
      return {
        status: 'シフト作成中', statusClass: 'current',
        title: 'シフト作成を続ける', detail: '作成中のシフトを確認し、必要な配置を完了させます。',
        action: 'shift', label: 'シフト作成を続ける',
      };
    }
    if (!state.approved) {
      return {
        status: '確認待ち', statusClass: 'wait',
        title: '確認状況を確認する', detail: '確認者の状況を確認し、必要ならシフト管理アプリへ戻ります。',
        action: 'shift', label: '確認状況を見る',
      };
    }
    if (!state.notified) {
      return {
        status: '公開待ち', statusClass: 'wait',
        title: '公開条件を確認する', detail: dates.open ? `${fullDateLabel(dates.open)}に自動公開されます。` : '公開条件を確認します。',
        action: 'shift', label: '公開条件を見る',
      };
    }
    return {
      status: '公開済み', statusClass: 'done',
      title: '公開済み。次の月の準備を確認する', detail: '公開済みのシフトを確認し、必要な対応が残っていないか確認します。',
      action: 'monthly', label: '月次運用を開く',
    };
  }

  function renderHomeProgress(state) {
    const list = document.getElementById('home-progress');
    if (!list) return;
    list.innerHTML = state.stages.map((stage, index) => {
      const mark = stage.state === 'done' ? '✓' : String(index + 1);
      // 日程に対応する段は、その日程を何日にするか決める入口にする
      const kindAttr = stage.dateKind
        ? ` data-home-date-kind="${escapeHome(stage.dateKind)}" role="button" tabindex="0" title="タップして日付を変更"`
        : '';
      return `<li class="${escapeHome(stage.state)}${stage.dateKind ? ' is-editable' : ''}"${kindAttr}><span class="home-progress-dot">${mark}</span><b>${escapeHome(stage.label)}</b><small>${escapeHome(stage.sub || '')}</small></li>`;
    }).join('');
    const title = document.getElementById('home-progress-title');
    if (title) {
      const remaining = state.stages.filter(stage => stage.state !== 'done').length;
      title.textContent = remaining ? `公開まであと${remaining}段階` : '今月の作業が完了';
    }
  }

  function eventMap() {
    const events = new Map();
    const limitedPhase = currentPwType !== 'normal' && Array.isArray(adminPhases)
      ? adminPhases[currentPhaseIndex] : null;
    const calendarDates = currentPwType === 'normal' ? (dates || {}) : (limitedPhase || {});
    const calendarSlots = currentPwType === 'normal'
      ? (Array.isArray(slots) ? slots : [])
      : (limitedPhase && Array.isArray(limitedPhase.slots) ? limitedPhase.slots : []);
    // dateKind は「申込開始日などを何日にするか」を選ぶ入口に使う種別キー
    const add = (value, label, kind, detail, dateKind) => {
      const key = dateKey(value);
      if (!key) return;
      const current = events.get(key) || { value, labels: [], kinds: [], details: [], dateKinds: [] };
      if (!current.labels.includes(label)) current.labels.push(label);
      if (!current.kinds.includes(kind)) current.kinds.push(kind);
      if (detail && !current.details.includes(detail)) current.details.push(detail);
      if (dateKind && !current.dateKinds.includes(dateKind)) current.dateKinds.push(dateKind);
      events.set(key, current);
    };
    add(calendarDates.apply, '受付', 'green', '申込開始', 'apply');
    add(calendarDates.deadline, '締切', 'amber', '希望締切', 'deadline');
    add(calendarDates.open, '公開', 'amber', 'シフト公開', 'open');
    calendarSlots.forEach(slot => add(slot, '実施', 'blue', slot.time || '実施日', 'slot'));
    return events;
  }

  function renderHomeCalendar() {
    const grid = document.getElementById('home-calendar-grid');
    const title = document.getElementById('home-calendar-title');
    const list = document.getElementById('home-schedule-list');
    if (!grid || !list) return;
    const events = eventMap();
    if (title) title.textContent = `${curY}年${curM}月`;
    grid.setAttribute('aria-label', `${curY}年${curM}月の日程`);
    const html = HOME_DOW.map((day, index) => `<span class="home-calendar-head ${index === 6 ? 'sun' : index === 5 ? 'sat' : ''}" role="columnheader">${day}</span>`).join('');
    const first = new Date(curY, curM - 1, 1);
    const days = new Date(curY, curM, 0).getDate();
    const cells = [];
    const firstOffset = first.getDay() === 0 ? 6 : first.getDay() - 1;
    for (let i = 0; i < firstOffset; i += 1) cells.push('<span class="home-calendar-empty" aria-hidden="true"></span>');
    for (let day = 1; day <= days; day += 1) {
      const value = { y: curY, m: curM, d: day };
      const key = dateKey(value);
      const event = events.get(key);
      const kind = event && (event.kinds.includes('blue') ? 'blue' : event.kinds.includes('green') ? 'green' : 'amber');
      const mark = event ? `<span class="home-day-mark ${kind}">${escapeHome(event.labels.join('・'))}</span>` : '';
      const aria = `${dateLabel(value, true)}${event ? ` ${event.labels.join('・')}` : ''}`;
      cells.push(`<button type="button" class="home-day${event ? ' has-event' : ''}" data-home-day="${key}" role="gridcell" aria-label="${escapeHome(aria)}"><span class="home-day-number">${day}</span>${mark}</button>`);
    }
    while (cells.length % 7) cells.push('<span class="home-calendar-empty" aria-hidden="true"></span>');
    grid.innerHTML = html + cells.join('');

    const rows = [...events.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, event]) => {
      const kind = event.kinds.includes('blue') ? 'blue' : event.kinds.includes('green') ? 'green' : 'amber';
      // 基準日が1つだけの行は、その日程を何日にするか選び直す入口にする
      const dateKinds = event.dateKinds || [];
      const dateKind = dateKinds.length === 1 && dateKinds[0] !== 'slot' ? dateKinds[0] : '';
      const attr = dateKind
        ? `data-home-date-kind="${dateKind}" title="タップして日付を変更"`
        : `data-home-day="${dateKey(event.value)}"`;
      return `<button type="button" class="home-schedule-row" ${attr}><span class="home-schedule-date">${escapeHome(dateLabel(event.value, true))}</span><span><b>${escapeHome(event.labels.join('・'))}</b><small>${escapeHome(event.details.join('・'))}</small></span><span class="home-dot ${kind}"></span></button>`;
    });
    list.innerHTML = rows.length ? rows.join('') : '<div class="home-empty">この月の実施日・日程はまだ設定されていません。</div>';
  }

  function attentionRows() {
    return [
      { key: 'calApproval', label: '予定表の対応待ち', icon: '◷', action: 'calendar-stage', detail: '承認・公開状態を確認' },
      { key: 'recovery', label: 'ログイン救済', icon: '!', action: 'recovery', detail: '未対応の救済依頼' },
      { key: 'requests', label: '要望', icon: '要', action: 'requests', detail: '未対応の要望' },
      { key: 'bugs', label: 'バグ報告', icon: '不', action: 'bugs', detail: '未対応の報告' },
      { key: 'distribution', label: '配布報告', icon: '記', action: 'distribution', detail: '今月の記録' },
    ];
  }

  function renderHomeAttention() {
    const list = document.getElementById('home-attention-list');
    const title = document.getElementById('home-attention-title');
    const normal = currentPwType === 'normal';
    const total = homeInboxCounts ? ['calApproval', 'recovery', 'requests', 'bugs'].reduce((sum, key) => sum + Number(homeInboxCounts[key] || 0), 0) : null;
    const badge = document.getElementById('home-nav-badge');
    const bottomBadge = document.getElementById('home-bottom-badge');
    [badge, bottomBadge].forEach(el => {
      if (!el) return;
      if (normal && total !== null && total > 0) { el.textContent = total; el.classList.remove('is-hidden'); }
      else el.classList.add('is-hidden');
    });
    if (!list || !title) return;
    if (!normal) {
      title.textContent = '通常PWで確認';
      list.innerHTML = '<div class="home-attention-empty">対応一覧は通常PWのホームから確認します。上のPW切替から通常PWを選択してください。</div>';
      return;
    }
    if (!homeInboxCounts) {
      title.textContent = '確認しています';
      list.innerHTML = '<div class="home-attention-empty">対応件数を読み込んでいます。</div>';
      return;
    }
    title.textContent = total ? `未対応 ${total}件` : '対応はありません';
    const rows = attentionRows().filter(row => Number(homeInboxCounts[row.key] || 0) > 0 || row.key === 'distribution' && Number(homeInboxCounts[row.key] || 0) > 0);
    if (!rows.length) {
      list.innerHTML = '<div class="home-attention-empty">現在、対応が必要なものはありません。</div>';
      return;
    }
    list.innerHTML = rows.map(row => {
      const count = Number(homeInboxCounts[row.key] || 0);
      const urgent = row.key !== 'distribution' && count > 0;
      return `<button type="button" class="home-attention-row" data-home-action="${row.action}"><span class="home-attention-icon${urgent ? ' urgent' : ''}">${row.icon}</span><span><b>${row.label}</b><small>${row.detail}</small></span><strong class="home-attention-count">${count}</strong><span class="home-attention-arrow">›</span></button>`;
    }).join('');
  }

  function renderInboxHub() {
    const pending = document.getElementById('inbox-pending-list');
    const records = document.getElementById('inbox-record-list');
    const lead = document.getElementById('inbox-context-lead');
    const totalEl = document.getElementById('inbox-workspace-total');
    const filters = document.getElementById('inbox-type-filters');
    const detail = document.getElementById('inbox-detail-body');
    if (!pending || !records || !lead || !totalEl || !filters || !detail) return;
    if (currentPwType !== 'normal') {
      lead.textContent = '対応一覧は通常PWのデータを表示します。';
      totalEl.textContent = '通常PW';
      pending.innerHTML = '<div class="home-hub-empty"><p>通常PWに切り替えると、対応件数を確認できます。</p><button type="button" class="home-button secondary" data-home-context="pw">通常PWを選ぶ</button></div>';
      filters.innerHTML = '';
      detail.innerHTML = '<div class="home-hub-empty">通常PWの対応項目を選ぶと、ここに詳細を表示します。</div>';
      records.innerHTML = '<div class="home-hub-empty">配布報告は通常PWで確認します。</div>';
      renderHomeIcons();
      return;
    }
    const items = inboxItems();
    const pendingCount = items.filter(item => item.status === '未対応' || item.status === 'pending').length;
    const total = items.length;
    lead.textContent = inboxState.loading
      ? 'ログイン救済・要望・バグ報告を読み込んでいます。'
      : inboxState.loaded
        ? `${total}件の項目から種類を絞り、選択した内容を確認できます。${Object.keys(inboxState.errors).length ? ` ${Object.keys(inboxState.errors).length}種類は取得できていません。` : ''}`
        : '対応一覧を開くと、既存の申請・報告を読み込みます。';
    totalEl.textContent = inboxState.loading ? '読み込み中' : `未対応 ${pendingCount}件／全${total}件`;
    const filterOptions = [
      { id: 'all', label: 'すべて' },
      { id: 'recovery', label: 'ログイン救済' },
      { id: 'requests', label: '要望' },
      { id: 'bugs', label: 'バグ報告' },
    ];
    const statusFilters = [
      { id: 'pending', label: '未対応のみ', count: pendingCount },
      { id: 'all', label: '全状態', count: total },
    ];
    filters.innerHTML = '<span class="inbox-filter-group-label">状態</span>' + statusFilters.map(option =>
      '<button type="button" class="inbox-filter' + (inboxState.statusFilter === option.id ? ' active' : '') + '" data-inbox-status="' + option.id + '" aria-pressed="' + (inboxState.statusFilter === option.id) + '">' + option.label + '<span class="inbox-filter-count">' + option.count + '</span></button>'
    ).join('') + '<span class="inbox-filter-divider" aria-hidden="true"></span><span class="inbox-filter-group-label">種類</span>' + filterOptions.map(option => {
      const count = option.id === 'all' ? total : inboxState.errors[option.id] ? '—' : inboxState.items[option.id].length;
      return `<button type="button" class="inbox-filter${inboxState.filter === option.id ? ' active' : ''}" data-inbox-filter="${option.id}" aria-pressed="${inboxState.filter === option.id}">${option.label}<span class="inbox-filter-count">${count}</span></button>`;
    }).join('');
    if (inboxState.loading) {
      pending.innerHTML = '<div class="home-hub-empty">対応項目を読み込んでいます。</div>';
      detail.innerHTML = '<div class="home-hub-empty">読み込みが終わると、項目を選択できます。</div>';
    } else if (!inboxState.loaded) {
      pending.innerHTML = '<div class="home-hub-empty">読み込みを開始しています。</div>';
      detail.innerHTML = '<div class="home-hub-empty">一覧から項目を選択すると、ここに詳細を表示します。</div>';
    } else {
      const visibleItems = items
        .filter(item => inboxState.filter === 'all' || item.kind === inboxState.filter)
        .filter(item => inboxState.statusFilter === 'all' || isInboxPending(item))
        .sort((a, b) => {
          const pendingA = isInboxPending(a);
          const pendingB = isInboxPending(b);
          if (pendingA !== pendingB) return pendingA ? -1 : 1;
          return (Date.parse(b.sortAt || '') || 0) - (Date.parse(a.sortAt || '') || 0);
        });
      if (!visibleItems.length) {
        const hasErrors = Object.keys(inboxState.errors).length > 0;
        const emptyText = hasErrors
          ? '取得できた項目はありません。再読み込みするか、種類別の既存画面を開いてください。'
          : inboxState.statusFilter === 'pending' ? '未対応の項目はありません。全状態に切り替えると、対応済みの項目も表示します。' : 'この種類の項目はありません。';
        pending.innerHTML = '<div class="home-hub-empty">' + emptyText + '</div>';
        detail.innerHTML = hasErrors
          ? `<div class="home-hub-empty">${Object.entries(inboxState.errors).map(([kind, message]) => `<p>${escapeHome(inboxTypeLabel(kind))}：${escapeHome(message)}</p>`).join('')}</div>`
          : '<div class="home-hub-empty">項目がありません。</div>';
      } else {
        let selected = visibleItems.find(item => item.key === inboxState.selectedKey);
        if (!selected) {
          selected = visibleItems[0];
          inboxState.selectedKey = selected.key;
        }
        pending.innerHTML = visibleItems.map(item => {
          const status = inboxStatus(item);
          const iconClass = item.kind === 'recovery' ? 'recovery' : item.kind === 'bugs' ? 'bug' : 'request';
          return `<button type="button" class="inbox-item-row${item.key === inboxState.selectedKey ? ' selected' : ''}" data-inbox-item="${escapeHome(item.key)}" aria-pressed="${item.key === inboxState.selectedKey}"><span class="inbox-item-icon ${iconClass}" aria-hidden="true">${item.kind === 'recovery' ? '救' : item.kind === 'bugs' ? '!' : '要'}</span><span class="inbox-item-copy"><b>${escapeHome(item.name || '氏名未登録')}</b><small>${escapeHome(inboxTypeLabel(item.kind))} · ${escapeHome(item.date || '日付未登録')}</small></span><span class="inbox-item-status ${status.className}">${escapeHome(status.label)}</span></button>`;
        }).join('');
        detail.innerHTML = renderInboxDetail(selected);
      }
    }
    const distribution = Number(homeInboxCounts && homeInboxCounts.distribution || 0);
    const calendarCount = Number(homeInboxCounts && homeInboxCounts.calApproval || 0);
    records.innerHTML = `<button type="button" class="home-hub-row" data-home-action="calendar-stage"><span class="home-hub-icon" data-home-icon="calendar" aria-hidden="true"></span><span class="home-hub-row-copy"><b>予定表の承認・公開</b><small>対象月の状態と次の操作</small></span><span class="home-hub-row-count${calendarCount ? ' has-items' : ''}">${calendarCount || '対応なし'}</span><span class="home-hub-row-action">月次で開く ›</span></button><button type="button" class="home-hub-row" data-home-action="distribution"><span class="home-hub-icon neutral" data-home-icon="package" aria-hidden="true"></span><span class="home-hub-row-copy"><b>配布報告</b><small>対応件数に含めない記録</small></span><span class="home-hub-row-count neutral">${distribution}件</span><span class="home-hub-row-action">記録を見る ›</span></button>`;
    renderHomeIcons();
  }

  function inboxItems() {
    return [...inboxState.items.recovery, ...inboxState.items.requests, ...inboxState.items.bugs];
  }

  function inboxTypeLabel(kind) {
    return kind === 'recovery' ? 'ログイン救済' : kind === 'bugs' ? 'バグ報告' : '要望';
  }

  function inboxStatus(item) {
    if (item.kind === 'recovery') {
      if (item.status === 'pending') return { label: '未対応', className: 'pending' };
      if (item.status === 'approved') return { label: '承認済み', className: 'approved' };
      return { label: typeof recStatusLabel === 'function' ? recStatusLabel(item.status) : '完了', className: 'done' };
    }
    if (item.status === '未対応') return { label: '未対応', className: 'pending' };
    return { label: '対応済み', className: 'done' };
  }

  function isInboxPending(item) {
    if (!item) return false;
    if (item.kind === 'recovery') return item.status === 'pending';
    return item.status === '未対応' || item.status === 'pending';
  }

  function renderInboxDetail(item) {
    const status = inboxStatus(item);
    const title = item.kind === 'recovery' ? 'ログイン救済の申請' : inboxTypeLabel(item.kind);
    const body = item.kind === 'recovery'
      ? '<p class="inbox-detail-note">本人確認・承認・却下は、確認情報を重複表示しないため既存のログイン救済画面で行います。</p>'
      : `<div class="inbox-detail-body">${escapeHome(item.body || '本文はありません。')}</div>`;
    const actions = item.kind === 'recovery'
      ? '<button type="button" class="home-button primary" data-inbox-open="recovery">ログイン救済画面を開く</button>'
      : `<button type="button" class="home-button secondary" data-inbox-open="${item.kind}">既存の一覧を開く</button>${item.status === '未対応' ? `<button type="button" class="home-button primary" data-inbox-resolve="${item.kind}">対応済みにする</button>` : '<span class="inbox-status-note">対応済み</span>'}`;
    return `<article class="inbox-detail-card"><header class="inbox-detail-head"><div><p class="home-section-label">${escapeHome(inboxTypeLabel(item.kind))}</p><h3>${escapeHome(item.name || title)}</h3><div class="inbox-detail-meta"><span>${escapeHome(item.date || '日付未登録')}</span><span class="inbox-item-status ${status.className}">${escapeHome(status.label)}</span></div></div></header>${body}<div class="inbox-detail-actions">${actions}</div></article>`;
  }

  function normalizeInboxRows(kind, rows) {
    return (Array.isArray(rows) ? rows : []).map((row, index) => {
      if (kind === 'recovery') {
        const rawDate = String(row.created_at || '');
        return {
          kind, key: `${kind}:${String(row.id == null ? index : row.id)}`, id: row.id,
          name: String(row.name || '氏名未登録'), date: typeof fmtRecTime === 'function' ? (fmtRecTime(rawDate) || rawDate) : rawDate,
          sortAt: rawDate,
          status: String(row.status || ''),
        };
      }
      const id = row.rowIndex == null ? index : row.rowIndex;
      return {
        kind, key: `${kind}:${String(id)}`, rowIndex: id,
        name: String(row.name || '氏名未登録'), date: String(row.sentAt || ''), sortAt: String(row.sentAt || ''),
        body: String(row.body || ''), status: String(row.status || ''),
      };
    });
  }

  async function loadInboxWorkspace(force) {
    if (inboxState.loading || (!force && inboxState.loaded)) return;
    inboxState.loading = true;
    inboxState.errors = {};
    renderInboxHub();
    if (typeof showProc === 'function') showProc('対応一覧を読み込んでいます...', 'ログイン救済・要望・バグ報告を確認しています');
    try {
      const results = await Promise.allSettled([
        apiGet('getRequests'),
        apiGet('getBugReports'),
        apiPost({ action: 'getRecoveryRequests' }),
      ]);
      const apply = (index, kind, pick) => {
        const result = results[index];
        if (result.status === 'rejected') {
          inboxState.errors[kind] = result.reason && result.reason.message || '取得できませんでした';
          inboxState.items[kind] = [];
          return;
        }
        try {
          const value = result.value || {};
          if (value.ok === false) throw new Error(value.reason === 'unauthorized' ? '権限がありません' : (value.error || value.reason || '取得失敗'));
          inboxState.items[kind] = normalizeInboxRows(kind, pick(value));
        } catch (error) {
          inboxState.errors[kind] = error && error.message || '取得できませんでした';
          inboxState.items[kind] = [];
        }
      };
      apply(0, 'requests', value => value.requests);
      apply(1, 'bugs', value => value.reports);
      apply(2, 'recovery', value => value.requests);
      inboxState.loaded = true;
      const countPending = kind => inboxState.items[kind].filter(item => item.status === '未対応' || item.status === 'pending').length;
      const refreshedCounts = {};
      ['requests', 'bugs', 'recovery'].forEach(kind => {
        if (!inboxState.errors[kind]) refreshedCounts[kind] = countPending(kind);
      });
      homeInboxCounts = Object.assign({}, homeInboxCounts || {}, refreshedCounts);
      if (typeof setInboxCount === 'function') {
        Object.entries(refreshedCounts).forEach(([kind, count]) => setInboxCount(kind, count));
      }
      inboxState.loading = false;
      renderHomeAttention();
      renderInboxHub();
    } catch (error) {
      inboxState.loaded = true;
      inboxState.errors = { recovery: error && error.message || '取得できませんでした', requests: error && error.message || '取得できませんでした', bugs: error && error.message || '取得できませんでした' };
      inboxState.items = { recovery: [], requests: [], bugs: [] };
      inboxState.loading = false;
      renderInboxHub();
    } finally {
      inboxState.loading = false;
      if (typeof hideProc === 'function') hideProc();
    }
  }

  async function resolveInboxItem(kind) {
    const item = inboxItems().find(row => row.key === inboxState.selectedKey);
    if (!item || item.kind !== kind || item.status !== '未対応') return;
    if (kind === 'requests' && typeof window.resolveRequest === 'function') await window.resolveRequest(item.rowIndex);
    if (kind === 'bugs' && typeof window.resolveBugReport === 'function') await window.resolveBugReport(item.rowIndex);
  }

  function renderHomeAccount() {
    const nameEl = document.getElementById('home-account-name');
    const avatarEl = document.getElementById('home-avatar');
    const name = (_currentUser && (_currentUser.name || _currentUser.email)) || 'アカウント';
    if (nameEl) nameEl.textContent = name;
    if (avatarEl) avatarEl.textContent = [...name][0] || '?';
  }

  function renderAdminHome() {
    const view = document.getElementById('home-view');
    if (!view || typeof currentPwType === 'undefined') return;
    renderHomeIcons();
    const state = statusForCurrentMonth();
    const primary = primaryActionForMonth(state);
    const status = document.getElementById('home-current-status');
    const title = document.getElementById('home-next-title');
    const detail = document.getElementById('home-next-detail');
    const action = document.getElementById('home-primary-action');
    const lead = document.getElementById('home-context-lead');
    const pwChip = document.getElementById('home-pw-chip');
    const monthChip = document.getElementById('home-month-chip');
    if (status) { status.textContent = primary.status; status.className = `home-status ${primary.statusClass || ''}`; }
    if (title) title.textContent = primary.title;
    if (detail) detail.textContent = primary.detail;
    if (action) { action.dataset.homeAction = primary.action; action.innerHTML = `${escapeHome(primary.label)} <span>›</span>`; }
    if (lead) lead.textContent = `${curY}年${curM}月・${currentPwLabel()}の作業状況を表示しています。`;
    if (pwChip) pwChip.textContent = `${currentPwLabel()}⌄`;
    if (monthChip) monthChip.textContent = `${curY}年${curM}月⌄`;
    renderHomeProgress(state);
    renderHomeCalendar();
    renderHomeAttention();
    renderInboxHub();
    renderHomeAccount();
    if (typeof renderAdminMonthly === 'function') renderAdminMonthly();
  }

  function updateNavActive(view) {
    const navView = view === 'inbox' ? 'attention' : view;
    document.querySelectorAll('[data-home-nav]').forEach(button => {
      const target = button.dataset.homeNav;
      const mobileMore = view === 'inbox' && target === 'settings' && button.closest('.home-bottom-nav');
      const active = target === navView || !!mobileMore;
      button.classList.toggle('active', active);
    });
  }

  function loadHomeTool(view) {
    const frame = document.getElementById(view === 'shift' ? 'shift-workspace-frame' : 'territory-workspace-frame');
    if (!frame || frame.dataset.loaded === 'true') return;
    const wrap = frame.closest('[data-tool-frame-wrap]');
    const hideLoading = () => wrap && wrap.classList.remove('is-loading');
    if (wrap) wrap.classList.add('is-loading');
    frame.addEventListener('load', hideLoading, { once: true });
    if (view === 'shift') {
      const url = new URL(shiftCreateHref(), location.href);
      url.searchParams.set('embedded', '1');
      frame.src = url.toString();
    } else {
      frame.src = './territory/?embedded=1';
    }
    frame.dataset.loaded = 'true';
  }

  function returnFromAdminTool() {
    setAdminHomeView(toolReturnView);
  }

  function setAdminHomeView(view) {
    const app = document.getElementById('app');
    const home = document.getElementById('home-view');
    const pages = {
      home: document.getElementById('home-main'),
      monthly: document.getElementById('monthly-view'),
      inbox: document.getElementById('inbox-view'),
      settings: document.getElementById('settings-view'),
      shift: document.getElementById('shift-view'),
      territory: document.getElementById('territory-view'),
    };
    const layout = document.querySelector('.layout');
    const nextView = Object.prototype.hasOwnProperty.call(pages, view) ? view : 'home';
    const showWorkspace = true;
    const isToolView = nextView === 'shift' || nextView === 'territory';
    if (isToolView && homeView !== 'shift' && homeView !== 'territory') toolReturnView = homeView;
    homeView = nextView;
    if (app) app.classList.toggle('home-mode', showWorkspace);
    if (app) app.classList.toggle('home-tool-mode', isToolView);
    setHomeVisible(home, showWorkspace);
    Object.entries(pages).forEach(([key, page]) => setHomeVisible(page, key === nextView));
    setHomeVisible(layout, !showWorkspace);
    if (home) home.scrollTop = 0;
    updateNavActive(nextView);
    if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    if (nextView === 'home') renderAdminHome();
    else if (nextView === 'monthly' && typeof renderAdminMonthly === 'function') renderAdminMonthly();
    else if (nextView === 'inbox') {
      renderInboxHub();
      loadInboxWorkspace(false);
    }
    else if (isToolView) loadHomeTool(nextView);
    requestAnimationFrame(() => pages[nextView]?.focus({ preventScroll: true }));
  }

  function openMonthlyContext(kind) {
    setAdminHomeView('monthly');
    setTimeout(() => {
      if (kind === 'month' && typeof openYmPicker === 'function') openYmPicker(document.getElementById('monthly-calendar-month-button') || document.getElementById('cal-ym-label'));
      if (kind === 'pw' && typeof toggleMonthlyPwMenu === 'function') toggleMonthlyPwMenu();
    }, 0);
  }

  function openHomeDay(key) {
    const parts = String(key || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return;
    setAdminHomeView('monthly');
    setTimeout(() => {
      if (typeof openDaySelectModal === 'function') openDaySelectModal(parts[0], parts[1], parts[2]);
    }, 0);
  }

  function openExistingAction(action) {
    if (action === 'monthly') return setAdminHomeView('monthly');
    if (action === 'calendar-stage') {
      setAdminHomeView('monthly');
      return setTimeout(() => { if (typeof calStageAction === 'function') calStageAction(); }, 0);
    }
    if (action === 'shift') {
      return setAdminHomeView('shift');
    }
    if (action === 'territory') {
      return setAdminHomeView('territory');
    }
    const actions = {
      recovery: 'openRecoveryModal', requests: 'openRequestModal', bugs: 'openBugReportModal',
      distribution: 'openDistributionReportModal', member: 'openMemberModal', access: 'openAccessModal',
      position: 'openPositionModal', notice: 'openNoticeModal', photo: 'openPhotoMgmtModal',
      proxy: 'openProxyModal', couple: 'openCoupleModal', limited: 'openLimitedSettingsModal', logs: 'openLogModal',
    };
    if (action === 'manual' || action === 'pwa') {
      return setTimeout(() => {
        if (action === 'manual' && typeof openM === 'function') openM('m-manual');
        if (action === 'pwa' && typeof window.openPwaModal === 'function') window.openPwaModal();
      }, 0);
    }
    const fnName = actions[action];
    if (!fnName || typeof window[fnName] !== 'function') return;
    setTimeout(() => {
      if (action === 'photo') window[fnName]('exhibit');
      else window[fnName]();
    }, 0);
  }

  function shiftCreateHref() {
    const params = new URLSearchParams({ year: String(curY), month: String(curM) });
    if (currentPwType !== 'normal') params.set('type', currentPwType);
    return `./shift-create.html?${params.toString()}`;
  }

  function handleHomeClick(event) {
    const nav = event.target.closest('[data-home-nav]');
    if (nav) {
      event.preventDefault();
      const target = nav.dataset.homeNav;
      if (target === 'home') return setAdminHomeView('home');
      if (target === 'monthly') return setAdminHomeView('monthly');
      if (target === 'shift') return openExistingAction('shift');
      if (target === 'territory') return openExistingAction('territory');
      if (target === 'attention') return setAdminHomeView('inbox');
      if (target === 'settings') return setAdminHomeView('settings');
    }
    const context = event.target.closest('[data-home-context]');
    if (context) return openMonthlyContext(context.dataset.homeContext);
    const inboxAction = event.target.closest('[data-inbox-action]');
    if (inboxAction && inboxAction.dataset.inboxAction === 'reload') return loadInboxWorkspace(true);
    const inboxFilter = event.target.closest('[data-inbox-filter]');
    if (inboxFilter) {
      inboxState.filter = inboxFilter.dataset.inboxFilter || 'all';
      inboxState.selectedKey = '';
      return renderInboxHub();
    }
    const inboxStatus = event.target.closest('[data-inbox-status]');
    if (inboxStatus) {
      inboxState.statusFilter = inboxStatus.dataset.inboxStatus === 'all' ? 'all' : 'pending';
      inboxState.selectedKey = '';
      return renderInboxHub();
    }
    const inboxOpen = event.target.closest('[data-inbox-open]');
    if (inboxOpen) return openExistingAction(inboxOpen.dataset.inboxOpen);
    const inboxResolve = event.target.closest('[data-inbox-resolve]');
    if (inboxResolve) return resolveInboxItem(inboxResolve.dataset.inboxResolve);
    const inboxItem = event.target.closest('[data-inbox-item]');
    if (inboxItem) {
      inboxState.selectedKey = inboxItem.dataset.inboxItem;
      return renderInboxHub();
    }
    const dateKind = event.target.closest('[data-home-date-kind]');
    if (dateKind) {
      if (typeof openDateKindPicker === 'function') openDateKindPicker(dateKind.dataset.homeDateKind);
      return;
    }
    const day = event.target.closest('[data-home-day]');
    if (day) return openHomeDay(day.dataset.homeDay);
    const action = event.target.closest('[data-home-action]');
    if (action) return openExistingAction(action.dataset.homeAction);
  }

  function updateAdminHomeCounts(counts) {
    homeInboxCounts = counts ? Object.assign({}, counts) : null;
    renderHomeAttention();
    renderInboxHub();
    renderHomeIcons();
  }

  function applyInboxMutation(detail) {
    const kind = detail && detail.kind;
    const rows = kind && inboxState.items[kind];
    if (!inboxState.loaded || !Array.isArray(rows)) return false;
    const id = kind === 'recovery' ? detail.id : detail.rowIndex;
    const item = rows.find(row => String(kind === 'recovery' ? row.id : row.rowIndex) === String(id));
    if (!item) return false;
    item.status = String(detail.status || (kind === 'recovery' ? 'approved' : '対応済み'));
    const pendingCount = rows.filter(isInboxPending).length;
    homeInboxCounts = Object.assign({}, homeInboxCounts || {}, { [kind]: pendingCount });
    if (typeof setInboxCount === 'function') setInboxCount(kind, pendingCount);
    renderHomeAttention();
    renderInboxHub();
    return true;
  }

  document.addEventListener('click', handleHomeClick);
  // 進捗の段は li のため、Enter／Space でも日付選択を開けるようにする
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest && event.target.closest('li[data-home-date-kind]');
    if (!target) return;
    event.preventDefault();
    if (typeof openDateKindPicker === 'function') openDateKindPicker(target.dataset.homeDateKind);
  });
  window.addEventListener('admin:inbox-mutated', event => {
    if (!applyInboxMutation(event.detail || {}) && typeof loadPendingCounts === 'function') loadPendingCounts();
  });
  window.renderAdminHome = renderAdminHome;
  window.updateAdminHomeCounts = updateAdminHomeCounts;
  window.setAdminHomeView = setAdminHomeView;
  window.returnFromAdminTool = returnFromAdminTool;
})();
