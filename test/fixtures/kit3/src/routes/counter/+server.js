import { state } from '../../shared.js';
export function GET() { return Response.json({ messages: state.messages, entries: state.entries, instrumentation: globalThis.__kit3InstrumentationToken }); }
