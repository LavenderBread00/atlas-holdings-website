(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let user = null, dashboard = null;
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
    const identity = $('identity'); identity.replaceChildren(element('strong', '', user.name), element('small', '', user.email));
    $('role-badge').textContent = user.role === 'chairman' ? 'CHAIRMAN' : 'HOLDINGS STAFF';
    $('greeting').textContent = 'Welcome, ' + user.name + '.';
    $('account-summary').textContent = user.name + ' · ' + user.email;
    switchTab('overview');
    await loadDashboard();
  }
  function switchTab(name) {
    if (name === 'team' && user?.role !== 'chairman') return;
    notice('');
    document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== 'tab-' + name; });
    document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
    if (name === 'team') loadStaff().catch(error => notice(error.message));
  }
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
    const list = $('announcements-list'); list.replaceChildren();
    dashboard.announcements.forEach(item => {
      const card = element('article', 'announcement');
      card.append(element('h2', '', item.title), element('p', 'meta', item.author + ' · ' + date(item.created_at)), element('p', 'body', item.body));
      if (user.role === 'chairman') card.append(deleteButton('announcement', item.id));
      list.append(card);
    });
    if (!dashboard.announcements.length) list.append(element('p', 'empty', 'No group announcements have been published yet.'));
    const resources = $('resources-list'); resources.replaceChildren();
    dashboard.resources.forEach(item => {
      const card = element('article', 'resource'), link = element('a', '', item.title + ' ↗');
      link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
      if (user.role === 'chairman') card.append(deleteButton('resource', item.id));
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
    result.invites.forEach(item => { const card = element('article', 'person'), info = element('div'); info.append(element('h3', '', item.name), element('small', '', item.email), element('small', '', 'Expires ' + date(item.expires_at))); card.append(info); pending.append(card); });
    if (!result.invites.length) pending.append(element('p', 'empty', 'No pending invitations.'));
  }
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
