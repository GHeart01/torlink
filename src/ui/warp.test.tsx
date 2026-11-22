import { afterEach, describe, expect, it, vi } from "vitest";
import { Text, useInput } from "ink";
import { SOURCES } from "../sources/registry";
import { parseCliArgs } from "../cli/args";
import type { DownloadQueue } from "../download/queue";
import type { InterfaceTable } from "../util/bind";
import { WARP_MODE, WARP_WAITING, type Runner, type WarpDeps, type WarpState } from "../util/warp";
import { StoreContext, type Store, type VpnStatus } from "./store";
import { makeTestStore, renderUI, type RenderedUI } from "./testHarness";
import { MouseProvider } from "./mouse";
import { useWarp } from "./hooks/useWarp";
import { Results } from "./components/Results";
import { Splash } from "./views/Splash";
import type { ConcurrentSearchState } from "./hooks/useConcurrentSearch";

const search = vi.hoisted(() => ({ enabled: [] as boolean[], state: null as unknown }));

vi.mock("./hooks/useConcurrentSearch", () => ({
  useConcurrentSearch: (_query: string, enabled = true) => {
    search.enabled.push(enabled);
    return search.state;
  },
}));

function idle(): ConcurrentSearchState {
  const perSource = Object.fromEntries(
    SOURCES.map((s) => [s.id, { loading: false, error: null, code: null, count: 0 }]),
  ) as ConcurrentSearchState["perSource"];
  return { results: [], perSource, loading: false, done: 0, total: SOURCES.length };
}

let ui: RenderedUI | null = null;
afterEach(() => {
  ui?.unmount();
  ui = null;
  search.enabled = [];
});

const vpn = (over: Partial<VpnStatus> = {}): VpnStatus => ({
  name: "WARP",
  up: true,
  detail: "on",
  connect: () => {},
  ...over,
});

function Listening() {
  useInput(() => {});
  return null;
}

function mount(node: React.ReactNode, store: Partial<Store>): RenderedUI {
  ui = renderUI(
    <MouseProvider>
      <StoreContext.Provider value={makeTestStore(store)}>
        <Listening />
        {node}
      </StoreContext.Provider>
    </MouseProvider>,
  );
  return ui;
}

describe("--no-warp", () => {
  it("turns WARP off for the TUI, with or without something to download", () => {
    expect(parseCliArgs(["--no-warp"])).toEqual({ kind: "run", warp: false });
    expect(parseCliArgs(["magnet:?xt=urn:btih:abc", "--no-warp"])).toMatchObject({
      kind: "run",
      warp: false,
    });
    expect(parseCliArgs([])).toEqual({ kind: "run" });
  });

  it("is refused by the headless modes, which never bring WARP in", () => {
    expect(parseCliArgs(["serve", "--no-warp"]).kind).toBe("invalid");
    expect(parseCliArgs(["search", "ubuntu", "--no-warp"]).kind).toBe("invalid");
  });
});

describe("results while held to a VPN", () => {
  it("search as usual while it is up", async () => {
    search.state = idle();
    const u = mount(<Results />, { query: "iso", vpn: vpn() });
    await vi.waitFor(() => expect(u.frame()).toContain("No results"));
    expect(search.enabled.every(Boolean)).toBe(true);
    expect(u.frame()).not.toContain("paused");
  });

  it("stop searching and say why while it is down", async () => {
    search.state = idle();
    const u = mount(<Results />, { query: "iso", vpn: vpn({ up: false, detail: "off" }) });
    // The line wraps inside the panel, so match it with the layout squeezed out.
    const flat = (): string => u.frame().replace(/[│\s]+/g, " ");
    await vi.waitFor(() =>
      expect(flat()).toContain("WARP is off. Searches and downloads are paused until it is back."),
    );
    expect(search.enabled.some(Boolean)).toBe(false);
    expect(u.frame()).not.toContain("Couldn't reach");
  });

  it("are untouched when no VPN is in play", async () => {
    search.state = idle();
    const u = mount(<Results />, { query: "iso", vpn: null });
    await vi.waitFor(() => expect(u.frame()).toContain("No results"));
    expect(search.enabled.every(Boolean)).toBe(true);
  });
});

describe("splash VPN line", () => {
  it("is absent without a VPN", async () => {
    const u = mount(<Splash />, { vpn: null });
    await vi.waitFor(() => expect(u.frame()).toContain("quit"));
    expect(u.frame()).not.toContain("WARP");
  });

  it("says WARP is carrying traffic and DNS", async () => {
    const u = mount(<Splash />, { vpn: vpn() });
    await vi.waitFor(() => expect(u.frame()).toContain("WARP on · traffic and DNS go through it"));
  });

  it("asks WARP to reconnect when the down line is clicked", async () => {
    const connect = vi.fn();
    const u = mount(<Splash />, { vpn: vpn({ up: false, detail: "off", connect }) });
    await vi.waitFor(() => expect(u.frame()).toContain("WARP off · paused until it is back"));
    u.clickText("WARP off");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  });
});

describe("useWarp", () => {
  const v4 = (address: string) =>
    ({ address, family: "IPv4", netmask: "255.255.255.255", mac: "", internal: false, cidr: null }) as const;
  const TABLE: InterfaceTable = { en0: [v4("192.168.3.72")], utun4: [v4("172.16.0.2")] };

  function fake(client: { status: string }): { deps: WarpDeps; sent: string[] } {
    const sent: string[] = [];
    const run: Runner = async (args) => {
      const cmd = args.filter((a) => a !== "-j").join(" ");
      const out = (stdout: string) => ({ code: 0, stdout, stderr: "", missing: false });
      if (cmd === "status") return out(JSON.stringify({ status: client.status }));
      if (cmd === "settings") return out(JSON.stringify({ settings: { operation_mode: WARP_MODE } }));
      sent.push(cmd);
      if (cmd === "connect") client.status = "Connected";
      return out("Success");
    };
    return { deps: { run, route: async () => "172.16.0.2", table: () => TABLE }, sent };
  }

  function Probe(props: {
    queue: DownloadQueue;
    initial: WarpState | null;
    deps: WarpDeps;
    notify: (m: string) => void;
  }) {
    const status = useWarp(props.queue, props.initial, props.notify, props.deps, 5);
    return <Text>{status ? `${status.name}:${status.up ? "up" : "down"}:${status.detail}` : "none"}</Text>;
  }

  const fakeQueue = () => {
    const reconfigureNetwork = vi.fn(() => ({ ok: true }));
    return { queue: { reconfigureNetwork } as unknown as DownloadQueue, reconfigureNetwork };
  };

  it("does nothing when WARP is not in play", async () => {
    const { queue, reconfigureNetwork } = fakeQueue();
    const { deps, sent } = fake({ status: "Disconnected" });
    for (const initial of [null, { kind: "missing" } as const]) {
      ui = renderUI(<Probe queue={queue} initial={initial} deps={deps} notify={() => {}} />);
      const u = ui;
      await vi.waitFor(() => expect(u.frame()).toContain("none"));
      await new Promise((r) => setTimeout(r, 30));
      u.unmount();
    }
    ui = null;
    expect(sent).toEqual([]);
    expect(reconfigureNetwork).not.toHaveBeenCalled();
  });

  it("turns WARP on from a closed start, then opens the queue on its address", async () => {
    const { queue, reconfigureNetwork } = fakeQueue();
    const { deps, sent } = fake({ status: "Disconnected" });
    const notify = vi.fn();
    ui = renderUI(
      <Probe queue={queue} initial={{ kind: "off", detail: "off" }} deps={deps} notify={notify} />,
    );
    const u = ui;
    expect(u.frame()).toContain("WARP:down:off");
    await vi.waitFor(() => expect(u.frame()).toContain("WARP:up:on"));
    expect(sent).toEqual(["connect"]);
    expect(notify).toHaveBeenCalledWith("Turning WARP on…");
    expect(reconfigureNetwork).toHaveBeenCalledTimes(1);
    expect(reconfigureNetwork).toHaveBeenCalledWith({ interface: "172.16.0.2" });
  });

  it("closes the queue when WARP drops", async () => {
    const { queue, reconfigureNetwork } = fakeQueue();
    const client = { status: "Connected" };
    const { deps, sent } = fake(client);
    ui = renderUI(
      <Probe
        queue={queue}
        initial={{ kind: "on", address: "172.16.0.2", iface: "utun4" }}
        deps={deps}
        notify={() => {}}
      />,
    );
    const u = ui;
    await vi.waitFor(() => expect(u.frame()).toContain("WARP:up:on"));
    await new Promise((r) => setTimeout(r, 30));
    expect(reconfigureNetwork).not.toHaveBeenCalled();

    client.status = "Disconnected";
    await vi.waitFor(() => expect(u.frame()).toContain("WARP:down:off"));
    expect(reconfigureNetwork).toHaveBeenCalledTimes(1);
    expect(reconfigureNetwork).toHaveBeenCalledWith({ interface: WARP_WAITING });
    // The drop itself is not answered with a connect.
    expect(sent).toEqual([]);
  });
});
