import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Minimal ~/.ssh/config parser.
 *
 * We only care about the parts needed to (a) enumerate reachable aliases and
 * (b) resolve HostName/User/Port for `remote_known_hosts`. SSH itself still
 * does the real config resolution when it actually connects, so this parser is
 * intentionally "good enough" for discovery/validation.
 */

export interface ResolvedHost {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  proxyJump?: string;
  proxyCommand?: string;
}

export interface ParsedConfig {
  /** Concrete (non-wildcard) Host aliases, in file order. */
  aliases: string[];
  /** Host patterns that contain glob chars (* / ?) — not directly addressable. */
  wildcardPatterns: string[];
  resolved: Map<string, ResolvedHost>;
  /** Files pulled in via Include. */
  includes: string[];
}

const MAX_INCLUDE_DEPTH = 8;

interface RawHost {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string[];
  proxyJump?: string;
  proxyCommand?: string;
}

const SCALAR_KEYS = new Set([
  "hostname",
  "user",
  "port",
  "identityfile",
  "proxyjump",
  "proxycommand",
]);

function stripComment(line: string): string {
  let inQuote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'") {
      inQuote = inQuote === c ? "" : inQuote === "" ? c : inQuote;
    } else if (c === "#" && inQuote === "") {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Expand a simple glob (single `*` or `?` patterns) in the style of ssh Include. */
function expandIncludePattern(pattern: string, baseDir: string): string[] {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    const p = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : path.resolve(baseDir, pattern);
    return [p];
  }
  const full = pattern.startsWith("~") ? path.join(os.homedir(), pattern.slice(1)) : path.resolve(baseDir, pattern);
  const dir = path.dirname(full);
  const base = path.basename(full);
  const re = new RegExp(
    "^" +
      base
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((e) => re.test(e)).map((e) => path.join(dir, e));
}

function applyToken(host: RawHost, key: string, value: string, lineNo: number) {
  switch (key) {
    case "hostname":
      if (host.hostname === undefined) host.hostname = unquote(value);
      break;
    case "user":
      if (host.user === undefined) host.user = unquote(value);
      break;
    case "port": {
      if (host.port === undefined) {
        const n = Number(value);
        if (Number.isInteger(n) && n > 0 && n <= 65535) host.port = n;
      }
      break;
    }
    case "identityfile":
      (host.identityFile ??= []).push(unquote(value));
      break;
    case "proxyjump":
      if (host.proxyJump === undefined) host.proxyJump = unquote(value);
      break;
    case "proxycommand":
      if (host.proxyCommand === undefined) host.proxyCommand = unquote(value);
      break;
  }
}

export function parseSshConfig(filePath: string): ParsedConfig {
  const raw = new Map<string, RawHost>();
  const aliases: string[] = [];
  const wildcardPatterns: string[] = [];
  const includes: string[] = [];
  const seenFiles = new Set<string>();

  function load(p: string, depth: number) {
    if (depth > MAX_INCLUDE_DEPTH) return;
    const abs = path.resolve(p);
    if (seenFiles.has(abs)) return;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      seenFiles.add(abs);
      return;
    }
    seenFiles.add(abs);

    const text = fs.readFileSync(abs, "utf8");
    let blockPatterns: string[] = [];
    let lineNo = 0;

    for (const rawLine of text.split(/\r?\n/)) {
      lineNo++;
      const line = stripComment(rawLine).trim();
      if (!line) continue;

      const eq = line.indexOf("=");
      const tokenSep = eq >= 0 ? eq : line.search(/\s/);
      const key = (tokenSep >= 0 ? line.slice(0, tokenSep) : line).trim().toLowerCase();
      const value = (tokenSep >= 0 ? line.slice(tokenSep + (eq >= 0 ? 1 : 0)) : "").trim();
      if (!key) continue;

      if (!SCALAR_KEYS.has(key)) {
        // Host / Match / Include start or end blocks.
        if (key === "host") {
          blockPatterns = value
            .split(/[\s,]+/)
            .filter(Boolean)
            .filter((p) => !p.startsWith("!"));
          for (const pat of blockPatterns) {
            if (/[*?]/.test(pat)) {
              if (!wildcardPatterns.includes(pat)) wildcardPatterns.push(pat);
            } else if (!raw.has(pat)) {
              raw.set(pat, {});
              aliases.push(pat);
            }
          }
        } else if (key === "match") {
          blockPatterns = [];
        } else if (key === "include") {
          includes.push(unquote(value));
          const baseDir = path.dirname(abs);
          for (const inc of expandIncludePattern(unquote(value), baseDir)) {
            load(inc, depth + 1);
          }
        }
        continue;
      }

      if (blockPatterns.length === 0) continue;
      for (const pat of blockPatterns) {
        if (/[*?]/.test(pat)) continue; // wildcard blocks don't enumerate
        applyToken(raw.get(pat) ?? raw.set(pat, {}).get(pat)!, key, value, lineNo);
      }
    }
  }

  load(filePath, 0);

  const defaults = {
    user: os.userInfo().username,
    port: 22,
  };

  const resolved = new Map<string, ResolvedHost>();
  for (const alias of aliases) {
    const r = raw.get(alias) ?? {};
    resolved.set(alias, {
      alias,
      hostname: r.hostname || alias,
      user: r.user || defaults.user,
      port: r.port || defaults.port,
      identityFile: r.identityFile?.[0] ?? undefined,
      proxyJump: r.proxyJump,
      proxyCommand: r.proxyCommand,
    });
  }

  return { aliases, wildcardPatterns, resolved, includes };
}
