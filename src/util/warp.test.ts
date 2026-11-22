import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterfaceTable } from "./bind";
import {
  WARP_MODE,
  ensureWarp,
  readWarp,
  startWarpGuard,
  tunnelHolding,
  warpWanted,
  type RunResult,
  type Runner,
  type WarpDeps,
  type WarpState,
} from "./warp";

const v4 = (address: string) =>
  ({ address, family: "IPv4", netmask: "255.255.255.0", mac: "", internal: false, cidr: null }) as const;

const TABLE: InterfaceTable = {
  en0: [v4("192.168.3.72")],
  utun4: [v4("172.16.0.2")],
};

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", missing: false });
const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr, missing: false });
const MISSING: RunResult = { code: null, stdout: "", stderr: "", missing: true };

// A stand-in warp-cli: answers status and settings from `client`, and applies
// mode / connect to it the way the real one does.
function fakeWarp(client: { status: string; mode: string; refuse?: string }): {
  run: Runner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: Runner = async (args) => {
    calls.push(args.join(" "));
    const cmd = args.filter((a) => a !== "-j").join(" ");
    if (cmd === "status") return ok(JSON.stringify({ status: client.status }));
    if (cmd === "settings") return ok(JSON.stringify({ settings: { operation_mode: client.mode } }));
    if (client.refuse) return fail(client.refuse);
    if (cmd === `mode ${WARP_MODE}`) client.mode = WARP_MODE;
    else if (cmd === "connect") client.status = "Connected";
    else return fail(`unexpected: ${cmd}`);
    return ok("Success");
  };
  return { run, calls };
}

const deps = (run: Runner, route: string | null = "172.16.0.2"): WarpDeps => ({
  run,
  route: async () => route,
  table: () => TABLE,
});

const mutating = (calls: string[]): string[] => calls.filter((c) => !c.startsWith("-j "));

describe("tunnelHolding", () => {
  it("names the tunnel an address sits on", () => {
    expect(tunnelHolding("172.16.0.2", TABLE)).toBe("utun4");
    expect(tunnelHolding("10.0.0.1", { CloudflareWARP: [v4("10.0.0.1")] })).toBe("CloudflareWARP");
  });

  it("refuses an address on a normal interface, or on none", () => {
    expect(tunnelHolding("192.168.3.72", TABLE)).toBeNull();
    expect(tunnelHolding("203.0.113.9", TABLE)).toBeNull();
  });
});

describe("readWarp", () => {
  it("is on when connected and traffic leaves through the tunnel", async () => {
    const { run } = fakeWarp({ status: "Connected", mode: WARP_MODE });
    expect(await readWarp(deps(run))).toEqual({ kind: "on", address: "172.16.0.2", iface: "utun4" });
  });

  it("is off when connected but traffic still leaves through Wi-Fi", async () => {
    const { run } = fakeWarp({ status: "Connected", mode: "doh" });
    expect(await readWarp(deps(run, "192.168.3.72"))).toEqual({
      kind: "off",
      detail: "not carrying traffic",
    });
  });

  it("is off while disconnected or connecting, without trusting the route", async () => {
    expect(await readWarp(deps(fakeWarp({ status: "Disconnected", mode: WARP_MODE }).run))).toEqual({
      kind: "off",
      detail: "off",
    });
    expect(await readWarp(deps(fakeWarp({ status: "Connecting", mode: WARP_MODE }).run))).toEqual({
      kind: "off",
      detail: "connecting",
    });
  });

  it("is missing when there is no warp-cli", async () => {
    expect(await readWarp(deps(async () => MISSING))).toEqual({ kind: "missing" });
  });

  it("is off when the service answers nothing usable", async () => {
    const run: Runner = async () => fail("Unable to connect to the CloudflareWARP daemon");
    expect(await readWarp(deps(run))).toEqual({ kind: "off", detail: "not running" });
  });

  it("reads the plain-text status of a client without --json", async () => {
    const run: Runner = async () => ok("Status update: Connected\nNetwork: healthy\n");
    expect(await readWarp(deps(run))).toMatchObject({ kind: "on" });
  });
});

describe("ensureWarp", () => {
  it("sends nothing to a client that is already connected in the right mode", async () => {
    const { run, calls } = fakeWarp({ status: "Connected", mode: WARP_MODE });
    expect(await ensureWarp(deps(run))).toEqual({ modeSet: false, connectSent: false, error: null });
    expect(mutating(calls)).toEqual([]);
  });

  it("connects a client that is off", async () => {
    const { run, calls } = fakeWarp({ status: "Disconnected", mode: WARP_MODE });
    expect(await ensureWarp(deps(run))).toEqual({ modeSet: false, connectSent: true, error: null });
    expect(mutating(calls)).toEqual(["connect"]);
  });

  it("moves a DNS-only client to traffic + DNS over HTTPS", async () => {
    const { run, calls } = fakeWarp({ status: "Connected", mode: "doh" });
    expect(await ensureWarp(deps(run))).toEqual({ modeSet: true, connectSent: false, error: null });
    expect(mutating(calls)).toEqual([`mode ${WARP_MODE}`]);
  });

  it("does not pile a second connect on one already in progress", async () => {
    const { run, calls } = fakeWarp({ status: "Connecting", mode: WARP_MODE });
    await ensureWarp(deps(run));
    expect(mutating(calls)).toEqual([]);
  });

  it("reports warp-cli's own words when it refuses", async () => {
    const { run } = fakeWarp({
      status: "Disconnected",
      mode: WARP_MODE,
      refuse: "Registration Missing\nrun warp-cli registration new",
    });
    expect(await ensureWarp(deps(run))).toEqual({
      modeSet: false,
      connectSent: false,
      error: "Registration Missing",
    });
  });
});

describe("startWarpGuard", () => {
  afterEach(() => vi.useRealTimers());

  it("opens the engine once WARP is up, and closes it when WARP drops", async () => {
    const client = { status: "Disconnected", mode: WARP_MODE };
    const { run, calls } = fakeWarp(client);
    const binds: (string | null)[] = [];
    const states: WarpState[] = [];
    const guard = startWarpGuard({
      deps: deps(run),
      bound: null,
      bind: (a) => binds.push(a),
      onState: (s) => states.push(s),
      intervalMs: 5,
    });
    // Started closed with WARP off: the guard connects it, then opens.
    await vi.waitFor(() => expect(binds).toEqual(["172.16.0.2"]));
    expect(mutating(calls)).toEqual(["connect"]);

    client.status = "Disconnected";
    await vi.waitFor(() => expect(binds).toEqual(["172.16.0.2", null]));
    expect(states.at(-1)).toEqual({ kind: "off", detail: "off" });
    // A drop is not answered with a connect: that is WARP's and the user's call.
    expect(mutating(calls)).toEqual(["connect"]);

    client.status = "Connected";
    await vi.waitFor(() => expect(binds).toEqual(["172.16.0.2", null, "172.16.0.2"]));
    guard.stop();
  });

  it("leaves a healthy engine alone", async () => {
    const { run, calls } = fakeWarp({ status: "Connected", mode: WARP_MODE });
    const bind = vi.fn();
    const states: WarpState[] = [];
    const guard = startWarpGuard({
      deps: deps(run),
      bound: "172.16.0.2",
      bind,
      onState: (s) => states.push(s),
      intervalMs: 5,
    });
    await vi.waitFor(() => expect(states.length).toBeGreaterThan(2));
    expect(bind).not.toHaveBeenCalled();
    expect(mutating(calls)).toEqual([]);
    guard.stop();
  });

  it("closes, never falls back, if warp-cli disappears mid-session", async () => {
    let gone = false;
    const { run } = fakeWarp({ status: "Connected", mode: WARP_MODE });
    const binds: (string | null)[] = [];
    const guard = startWarpGuard({
      deps: deps(async (args) => (gone ? MISSING : run(args))),
      bound: "172.16.0.2",
      bind: (a) => binds.push(a),
      intervalMs: 5,
    });
    gone = true;
    await vi.waitFor(() => expect(binds).toEqual([null]));
    guard.stop();
  });

  it("connect() asks again after a refusal clears", async () => {
    const client: { status: string; mode: string; refuse?: string } = {
      status: "Disconnected",
      mode: WARP_MODE,
      refuse: "Registration Missing",
    };
    const { run } = fakeWarp(client);
    const binds: (string | null)[] = [];
    const errors: (string | null)[] = [];
    const guard = startWarpGuard({
      deps: deps(run),
      bound: null,
      bind: (a) => binds.push(a),
      onEnsured: (r) => errors.push(r.error),
      intervalMs: 5,
    });
    await vi.waitFor(() => expect(errors).toEqual(["Registration Missing"]));
    expect(binds).toEqual([]);
    delete client.refuse;
    guard.connect();
    await vi.waitFor(() => expect(binds).toEqual(["172.16.0.2"]));
    guard.stop();
  });

  it("stops reading once stopped", async () => {
    const { run, calls } = fakeWarp({ status: "Connected", mode: WARP_MODE });
    const guard = startWarpGuard({ deps: deps(run), bound: "172.16.0.2", bind: () => {}, intervalMs: 5 });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(2));
    guard.stop();
    await new Promise((r) => setTimeout(r, 20));
    const settled = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(settled);
  });
});

describe("warpWanted", () => {
  it("is on by default", () => {
    expect(warpWanted({}, {})).toBe(true);
  });

  it("stands down for --no-warp, TORLINK_NO_WARP, or an interface the user named", () => {
    expect(warpWanted({ warp: false }, {})).toBe(false);
    expect(warpWanted({}, { TORLINK_NO_WARP: "1" })).toBe(false);
    expect(warpWanted({}, { TORLINK_INTERFACE: "wg0" })).toBe(false);
    expect(warpWanted({}, { TORLINK_INTERFACE: "  " })).toBe(true);
  });
});
