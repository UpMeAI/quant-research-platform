"""Producer: admission under frozen templates, inbox intake for NET kinds, re-evaluation of waiting tasks."""
import dataclasses
import datetime as dt
import json
import os
import pathlib
import re

from . import core, guard, packshape, templates as T

# Only external waits that depend on facts outside the queue. There is no cost-cap wait (★RQ4).
EXTERNAL_CODES = ("MECHANISM_REVIEW", "HOLDOUT_INCOMPLETE", "DATA_DATE", "SERIES_MISSING", "US_PIT_SOURCE", "MARKET_PAUSED",
                  "PREREG_REFUSED", "TRL_RECEIPT", "MECHANISM_ADMISSION")
MARKET_AGENT_HOST = {"CN_A": "LINUX", "US_EQUITY": "HK", "CRYPTO": "HK"}
CARD_KIND = "AI_REVIEW_CARD"
FACT_PACK_SCHEMA = packshape.SCHEMA
LAB_FEEDBACK_SCHEMA = "LAB_FEEDBACK_FACTS_V1"
HK_FORBIDDEN_ARGV = ("export-crypto-desk.js", "smartflow", "127.0.0.1:3306", "localhost:3306", "mysql")
QUOTA_PROBE_S = 6 * 3600
PROVIDER_PROBE_S = 3600
REQUEST_KEYS = ("template_id", "template_sha256", "market", "kind", "subject", "params", "inputs", "depends_on", "not_before", "priority",
                "trl_ids", "trl_ledger_snapshot_sha256", "argv")


@dataclasses.dataclass
class AdmitResult:
    task_id: str
    state: str
    code: str
    created: bool


class NullProbes:
    """Default probes: nothing is known, so waiting tasks keep waiting until the coordinator or a real probe says otherwise."""
    def balance_ok(self): return None
    def credential_fingerprint(self, key_id): return None
    def provider_ok(self): return None
    def external(self, code, task): return None


def _canon_request(request):
    r = {k: request.get(k) for k in REQUEST_KEYS if k != "argv"}
    r["subject"] = request.get("subject") or {}
    r["params"] = request.get("params") or {}
    r["inputs"] = request.get("inputs") or []
    r["depends_on"] = request.get("depends_on") or []
    return r


def _refuse(conn, cfg, request, now, code):
    now = now.astimezone(core.CST)
    base = core.canonical({"template_id": request.get("template_id"), "template_sha256": request.get("template_sha256"),
                           "subject": request.get("subject") or {}, "params": request.get("params") or {}})
    idem = core.sha256_hex(base + "|refused|" + code)
    host = cfg.host
    row = dict(task_id="RQT-%s-%s-%s" % (host, now.strftime("%Y%m%d"), idem[:8]), idem_key=idem, host=host, agent_host=host, kind=str(request.get("kind") or "UNKNOWN"),
               market=request.get("market") if request.get("market") in T.MARKETS else "NONE", template_id=str(request.get("template_id")),
               template_sha256=str(request.get("template_sha256")), evidence_matrix_sha256="", admission_json=core.canonical({"request": _canon_request(request), "refused": code}),
               admission_sha256=core.sha256_hex(core.canonical(_canon_request(request))), weight_class="W0", io_class="NONE", depends_on="[]", state="REFUSED_ADMISSION",
               state_reason=code, not_before=None, transient_budget=0, priority=int(request.get("priority") or 50))
    created = core.insert_task(conn, row, now)
    return AdmitResult(row["task_id"], "REFUSED_ADMISSION", code, created)


def admit(conn, cfg, registry, request, now, extra_input_prefixes=()):
    now = now.astimezone(core.CST)
    """Admit one request under a frozen template. Same key + same admission -> same task; same key + other admission -> IDEM_CONFLICT."""
    tpl_id, tpl_sha = request.get("template_id"), request.get("template_sha256")
    subject, params = request.get("subject") or {}, request.get("params") or {}
    idem = core.sha256_hex(core.canonical({"template_id": tpl_id, "template_sha256": tpl_sha, "subject": subject, "params": params}))
    req_sha = core.sha256_hex(core.canonical(_canon_request(request)))
    ex = conn.execute("select task_id, state, admission_json from task where idem_key=?", (idem,)).fetchone()
    if ex:
        if core.sha256_hex(core.canonical(json.loads(ex[2])["request"])) != req_sha:
            return AdmitResult(ex[0], ex[1], "IDEM_CONFLICT", False)
        return AdmitResult(ex[0], ex[1], "", False)

    t = registry.get(tpl_id)
    if t is None or tpl_sha != T.template_sha256(t) or not registry.is_frozen(t):
        return _refuse(conn, cfg, request, now, "TEMPLATE_NOT_FROZEN")
    market = request.get("market") or "NONE"
    if market not in T.MARKETS:
        return _refuse(conn, cfg, request, now, "MARKET_UNKNOWN")
    if T.validate_template(t):
        return _refuse(conn, cfg, request, now, "TEMPLATE_INVALID")
    net = t["weight_class"] == "NET"
    if cfg.host == "HK" and (not net or "HK_EXTRACT" in t["kinds"] or t["io_class"] != "NONE"):
        return _refuse(conn, cfg, request, now, "HK_COMPUTE_FORBIDDEN")
    agent = MARKET_AGENT_HOST.get(market) if t["agent_host"] == "BY_MARKET" else t["agent_host"]
    if agent is None:
        agent = cfg.host
    if (market == "CN_A" and agent != "LINUX") or (market in ("US_EQUITY", "CRYPTO") and net and agent != "HK") \
            or (t["agent_host"] == "BY_MARKET" and agent != MARKET_AGENT_HOST.get(market, agent)):
        return _refuse(conn, cfg, request, now, "AGENT_HOST_MISMATCH")
    run_host = agent if t["run_host"] == "BY_MARKET" else t["run_host"]
    producer = agent if t["producer_host"] == "BY_MARKET" else t["producer_host"]
    if producer != cfg.host or (net and agent != cfg.host) or (not net and run_host != cfg.host):
        code = "AGENT_HOST_MISMATCH" if t["agent_host"] == "BY_MARKET" else "HOST_ROUTE_REFUSED"
        return _refuse(conn, cfg, request, now, code)
    if market not in t["markets"]:
        return _refuse(conn, cfg, request, now, "MARKET_NOT_IN_TEMPLATE")
    if set(params) != set(t["params"]) or not all(re.fullmatch(t["params"][k], str(params[k])) for k in t["params"]):
        return _refuse(conn, cfg, request, now, "PARAM_NOT_ALLOWED")
    argv = T.render_argv(t["argv"], params)
    recovery = T.render_argv(t["recovery_argv"], params) if t.get("recovery_argv") else None
    if request.get("argv") is not None and request["argv"] != argv:
        return _refuse(conn, cfg, request, now, "ARGV_NOT_ALLOWED")
    if cfg.host == "HK":
        for a in argv + (recovery or []):
            if any(tok in a for tok in HK_FORBIDDEN_ARGV) or (re.search(r"://", a) and not re.match(r"[a-z]+://(127\.0\.0\.1|localhost)(:|/|$)", a)):
                return _refuse(conn, cfg, request, now, "HK_FORBIDDEN_ARGV")
    prefixes = [p.replace("{inbox}", str(cfg.inbox_dir)) for i in t["inputs"] for p in [i["prefix"]]] + [str(p) for p in extra_input_prefixes]
    for inp in request.get("inputs") or []:
        try:
            guard.check_path(inp.get("path", ""))
        except guard.PathForbidden:
            return _refuse(conn, cfg, request, now, "PATH_FORBIDDEN")
        pth = os.path.normpath(str(inp.get("path", "")))
        if not any(pth == q or pth.startswith(q.rstrip("/") + "/") for q in prefixes):
            return _refuse(conn, cfg, request, now, "INPUT_NOT_ALLOWED")
        f = pathlib.Path(pth)
        if not f.is_file():
            return _refuse(conn, cfg, request, now, "INPUT_MISSING")
        if core.sha256_hex(f.read_bytes()) != inp.get("sha256"):
            return _refuse(conn, cfg, request, now, "INPUT_SHA_MISMATCH")
    if t["requires_trl"] and not (request.get("trl_ids") and request.get("trl_ledger_snapshot_sha256")):
        return _refuse(conn, cfg, request, now, "TRL_MISSING")
    kind = request.get("kind") or t["kinds"][0]
    if kind not in t["kinds"]:
        return _refuse(conn, cfg, request, now, "KIND_NOT_IN_TEMPLATE")
    derived = {"argv": argv, "recovery_argv": recovery, "recovery_max": t.get("recovery_max", t["transient_budget"]), "idempotent": t["idempotent"],
               "completion": t["completion"], "outputs": t["outputs"], "prompt_admission_sha256": t.get("prompt_admission_sha256"),
               "agent_host": agent, "run_host": run_host}
    adm = {"request": _canon_request(request), "derived": derived}
    row = dict(task_id="RQT-%s-%s-%s" % (cfg.host, now.strftime("%Y%m%d"), idem[:8]), idem_key=idem, host=run_host, agent_host=agent, kind=kind, market=market,
               template_id=tpl_id, template_sha256=tpl_sha, evidence_matrix_sha256=t["evidence_matrix"]["sha256"], admission_json=core.canonical(adm),
               admission_sha256=core.sha256_hex(core.canonical(adm)), weight_class=t["weight_class"], io_class=t["io_class"],
               depends_on=core.canonical(request.get("depends_on") or []), state="READY", state_reason=None, not_before=request.get("not_before"),
               transient_budget=t["transient_budget"], priority=int(request.get("priority") if request.get("priority") is not None else 50))
    created = core.insert_task(conn, row, now)
    return AdmitResult(row["task_id"], "READY", "", created)


def _load_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return None


def card_template(registry, cfg, market):
    """The card template for a fact pack: kind AI_REVIEW_CARD, the pack's market, preferring the one that runs on this host.
    Host and market routing itself stays in admit(); with no template for the market the pack is skipped, with a wrong-host one it is refused there."""
    found = [t for t in registry.templates if CARD_KIND in t["kinds"] and market in t["markets"]]
    found.sort(key=lambda t: (t["agent_host"] not in (cfg.host, "BY_MARKET"), t["template_id"]))
    return found[0] if found else None


REVISION_SKIPPED = "REVISION_OF_CARDED_WEEK"
TERMINAL_FAILURE = ("BLOCKED_DETERMINISTIC", "FAILED")   # and every REFUSED_*: a card task in one of these never delivered its idea ids


def _is_failure(state):
    return state in TERMINAL_FAILURE or str(state).startswith("REFUSED_")


def _card_tasks(conn, market, week):
    """The card tasks of a (market, week), any state: [(task_id, state, name of the pack file it was admitted from)], read from the admitted request (subject.week, subject.fact_pack_sha256, inputs)."""
    out = []
    for task_id, state, adm in conn.execute("select task_id, state, admission_json from task where market=? order by rowid", (market,)).fetchall():
        try:
            req = json.loads(adm)["request"]
            subject, inputs = req.get("subject") or {}, req.get("inputs") or []
            if subject.get("week") == week and "fact_pack_sha256" in subject and inputs:
                out.append((task_id, state, pathlib.Path(inputs[0]["path"]).name))
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    return out


def _holding_card(conn, pack, name):
    """plan-coord ruling 11-23 13:35 (M6): ONE card task per (market, weekId), the first admitted pack wins. The task id of a card task of this pack's market and week that was admitted from
    ANOTHER pack file and is in any state but a terminal failure, else None (the pack has its own task, or none holds the week). Re-evaluated every tick: a card that fails later frees the week."""
    tasks = _card_tasks(conn, pack["market"], packshape.week_of(pack))
    if any(n == name for _, _, n in tasks):
        return None
    live = [t for t, s, _ in tasks if not _is_failure(s)]
    return live[0] if live else None


def merge_lab_feedback(pack, feedbacks):
    """W24 (plan-coord ruling 11-23 (6)): add the AI Quant Research Lab's feedback facts (LAB_FEEDBACK_FACTS_V1) to a REVIEW_AI_FACT_PACK_V1, with ids of their own
    after the pack's. Only files of the pack's market; a fact already cited (same source sha256) is not added twice; deterministic order; the input is not modified."""
    out = json.loads(json.dumps(pack))
    facts = out.setdefault("facts", [])
    known = {(f.get("source") or {}).get("sha256") for f in facts if isinstance(f, dict)}
    top = 0
    for f in facts:
        m = re.fullmatch(r"F-(\d+)", str(f.get("id", ""))) if isinstance(f, dict) else None
        top = max(top, int(m.group(1)) if m else 0)
    docs = [d for d in feedbacks if isinstance(d, dict) and d.get("schema") == LAB_FEEDBACK_SCHEMA and d.get("market") == out.get("market") and isinstance(d.get("facts"), list)]
    for d in sorted(docs, key=lambda x: json.dumps(x, sort_keys=True)):
        for f in d["facts"]:
            sha_ = (f.get("source") or {}).get("sha256") if isinstance(f, dict) else None
            if not sha_ or sha_ in known:
                continue
            top += 1
            facts.append(dict({"id": "F-%03d" % top}, **f))
            known.add(sha_)
    return out


def _fact_pack_request(registry, cfg, path, pack):
    t = card_template(registry, cfg, pack["market"])
    if not t:
        return None
    raw = pathlib.Path(path).read_bytes()
    return {"template_id": t["template_id"], "template_sha256": T.template_sha256(t), "market": pack["market"],
            "subject": {"week": packshape.week_of(pack), "market": pack["market"], "fact_pack_sha256": core.sha256_hex(raw),
                        "prompt_admission_sha256": t.get("prompt_admission_sha256")},
            "params": {}, "inputs": [{"path": str(path), "sha256": core.sha256_hex(raw)}], "depends_on": [], "priority": 50}


def tick(conn, cfg, registry, now, probes=None):
    probes = probes or NullProbes()
    out = {"admitted": 0, "refused": 0, "unreadable": 0, "resumed": []}

    def count(r):
        if r.created and r.state == "READY":
            out["admitted"] += 1
        elif r.created:
            out["refused"] += 1

    d = cfg.inbox_dir / "requests"
    for f in sorted(d.glob("*.json")) if d.is_dir() else []:
        req = _load_json(f)
        if not isinstance(req, dict) or "template_id" not in req:
            out["unreadable"] += 1
            continue
        count(admit(conn, cfg, registry, req, now))
    d = cfg.inbox_dir / "fact-packs"
    lab_dir = cfg.inbox_dir / "lab-feedback"
    lab = [x for x in (_load_json(p) for p in sorted(lab_dir.glob("*.json"))) if x] if lab_dir.is_dir() else []
    merged_dir = cfg.inbox_dir / "fact-packs-merged"
    state_file = cfg.inbox_dir / "lab-feedback-state.json"
    state = _load_json(state_file) or {}
    state.setdefault("packs", {})
    state_dirty = False
    skipped = []
    for f in sorted(d.glob("*.json")) if d.is_dir() else []:
        pack = _load_json(f)
        if not (packshape.schema_ok(pack) and packshape.week_of(pack) and pack.get("market")):
            out["unreadable"] += 1
            continue
        held_by = _holding_card(conn, pack, f.name)
        if held_by:  # a revision of a carded week: no second task, no lab feedback taken; the relay still ships it and W05 still marks it
            skipped.append({"pack": f.name, "sha256": core.sha256_hex(f.read_bytes()), "week": packshape.week_of(pack), "market": pack["market"], "of_task": held_by, "reason": REVISION_SKIPPED})
            continue
        # W24 (plan-coord 11-23 (5)): a pack takes the lab feedback that exists the first time the producer sees it and keeps exactly that set. Feedback arriving later is never added to a
        # pack already seen (no second card task for an admitted week); it joins the next pack that has not been seen yet. A fact is delivered once.
        if f.name not in state["packs"]:
            taken = {s_ for v in state["packs"].values() for s_ in v}
            state["packs"][f.name] = sorted({(x.get("source") or {}).get("sha256") for doc in lab if doc.get("market") == pack["market"] for x in doc.get("facts", []) if isinstance(x, dict)
                                              and (x.get("source") or {}).get("sha256") and (x.get("source") or {}).get("sha256") not in taken})
            state_dirty = True
        mine = set(state["packs"][f.name])
        docs = [dict(doc, facts=[x for x in doc.get("facts", []) if isinstance(x, dict) and (x.get("source") or {}).get("sha256") in mine]) for doc in lab]
        use = f
        merged = merge_lab_feedback(pack, [x for x in docs if x["facts"]]) if mine else pack
        if merged != pack:  # the lab's feedback facts join the card's input; the pack the producer was given stays untouched
            merged_dir.mkdir(parents=True, exist_ok=True)
            use = merged_dir / f.name
            use.write_text(json.dumps(merged, sort_keys=True, separators=(",", ":")))
            pack = merged
        req = _fact_pack_request(registry, cfg, use, pack)
        if req is None:
            continue
        count(admit(conn, cfg, registry, req, now, extra_input_prefixes=[d, merged_dir]))
    if state_dirty:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps(state, sort_keys=True))
    out["revision_skipped"] = len(skipped)
    out["revision_skipped_log"] = [[s["pack"], s["reason"]] for s in skipped]
    skip_file = cfg.state_dir / core.REVISION_SKIPPED_FILE   # what the status lists (the pack sha256 of every skipped pack); rewritten every tick so a freed week disappears
    skip_file.write_text(json.dumps({"at": core.iso(now), "packs": skipped}, sort_keys=True))
    out["resumed"] = reevaluate_waiting(conn, cfg, now, probes)
    return out


def _probe_state(cfg):
    return _load_json(cfg.state_dir / "probe-state.json") or {}


def reevaluate_waiting(conn, cfg, now, probes):
    """Each tick: wake waiting tasks whose reason no longer holds. Unknown probe answers (None) keep the wait."""
    st = _probe_state(cfg)
    resumed = []

    def due(key, every):
        last = st.get(key)
        if last and (now - core.parse_iso(last)).total_seconds() < every:
            return False
        st[key] = core.iso(now)
        return True

    def wake(task_id, reason):
        core.transition(conn, task_id, "READY", actor="rq-producer", now=now, reason=reason)
        resumed.append(task_id)

    rows = conn.execute("select task_id, state, state_reason from task where state in ('WAITING_QUOTA','WAITING_PROVIDER','WAITING_CREDENTIAL','WAITING_EXTERNAL')").fetchall()
    quota = [r for r in rows if r[1] == "WAITING_QUOTA"]
    if quota and due("balance", QUOTA_PROBE_S) and probes.balance_ok() is True:
        for r in quota:
            wake(r[0], "BALANCE_RESTORED")
    prov = [r for r in rows if r[1] == "WAITING_PROVIDER"]
    if prov and due("provider", PROVIDER_PROBE_S) and probes.provider_ok() is True:
        for r in prov:
            wake(r[0], "PROVIDER_RECOVERED")
    for r in rows:
        if r[1] == "WAITING_CREDENTIAL":
            key = "cred:" + r[0]
            fp = probes.credential_fingerprint(r[2] or "DEFAULT")
            if key not in st:
                st[key] = {"fp": fp}
            elif fp is not None and fp != st[key]["fp"]:
                wake(r[0], "CREDENTIAL_CHANGED")
                st.pop(key, None)
        elif r[1] == "WAITING_EXTERNAL":
            t = core.get_task(conn, r[0])
            if probes.external(r[2], t) is True:
                wake(r[0], "EXTERNAL_CLEARED")
    p = cfg.state_dir / "probe-state.json"
    p.write_text(json.dumps(st))
    return resumed
