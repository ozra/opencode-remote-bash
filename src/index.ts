import { type Plugin, tool } from "@opencode-ai/plugin";
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

export const RemoteBash: Plugin = async () => {
  return {
    tool: {
      remote_bash: tool({
        description:
          "Run a command on a remote host over an SSH ControlMaster-multiplexed connection. " +
          "`hostalias` must be one of the aliases returned by `remote_known_hosts` (resolved from ~/.ssh/config or an explicit allowlist). " +
          "The command runs through `bash -lc` on the remote host; the remote host's regular ~/.ssh/config (identities, ProxyJump, ports) is honored. " +
          "stdout and stderr are combined into one output stream, like the built-in `bash` tool. " +
          "Call `remote_known_hosts` first to discover valid aliases.",
        args: {
          hostalias: tool.schema
            .string()
            .describe("SSH config alias of the target host (e.g. web1, db1, bastion)"),
          command: tool.schema.string().describe("The command to execute"),
          timeout: tool.schema.number().optional().describe("Optional timeout in milliseconds"),
          workdir: tool.schema
            .string()
            .optional()
            .describe(
              "The working directory to run the command in on the remote host. Defaults to the remote user's current directory. Use this instead of 'cd' commands.",
            ),
          description: tool.schema.string().describe(
            "Clear, concise description of what this command does in 5-10 words. Examples:\n" +
              "Input: ls\nOutput: Lists files in current directory\n\n" +
              "Input: git status\nOutput: Shows working tree status\n\n" +
              "Input: npm install\nOutput: Installs package dependencies\n\n" +
              "Input: mkdir foo\nOutput: Creates directory 'foo'",
          ),
          env: tool.schema
            .record(tool.schema.string(), tool.schema.string())
            .optional()
            .describe("Extra environment variables to `export` on the remote host before running"),
        },
        async execute(args, ctx) {
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
              ctx.metadata({ metadata: { output: pv, description } });
            } catch {
              /* best effort */
            }
          };

          const res = await execRemote(args.hostalias, command, {
            workdir: args.workdir,
            env: args.env,
            timeoutMs: timeout,
            signal: ctx.abort,
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
            title: description,
            output,
            metadata: {
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
