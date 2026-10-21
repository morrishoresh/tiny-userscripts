# Tiny Userscripts

A minimal userscript manager for Firefox (140+) and Chrome (131+). Scripts are stored in the
extension's local storage, never inside the extension package.

## Install

**Firefox, for testing:** `about:debugging` → This Firefox → Load Temporary Add-on → pick
`manifest.json`. Removed when Firefox restarts.

**Firefox, permanent:** sign it as an unlisted add-on (not published on AMO):

```sh
web-ext sign --channel=unlisted --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET
```

then open the resulting `.xpi` in Firefox.

**Chrome:** `chrome://extensions` → Developer mode → Load unpacked → pick this folder. Click **Allow**
in the manager's banner, then open the extension's Details and turn on **Allow User Scripts**.

## Use

Click the toolbar icon to open the manager. Paste a script (or **Import files…**) and click
**Install**. **Import files…** accepts several files at once; they are shown read-only and
**Install all** installs them together, with one prompt for the sites they match (files with an
invalid header are skipped). Click **Allow** in the banner once to permit user scripts; each script
then asks for access to the sites it matches. Installing a script with the same `@name` and `@namespace` as an existing
one updates it.

## Supported header keys

| Key | Effect |
|---|---|
| `@name` | Required |
| `@namespace`, `@version`, `@description` | Shown in the manager and `GM.info` |
| `@match` / `@exclude-match` | Match patterns |
| `@include` / `@exclude` | Globs (no regular expressions) |
| `@run-at` | `document-start`, `document-end`, `document-idle` (default) |
| `@noframes` | Top frame only |
| `@inject-into page` | Run in the page's own world instead of the isolated user script world. The script then sees the page's globals and cookies, and gets only `GM.info` / `GM_info`, no other GM API |

`@grant`, `@require` and `@resource` are ignored.

## GM API

Every script gets `GM` (Greasemonkey 4 style, async) and `GM_info`:

- `GM.getValue(key, default)`, `GM.setValue(key, value)`, `GM.deleteValue(key)`, `GM.listValues()` —
  per-script storage, deleted with the script
- `GM.notification({ title, text, onclick, ondone })` or `GM.notification(text, title)`
- `GM.info`

There is no synchronous `GM_getValue`, no `GM_xmlhttpRequest` and no menu commands.
