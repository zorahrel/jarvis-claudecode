import type { Channel } from "../types";

/** Base interface all connectors implement */
export interface Connector {
  readonly channel: Channel;
  start(): Promise<void>;
  stop(): Promise<void>;
}
