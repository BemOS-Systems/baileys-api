import type {
  BaileysEventMap,
  MessageReceiptType,
  proto,
  WAConnectionState,
} from "@whiskeysockets/baileys";

export interface DisconnectInfo {
  // Baileys' DisconnectReason status code, null when the close carried none.
  statusCode: number | null;
  // Stable snake_case token derived from the code (never the Boom message).
  reason: string;
}

// What the socket is doing right now, as last reported to the webhook. Read
// by GET /connections/:phoneNumber so a consumer that lost a webhook — or
// never got one, because a healthy socket has nothing to report — can ask
// instead of guessing.
export interface ConnectionStateSnapshot {
  // `reconnecting` is ours, not Baileys': WAConnectionState is only
  // open/connecting/close, and the socket layer casts to it when it narrates
  // a resume. The snapshot reports what actually goes over the webhook.
  connection: WAConnectionState | "reconnecting" | null;
  disconnect: DisconnectInfo | null;
}

export interface BaileysConnectionOptions {
  clientName?: string;
  webhookUrl: string;
  webhookVerifyToken: string;
  includeMedia?: boolean;
  syncFullHistory?: boolean;
  groupsEnabled?: boolean;
  autoPresenceSubscribe?: boolean;
  // Link the device with an 8-character pairing code instead of (in addition
  // to) scanning the QR. The code is requested from WhatsApp on the first `qr`
  // event of each socket — that is the earliest point the Noise handshake is
  // complete and a node can be sent — and delivered on the same
  // connection.update webhook as `pairingCode`. QR refs keep rotating
  // meanwhile, so both linking methods stay live for the whole attempt.
  usePairingCode?: boolean;
  apiKeyHash?: string;
  isReconnect?: boolean;
  // Import/takeover: discard any live socket and spawn a fresh one so the newly
  // seeded creds are actually loaded. A reused in-memory socket (e.g. one still
  // emitting QRs) would otherwise ignore the transplanted session. Transient —
  // stripped in connect() and never persisted onto the connection.
  forceRestart?: boolean;
  // Epoch of the lease under which this connection was claimed. Stamped onto
  // connection.update webhooks so the client can discard late events from a
  // previous owner. Threaded in by the coordinator's lease-claim path; never
  // read back from Redis (a re-read could pick up a successor's epoch).
  leaseEpoch?: number | null;
  onConnectionClose?: () => void;
  // Invoked by the connection when it must tear itself down via the handler
  // (wrong-phone-number teardown) so the logout participates in the handler's
  // inFlightOps lock instead of bypassing it. Wired by the handler, mirroring
  // onConnectionClose. See issue #313.
  requestLogout?: () => void;
}

export interface BaileysConnectionWebhookPayload {
  event: keyof BaileysEventMap;
  // connection.update events additionally carry the lease epoch so the
  // client can discard late events from a previous owner.
  data:
    | BaileysEventMap[keyof BaileysEventMap]
    | (BaileysEventMap["connection.update"] & {
        epoch?: number;
        pairingCode?: string;
        // Why the socket closed, on `reconnecting` and on a terminal `close`.
        // See disconnectInfo in connection.ts.
        disconnect?: DisconnectInfo;
      })
    | {
        error: string;
        // Present on reconnect_loop_detected when the phone entered
        // quarantine: consecutive failed reconnect cycles and when background
        // claims will retry. Explicit POST /connections retries immediately.
        quarantine?: { strikes: number; until: string };
      };
  extra?: unknown;
}

export interface FetchMessageHistoryOptions {
  count: number;
  oldestMsgKey: proto.IMessageKey;
  oldestMsgTimestamp: number;
}

export interface SendReceiptsOptions {
  keys: proto.IMessageKey[];
  type?: MessageReceiptType;
}

export type MessageKeyWithId = proto.IMessageKey & { id: string };
