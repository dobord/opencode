# Marketplace on OpenCode 2

The current implementation uses Core services, the V2 config document pipeline, and the generated V2 client. It does not load the retired `packages/opencode` runtime.

## Build

Use Bun **1.4.4**. Run from the repository root:

Repository tests that exercise Node's plugin loader also need a modern Node runtime with `module.registerHooks` (Node 24 is suitable; Node 20 is not).

```sh
bun install --frozen-lockfile
bun run --cwd packages/cli script/build.ts --single --baseline --skip-install
bun run --cwd packages/desktop build
```

The CLI build also builds and embeds the Web UI. On Linux x64 the CLI is `packages/cli/dist/cli-linux-x64/bin/opencode`. Desktop output is `packages/desktop/out`; run it with `bun run --cwd packages/desktop preview`.

Keep `--baseline` on x64: Desktop bundles the baseline CLI package. Without it, the desktop build can download a published CLI instead of using your local Marketplace implementation.

To resume after the Web stage completed, add `--reuse-web-ui` to the CLI build command. It reuses `.cache/bun-app-archive.bin` and fails if that archive is absent. Do not use it after frontend changes.

To produce a standalone desktop directory without installing it:

```sh
cd packages/desktop
bun --bun x electron-builder --linux --x64 --dir --publish never --config electron-builder.config.ts
```

The desktop executable is then under `packages/desktop/dist/linux-unpacked/`.

On this Ubuntu host, both the unprivileged user-namespace sandbox and the local SUID helper are unavailable. For the explicitly approved **local-only** manual check, launch with an isolated profile:

```sh
OPENCODE_DESKTOP_TEST_ROOT=/tmp/opencode/marketplace-run \
  ./packages/desktop/dist/linux-unpacked/ai.opencode.desktop.dev --no-sandbox
```

`--no-sandbox` disables Electron's protective sandbox. Do not use this command for untrusted projects/plugins or turn the flag into an application default. No system sandbox settings are changed.

## Isolated manual check

Use separate data/config directories rather than replacing your installed OpenCode or its background service:

```sh
export MARKETPLACE_TEST_ROOT=/tmp/opencode/marketplace-run
export XDG_CONFIG_HOME="$MARKETPLACE_TEST_ROOT/config"
export XDG_DATA_HOME="$MARKETPLACE_TEST_ROOT/data"
export XDG_STATE_HOME="$MARKETPLACE_TEST_ROOT/state"
export XDG_CACHE_HOME="$MARKETPLACE_TEST_ROOT/cache"
export OPENCODE_PASSWORD=marketplace-local
mkdir -p "$MARKETPLACE_TEST_ROOT/project"

./packages/cli/dist/cli-linux-x64/bin/opencode serve --port 4410
```

In another terminal, with the password set:

```sh
export OPENCODE_PASSWORD=marketplace-local
./packages/cli/dist/cli-linux-x64/bin/opencode marketplace source-add "$PWD/artifacts/marketplace-smoke" --server http://127.0.0.1:4410
./packages/cli/dist/cli-linux-x64/bin/opencode marketplace list --server http://127.0.0.1:4410
./packages/cli/dist/cli-linux-x64/bin/opencode --server http://127.0.0.1:4410
```

- **Web:** open `http://127.0.0.1:4410`, then **Settings → Extensions → Marketplace**. Connect using username `opencode` and password `marketplace-local` if prompted.
- **TUI:** use `/marketplace` or choose **Marketplace** from the command palette.
- **Desktop:** set `OPENCODE_DESKTOP_TEST_ROOT=/tmp/opencode/marketplace-run` when launching the built desktop executable or `bun run --cwd packages/desktop preview`. This isolates both desktop preferences and its server. You can also add `http://127.0.0.1:4410` in its server settings to inspect the exact Web/TUI test server.

Install **Alpha Tools**, explicitly accept the trust warning, and check Plugins, Skills, and MCPs. Toggle each component and the entire package, uninstall it, and check the installed/updates/source tabs. Source edits and package operations live in SQLite and do not rewrite `opencode.json(c)`. Plugin and config consumers reload without restarting the server.

The smoke catalog's plugins use the V2 plugin API. Arbitrary third-party V1 plugin implementations still require a source-level port; Marketplace does not translate executable plugin code.

## CLI and API

`opencode marketplace <action> [target]` supports `list`, `refresh`, `plan`, `install`, `uninstall`, `update-all`, `toggle`, `source-add`, `source-toggle`, `source-remove`, `profile`, and `prune`. All server-connecting actions accept `--server` or `--standalone`.

Use `--accept-untrusted` only after reviewing a catalog, `--force` for reviewed conflicts, and `--component skill|mcp --id <component> --disabled` to disable an individual component.

The HTTP routes are experimental: `/api/experimental/marketplace/...`; the generated client exposes `client.experimental.marketplace`. Mutations require `expected_revision`, and stale revisions fail rather than overwrite concurrent changes.
