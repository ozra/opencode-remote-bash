import * as fs from "node:fs";
import { sshConfigFile } from "./util.js";
import { parseSshConfig, type ParsedConfig } from "./sshconfig.js";

export type HostSource = { mode: "ssh-config" } | { mode: "list"; aliases: string[] };

export interface Allowlist {
  source: HostSource;
  allowed: Set<string>;
  parsed: ParsedConfig | null;
  error?: string;
}

function readHostSourceValue(hosts?: unknown): unknown {
  const env = process.env.REMOTE_BASH_HOSTS;
  if (env && env.trim()) {
    try {
      return JSON.parse(env);
    } catch {
      return env;
    }
  }

  return hosts;
}

function coerceHostSource(value: unknown): HostSource | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    if (t === "ssh-config") return { mode: "ssh-config" };
    let arr: unknown = null;
    if (t.startsWith("[")) {
      try {
        arr = JSON.parse(t);
      } catch {
        arr = null;
      }
    } else if (t.includes(",")) {
      arr = t.split(",").map((x) => x.trim());
    }
    if (Array.isArray(arr)) {
      const aliases = arr.filter((x): x is string => typeof x === "string" && x.length > 0);
      return aliases.length ? { mode: "list", aliases } : { mode: "list", aliases: [] };
    }
    if (t.length > 0) return { mode: "list", aliases: [t] };
    return { mode: "list", aliases: [] };
  }
  if (Array.isArray(value)) {
    const aliases = value.filter((x): x is string => typeof x === "string" && x.length > 0);
    return { mode: "list", aliases };
  }
  return undefined;
}

export function resolveHostSource(hosts?: unknown): HostSource | { error: string } {
  const value = readHostSourceValue(hosts);
  if (value === undefined) return { mode: "ssh-config" };
  const src = coerceHostSource(value);
  if (!src) {
    return {
      error: `invalid host source (expected "ssh-config" or a string array): ${JSON.stringify(value)}`,
    };
  }
  return src;
}

export function computeAllowlist(hosts?: unknown): Allowlist {
  const source = resolveHostSource(hosts);
  if ("error" in source) {
    return { source: { mode: "list", aliases: [] }, allowed: new Set(), parsed: null, error: source.error };
  }
  if (source.mode === "list") {
    return { source, allowed: new Set(source.aliases), parsed: null };
  }
  const p = sshConfigFile();
  if (!fs.existsSync(p)) {
    return {
      source,
      allowed: new Set(),
      parsed: null,
      error: `SSH config not found at ${p}. Add aliases to ~/.ssh/config or set the plugin's hosts option / REMOTE_BASH_HOSTS.`,
    };
  }
  const parsed = parseSshConfig(p);
  return { source, allowed: new Set(parsed.aliases), parsed };
}
