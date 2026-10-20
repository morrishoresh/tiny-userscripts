// Parses a userscript's ==UserScript== header into the fields userScripts.register() needs.
// Shared by the background script and the options page.

const RUN_AT = {
  'document-start': 'document_start',
  'document-body': 'document_end',
  'document-end': 'document_end',
  'document-idle': 'document_idle'
};

function parseHeader(code) {
  const block = /\/\/[ \t]*==UserScript==([\s\S]*?)\/\/[ \t]*==\/UserScript==/.exec(code || '');
  if (!block) return null;
  const header = {};
  for (const line of block[1].split(/\r?\n/)) {
    const m = /^\s*\/\/[ \t]*@([\w:.-]+)(?:[ \t]+(.*?))?\s*$/.exec(line);
    if (m) (header[m[1]] ||= []).push(m[2] || '');
  }
  return header;
}

function describeScript(code) {
  const header = parseHeader(code);
  if (!header) return { error: 'Missing the // ==UserScript== header.' };
  const first = (key) => (header[key] || [''])[0];
  const all = (key) => (header[key] || []).filter(Boolean);

  const info = {
    name: first('name'),
    namespace: first('namespace'),
    version: first('version'),
    description: first('description'),
    matches: all('match'),
    excludeMatches: all('exclude-match'),
    includeGlobs: all('include'),
    excludeGlobs: all('exclude'),
    runAt: RUN_AT[first('run-at')] || 'document_idle',
    allFrames: !('noframes' in header),
    // page: the page's own world, without the GM API; anything else: the isolated USER_SCRIPT world
    world: first('inject-into') === 'page' ? 'MAIN' : 'USER_SCRIPT'
  };

  if (!info.name) return { error: 'The header needs an @name.' };
  if (!info.matches.length && !info.includeGlobs.length) {
    return { error: 'The header needs at least one @match or @include.' };
  }
  if ([...info.includeGlobs, ...info.excludeGlobs].some((g) => /^\/.*\/$/.test(g))) {
    return { error: 'Regular expressions in @include/@exclude are not supported; use globs or @match.' };
  }
  // register() needs match patterns; @include globs then narrow them down
  if (!info.matches.length) info.matches = ['*://*/*'];
  return info;
}

// Host permissions a script needs: the scheme and host of each @match, any path.
function originsFor(info) {
  const origins = info.matches.map((p) =>
    p === '<all_urls>' ? p : p.replace(/^([^:]+:\/\/[^/]*)\/.*$/, '$1/*')
  );
  return [...new Set(origins)];
}
