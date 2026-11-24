"""Pure, self-contained HTML renderer for PROGRESS_REGISTRY_V1."""

from __future__ import annotations

import html
import json


STATE_ZH = {
    "OK": "正常", "ZERO": "0 条（来源可读）", "STALE": "过期",
    "MISSING": "缺失", "UNKNOWN": "未知", "NOT_APPLICABLE": "不适用",
}


def _e(value):
    return html.escape(str(value), quote=True)


def _json(value):
    return _e(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _render_plan(data):
    parts = ['<p class="freeze-note">11-25 冻结，之后不再更新</p>']
    for name in ("workplan", "focus", "milestones"):
        groups = {}
        for row in data.get(name, []):
            groups.setdefault(str(row.get("track", row.get("area", "未分组"))), []).append(row)
        if not groups:
            continue
        parts.append(f"<h3>{_e(name)}</h3>")
        for track in sorted(groups):
            parts.append(f"<h4>{_e(track)}</h4><ul>")
            for row in groups[track]:
                label = row.get("name", row.get("item", row.get("what", row.get("key", ""))))
                parts.append(f'<li><span class="record-state">{_e(row.get("state", row.get("status", "")))}</span> {_e(label)}</li>')
            parts.append("</ul>")
    return "".join(parts)


def _render_data(row):
    data = row.get("data")
    if data is None:
        if row.get("key") == "S8_NOT_IN_SCOPE":
            items = (
                ("HK 研究队列状态", "现有 HK 告警与 #133 research-web 导出"),
                ("T3 影子 S 周任务（HK）", "现有 HK 告警与 #133 research-web 导出"),
                ("U11 前向采集（HK）", "现有 HK 告警与 #133 research-web 导出"),
                ("V6 每日运行", "现有 alert-checks 飞书告警"),
                ("C3 FWD 前向车道", "现有 HK 告警"),
                ("试验台账 N", "QRP trial-ledger"),
            )
            return "<ul>" + "".join(f"<li>{_e(name)}：NOT_APPLICABLE / NOT_IN_V1_SCOPE；{_e(where)}</li>" for name, where in items) + "</ul>"
        return ""
    if row.get("key") == "S7_PLAN_SNAPSHOT":
        body = _render_plan(data)
    else:
        body = f'<pre class="values">{_json(data)}</pre>'
    if row.get("state") == "STALE":
        body = '<div class="stale-values"><strong>过期：所有数值均为过期值</strong>' + body + '<span class="stale-mark">过期</span></div>'
    if row.get("key") == "S9_MASTER_TABLE":
        code = ((data.get("run_status") or {}).get("code") or "")
        if code.startswith("FROZEN_") or code.startswith("ROW_REGISTRY_UNVERIFIABLE"):
            body = f'<p class="critical-code">{_e(code)}</p>' + body
    return body


def render(reg: dict) -> str:
    generated = _e(reg.get("generated_at", "UNKNOWN"))
    threshold = reg.get("stale_banner_after_h", 3)
    sections = []
    for row in reg.get("sections", []):
        state = row.get("state", "UNKNOWN")
        reason = row.get("reason")
        reason_html = f'<code class="reason">{_e(reason)}</code>' if reason else ""
        age = (row.get("freshness") or {}).get("age_h")
        stale = f'<p class="section-warning">过期：as_of = {_e(row.get("as_of"))}，已 {_e(round(age, 2) if isinstance(age, (int, float)) else "未知")} 小时</p>' if state == "STALE" else ""
        sections.append(
            f'<section id="{_e(row.get("key"))}" data-state="{_e(state)}">'
            f'<header><h2>{_e(row.get("title_zh", row.get("key")))}</h2>'
            f'<span class="badge">{_e(STATE_ZH.get(state, state))}</span>{reason_html}</header>'
            f'{stale}{_render_data(row)}</section>'
        )
    counts = " ".join(f"{_e(k)}={_e(v)}" for k, v in (reg.get("sections_by_state") or {}).items())
    page_age = reg.get("page_age_h")
    page_age_state = reg.get("page_age_state")
    page_age_reason = reg.get("page_age_reason")
    if (
        page_age_state == "OK"
        and isinstance(page_age, (int, float))
        and not isinstance(page_age, bool)
        and page_age > threshold
    ):
        server_banner = '<div id="server-stale" class="global-warning">本页生成登记已标记过期，以下内容可能全部过期</div>'
    elif page_age_state == "MISSING":
        server_banner = f'<div id="server-age-missing" class="global-warning">页面生成时间缺失，无法判断页面时效 <code>{_e(page_age_reason)}</code></div>'
    elif page_age_state != "OK":
        server_banner = f'<div id="server-age-unknown" class="global-warning">页面生成时间无效，无法判断页面时效 <code>{_e(page_age_reason)}</code></div>'
    else:
        server_banner = ""
    script_time = json.dumps(str(reg.get("generated_at", ""))).replace("<", "\\u003c")
    script = f"""<script>
(() => {{
  const generated_at = {script_time};
  const stale_banner_after_h = {json.dumps(threshold)};
  const ageHours = (Date.now() - Date.parse(generated_at)) / 3600000;
  if (Number.isFinite(ageHours) && ageHours > stale_banner_after_h) {{
    const banner = document.getElementById('client-stale');
    banner.hidden = false;
    banner.textContent = `本页 ${{ageHours.toFixed(1)}} 小时未更新，以下内容可能全部过期`;
  }}
}})();
</script>"""
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="progress-page" content="PROGRESS_REGISTRY_V1"><title>运行态向前验证进度</title>
<style>
:root{{--bg:#f5f7fb;--card:#fff;--fg:#172033;--muted:#697386;--border:#d9deea;--ok:#18794e;--zero:#697386;--stale:#a15c00;--bad:#b42318}}
@media(prefers-color-scheme:dark){{:root{{--bg:#10131a;--card:#1b202b;--fg:#edf1f7;--muted:#a9b2c3;--border:#394253;--ok:#61d6a1;--zero:#a9b2c3;--stale:#ffbd66;--bad:#ff8d86}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}}main{{max-width:960px;margin:auto;padding:20px}}h1{{font-size:clamp(24px,6vw,38px);margin-bottom:4px}}.meta{{color:var(--muted);overflow-wrap:anywhere}}section{{background:var(--card);border:1px solid var(--border);border-left:6px solid var(--zero);border-radius:10px;margin:14px 0;padding:14px;overflow:hidden}}section[data-state="OK"]{{border-left-color:var(--ok)}}section[data-state="STALE"]{{border-left-color:var(--stale)}}section[data-state="MISSING"],section[data-state="UNKNOWN"]{{border-left-color:var(--bad)}}header{{display:flex;gap:9px;align-items:center;flex-wrap:wrap}}h2{{font-size:18px;margin:0 auto 0 0}}.badge,.reason{{padding:2px 7px;border-radius:6px;background:var(--bg)}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}}.global-warning,.section-warning,.critical-code{{background:#fff0c2;color:#5d3b00;padding:10px;border-radius:7px}}.critical-code{{background:#fee4e2;color:#7a271a}}.stale-mark{{display:inline-block;margin-top:6px;color:var(--stale);font-weight:700}}@media(max-width:375px){{main{{padding:10px}}section{{padding:10px}}}}
</style></head><body><main><h1>运行态向前验证进度</h1>
<p class="meta">生成：{generated} · 提交：{_e((reg.get('generator') or {}).get('commit'))} · 登记表：{_e(str(reg.get('registry_sha256',''))[:12])}</p>
<p class="meta">{counts}</p>{server_banner}<div id="client-stale" class="global-warning" hidden></div>{''.join(sections)}</main>{script}</body></html>"""
