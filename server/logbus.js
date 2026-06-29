// logbus.js — tiny in-process event bus used to stream "terminal" lines to the UI.
//
// Every component (MCP client, BPI API, orchestrator) emits structured log
// records on a single EventEmitter. The orchestrator subscribes once and
// rebroadcasts each record to connected browsers over WebSocket, where it is
// rendered into the matching terminal panel.
import { EventEmitter } from 'node:events';

export const CHANNELS = {
  CHAT: 'chat', // A.I Chat Center status line (not the bubbles themselves)
  MCP_CLIENT: 'mcp-client', // "MCP Client Terminal"
  MCP_SERVER: 'mcp-server', // "BPI MCP Server Terminal"
  BPI_API: 'bpi-api', // "BPI Open Banking API Server Terminal"
  SYSTEM: 'system',
};

const bus = new EventEmitter();
bus.setMaxListeners(50);

let seq = 0;

/**
 * Emit a structured log line.
 * @param {string} channel one of CHANNELS
 * @param {object} fields { level, dir, text, data }
 *   - level: 'info' | 'req' | 'res' | 'ok' | 'err' | 'tool' | 'llm'
 *   - dir:   '->' | '<-' | undefined  (direction arrow shown in the terminal)
 */
export function log(channel, fields = {}) {
  const record = {
    id: ++seq,
    ts: new Date().toISOString(),
    channel,
    level: fields.level || 'info',
    dir: fields.dir || null,
    text: fields.text != null ? String(fields.text) : '',
    data: fields.data ?? null,
    ms: Number.isFinite(fields.ms) ? fields.ms : null, // round-trip latency, if known
  };
  bus.emit('log', record);
  return record;
}

export function onLog(listener) {
  bus.on('log', listener);
  return () => bus.off('log', listener);
}

export default { log, onLog, CHANNELS };
