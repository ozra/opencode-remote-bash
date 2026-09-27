import * as child from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { controlDir, ensurePrivateDir, shq } from "./util.js";

/**
 * SSH ControlMaster multiplexing core.
 *
 * One master per alias is started on first use and reused by every call:
 *   master:  ssh -fN -M -o ControlMaster=yes -o ControlPath=<dir>/<slug> \
 *            -o ControlPersist=600 -o BatchMode=yes -- <alias>
 *   exec:    ssh -T -o ControlPath=<dir>/<slug> -- <alias> bash -lc '<quoted script>'
 */

const CONTROL_PERSIST = 600; // seconds a master stays alive after the last client detaches
const CONNECT_TIMEOUT = 12; // seconds, for establishing the connection
const MASTER_WAIT_MS = 15000; // how long to wait for the master socket to appear
const DEFAULT_TIMEOUT_MS = 120000; // mirrors the built-in bash tool default (2 minutes)

const inFlight = new Map<string, Promise<void>>();
const started = new Set<string>();

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExecOptions {
  /** Remote working directory to `cd` into first. Mirrors the bash tool's `workdir`. */
  workdir?: string;
  /** Extra environment variables to `export` on the remote host before running. */
  env?: Record<string, string>;
  /** Per-call timeout in milliseconds (default 120000). Mirrors the bash tool. */
  timeoutMs?: number;
  /** Abort the running command (kills the ssh process) when this signal fires. */
  signal?: AbortSignal;
  /** Live output callback (stdout+stderr chunks as they arrive), used to stream a preview like the bash tool does. */
  onOutput?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export function ctrlPathFor(alias: string): string {
  ensurePrivateDir(controlDir());
  const slug = crypto.createHash("sha256").update(String(alias)).digest("hex").slice(0, 10);
  return path.join(controlDir(), slug);
}

function ctlOpt(p: string): string {
  return `ControlPath=${p}`;
}

export function masterAlive(alias: string): boolean {
  const cp = ctrlPathFor(alias);
  if (!fs.existsSync(cp)) return false;
  const r = child.spawnSync("ssh", ["-o", ctlOpt(cp), "-o", "ConnectTimeout=4", "-O", "check", alias], {
    stdio: "ignore",
    timeout: 8000,
  });
  return r.status === 0;
}

function cleanSshError(stderr: string, alias: string): string {
  const s = stderr.trim();
  const probe = (re: RegExp, msg: string) => (re.test(s) ? msg : null);
  const kind =
    probe(/Could not resolve hostname/i, `cannot resolve host for alias "${alias}" (check ~/.ssh/config HostName)`) ??
    probe(/Permission denied/i, `authentication to "${alias}" failed (no usable key / not authorized)`) ??
    probe(/Connection refused/i, `connection to "${alias}" refused (host up, service down?)`) ??
    probe(/Connection timed out|Network is unreachable|No route to host/i, `no route to "${alias}" (host down or unreachable)`) ??
    probe(/Host key verification failed/i, `host key verification failed for "${alias}" (stale known_hosts?)`) ??
    probe(/Couldn't read packet|Connection reset/i, `connection to "${alias}" was reset`) ??
    null;
  const detail = s.replace(/\s+/g, " ").slice(0, 300);
  return `remote_bash: ${kind ?? `failed to reach "${alias}"`}: ${detail || "(no error output)"}`;
}

function startMaster(alias: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (masterAlive(alias)) return resolve();

    const cp = ctrlPathFor(alias);
    const args = [
      "-fN",
      "-M",
      "-o",
      "ControlMaster=yes",
      "-o",
      ctlOpt(cp),
      "-o",
      `ControlPersist=${CONTROL_PERSIST}`,
      "-o",
      `ConnectTimeout=${CONNECT_TIMEOUT}`,
      "-o",
      "BatchMode=yes",
      "--",
      alias,
    ];

    const proc = child.spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(new Error(`remote_bash: failed to spawn ssh for "${alias}": ${e.message}`));
      }
    });

    const timer = setInterval(() => {
      if (masterAlive(alias)) {
        started.add(alias);
        settled = true;
        clearInterval(timer);
        resolve();
      } else if (proc.exitCode !== null && proc.exitCode !== 0) {
        settled = true;
        clearInterval(timer);
        reject(new Error(cleanSshError(stderr, alias)));
      }
    }, 120);
    timer.unref();

    setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        reject(new Error(`remote_bash: timed out establishing master connection to "${alias}" (${MASTER_WAIT_MS}ms)`));
      }
    }, MASTER_WAIT_MS).unref();
  });
}

export function ensureMaster(alias: string): Promise<void> {
  const existing = inFlight.get(alias);
  if (existing) return existing;
  const p = startMaster(alias).finally(() => inFlight.delete(alias));
  inFlight.set(alias, p);
  return p;
}

function runSsh(
  args: string[],
  timeoutMs: number,
  opts: Pick<ExecOptions, "signal" | "onOutput"> = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = child.spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const t = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => {
      if (proc.exitCode === null) {
        aborted = true;
        proc.kill("SIGKILL");
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout?.on("data", (d) => {
      const text = String(d);
      stdout += text;
      opts.onOutput?.(text);
    });
    proc.stderr?.on("data", (d) => {
      const text = String(d);
      stderr += text;
      opts.onOutput?.(text);
    });
    proc.on("error", (e) => {
      clearTimeout(t);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr || `remote_bash: failed to spawn ssh: ${e.message}`,
        timedOut: false,
        aborted: false,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(t);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut, aborted });
    });
  });
}

export async function execRemote(alias: string, command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  await ensureMaster(alias);
  const cp = ctrlPathFor(alias);

  const prefix: string[] = [];
  if (opts.workdir) {
    if (opts.workdir.includes("\0")) throw new Error("remote_bash: workdir contains a NUL byte");
    prefix.push(`cd ${shq(opts.workdir)}`);
  }
  if (opts.env && Object.keys(opts.env).length > 0) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new Error(`remote_bash: invalid environment variable name ${JSON.stringify(k)}`);
      }
      prefix.push(`export ${k}=${shq(v)}`);
    }
  }
  const script = prefix.length > 0 ? [...prefix, command].join("; ") : command;

  const args = [
    "-T",
    "-o",
    ctlOpt(cp),
    "-o",
    `ConnectTimeout=${CONNECT_TIMEOUT}`,
    "--",
    alias,
    "bash",
    "-lc",
    shq(script),
  ];

  const res = await runSsh(args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts);
  return res;
}

/** Best-effort shutdown of tracked masters (used on process exit; ControlPersist also self-cleans). */
export function sweepMasters(): void {
  for (const alias of [...started]) {
    const cp = ctrlPathFor(alias);
    if (!fs.existsSync(cp)) continue;
    try {
      child.spawnSync("ssh", ["-o", ctlOpt(cp), "-o", "ConnectTimeout=2", "-O", "exit", alias], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      /* best effort */
    }
  }
  started.clear();
}
