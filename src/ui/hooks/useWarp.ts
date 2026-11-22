import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DownloadQueue } from "../../download/queue";
import {
  WARP_WAITING,
  defaultWarpDeps,
  startWarpGuard,
  type WarpDeps,
  type WarpGuard,
  type WarpState,
} from "../../util/warp";
import type { VpnStatus } from "../store";

/**
 * Holds the download queue to Cloudflare WARP for the life of the app.
 * `initial` is what startup read before anything could open a socket (and
 * what the queue was built bound to); null or "missing" means WARP is not in
 * play and this does nothing.
 */
export function useWarp(
  queue: DownloadQueue | null,
  initial: WarpState | null,
  notify: (message: string) => void,
  // Test seams: a stand-in warp-cli, and how often it is read.
  deps?: WarpDeps,
  intervalMs?: number,
): VpnStatus | null {
  const inPlay = initial !== null && initial.kind !== "missing";
  const [state, setState] = useState<WarpState | null>(inPlay ? initial : null);
  const guard = useRef<WarpGuard | null>(null);
  const say = useRef(notify);
  say.current = notify;

  useEffect(() => {
    if (!queue || !inPlay) return;
    const started = startWarpGuard({
      deps: deps ?? defaultWarpDeps(),
      bound: initial.kind === "on" ? initial.address : null,
      bind: (address) => void queue.reconfigureNetwork({ interface: address ?? WARP_WAITING }),
      onState: setState,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      onEnsured: (r) => {
        if (r.error) say.current(`WARP: ${r.error}`);
        else if (r.connectSent) say.current("Turning WARP on…");
        else if (r.modeSet) say.current("WARP set to traffic + DNS over HTTPS");
      },
    });
    guard.current = started;
    return () => {
      started.stop();
      guard.current = null;
    };
    // `initial` is deliberately not a dependency: it is read once, since it
    // describes how the queue was built.
  }, [queue, inPlay, deps, intervalMs]);

  const connect = useCallback(() => guard.current?.connect(), []);

  return useMemo(() => {
    if (!state || state.kind === "missing") return null;
    return {
      name: "WARP",
      up: state.kind === "on",
      detail: state.kind === "on" ? "on" : state.detail,
      connect,
    };
  }, [state, connect]);
}
