"use client";

import { useEffect, useRef, useState } from "react";

export type WsState = "connecting" | "connected" | "reconnecting";

export interface LiveEventMessage {
  type: "sample_tick" | "probe_status" | "mtr_ready" | "incident_update";
  channel: string;
  data: unknown;
}

export function useLiveSocket(
  channels: string[],
  onEvent: (ev: LiveEventMessage) => void,
  options?: { scope?: "tv"; kioskKey?: string }
): WsState {
  const [state, setState] = useState<WsState>("connecting");
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const channelKey = channels.join("|");
  const scope = options?.scope;
  const kioskKey = options?.kioskKey;

  useEffect(() => {
    let active = true;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const connect = () => {
      if (!active) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams();
      if (scope) params.set("scope", scope);
      if (kioskKey) params.set("key", kioskKey);
      const qs = params.toString();
      const url = `${proto}//${window.location.host}/ws/live${qs ? `?${qs}` : ""}`;

      ws = new WebSocket(url);
      ws.onopen = () => {
        if (!active) return;
        backoffMs = 1000;
        setState("connected");
        for (const ch of channels) {
          ws?.send(JSON.stringify({ channel: ch }));
        }
      };

      ws.onmessage = (msg) => {
        try {
          const parsed = JSON.parse(String(msg.data)) as LiveEventMessage;
          handlerRef.current(parsed);
        } catch {
          // ignore malformed WS frames
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setState("reconnecting");
        retryTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, scope, kioskKey]);

  return state;
}
