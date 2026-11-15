'use strict';

/**
 * Node 运行器（子进程）。stdin 是按行的作业：第一行 init（被测模块、入口、调用方式、输出形状），其后每行一次调用的输入。
 * 先装沙箱再加载被测模块；每次调用前重新加载（模块缓存与新增全局变量清零），一次调用的缓存带不进下一次。每次调用的输出按 canon.js 写成规范串，连同这次调用里的越界记录写回 stdout（带标记的行）。
 * 不比较、不判定：比较与判定都在 core.js。
 */
const fs = require('fs');
const path = require('path');
const { canon } = require('./canon');
const { createSandbox } = require('./sandbox');

const MARK = '@@CAUSALITY@@';
const out = process.stdout.write.bind(process.stdout);
const emit = (obj) => out(`${MARK}${JSON.stringify(obj)}\n`);
const message = (e) => String(e && e.message ? e.message : e).slice(0, 300);

const select = (value, dotted) => (dotted ? String(dotted).split('.').reduce((v, k) => (v == null ? v : v[k]), value) : value);

function shape(result, output) {
  const value = select(result, output.select);
  if (output.align === 'ALIGNED') {
    if (!(Array.isArray(value) || ArrayBuffer.isView(value))) throw new Error('OUTPUT_NOT_ARRAY');
    return { kind: 'ALIGNED', values: Array.from(value, canon) };
  }
  if (!Array.isArray(value)) throw new Error('OUTPUT_NOT_ARRAY');
  return { kind: 'KEYED', rows: value.map((rec) => [canon((output.key_fields || []).map((k) => rec && rec[k])), rec ? rec[output.time_field] : null, canon(rec)]) };
}

async function main() {
  const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const init = lines.shift();
  const sandbox = createSandbox({ fixtureDir: init.fixture_dir, codeRoots: init.code_roots, staticReads: init.static_reads || [] });
  // 被测函数的 stdout 改走 stderr，不污染协议行
  process.stdout.write = process.stderr.write.bind(process.stderr);
  sandbox.install();
  const target = path.resolve(init.code_root, init.path);
  const harnessDir = __dirname;
  const purgeable = (file) => !file.startsWith(harnessDir + path.sep) && init.code_roots.some((r) => file === r || file.startsWith(r + path.sep));
  let globals = null;
  /** MODULE_RELOAD：每次调用前清掉代码根下的模块缓存、删掉上次调用新增的全局变量，再重新加载被测模块（加载阶段的规则）。 */
  const load = () => {
    sandbox.enterLoad();
    for (const k of Object.keys(require.cache)) if (purgeable(k)) delete require.cache[k];
    if (globals) for (const k of Object.getOwnPropertyNames(globalThis)) if (!globals.has(k)) delete globalThis[k];
    const f = select(require(target), init.entry);
    if (typeof f !== 'function') throw new Error(`ENTRY_NOT_FUNCTION:${init.entry}`);
    if (!globals) globals = new Set(Object.getOwnPropertyNames(globalThis));
    sandbox.enterCall();
    return f;
  };
  let fn;
  try {
    fn = load();
  } catch (e) {
    emit({ id: 'init', ok: false, error: message(e), attempts: sandbox.takeAttempts(), load_reads: sandbox.loadReads() });
    return;
  }
  emit({ id: 'init', ok: true, attempts: sandbox.takeAttempts(), load_reads: sandbox.loadReads(), runtime: { node: process.version, permission: Boolean(process.permission) } });
  const call = init.call || {};
  const at = call.at || null;
  let first = true;
  for (const job of lines) {
    try {
      if (!first) fn = load();
      first = false;
      const base = call.style === 'object'
        ? [{ ...job.inputs, ...(call.params || {}) }]
        : [...(call.order || Object.keys(job.inputs)).map((k) => job.inputs[k]), ...(call.params || [])];
      let out;
      if (init.output.align === 'AT_POINT') {
        // 逐时点函数 f(X, t)：对主输入的每一行调用一次，t 是行号或该行的某个字段；某个点抛错也是这个点的读数
        const rows = job.inputs[init.output.to];
        const values = [];
        for (let i = 0; i < rows.length; i += 1) {
          const v = at.value === 'INDEX' ? i : rows[i][at.field];
          const args = base.slice();
          if (at.key) args[at.position] = { ...(args[at.position] || {}), [at.key]: v };
          else args.splice(at.position, 0, v);
          try {
            let r = fn(...args);
            if (r && typeof r.then === 'function') r = await r;
            values.push(canon(select(r, init.output.select)));
          } catch (e) {
            if (sandbox.isDenied(e)) throw e;
            values.push(`x:${JSON.stringify(message(e))}`);
          }
        }
        out = { kind: 'ALIGNED', values };
      } else {
        let result = fn(...base);
        if (result && typeof result.then === 'function') result = await result;
        out = shape(result, init.output);
      }
      emit({ id: job.id, ok: true, out, attempts: sandbox.takeAttempts() });
    } catch (e) {
      emit({ id: job.id, ok: false, error: message(e), attempts: sandbox.takeAttempts() });
    }
  }
}

main().catch((e) => { emit({ id: 'fatal', ok: false, error: message(e) }); process.exitCode = 1; });
