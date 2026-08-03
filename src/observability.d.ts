import type {
	DataClass,
	MetricLabelName,
	SignalName,
	TelemetryLevel
} from './observability.generated.js';

export type {
	DataClass,
	EventFieldName,
	MetricEnumValue,
	MetricLabelName,
	SignalName,
	TelemetryLevel
} from './observability.generated.js';

export type AggregationLaw = 'sum' | 'max' | 'min';
export type MetricUnit = null | 'bytes' | 'seconds' | 'ratio' | 'percent' | 'enum';

export interface DiagnosticInput<T = unknown> {
	readonly source: string;
	readonly component: string;
	readonly event: string;
	readonly severity: TelemetryLevel;
	readonly message: string;
	readonly occurredAt?: string | null;
	readonly dataClass?: DataClass;
	readonly attributes?: T;
}

export interface DiagnosticRecord<T = unknown> {
	readonly schemaVersion: 1;
	readonly occurredAt: string | null;
	readonly source: string;
	readonly component: string;
	readonly event: string;
	readonly severity: TelemetryLevel;
	readonly level: TelemetryLevel;
	readonly dataClass: DataClass;
	readonly message: string;
	readonly attributes: T | null;
}

export interface ParsedDiagnostic<T = unknown> {
	readonly format: 'canonical' | 'legacy';
	readonly record: DiagnosticRecord<T>;
}

export interface LabelDomain {
	readonly kind: 'enum' | 'pattern';
	readonly dataClass: 'operational';
	readonly values?: readonly string[];
	readonly pattern?: string;
	readonly maxDistinct?: number;
}

export interface Signal {
	readonly name: SignalName;
	readonly type: 'counter' | 'gauge' | 'histogram';
	readonly labels: readonly MetricLabelName[];
	readonly unit: MetricUnit;
	readonly scope: 'worker' | 'process';
	readonly aggregate: AggregationLaw;
	readonly help: string;
	readonly formula?: string;
	readonly buckets: readonly number[] | null;
	readonly optional?: boolean;
	readonly merged?: boolean;
	readonly schemaVersion: 1;
	readonly dataClass: 'operational';
	readonly labelDomains: Readonly<Record<string, LabelDomain>>;
	readonly noData: Readonly<{ local: string; snapshot: string }>;
	readonly valueDomain: Readonly<Record<string, number>> | null;
}

export declare const OBSERVABILITY_SCHEMA_VERSION: 1;
export declare const DIAGNOSTIC_SCHEMA_VERSION: 1;
export declare const DIAGNOSTIC_PREFIX: 'oss-realtime/diagnostic';
export declare const TELEMETRY_LEVELS: readonly TelemetryLevel[];
export declare const DATA_CLASSES: Readonly<Record<DataClass, Readonly<{
	personalData: boolean;
	defaultRetention: string;
	description: string;
}>>>;
export declare const NO_DATA_POLICIES: Readonly<Record<string, string>>;
export declare const TELEMETRY_CONTRACT: Readonly<{
	schemaVersion: 1;
	eventEnvelope: Readonly<{ fields: Readonly<Record<string, Readonly<{
		required: boolean;
		type: string;
		dataClass: DataClass;
		values?: readonly string[];
	}>>> }>;
	correlation: Readonly<Record<'requestId' | 'traceparent' | 'tracestate', Readonly<{
		field: string;
		header: string;
		supported: boolean;
		dataClass: 'pseudonymous';
	}>>>;
	metrics: Readonly<{
		namePrefix: 'canonical-unprefixed';
		dataClass: 'operational';
		labelCardinality: 'bounded';
		noDataPolicies: typeof NO_DATA_POLICIES;
	}>;
}>;
export declare const PRESSURE_REASON_CODES: Readonly<Record<string, number>>;
export declare const SIGNALS: readonly Signal[];
export declare const SIGNALS_BY_NAME: ReadonlyMap<string, Signal>;
export declare function aggregationFor(name: string): AggregationLaw | null;
export declare function validateObservabilityContract(
	signals?: readonly Signal[],
	contract?: typeof TELEMETRY_CONTRACT
): string[];
export declare function createDiagnostic<T = unknown>(input: DiagnosticInput<T>): DiagnosticRecord<T>;
export declare function formatDiagnostic<T = unknown>(input: DiagnosticInput<T>): string;
export declare function parseDiagnostic(
	value: unknown,
	options?: Readonly<{ defaultSeverity?: TelemetryLevel }>
): ParsedDiagnostic | null;
export type OperationalEventSink = (record: DiagnosticRecord) => void | Promise<void>;
export declare function setOperationalEventSink(sink: OperationalEventSink | null): () => void;
export declare function emitOperationalEvent<T = unknown>(input: DiagnosticInput<T>): DiagnosticRecord<T>;

export interface TraceContext {
	readonly traceparent: string;
	readonly tracestate?: string;
}

export interface TraceSpan {
	readonly traceContext?: TraceContext | (() => TraceContext | null);
	readonly context?: TraceContext | (() => TraceContext | null);
	spanContext?(): { traceId: string; spanId: string; traceFlags?: number };
	setAttribute?(name: string, value: string | number | boolean): void;
	recordException?(error: unknown): void;
	end?(): void;
}

export interface TraceProvider {
	startSpan(name: string, options: Readonly<{
		kind: 'server' | 'consumer' | 'producer' | 'internal';
		parent: TraceContext | null;
		attributes: Readonly<Record<string, string | number | boolean>>;
	}>): TraceSpan | null;
}

export interface TraceOperationOptions {
	readonly kind?: 'server' | 'consumer' | 'producer' | 'internal';
	readonly parent?: TraceContext | null;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export declare function normalizeTraceContext(value: unknown): TraceContext | null;
export declare function extractTraceContext(carrier: Headers | Record<string, unknown>): TraceContext | null;
export declare function injectTraceContext<T extends Headers | Record<string, string>>(carrier: T, context?: TraceContext | null): T;
