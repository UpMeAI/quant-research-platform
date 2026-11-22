'use strict';

/**
 * Clock preflight for the V9 ordering check (plan-coord ruling 11-22). The Mac registrar stamps registered_at and the Linux program stamps k2_frozen_at;
 * if a V9 refusal says "registered after freeze", the preflight tells a clock-skew suspicion from a real ordering error. It only parses the text of an
 * NTP status command run by the caller (no ssh, no network here); an unparseable status is an error, never "zero offset".
 * Supported: `chronyc tracking`, `timedatectl timesync-status` / `show-timesync`, `sntp <server>` (macOS).
 */
const { fail } = require('./common');

function parseOffset(text) {
  const t = String(text || '');
  let m = /System time\s*:\s*([\d.]+) seconds (fast|slow) of NTP time/.exec(t);
  if (m) return { offset_ms: (m[2] === 'fast' ? 1 : -1) * Number(m[1]) * 1000, source: 'chronyc' };
  m = /Offset:\s*([+-]?[\d.]+)\s*(us|µs|ms|s)\b/.exec(t);
  if (m) return { offset_ms: Number(m[1]) * ({ us: 0.001, 'µs': 0.001, ms: 1, s: 1000 })[m[2]], source: 'timedatectl' };
  m = /^\s*([+-][\d.]+)\s+\+\/-\s+[\d.]+\s+\S+/m.exec(t);
  if (m) return { offset_ms: Number(m[1]) * 1000, source: 'sntp' };
  return fail('CLOCK_PREFLIGHT_UNPARSEABLE');
}

/** @returns {{registrar_offset_ms: number, program_offset_ms: number, sources: string[], measured_at: string, tolerance_ms: number}} */
function clockOffsets({ registrarText, programText, measuredAt, toleranceMs = 1000 }) {
  const r = parseOffset(registrarText);
  const p = parseOffset(programText);
  return { registrar_offset_ms: r.offset_ms, program_offset_ms: p.offset_ms, sources: [r.source, p.source], measured_at: measuredAt, tolerance_ms: toleranceMs };
}

module.exports = { parseOffset, clockOffsets };
