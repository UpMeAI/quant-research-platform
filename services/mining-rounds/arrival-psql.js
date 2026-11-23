'use strict';

/**
 * RF1116 R2 data arrival, PG_PSQL driver: runs ONE read-only query through psql (connection from the standard PG* environment, a read-only role) and returns the CSV bytes.
 * Kept out of services/mining-sandbox (sandbox modules do not import child_process; tests/mining_sandbox.test.js). The queries themselves and the psql arguments are in
 * services/mining-sandbox/round-runner/arrival.js (pgQueries, psqlArgs) and are tested; this runner is not exercised by any test (no database here).
 */
const { spawnSync } = require('child_process');
const { psqlArgs } = require('../mining-sandbox/round-runner/arrival');

function psqlRunner({ psql = 'psql', env = process.env } = {}) {
  return (sql) => {
    const r = spawnSync(psql, psqlArgs(sql), { env, maxBuffer: 1024 * 1024 * 1024 });
    if (r.status !== 0) { const e = new Error(`MINE_RUNNER_ARRIVE_PSQL:${r.status}:${String(r.stderr || '').slice(0, 200)}`); e.code = 'MINE_RUNNER_ARRIVE_PSQL'; throw e; }
    return r.stdout;
  };
}

module.exports = { psqlRunner };
