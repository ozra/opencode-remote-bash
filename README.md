# opencode-remote-bash

An [OpenCode](https://opencode.ai) plugin that adds a `remote_bash` tool, letting a model
session run commands on remote machines over **SSH ControlMaster multiplexing** — one
long-lived master connection per host, so every call reuses the socket instead of doing a
full SSH handshake each time.

Designed to run an opencode session on one machine and drive commands on the other machines
in your fleet over plain SSH — no agents or daemons to install on the targets.

## Tools

### `remote_bash`

```
remote_bash(hostalias, command, { cwd?, env?, timeout? })
  -> { exitCode, stdout, stderr }
```

- `hostalias` is **validated against an allowlist** (see [Host source](#host-source)) —
  the model can never reach an arbitrary host.
- Everything is sent as a single argv through `--`, and the command string is
  single-quote-escaped for the remote `bash -lc`, so no local option injection is possible.
- Stdout/stderr are captured and truncated at 16 KiB each; per-call timeout (default 120 s,
  clamped to `[1000, 600000]` ms) so the model can't hang the session.

### `remote_known_hosts`

```
remote_known_hosts()
  -> aliases resolved from ~/.ssh/config (or the explicit allowlist)
     with resolved HostName / User / Port / IdentityFile / ProxyJump
```

Call this first so the model knows which `hostalias` values are valid and what they point at.

## Host source

File: `~/.config/opencode/plugin/remote_bash.json` (env override `REMOTE_BASH_HOSTS`):

```json
{
  "remote_bash": {
    "hosts": "ssh-config"
  }
}
```

- `"ssh-config"` (default) — allow any alias that appears in `~/.ssh/config`.
- `["web1", "db1", "bastion"]` — explicit allowlist.
- Env override: `REMOTE_BASH_HOSTS` accepts `"ssh-config"`, a JSON array, or a
  comma-separated list, and takes precedence over the file.

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

The plugin is loaded directly from source (no npm publish needed). Point opencode's global
plugin directory at this repo:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s <repo>/src/index.ts ~/.config/opencode/plugins/remote-bash.ts
```

Restart opencode; `remote_bash` and `remote_known_hosts` should appear. The host's
`~/.ssh/config` is read from `$HOME`, and the master socket directory is created under
`~/.ssh/`.

As a regular npm-style plugin (for opencode config `"plugin": [...]`), the package can also
be built to `dist/` with `bun run build`.

## Requirements

- `ssh` client on the box running opencode (the `openssh-client` `ssh` binary).
- Key-based auth (no password prompts — `BatchMode=yes` on the master).
- Host keys pre-seeded in `known_hosts` (plain host keys; no CA setup).

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun run build       # bundle dist/ (single file, @opencode-ai/plugin external)
```

## Security notes

- Strict allowlist: any `hostalias` outside the resolved source is rejected.
- Remote command is built from single-quote-escaped parts (`cd`/`export`/command) — no
  shell re-tokenization of user input outside the intended `bash -lc '…'`.
- `env` keys are validated (`[A-Za-z_][A-Za-z0-9_]*`); `cwd` is NUL-checked.
- Output truncation + hard per-call timeout keep runaway output/commands contained.
- Masters require `BatchMode=yes` so a missing key fails fast instead of hanging on a prompt.

## License

MIT
