"""合成夹具（修订草稿 §3.3「必须失败的夹具」）的 Python 写法，与 ../node/features.js 一一对应。只用合成数据（../data）。"""
import json
import math
import os
import socket

HERE = os.path.dirname(os.path.abspath(__file__))


def _sign(x):
    return (x > 0) - (x < 0)


# ── T-C1：草稿点名的两个必须失败的夹具 ─────────────────────────────────────────

def participation_full_day(minutes):
    """红：当日累计成交量 / 当日全天成交量（全天分母）。"""
    total = {}
    for m in minutes:
        total[m['day']] = total.get(m['day'], 0) + m['volume']
    cum, out = {}, []
    for m in minutes:
        cum[m['day']] = cum.get(m['day'], 0) + m['volume']
        out.append(cum[m['day']] / total[m['day']])
    return out


def participation_prior_days(minutes):
    """绿：当日累计成交量 / 前 3 个已收完交易日的平均全天量。"""
    done, day, cum, out = [], None, 0, []
    for m in minutes:
        if m['day'] != day:
            if day is not None:
                done.append(cum)
            day, cum = m['day'], 0
        cum += m['volume']
        prev = done[-3:]
        out.append(None if len(prev) < 3 else cum / (sum(prev) / 3))
    return out


def fractal_at_peak(bars):
    """红：顶分型记在顶那根上，要靠下一根确认。"""
    n = len(bars)
    return [0 < i < n - 1 and b['high'] > bars[i - 1]['high'] and b['high'] > bars[i + 1]['high'] for i, b in enumerate(bars)]


def fractal_at_confirmation(bars):
    """绿：同一个分型，记在确认它的那根上。"""
    return [i > 1 and bars[i - 1]['high'] > bars[i - 2]['high'] and bars[i - 1]['high'] > b['high'] for i, b in enumerate(bars)]


# ── T-C2 ────────────────────────────────────────────────────────────────────────

def next_bar_direction_with_fallback(bars):
    """红：下一根的方向；最后一根退回本根阴阳。"""
    n = len(bars)
    return [_sign(bars[i + 1]['close'] - b['close']) if i + 1 < n else _sign(b['close'] - b['open']) for i, b in enumerate(bars)]


def prior_bar_direction(bars):
    """绿：上一根到这一根的方向。"""
    return [_sign(b['close'] - bars[i - 1]['close']) if i > 0 else _sign(b['close'] - b['open']) for i, b in enumerate(bars)]


# ── T-C3 ────────────────────────────────────────────────────────────────────────

def _expanding_mean(bars):
    s, out = 0.0, []
    for i, b in enumerate(bars):
        s += b['close']
        out.append(s / (i + 1))
    return out


def expanding_mean_with_cache(bars):
    """红：先试夹具目录外的缓存与数据库端口，吞掉错误再退回只用给定输入。"""
    try:
        with open(os.path.join(HERE, '..', 'outside', 'full_history.json')) as f:
            json.load(f)
    except Exception:  # noqa: BLE001
        pass
    try:
        socket.create_connection(('127.0.0.1', 5432), timeout=0.05).close()
    except Exception:  # noqa: BLE001
        pass
    return _expanding_mean(bars)


def expanding_mean_fixture_params(bars):
    """绿：从夹具目录读一个静态参数（允许）。"""
    with open(os.path.join(HERE, '..', 'data', 'params.json')) as f:
        scale = json.load(f)['scale']
    return [v * scale for v in _expanding_mean(bars)]


# ── 逐时点与面板 ────────────────────────────────────────────────────────────────

def centered_mean_at(bars, t):
    """红：居中 5 日均线。"""
    w = bars[max(0, t - 2):t + 3]
    return sum(b['close'] for b in w) / len(w)


def trailing_mean_at(bars, t):
    """绿：截至 t 的 5 日均线。"""
    w = bars[max(0, t - 4):t + 1]
    return sum(b['close'] for b in w) / len(w)


def _rank_within(panel, score):
    by_date = {}
    for r in panel:
        by_date.setdefault(r['date'], []).append((r['code'], score(r)))
    out = []
    for date, rows in by_date.items():
        rows.sort(key=lambda x: (-x[1], x[0]))
        out.extend({'date': date, 'code': c, 'rank': i + 1} for i, (c, _) in enumerate(rows))
    return out


def rank_by_full_sample_z(panel):
    """红：用全样本均值归一化后排序。"""
    tot, cnt = {}, {}
    for r in panel:
        tot[r['code']] = tot.get(r['code'], 0) + r['close']
        cnt[r['code']] = cnt.get(r['code'], 0) + 1
    return _rank_within(panel, lambda r: r['close'] / (tot[r['code']] / cnt[r['code']]))


def rank_by_daily_return(panel):
    """绿：按当日相对前一日的涨幅排序。"""
    last = {}

    def score(r):
        p = last.get(r['code'])
        last[r['code']] = r['close']
        return r['close'] / p - 1 if p else 0.0
    return _rank_within(panel, score)


def rolling_std_pandas(bars):
    """绿（pandas 输入）：5 日滚动标准差，用 DataFrame 进、Series 出。"""
    s = bars['close'].rolling(5, min_periods=2).std()
    return s.where(s.notna(), None).astype(object)


def centered_rolling_pandas(bars):
    """红（pandas 输入）：居中滚动均值。"""
    return bars['close'].rolling(5, center=True, min_periods=1).mean()


# ── 隔离：跨调用的缓存 ──────────────────────────────────────────────────────────

_MEMO = {}


def memo_centered_mean(bars):
    """红（隔离）：居中 5 日均线，按日期记在模块里。各次调用若共用模块状态，T-C1 就看不出。"""
    out = []
    for i, b in enumerate(bars):
        if b['date'] not in _MEMO:
            w = bars[max(0, i - 2):i + 3]
            _MEMO[b['date']] = sum(x['close'] for x in w) / len(w)
        out.append(_MEMO[b['date']])
    return out


_ = math
