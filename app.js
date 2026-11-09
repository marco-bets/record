// Book Buster Bankroll: each person signs in; their bets live in Firestore under users/<their id>,
// which the security rules (firestore.rules) let only that person read or write.
import { app, auth, logOut } from "./session.js";          // one login for the whole site
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, doc, collection, setDoc, deleteDoc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const CHECK_EVERY = 25, SWING = 0.2, STEPS = [0.5, 1, 1.5, 2];
const S = { loaded: false, user: null, settings: null, bets: {}, units: 1, kind: "", stakeEdited: false, tab: "open", unsub: [] };

// ---------- firebase ----------
let db;
if (app) {
  try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); }
  catch (e) { db = initializeFirestore(app, {}); }
} else {
  $("status").textContent = "My Bankroll accounts open soon. The record is on the Record tab.";
}

// ---------- math ----------
const ppu = (o) => (o > 0 ? o / 100 : 100 / -o);
const validOdds = (o) => Number.isFinite(o) && (o >= 100 || o <= -100);
const profitOf = (b) => b.result === "win" ? b.stake * ppu(b.odds) : b.result === "loss" ? -b.stake : 0;
const r2 = (x) => Math.round(x * 100) / 100;
const money = (x, sign) => { const a = Math.abs(x), s = a >= 1000 ? Math.round(a).toLocaleString() : a.toFixed(2).replace(/\.00$/, "");
  return (x < 0 ? "-" : sign && x > 0 ? "+" : "") + "$" + s; };
const uFmt = (u, sign) => { const v = Math.round(u * 100) / 100, s = String(Math.abs(v));
  return (v < 0 ? "-" : sign && v > 0 ? "+" : "") + s + (Math.abs(v) === 1 ? " unit" : " units"); };
const newId = () => "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowIso = () => new Date().toISOString();
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function derive() {
  const st = S.settings, all = Object.values(S.bets);
  const settled = all.filter((b) => b.result && b.result !== "pending").sort((a, b) => (a.settledAt || a.t).localeCompare(b.settledAt || b.t));
  const open = all.filter((b) => b.result === "pending").sort((a, b) => b.t.localeCompare(a.t));
  const unitsWon = settled.reduce((s, b) => s + profitOf(b) / (b.unitAt || (st && st.unit) || 1), 0);
  const w = settled.filter((b) => b.result === "win").length, l = settled.filter((b) => b.result === "loss").length;
  if (!st) return { settled, open, unitsWon, w, l };
  const since = settled.filter((b) => (b.settledAt || b.t) > st.setAt);
  const bankroll = st.base + since.reduce((s, b) => s + profitOf(b), 0);
  const n = since.filter((b) => b.result === "win" || b.result === "loss").length;
  const hi = st.base * (1 + SWING), lo = st.base * (1 - SWING);
  const reason = bankroll <= lo ? "down" : n >= CHECK_EVERY ? "count" : (bankroll >= hi && n > 0) ? "up" : null;
  return { settled, open, unitsWon, w, l, bankroll, n, hi, lo, reason, plan: plan(bankroll) };
}
// At a unit check: set aside part of any profit, then keep the same unit-to-bankroll ratio on the rest.
// Rainy-day savings follow a high-water mark (like a hedge fund's performance fee): only profit above
// your best bankroll so far gets skimmed, so winning back a loss is never "profit".
function plan(bankroll) {
  const st = S.settings, peak = st.peak ?? st.base, profit = bankroll - peak;
  const save = profit > 0 ? r2(profit * st.savePct / 100) : 0;
  const keep = r2(bankroll - save);
  return { profit, save, keep, unit: Math.max(1, Math.round(keep * st.pct)) };
}

// ---------- reading a Book Buster Bot alert ----------
function parseAlert(raw) {
  const t = raw.replace(/\*\*|__|`/g, "").replace(/🧪 (EXAMPLE|PRACTICE)[^:]*:\s*/g, "").replace(/🔒\s*/g, "").replace(/\r/g, "");
  const book = (s) => (/fan/i.test(s || "") ? "FanDuel" : /draft/i.test(s || "") ? "DraftKings" : "");
  // teaser line: "Teaser 1: Bears +8.5 (vs Packers) / Jets +7.5 (vs Lions) · 3 units" (first teaser if there are several)
  const tz = t.match(/Teaser\s*\d*:\s*(.+?)\s*\/\s*(.+?)\s*·\s*([\d.]+)\s*units?/i);
  if (tz) {
    const leg = (x) => x.replace(/\(vs [^)]*\)/i, "").trim();
    return { kind: "Teaser", bet: `${leg(tz[1])} / ${leg(tz[2])} (6-pt teaser)`, odds: -120, book: "DraftKings", units: parseFloat(tz[3]) };
  }
  const head = t.match(/(DAILY PICK|DAILY LEAN|BET OF THE DAY|VALUE BET|TOTAL|LIVE|MIDDLE|LEAN|BET|Best bet):\s*(.+?)\s*\(([+-]\d{3,4})\)(?:\*\*)?(?:\s*on\s+(FanDuel|DraftKings))?/i);
  if (!head) {
    // a line from the 📋 Top 5 board: "1. Under 150.5 (-110) on FanDuel ... · quarter unit"
    const row = t.match(/^\s*(\d)\.\s*(.+?)\s*\(([+-]\d{3,4})\)\s*on\s+(FanDuel|DraftKings)[^\n]*\n?([^\n]*)/m);
    if (!row) return null;
    const tagline = row[0];
    return { kind: "Top 5 board", bet: row[2].trim(), odds: parseInt(row[3], 10), book: book(row[4]),
             units: /half unit/i.test(tagline) ? 0.5 : 0.25 };
  }
  const k = head[1].toLowerCase();
  const out = { kind: (k === "daily lean" || k === "daily pick") ? "Daily pick" : k === "bet of the day" ? "Bet of the day" : k === "value bet" ? "Value bet" : k === "total" ? "NFL total" : k === "live" ? "Live" : k === "middle" ? "Middle" :
    k === "lean" ? "Lean" : k === "best bet" ? "NFL best bet" : "Bet", bet: head[2].trim(), odds: parseInt(head[3], 10), book: book(head[4]) };
  const sp = t.match(/\((NBA|NFL|CFB|CBB|MLB),/);
  const college = sp && (sp[1] === "CBB" || sp[1] === "CFB");
  const st = t.match(/Stake:\s*(quarter unit|half unit|[\d.]+\s*units?)/i);
  out.units = st ? (/quarter/i.test(st[1]) ? 0.25 : /half/i.test(st[1]) ? 0.5 : parseFloat(st[1])) : 1;
  if (/LOCKED/i.test(t)) out.kind = "Locked middle";
  const m = out.bet.match(/^(.+?)\s+([+-]\d+(?:\.\d)?)$/);
  if (m && !/^(Over|Under|2nd Half Under|2nd Half Over)$/i.test(m[1]) && !college) out.bet = `${m[1].split(/\s+/).pop()} ${m[2]}`;
  return out;
}
function fillFromPaste() {
  const raw = $("paste").value, p = parseAlert(raw);
  showMsg("formErr", ""); showMsg("pasteOk", "");
  if (!p) { if (raw.trim()) showMsg("formErr", "Couldn't read that. Paste the whole alert, or just type the wager."); return; }
  $("fOdds").value = (p.odds > 0 ? "+" : "") + p.odds;
  $("fDesc").value = p.bet + (p.book ? " · " + p.book : "");
  S.units = p.units; S.kind = p.kind; S.stakeEdited = false;
  render();
  showMsg("pasteOk", `${p.kind}: ${uFmt(p.units)} = ${money(unitNow() * p.units)} for you. Fix the odds if your book shows different.`);
}

// ---------- drawing ----------
const unitNow = () => (S.settings ? S.settings.unit : 10);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const bold = (t) => el("b", null, t);
const li = (...kids) => { const e = el("li"); e.append(...kids); return e; };

function render() {
  const st = S.settings, d = derive(), signedIn = !!S.user;
  $("auth").hidden = !auth || signedIn || !S.authKnown;
  $("setup").hidden = !signedIn || !S.loaded || !!st;
  $("main").hidden = !signedIn || !st;
  $("recordTag").hidden = !d.settled.length;
  $("recordTag").textContent = `${d.w}-${d.l}`;
  $("bankroll").textContent = st ? money(d.bankroll) : "$0";
  $("sUnit").textContent = st ? money(st.unit) : "–";
  $("sUnits").textContent = d.settled.length ? uFmt(d.unitsWon, true) : "–";
  $("sRain").textContent = st ? money(st.rainy || 0) : "–";
  $("where").textContent = signedIn ? `Saved to ${S.user.email || "your account"}. Same numbers on any phone or computer.` : "";
  $("who").textContent = S.user ? (S.user.email || "Google account") : "";
  $("aOut2").hidden = !signedIn;
  if (!st || !signedIn) return;
  const u = st.unit;
  $("unitBig").textContent = money(u);

  // unit check
  const due = $("checkDue"); due.replaceChildren();
  $("checkProg").hidden = !!d.reason;
  if (d.reason) {
    const p = d.plan, box = el("div", "alert" + (p.unit < u ? " down" : ""));
    box.append(el("strong", null, d.reason === "down" ? `Unit check: down 20% since your last change (${money(d.bankroll)}).`
      : d.reason === "up" ? `Unit check: up 20% since your last change (${money(d.bankroll)}).`
      : `Unit check: ${CHECK_EVERY} bets done. Bankroll ${money(d.bankroll)}.`));
    const ol = el("ol");
    if (p.save > 0) ol.append(li("Set aside ", el("span", "rainc", money(p.save)), " for a rainy day (cash it out or don't touch it)."));
    ol.append(li(p.unit > u ? "Raise your unit from " : p.unit < u ? "Lower your unit from " : "Keep your unit at ",
      ...(p.unit === u ? [bold(money(u))] : [bold(money(u)), " to ", bold(money(p.unit))]), "."));
    ol.append(li("Next bet: 1 unit = ", bold(money(p.unit)), "."));
    const btn = el("button", "btn main", p.save > 0 ? `Done: set aside ${money(p.save)}, unit ${money(p.unit)}` : `Done: unit ${money(p.unit)}`);
    btn.type = "button"; btn.onclick = () => applyCheck(d);
    box.append(ol, btn); due.append(box);
  } else {
    $("progTxt").textContent = `${d.n} of ${CHECK_EVERY} bets`;
    $("progBar").style.width = (d.n / CHECK_EVERY * 100) + "%";
    $("progHint").textContent = `Sooner if your bankroll hits ${money(d.hi)} (up 20%) or ${money(d.lo)} (down 20%).`;
    const p = d.plan, it = $("ifToday"); it.replaceChildren("If it were today: unit ", bold(money(p.unit)));
    if (p.save > 0) it.append(", set aside ", bold(money(p.save)));
    it.append(".");
    const pk = st.peak ?? st.base;
    if (d.bankroll < pk) it.append(` Nothing gets set aside until you're back above your best: ${money(pk)}.`);
  }

  // slip
  if (!S.stakeEdited) $("fStake").value = r2(u * S.units);
  $("kindTag").textContent = S.kind;
  chips(u); preview();

  // my bets
  $("tabOpen").textContent = `Open${d.open.length ? " (" + d.open.length + ")" : ""}`;
  $("tabOpen").setAttribute("aria-selected", String(S.tab === "open"));
  $("tabDone").setAttribute("aria-selected", String(S.tab === "done"));
  const bl = $("betList"), items = S.tab === "open" ? d.open : d.settled.slice().reverse().slice(0, 100);
  if (!items.length) bl.replaceChildren(el("p", "empty", S.tab === "open" ? "No open bets. Log one in the bet slip." : "Settled bets show up here."));
  else bl.replaceChildren(...items.map((b) => row(b, S.tab === "open")));

  // account
  const logs = (st.log || []).slice().reverse(), ll = $("logList");
  if (!logs.length) ll.replaceChildren(el("p", "empty", "None yet."));
  else ll.replaceChildren(...logs.map((g) => { const r = el("div", "bet");
    r.append(el("div", "what", `Unit ${money(g.unit)}`), el("div", "res rainc", g.saved ? `${money(g.saved)} saved` : ""),
      el("div", "meta", `${day(g.at)} · bankroll ${money(g.bankroll)}`)); return r; }));
  chart(d);
  const keepIfFocused = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  keepIfFocused("sBank", r2(d.bankroll)); keepIfFocused("sUnitIn", u); keepIfFocused("sSave", st.savePct); keepIfFocused("sRainIn", st.rainy || 0);
}

function chips(u) {
  $("chips").replaceChildren(...STEPS.map((k) => {
    const b = el("button"); b.type = "button";
    b.append(k === 0.5 ? "½ unit" : k + (k === 1 ? " unit" : " units"), bold(money(u * k)));
    b.onclick = () => { S.units = k; S.stakeEdited = false; render(); $("slip").scrollIntoView({ behavior: "smooth", block: "start" }); };
    return b;
  }));
}
function preview() {
  const o = parseFloat($("fOdds").value), s = parseFloat($("fStake").value), u = unitNow();
  $("pUnits").textContent = s > 0 ? uFmt(s / u) : "0 units";
  const win = validOdds(o) && s > 0 ? s * ppu(o) : null;
  $("pWin").textContent = win != null ? money(win) : "–";
  $("pPay").textContent = win != null ? money(win + s) : "–";
  $("place").textContent = s > 0 ? `Log bet · ${money(s)}` : "Log bet";
  const big = s > 0 && s / u > 2.001;
  $("pWarn").hidden = !big;
  if (big) $("pWarn").textContent = "That's more than 2 units on one bet. Most bettors keep a single bet to 2 units or less.";
  $("chips").querySelectorAll("button").forEach((b, i) => b.setAttribute("aria-pressed", String(s > 0 && Math.abs(s - u * STEPS[i]) < 0.005)));
}

function row(b, open) {
  const r = el("div", "bet"), ua = b.unitAt || unitNow();
  const res = el("div", "res");
  if (open) { res.textContent = money(b.stake); res.append(el("small", null, uFmt(b.stake / ua))); }
  else {
    res.classList.add(b.result === "win" ? "w" : b.result === "loss" ? "l" : "p");
    res.textContent = b.result === "push" ? "$0" : money(profitOf(b), true);
    res.append(el("small", null, b.result === "push" ? "push" : uFmt(profitOf(b) / ua, true)));
  }
  const meta = el("div", "meta");
  if (!open) { const k = b.result === "win" ? "w" : b.result === "loss" ? "l" : "p";
    meta.append(el("span", "badge " + k, b.result === "win" ? "Won" : b.result === "loss" ? "Lost" : "Push"), " "); }
  meta.append(`${b.odds > 0 ? "+" : ""}${b.odds} · ${money(b.stake)}${b.kind ? " · " + b.kind : ""} · ${day(b.t)}`);
  const del = el("button", "del", "Delete"); del.type = "button";
  del.onclick = () => { if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Tap to confirm";
    setTimeout(() => { del.classList.remove("armed"); del.textContent = "Delete"; }, 3000); return; } removeBet(b.id); };
  r.append(el("div", "what", b.desc || "Bet"), res, meta, del);
  if (open) {
    const s = el("div", "settle");
    [["win", "Won", "w"], ["loss", "Lost", "l"], ["push", "Push", "p"]].forEach(([res2, t, cls]) => {
      const btn = el("button", cls, t); btn.type = "button";
      btn.onclick = () => putBet({ ...b, result: res2, settledAt: nowIso() }); s.append(btn);
    });
    r.append(s);
  }
  return r;
}

function chart(d) {
  const box = $("chart");
  if (!d.settled.length) { box.replaceChildren(el("p", "empty", "Shows up after your first settled bet.")); return; }
  const pts = [0]; let run = 0; d.settled.forEach((b) => pts.push(run += profitOf(b)));
  const W = 500, H = 160, L = 52, R = 10, T = 10, B = 22;
  let lo = Math.min(...pts), hi = Math.max(...pts); if (hi - lo < 20) { hi += 10; lo -= 10; }
  const x = (i) => L + (pts.length < 2 ? 0 : i / (pts.length - 1)) * (W - L - R), y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "), last = pts[pts.length - 1];
  const col = last >= 0 ? "var(--win)" : "var(--loss)", zy = y(0).toFixed(1);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Profit over ${pts.length - 1} bets: ${money(last, true)}">
    <line x1="${L}" x2="${W - R}" y1="${zy}" y2="${zy}" stroke="var(--line)" stroke-dasharray="4 4"/>
    <text x="${L - 6}" y="${y(hi) + 4}" text-anchor="end">${money(hi, true)}</text><text x="${L - 6}" y="${y(lo) + 4}" text-anchor="end">${money(lo, true)}</text>
    <polyline points="${line}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
    <text x="${L}" y="${H - 6}">bet 1</text><text x="${W - R}" y="${H - 6}" text-anchor="end">bet ${pts.length - 1}</text></svg>`;
}

// ---------- saving (Firestore: users/<uid> holds settings, users/<uid>/bets holds bets) ----------
function showMsg(id, m) { $(id).textContent = m; $(id).hidden = !m; }
const userDoc = () => doc(db, "users", S.user.uid);
const betDoc = (id) => doc(db, "users", S.user.uid, "bets", id);
function saveErr(e) {
  console.error(e);
  showMsg("formErr", e && e.code === "permission-denied" ? "Your account isn't allowed to save. Sign out and back in." : "Couldn't save. Check your connection and try again.");
}
// Writes show right away (Firestore applies them locally first) and sync to the server in the background.
function putSettings(next) { S.settings = next; render(); return setDoc(userDoc(), { settings: next }, { merge: true }).then(() => true, (e) => { saveErr(e); return false; }); }
function putBet(b) { S.bets = { ...S.bets, [b.id]: b }; render(); return setDoc(betDoc(b.id), b).then(() => true, (e) => { saveErr(e); return false; }); }
function removeBet(id) { const n = { ...S.bets }; delete n[id]; S.bets = n; render(); deleteDoc(betDoc(id)).catch(saveErr); }

function listen() {
  S.unsub.forEach((f) => f()); S.unsub = [];
  let gotS = false, gotB = false;
  const ready = () => { if (gotS && gotB) { S.loaded = true; $("status").hidden = true; render(); } };
  const timer = setTimeout(() => { if (!S.loaded) { $("status").hidden = false; $("status").textContent = "Still loading… check your connection."; } }, 10000);
  const fail = (e) => { clearTimeout(timer); console.error(e); $("status").hidden = false; $("status").textContent = "Couldn't load your bets. Refresh to try again."; };
  S.unsub.push(onSnapshot(userDoc(), (snap) => { S.settings = snap.exists() ? (snap.data().settings || null) : null; gotS = true; clearTimeout(timer); ready(); render(); }, fail));
  S.unsub.push(onSnapshot(collection(db, "users", S.user.uid, "bets"), (snap) => {
    const bets = {}; snap.forEach((x) => { bets[x.id] = { id: x.id, ...x.data() }; }); S.bets = bets; gotB = true; ready(); render(); }, fail));
}

// ---------- sign out (logging in happens on login.html) ----------
$("aOut").onclick = $("aOut2").onclick = () => logOut();

if (auth) onAuthStateChanged(auth, (u) => {
  S.authKnown = true; S.user = u; S.settings = null; S.bets = {}; S.loaded = false;
  if (u) { $("status").hidden = false; $("status").textContent = "Loading your bets…"; listen(); }
  else { S.unsub.forEach((f) => f()); S.unsub = []; $("status").hidden = true; }
  render();
});

// ---------- actions ----------
$("uGo").onclick = async () => {
  const unit = parseFloat($("uUnit").value), bankIn = parseFloat($("uBank").value), save = parseFloat($("uSave").value);
  if (!(unit > 0)) return showMsg("uErr", "Enter your unit in dollars, like 10.");
  const bank = bankIn > 0 ? bankIn : unit * 50;
  if (unit > bank) return showMsg("uErr", "Your unit can't be bigger than your betting money.");
  if (!(save >= 0 && save <= 100)) return showMsg("uErr", "Rainy day % should be 0 to 100.");
  showMsg("uErr", "");
  const at = nowIso();
  putSettings({ v: 2, base: r2(bank), peak: r2(bank), unit: r2(unit), pct: unit / bank, savePct: Math.round(save), rainy: 0, setAt: at,
    log: [{ at, unit: r2(unit), bankroll: r2(bank), saved: 0 }] });
};
$("place").onclick = () => {
  showMsg("formErr", ""); showMsg("formOk", "");
  const odds = parseFloat($("fOdds").value), stake = parseFloat($("fStake").value);
  if (!validOdds(odds)) return showMsg("formErr", "Use American odds, like -110 or +150.");
  if (!(stake > 0)) return showMsg("formErr", "Enter your wager.");
  const u = unitNow();
  const bet = { id: newId(), t: nowIso(), desc: $("fDesc").value.trim().slice(0, 120) || "Bet", odds: Math.round(odds),
    stake: r2(stake), unitAt: u, kind: S.kind, result: "pending", settledAt: null };
  putBet(bet);
  showMsg("formOk", `Logged ${money(bet.stake)} (${uFmt(bet.stake / u)}). Mark it Won or Lost under My bets when it's done.`);
  $("paste").value = ""; $("fDesc").value = ""; $("fOdds").value = "-110"; $("pasteBox").open = false; showMsg("pasteOk", "");
  S.kind = ""; S.units = 1; S.stakeEdited = false; S.tab = "open"; render();
};
function applyCheck(d) {
  const st = S.settings, p = d.plan, at = nowIso();
  putSettings({ ...st, base: p.keep, peak: r2(Math.max(st.peak ?? st.base, p.keep)), unit: p.unit, rainy: r2((st.rainy || 0) + p.save), setAt: at,
    log: [...(st.log || []), { at, unit: p.unit, bankroll: p.keep, saved: p.save }].slice(-60) });
}
$("sGo").onclick = async () => {
  showMsg("sErr", ""); showMsg("sOk", "");
  const bank = parseFloat($("sBank").value), unit = parseFloat($("sUnitIn").value), save = parseFloat($("sSave").value), rain = parseFloat($("sRainIn").value);
  if (!(bank > 0)) return showMsg("sErr", "Enter your betting money in dollars.");
  if (!(unit > 0) || unit > bank) return showMsg("sErr", "Enter a unit in dollars, smaller than your betting money.");
  if (!(save >= 0 && save <= 100)) return showMsg("sErr", "Rainy day % should be 0 to 100.");
  if (!(rain >= 0)) return showMsg("sErr", "Rainy day fund can't be negative.");
  const st = S.settings, at = nowIso();
  putSettings({ ...st, base: r2(bank), peak: r2(bank), unit: r2(unit), pct: unit / bank, savePct: Math.round(save), rainy: r2(rain), setAt: at,
    log: [...(st.log || []), { at, unit: r2(unit), bankroll: r2(bank), saved: 0 }].slice(-60) });
  showMsg("sOk", "Saved. The 25-bet count starts over.");
};
$("tabOpen").onclick = () => { S.tab = "open"; render(); };
$("tabDone").onclick = () => { S.tab = "done"; render(); };
$("paste").addEventListener("paste", () => setTimeout(fillFromPaste, 0));
$("paste").addEventListener("input", () => { clearTimeout(S.pt); S.pt = setTimeout(fillFromPaste, 250); });
$("fOdds").addEventListener("input", preview);
$("fStake").addEventListener("input", () => { S.stakeEdited = true; preview(); });
render();
