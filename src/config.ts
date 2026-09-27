import * as fs from "node:fs";
import { configFile, sshConfigFile } from "./util.js";
import { parseSshConfig, type ParsedConfig } from "./sshconfig.js";

export type HostSource = { mode: "ssh-config" } | { mode: "list"; aliases: string[] };

export interface Allowlist {
  source: HostSource;
  allowed: Set<string>;
  parsed: ParsedConfig | null;
  error?: string;
}

function readHostSourceValue(): unknown {
  const env = process.env.REMOTE_BASH_HOSTS;
  if (env && env.trim()) {
    try {
      return JSON.parse(env);
    } catch {
      return env;
    }
  }

  const p = configFile();
  if (!fs.existsSync(p)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
    if (parsed && typeof parsed === "object") {
      const hosts = (parsed as { remote_bash?: { hosts?: unknown } }).remote_bash?.hosts;
      if (hosts !== undefined) return hosts;
    }
  } catch (e) {
    console.error(`remote_bash: failed to parse ${p}: ${(e as Error).message}`);
  }
  return undefined;
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

export function resolveHostSource(): HostSource | { error: string } {
  const value = readHostSourceValue();
  if (value === undefined) return { mode: "ssh-config" };
  const src = coerceHostSource(value);
  if (!src) {
    return {
      error: `invalid host source (expected "ssh-config" or a string array): ${JSON.stringify(value)}`,
    };
  }
  return src;
}

export function computeAllowlist(): Allowlist {
  const source = resolveHostSource();
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
      error: `SSH config not found at ${p} — add host aliases to ~/.ssh/config or set hosts via the plugin config file (${configFile()}) / REMOTE_BASH_HOSTS`,
    };
  }
  const parsed = parseSshConfig(p);
  return { source, allowed: new Set(parsed.aliases), parsed };
}
