export {
	OBSERVABILITY_SCHEMA_VERSION,
	TELEMETRY_LEVELS,
	DATA_CLASSES,
	NO_DATA_POLICIES,
	TELEMETRY_CONTRACT,
	PRESSURE_REASON_CODES,
	SIGNALS,
	SIGNALS_BY_NAME,
	aggregationFor,
	validateObservabilityContract
} from './runtime/observability-manifest.js';

export {
	DIAGNOSTIC_SCHEMA_VERSION,
	DIAGNOSTIC_PREFIX,
	createDiagnostic,
	formatDiagnostic,
	parseDiagnostic,
	setOperationalEventSink,
	emitOperationalEvent
} from './runtime/diagnostic.js';

export {
	normalizeTraceContext,
	extractTraceContext,
	injectTraceContext
} from './trace-context.js';
