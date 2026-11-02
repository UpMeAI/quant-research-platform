'use strict';
/**
 * Replay-core 桥(US_EQUITY / CRYPTO 适配器共用):在钉住的 smartflow 检出上以子进程跑 replay core。
 *
 * 为什么是子进程而不是把核心搬进来(REPLAY_CORE_CONTRACT_V1 §8:冻结后不另写回放引擎):
 *   策略决策(hooks)就是 smartflow 的生产策略代码,搬进平台即分叉。子进程按 pin.json 校验核心目录哈希、
 *   hooks 版本与已加载策略文件哈希,再调用 smartflow 自己的输入构造器与 Core.run —— 平台与生产跑的是同一份字节。
 *
 * 作业(QRP_REPLAY_CORE_JOB_V1,JSON):
 *   { kind, strategy: 'US_V5'|'C17'|'CARRY', payload_file, payload_sha256, options: { skipInputHash? } }
 * 载荷(QRP_REPLAY_CORE_PAYLOAD_V1,v8 序列化,只是数据):
 *   US_V5 { input }                          REPLAY_CORE_INPUT_V1 去掉 hooks(hooksId 指名 hooks)
 *   C17   { dataset, opts, configOverlay }   c17Input 的参数;configOverlay 只允许 ASSET_PARAMS 的止盈/冷却
 *   CARRY { data, win, capital, opts }       carryInput 的参数
 *
 * 边界:只读研究缓存;子进程环境裁成最小集(PATH / TZ),拿不到任何凭证;未配置 QRP_SMARTFLOW_ROOT = 未接通,显式抛错。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const { spawnSync } = require('child_process');
const { PIN, sha256Hex } = require('./core_pin');
const { JOB_KIND, PAYLOAD_KIND } = require('./runner');

const RUNNER = path.join(__dirname, 'runner.js');
const ROOT_ENV = 'QRP_SMARTFLOW_ROOT';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function smartflowRoot(opts = {}) {
  const root = opts.smartflowRoot || process.env[ROOT_ENV];
  if (!root) throw new Error(`REPLAY_CORE_SOURCE_NOT_CONFIGURED:${ROOT_ENV}`);
  return path.resolve(root);
}

/** 子进程只拿 PATH 与 TZ(TZ 与调用方一致,以免日历口径漂移);其余环境变量一律不传。 */
function childEnv() {
  const env = { PATH: process.env.PATH || '' };
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

/** 把载荷写成 v8 文件并返回作业;`dir` 为作业与载荷所在目录(研究缓存或临时目录)。 */
function writeJob(dir, strategy, payload, options = {}) {
  if (!PIN.strategies[strategy]) throw new Error(`STRATEGY_UNSUPPORTED:${strategy}`);
  const bytes = v8.serialize({ ...payload, kind: PAYLOAD_KIND, strategy });
  const sha = sha256Hex(bytes);
  const payloadFile = `payload-${sha.slice(0, 16)}.v8`;
  const full = path.join(dir, payloadFile);
  if (!fs.existsSync(full)) fs.writeFileSync(full, bytes);
  return { kind: JOB_KIND, strategy, payload_file: payloadFile, payload_sha256: sha, options };
}

/**
 * 跑一个作业。`job.payload_file` 相对 `jobDir`。返回 { receipt, output, outputBytes }:
 * outputBytes 是核心 canonBytes 的原样字节(结果哈希的依据),output 是其解析。
 */
function runJob(job, jobDir, opts = {}) {
  const root = smartflowRoot(opts);
  if (!job || job.kind !== JOB_KIND) throw new Error('JOB_KIND_INVALID');
  const spec = PIN.strategies[job.strategy];
  if (!spec) throw new Error(`STRATEGY_UNSUPPORTED:${job.strategy}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qrp-replay-core-'));
  try {
    const jobFile = path.join(tmp, 'job.json');
    const absPayload = path.resolve(jobDir, job.payload_file);
    fs.writeFileSync(jobFile, JSON.stringify({ ...job, payload_file: absPayload }));
    const outFile = path.join(tmp, 'output.json');
    const receiptFile = path.join(tmp, 'receipt.json');
    const r = spawnSync(process.execPath, [RUNNER, '--root', root, '--job', jobFile, '--out', outFile, '--receipt', receiptFile], {
      cwd: tmp, env: childEnv(), encoding: 'utf8', timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: 1 << 26,
    });
    if (r.error) throw new Error(`REPLAY_CORE_RUN_FAILED:${r.error.code || r.error.message}`);
    if (r.status !== 0) throw new Error(`REPLAY_CORE_RUN_FAILED:${String(r.stderr || '').trim().split('\n').pop()}`);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    const outputBytes = fs.readFileSync(outFile);
    if (sha256Hex(outputBytes) !== receipt.output_sha256) throw new Error('REPLAY_CORE_OUTPUT_SHA256_MISMATCH');
    if (receipt.core_version_hash !== PIN.core.version_hash) throw new Error('CORE_VERSION_MISMATCH:receipt');
    if (receipt.hooks_id !== spec.hooks_id) throw new Error('HOOKS_VERSION_MISMATCH:receipt');
    return { receipt: { ...receipt, smartflow_commit_pinned: PIN.smartflow.commit }, output: JSON.parse(outputBytes.toString('utf8')), outputBytes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 研究缓存目录的作业清单(只读):每个 *.job.json 及其载荷的 sha256 是否对得上。 */
function listJobs(cacheDir) {
  const out = [];
  for (const name of fs.readdirSync(cacheDir).filter((n) => n.endsWith('.job.json')).sort()) {
    const job = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
    const payloadPath = path.resolve(cacheDir, job.payload_file || '');
    const ok = job.kind === JOB_KIND && fs.existsSync(payloadPath) && sha256Hex(fs.readFileSync(payloadPath)) === job.payload_sha256;
    out.push({ job_file: name, strategy: job.strategy, payload_sha256: job.payload_sha256, payload_ok: ok });
  }
  return out;
}

module.exports = { PIN, ROOT_ENV, RUNNER, smartflowRoot, childEnv, writeJob, runJob, listJobs };
