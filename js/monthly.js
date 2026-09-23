// ============================================================
// 月次運用（フェーズ3）
// 日程・承認・公開状態は index.js の状態を描画する。申込状況の取得と
// 描画は monthly-wishes.js に分離し、このファイルはタブと既存操作を仲介する。
// ============================================================
(function () {
  const DOW = ['月', '火', '水', '木', '金', '土', '日'];
  let monthlyTab = 'schedule';
  let selectedMonthlyDayKey = '';
  let selectedMonthlyDayContext = '';

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
    if (currentPwType !== 'normal' && Array.isArray(adminPhases) && adminPhases[currentPhaseIndex]) {
      const phaseSlots = adminPhases[currentPhaseIndex].slots;
      return Array.isArray(phaseSlots) ? phaseSlots : [];
    }
    return Array.isArray(slots) ? slots : [];
  }

  function phaseMonth(phase) {
    if (typeof limitedPhaseYM === 'function') return limitedPhaseYM(phase);
    if (!phase) return null;
    const directYear = Number(phase.year), directMonth = Number(phase.month);
    if (Number.isInteger(directYear) && Number.isInteger(directMonth) && directMonth >= 1 && directMonth <= 12) {
      return { y: directYear, m: directMonth };
    }
    const slot = (phase.slots || []).find(item => Number(item.y) && Number(item.m));
    if (slot) return { y: Number(slot.y), m: Number(slot.m) };
    for (const date of [phase.open, phase.deadline, phase.apply]) {
      if (date && Number(date.y) && Number(date.m)) return { y: Number(date.y), m: Number(date.m) };
    }
    return null;
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

  function shiftCreateHref() {
    const params = new URLSearchParams({ year: String(curY), month: String(curM) });
    if (currentPwType !== 'normal') params.set('type', currentPwType);
    return `./shift-create.html?${params.toString()}`;
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
    const approvalDetail = document.getElementById('monthly-approval-detail');
    if (approvalDetail) {
      const approval = currentApproval();
      visible(approvalDetail, currentPwType === 'normal' && !!approval && info.action !== 'approval-detail');
    }
  }

  function renderWorkflow() {
    const nav = document.getElementById('monthly-workflow');
    if (!nav) return;
    nav.setAttribute('aria-label', `${pwLabel()}の月次進行`);
    const shiftHref = shiftCreateHref();
    const steps = [
      { label: '日程', caption: 'カレンダー', tab: 'schedule' },
      { label: '希望', caption: '申込状況', tab: 'wishes' },
      { label: '作成', caption: '配置編集', href: shiftHref },
      { label: '確認', caption: 'シフト一覧', tab: 'shifts' },
      { label: '公開', caption: '作成画面', href: shiftHref },
    ];
    nav.innerHTML = steps.map((step, index) => {
      const active = step.tab === monthlyTab;
      const classes = `monthly-workflow-step${active ? ' active' : ''}`;
      const aria = active ? ' aria-current="step"' : '';
      const content = `<span class="monthly-workflow-index">${index + 1}</span><span class="monthly-workflow-copy"><b>${escapeMonthly(step.label)}</b><small>${escapeMonthly(step.caption)}</small></span>`;
      if (step.tab) return `<button type="button" class="${classes}" data-monthly-tab="${step.tab}"${aria}>${content}</button>`;
      return `<a class="${classes}" href="${escapeMonthly(step.href)}" data-home-nav="shift">${content}</a>`;
    }).join('<span class="monthly-workflow-connector" aria-hidden="true"></span>');
  }

  function renderCalendarMonth(gridId, year, month) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const d = activeDates();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const first = new Date(year, month - 1, 1);
    const last = new Date(year, month, 0);
    let html = DOW.map((name, index) => `<div class="monthly-calendar-dow${index === 5 ? ' sat' : index === 6 ? ' sun' : ''}" role="columnheader">${name}</div>`).join('');
    const offset = first.getDay() === 0 ? 6 : first.getDay() - 1;
    for (let i = 0; i < offset; i++) html += '<div class="monthly-day-empty" aria-hidden="true"></div>';
    const applyTime = isDate(d.apply) ? new Date(Number(d.apply.y), Number(d.apply.m) - 1, Number(d.apply.d)).getTime() : null;
    const deadlineTime = isDate(d.deadline) ? new Date(Number(d.deadline.y), Number(d.deadline.m) - 1, Number(d.deadline.d)).getTime() : null;
    for (let day = 1; day <= last.getDate(); day++) {
      const dt = new Date(year, month - 1, day);
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slotsForDay = activeSlots().filter(slot => Number(slot.y) === year && Number(slot.m) === month && Number(slot.d) === day);
      const marks = [];
      if (slotsForDay.length) marks.push(`<span class="monthly-day-mark purple">実施日 ${slotsForDay.length}枠</span>`);
      if (sameDate(d.apply, year, month, day)) marks.push('<span class="monthly-day-mark green">申込開始</span>');
      if (sameDate(d.deadline, year, month, day)) marks.push('<span class="monthly-day-mark amber">希望締切</span>');
      if (sameDate(d.open, year, month, day)) marks.push('<span class="monthly-day-mark blue">公開日</span>');
      const classes = ['monthly-day'];
      if (dt.getDay() === 6) classes.push('sat');
      if (dt.getDay() === 0) classes.push('sun');
      if (dt.getTime() === today.getTime()) classes.push('today');
      if (key === selectedMonthlyDayKey) classes.push('selected');
      if (marks.length) classes.push('has-event');
      if (applyTime !== null && deadlineTime !== null && dt.getTime() >= applyTime && dt.getTime() <= deadlineTime) classes.push('in-apply');
      html += `<button type="button" class="${classes.join(' ')}" data-monthly-day="${key}" aria-label="${year}年${month}月${day}日">`;
      html += `<span class="monthly-day-number">${day}</span>${marks.join('')}</button>`;
    }
    grid.innerHTML = html;
  }

  function renderCalendar() {
    if (typeof curY === 'undefined' || typeof curM === 'undefined') return;
    const previous = new Date(Number(curY), Number(curM) - 2, 1);
    const previousTitle = document.getElementById('monthly-previous-calendar-title');
    const currentTitle = document.getElementById('monthly-current-calendar-title');
    if (previousTitle) previousTitle.textContent = `${previous.getFullYear()}年${previous.getMonth() + 1}月（前月）`;
    if (currentTitle) currentTitle.textContent = `${curY}年${curM}月（対象月）`;
    renderCalendarMonth('monthly-previous-calendar-grid', previous.getFullYear(), previous.getMonth() + 1);
    renderCalendarMonth('monthly-current-calendar-grid', Number(curY), Number(curM));
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
      : (() => {
        const byDate = new Map();
        activeSlots().forEach(slot => {
          const key = `${Number(slot.y)}-${Number(slot.m)}-${Number(slot.d)}`;
          if (!byDate.has(key)) byDate.set(key, { y: Number(slot.y), m: Number(slot.m), d: Number(slot.d), count: 0 });
          byDate.get(key).count++;
        });
        return [...byDate.values()].sort((a, b) => a.y - b.y || a.m - b.m || a.d - b.d)
          .map(slot => ['実施日', slot, `${slot.count}件の実施日枠`]);
      })();
    if (!cards.length) {
      list.innerHTML = '<div class="monthly-date-card is-empty"><small>実施日</small><b>未設定</b><p>このフェーズに実施日枠はありません。</p></div>';
      return;
    }
    list.innerHTML = cards.map(([label, date, description]) => {
      const isSet = isDate(date);
      const content = `<small>${escapeMonthly(label)}</small><b>${escapeMonthly(dateText(date))}</b><p>${escapeMonthly(description)}</p>`;
      return isSet
        ? `<button type="button" class="monthly-date-card" data-monthly-milestone="${Number(date.y)}-${Number(date.m)}-${Number(date.d)}" aria-label="${escapeMonthly(label)}、${escapeMonthly(dateText(date))}。選択日の詳細を表示">${content}</button>`
        : `<div class="monthly-date-card is-empty">${content}</div>`;
    }).join('');
  }

  function renderSelectedDay() {
    const card = document.getElementById('monthly-selected-day');
    const title = document.getElementById('monthly-selected-day-title');
    const events = document.getElementById('monthly-selected-day-events');
    const meta = document.getElementById('monthly-selected-day-meta');
    const note = document.getElementById('monthly-selected-day-note');
    const primary = document.getElementById('monthly-selected-day-primary');
    const configure = document.getElementById('monthly-selected-day-configure');
    if (!card || !title || !events || !meta || !note || !primary || !configure) return;
    if (!selectedMonthlyDayKey) {
      card.classList.add('is-empty');
      title.textContent = '日付を選択してください';
      events.innerHTML = '';
      meta.innerHTML = '';
      note.textContent = '日付を選ぶと、実施枠や申込期間を確認できます。';
      primary.innerHTML = '日程またはシフトを開く <span>›</span>';
      primary.removeAttribute('href');
      primary.dataset.monthlyDayPrimary = '';
      delete primary.dataset.homeNav;
      primary.classList.add('is-disabled');
      primary.setAttribute('aria-disabled', 'true');
      primary.setAttribute('tabindex', '-1');
      configure.disabled = true;
      return;
    }
    const [year, month, day] = selectedMonthlyDayKey.split('-').map(Number);
    const d = activeDates();
    const slotsForDay = activeSlots().filter(slot => Number(slot.y) === year && Number(slot.m) === month && Number(slot.d) === day);
    const marks = [];
    if (slotsForDay.length) marks.push(`実施日 ${slotsForDay.length}枠`);
    if (sameDate(d.apply, year, month, day)) marks.push('申込開始日');
    if (sameDate(d.deadline, year, month, day)) marks.push('希望締切日');
    if (sameDate(d.open, year, month, day)) marks.push('シフト公開予定日');
    card.classList.remove('is-empty');
    title.textContent = dateText({ y: year, m: month, d: day });
    events.innerHTML = marks.length
      ? marks.map(mark => `<span class="monthly-day-detail-event">${escapeMonthly(mark)}</span>`).join('')
      : '<span class="monthly-day-detail-event neutral">基準日の登録なし</span>';
    const timeList = slotsForDay.map(slot => String(slot.time || '').trim()).filter(Boolean);
    meta.innerHTML = '<div><dt>実施枠</dt><dd>' + (timeList.length ? timeList.map(escapeMonthly).join('・') : 'なし') + '</dd></div>' +
      '<div><dt>日程の種類</dt><dd>' + escapeMonthly(marks.length ? marks.join('・') : '登録なし') + '</dd></div>';
    const shift = currentShift();
    let primaryLabel = 'この日の日程を開く';
    let primaryKind = 'configure';
    if (slotsForDay.length) {
      primaryKind = 'shift';
      primaryLabel = shift && shift.notified ? '公開済みシフトを確認する'
        : shift && shift.rejected && !shift.published ? '差し戻し内容を確認・修正する'
        : shift && shift.published ? '確認状況を開く'
        : 'この月のシフト作成を開く';
    } else if (sameDate(d.apply, year, month, day)) {
      primaryLabel = '申込開始日の設定を開く';
    } else if (sameDate(d.deadline, year, month, day)) {
      primaryLabel = '希望締切日の設定を開く';
    } else if (sameDate(d.open, year, month, day)) {
      primaryLabel = 'シフト公開日の設定を開く';
    }
    primary.innerHTML = escapeMonthly(primaryLabel) + ' <span>›</span>';
    primary.dataset.monthlyDayPrimary = primaryKind;
    primary.classList.remove('is-disabled');
    primary.setAttribute('aria-disabled', 'false');
    primary.setAttribute('tabindex', '0');
    if (primaryKind === 'shift') {
      primary.href = shiftCreateHref();
      primary.dataset.homeNav = 'shift';
    } else {
      primary.removeAttribute('href');
      delete primary.dataset.homeNav;
    }
    note.textContent = slotsForDay.length
      ? '対象月とPWを引き継いで、既存のシフト管理画面を開きます。'
      : '日程の変更は既存の日程設定画面で行います。';
    configure.textContent = 'この日の日程設定を開く';
    configure.disabled = false;
    configure.dataset.monthlyDayKey = selectedMonthlyDayKey;
  }

  function renderSubtabs() {
    const href = shiftCreateHref();
    document.querySelectorAll('.monthly-link-button:not(#monthly-selected-day-primary)').forEach(link => { link.href = href; });
  }

  function renderPhaseSwitcher() {
    const nav = document.getElementById('monthly-phase-switcher');
    if (!nav) return;
    const phases = currentPwType !== 'normal' && Array.isArray(adminPhases) ? adminPhases : [];
    visible(nav, phases.length > 0);
    if (!phases.length) { nav.innerHTML = ''; return; }
    nav.innerHTML = phases.map((phase, index) => {
      const ym = phaseMonth(phase);
      const isActive = index === currentPhaseIndex;
      const state = phase && phase.published === true ? '公開中' : '未公開';
      const monthLabel = ym ? `${ym.y}年${ym.m}月` : '年月未設定';
      return `<button type="button" class="monthly-phase-button${isActive ? ' active' : ''}" data-monthly-phase="${index}" aria-pressed="${isActive}"${typeof _adminSwitching !== 'undefined' && _adminSwitching ? ' disabled' : ''}><span>フェーズ ${index + 1}</span><small>${escapeMonthly(monthLabel)}</small><b class="${phase && phase.published === true ? 'published' : ''}">${state}</b></button>`;
    }).join('');
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
    if (monthlyTab === 'wishes' && typeof loadMonthlyWishes === 'function') {
      // 年月／PW切替の既存ローディング中は、親のオーバーレイを上書きしない。
      // loadAdminData 完了後に同じタブを再描画して取得する。
      if (typeof _adminSwitching !== 'undefined' && _adminSwitching) {
        setTimeout(() => { if (monthlyTab === 'wishes') setMonthlyTab('wishes'); }, 0);
      } else loadMonthlyWishes();
    }
    if (monthlyTab === 'shifts' && typeof loadMonthlyShifts === 'function') {
      // 年月／PW切替の既存ローディング中は、親のオーバーレイを上書きしない。
      // loadAdminData 完了後に同じタブを再描画して取得する。
      if (typeof _adminSwitching !== 'undefined' && _adminSwitching) {
        setTimeout(() => { if (monthlyTab === 'shifts') setMonthlyTab('shifts'); }, 0);
      } else loadMonthlyShifts();
    }
  }

  function renderAdminMonthly() {
    if (typeof currentPwType === 'undefined') return;
    const dayContext = `${currentPwType}:${curY}-${curM}:${currentPwType === 'normal' ? '' : currentPhaseIndex}`;
    if (selectedMonthlyDayContext !== dayContext) {
      selectedMonthlyDayContext = dayContext;
      selectedMonthlyDayKey = '';
    }
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
    renderSelectedDay();
    renderPhaseSwitcher();
    renderSubtabs();
    renderPwMenu();
    renderMonthlyIcons();
    renderWorkflow();
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
    const returnButton = document.getElementById('legacy-home-return');
    if (app) app.classList.remove('home-mode');
    visible(home, false);
    visible(layout, true);
    visible(bar, true);
    visible(returnButton, true);
    if (layout) layout.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function returnToNewHome() {
    visible(document.getElementById('legacy-home-return'), false);
    if (typeof setAdminHomeView === 'function') setAdminHomeView('home');
  }

  function openMonthlyAction(action) {
    if (action === 'legacy') return showLegacyMonthlyView();
    if (action === 'calendar-stage') return typeof calStageAction === 'function' && calStageAction();
    if (action === 'approval-detail') return typeof openCalApprovalDetail === 'function' && openCalApprovalDetail();
    if (action === 'first-day' && typeof openDaySelectModal === 'function') return openDaySelectModal(curY, curM, 1);
  }

  function selectMonthlyDay(key) {
    selectedMonthlyDayKey = String(key || '');
    document.querySelectorAll('.monthly-day.selected').forEach(day => day.classList.remove('selected'));
    const button = document.querySelector(`[data-monthly-day="${key}"]`);
    if (button) button.classList.add('selected');
    renderSelectedDay();
  }

  async function selectMonthlyPhase(index) {
    const phases = currentPwType !== 'normal' && Array.isArray(adminPhases) ? adminPhases : [];
    if (!Number.isInteger(index) || index < 0 || index >= phases.length || (typeof _adminSwitching !== 'undefined' && _adminSwitching)) return;
    const ym = phaseMonth(phases[index]);
    if (ym && (Number(curY) !== Number(ym.y) || Number(curM) !== Number(ym.m))) {
      if (typeof setYm !== 'function') return;
      await setYm(ym.y, ym.m);
      if (Number(curY) !== Number(ym.y) || Number(curM) !== Number(ym.m) || !adminPhases[index]) return;
    }
    if (typeof switchPhase === 'function') switchPhase(index);
    renderAdminMonthly();
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
    if (tab) {
      setMonthlyTab(tab.dataset.monthlyTab);
      renderWorkflow();
      return;
    }
    const phase = event.target.closest('[data-monthly-phase]');
    if (phase) return selectMonthlyPhase(Number(phase.dataset.monthlyPhase));
    const month = event.target.closest('[data-monthly-month]');
    if (month && typeof chM === 'function') return chM(Number(month.dataset.monthlyMonth));
    const day = event.target.closest('[data-monthly-day]');
    if (day) {
      selectMonthlyDay(day.dataset.monthlyDay);
      return;
    }
    const dayAction = event.target.closest('[data-monthly-day-action="configure"]');
    if (dayAction) {
      const key = dayAction.dataset.monthlyDayKey || selectedMonthlyDayKey;
      const parts = String(key).split('-').map(Number);
      if (parts.length === 3 && parts.every(Number.isFinite) && typeof openDaySelectModal === 'function') {
        openDaySelectModal(parts[0], parts[1], parts[2]);
      }
      return;
    }
    const dayPrimary = event.target.closest('[data-monthly-day-action="primary"]');
    if (dayPrimary) {
      if (dayPrimary.dataset.monthlyDayPrimary === 'configure') {
        const parts = String(selectedMonthlyDayKey).split('-').map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite) && typeof openDaySelectModal === 'function') {
          openDaySelectModal(parts[0], parts[1], parts[2]);
        }
      }
      return;
    }
    const milestone = event.target.closest('[data-monthly-milestone]');
    if (milestone) {
      const key = milestone.dataset.monthlyMilestone;
      selectMonthlyDay(key);
      return;
    }
    const wishAction = event.target.closest('[data-monthly-wishes-action]');
    if (wishAction) {
      const actionName = wishAction.dataset.monthlyWishesAction;
      if (actionName === 'reload' && typeof loadMonthlyWishes === 'function') return loadMonthlyWishes(true);
      if (actionName === 'toggle-unsubmitted' && typeof toggleMonthlyWishesUnsubmitted === 'function') return toggleMonthlyWishesUnsubmitted();
    }
    const shiftAction = event.target.closest('[data-monthly-shifts-action]');
    if (shiftAction) {
      const actionName = shiftAction.dataset.monthlyShiftsAction;
      if (actionName === 'reload' && typeof loadMonthlyShifts === 'function') return loadMonthlyShifts(true);
      if (actionName === 'toggle-approvers' && typeof toggleMonthlyShiftsApprovers === 'function') return toggleMonthlyShiftsApprovers();
    }
    const action = event.target.closest('[data-monthly-action]');
    if (action) return openMonthlyAction(action.dataset.monthlyAction);
  }

  document.addEventListener('click', handleMonthlyClick);
  window.renderAdminMonthly = renderAdminMonthly;
  window.toggleMonthlyPwMenu = toggleMonthlyPwMenu;
  window.showLegacyMonthlyView = showLegacyMonthlyView;
  window.returnToNewHome = returnToNewHome;
  window.getMonthlyActiveDates = activeDates;
  window.getMonthlyDateText = dateText;
})();
