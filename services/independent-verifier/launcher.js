'use strict';

/**
 * Generator launchers take the W20 read lock (W24, plan-coord ruling 11-23 item 3; contract "Who takes the process lock").
 * lockGenerator: the principal must be a generator (mining-generator, review-agent); the process may then write only `allowWriteRoot` and read nothing under the
 * holdout dirs (arguments plus QRP_HOLDOUT_DATA_DIRS); a refused holdout read is written to the access log as a generator HOLDOUT_READ row marked refused, which V-2 flags.
 * The round runner's scoring does not call this: it is the trusted evaluator (it takes authority.grantHoldoutRead and logs each holdout read itself).
 * The lock cannot be lifted inside the process.
 */
const authority = require('./authority');
const accessLog = require('./access-log');
const processLock = require('./process-lock');
const { SEGMENTS } = require('../mining-sandbox/segments');

/**
 * @param {{principal: string, allowWriteRoot: string, accessLogFile?: string, log?: {record: Function}, holdoutDirs?: string[]}} o
 * @returns {{principal: string, log: object, recordRead: (r: {dataset: string, from: string, to: string}) => object|null}}
 */
function lockGenerator({ principal, allowWriteRoot, accessLogFile = null, log = null, holdoutDirs = [] } = {}) {
  const cfg = authority.loadConfig();
  if (!cfg.generatorPrincipals.includes(principal)) throw Object.assign(new Error(`VERIFIER_PRINCIPAL_NOT_GENERATOR:${String(principal)}`), { code: 'VERIFIER_PRINCIPAL_NOT_GENERATOR' });
  const writer = log || (accessLogFile ? accessLog.writer(accessLogFile) : accessLog.deferred());
  const deny = [...new Set([...holdoutDirs, ...authority.holdoutDirsOf({})])];
  processLock.lockProcess({
    allowWriteRoot, denyReadRoots: deny,
    onRefuse: () => writer.record({ principal, op: 'HOLDOUT_READ', dataset: 'HOLDOUT_DATA_DIR', from: SEGMENTS.HOLDOUT.from, to: SEGMENTS.HOLDOUT.to, refused: true, code: 'VERIFIER_HOLDOUT_READ_REFUSED' }),
  });
  return { principal, log: writer, recordRead: ({ dataset, from, to }) => writer.record({ principal, op: 'READ', dataset, from, to }) };
}

module.exports = { lockGenerator };
