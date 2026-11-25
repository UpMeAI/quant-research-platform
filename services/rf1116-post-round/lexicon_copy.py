"""Literal Python copy of the three frozen RQ agent wording lexicons.

The lists intentionally keep the display terms in the same order as
services/research-queue-agent/lexicon.js.  Package-B tests compare them to the
JavaScript source so a lexicon change cannot silently diverge.
"""
import re


PREDICTION_TERMS = [
    "会涨", "会跌", "上涨概率", "目标价", "预计", "看多", "看空",
    "will rise", "expect", "probability", "target", "forecast", "outperform",
]
VERDICT_TERMS = ["不做", "结论做", "建议上线", "应当采用", "买入", "卖出", "加仓", "减仓", "adopt"]
DIRECTION_TERMS = ["做多", "做空", "看涨", "看跌", "bullish", "bearish", "go long"]

_PATTERNS = [
    r"会涨", r"会跌", r"上涨概率", r"目标价", r"预计", r"看多", r"看空",
    r"\bwill\s+(?:rise|fall)\b", r"\bexpect(?:s|ed|ing)?\b", r"\bprobabilit(?:y|ies)\b",
    r"\btarget\b", r"\bforecast\w*", r"\boutperform\w*",
    r"不做", r"(?:结论|判断|裁决|判定|verdict)\s*[:：]\s*做", r"建议上线", r"应当采用",
    r"买入", r"卖出", r"加仓", r"减仓", r"\badopt\b",
    r"做多", r"做空", r"看涨", r"看跌", r"\bbullish\b", r"\bbearish\b", r"\bgo(?:ing)?\s+(?:long|short)\b",
]


def has_forbidden_wording(text):
    if not isinstance(text, str):
        return False
    return any(re.search(pattern, text, re.I) for pattern in _PATTERNS)
