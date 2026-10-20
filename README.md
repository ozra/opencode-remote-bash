# opencode-remote-bash

An [OpenCode](https://opencode.ai) plugin that adds a `remote_bash` tool, letting a model
session run commands on remote machines over **SSH ControlMaster multiplexing** — one
long-lived master connection per host, so every call reuses the socket instead of doing a
full SSH handshake each time.

Designed to run an opencode session on one machine and drive commands on the other machines
in your fleet over plain SSH — no agents or daemons to install on the targets.

## Tools

### `remote_bash`

Its `command`, `timeout`, `workdir` and `description` arguments mirror the built-in
[`bash`](https://opencode.ai) tool so the two behave as similarly as possible — the only
addition is `hostalias` (which host to run on) and an optional `env` override.

```
remote_bash(hostalias, command, { description, timeout?, workdir?, env? })
```

- `hostalias` is **validated against an allowlist** (see [Host source](#host-source)) —
  the model can never reach an arbitrary host.
- `description` (required) — "Clear, concise description of what this command does in 5-10
  words", exactly like the built-in bash tool.
- `workdir` (optional) — remote working directory to run in; defaults to the remote user's
  current directory. Use this instead of `cd` commands.
- `timeout` (optional, default `120000` ms) — a negative value is rejected
  (`Invalid timeout value: X. Timeout must be a positive number.`), matching the bash tool.
- `env` (optional) — extra environment variables to `export` on the remote host.
- Everything is sent as a single argv through `--`, and the command string is
  single-quote-escaped for the remote `bash -lc`, so no local option injection is possible.
- Like bash, stdout+stderr are combined into one output stream, the tail of which is
  returned with `...output truncated... Full output saved to: <path>` when it overruns
  (16 KiB), with `(no output)` when empty; timeouts end with a
  `<remote_bash_metadata>` note. Partial output streams into the tool preview during the
  run, and the command is killed if the user aborts the call.
- Returns `{ title: <description>, output, metadata: { hostalias, description, output, exit,
  truncated, outputPath?, stdout?, stderr?, ... } }`.

### `remote_known_hosts`

```
remote_known_hosts()
  -> aliases resolved from ~/.ssh/config (or the explicit allowlist)
     with resolved HostName / User / Port / IdentityFile / ProxyJump
```

Call this first so the model knows which `hostalias` values are valid and what they point at.

## Host source

Set `hosts` in the plugin's options in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-remote-bash",
      "options": { "hosts": "ssh-config" }
    }
  ]
}
```

- `"ssh-config"` (default) — allow any alias that appears in `~/.ssh/config`.
- `["web1", "db1", "bastion"]` — explicit allowlist.
- Env override: `REMOTE_BASH_HOSTS` accepts `"ssh-config"`, a JSON array, or a
  comma-separated list, and takes precedence over plugin options.
- The old `plugin/remote_bash.json` file is no longer read. Move its
  `remote_bash.hosts` value into the plugin's `options.hosts` before upgrading.

## SSH multiplexing

- Per alias, a master is started on first use:
  `ssh -fN -M -o ControlMaster=yes -o ControlPath=~/.ssh/cm_opencode/<slug> -o ControlPersist=600 -- <alias>`
- Each command rides the socket:
  `ssh -T -o ControlPath=<dir>/<slug> -- <alias> bash -lc '<command>'`
- The control dir is `~/.ssh/cm_opencode/` (`0700`); the per-alias slug is a short SHA-256
  hash so paths never contain `:` or spaces.
- Masters auto-close `ControlPersist` seconds after the last call (`600` by default) and are
  swept on process exit.
- The user's normal `~/.ssh/config` (identities, `ProxyJump`, ports) is honored for the
  master connection, so `remote_bash` automatically works through existing jump hosts.

## Install (source-build / local)

Requires OpenCode 2.0.32 or newer. Build the checkout:

```sh
npm ci
npm run build
```

Add the checkout directory to `plugins` in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-remote-bash"]
}
```

The package's default export is the OpenCode 2 plugin. V1 entrypoints and the
temporary `/v2` subpath are retired. Remove old discovery symlinks to avoid
loading the plugin twice. Run `opencode service restart` after rebuilding an
already loaded checkout, then check `opencode plugin list`.

The host's `~/.ssh/config` is read from `$HOME`, and the master socket directory
is created under `~/.ssh/`. No separate plugin configuration file is needed.

## Requirements

- `ssh` client on the box running opencode (the `openssh-client` `ssh` binary).
- Key-based auth (no password prompts — `BatchMode=yes` on the master).
- Host keys pre-seeded in `known_hosts` (plain host keys; no CA setup).

## Development

```sh
npm ci
npm run typecheck
npm run build
npm test
```

## Security notes

- Strict allowlist: any `hostalias` outside the resolved source is rejected.
- Remote command is built from single-quote-escaped parts (`cd`/`export`/command) — no
  shell re-tokenization of user input outside the intended `bash -lc '…'`.
- `env` keys are validated (`[A-Za-z_][A-Za-z0-9_]*`); `workdir` is NUL-checked.
- Output truncation + hard per-call timeout keep runaway output/commands contained.
- Masters require `BatchMode=yes` so a missing key fails fast instead of hanging on a prompt.

## License

MIT
