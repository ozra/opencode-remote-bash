/** SSH tool execution, independent of the OpenCode registration API. */
import { computeAllowlist } from "./config.js";
import { execRemote, sweepMasters } from "./mux.js";
import { spoolOutput, truncate } from "./util.js";

try {
  process.once("exit", () => {
    try {
      sweepMasters();
    } catch {
      /* best effort */
    }
  });
} catch {
  /* not in a process we should touch */
}

export interface RemoteBashArgs {
  hostalias: string;
  command: string;
  timeout?: number;
  workdir?: string;
  description: string;
  env?: Record<string, string>;
}

export interface RemoteToolContext {
  /** Aborted when the tool call is cancelled. */
  signal?: AbortSignal;
  /** Reports streaming metadata to the host; unknown keys are ignored. */
  progress?: (update: { metadata: Record<string, unknown> }) => void;
}

export interface RemoteToolResult {
  content: string;
  metadata: Record<string, unknown>;
}

export function allowlistError(hostalias: unknown, hosts?: unknown): string {
  const allow = computeAllowlist(hosts);
  const known = allow.parsed ? [...allow.allowed].join(", ") || "(none)" : "(none)";
  return (
    `remote_bash: hostalias ${JSON.stringify(hostalias)} is not in the allowlist. ` +
    `Available: ${known}. Call remote_known_hosts to see reachable hosts.` +
    (allow.error ? ` (${allow.error})` : "")
  );
}

export function isAllowed(hostalias: unknown, hosts?: unknown): hostalias is string {
  return typeof hostalias === "string" && hostalias.length > 0 && computeAllowlist(hosts).allowed.has(hostalias);
}

/** Run one remote command; throws allowlist/argument errors, returns the truncated tool result. */
export async function runRemoteBash(args: RemoteBashArgs, ctx: RemoteToolContext = {}, hosts?: unknown): Promise<RemoteToolResult> {
  if (!isAllowed(args.hostalias, hosts)) throw new Error(allowlistError(args.hostalias, hosts));

  const command = (args.command ?? "").trim();
  if (!command) throw new Error("remote_bash: command must be a non-empty string.");

  if (args.timeout !== undefined && args.timeout < 0) {
    throw new Error(`Invalid timeout value: ${args.timeout}. Timeout must be a positive number.`);
  }
  const timeout = args.timeout ?? 120000;

  const description = args.description ?? "";
  const MAX_METADATA_LENGTH = 30000;
  let preview = "";
  let lastEmit = 0;

  const emit = (force: boolean) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return;
    lastEmit = now;
    const pv = preview.length > MAX_METADATA_LENGTH ? "..." + preview.slice(-MAX_METADATA_LENGTH) : preview;
    try {
      ctx.progress?.({ metadata: { output: pv, description } });
    } catch {
      /* best effort */
    }
  };

  const res = await execRemote(args.hostalias, command, {
    workdir: args.workdir,
    env: args.env,
    timeoutMs: timeout,
    signal: ctx.signal,
    onOutput: (chunk) => {
      preview = (preview + chunk).slice(-MAX_METADATA_LENGTH);
      emit(false);
    },
  });
  emit(true);

  const raw = res.stdout + (!res.stderr ? "" : "\n" + res.stderr);
  const tail = truncate(raw);
  let output = tail.text;
  if (!output.trim()) output = "(no output)";

  let spoolPath: string | undefined;
  if (tail.truncated) {
    spoolPath = spoolOutput(raw);
    output = `...output truncated...\n\nFull output saved to: ${spoolPath}\n\n` + output;
  }

  const meta: string[] = [];
  if (res.timedOut) {
    meta.push(
      `remote_bash tool terminated command after exceeding timeout ${timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
    );
  }
  if (res.aborted) meta.push("User aborted the command");
  if (meta.length > 0) output += "\n\n<remote_bash_metadata>\n" + meta.join("\n") + "\n</remote_bash_metadata>";

  const so = truncate(res.stdout);
  const se = truncate(res.stderr);

  return {
    content: output,
    metadata: {
      title: description,
      hostalias: args.hostalias,
      description,
      output: preview || output,
      exit: res.timedOut || res.aborted ? null : res.exitCode,
      truncated: tail.truncated,
      ...(spoolPath ? { outputPath: spoolPath } : {}),
      stdout: so.text,
      stderr: se.text,
      stdoutTruncated: so.truncated,
      stderrTruncated: se.truncated,
    },
  };
}

/** Inventory text used by the remote_known_hosts tool. */
export function knownHostsText(hosts?: unknown): string {
  const allow = computeAllowlist(hosts);
  const src = allow.source;

  if (allow.error) {
    return `remote_bash host source ERROR: ${allow.error}`;
  }

  const modeDesc =
    src.mode === "ssh-config"
      ? "any alias from ~/.ssh/config"
      : `explicit allowlist: ${src.aliases.join(", ")}`;

  if (!allow.parsed) {
    return `remote_bash host source: ${modeDesc}\nNo aliases to enumerate (nothing in ~/.ssh/config).`;
  }

  const rows = allow.parsed.aliases.map((a) => {
    const h = allow.parsed!.resolved.get(a)!;
    const extra: string[] = [];
    if (h.identityFile) extra.push(`identity:${h.identityFile}`);
    if (h.proxyJump) extra.push(`proxy:${h.proxyJump}`);
    if (h.proxyCommand) extra.push(`proxycmd:on`);
    const suffix = extra.length ? `  (${extra.join(", ")})` : "";
    return `${h.alias}\t${h.user}@${h.hostname}:${h.port}${suffix}`;
  });

  const wildcard = allow.parsed.wildcardPatterns.length
    ? `\n(ignored wildcard Host patterns: ${allow.parsed.wildcardPatterns.join(", ")})`
    : "";

  return [
    `remote_bash hosts (${modeDesc}):`,
    ...(rows.length ? rows : ["(none)"]),
    wildcard.trim() || null,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** JSON Schema for the v2 tool domain (which also accepts Effect/StandardSchema inputs). */
export const remoteBashSchema = {
  type: "object",
  properties: {
    hostalias: {
      type: "string",
      description: "SSH config alias of the target host (e.g. web1, db1, bastion)",
    },
    command: { type: "string", description: "The command to execute" },
    timeout: { type: "number", description: "Optional timeout in milliseconds" },
    workdir: {
      type: "string",
      description:
        "The working directory to run the command in on the remote host. Defaults to the remote user's current directory. Use this instead of 'cd' commands.",
    },
    description: {
      type: "string",
      description:
        "Clear, concise description of what this command does in 5-10 words. Examples:\n" +
        "Input: ls\nOutput: Lists files in current directory\n\n" +
        "Input: git status\nOutput: Shows working tree status\n\n" +
        "Input: npm install\nOutput: Installs package dependencies\n\n" +
        "Input: mkdir foo\nOutput: Creates directory 'foo'",
    },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Extra environment variables to `export` on the remote host before running",
    },
  },
  required: ["hostalias", "command", "description"],
  additionalProperties: false,
} as const;

export const remoteKnownHostsSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const remoteBash = {
  description:
    "Run a command on a remote host over an SSH ControlMaster-multiplexed connection. " +
    "`hostalias` must be one of the aliases returned by `remote_known_hosts` (resolved from ~/.ssh/config or an explicit allowlist). " +
    "The command runs through `bash -lc` on the remote host; the remote host's regular ~/.ssh/config (identities, ProxyJump, ports) is honored. " +
    "stdout and stderr are combined into one output stream, like the built-in `bash` tool. " +
    "Call `remote_known_hosts` first to discover valid aliases.",
  execute: runRemoteBash,
};

export const remoteKnownHosts = {
  description:
    "List the hosts `remote_bash` can connect to. Resolves aliases from ~/.ssh/config " +
    "(or an explicit allowlist) with each alias's HostName/User/Port/IdentityFile/ProxyJump so the model " +
    "knows the exact `hostalias` values it may pass to `remote_bash`.",
  execute: knownHostsText,
};
