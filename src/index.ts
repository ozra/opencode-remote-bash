import { type Plugin, tool } from "@opencode-ai/plugin";
import { computeAllowlist } from "./config.js";
import { execRemote, sweepMasters } from "./mux.js";
import { truncate } from "./util.js";

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

export const RemoteBash: Plugin = async () => {
  return {
    tool: {
      remote_bash: tool({
        description:
          "Run a command on a remote host over an SSH ControlMaster-multiplexed connection. " +
          "`hostalias` must be one of the aliases returned by `remote_known_hosts` (resolved from ~/.ssh/config or an explicit allowlist). " +
          "The command runs through `bash -lc` on the remote host; the remote host's regular ~/.ssh/config (identities, ProxyJump, ports) is honored. " +
          "Returns the remote command's exit code, stdout and stderr (each truncated at 16 KiB). " +
          "Call `remote_known_hosts` first to discover valid aliases.",
        args: {
          hostalias: tool.schema
            .string()
            .describe("SSH config alias of the target host (e.g. web1, db1, bastion)"),
          command: tool
            .schema.string()
            .describe("Shell command to run remotely (executed via `bash -lc '...'`)"),
          cwd: tool.schema.string().optional().describe("Remote working directory to `cd` into before running"),
          env: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe("Extra environment variables to `export` on the remote host before running"),
          timeout: tool.schema
            .number()
            .optional()
            .describe("Per-call timeout in milliseconds (default 120000, clamped to [1000, 600000])"),
        },
        async execute(args) {
          const allow = computeAllowlist();
          const allowed = allow.allowed;

          if (!args.hostalias || !allowed.has(args.hostalias)) {
            const known = allow.parsed ? [...allowed].join(", ") || "(none)" : "(none)";
            throw new Error(
              `remote_bash: hostalias ${JSON.stringify(args.hostalias)} is not in the allowlist. ` +
                `Available: ${known}. Call remote_known_hosts to see reachable hosts.` +
                (allow.error ? ` (${allow.error})` : ""),
            );
          }

          const command = (args.command ?? "").trim();
          if (!command) throw new Error("remote_bash: command must be a non-empty string.");

          const timeout = Math.min(Math.max(args.timeout ?? 120000, 1000), 600000);

          const res = await execRemote(args.hostalias, command, {
            cwd: args.cwd,
            env: args.env,
            timeoutMs: timeout,
          });

          const so = truncate(res.stdout);
          const se = truncate(res.stderr);
          const statusLine = res.timedOut
            ? `[timed out after ${timeout}ms]`
            : `exit code: ${res.exitCode}`;
          const body = ["stdout:", so.text, ...(se.text ? ["stderr:", se.text] : [])].join("\n");

          return {
            output: `${statusLine}\n${body}`,
            metadata: {
              hostalias: args.hostalias,
              exitCode: res.exitCode,
              timedOut: res.timedOut,
              stdout: so.text,
              stderr: se.text,
              stdoutTruncated: so.truncated,
              stderrTruncated: se.truncated,
            },
          };
        },
      }),

      remote_known_hosts: tool({
        description:
          "List the hosts `remote_bash` can connect to. Resolves aliases from ~/.ssh/config " +
          "(or an explicit allowlist) with each alias's HostName/User/Port/IdentityFile/ProxyJump so the model " +
          "knows the exact `hostalias` values it may pass to `remote_bash`.",
        args: {},
        async execute() {
          const allow = computeAllowlist();
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
        },
      }),
    },
  };
};

export default RemoteBash;
