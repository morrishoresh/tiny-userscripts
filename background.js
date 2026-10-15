// Chrome runs this as a service worker; Firefox loads meta.js itself via background.scripts.
if (typeof importScripts === 'function') importScripts('meta.js');

const ext = globalThis.browser || globalThis.chrome;

// --- registration ------------------------------------------------------------------------
// storage.local `scripts` is the source of truth. Every change re-registers everything, and
// the outcome per script goes to storage.local `status` for the options page to show.

let syncing = Promise.resolve();

function sync() {
  syncing = syncing
    .then(registerAll)
    .catch((e) => console.error('[Tiny Userscripts] sync failed', e));
  return syncing;
}

async function userScriptsAllowed() {
  try {
    await ext.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

async function registerAll() {
  const { scripts } = await ext.storage.local.get({ scripts: [] });
  const status = {};

  if (!(await userScriptsAllowed())) {
    for (const script of scripts) status[script.id] = 'User scripts not allowed';
    await ext.storage.local.set({ status });
    return;
  }

  await ext.userScripts.configureWorld({ messaging: true });
  const ids = (await ext.userScripts.getScripts()).map((s) => s.id);
  if (ids.length) await ext.userScripts.unregister({ ids });

  for (const script of scripts) status[script.id] = await registerOne(script);
  await ext.storage.local.set({ status });
}

async function registerOne(script) {
  if (!script.enabled) return 'Disabled';
  const info = describeScript(script.code);
  if (info.error) return info.error;
  if (!(await ext.permissions.contains({ origins: originsFor(info) }))) return 'Needs site access';

  const registration = {
    id: script.id,
    js: [{ code: wrap(script, info) }],
    matches: info.matches,
    runAt: info.runAt,
    allFrames: info.allFrames
  };
  if (info.excludeMatches.length) registration.excludeMatches = info.excludeMatches;
  if (info.includeGlobs.length) registration.includeGlobs = info.includeGlobs;
  if (info.excludeGlobs.length) registration.excludeGlobs = info.excludeGlobs;

  try {
    await ext.userScripts.register([registration]);
    return 'Running';
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// --- the GM API ---------------------------------------------------------------------------
// gmApi is serialized into every user script, so it must not reference anything outside itself.

function gmApi(scriptId, info) {
  const runtime = (globalThis.browser || globalThis.chrome).runtime;

  async function call(op, ...args) {
    const reply = await runtime.sendMessage({ scriptId, op, args });
    if (reply && reply.error) throw new Error(reply.error);
    return reply ? reply.value : undefined;
  }

  return Object.freeze({
    info: Object.freeze(info),
    getValue: async (key, defaultValue) => {
      const value = await call('getValue', key);
      return value === undefined ? defaultValue : value;
    },
    setValue: async (key, value) => {
      await call('setValue', key, value);
    },
    deleteValue: async (key) => {
      await call('deleteValue', key);
    },
    listValues: () => call('listValues'),
    notification(details, title, image, onclick) {
      if (typeof details !== 'object' || details === null) details = { text: details, title, image, onclick };
      const wait = typeof details.onclick === 'function' || typeof details.ondone === 'function';
      call('notification', { title: details.title || info.script.name, text: details.text, wait }).then(
        (result) => {
          if (result === 'clicked' && details.onclick) details.onclick();
          if (details.ondone) details.ondone();
        },
        () => {}
      );
    }
  });
}

function wrap(script, info) {
  const gmInfo = {
    scriptHandler: 'Tiny Userscripts',
    version: ext.runtime.getManifest().version,
    script: { name: info.name, namespace: info.namespace, version: info.version, description: info.description }
  };
  return [
    '(function () {',
    `const GM = (${gmApi})(${JSON.stringify(script.id)}, ${JSON.stringify(gmInfo)});`,
    'const GM_info = GM.info;',
    script.code,
    '})();',
    `//# sourceURL=tiny-userscripts/${encodeURIComponent(info.name)}.user.js`
  ].join('\n');
}

// --- messages from user scripts ------------------------------------------------------------

const SCRIPT_ID = /^s-[0-9a-f-]{36}$/;
let valueWrites = Promise.resolve();

function queueWrite(fn) {
  const run = valueWrites.then(fn);
  valueWrites = run.catch(() => {});
  return run;
}

async function readValues(key) {
  await valueWrites;
  return (await ext.storage.local.get({ [key]: {} }))[key];
}

async function handle({ scriptId, op, args = [] }) {
  const key = `values:${scriptId}`;
  switch (op) {
    case 'getValue':
      return (await readValues(key))[args[0]];
    case 'listValues':
      return Object.keys(await readValues(key));
    case 'setValue':
    case 'deleteValue':
      return queueWrite(async () => {
        const values = (await ext.storage.local.get({ [key]: {} }))[key];
        if (op === 'setValue') values[args[0]] = args[1];
        else delete values[args[0]];
        await ext.storage.local.set({ [key]: values });
      });
    case 'notification':
      return notify(args[0]);
    default:
      throw new Error(`Unknown GM operation: ${op}`);
  }
}

let listening = false;

// In Firefox the event only exists once the optional userScripts permission is granted.
function listenToUserScripts() {
  if (listening || !ext.runtime.onUserScriptMessage) return;
  listening = true;
  ext.runtime.onUserScriptMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !SCRIPT_ID.test(msg.scriptId)) return false;
    handle(msg).then(
      (value) => sendResponse({ value }),
      (e) => sendResponse({ error: String((e && e.message) || e) })
    );
    return true;
  });
}

// --- notifications -------------------------------------------------------------------------

const waiting = new Map(); // notificationId -> resolve

async function notify({ title, text, wait }) {
  const id = `n-${crypto.randomUUID()}`;
  await ext.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: String(title || 'Userscript'),
    message: String(text || '')
  });
  if (!wait) return 'shown';
  return new Promise((resolve) => waiting.set(id, resolve));
}

function settle(id, result) {
  const resolve = waiting.get(id);
  if (!resolve) return;
  waiting.delete(id);
  resolve(result);
}

ext.notifications.onClicked.addListener((id) => {
  settle(id, 'clicked');
  ext.notifications.clear(id);
});
ext.notifications.onClosed.addListener((id) => settle(id, 'closed'));

// --- wiring --------------------------------------------------------------------------------

listenToUserScripts();
ext.runtime.onInstalled.addListener(() => sync());
ext.runtime.onStartup.addListener(() => sync());
ext.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.scripts) sync();
});
ext.permissions.onAdded.addListener(() => {
  listenToUserScripts();
  sync();
});
ext.permissions.onRemoved.addListener(() => sync());
ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());
