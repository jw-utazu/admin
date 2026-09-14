const pages=document.querySelectorAll('.page');
const navButtons=document.querySelectorAll('[data-page]');
let activeStage='shift';
const stageCopy={
  schedule:['日程・カレンダー','実施日と申込期間をカレンダーで確認・設定します。','設定完了'],
  wishes:['希望確認','提出状況と参加希望を確認します。','受付終了'],
  shift:['シフト作成','希望を見ながら担当者を割り当てます。','編集中'],
  review:['確認','確認者の進捗と指摘を確認します。','未開始'],
  publish:['公開','公開条件と公開予定日を確認します。','公開待ち'],
  'month-settings':['この月の設定','場所・カート番号・検証ルールを調整します。','設定']
};
function showPage(name){
  pages.forEach(page=>page.classList.toggle('active',page.id===`page-${name}`));
  document.querySelectorAll('.nav-item,.bottom-nav button').forEach(button=>button.classList.toggle('active',button.dataset.page===name));
  document.getElementById('main').focus({preventScroll:true});
  window.scrollTo({top:0,behavior:'smooth'});
}
navButtons.forEach(button=>button.addEventListener('click',event=>{event.preventDefault();showPage(button.dataset.page);if(button.dataset.stage)showStage(button.dataset.stage)}));
function showStage(name){
  const copy=stageCopy[name]||stageCopy.shift;
  activeStage=name;
  document.querySelectorAll('.stage').forEach(stage=>stage.classList.toggle('active',stage.dataset.stage===name));
  document.getElementById('stage-title').textContent=copy[0];
  document.getElementById('stage-help').textContent=copy[1];
  const badge=document.querySelector('.work-toolbar .status');
  badge.textContent=copy[2];
  const calendar=document.getElementById('calendar-pane');
  const shift=document.getElementById('stage-content');
  const shiftToolbar=document.getElementById('shift-toolbar');
  const createTools=document.getElementById('create-toolbar-actions');
  if(calendar) calendar.classList.toggle('pane-hidden',name!=='schedule');
  if(shift) shift.classList.toggle('pane-hidden',name==='schedule');
  if(shiftToolbar) shiftToolbar.classList.toggle('pane-hidden',name==='schedule');
  if(createTools) createTools.classList.toggle('pane-hidden',name==='schedule');
  const primary=document.getElementById('stage-primary');
  if(primary) primary.textContent=name==='schedule'?'予定表を確認・承認':'公開前チェックへ';
  showPage('monthly');
}
document.querySelectorAll('[data-stage]').forEach(button=>button.addEventListener('click',()=>showStage(button.dataset.stage)));
const scrim=document.getElementById('scrim');
const drawer=document.getElementById('drawer');
const drawerContent=document.getElementById('drawer-content');
const drawerTemplates={
  account:'<p class="eyebrow">アカウント</p><h2>田中 太郎</h2><p>区域係・通常PW</p><ul><li>アカウントを切り替える</li><li>マニュアルを開く</li><li>ログアウト</li></ul>',
  stages:'<p class="eyebrow">月次運用</p><h2>段階を選ぶ</h2><ul><li>✓ 日程・カレンダー — 完了</li><li>✓ 希望 — 受付終了</li><li><b>3 シフト作成 — 編集中</b></li><li>4 確認 — 未開始</li><li>5 公開 — 9月20日予定</li></ul>',
  message:'<p class="eyebrow">ログイン救済</p><h2>ログインできません</h2><p>山田 花子・9月14日 9:32</p><p>Googleアカウントを変更したところ、ログインできなくなりました。</p><button class="button primary">救済設定を開く</button>'
};
function closeDrawer(){drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');scrim.classList.remove('open')}
document.querySelectorAll('[data-drawer]').forEach(button=>button.addEventListener('click',()=>{drawerContent.innerHTML=drawerTemplates[button.dataset.drawer];drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');scrim.classList.add('open')}));
scrim.addEventListener('click',closeDrawer);document.querySelector('.drawer-close').addEventListener('click',closeDrawer);
const dialog=document.getElementById('dialog');
document.querySelectorAll('[data-dialog]').forEach(button=>button.addEventListener('click',()=>{document.getElementById('dialog-title').textContent=activeStage==='schedule'?'予定表の確認・承認':'3件の確認があります';document.querySelector('#dialog .status').textContent=activeStage==='schedule'?'予定表の確認':'公開前チェック';dialog.classList.add('open');dialog.setAttribute('aria-hidden','false')}));
function closeDialog(){dialog.classList.remove('open');dialog.setAttribute('aria-hidden','true')}
document.querySelector('.dialog-close').addEventListener('click',closeDialog);dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialog()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawer();closeDialog()}});

const picker=document.getElementById('picker-popover');let pickerTarget=null;
function closePicker(){picker.classList.remove('open');picker.setAttribute('aria-hidden','true');pickerTarget=null}
document.addEventListener('click',event=>{
  const role=event.target.closest('.role-select');
  if(role){event.preventDefault();event.stopPropagation();pickerTarget=role;picker.classList.add('open');picker.setAttribute('aria-hidden','false');return}
  const choice=event.target.closest('[data-picker-value]');
  if(choice&&pickerTarget){const value=choice.dataset.pickerValue;pickerTarget.innerHTML=value==='空欄にする'?'＋ 割り当て <span class="select-caret">⌄</span>':`${value} <span class="select-caret">⌄</span>`;pickerTarget.classList.toggle('empty',value==='空欄にする');closePicker();return}
  if(!event.target.closest('#picker-popover'))closePicker();
});

const dndBar=document.getElementById('dnd-dropbar');let dnd={source:null,ghost:null,press:null,active:false,x:0,y:0};
function startDnd(source,e){dnd.source=source;dnd.active=true;document.body.classList.add('dnd-on');dndBar.classList.add('open');dndBar.setAttribute('aria-hidden','false');dnd.ghost=document.createElement('div');dnd.ghost.className='dnd-ghost';dnd.ghost.textContent=source.dataset.dndName||source.textContent.trim().replace('⌄','');document.body.append(dnd.ghost);moveGhost(e)}
function moveGhost(e){if(dnd.ghost){dnd.ghost.style.left=`${e.clientX+12}px`;dnd.ghost.style.top=`${e.clientY+12}px`}}
function endDnd(e){if(!dnd.active){if(dnd.press)clearTimeout(dnd.press);dnd={source:null,ghost:null,press:null,active:false,x:0,y:0};return}const target=e.target.closest('.drop-zone,.role-select');if(target&&target!==dnd.source){target.innerHTML=`${dnd.source.dataset.dndName||'選択した人'} <span class="select-caret">⌄</span>`;target.classList.remove('empty');target.classList.add('dnd-over')}if(dnd.ghost)dnd.ghost.remove();dndBar.classList.remove('open');dndBar.setAttribute('aria-hidden','true');document.body.classList.remove('dnd-on');dnd={source:null,ghost:null,press:null,active:false,x:0,y:0}}
document.addEventListener('pointerdown',event=>{const source=event.target.closest('.draggable-candidate,.role-select.draggable,.cart-chip');if(!source)return;dnd.source=source;dnd.x=event.clientX;dnd.y=event.clientY;if(event.pointerType==='touch')dnd.press=setTimeout(()=>startDnd(source,event),320)});
document.addEventListener('pointermove',event=>{if(!dnd.source)return;if(!dnd.active&&Math.abs(event.clientX-dnd.x)+Math.abs(event.clientY-dnd.y)>8){if(dnd.press)clearTimeout(dnd.press);startDnd(dnd.source,event)}if(dnd.active){event.preventDefault();moveGhost(event);document.querySelectorAll('.dnd-over').forEach(el=>el.classList.remove('dnd-over'));const target=event.target.closest('.drop-zone,.role-select');if(target&&target!==dnd.source)target.classList.add('dnd-over')}},{passive:false});
document.addEventListener('pointerup',endDnd);document.addEventListener('pointercancel',endDnd);
