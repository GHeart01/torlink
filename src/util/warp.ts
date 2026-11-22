// Cloudflare WARP, driven through the warp-cli tool its installer ships.
//
// WARP is a system service with its own installer and permissions, so torlink
// cannot carry it; what it can do is ask the one already on the machine to be
// on, bind to the tunnel it brings up, and stop moving data whenever that
// tunnel is not the thing carrying traffic. The binding itself is the existing
// interface bind (util/bind.ts, download/network.ts): this file only decides
// which address that bind points at, and when it points at nothing.

import { execFile } from "node:child_process";
import dgram from "node:dgram";
import os from "node:os";
import type { InterfaceTable } from "./bind";

/** Tunnel all traffic and send DNS over HTTPS: the mode torlink asks for. */
export const WARP_MODE = "warp+doh";

/**
 * What the engine is bound to while WARP is expected but not carrying traffic.
 * No interface has this name, so the bind resolves to nothing and every socket
 * fails closed instead of leaving through the normal connection.
 */
export const WARP_WAITING = "warp:waiting";

export interface RunResult {
  /** Exit code; null when the process never ran or was cut off by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** No warp-cli on this machine. */
  missing: boolean;
}

export type Runner = (args: string[], timeoutMs?: number) => Promise<RunResult>;

// Where the installer puts warp-cli when it is not on PATH (a GUI-launched
// terminal on macOS, a service account on Linux).
const KNOWN_PATHS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/usr/local/bin/warp-cli", "/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli"],
  linux: ["/usr/bin/warp-cli", "/bin/warp-cli"],
  win32: ["C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe"],
};

const RUN_TIMEOUT_MS = 4000;

function execOnce(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr, missing: false });
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      resolve({
        code: typeof code === "number" ? code : null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        missing: code === "ENOENT",
      });
    });
  });
}

/** TORLINK_WARP_CLI names the binary outright; otherwise PATH, then the installer's own locations. */
export function createRunner(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Runner {
  const named = env.TORLINK_WARP_CLI?.trim();
  const candidates = named ? [named] : ["warp-cli", ...(KNOWN_PATHS[platform] ?? [])];
  let found: string | null = null;
  return async (args, timeoutMs = RUN_TIMEOUT_MS) => {
    for (const bin of found ? [found] : candidates) {
      const result = await execOnce(bin, args, timeoutMs);
      if (!result.missing) {
        found = bin;
        return result;
      }
    }
    return { code: null, stdout: "", stderr: "", missing: true };
  };
}

/**
 * The local address the OS would send internet traffic from right now. A UDP
 * socket is pointed at a public address and asked where it is bound; nothing
 * is sent. The explicit wildcard bind keeps the interface bind (util/bind.ts)
 * from answering the question for us.
 */
export function routeAddress(target = "1.1.1.1", timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = dgram.createSocket("udp4");
    const finish = (address: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(address);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    try {
      socket.bind(0, "0.0.0.0", () => {
        try {
          socket.connect(53, target, () => {
            try {
              finish(socket.address().address);
            } catch {
              finish(null);
            }
          });
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

// WARP's tunnel device: utunN on macOS, CloudflareWARP on Linux and Windows.
const TUNNEL_NAME = /^(utun\d+|cloudflarewarp)$/i;

/** The tunnel interface holding `address`, or null when it sits on a normal one (Wi-Fi, ethernet). */
export function tunnelHolding(address: string, table: InterfaceTable): string | null {
  for (const [name, entries] of Object.entries(table)) {
    if (!entries?.some((e) => e.address === address)) continue;
    return TUNNEL_NAME.test(name) ? name : null;
  }
  return null;
}

export type WarpState =
  /** No warp-cli here: torlink runs as it always has, and says so. */
  | { kind: "missing" }
  /** Installed but not carrying traffic. `detail` is short and lower-case: "off", "connecting". */
  | { kind: "off"; detail: string }
  /** Connected, and internet traffic leaves through its tunnel at `address`. */
  | { kind: "on"; address: string; iface: string };

export interface WarpDeps {
  run: Runner;
  route: () => Promise<string | null>;
  table: () => InterfaceTable;
}

export function defaultWarpDeps(env: NodeJS.ProcessEnv = process.env): WarpDeps {
  return { run: createRunner(env), route: () => routeAddress(), table: () => os.networkInterfaces() };
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** warp-cli's connection status word ("Connected", "Disconnected", "Connecting"), or null when it gave none. */
async function readStatus(run: Runner): Promise<{ missing: boolean; status: string | null }> {
  const r = await run(["-j", "status"]);
  if (r.missing) return { missing: true, status: null };
  const status = parseJson(r.stdout)?.status;
  if (typeof status === "string" && status) return { missing: false, status };
  // Older clients have no --json; they print "Status update: Connected".
  const plain = /Status update:\s*(\w+)/i.exec(r.stdout)?.[1];
  return { missing: false, status: plain ?? null };
}

async function readMode(run: Runner): Promise<string | null> {
  const r = await run(["-j", "settings"]);
  const settings = parseJson(r.stdout)?.settings;
  const mode = typeof settings === "object" && settings !== null
    ? (settings as Record<string, unknown>).operation_mode
    : undefined;
  return typeof mode === "string" && mode ? mode : null;
}

/**
 * Whether WARP is carrying this machine's traffic. "Connected" alone is not
 * enough: a DNS-only mode or a split tunnel leaves traffic on the normal
 * connection, so the route is checked too and has to land on the tunnel.
 */
export async function readWarp(deps: WarpDeps): Promise<WarpState> {
  const { missing, status } = await readStatus(deps.run);
  if (missing) return { kind: "missing" };
  if (status === null) return { kind: "off", detail: "not running" };
  if (status !== "Connected") {
    return { kind: "off", detail: status === "Connecting" ? "connecting" : "off" };
  }
  const address = await deps.route();
  const iface = address ? tunnelHolding(address, deps.table()) : null;
  if (!address || !iface) return { kind: "off", detail: "not carrying traffic" };
  return { kind: "on", address, iface };
}

export interface EnsureResult {
  /** The mode was something else and is now WARP_MODE. */
  modeSet: boolean;
  /** WARP was off and has been told to connect. */
  connectSent: boolean;
  /** warp-cli's own words when it refused either step. */
  error: string | null;
}

/**
 * Bring WARP to "connected, traffic + DNS over HTTPS", touching only what
 * differs: a client that is already there is sent nothing. Both steps change
 * the whole machine, not just torlink, which is the point of asking for a VPN.
 */
export async function ensureWarp(deps: WarpDeps): Promise<EnsureResult> {
  const result: EnsureResult = { modeSet: false, connectSent: false, error: null };
  const refused = (r: RunResult): string => firstLine(r.stderr) || firstLine(r.stdout) || "warp-cli failed";

  const mode = await readMode(deps.run);
  if (mode !== null && mode !== WARP_MODE) {
    const r = await deps.run(["mode", WARP_MODE]);
    if (r.code === 0) result.modeSet = true;
    else result.error = refused(r);
  }

  const { missing, status } = await readStatus(deps.run);
  if (!missing && status !== "Connected" && status !== "Connecting") {
    const r = await deps.run(["connect"]);
    if (r.code === 0) result.connectSent = true;
    else result.error = refused(r);
  }
  return result;
}

export const WARP_POLL_MS = 3000;

export interface WarpGuardOptions {
  deps: WarpDeps;
  /** What the engine was built bound to: WARP's address, or null when it started closed. */
  bound: string | null;
  /** Point the engine at an address, or close it (null). Called only when that changes. */
  bind: (address: string | null) => void;
  onState?: (state: WarpState) => void;
  onEnsured?: (result: EnsureResult) => void;
  intervalMs?: number;
}

export interface WarpGuard {
  /** Ask WARP to come up again (and into the right mode), then re-read it. */
  connect: () => void;
  stop: () => void;
}

/**
 * Keep the engine bound to WARP for as long as WARP is carrying traffic, and
 * closed otherwise. WARP's own status is the authority; the interface guard
 * underneath (download/network.ts) only catches the address vanishing between
 * two reads. Once WARP was in play, losing warp-cli closes too: nothing here
 * ever falls back to the normal connection.
 */
export function startWarpGuard(options: WarpGuardOptions): WarpGuard {
  const { deps, bind, onState, onEnsured, intervalMs = WARP_POLL_MS } = options;
  let bound = options.bound;
  let stopped = false;
  let reading = false;

  const read = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    try {
      const state = await readWarp(deps);
      if (stopped) return;
      const next = state.kind === "on" ? state.address : null;
      if (next !== bound) {
        bound = next;
        bind(next);
      }
      onState?.(state.kind === "missing" ? { kind: "off", detail: "not running" } : state);
    } catch {
      // A read that blew up says nothing new; the next one will.
    } finally {
      reading = false;
    }
  };

  const ensure = async (): Promise<void> => {
    try {
      const result = await ensureWarp(deps);
      if (!stopped) onEnsured?.(result);
    } catch {}
    await read();
  };

  void ensure();
  const timer = setInterval(() => void read(), intervalMs);
  timer.unref();

  return {
    connect: () => void ensure(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Whether a plain `torlnk` launch should bring WARP in: not when the user named an interface or opted out. */
export function warpWanted(opts: { warp?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (opts.warp === false) return false;
  if (env.TORLINK_NO_WARP) return false;
  if (env.TORLINK_INTERFACE?.trim()) return false;
  return true;
}
