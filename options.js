const ext = globalThis.browser || globalThis.chrome;

let editingId = null;

function el(id) {
  return document.getElementById(id);
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function say(text, bad = false) {
  el('message').textContent = text;
  el('message').className = bad ? 'bad' : '';
}

// Firefox only shows the permission prompt when request() runs straight from a click,
// so callers must not await anything before calling this. userScripts cannot be requested
// together with anything else; the banner's Allow button requests it on its own.
function requestAccess(info) {
  return ext.permissions.request({ origins: originsFor(info) });
}

function hasUserScriptsPermission() {
  return ext.permissions.contains({ permissions: ['userScripts'] });
}

// Chrome also needs the "Allow User Scripts" toggle before the API works.
async function userScriptsAllowed() {
  try {
    await ext.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

// --- list ------------------------------------------------------------------------------------

async function render() {
  const { scripts, status } = await ext.storage.local.get({ scripts: [], status: {} });
  el('scripts').replaceChildren(...scripts.map((s) => row(s, status[s.id])));
  el('empty').hidden = scripts.length > 0;
  await renderBanner();
}

function row(script, status = 'Pending') {
  const info = describeScript(script.code);
  const li = make('li');

  const toggle = make('input');
  toggle.type = 'checkbox';
  toggle.checked = script.enabled;
  toggle.title = 'Enabled';
  toggle.addEventListener('change', () => updateScript(script.id, { enabled: toggle.checked }));

  const main = make('div', 'main');
  const name = make('div', 'name', info.name || '(invalid script)');
  if (info.version) name.append(make('span', 'version', info.version));
  main.append(name);
  if (info.description) main.append(make('div', 'desc', info.description));
  if (info.matches) main.append(matchesLine(script.id, info.matches));

  const state = make('span', 'status', status);
  if (status === 'Running') state.classList.add('ok');
  else if (status !== 'Disabled' && status !== 'Pending') state.classList.add('bad');

  li.append(toggle, main, state);

  if (status === 'Needs site access' && !info.error) {
    const grant = make('button', '', 'Grant access');
    grant.addEventListener('click', () => requestAccess(info).catch((e) => say(e.message, true)));
    li.append(grant);
  }

  const edit = make('button', '', 'Edit');
  edit.addEventListener('click', () => startEditing(script, info));
  const remove = make('button', '', 'Delete');
  remove.addEventListener('click', () => {
    if (confirm(`Delete "${info.name || 'this script'}" and its stored values?`)) deleteScript(script.id);
  });
  li.append(edit, remove);
  return li;
}

// Only the first @match is shown; the rest are behind a toggle. The set keeps a script expanded
// across re-renders (every storage change re-renders the list).
const expanded = new Set();

function matchesLine(id, matches) {
  const line = make('div', 'matches');
  if (matches.length <= 1) {
    line.textContent = matches.join('');
    return line;
  }
  const open = expanded.has(id);
  const toggle = make('button', 'more', open ? 'Show less' : `+${matches.length - 1} more`);
  toggle.addEventListener('click', () => {
    if (open) expanded.delete(id);
    else expanded.add(id);
    line.replaceWith(matchesLine(id, matches));
  });
  line.append(open ? matches.join('  ') : matches[0], ' ', toggle);
  return line;
}

async function renderBanner() {
  const banner = el('banner');
  if (!(await hasUserScriptsPermission())) {
    banner.hidden = false;
    const allow = make('button', '', 'Allow');
    allow.addEventListener('click', () =>
      ext.permissions
        .request({ permissions: ['userScripts'] })
        .then((granted) => granted && render())
        .catch((e) => say(e.message, true))
    );
    banner.replaceChildren('Tiny Userscripts needs your permission to run user scripts.', allow);
    return;
  }
  if (await userScriptsAllowed()) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.replaceChildren(
    'Chrome blocks user scripts until you allow them: open chrome://extensions, click Details on ' +
      'Tiny Userscripts and turn on "Allow User Scripts" (before Chrome 138: turn on Developer mode). ' +
      'Then reload this page.'
  );
}

// --- storage -----------------------------------------------------------------------------------

async function updateScript(id, changes) {
  const { scripts } = await ext.storage.local.get({ scripts: [] });
  const script = scripts.find((s) => s.id === id);
  if (!script) return;
  Object.assign(script, changes);
  await ext.storage.local.set({ scripts });
}

async function deleteScript(id) {
  const { scripts } = await ext.storage.local.get({ scripts: [] });
  await ext.storage.local.set({ scripts: scripts.filter((s) => s.id !== id) });
  await ext.storage.local.remove(`values:${id}`);
  if (editingId === id) stopEditing();
}

// Installing a script with the same @name and @namespace as an existing one updates it.
async function saveScript(code, info) {
  const { scripts } = await ext.storage.local.get({ scripts: [] });
  const existing = editingId
    ? scripts.find((s) => s.id === editingId)
    : scripts.find((s) => {
        const other = describeScript(s.code);
        return other.name === info.name && other.namespace === info.namespace;
      });
  if (existing) existing.code = code;
  else scripts.push({ id: `s-${crypto.randomUUID()}`, code, enabled: true });
  await ext.storage.local.set({ scripts });
  return existing ? 'Updated' : 'Installed';
}

// --- editor --------------------------------------------------------------------------------------

function startEditing(script, info) {
  editingId = script.id;
  el('code').value = script.code;
  el('editorTitle').textContent = `Edit ${info.name || 'script'}`;
  el('save').textContent = 'Save';
  el('cancel').hidden = false;
  say('');
  el('code').scrollIntoView({ behavior: 'smooth' });
}

function stopEditing() {
  editingId = null;
  el('code').value = '';
  el('editorTitle').textContent = 'Install a userscript';
  el('save').textContent = 'Install';
  el('cancel').hidden = true;
}

el('save').addEventListener('click', () => {
  const code = el('code').value;
  const info = describeScript(code);
  if (info.error) return say(info.error, true);

  let access;
  try {
    access = requestAccess(info);
  } catch (e) {
    return say(e.message, true);
  }
  access
    .then((granted) =>
      saveScript(code, info).then((verb) => {
        stopEditing();
        say(granted ? `${verb} ${info.name}.` : `${verb} ${info.name}, but site access was not granted.`, !granted);
      })
    )
    .catch((e) => say(e.message, true));
});

el('cancel').addEventListener('click', () => {
  stopEditing();
  say('');
});

el('import').addEventListener('click', () => el('file').click());
el('file').addEventListener('change', async () => {
  const file = el('file').files[0];
  el('file').value = '';
  if (!file) return;
  stopEditing();
  el('code').value = await file.text();
  say(`Loaded ${file.name}. Review it, then click Install.`);
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.scripts || changes.status)) render();
});
ext.permissions.onAdded.addListener(() => render());
ext.permissions.onRemoved.addListener(() => render());

render();
