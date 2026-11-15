"""Python 运行器（子进程），供统计车道用。协议、阶段与 Node 运行器（../lib/node-runner.js）相同。

T-C3 用审计钩子（sys.addaudithook，装上就卸不掉）：
  LOAD：可读代码文件、解释器与库目录（标准库、site-packages）里的文件、夹具目录、清单声明的 static_reads；
        仓库自己的数据文件不声明就不许读；
  CALL：只可读夹具目录与 static_reads；代码根与解释器目录下只允许按需加载代码文件（.py/.pyc/.so/.pyd）。
  两个阶段都可以列目录（只得到文件名）。
两个阶段都不许写文件、访问网络（含 Unix 套接字，即数据库）、起子进程、打开 sqlite。
每一次越界都先记下再抛错：被测函数吞掉异常、改走别的路，T-C3 照样判 FAIL。

输出的规范写法（★4 (a) 逐字节相等）：float 写成 IEEE 754 双精度的 16 位十六进制；int 与 float 不同；
numpy 标量按 .item()，ndarray / Series 按 .tolist()，DataFrame 按逐行字典。
"""
import json
import os
import re
import struct
import sys

MARK = '@@CAUSALITY@@'
CODE_EXT = ('.py', '.pyc', '.so', '.pyd')
LIBRARY = re.compile(r'[\\/](site-packages|dist-packages|node_modules)[\\/]')
DENIED = 'CAUSALITY_SANDBOX_DENIED'

_proto = sys.stdout


def emit(obj):
    _proto.write(MARK + json.dumps(obj, ensure_ascii=False) + '\n')
    _proto.flush()


class Denied(PermissionError):
    pass


def make_sandbox(fixture_dir, code_roots, static_reads=()):
    state = {'phase': 'LOAD', 'attempts': [], 'load_reads': []}
    real = os.path.realpath
    fixture = real(fixture_dir)
    roots = [real(r) for r in code_roots]
    statics = {real(p) for p in static_reads}  # 清单声明、已记 sha256 的静态文件，调用阶段也可读
    # 解释器的导入根：标准库、site-packages（Homebrew 的 site-packages 不在 sys.prefix 下）与 sys.path 上的目录
    import site
    places = [sys.prefix, sys.base_prefix, sys.exec_prefix, os.path.dirname(os.__file__)] + list(site.getsitepackages()) + [p for p in sys.path if p]
    prefixes = sorted({real(p) for p in places if p and os.path.isdir(p)})

    def inside(p, d):
        return p == d or p.startswith(d + os.sep)

    def display(p):
        if inside(p, fixture):
            return '<fixture>/' + os.path.relpath(p, fixture)
        for r in roots:
            if inside(p, r):
                return '<code>/' + os.path.relpath(p, r)
        for r in prefixes:
            if inside(p, r):
                return '<runtime>/' + os.path.basename(p)
        return '<outside>/' + os.path.basename(p)

    def deny(kind, target):
        state['attempts'].append({'phase': state['phase'], 'kind': kind, 'target': target})
        raise Denied('%s:%s:%s' % (DENIED, kind, target))

    def declared(p):
        return any(inside(p, s) for s in statics)  # 声明的文件，或声明的目录之下

    def in_library(p):
        return any(inside(p, r) for r in prefixes) or bool(LIBRARY.search(p))

    def read_ok(p):
        if inside(p, fixture) or declared(p):
            return True
        if not (any(inside(p, r) for r in roots) or any(inside(p, r) for r in prefixes)):
            return False
        if p.endswith(CODE_EXT) or os.path.isdir(p):
            return True  # 代码文件；目录只列文件名
        # 加载段只放行解释器与库目录里的数据（标准库、site-packages）；仓库自己的数据文件要声明
        return state['phase'] == 'LOAD' and in_library(p)

    def hook(event, args):
        if event == 'open':
            path, mode = args[0], args[1]
            if isinstance(path, int) or path is None:
                return
            p = real(os.fsdecode(path))
            writing = isinstance(mode, str) and any(c in mode for c in 'wax+')
            flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND):
                writing = True
            if writing:
                deny('FS_WRITE', display(p))
            if not read_ok(p):
                deny('FS_READ', display(p))
            if state['phase'] == 'LOAD' and not inside(p, fixture) and not p.endswith(CODE_EXT) and any(inside(p, r) for r in roots):
                state['load_reads'].append(display(p))
        elif event in ('os.listdir', 'os.scandir'):
            target = args[0] if args and args[0] is not None else '.'
            if isinstance(target, int):
                return
            p = real(os.fsdecode(target))
            if not read_ok(p):
                deny('FS_READ', display(p))
        elif event in ('os.remove', 'os.rename', 'os.mkdir', 'os.rmdir', 'os.truncate', 'os.chmod', 'os.symlink', 'os.link', 'shutil.copyfile', 'shutil.rmtree'):
            deny('FS_WRITE', event)
        elif event in ('socket.connect', 'socket.bind', 'socket.sendto', 'socket.sendmsg'):
            addr = args[1] if len(args) > 1 else None
            target = ('unix:' + os.path.basename(addr)) if isinstance(addr, str) else ('%s:%s' % tuple(addr[:2]) if isinstance(addr, tuple) and len(addr) >= 2 else str(addr))
            deny('NET_CONNECT', target)
        elif event in ('socket.getaddrinfo', 'socket.gethostbyname', 'socket.gethostbyaddr', 'socket.gethostbyname_ex'):
            deny('NET_DNS', str(args[0]) if args else '')
        elif event in ('urllib.Request', 'http.client.connect', 'ftplib.connect', 'smtplib.connect', 'poplib.connect', 'imaplib.open', 'nntplib.connect', 'telnetlib.Telnet.open'):
            deny('NET_HTTP', str(args[0]) if args else event)
        elif event in ('subprocess.Popen', 'os.system', 'os.exec', 'os.spawn', 'os.posix_spawn', 'os.fork', 'os.forkpty', 'os.startfile', 'pty.spawn'):
            deny('PROCESS', event)
        elif event == 'sqlite3.connect':
            deny('DB', 'sqlite3')
        elif event == 'ctypes.dlopen' and state['phase'] == 'CALL':
            deny('NATIVE_ADDON', str(args[0]) if args else '')

    return state, hook


def canon(v):
    if v is None:
        return 'n'
    if isinstance(v, bool):
        return 'b:1' if v else 'b:0'
    mod = type(v).__module__
    if mod.startswith('numpy') and hasattr(v, 'item') and getattr(v, 'ndim', 0) == 0:
        return canon(v.item())
    if isinstance(v, int):
        return 'i:%d' % v
    if isinstance(v, float):
        return 'd:' + struct.pack('>d', v).hex()
    if isinstance(v, str):
        return 's:' + json.dumps(v)
    if isinstance(v, (list, tuple)):
        return '[' + ','.join(canon(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(sorted(canon(k) + ':' + canon(x) for k, x in v.items())) + '}'
    if mod.startswith('pandas') and type(v).__name__ == 'DataFrame':
        return canon(v.to_dict('records'))
    if hasattr(v, 'tolist'):
        return canon(v.tolist())
    if hasattr(v, 'isoformat'):
        return 't:' + v.isoformat()
    raise TypeError('UNSUPPORTED_OUTPUT_TYPE:%s' % type(v).__name__)


def select(value, dotted):
    if not dotted:
        return value
    for k in str(dotted).split('.'):
        if value is None:
            return None
        value = value[k] if isinstance(value, dict) else getattr(value, k)
    return value


def as_list(value):
    if type(value).__name__ == 'DataFrame':
        return value.to_dict('records')
    if hasattr(value, 'tolist') and not isinstance(value, (list, tuple)):
        return value.tolist()
    if isinstance(value, (list, tuple)):
        return list(value)
    raise TypeError('OUTPUT_NOT_ARRAY')


def shape(result, output):
    value = as_list(select(result, output.get('select')))
    if output['align'] == 'ALIGNED':
        return {'kind': 'ALIGNED', 'values': [canon(x) for x in value]}
    keys = output.get('key_fields') or []
    rows = []
    for rec in value:
        t = rec.get(output['time_field']) if isinstance(rec, dict) else None
        if hasattr(t, 'isoformat'):
            t = t.isoformat()
        rows.append([canon([rec.get(k) for k in keys]) if isinstance(rec, dict) else 'n', t, canon(rec)])
    return {'kind': 'KEYED', 'rows': rows}


def frame(rows, kind):
    if kind == 'pandas':
        import pandas
        return pandas.DataFrame.from_records(rows)
    return rows


def main():
    lines = [json.loads(l) for l in sys.stdin.read().split('\n') if l.strip()]
    init = lines.pop(0)
    state, hook = make_sandbox(init['fixture_dir'], init['code_roots'], init.get('static_reads') or [])
    sys.stdout = sys.stderr  # 被测函数的输出改走 stderr
    sys.dont_write_bytecode = True  # 不写 __pycache__（沙箱不许写文件）
    for root in reversed(init['code_roots']):
        sys.path.insert(0, root)
    frames = {name: kind for name, kind in (init.get('frames') or {}).items()}
    if 'pandas' in frames.values():
        import pandas  # noqa: F401  加载阶段先导入，调用阶段不再读库文件
    sys.addaudithook(hook)
    here = os.path.dirname(os.path.realpath(__file__))
    roots = [os.path.realpath(r) for r in init['code_roots']]

    def purgeable(mod):
        f = getattr(mod, '__file__', None)
        if not f:
            return False
        f = os.path.realpath(f)
        return not f.startswith(here + os.sep) and any(f == r or f.startswith(r + os.sep) for r in roots)

    def load():
        """MODULE_RELOAD：每次调用前清掉代码根下已导入的模块，再重新执行被测模块（加载阶段的规则）。"""
        import importlib.util
        state['phase'] = 'LOAD'
        for name in [n for n, m in list(sys.modules.items()) if m is not None and purgeable(m)]:
            del sys.modules[name]
        path = os.path.join(init['code_root'], init['path'])
        spec = importlib.util.spec_from_file_location('causality_target', path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        f = select(mod, init['entry'])
        if not callable(f):
            raise TypeError('ENTRY_NOT_FUNCTION:' + init['entry'])
        state['phase'] = 'CALL'
        return f

    try:
        fn = load()
    except BaseException as e:  # noqa: BLE001
        emit({'id': 'init', 'ok': False, 'error': str(e)[:300], 'attempts': state['attempts'][:], 'load_reads': sorted(set(state['load_reads']))})
        return
    emit({'id': 'init', 'ok': True, 'attempts': state['attempts'][:], 'load_reads': sorted(set(state['load_reads'])),
          'runtime': {'python': sys.version.split()[0], 'audit_hook': True}})
    del state['attempts'][:]
    call = init.get('call') or {}
    ats = call.get('at') or []
    ats = ats if isinstance(ats, list) else [ats]
    output = init['output']
    first = True
    for job in lines:
        try:
            if not first:
                fn = load()
            first = False
            inputs = {k: frame(v, frames.get(k, 'records')) for k, v in job['inputs'].items()}
            if call.get('style') == 'object':
                base_args, kwargs = [], dict(inputs, **(call.get('params') or {}))
            else:
                order = call.get('order') or list(inputs.keys())
                base_args, kwargs = [inputs[k] for k in order] + list(call.get('params') or []), {}
            if output['align'] == 'AT_POINT':
                rows = job['inputs'][output['to']]
                values = []
                for i in range(len(rows)):
                    args = list(base_args)
                    for at in ats:
                        v = i if at['value'] == 'INDEX' else rows[i][at['field']]
                        if at.get('key'):
                            args[at['position']] = dict(args[at['position']] or {}, **{at['key']: v})
                        else:
                            args.insert(at['position'], v)
                    try:
                        values.append(canon(select(fn(*args, **kwargs), output.get('select'))))
                    except Denied:
                        raise
                    except Exception as e:  # noqa: BLE001  某个点抛错也是这个点的读数
                        values.append('x:' + json.dumps('%s: %s' % (type(e).__name__, e)))
                out = {'kind': 'ALIGNED', 'values': values}
            else:
                out = shape(fn(*base_args, **kwargs), output)
            emit({'id': job['id'], 'ok': True, 'out': out, 'attempts': state['attempts'][:]})
        except BaseException as e:  # noqa: BLE001
            emit({'id': job['id'], 'ok': False, 'error': ('%s: %s' % (type(e).__name__, e))[:300], 'attempts': state['attempts'][:]})
        del state['attempts'][:]

if __name__ == '__main__':
    main()
