const ext = globalThis.browser || globalThis.chrome;

let editingId = null;
// Files picked together with Import files…, installed in one go: [{ fileName, code }]
let batch = null;

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
function requestAccess(...infos) {
  return ext.permissions.request({ origins: [...new Set(infos.flatMap(originsFor))] });
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
// Takes [{ code, info }] and saves them in one write; returns 'Installed' or 'Updated' for each.
async function saveScripts(items) {
  const { scripts } = await ext.storage.local.get({ scripts: [] });
  const verbs = items.map(({ code, info }) => {
    const existing = editingId
      ? scripts.find((s) => s.id === editingId)
      : scripts.find((s) => {
          const other = describeScript(s.code);
          return other.name === info.name && other.namespace === info.namespace;
        });
    if (existing) existing.code = code;
    else scripts.push({ id: `s-${crypto.randomUUID()}`, code, enabled: true });
    return existing ? 'Updated' : 'Installed';
  });
  await ext.storage.local.set({ scripts });
  return verbs;
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
  batch = null;
  el('code').value = '';
  el('code').readOnly = false;
  el('editorTitle').textContent = 'Install a userscript';
  el('save').textContent = 'Install';
  el('cancel').hidden = true;
}

// The batch is shown read-only in the editor, one file after another.
function startBatch(files) {
  stopEditing();
  batch = files;
  el('code').value = files.map((f) => `// ----- ${f.fileName} -----\n\n${f.code.trim()}\n`).join('\n');
  el('code').readOnly = true;
  el('editorTitle').textContent = `Install ${files.length} userscripts`;
  el('save').textContent = 'Install all';
  el('cancel').hidden = false;
}

// ['Installed', 'Installed', 'Updated'] -> 'Installed 2 scripts, updated 1 script'
function countVerbs(verbs) {
  return ['Installed', 'Updated']
    .map((verb) => [verb, verbs.filter((v) => v === verb).length])
    .filter(([, n]) => n > 0)
    .map(([verb, n], i) => `${i ? verb.toLowerCase() : verb} ${n} script${n === 1 ? '' : 's'}`)
    .join(', ');
}

el('save').addEventListener('click', () => {
  const files = batch || [{ code: el('code').value }];
  const items = files.map(({ fileName, code }) => ({ fileName, code, info: describeScript(code) }));
  const valid = items.filter((item) => !item.info.error);
  const skipped = items
    .filter((item) => item.info.error)
    .map((item) => (batch ? `Skipped ${item.fileName}: ${item.info.error}` : item.info.error));
  if (!valid.length) return say(skipped.join('\n'), true);

  let access;
  try {
    access = requestAccess(...valid.map((item) => item.info));
  } catch (e) {
    return say(e.message, true);
  }
  access
    .then((granted) =>
      saveScripts(valid).then((verbs) => {
        stopEditing();
        const done = valid.length === 1 ? `${verbs[0]} ${valid[0].info.name}` : countVerbs(verbs);
        const text = granted ? `${done}.` : `${done}, but site access was not granted.`;
        say([text, ...skipped].join('\n'), !granted || skipped.length > 0);
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
  const files = [...el('file').files];
  el('file').value = '';
  if (!files.length) return;
  if (files.length > 1) {
    startBatch(await Promise.all(files.map(async (f) => ({ fileName: f.name, code: await f.text() }))));
    return say(`Loaded ${files.length} files. Review them, then click Install all.`);
  }
  stopEditing();
  el('code').value = await files[0].text();
  say(`Loaded ${files[0].name}. Review it, then click Install.`);
});

ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.scripts || changes.status)) render();
});
ext.permissions.onAdded.addListener(() => render());
ext.permissions.onRemoved.addListener(() => render());

render();
