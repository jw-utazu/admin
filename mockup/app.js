const pages=document.querySelectorAll('.page');
const navButtons=document.querySelectorAll('[data-page]');
const stageCopy={
  schedule:['日程','実施日と申込期間を設定します。','設定完了'],
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
  document.querySelectorAll('.stage').forEach(stage=>stage.classList.toggle('active',stage.dataset.stage===name));
  document.getElementById('stage-title').textContent=copy[0];
  document.getElementById('stage-help').textContent=copy[1];
  const badge=document.querySelector('.work-toolbar .status');
  badge.textContent=copy[2];
  showPage('monthly');
}
document.querySelectorAll('[data-stage]').forEach(button=>button.addEventListener('click',()=>showStage(button.dataset.stage)));
const scrim=document.getElementById('scrim');
const drawer=document.getElementById('drawer');
const drawerContent=document.getElementById('drawer-content');
const drawerTemplates={
  account:'<p class="eyebrow">アカウント</p><h2>田中 太郎</h2><p>区域係・通常PW</p><ul><li>アカウントを切り替える</li><li>マニュアルを開く</li><li>ログアウト</li></ul>',
  stages:'<p class="eyebrow">月次運用</p><h2>段階を選ぶ</h2><ul><li>✓ 日程 — 完了</li><li>✓ 希望 — 受付終了</li><li><b>3 シフト作成 — 編集中</b></li><li>4 確認 — 未開始</li><li>5 公開 — 9月20日予定</li></ul>',
  message:'<p class="eyebrow">ログイン救済</p><h2>ログインできません</h2><p>山田 花子・9月14日 9:32</p><p>Googleアカウントを変更したところ、ログインできなくなりました。</p><button class="button primary">救済設定を開く</button>'
};
function closeDrawer(){drawer.classList.remove('open');drawer.setAttribute('aria-hidden','true');scrim.classList.remove('open')}
document.querySelectorAll('[data-drawer]').forEach(button=>button.addEventListener('click',()=>{drawerContent.innerHTML=drawerTemplates[button.dataset.drawer];drawer.classList.add('open');drawer.setAttribute('aria-hidden','false');scrim.classList.add('open')}));
scrim.addEventListener('click',closeDrawer);document.querySelector('.drawer-close').addEventListener('click',closeDrawer);
const dialog=document.getElementById('dialog');
document.querySelectorAll('[data-dialog]').forEach(button=>button.addEventListener('click',()=>{dialog.classList.add('open');dialog.setAttribute('aria-hidden','false')}));
function closeDialog(){dialog.classList.remove('open');dialog.setAttribute('aria-hidden','true')}
document.querySelector('.dialog-close').addEventListener('click',closeDialog);dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialog()});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeDrawer();closeDialog()}});
