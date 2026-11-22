'use strict';

/**
 * Sealed canaries (AQ-38, RF1118 V10). A canary is a file planted in a sealed-like directory. The agent's start self-test tries to read each one;
 * the start is allowed only when every read is refused. A canary that is missing is UNKNOWN, never "unreadable".
 */
const fs = require('fs');
const path = require('path');
const { fail } = require('./common');

const TOKEN_PREFIX = 'QRP_SEALED_CANARY_V1';

function plant(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `CANARY-${label}.txt`);
  fs.writeFileSync(file, `${TOKEN_PREFIX}:${label}\n`);
  return file;
}

/** @param {{label: string, file: string}[]} probes */
function selfTest(probes, read = (f) => fs.readFileSync(f)) {
  if (!Array.isArray(probes) || !probes.length) fail('PREREG_ISOLATION_CANARY_UNKNOWN', 'no probes');
  const out = [];
  const readable = [];
  const unknown = [];
  for (const { label, file } of probes) {
    try {
      read(file);
      out.push({ label, readable: true });
      readable.push(label);
    } catch (e) {
      if (e && (e.code === 'EACCES' || e.code === 'EPERM')) out.push({ label, readable: false });
      else { out.push({ label, readable: null }); unknown.push(label); }
    }
  }
  if (readable.length) fail('PREREG_ISOLATION_CANARY_READABLE', readable.join(','));
  if (unknown.length) fail('PREREG_ISOLATION_CANARY_UNKNOWN', unknown.join(','));
  return { self_test: 'PASS', probes: out };
}

module.exports = { TOKEN_PREFIX, plant, selfTest };
