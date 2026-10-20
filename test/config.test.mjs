import assert from "node:assert/strict";
import { test } from "node:test";
import { computeAllowlist, resolveHostSource } from "../dist/config.js";
import { isAllowed, knownHostsText, runRemoteBash } from "../dist/core.js";

test("plugin options select an explicit allowlist and block other aliases", async () => {
  assert.equal(process.env.REMOTE_BASH_HOSTS, undefined);
  assert.deepEqual(resolveHostSource(["example-target"]), {
    mode: "list",
    aliases: ["example-target"],
  });
  assert.equal(isAllowed("example-target", ["example-target"]), true);
  assert.equal(isAllowed("other-target", ["example-target"]), false);
  await assert.rejects(
    runRemoteBash({ hostalias: "other-target", command: "true", description: "Must not connect" }, {}, ["example-target"]),
    /not in the allowlist/,
  );
  assert.match(knownHostsText(["example-target"]), /explicit allowlist: example-target/);
});

test("missing options use SSH config and invalid options fail closed", () => {
  assert.deepEqual(resolveHostSource(), { mode: "ssh-config" });
  assert.equal(computeAllowlist({ hosts: "invalid" }).allowed.size, 0);
  assert.match(knownHostsText({ hosts: "invalid" }), /host source ERROR/);
  assert.equal(computeAllowlist([]).allowed.size, 0);
});

test("environment host source overrides plugin options", () => {
  process.env.REMOTE_BASH_HOSTS = '["environment-target"]';
  try {
    assert.deepEqual(resolveHostSource(["option-target"]), {
      mode: "list",
      aliases: ["environment-target"],
    });
    assert.equal(isAllowed("option-target", ["option-target"]), false);
  } finally {
    delete process.env.REMOTE_BASH_HOSTS;
  }
});
