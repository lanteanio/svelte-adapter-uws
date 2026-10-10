import { state } from '../../shared.js';
export function GET() { return Response.json({ messages: state.messages }); }
