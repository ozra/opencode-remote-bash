/** OpenCode 2 plugin with an allowlisted SSH command tool and host inventory. */
import { Plugin } from "@opencode/plugin";
import {
  knownHostsText,
  remoteBash,
  remoteBashSchema,
  remoteKnownHosts,
  remoteKnownHostsSchema,
  type RemoteBashArgs,
} from "./core.js";

export default Plugin.define({
  id: "remote-bash",
  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "remote_bash",
        description: remoteBash.description,
        input: remoteBashSchema,
        options: { codemode: false },
        // A JSON Schema input decodes to unknown; core validates the fields it relies on.
        execute: async (input, toolCtx) =>
          remoteBash.execute(input as RemoteBashArgs, {
            signal: toolCtx.signal,
            progress: ({ metadata }) => toolCtx.progress(metadata),
          }, ctx.options.hosts),
      });

      tools.add({
        name: "remote_known_hosts",
        description: remoteKnownHosts.description,
        input: remoteKnownHostsSchema,
        options: { codemode: false },
        execute: async () => ({ content: knownHostsText(ctx.options.hosts), metadata: {} }),
      });
    });
  },
});
