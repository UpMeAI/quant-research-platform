'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const F = require('./_rq_agent_fixture');

const ROOT = path.join(__dirname, '..');
const LINUX = path.join(ROOT, 'deploy', 'research-queue-ai', 'linux');
const BASE = 'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';

test('#167 image is pinned, dependency-free, and runs the archived source as uid 1000', () => {
  const dockerfile = fs.readFileSync(path.join(LINUX, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, new RegExp(`^FROM ${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(dockerfile, /^COPY \. \/app$/m);
  assert.match(dockerfile, /^USER 1000:1000$/m);
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.equal(/\b(?:RUN|ADD)\b|npm\s+(?:ci|install)|curl|wget|apt-get/.test(dockerfile), false,
    'the image must need neither node_modules nor build-time network');
  assert.equal(fs.existsSync(path.join(ROOT, 'node_modules')), false, 'the archived source must not rely on node_modules');
});

test('#167 build uses git archive, forbids pull/build network, tags the exact 12-hex commit, and records image ID', () => {
  const build = fs.readFileSync(path.join(LINUX, 'build-image.sh'), 'utf8');
  for (const required of ['git archive', '--network none', '--pull=false', 'rq-agent:', 'docker image inspect', 'RQ_AGENT_IMAGE=', 'RQ_AGENT_IMAGE_ID=']) {
    assert.ok(build.includes(required), required);
  }
  assert.match(build, /[Ss][Hh][Aa].*cut -c 1-12|cut -c 1-12.*[Ss][Hh][Aa]/s);
  assert.equal(/docker\s+(?:pull|login)|npm\s+(?:ci|install)|curl|wget/.test(build), false);
});

test('#167 generated consumer environment is exact and the service uses rootless Docker', () => {
  const service = fs.readFileSync(path.join(ROOT, 'deploy', 'research-queue', 'linux', 'rq-consumer.service'), 'utf8');
  assert.match(service, /^Environment=DOCKER_HOST=unix:\/\/\/run\/user\/1000\/docker\.sock$/m);
  assert.match(service, /^EnvironmentFile=%h\/\.config\/research-queue\/rq-agent-image\.env$/m);
  const readme = fs.readFileSync(path.join(LINUX, 'README.md'), 'utf8');
  for (const required of ['git archive', 'rq-agent:<12-hex>', 'RQ_AGENT_IMAGE_ID', 'MODE=LIVE', 'systemctl --user restart rq-consumer.service']) {
    assert.ok(readme.includes(required), required);
  }
});

test('#167 launcher refuses unstaged input before Docker and enforces no network', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rq167-refuse-'));
  try {
    const fakeBin = path.join(tmp, 'bin');
    fs.mkdirSync(fakeBin);
    const docker = path.join(fakeBin, 'docker');
    fs.writeFileSync(docker, '#!/bin/sh\necho docker-must-not-run >&2\nexit 99\n', { mode: 0o755 });
    const run = spawnSync(path.join(LINUX, 'run-agent.sh'), [path.join(tmp, 'in'), path.join(tmp, 'out')], {
      encoding: 'utf8',
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, RQ_AGENT_IMAGE: 'rq-agent:0123456789ab', XDG_RUNTIME_DIR: tmp },
    });
    assert.equal(run.status, 66, run.stderr);
    assert.match(run.stderr, /RQ_AGENT_INPUT_NOT_STAGED/);
    assert.equal(run.stderr.includes('docker-must-not-run'), false);
    const launcher = fs.readFileSync(path.join(LINUX, 'run-agent.sh'), 'utf8');
    assert.match(launcher, /docker run --rm --network none/);
    assert.match(launcher, /--user 0:0/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('#167 Linux rootless image completes stage -> agent -> result.json through a scratch Unix socket',
  { skip: !process.env.RQ_AGENT_IMAGE }, async () => {
    const tmpBase = process.env.RQ167_TMPDIR || os.tmpdir();
    const tmp = fs.mkdtempSync(path.join(tmpBase, 'rq167-e2e-'));
    const runtime = path.join(tmp, 'runtime');
    const staged = path.join(tmp, 'attempt', 'in');
    const out = path.join(tmp, 'attempt', 'out');
    const sock = path.join(runtime, 'rq-gw.sock');
    fs.mkdirSync(runtime);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    const packFile = path.join(tmp, 'pack.json');
    fs.writeFileSync(packFile, JSON.stringify(F.makePack()));
    const row = {
      task_id: 'RQT-LINUX-20261125-167a167a', host: 'LINUX', agent_host: 'LINUX',
      kind: 'AI_REVIEW_CARD', market: 'CN_A', template_id: 'AI_REVIEW_CARD_V1',
      template_sha256: F.sha('tpl'), attempt_no: 1,
    };
    const cli = path.join(ROOT, 'services', 'research-queue-agent', 'cli.js');
    const stage = spawnSync(process.execPath,
      [cli, 'stage', '--row-json', JSON.stringify(row), '--input', packFile, '--out', staged],
      { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(stage.status, 0, stage.stderr);

    let calls = 0;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        calls += 1;
        res.setHeader('content-type', 'application/json');
        const card = F.makeCard({ factor_ideas: [], no_idea_reason: { text_zh: '本周没有触及选股或择时的发现', fact_ids: ['F-001'] } });
        res.end(JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: JSON.stringify(card) } }], usage: {} }));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
    try {
      const run = await new Promise((resolve) => {
        const child = spawn(path.join(LINUX, 'run-agent.sh'), [staged, out], { env: {
          PATH: process.env.PATH,
          RQ_AGENT_IMAGE: process.env.RQ_AGENT_IMAGE,
          XDG_RUNTIME_DIR: runtime,
          DOCKER_HOST: process.env.DOCKER_HOST,
        } });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'result.json'))).status, 'DONE');
      assert.equal(calls, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
