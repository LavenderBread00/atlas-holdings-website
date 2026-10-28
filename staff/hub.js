(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let user = null, dashboard = null, directory = null;
  const isManager = () => user?.role === 'chairman' || user?.management === true;
  const rankName = person => person.role === 'chairman' ? 'Chairman' : person.rank || 'Holdings Staff';
  const inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (inviteToken) history.replaceState(null, '', location.pathname);
  $('year').textContent = new Date().getFullYear();
  function notice(message, success = false) {
    $('notice').textContent = message;
    $('notice').classList.toggle('success', success);
    $('notice').hidden = !message;
  }
  async function api(action, data) {
    const res = await fetch('/api/staff/' + action, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
    let result;
    try { result = await res.json(); } catch { throw new Error('The staff service is awaiting activation. Please contact the chairman.'); }
    if (!res.ok) {
      if (res.status === 401 && user) { user = null; showAuth(); }
      throw new Error(result.error || 'The request could not be completed.');
    }
    return result;
  }
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const date = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function showAuth(mode = 'login') {
    $('loading').hidden = true; $('workspace').hidden = true; $('auth').hidden = false;
    ['login', 'setup', 'invite'].forEach(value => { $(value + '-form').hidden = mode !== value; });
    $('auth-title').textContent = mode === 'invite' ? 'Join the group.' : mode === 'setup' ? 'Set up your hub.' : 'Welcome back.';
    $('auth-description').textContent = mode === 'invite' ? 'Create your individual Altaş Holdings staff account.' : mode === 'setup' ? 'Create the first chairman account.' : 'Sign in with your Altaş Holdings staff account.';
    $('return-login').hidden = mode === 'login';
    $('setup-toggle').hidden = mode !== 'login' || !$('setup-toggle').dataset.available;
  }
  async function showWorkspace() {
    $('loading').hidden = true; $('auth').hidden = true; $('workspace').hidden = false;
    document.querySelectorAll('.chairman-only').forEach(el => { el.hidden = user.role !== 'chairman'; });
    document.querySelectorAll('.management-only').forEach(el => { el.hidden = !isManager(); });
    const identity = $('identity'); identity.replaceChildren(element('strong', '', user.name), element('small', '', user.email));
    $('role-badge').textContent = rankName(user).toUpperCase();
    $('greeting').textContent = 'Welcome, ' + user.name + '.';
    $('account-summary').textContent = user.name + ' · ' + user.email + ' · ' + rankName(user) + (user.department ? ' · ' + user.department : '');
    switchTab('overview');
    await loadDashboard();
  }
  function switchTab(name) {
    if (['team','ranks','activity'].includes(name) && user?.role !== 'chairman') return;
    if (name === 'directory' && !isManager()) return;
    notice('');
    $('workspace-menu').setAttribute('aria-expanded','false');
    $('workspace-menu').parentElement.classList.remove('menu-open');
    document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== 'tab-' + name; });
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
    if (name === 'team') loadStaff().catch(error => notice(error.message));
    if (['directory','ranks'].includes(name) || (name === 'tasks' && isManager())) loadDirectory().catch(error => notice(error.message));
    if (name === 'activity') loadActivity().catch(error => notice(error.message));
    if (name === 'tasks') loadDashboard().catch(error => notice(error.message));
  }
  $('workspace-menu').addEventListener('click',()=>{const open=$('workspace-menu').getAttribute('aria-expanded')!=='true';$('workspace-menu').setAttribute('aria-expanded',String(open));$('workspace-menu').parentElement.classList.toggle('menu-open',open);});
  document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
  function bindForm(id, callback) {
    $(id).addEventListener('submit', async event => {
      event.preventDefault(); notice('');
      const form = event.currentTarget, button = form.querySelector('[type=submit]');
      const values = Object.fromEntries(new FormData(form));
      if ('confirm' in values && values.password !== values.confirm) { notice('The passwords do not match.'); return; }
      button.disabled = true;
      try { await callback(values, form); } catch (error) { notice(error.message); }
      finally { button.disabled = false; }
    });
  }
  bindForm('login-form', async (values, form) => { const result = await api('login', { ...values, remember: values.remember === 'on' }); form.reset(); user = result.user; await showWorkspace(); });
  bindForm('setup-form', async (values, form) => { const result = await api('setup', values); form.reset(); user = result.user; await showWorkspace(); });
  bindForm('invite-form', async (values, form) => { const result = await api('accept-invite', { password: values.password, token: inviteToken }); form.reset(); user = result.user; await showWorkspace(); });
  $('setup-toggle').addEventListener('click', () => showAuth('setup'));
  $('logout').addEventListener('click', async () => {
    try { await api('logout', {}); location.replace('/staff/'); } catch (error) { notice(error.message); }
  });
  // Sign out remains available on compact screens via the My account tab.
  const mobileLogout = element('button', 'text-button', 'Sign out of Altaş →');
  mobileLogout.type = 'button'; mobileLogout.addEventListener('click', () => $('logout').click());
  $('tab-account').append(mobileLogout);
  function deleteButton(kind, id) {
    const button = element('button', 'delete-button', 'Delete'); button.type = 'button';
    button.addEventListener('click', async () => {
      if (!window.confirm('Delete this ' + kind + '?')) return;
      button.disabled = true;
      try { await api('delete-content', { kind, id }); await loadDashboard(); notice('Content deleted.', true); }
      catch (error) { notice(error.message); button.disabled = false; }
    });
    return button;
  }
  async function loadDashboard() {
    dashboard = await api('dashboard');
    renderTasks();
    const stats = $('hub-stats'); stats.replaceChildren();
    [['Open tasks',(dashboard.tasks || []).filter(t => t.status !== 'done').length],['Announcements',dashboard.announcements.length],['Shared resources',dashboard.resources.length]].forEach(([label,count]) => { const card=element('div','stat-card'); card.append(element('strong','',String(count)),element('span','',label)); stats.append(card); });
    const list = $('announcements-list'); list.replaceChildren();
    dashboard.announcements.forEach(item => {
      const card = element('article', 'announcement');
      card.append(element('h2', '', item.title), element('p', 'meta', item.author + ' · ' + date(item.created_at)), element('p', 'body', item.body));
      if (isManager()) card.append(deleteButton('announcement', item.id));
      list.append(card);
    });
    if (!dashboard.announcements.length) list.append(element('p', 'empty', 'No group announcements have been published yet.'));
    const resources = $('resources-list'); resources.replaceChildren();
    dashboard.resources.forEach(item => {
      const card = element('article', 'resource'), link = element('a', '', item.title + ' ↗');
      link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      if (isManager()) card.append(deleteButton('resource', item.id));
      resources.append(card);
    });
    if (!dashboard.resources.length) resources.append(element('p', 'empty', 'Shared documents and links will appear here when added by the chairman.'));
  }
  bindForm('announcement-form', async (values, form) => { await api('announcement', values); form.reset(); await loadDashboard(); notice('Announcement published.', true); });
  bindForm('resource-form', async (values, form) => { await api('resource', values); form.reset(); await loadDashboard(); notice('Resource added.', true); });
  bindForm('password-form', async (values, form) => { await api('password', { password: values.password, currentPassword: values.currentPassword }); form.reset(); notice('Password updated. Your other sessions have been signed out.', true); });
  bindForm('new-invite-form', async (values, form) => {
    const result = await api('invite', values); form.reset(); $('invite-result').hidden = false; $('invite-link').value = result.link;
    await loadStaff(); notice('Invitation created. Share the private link with the intended staff member.', true);
  });
  $('copy-invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('invite-link').value); notice('Invitation link copied.', true); }
    catch { $('invite-link').select(); notice('Select and copy the invitation link above.'); }
  });
  async function loadStaff() {
    const result = await api('staff'); const list = $('staff-list'); list.replaceChildren();
    result.staff.forEach(person => {
      const card = element('article', 'person'), info = element('div');
      info.append(element('h3', '', person.name), element('small', '', person.email), element('small', '', (person.role === 'chairman' ? 'Chairman' : 'Holdings staff') + ' · ' + (person.active ? 'Active' : 'Suspended'))); card.append(info);
      if (person.role !== 'chairman') {
        const button = element('button', '', person.active ? 'Suspend access' : 'Restore access'); button.type = 'button';
        button.addEventListener('click', async () => {
          if (person.active && !window.confirm('Suspend ' + person.name + ' and sign out their sessions?')) return;
          button.disabled = true;
          try { await api('staff-access', { id: person.id, active: !person.active }); await loadStaff(); notice('Staff access updated.', true); }
          catch (error) { notice(error.message); button.disabled = false; }
        }); card.append(button);
      }
      list.append(card);
    });
    const pending = $('pending-list'); pending.replaceChildren();
    result.invites.forEach(item => { const card = element('article', 'person'), info = element('div'); info.append(element('h3', '', item.name), element('small', '', item.email), element('small', '', 'Expires ' + date(item.expires_at))); card.append(info); const revoke=element('button','secondary','Revoke invitation'); revoke.type='button'; revoke.addEventListener('click',async()=>{if(!confirm('Revoke the invitation for '+item.name+'?'))return;revoke.disabled=true;try{await api('revoke-invite',{email:item.email});await loadStaff();notice('Invitation revoked.',true);}catch(error){notice(error.message);revoke.disabled=false;}});card.append(revoke);pending.append(card); });
    if (!result.invites.length) pending.append(element('p', 'empty', 'No pending invitations.'));
  }

  function selectControl(labelText, options, value) {
    const label=element('label','',labelText), select=element('select');
    options.forEach(([id,name])=>{ const option=element('option','',name);option.value=id;select.append(option); });
    select.value=value; label.append(select);return {label,select};
  }
  async function loadDirectory() {
    directory=await api('directory'); renderDirectory(); renderRanks();
    const select=$('task-assignee'), previous=select.value; select.replaceChildren(element('option','','Choose a staff member'));select.firstChild.value='';
    directory.staff.filter(p=>p.active).forEach(p=>{const option=element('option','',p.name+' · '+rankName(p));option.value=p.id;select.append(option);});
    if([...select.options].some(o=>o.value===previous))select.value=previous;
  }
  function renderDirectory() {
    if(!directory)return;
    const list=$('directory-list'), search=$('staff-search').value.trim().toLowerCase();list.replaceChildren();
    const people=directory.staff.filter(p=>[p.name,p.email,rankName(p),p.department].join(' ').toLowerCase().includes(search));
    people.forEach(person=>{
      const card=element('article','panel directory-card'), info=element('div');
      info.append(element('h2','',person.name),element('p','',person.email),element('span','tag',rankName(person)),element('p','meta',(person.department||'No department assigned')+' · '+(person.active?'Active':'Suspended')));card.append(info);
      if(user.role==='chairman' && person.role!=='chairman') {
        const form=element('form','profile-form'), row=element('div','fields');
        const rank=selectControl('Rank',directory.ranks.map(r=>[r.id,r.name+(r.management?' · Management':'')]),person.rank_id);
        const label=element('label','','Department'), department=element('input'); department.value=person.department;department.maxLength=80;label.append(department);row.append(rank.label,label);
        const save=element('button','','Save assignment');save.type='submit';form.append(row,save);
        form.addEventListener('submit',async event=>{event.preventDefault();const selected=directory.ranks.find(r=>r.id===rank.select.value);if(selected?.management && !person.management && !confirm('Give '+person.name+' management permissions? They will be able to publish content and assign tasks.'))return;save.disabled=true;try{await api('staff-profile',{id:person.id,rank_id:rank.select.value,department:department.value});await loadDirectory();notice('Staff assignment saved.',true);}catch(error){notice(error.message);save.disabled=false;}});card.append(form);
      }
      list.append(card);
    });
    if(!people.length)list.append(element('p','empty','No staff match your search.'));
  }
  function renderRanks() {
    if(!directory || user.role!=='chairman')return;
    const list=$('ranks-list');list.replaceChildren();
    const chairman=element('article','panel');chairman.append(element('h2','','Chairman'),element('p','','Owner rank · protected · full control'));list.append(chairman);
    directory.ranks.forEach(rank=>{
      const form=element('form','panel'), title=element('h2','',rank.name), label=element('label','','Rank name'), name=element('input');name.value=rank.name;name.required=true;name.minLength=2;name.maxLength=60;label.append(name);
      const permission=selectControl('Portal permissions',[['false','Standard staff'],['true','Management']],String(!!rank.management));
      if(rank.id==='staff')permission.select.disabled=true;
      const count=directory.staff.filter(p=>p.role!=='chairman' && p.rank_id===rank.id).length;
      const save=element('button','','Save rank');save.type='submit';form.append(title,element('p','meta',count+' staff assigned'+(rank.id==='staff'?' · default rank':'')),label,permission.label,save);
      form.addEventListener('submit',async event=>{event.preventDefault();const management=permission.select.value==='true';if(management!==!!rank.management && !confirm('Change permissions for '+rank.name+'? This applies immediately to all '+count+' staff assigned to this rank.'))return;save.disabled=true;try{await api('rank',{id:rank.id,name:name.value,management});await loadDirectory();notice('Rank updated.',true);}catch(error){notice(error.message);save.disabled=false;}});list.append(form);
    });
  }
  function renderTasks() {
    const list=$('tasks-list'), filter=$('task-filter').value;list.replaceChildren();
    const tasks=(dashboard?.tasks||[]).filter(t=>filter==='all'||(filter==='done'?t.status==='done':t.status!=='done'));
    tasks.forEach(task=>{
      const card=element('article','panel task-card');const today=new Date().toLocaleDateString('en-CA');
      card.append(element('span','tag',task.priority==='high'?'HIGH PRIORITY':'TASK'),element('h2','',task.title),element('p','task-description',task.description));
      const due=task.due_date?new Date(task.due_date+'T12:00:00').toLocaleDateString(undefined,{dateStyle:'medium'}):'No due date';
      card.append(element('p',task.due_date && task.due_date<today && task.status!=='done'?'overdue':'meta',task.assignee+' · '+due+(task.due_date && task.due_date<today && task.status!=='done'?' · Overdue':'')));
      const status=selectControl('Progress',[['todo','To do'],['in_progress','In progress'],['done','Completed']],task.status); const save=element('button','secondary','Update progress');save.type='button';
      save.addEventListener('click',async()=>{save.disabled=true;try{await api('task-status',{id:task.id,status:status.select.value});await loadDashboard();notice('Task progress updated.',true);}catch(error){notice(error.message);save.disabled=false;}});card.append(status.label,save);list.append(card);
    });
    if(!tasks.length)list.append(element('p','empty',filter==='done'?'No completed tasks yet.':'No tasks to show.'));
  }
  async function loadActivity() {
    const result=await api('activity'), list=$('activity-list');list.replaceChildren();
    result.activity.forEach(item=>{const card=element('article','panel activity-card');card.append(element('h3','',item.action),element('p','',item.detail),element('p','meta',item.actor+' · '+date(item.created_at)));list.append(card);});
    if(!result.activity.length)list.append(element('p','empty','Management changes will appear here.'));
  }
  $('staff-search').addEventListener('input',renderDirectory);
  $('task-filter').addEventListener('change',renderTasks);
  $('refresh-tasks').addEventListener('click',()=>loadDashboard().catch(e=>notice(e.message)));
  $('refresh-activity').addEventListener('click',()=>loadActivity().catch(e=>notice(e.message)));
  bindForm('rank-form',async(values,form)=>{await api('rank',{name:values.name,management:values.management==='true'});form.reset();await loadDirectory();notice('Rank created. Assign it in the staff directory.',true);});
  bindForm('task-form',async(values,form)=>{await api('task',values);form.reset();await loadDashboard();notice('Task assigned.',true);});

  async function init() {
    try {
      const status = await api('status');
      $('setup-toggle').dataset.available = status.setup ? 'true' : '';
      if (inviteToken) { showAuth('invite'); return; }
      try { const result = await api('me'); user = result.user; }
      catch (error) { if (!error.message.includes('sign in')) throw error; }
      if (user) await showWorkspace(); else showAuth();
    } catch (error) {
      showAuth(); notice(error.message);
      document.querySelectorAll('#auth form button[type=submit]').forEach(button => { button.disabled = true; });
    }
  }
  init();
})();
