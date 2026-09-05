/**
 * Protocol major version. A single integer: every message carries it as
 * `protocolVersion`. Additive, optional fields ship within the same major;
 * anything a decoder for this major cannot accept requires a new major.
 * Decoders fail closed on any other major.
 */
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;
