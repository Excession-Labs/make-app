// Replays the HTTP calls of each module in ../app with a small IML evaluator, then checks the result.
// Usage: node test/replay.mjs [--write]      (--write also sends 1 test request; needs EXL_AGENT_KEY in the environment)
// The key is read from the environment and is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const WRITE = process.argv.includes("--write");
const KEY = process.env.EXL_AGENT_KEY || "";

// ---- IML subset: {{ expr }} with ; as argument separator, a.b -> a?.b ----
const fns = {
  contains: (t, s) => String(t ?? "").includes(String(s ?? "")),
  lower: (t) => String(t ?? "").toLowerCase(),
  get: (o, k) => (o == null ? undefined : o[k]),
  length: (x) => (x == null ? 0 : x.length ?? Object.keys(x).length),
  ifempty: (a, b) => (a === undefined || a === null || a === "" ? b : a),
  toCollection: (arr, k, v) => Object.fromEntries((arr || []).map((i) => [i[k], i[v]])),
};
function toJs(expr) {
  let out = "", q = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (q) { out += c; if (c === "\\") out += expr[++i]; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; out += c; continue; }
    if (c === ";") { out += ","; continue; }
    if (c === "." && /[A-Za-z0-9_\])]/.test(expr[i - 1] || "") && /[A-Za-z_]/.test(expr[i + 1] || "")) { out += "?."; continue; }
    out += c;
  }
  return out;
}
function evalExpr(expr, ctx) {
  const names = [...Object.keys(fns), ...Object.keys(ctx)];
  const vals = [...Object.values(fns), ...Object.values(ctx)];
  return new Function(...names, `return (${toJs(expr)});`)(...vals);
}
function tpl(v, ctx) {
  if (typeof v === "string") {
    const whole = v.match(/^\{\{([\s\S]*)\}\}$/);
    if (whole && !whole[1].includes("{{")) return evalExpr(whole[1], ctx);
    return v.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const r = evalExpr(e, ctx); return r === undefined || r === null ? "" : String(r); });
  }
  if (Array.isArray(v)) return v.map((x) => tpl(x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tpl(x, ctx)]));
  return v;
}

// Apply parameter defaults and checks like the Make form does
function prepParams(spec, given) {
  const p = {};
  for (const s of spec) {
    let v = given[s.name];
    if (v === undefined && s.default !== undefined) v = s.default;
    if (v === undefined && s.type === "boolean") v = false;
    if (s.required && (v === undefined || v === "" || (Array.isArray(v) && !v.length))) throw new Error(`form: ${s.name} is required`);
    if (s.validate?.pattern && v && !new RegExp(s.validate.pattern).test(v)) throw new Error(`form: ${s.name} fails pattern`);
    if (s.type === "select" && s.options && v !== undefined && !s.options.some((o) => (o.value ?? o) === v)) throw new Error(`form: ${s.name} not an option`);
    if (v !== undefined) p[s.name] = v;
  }
  return p;
}

const base = rd("base.json");
async function run(modName, given, extra = {}) {
  const comm = rd(`modules/${modName}/communication.json`);
  const parameters = prepParams(rd(`modules/${modName}/parameters.json`), given);
  const ctx = { parameters, connection: { apiKey: KEY } };
  const urlRaw = tpl(comm.url, ctx);
  const url = new URL(urlRaw, base.baseUrl);
  if (comm.qs) { const qs = tpl(comm.qs, ctx); for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v); }
  const headers = { ...(base.headers || {}), ...(comm.headers ? tpl(comm.headers, ctx) : {}) };
  const init = { method: comm.method ? tpl(comm.method, ctx) : "GET", headers };
  if (comm.body && init.method !== "GET") { const b = tpl(comm.body, ctx); if (b !== undefined) init.body = JSON.stringify(b); }
  const res = await fetch(url, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  const rctx = { ...ctx, body, statusCode: res.status, headers: Object.fromEntries(res.headers) };
  const r = comm.response || {};
  const errCfg = r.error || base.response?.error;
  if (res.status >= 400) return { error: tpl(errCfg.message, rctx).replace(/\s+/g, " ").trim(), status: res.status, host: url.host };
  if (r.valid) {
    const v = typeof r.valid === "string" ? { condition: r.valid } : r.valid;
    if (!tpl(v.condition, rctx)) return { error: tpl(v.message || "Response marked as invalid.", rctx), status: res.status, host: url.host };
  }
  let out;
  if (r.iterate) {
    const it = typeof r.iterate === "string" ? { container: r.iterate } : r.iterate;
    let items = tpl(it.container, rctx) || [];
    if (it.condition) items = items.filter((item) => tpl(it.condition, { ...rctx, item }));
    const limit = r.limit ? Number(tpl(r.limit, rctx)) : Infinity;
    out = items.slice(0, limit).map((item) => tpl(r.output, { ...rctx, item }));
  } else out = r.output ? tpl(r.output, rctx) : body;
  return { out, status: res.status, host: url.host, sent: init };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const keys = (o) => Object.keys(o).sort().join(",");
const ifaceNames = (m) => rd(`modules/${m}/interface.json`).map((f) => f.name).sort().join(",");

// connection definition
{
  const params = rd("connection/parameters.json");
  ok(prepParams(params, { apiKey: "exl_agent_" + "a".repeat(48) }).apiKey, "connection accepts well-formed key");
  let rejected = false; try { prepParams(params, { apiKey: "wrong" }); } catch { rejected = true; }
  ok(rejected, "connection rejects malformed key");
  const c = rd("connection/api.json");
  const res = await fetch(c.url);
  ok(res.status === 200, `connection test URL answers 200 (got ${res.status})`);
}

// 1 Check Security Headers
{
  const r = await run("checkSecurityHeaders", { url: "https://example.com" });
  ok(!r.error && r.out.ok === true && r.out.summary && Array.isArray(r.out.checks) && r.out.checks.length > 0, "headers: ok output " + JSON.stringify(r.error));
  const ifaceOut = ifaceNames("checkSecurityHeaders").split(",");
  ok(ifaceOut.every((n) => n in r.out), "headers: every interface field present in output");
  ok(r.host === "penetrationtestservices.com", "headers: host");
  const bad = await run("checkSecurityHeaders", { url: "http://localhost" });
  ok(bad.error && /public domain/.test(bad.error), "headers: bad URL gives readable error: " + bad.error);
}

// 2 Find Pentest Providers
{
  const all = await run("findPentestProviders", { limit: 200 });
  ok(!all.error && all.out.length > 50, "providers: unfiltered returns many " + all.out?.length);
  ok(all.host === "pentestcompare.com", "providers: host");
  const ifaceKeys = ifaceNames("findPentestProviders");
  ok(keys(all.out[0]) === ifaceKeys, `providers: output keys equal interface (${keys(all.out[0])} vs ${ifaceKeys})`);
  const lim = await run("findPentestProviders", { limit: 3 });
  ok(lim.out.length === 3, "providers: limit 3");
  const hy = await run("findPentestProviders", { limit: 200, delivery: "hybrid" });
  ok(hy.out.length > 0 && hy.out.every((p) => p.delivery === "hybrid"), "providers: delivery filter " + hy.out.length);
  const sc = await run("findPentestProviders", { limit: 200, scope: "ai_apps" });
  ok(sc.out.length > 0 && sc.out.every((p) => p.scope.ai_apps === "yes"), "providers: scope filter " + sc.out.length);
  const nm = await run("findPentestProviders", { limit: 200, name: "EXCESSION" });
  ok(nm.out.length === 1 && nm.out[0].publisher_owned === true && nm.out[0].profile_url.endsWith("/providers/excession-labs/"), "providers: name filter and publisher flag");
  const pp = await run("findPentestProviders", { limit: 200, published_prices_only: true });
  ok(pp.out.length > 0 && pp.out.every((p) => p.prices.length > 0) && pp.out.length < all.out.length, "providers: price filter " + pp.out.length);
  const none = await run("findPentestProviders", { limit: 200, name: "zzzz-no-such" });
  ok(none.out.length === 0, "providers: empty result");
  const combo = await run("findPentestProviders", { limit: 200, delivery: "automated", scope: "api" });
  ok(combo.out.every((p) => p.delivery === "automated" && p.scope.api === "yes"), "providers: combined filters " + combo.out.length);
  ok(all.out.filter((p) => p.publisher_owned).length === 1, "providers: exactly one publisher row");
}

// 3 Request a Penetration Test
{
  const good = {
    name: "Make Test", email: "make-test@example.com", test_type: "web_app", targets: ["https://example.com (test data)"],
    person_consent: true, authorized: true, notes: "Test data from the Make app replay script. Ignore.",
  };
  // validation errors surface in the message (valid key, bad body)
  if (KEY) {
    const bad = await run("requestPenetrationTest", { ...good, person_consent: false });
    ok(bad.error && /person_consent|Must be true/.test(bad.error) && bad.status === 422, "request: 422 message names the field: " + bad.error);
    const sec = await run("requestPenetrationTest", { ...good, notes: "my password is x" });
    ok(sec.error && /password/i.test(sec.error), "request: secret-like notes refused: " + sec.error);
    ok(!JSON.stringify(bad).includes(KEY), "request: key not in result");
    if (WRITE) {
      const r = await run("requestPenetrationTest", good);
      ok(!r.error && r.out.ok === true && r.out.reference && r.out.next_steps, "request: 201 output " + (r.error || ""));
      ok(keys(r.out) === ifaceNames("requestPenetrationTest"), "request: output keys equal interface");
      ok(r.sent.headers.Authorization.startsWith("Bearer exl_agent_"), "request: bearer header sent");
      ok(JSON.parse(r.sent.body).targets.length === 1 && JSON.parse(r.sent.body).person_consent === true, "request: body mapping");
      console.log("request reference present:", !!r.out.reference);
    }
  } else console.log("SKIP request tests: EXL_AGENT_KEY not set");
}

// 4 Universal module
{
  const r = await run("makeAnApiCall", { url: "/api/health", method: "GET" });
  ok(!r.error && r.out.status === 200 && r.out.body.ok === true, "universal: /api/health " + JSON.stringify(r.error));
  ok(r.host === "penetrationtestservices.com", "universal: host stays");
  let rej = false; try { prepParams(rd("modules/makeAnApiCall/parameters.json"), { url: "https://evil.example/x", method: "GET" }); } catch { rej = true; }
  ok(rej, "universal: absolute URL rejected by form pattern");
  rej = false; try { prepParams(rd("modules/makeAnApiCall/parameters.json"), { url: "//evil.example/x", method: "GET" }); } catch { rej = true; }
  ok(rej, "universal: protocol-relative URL rejected");
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
