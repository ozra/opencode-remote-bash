import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "../dist/index.js";
import localPlugin from "../server.js";

test("the default V2 entrypoint registers both tools with plugin options", async () => {
  const tools = [];
  await plugin.setup({
    options: { hosts: ["example-target"] },
    tool: { transform: async (register) => register({ add: (tool) => tools.push(tool) }) },
  });
  assert.equal(plugin.id, "remote-bash");
  assert.equal(localPlugin, plugin);
  assert.deepEqual(tools.map((tool) => tool.name), ["remote_bash", "remote_known_hosts"]);
  const inventory = await tools[1].execute();
  assert.match(inventory.content, /explicit allowlist: example-target/);
  await assert.rejects(
    tools[0].execute({ hostalias: "other-target", command: "true", description: "Blocked alias" }, {}),
    /not in the allowlist/,
  );
});
