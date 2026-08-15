# dsh-plugin-prompt-guard

A **dsh web** plugin (desktop + mobile) that keeps pending
permission/approval and multiselect prompts visible and reachable.

## Install

### From GitHub

> **Prerequisite (pnpm ≥ 11).** pnpm 11 blocks git-hosted **transitive**
> dependencies (`blockExoticSubdeps` defaults to `true`). Before installing,
> add one line to your profile's `pnpm-workspace.yaml`:
>
> ```yaml
> blockExoticSubdeps: false
> ```

```sh
dsh plugin --profile web add github:davidgereb/dsh-plugin-prompt-guard
```

Then add the loader row to the profile patch file
(`$DSH_HOME/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: ui-prompt-guard
      name: dsh-plugin-prompt-guard
      config:
        ntfyTopic: your-ntfy-topic     # see Configuration below
        ntfyToken: ""
        cooldownSec: 5
```

> **Root-cause patch.** The plugin's main fix rewrites the served
> `dsh-client-runtime` bundle so `Session#resync()` no longer clears pending
> waits. That patch is applied to the **installed** runtime copies by
> `scripts/patch-client-runtime.mjs` — run it after installing (and after any
> dsh upgrade that re-serves the runtime bundle):

```sh
node scripts/patch-client-runtime.mjs        # idempotent; --revert to undo
```

### From a local checkout

```sh
node scripts/build-client.js
node scripts/patch-client-runtime.mjs        # idempotent; --revert to undo
dsh plugin --profile web link /path/to/dsh-plugin-prompt-guard
# + register the loader row in cordis.patch.yml (see above)
```

Host-half changes need a dsh server restart; browser-bundle changes (client.js
and the runtime patch) reach the GUI on a page refresh.

## The problem

Permission requests (allow/deny), `ask_user_question` answers, and plan
reviews render from the session's *pending waits*. On every **connection
reset** (mobile networks, browser backgrounding, flaky desktop connections)
the app's `Session#resync()` cleared the pending-wait list and relied on a
host replay over the mux to re-mint the cards — which does not always happen.
Result: a prompt you never answered silently disappeared.

## What it does

Three layers, from root cause outward:

1. **Root-cause fix (patched dsh-client-runtime).** The served
   `dsh-client-runtime` bundle no longer clears `this.pending` in `resync()`.
   Pending waits now survive reconnects, so the card **stays on screen until
   you actually answer it**. The host baseline replay re-mints the same
   rpcIds and `mint()` is a `Map.set` keyed by `kind:rpcId`, so the replay is
   a duplicate-free no-op; when the replay is missing the card simply stays.
   Applied by `scripts/patch-client-runtime.mjs` to both installed copies
   (byte-exact, reversible).
2. **Restore-in-place safety net (client plugin).** If a card still disappears
   *without you interacting with it* (Allow / Reject / option pick / submit /
   cancel all count as interaction), the guard opens a short-lived probe mux
   and asks the host for the still-pending waits. If the host still has them,
   it re-renders the prompt itself as a **persistent interactive card**
   (Allow once / Reject, option picker, free-text input) that answers straight
   through `/api/respond` — **no page reload**. It stays until you react.
   Only when the host has no pending wait left (e.g. the server restarted)
   does the old banner appear: tap to reload, ✕ to dismiss.
3. **Notifications, browser open or not.**
   * Browser open (tab hidden / window unfocused): a system notification
     fires when a prompt appears and when one is lost. Permission is requested
     on page load (with a first-interaction retry for browsers that defer the
     load-time prompt); flip `NOTIFY_ONLY_WHEN_UNFOCUSED` or `NOTIFY_ENABLED`
     in `src/client-source.js` to tune.
   * Browser closed: the host half watches the session log
     (`approval/asked` events, `ask_user_question` / `exit_plan_mode` tool
     calls) and, while **no web client is connected**, pushes a notification
     to the configured `ntfyTopic` (and attempts a local desktop notification
     where a display exists).

4. **Settings card (Settings → Plugins → Configurable).** Like Cost Lens and
   the Watchdog, the plugin ships a card that displays and edits the host
   notification config — the ntfy topic, optional access token, and the
   notification cooldown — through `/prompt-guard/api`. UI settings persist to
   `$DSH_HOME/storages/prompt-guard-settings.json` and override the
   `cordis.patch.yml` config. The card also has **two test buttons**:
   * **Test browser notification** — fires a system notification in this
     browser immediately (verifies the Web Notifications channel);
   * **Test ntfy push** — publishes a test message to the configured ntfy
     topic regardless of connected clients (verifies the closed-browser
     channel end to end).

## Layout

```
dsh-plugin-prompt-guard/
├── package.json              # dsh.client web plugin declaration
├── lib/
│   ├── index.js              # host half: pending-wait watcher + ntfy push
│   └── client.js             # browser bundle (generated)
├── src/
│   └── client-source.js      # single source of truth for the browser half
└── scripts/
    ├── build-client.js       # generates lib/client.js
    └── patch-client-runtime.mjs  # applies/reverts the resync() fix (root cause)
```

## Configuration

Per-entry `config:` in `cordis.patch.yml`, overridable live from the
Settings → Plugins → Configurable card (UI settings persist to
`$DSH_HOME/storages/prompt-guard-settings.json` and take precedence):

| Key | Default | Meaning |
|---|---|---|
| `ntfyTopic` | `""` | ntfy.sh topic to push to when the agent needs the user and no browser client is open. Empty disables the push channel. |
| `ntfyToken` | `""` | Optional ntfy.sh access token for private topics (`Authorization: Bearer`). |
| `ntfyPriority` | `4` | ntfy message priority 1–5 (min/low/default/high/max). |
| `cooldownSec` | `5` | Minimum seconds between two host notifications (burst guard). |
| `clickUrl` | `http://127.0.0.1:3080` | URL opened when a notification is tapped (ntfy `Click` header); empty disables. The GUI's default address. |
| `notifyWhileBrowserOpen` | `false` | Also push while a browser client is connected (default: the browser half handles that case). |
| `browserNotify` | `true` | Browser system notifications master switch. |
| `browserNotifyOnlyUnfocused` | `true` | Only notify while the tab is hidden/unfocused. |

Client-side toggles `NOTIFY_ENABLED` / `NOTIFY_ONLY_WHEN_UNFOCUSED` in
`src/client-source.js` are read at build time.

## Reverting

* `node scripts/patch-client-runtime.mjs --revert` — undo the runtime fix.
* Remove the `ui-prompt-guard` insert (and its `config`) from
  `cordis.patch.yml`.
* `dsh plugin --profile web rm dsh-plugin-prompt-guard`
* Restart the dsh server and refresh the page.

> **Compatibility.** Tested against **dsh `0.1.0-rc.6`** on Node.js
> **v24.19.0** (dsh web profile). Older or newer dsh releases may change the
> internals this plugin hooks into — check the changelog before upgrading.

---

> **⚠️ AI-generated, provided as-is.** This project was written with the
> assistance of an AI. It is provided **AS IS** without warranty of any kind,
> express or implied. The author cannot be held responsible for any damage,
> data loss, or misbehaviour that results from using it. Use at your own risk.
