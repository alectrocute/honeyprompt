import type { ServiceConfig } from "../config/schema.ts";

/** A protocol listener that can be started and gracefully stopped. */
export interface Service {
  readonly config: ServiceConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
}
