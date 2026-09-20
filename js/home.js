// ============================================================
// 新ホーム（フェーズ1）
//
// APIはここから直接呼ばない。index.js が取得した状態を読み、
// 既存のカレンダー・モーダル・別ページの入口へ接続する。
// ============================================================
(function () {
  const HOME_DOW = ['月', '火', '水', '木', '金', '土', '日'];
  let homeInboxCounts = null;
  let homeView = 'home';

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
      const hasSlots = Array.isArray(slots) && slots.length > 0;
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
        hasDates,
        shift,
      };
    }

    const stages = [
      { label: '日程設定', state: scheduleReady ? 'done' : 'current', sub: hasDates ? '設定済み' : '未設定' },
      { label: '希望受付', state: !scheduleReady ? 'todo' : wishesDone ? 'done' : 'current', sub: dates.deadline ? `締切 ${dateLabel(dates.deadline, false)}` : '未設定' },
      { label: 'シフト作成', state: !wishesDone ? 'todo' : created ? 'done' : 'current', sub: created ? '作成完了' : '未完了' },
      { label: '確認', state: !created ? 'todo' : approved ? 'done' : 'wait', sub: !created ? '未開始' : approved ? '確認完了' : '確認待ち' },
      { label: '公開', state: !approved ? 'todo' : notified ? 'done' : 'current', sub: notified ? '公開済み' : dates.open ? `予定 ${dateLabel(dates.open, false)}` : '公開待ち' },
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
      return `<li class="${escapeHome(stage.state)}"><span class="home-progress-dot">${mark}</span><b>${escapeHome(stage.label)}</b><small>${escapeHome(stage.sub || '')}</small></li>`;
    }).join('');
    const title = document.getElementById('home-progress-title');
    if (title) {
      const remaining = state.stages.filter(stage => stage.state !== 'done').length;
      title.textContent = remaining ? `公開まであと${remaining}段階` : '今月の作業が完了';
    }
  }

  function eventMap() {
    const events = new Map();
    const add = (value, label, kind, detail) => {
      const key = dateKey(value);
      if (!key) return;
      const current = events.get(key) || { value, labels: [], kinds: [], details: [] };
      if (!current.labels.includes(label)) current.labels.push(label);
      if (!current.kinds.includes(kind)) current.kinds.push(kind);
      if (detail && !current.details.includes(detail)) current.details.push(detail);
      events.set(key, current);
    };
    add(dates && dates.apply, '受付', 'green', '申込開始');
    add(dates && dates.deadline, '締切', 'amber', '希望締切');
    add(dates && dates.open, '公開', 'amber', 'シフト公開');
    (Array.isArray(slots) ? slots : []).forEach(slot => add(slot, '実施', 'blue', slot.time || '実施日'));
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
      return `<button type="button" class="home-schedule-row" data-home-day="${dateKey(event.value)}"><span class="home-schedule-date">${escapeHome(dateLabel(event.value, true))}</span><span><b>${escapeHome(event.labels.join('・'))}</b><small>${escapeHome(event.details.join('・'))}</small></span><span class="home-dot ${kind}"></span></button>`;
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
    renderHomeAccount();
  }

  function updateNavActive(view) {
    document.querySelectorAll('[data-home-nav]').forEach(button => {
      const target = button.dataset.homeNav;
      const active = target === view;
      button.classList.toggle('active', active);
    });
  }

  function setAdminHomeView(view) {
    const app = document.getElementById('app');
    const home = document.getElementById('home-view');
    const layout = document.querySelector('.layout');
    const showHome = view === 'home';
    homeView = showHome ? 'home' : 'monthly';
    if (app) app.classList.toggle('home-mode', showHome);
    setHomeVisible(home, showHome);
    setHomeVisible(layout, !showHome);
    updateNavActive(showHome ? 'home' : 'monthly');
    if (typeof closeMobileSidebar === 'function') closeMobileSidebar();
    if (showHome) {
      renderAdminHome();
      requestAnimationFrame(() => document.getElementById('home-main')?.focus({ preventScroll: true }));
    } else {
      const panel = document.querySelector('.cp');
      if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function openMonthlyContext(kind) {
    setAdminHomeView('monthly');
    setTimeout(() => {
      if (kind === 'month' && typeof openYmPicker === 'function') openYmPicker(document.getElementById('cal-ym-label'));
      if (kind === 'pw') document.getElementById('pw-type-bar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      const link = document.getElementById('btn-shift-create');
      return link ? link.click() : window.open('./shift-create.html', '_blank', 'noopener');
    }
    if (action === 'territory') {
      const link = document.getElementById('btn-territory');
      return link ? link.click() : window.open('./territory/', '_blank', 'noopener');
    }
    const actions = {
      recovery: 'openRecoveryModal', requests: 'openRequestModal', bugs: 'openBugReportModal',
      distribution: 'openDistributionReportModal', member: 'openMemberModal', access: 'openAccessModal',
      position: 'openPositionModal', notice: 'openNoticeModal', photo: 'openPhotoMgmtModal',
      proxy: 'openProxyModal', couple: 'openCoupleModal', limited: 'openLimitedSettingsModal', logs: 'openLogModal',
    };
    if (action === 'manual' || action === 'pwa') {
      setAdminHomeView('monthly');
      return setTimeout(() => {
        if (action === 'manual' && typeof openM === 'function') openM('m-manual');
        if (action === 'pwa' && typeof window.openPwaModal === 'function') window.openPwaModal();
      }, 0);
    }
    const fnName = actions[action];
    if (!fnName || typeof window[fnName] !== 'function') return;
    setAdminHomeView('monthly');
    setTimeout(() => {
      if (action === 'photo') window[fnName]('exhibit');
      else window[fnName]();
    }, 0);
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
      if (target === 'attention') {
        setAdminHomeView('home');
        return document.getElementById('home-attention')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      if (target === 'settings') {
        setAdminHomeView('home');
        return document.getElementById('home-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    const context = event.target.closest('[data-home-context]');
    if (context) return openMonthlyContext(context.dataset.homeContext);
    const day = event.target.closest('[data-home-day]');
    if (day) return openHomeDay(day.dataset.homeDay);
    const action = event.target.closest('[data-home-action]');
    if (action) return openExistingAction(action.dataset.homeAction);
  }

  function updateAdminHomeCounts(counts) {
    homeInboxCounts = counts ? Object.assign({}, counts) : null;
    renderHomeAttention();
  }

  document.addEventListener('click', handleHomeClick);
  window.renderAdminHome = renderAdminHome;
  window.updateAdminHomeCounts = updateAdminHomeCounts;
  window.setAdminHomeView = setAdminHomeView;
})();
