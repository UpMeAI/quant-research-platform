'use strict';

/**
 * The artifact chain of one lab run: every step writes its files under steps/NN_NAME/ and links its primary file to the one before it by sha256.
 * link = { step, name, artifact_path (relative to the output directory), sha256, prior_sha256 (null for step 1), status: DONE | PENDING_HOLDOUT | NOT_APPLICABLE }.
 */
const { fs, path, sha256, STEPS, stepDir, text } = require('./common');

class Chain {
  constructor(outDir) { this.outDir = outDir; this.links = []; fs.mkdirSync(outDir, { recursive: true }); }

  abs(rel) { return path.join(this.outDir, rel); }

  /** Write the files of one step (overwrites: steps are deterministic) and link its primary file. @returns {object} the link */
  add(stepNo, files, primary, status = 'DONE') {
    const step = STEPS.find((s) => s.n === stepNo);
    const dir = stepDir(step);
    fs.mkdirSync(this.abs(dir), { recursive: true });
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(this.abs(`${dir}/${name}`), bytes);
    const bytes = fs.readFileSync(this.abs(`${dir}/${primary}`));
    const link = { step: step.n, name: step.name, artifact_path: `${dir}/${primary}`, sha256: sha256(bytes), prior_sha256: this.links.length ? this.links[this.links.length - 1].sha256 : null, status };
    this.links.push(link);
    return link;
  }

  /** A file already written by an earlier run of the same step. */
  existing(stepNo, name) {
    const step = STEPS.find((s) => s.n === stepNo);
    const file = this.abs(`${stepDir(step)}/${name}`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  writeChain(header) {
    const file = this.abs('chain.json');
    fs.writeFileSync(file, text({ schema: 'LAB_CHAIN_V1', ...header, links: this.links }));
    return file;
  }
}

module.exports = { Chain };
