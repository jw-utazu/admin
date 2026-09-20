// ============================================================
// 月次運用（フェーズ2）
// APIはここから直接呼ばない。index.js が取得した状態と、
// 既存の年月・日付・承認処理を新しい本文へ描画する。
// ============================================================
(function () {
  const DOW = ['月', '火', '水', '木', '金', '土', '日'];
  let monthlyTab = 'schedule';

  function escapeMonthly(value) {
    if (typeof escHtml === 'function') return escHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function visible(el, on) {
    if (typeof setVisible === 'function') setVisible(el, on);
    else if (el) el.classList.toggle('is-hidden', !on);
  }

  function pwLabel() {
    if (currentPwType === 'normal') return '通常PW';
    const slot = (limitedSlots || []).find(item => item.id === currentPwType);
    return slot && slot.name ? slot.name : '限定PW';
  }

  function activeDates() {
    if (currentPwType !== 'normal' && Array.isArray(adminPhases) && adminPhases[currentPhaseIndex]) {
      return adminPhases[currentPhaseIndex];
    }
    return dates || {};
  }

  function activeSlots() {
    return Array.isArray(slots) ? slots : [];
  }

  function isDate(value) {
    return !!(value && Number(value.y) && Number(value.m) && Number(value.d));
  }

  function sameDate(a, y, m, d) {
    return isDate(a) && Number(a.y) === y && Number(a.m) === m && Number(a.d) === d;
  }

  function dateText(value) {
    if (!isDate(value)) return '未設定';
    const dt = new Date(Number(value.y), Number(value.m) - 1, Number(value.d));
    const dow = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
    return `${value.m}月${value.d}日（${DOW[dow]}）`;
  }

  function stripIcon(value) {
    return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  function currentApproval() {
    return typeof isCalApprovalForCurMonth === 'function' && isCalApprovalForCurMonth() ? calApproval : null;
  }

  function currentShift() {
    return typeof isShiftStatusForCurMonth === 'function' && isShiftStatusForCurMonth() ? shiftStatus : null;
  }

  function statusInfo() {
    const d = activeDates();
    const hasDates = isDate(d.apply) && isDate(d.deadline) && isDate(d.open);
    const slotsNow = activeSlots();
    if (currentPwType !== 'normal') {
      const hasSlots = slotsNow.length > 0;
      return hasSlots ? {
        badge: '実施日設定済み', statusClass: 'done',
        title: `${curY}年${curM}月の実施日を確認できます`,
        detail: `${slotsNow.length}件の実施日枠があります。日付を選ぶと設定を変更できます。`,
        action: 'first-day', actionLabel: '実施日を確認する',
      } : {
        badge: '実施日未設定', statusClass: 'alert',
        title: '実施日を設定して、限定PWの運用を始める',
        detail: 'カレンダーの日付を選び、実施日と枠を設定してください。',
        action: 'first-day', actionLabel: '実施日を設定する',
      };
    }

    const published = typeof isCurMonthPublished === 'function' && isCurMonthPublished();
    const approval = currentApproval();
    const stage = typeof calStageInfo === 'function' ? calStageInfo() : null;
    const stageText = stripIcon(stage && stage.text);
    if (published) {
      return {
        badge: '公開中', statusClass: 'done',
        title: `${curY}年${curM}月の予定表は公開中です`,
        detail: '公開状態の詳細を確認したり、必要に応じて既存の公開操作を開けます。',
        action: 'approval-detail', actionLabel: '公開状態を確認する',
      };
    }
    if (!hasDates) {
      return {
        badge: '日程未設定', statusClass: 'alert',
        title: '日程を設定して、月の作業を始める',
        detail: '申込開始・希望締切・シフト公開日を設定してから、予定表の承認へ進みます。',
        action: 'first-day', actionLabel: '日程を設定する',
      };
    }
    if (approval && approval.approved) {
      return {
        badge: '承認済み', statusClass: 'wait',
        title: stageText || '申込開始日を待って公開します',
        detail: (stage && stage.title) || '予定表は申込開始日に自動公開されます。',
        action: stageText ? 'calendar-stage' : 'approval-detail', actionLabel: stageText || '承認状態を確認する',
      };
    }
    if (approval && approval.ready) {
      return {
        badge: '承認待ち', statusClass: 'wait',
        title: stageText || '予定表の承認を待っています',
        detail: (stage && stage.title) || '承認者が確認するまで、申込開始日を過ぎても公開されません。',
        action: 'calendar-stage', actionLabel: stageText || '承認状態を確認する',
      };
    }
    return {
      badge: '日程設定済み', statusClass: 'current',
      title: stageText || '予定表を設定完了にして承認へ進む',
      detail: (stage && stage.title) || '申込開始・希望締切・シフト公開日を確認してください。',
      action: stage ? 'calendar-stage' : 'first-day', actionLabel: stageText || '日程を確認する',
    };
  }

  function renderStatus() {
    const info = statusInfo();
    const status = document.getElementById('monthly-status');
    const title = document.getElementById('monthly-status-title');
    const detail = document.getElementById('monthly-status-detail');
    const action = document.getElementById('monthly-primary-action');
    if (status) { status.textContent = info.badge; status.className = `monthly-status ${info.statusClass || ''}`; }
    if (title) title.textContent = info.title;
    if (detail) detail.textContent = info.detail;
    if (action) {
      action.dataset.monthlyAction = info.action;
      action.innerHTML = `${escapeMonthly(info.actionLabel)} <span>›</span>`;
    }
  }

  function renderCalendar() {
    const grid = document.getElementById('monthly-calendar-grid');
    if (!grid || typeof curY === 'undefined' || typeof curM === 'undefined') return;
    const d = activeDates();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const first = new Date(curY, curM - 1, 1);
    const last = new Date(curY, curM, 0);
    let html = DOW.map((name, index) => `<div class="monthly-calendar-dow${index === 5 ? ' sat' : index === 6 ? ' sun' : ''}" role="columnheader">${name}</div>`).join('');
    const offset = first.getDay() === 0 ? 6 : first.getDay() - 1;
    for (let i = 0; i < offset; i++) html += '<div class="monthly-day-empty" aria-hidden="true"></div>';
    for (let day = 1; day <= last.getDate(); day++) {
      const dt = new Date(curY, curM - 1, day);
      const key = `${curY}-${String(curM).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const applyTime = isDate(d.apply) ? new Date(Number(d.apply.y), Number(d.apply.m) - 1, Number(d.apply.d)).getTime() : null;
      const deadlineTime = isDate(d.deadline) ? new Date(Number(d.deadline.y), Number(d.deadline.m) - 1, Number(d.deadline.d)).getTime() : null;
      const slotsForDay = activeSlots().filter(slot => Number(slot.y) === curY && Number(slot.m) === curM && Number(slot.d) === day);
      const marks = [];
      if (slotsForDay.length) marks.push(`<span class="monthly-day-mark purple">実施日 ${slotsForDay.length}枠</span>`);
      if (sameDate(d.apply, curY, curM, day)) marks.push('<span class="monthly-day-mark green">申込開始</span>');
      if (sameDate(d.deadline, curY, curM, day)) marks.push('<span class="monthly-day-mark amber">希望締切</span>');
      if (sameDate(d.open, curY, curM, day)) marks.push('<span class="monthly-day-mark blue">公開日</span>');
      const classes = ['monthly-day'];
      if (dt.getDay() === 6) classes.push('sat');
      if (dt.getDay() === 0) classes.push('sun');
      if (dt.getTime() === today.getTime()) classes.push('today');
      if (marks.length) classes.push('has-event');
      if (applyTime !== null && deadlineTime !== null && dt.getTime() >= applyTime && dt.getTime() <= deadlineTime) classes.push('in-apply');
      html += `<button type="button" class="${classes.join(' ')}" data-monthly-day="${key}" aria-label="${curY}年${curM}月${day}日">`;
      html += `<span class="monthly-day-number">${day}</span>${marks.join('')}</button>`;
    }
    grid.innerHTML = html;
  }

  function renderDateCards() {
    const list = document.getElementById('monthly-date-cards');
    if (!list) return;
    const d = activeDates();
    const cards = currentPwType === 'normal'
      ? [
        ['申込開始', d.apply, '奉仕者が予定表を確認できる開始日'],
        ['希望締切', d.deadline, '希望提出の締切日'],
        ['シフト公開', d.open, '確認済みシフトの公開予定日'],
      ]
      : [['実施日', activeSlots()[0], activeSlots().length ? `${activeSlots().length}件の実施日枠` : '枠がまだ設定されていません']];
    list.innerHTML = cards.map(card => `<div class="monthly-date-card"><small>${escapeMonthly(card[0])}</small><b>${escapeMonthly(dateText(card[1]))}</b><p>${escapeMonthly(card[2])}</p></div>`).join('');
  }

  function shiftStatusText() {
    const state = currentShift();
    if (!state) return '対象月のシフト状態は未取得です。詳細はシフト管理アプリで確認してください。';
    const labels = [];
    if (state.published) labels.push('作成完了');
    if (state.approvedAll) labels.push('確認完了');
    if (state.notified) labels.push('公開済み');
    return labels.length ? `状態：${labels.join('・')}` : '状態：シフト作成中または未完了';
  }

  function renderSubtabs() {
    const d = activeDates();
    const wishes = document.getElementById('monthly-wishes-fact');
    const shifts = document.getElementById('monthly-shifts-fact');
    if (wishes) wishes.textContent = `希望締切：${dateText(d.deadline)}`;
    if (shifts) shifts.textContent = shiftStatusText();
    const href = './shift-create.html' + (currentPwType !== 'normal' ? `?type=${encodeURIComponent(currentPwType)}` : '');
    document.querySelectorAll('.monthly-link-button').forEach(link => { link.href = href; });
  }

  function renderPwMenu() {
    const menu = document.getElementById('monthly-pw-menu');
    if (!menu) return;
    const options = [{ id: 'normal', name: '通常PW' }].concat((limitedSlots || []).map(slot => ({ id: slot.id, name: slot.name || '限定PW' })));
    menu.innerHTML = options.map(option => `<button type="button" role="menuitem" class="${option.id === currentPwType ? 'active' : ''}" data-monthly-pw="${escapeMonthly(option.id)}">${escapeMonthly(option.name)}</button>`).join('');
  }

  function renderMonthlyIcons() {
    if (typeof ic !== 'function') return;
    document.querySelectorAll('[data-monthly-icon]').forEach(el => {
      const markup = ic(el.dataset.monthlyIcon);
      if (markup) el.innerHTML = markup;
    });
  }

  function setMonthlyTab(tab) {
    monthlyTab = tab === 'wishes' || tab === 'shifts' ? tab : 'schedule';
    document.querySelectorAll('[data-monthly-tab]').forEach(button => button.classList.toggle('active', button.dataset.monthlyTab === monthlyTab));
    document.querySelectorAll('[data-monthly-panel]').forEach(panel => visible(panel, panel.dataset.monthlyPanel === monthlyTab));
  }

  function renderAdminMonthly() {
    if (typeof currentPwType === 'undefined') return;
    const lead = document.getElementById('monthly-context-lead');
    const pw = document.getElementById('monthly-pw-chip');
    const month = document.getElementById('monthly-month-chip');
    const calendarMonth = document.getElementById('monthly-calendar-month-button');
    const title = document.getElementById('monthly-calendar-title');
    const label = `${curY}年${curM}月`;
    if (lead) lead.textContent = `${label}・${pwLabel()}の予定表と作業状況を表示しています。`;
    if (pw) pw.textContent = `${pwLabel()}⌄`;
    if (month) month.textContent = `${label}⌄`;
    if (calendarMonth) calendarMonth.textContent = label;
    if (title) title.textContent = `${label}の日程`;
    renderStatus();
    renderCalendar();
    renderDateCards();
    renderSubtabs();
    renderPwMenu();
    renderMonthlyIcons();
    setMonthlyTab(monthlyTab);
  }

  function toggleMonthlyPwMenu() {
    const menu = document.getElementById('monthly-pw-menu');
    if (!menu) return;
    renderPwMenu();
    menu.classList.toggle('is-hidden');
  }

  function showLegacyMonthlyView() {
    const app = document.getElementById('app');
    const home = document.getElementById('home-view');
    const layout = document.querySelector('.layout');
    const bar = document.getElementById('pw-type-bar');
    if (app) app.classList.remove('home-mode');
    visible(home, false);
    visible(layout, true);
    visible(bar, true);
    if (layout) layout.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openMonthlyAction(action) {
    if (action === 'legacy') return showLegacyMonthlyView();
    if (action === 'calendar-stage') return typeof calStageAction === 'function' && calStageAction();
    if (action === 'approval-detail') return typeof openCalApprovalDetail === 'function' && openCalApprovalDetail();
    if (action === 'first-day' && typeof openDaySelectModal === 'function') return openDaySelectModal(curY, curM, 1);
  }

  function selectMonthlyDay(key) {
    document.querySelectorAll('.monthly-day.selected').forEach(day => day.classList.remove('selected'));
    const button = document.querySelector(`[data-monthly-day="${key}"]`);
    if (button) button.classList.add('selected');
    const target = document.getElementById('monthly-selected-day');
    if (!target) return;
    const [year, month, day] = String(key).split('-').map(Number);
    const slotsForDay = activeSlots().filter(slot => Number(slot.y) === year && Number(slot.m) === month && Number(slot.d) === day);
    target.textContent = `${dateText({ y: year, m: month, d: day })}${slotsForDay.length ? `：実施日 ${slotsForDay.length}枠` : '：この日付の設定を開きます。'}`;
  }

  function handleMonthlyClick(event) {
    if (!event.target.closest('.monthly-context')) {
      const menu = document.getElementById('monthly-pw-menu');
      if (menu) menu.classList.add('is-hidden');
    }
    const pw = event.target.closest('[data-monthly-pw]');
    if (pw) {
      const menu = document.getElementById('monthly-pw-menu');
      if (typeof switchPwType === 'function') switchPwType(pw.dataset.monthlyPw);
      if (menu) menu.classList.add('is-hidden');
      return;
    }
    const tab = event.target.closest('[data-monthly-tab]');
    if (tab) return setMonthlyTab(tab.dataset.monthlyTab);
    const month = event.target.closest('[data-monthly-month]');
    if (month && typeof chM === 'function') return chM(Number(month.dataset.monthlyMonth));
    const day = event.target.closest('[data-monthly-day]');
    if (day) {
      selectMonthlyDay(day.dataset.monthlyDay);
      const parts = day.dataset.monthlyDay.split('-').map(Number);
      if (typeof openDaySelectModal === 'function') openDaySelectModal(parts[0], parts[1], parts[2]);
      return;
    }
    const action = event.target.closest('[data-monthly-action]');
    if (action) return openMonthlyAction(action.dataset.monthlyAction);
  }

  document.addEventListener('click', handleMonthlyClick);
  window.renderAdminMonthly = renderAdminMonthly;
  window.toggleMonthlyPwMenu = toggleMonthlyPwMenu;
  window.showLegacyMonthlyView = showLegacyMonthlyView;
})();
