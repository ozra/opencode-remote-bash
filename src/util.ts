import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

/** Single-quote a string for POSIX shell (safe for building remote commands). */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

/** Sane per-stream output cap (bytes), like the built-in bash tool's truncated tail. */
export const STREAM_BYTE_LIMIT = 16 * 1024;

export interface Truncated {
  text: string;
  truncated: boolean;
  bytes: number;
}

/** Keep the last `limit` bytes (UTF-8 safe, tail-sliced like the bash tool) if the text is longer. */
export function truncate(text: string, limit = STREAM_BYTE_LIMIT): Truncated {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) return { text, truncated: false, bytes };
  const buf = Buffer.from(text, "utf8");
  let start = buf.length - limit;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf8"), truncated: true, bytes };
}

/** Write full (untruncated) output to a spool file so the tail view can reference it, like the bash tool. */
export function spoolOutput(text: string): string {
  const dir = path.join(os.tmpdir(), "opencode-remote-bash");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `spool-${process.pid}-${crypto.randomBytes(4).toString("hex")}.log`);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

export function homeDir(): string {
  return os.homedir();
}

export function controlDir(): string {
  return path.join(homeDir(), ".ssh", "cm_opencode");
}

export function configFile(): string {
  return path.join(homeDir(), ".config", "opencode", "plugin", "remote_bash.json");
}

export function sshConfigFile(): string {
  return path.join(homeDir(), ".ssh", "config");
}

export function ensurePrivateDir(p: string): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    /* best effort */
  }
  return p;
}
