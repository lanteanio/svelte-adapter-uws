// Generated from src/index.d.ts by scripts/generate-platform-contract.js.
/**
 * All public Platform member names, including per-request and per-connection
 * context fields. This inventory describes the uWS contract, not the
 * capabilities implemented by another adapter or an arbitrary platform object.
 */
export declare const PLATFORM_MEMBERS: readonly [
	"adviseReconnect",
	"assertions",
	"authorizeWireSubscribe",
	"batch",
	"bufferedAmount",
	"bumpTopicEpoch",
	"checkSubscribe",
	"closedWsAborts",
	"connections",
	"diagnostic",
	"forEachSubscriber",
	"grantPublish",
	"hlc",
	"introspect",
	"isWarmupRequest",
	"maxPayloadLength",
	"metrics",
	"metricsSnapshot",
	"monotonic",
	"now",
	"onPressure",
	"onPublishRate",
	"pressure",
	"protection",
	"publish",
	"publishBatched",
	"publishGame",
	"publishGrant",
	"publishWire",
	"publishWireBatch",
	"random",
	"registerWireCodec",
	"request",
	"requestId",
	"requestTopic",
	"revokePublish",
	"send",
	"sendCoalesced",
	"sendTo",
	"sendWire",
	"sendWireBatch",
	"subscribe",
	"subscribers",
	"topic",
	"topicEpoch",
	"trace",
	"traceContext",
	"unsubscribe"
];

/** A public Platform member name. */
export type PlatformMember = typeof PLATFORM_MEMBERS[number];
