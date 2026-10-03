// Stormwreck Sheets — a tiny, self-contained Owlbear Rodeo character sheet extension.
// No build step: plain ES module. The Owlbear SDK is loaded from a CDN when running inside
// Owlbear; outside of it (opened directly in a browser) a local mock is used so the sheet
// can be tested standalone.

// The SDK must be imported statically so its message listener exists before Owlbear
// sends the ready handshake to this iframe. A lazy import can miss that message.
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";

const NS = "com.stormwreck.sheets";
const VERSION = "0.1.1";
const PROF = 2; // proficiency bonus is +2 for levels 1-4
const MAX_LEVEL = 3;

const ABIL = ["str", "dex", "con", "int", "wis", "cha"];
const ABIL_NAME = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
const SKILLS = [
  ["acrobatics", "Acrobatics", "dex"], ["animalHandling", "Animal Handling", "wis"], ["arcana", "Arcana", "int"],
  ["athletics", "Athletics", "str"], ["deception", "Deception", "cha"], ["history", "History", "int"],
  ["insight", "Insight", "wis"], ["intimidation", "Intimidation", "cha"], ["investigation", "Investigation", "int"],
  ["medicine", "Medicine", "wis"], ["nature", "Nature", "int"], ["perception", "Perception", "wis"],
  ["performance", "Performance", "cha"], ["persuasion", "Persuasion", "cha"], ["religion", "Religion", "int"],
  ["sleightOfHand", "Sleight of Hand", "dex"], ["stealth", "Stealth", "dex"], ["survival", "Survival", "wis"],
];
const DIE_AVG = { d6: 4, d8: 5, d10: 6, d12: 7 };
const ORD = ["", "1st", "2nd", "3rd"];
// Sensible starting prepared lists so nobody has to pick before the first session.
const DEFAULT_PREP = {
  aren: ["Magic Missile", "Shield", "Sleep", "Thunderwave"],
  reinhardt: ["Guiding Bolt", "Healing Word", "Sanctuary", "Shield of Faith"],
  arthur: ["Bless", "Command", "Shield of Faith"],
};

// ---------------------------------------------------------------------------
// Backends: real Owlbear SDK, or a localStorage/BroadcastChannel mock.
// ---------------------------------------------------------------------------
async function makeBackend() {
  if (OBR && OBR.isAvailable) return obrBackend(OBR);
  return mockBackend();
}

function status(text) {
  const el = document.querySelector("#app .loading");
  if (el) el.textContent = text;
}

function obrBackend(OBR) {
  const CH = `${NS}/roll`;
  return {
    kind: "obr",
    ready: () => new Promise((res) => OBR.onReady(res)),
    async player() {
      const [id, name, role] = await Promise.all([OBR.player.getId(), OBR.player.getName(), OBR.player.getRole()]);
      return { id, name, role };
    },
    onPlayer: (cb) => OBR.player.onChange((p) => cb({ id: p.id, name: p.name, role: p.role })),
    getMeta: () => OBR.room.getMetadata(),
    setMeta: (patch) => OBR.room.setMetadata(patch),
    onMeta: (cb) => OBR.room.onMetadataChange(cb),
    send: (msg) => OBR.broadcast.sendMessage(CH, msg, { destination: "ALL" }),
    onMsg: (cb) => OBR.broadcast.onMessage(CH, (ev) => cb(ev.data)),
    notify: (text, variant = "DEFAULT") => OBR.notification.show(text, variant),
    theme: async () => (await OBR.theme.getTheme()).mode,
    onTheme: (cb) => OBR.theme.onChange((t) => cb(t.mode)),
    party: () => OBR.party.getPlayers(),
  };
}

function mockBackend() {
  const q = new URLSearchParams(location.search);
  const role = (q.get("role") || "GM").toUpperCase();
  const name = q.get("name") || (role === "GM" ? "DM (local test)" : "Player (local test)");
  const id = q.get("id") || "mock-" + name.toLowerCase().replace(/\W+/g, "-");
  const LS = "stormwreck-mock-meta";
  const read = () => { try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; } };
  const bc = "BroadcastChannel" in window ? new BroadcastChannel("stormwreck-mock") : null;
  const metaCbs = [], msgCbs = [];
  if (bc) bc.onmessage = (ev) => {
    if (ev.data.t === "meta") metaCbs.forEach((cb) => cb(read()));
    else if (ev.data.t === "msg") msgCbs.forEach((cb) => cb(ev.data.m));
  };
  return {
    kind: "mock",
    ready: async () => {},
    player: async () => ({ id, name, role }),
    onPlayer() {},
    getMeta: async () => read(),
    async setMeta(patch) {
      const m = read();
      for (const k of Object.keys(patch)) { if (patch[k] === undefined) delete m[k]; else m[k] = patch[k]; }
      try { localStorage.setItem(LS, JSON.stringify(m)); } catch {}
      metaCbs.forEach((cb) => cb(m));
      if (bc) bc.postMessage({ t: "meta" });
    },
    onMeta: (cb) => metaCbs.push(cb),
    async send(m) { msgCbs.forEach((cb) => cb(m)); if (bc) bc.postMessage({ t: "msg", m }); },
    onMsg: (cb) => msgCbs.push(cb),
    async notify(text) { toast(text); },
    theme: async () => (q.get("theme") || "DARK").toUpperCase(),
    onTheme() {},
    party: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------
function rng(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return 1 + (a[0] % n); }

function parseTerms(formula) {
  const s = String(formula).replace(/\s+/g, "");
  const re = /([+-]?)(\d*d\d+|\d+)/gi;
  const terms = []; let m;
  while ((m = re.exec(s))) {
    const sign = m[1] === "-" ? -1 : 1;
    const t = m[2].toLowerCase();
    if (t.includes("d")) { const [c, d] = t.split("d"); terms.push({ sign, count: c === "" ? 1 : +c, sides: +d }); }
    else terms.push({ sign, konst: +t });
  }
  return terms;
}

function rollFormula(formula, { double = false } = {}) {
  const terms = parseTerms(formula);
  let total = 0; const parts = [];
  for (const t of terms) {
    if (t.sides) {
      const n = t.count * (double ? 2 : 1);
      const rolls = []; for (let i = 0; i < n; i++) rolls.push(rng(t.sides));
      const sum = rolls.reduce((a, b) => a + b, 0);
      total += t.sign * sum;
      parts.push(`${t.sign < 0 ? "-" : (parts.length ? "+" : "")}${n}d${t.sides}[${rolls.join(",")}]`);
    } else if (t.konst) {
      total += t.sign * t.konst;
      parts.push(`${t.sign < 0 ? "-" : "+"}${t.konst}`);
    }
  }
  return { total, text: parts.join(" ") };
}

function rollD20(bonus, mode = 0, critAt = 20) {
  const a = rng(20), b = rng(20);
  let kept = a, other = null;
  if (mode === 1) { kept = Math.max(a, b); other = Math.min(a, b); }
  else if (mode === -1) { kept = Math.min(a, b); other = Math.max(a, b); }
  const total = kept + bonus;
  const modeTxt = mode === 1 ? " adv" : mode === -1 ? " dis" : "";
  const text = `d20[${kept}${other !== null ? `|${other}` : ""}]${modeTxt} ${bonus >= 0 ? "+" : "-"} ${Math.abs(bonus)}`;
  return { total, d20: kept, crit: kept >= critAt, fumble: kept === 1, text };
}

const sgn = (n) => (n >= 0 ? `+${n}` : `${n}`);
const mod = (score) => Math.floor((score - 10) / 2);

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let DATA, SPELLS, B, ME = { id: "", name: "", role: "PLAYER" }, META = {};
const UI = {
  charId: null, adv: 0, log: [], open: {}, levelup: null, rest: null, rolling: null,
  popups: true, lastAttack: {}, prepOpen: false, editAc: false, menu: false, dirty: false,
  acctClaimsOpen: false,
};
try { Object.assign(UI, JSON.parse(localStorage.getItem("stormwreck-ui") || "{}")); } catch {}
UI.levelup = null; UI.rest = null; UI.menu = false; UI.editAc = false; UI.prepOpen = false;
function saveUi() {
  try { localStorage.setItem("stormwreck-ui", JSON.stringify({ open: UI.open, popups: UI.popups, charId: UI.charId, adv: 0 })); } catch {}
}

const charKey = (id) => `${NS}/char/${id}`;
const CLAIMS_KEY = `${NS}/claims`;
const byId = (id) => DATA.characters.find((c) => c.id === id);

function defaults(c) {
  return {
    lvl: 1, hp: c.hp.level1Max, thp: 0, hpGains: [], hdUsed: 0, ds: { s: 0, f: 0 },
    used: {}, slotsUsed: {}, prep: (DEFAULT_PREP[c.id] || []).slice(), book: [], acOverride: null, notes: "",
  };
}
function stateOf(id) { return META[charKey(id)] || defaults(byId(id)); }
async function update(id, fn) {
  const s = JSON.parse(JSON.stringify(stateOf(id)));
  fn(s);
  META[charKey(id)] = s;
  render();
  await B.setMeta({ [charKey(id)]: s });
}

// ---------------------------------------------------------------------------
// Derived character view
// ---------------------------------------------------------------------------
function highestLE(mapObj, lvl) {
  let best = null;
  for (const k of Object.keys(mapObj || {})) if (+k <= lvl && (best === null || +k > best)) best = +k;
  return best === null ? null : mapObj[best];
}

function derive(c, s) {
  const lvl = s.lvl;
  const mods = {}; ABIL.forEach((a) => (mods[a] = mod(c.abilities[a])));
  const saves = {}; ABIL.forEach((a) => (saves[a] = mods[a] + (c.saveProficiencies.includes(a) ? PROF : 0)));
  const skills = {};
  for (const [k, , ab] of SKILLS) {
    const p = c.skillProficiencies.includes(k) ? (c.expertise.includes(k) ? 2 : 1) : 0;
    skills[k] = mods[ab] + PROF * p;
  }
  const maxHp = c.hp.level1Max + (s.hpGains || []).reduce((a, b) => a + b, 0);
  const features = [];
  for (let L = 1; L <= lvl; L++) for (const f of c.featuresByLevel[String(L)] || []) features.push({ ...f, atLevel: L });
  const critAt = features.some((f) => f.name === "Improved Critical") ? 19 : 20;
  const resources = {};
  for (const f of features) {
    if (!f.resource) continue;
    const max = f.resource.max != null ? f.resource.max : highestLE(f.resource.maxByLevel, lvl);
    if (max == null) continue;
    resources[f.name] = { name: f.name, max, used: Math.min(max, s.used[f.name] || 0), recharge: f.resource.recharge };
  }
  let spell = null;
  const sc = c.spellcasting;
  if (sc && lvl >= (sc.startsAtLevel || 1)) {
    const slots = sc.slotsByLevel[String(lvl)] || {};
    const maxSlotLevel = Math.max(0, ...Object.keys(slots).map(Number));
    const always = [];
    for (let L = 1; L <= lvl; L++) for (const n of (sc.alwaysPreparedByLevel || {})[String(L)] || []) always.push(n);
    let known = [];
    if (sc.spellbook) known = [...sc.spellbook, ...(s.book || [])];
    else for (const L of Object.keys(sc.availableSpells)) known.push(...sc.availableSpells[L]);
    known = known.filter((n) => (SPELLS[n]?.level ?? 99) <= maxSlotLevel);
    const prepCount = sc.preparedCountByLevel[String(lvl)] || 0;
    const prep = (s.prep || []).filter((n) => known.includes(n) && !always.includes(n)).slice(0, prepCount);
    spell = {
      ability: sc.ability, mod: mods[sc.ability], dc: sc.saveDC, atk: sc.attackBonus, slots, maxSlotLevel,
      cantrips: sc.cantrips || [], known, always, prep, prepCount, isWizard: !!sc.spellbook,
      discipleOfLife: features.some((f) => f.name === "Disciple of Life"),
    };
  }
  const speed = c.speedByLevel ? highestLE(c.speedByLevel, lvl) : c.speed;
  const sneak = features.find((f) => f.name === "Sneak Attack");
  const sneakDie = sneak ? highestLE(sneak.rollByLevel, lvl) : null;
  return {
    lvl, mods, saves, skills, maxHp, features, critAt, resources, spell, speed, sneakDie,
    ac: s.acOverride != null ? s.acOverride : c.ac,
    passivePerception: 10 + skills.perception,
    hdTotal: lvl, hdLeft: Math.max(0, lvl - (s.hdUsed || 0)),
    hitDieSides: +c.hp.hitDie.slice(1),
    lucky: features.some((f) => f.name === "Lucky"),
  };
}

// ---------------------------------------------------------------------------
// Rolling + log
// ---------------------------------------------------------------------------
function post(c, entry) {
  const msg = { who: c.name, charId: c.id, player: ME.name, t: Date.now(), ...entry };
  B.send(msg);
}
function addLog(msg) {
  UI.log.unshift(msg); if (UI.log.length > 40) UI.log.length = 40;
  if (UI.popups && msg.player !== ME.name && B.kind === "obr") {
    B.notify(`${msg.who}: ${msg.label} ${msg.total != null ? "→ " + msg.total : ""}`);
  }
  renderLog();
}

function d20Roll(c, d, label, bonus, kind = "check", extra = {}) {
  const r = rollD20(bonus, UI.adv, kind === "attack" ? d.critAt : 20);
  const e = { label, total: r.total, text: r.text, kind, crit: kind === "attack" && r.crit, nat20: r.d20 === 20, fumble: r.fumble, lucky: d.lucky && r.d20 === 1, bonus, ...extra };
  post(c, e);
  if (UI.adv !== 0) { UI.adv = 0; renderRollbar(); }
  return r;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const app = document.getElementById("app");

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text"));
}

function render() {
  if (isTyping()) { UI.dirty = true; return; }
  UI.dirty = false;
  const isGM = ME.role === "GM";
  const claims = META[CLAIMS_KEY] || {};
  if (!UI.charId) {
    const mine = claims[ME.id];
    if (mine && byId(mine.charId)) UI.charId = mine.charId;
    else if (isGM) UI.charId = DATA.characters[0].id;
  }
  if (!UI.charId || !byId(UI.charId)) { app.innerHTML = renderPicker(claims); return; }
  const c = byId(UI.charId), s = stateOf(c.id), d = derive(c, s);
  const scrollY = app.parentElement.scrollTop || window.scrollY;
  app.innerHTML = [
    renderHeader(c, s, d, isGM, claims),
    renderVitals(c, s, d),
    `<div id="rollbar">${renderRollbar(true)}</div>`,
    section("abilities", "Abilities & saves", renderAbilities(c, s, d)),
    section("skills", "Skills", renderSkills(c, s, d)),
    section("attacks", "Attacks", renderAttacks(c, s, d)),
    section("features", "Features & resources", renderFeatures(c, s, d)),
    d.spell ? section("spells", "Spells", renderSpells(c, s, d)) : "",
    section("rest", "Rest & level", renderRest(c, s, d, isGM)),
    section("log", "Roll log", `<div id="log" class="log">${renderLogInner()}</div>`),
    section("notes", "Notes", `<textarea data-field="notes" placeholder="Anything worth remembering…">${esc(s.notes)}</textarea>`),
    `<div class="muted" style="font-size:10px;text-align:right">Stormwreck Sheets v${VERSION} · ${B.kind === "obr" ? "Owlbear" : "local test mode"} · ${esc(ME.name)} (${ME.role})</div>`,
    `<div id="toast" class="toast"></div>`,
  ].join("");
  window.scrollTo(0, scrollY);
}

function section(id, title, body) {
  const closed = UI.open[id] === false ? " closed" : "";
  return `<section class="card${closed}" data-sec="${id}"><h2 data-act="toggleSec" data-id="${id}">${title}<span class="chev">▾</span></h2><div class="body">${body}</div></section>`;
}

function renderPicker(claims) {
  const rows = DATA.characters.map((c) => {
    const owner = Object.values(claims).find((x) => x.charId === c.id);
    const taken = owner && owner.name && owner.id !== ME.id;
    return `<button data-act="claim" data-id="${c.id}">${esc(c.name)}<small>${esc(c.race)} ${esc(c.class)} · level ${stateOf(c.id).lvl}${taken ? " · played by " + esc(owner.name) : ""}</small></button>`;
  }).join("");
  return `<div class="hdr"><h1>Who are you playing?</h1></div><div class="picker">${rows}</div>
  <p class="muted" style="font-size:11px">Your choice is remembered for this room. You can switch later from the ⋯ menu.</p>`;
}

function renderHeader(c, s, d, isGM, claims) {
  const tabs = isGM ? `<div class="tabs">${DATA.characters.map((x) => `<button class="${x.id === c.id ? "on" : ""}" data-act="tab" data-id="${x.id}">${esc(x.name.split(" ")[0])}</button>`).join("")}</div>` : "";
  const sub = `${esc(c.race)} ${esc(c.class)} ${d.lvl}${c.subclass ? Object.entries(c.subclass).filter(([L]) => +L <= d.lvl).map(([, n]) => " · " + esc(n)).join("") : ""} · ${esc(c.background)}`;
  const menu = `<div class="menu${UI.menu ? " open" : ""}"><button class="icon" data-act="menu">⋯</button><div class="dd">
      <button data-act="switch">Switch character…</button>
      <button data-act="popups">${UI.popups ? "✓ " : ""}Pop up other people's rolls</button>
      <button data-act="claims">Who plays whom</button>
      ${isGM ? `<button data-act="resetChar">Reset ${esc(c.name.split(" ")[0])} to level 1…</button>` : ""}
    </div></div>`;
  const claimsBox = UI.acctClaimsOpen ? `<div class="notice">${DATA.characters.map((x) => { const o = Object.values(claims).find((y) => y.charId === x.id); return `${esc(x.name)}: ${o ? esc(o.name) : "<span class='muted'>unclaimed</span>"}`; }).join("<br>")}</div>` : "";
  const resetBox = UI.confirmReset ? `<div class="notice warn">Reset <b>${esc(c.name)}</b> to level 1, full HP, all resources and default spells? <button class="sm" data-act="resetChar2">Yes, reset</button> <button class="sm ghost" data-act="cancelReset">Cancel</button></div>` : "";
  return `${tabs}<div class="hdr"><div style="flex:1"><h1>${esc(c.name)}</h1><div class="sub">${sub}</div></div>${menu}</div>${claimsBox}${resetBox}`;
}

function renderVitals(c, s, d) {
  const pct = Math.max(0, Math.min(100, Math.round((s.hp / d.maxHp) * 100)));
  const ac = UI.editAc
    ? `<input type="number" data-field="ac" value="${d.ac}" style="width:50px;text-align:center" autofocus>`
    : `<div class="v">${d.ac}${s.acOverride != null ? "<small>*</small>" : ""}</div>`;
  const mageArmor = c.id === "aren" ? `<label class="muted" style="font-size:11px"><input type="checkbox" data-act="mageArmor" ${s.acOverride === 15 ? "checked" : ""}> Mage Armor (AC 15)</label>` : "";
  const dead = s.hp <= 0;
  const ds = dead ? `<div class="deathsaves">
      <div class="row" style="border:0"><b style="color:var(--bad)">Unconscious — death saves</b><span class="spacer"></span><button class="sm primary" data-act="deathSave">Roll death save</button></div>
      <div class="row" style="border:0">Successes <span class="pips">${[0, 1, 2].map((i) => `<span class="pip ${i < s.ds.s ? "" : "used"}" data-act="ds" data-k="s" data-i="${i}"></span>`).join("")}</span>
      &nbsp; Failures <span class="pips">${[0, 1, 2].map((i) => `<span class="pip ${i < s.ds.f ? "" : "used"}" data-act="ds" data-k="f" data-i="${i}"></span>`).join("")}</span>
      <span class="spacer"></span><button class="sm" data-act="stabilize">Stabilize</button></div></div>` : "";
  return `<section class="card"><div class="body" style="padding-top:8px">
    <div class="vitals">
      <div class="stat hp"><div class="v">${s.hp}<small> / ${d.maxHp}</small>${s.thp ? `<small class="thp"> +${s.thp}</small>` : ""}</div><div class="l">Hit points</div></div>
      <div class="stat click" data-act="editAc">${ac}<div class="l">AC</div></div>
      <div class="stat click" data-act="initiative"><div class="v">${sgn(c.initiative)}</div><div class="l">Initiative</div></div>
      <div class="stat"><div class="v">${d.speed}</div><div class="l">Speed</div></div>
    </div>
    <div class="bar${pct <= 25 ? " low" : ""}"><div style="width:${pct}%"></div></div>
    <div class="hprow">
      <input type="number" id="hpamt" min="0" value="" placeholder="0">
      <button data-act="damage" style="border-color:var(--bad)">Damage</button>
      <button data-act="heal" style="border-color:var(--good)">Heal</button>
      <span class="spacer"></span>
      <label class="muted" style="font-size:11px">Temp HP <input type="number" data-field="thp" value="${s.thp}" min="0" style="width:50px"></label>
    </div>
    <div class="flex muted" style="font-size:11px;margin-top:6px">
      <span>Hit dice ${d.hdLeft}/${d.hdTotal} ${c.hp.hitDie}</span>
      <span>· Passive Perception ${d.passivePerception}</span>
      <span>· Prof +${PROF}</span>
      ${c.resistances?.length ? `<span>· Resist ${esc(c.resistances.join(", "))}</span>` : ""}
      ${c.senses?.length ? `<span>· ${esc(c.senses.join(", "))}</span>` : ""}
      <span class="spacer"></span>${mageArmor}
    </div>
    ${ds}
  </div></section>`;
}

function renderRollbar(inner = false) {
  const html = `<div class="rollbar">
    <span class="seg">
      <button class="${UI.adv === -1 ? "on dis" : ""}" data-act="adv" data-v="-1">Dis</button>
      <button class="${UI.adv === 0 ? "on" : ""}" data-act="adv" data-v="0">Normal</button>
      <button class="${UI.adv === 1 ? "on adv" : ""}" data-act="adv" data-v="1">Adv</button>
    </span>
    <span class="spacer"></span>
    <input type="text" id="custom" placeholder="2d6+3" data-enter="customRoll">
    <button data-act="customRoll">Roll</button>
  </div>`;
  if (inner) return html;
  const el = document.getElementById("rollbar"); if (el) el.innerHTML = html;
}

function renderAbilities(c, s, d) {
  return `<div class="abils">${ABIL.map((a) => `<div class="abil" data-act="check" data-a="${a}" title="${ABIL_NAME[a]} check"><div class="n">${a}</div><div class="m">${sgn(d.mods[a])}</div><div class="s">${c.abilities[a]}</div></div>`).join("")}</div>
  <div class="saves">${ABIL.map((a) => `<button class="${c.saveProficiencies.includes(a) ? "prof" : ""}" data-act="save" data-a="${a}" title="${ABIL_NAME[a]} save">${sgn(d.saves[a])}</button>`).join("")}</div>
  <div class="muted" style="font-size:10px;margin-top:3px">Top row: ability checks. Bottom row: saving throws (outlined = proficient).</div>`;
}

function renderSkills(c, s, d) {
  return `<div class="skills">${SKILLS.map(([k, n, ab]) => {
    const p = c.skillProficiencies.includes(k) ? (c.expertise.includes(k) ? "e" : "p") : "";
    return `<div class="skill" data-act="skill" data-k="${k}"><span class="dot ${p}"></span><span class="nm">${n}</span><span class="ab">${ab}</span><span class="mod">${sgn(d.skills[k])}</span></div>`;
  }).join("")}</div>`;
}

function renderAttacks(c, s, d) {
  const rows = c.attacks.map((a, i) => {
    const la = UI.lastAttack[c.id];
    const critReady = la && la.i === i && la.crit && Date.now() - la.t < 90000;
    return `<div class="row"><div class="nm">${esc(a.name)}<small>${esc(a.type)}${a.range ? " " + esc(a.range) + " ft" : ""} · ${esc(a.damageType)}${a.note ? " · " + esc(a.note) : ""}${a.quantity ? " · ×" + a.quantity : ""}</small></div>
      <div class="btns"><button data-act="hit" data-i="${i}">Hit ${sgn(a.attackBonus)}</button>
      <button data-act="dmg" data-i="${i}" ${critReady ? 'class="primary"' : ""}>${critReady ? "Crit dmg" : "Dmg"} ${esc(a.damage)}</button>
      ${d.sneakDie ? `<button class="sm" data-act="sneak" data-i="${i}" title="Sneak Attack">+${d.sneakDie}</button>` : ""}</div></div>`;
  }).join("");
  const note = d.critAt < 20 ? `<div class="muted" style="font-size:11px">Improved Critical: weapon attacks crit on 19–20.</div>` : "";
  return rows + note;
}

function pips(res, actUse = "use", actRestore = "restore") {
  const dots = [];
  for (let i = 0; i < res.max; i++) dots.push(`<span class="pip ${i < res.max - res.used ? "" : "used"}" data-act="pip" data-r="${esc(res.name)}" data-i="${i}" title="Click to toggle"></span>`);
  return `<span class="pips">${res.max <= 12 ? dots.join("") : ""}<span class="cnt">${res.max - res.used}/${res.max}</span></span>`;
}

function renderFeatures(c, s, d) {
  const ki = d.resources["Ki"];
  return d.features.map((f) => {
    const open = UI.open["f:" + f.name] ? " open" : "";
    const res = d.resources[f.name];
    const left = res ? res.max - res.used : null;
    let controls = "";
    if (f.name === "Lay on Hands" && res) {
      controls = `${pips(res)} <span class="poolbox"><input type="number" id="loh" min="1" max="${left}" value="${Math.min(5, left)}" style="width:48px"><button class="sm" data-act="layOnHands" ${left <= 0 ? "disabled" : ""}>Heal</button></span>`;
    } else if (f.name === "Second Wind" && res) {
      controls = `${pips(res)} <button class="sm" data-act="secondWind" ${left <= 0 ? "disabled" : ""}>Use & heal 1d10+${d.lvl}</button>`;
    } else if (f.name === "Stone's Endurance" && res) {
      controls = `${pips(res)} <button class="sm" data-act="useRoll" data-r="${esc(f.name)}" data-roll="1d12+2" ${left <= 0 ? "disabled" : ""}>Use & roll 1d12+2</button>`;
    } else if (f.name === "Divine Smite" && d.spell) {
      const opts = Object.keys(d.spell.slots).filter((L) => (d.spell.slots[L] - (s.slotsUsed[L] || 0)) > 0);
      controls = `<label class="muted" style="font-size:11px"><input type="checkbox" id="smiteUndead"> vs Undead/Fiend</label> ${opts.length ? opts.map((L) => `<button class="sm" data-act="smite" data-l="${L}">Smite (${ORD[L]} slot)</button>`).join("") : `<span class="muted" style="font-size:11px">No slots left</span>`}`;
    } else if (f.name === "Deflect Missiles") {
      controls = `<button class="sm" data-act="rollFeat" data-n="${esc(f.name)}" data-roll="1d10+5">Reduce 1d10+5</button> <button class="sm" data-act="throwBack" ${!ki || ki.max - ki.used <= 0 ? "disabled" : ""}>Throw back (1 ki)</button>`;
    } else if (f.name === "Flurry of Blows") {
      controls = `<button class="sm" data-act="flurry" ${!ki || ki.max - ki.used <= 0 ? "disabled" : ""}>Use (1 ki) & roll 2 strikes</button>`;
    } else if (f.cost && ki) {
      controls = `<button class="sm" data-act="spendKi" data-n="${esc(f.name)}" ${ki.max - ki.used <= 0 ? "disabled" : ""}>Use (${f.cost} ki)</button>`;
    } else if (f.name === "Sneak Attack" && d.sneakDie) {
      controls = `<button class="sm" data-act="rollFeat" data-n="Sneak Attack" data-roll="${d.sneakDie}">Roll ${d.sneakDie}</button>`;
    } else if (res) {
      controls = `${pips(res)} <button class="sm" data-act="use" data-r="${esc(f.name)}" ${left <= 0 ? "disabled" : ""}>Use</button>`;
      if (f.roll) controls += ` <button class="sm" data-act="rollFeat" data-n="${esc(f.name)}" data-roll="${esc(f.roll.replace("{level}", d.lvl))}">Roll</button>`;
    } else if (f.roll) {
      controls = `<button class="sm" data-act="rollFeat" data-n="${esc(f.name)}" data-roll="${esc(f.roll.replace("{level}", d.lvl))}">Roll ${esc(f.roll.replace("{level}", d.lvl))}</button>`;
    }
    const act = f.action ? `<span class="tag">${esc(f.action)}</span>` : "";
    const rech = res ? `<span class="tag">${res.recharge} rest</span>` : "";
    return `<div class="feat${open}"><div class="top"><span class="nm" data-act="toggleFeat" data-n="${esc(f.name)}">${esc(f.name)}</span>${act}${rech}<span class="lvl">L${f.atLevel}</span>${controls}</div><div class="desc">${esc(f.description)}</div></div>`;
  }).join("");
}

function spellRow(c, s, d, name, { always = false } = {}) {
  const sp = SPELLS[name] || { level: 1, text: "(no description)" };
  const open = UI.open["s:" + name] ? " open" : "";
  let btns = "";
  if (sp.level === 0) btns = `<button class="sm" data-act="cast" data-n="${esc(name)}" data-l="0">Cast</button>`;
  else {
    const opts = Object.keys(d.spell.slots).filter((L) => +L >= sp.level && (d.spell.slots[L] - (s.slotsUsed[L] || 0)) > 0);
    btns = opts.length ? opts.map((L) => `<button class="sm" data-act="cast" data-n="${esc(name)}" data-l="${L}">Cast ${ORD[L]}</button>`).join("") : `<button class="sm" disabled>No slots</button>`;
    if (sp.ritual) btns += ` <button class="sm ghost" data-act="cast" data-n="${esc(name)}" data-l="ritual">Ritual</button>`;
  }
  const tags = [sp.concentration ? "conc." : "", sp.ritual ? "ritual" : ""].filter(Boolean).map((t) => `<span class="tag">${t}</span>`).join("");
  const rollTxt = sp.roll ? describeRoll(sp.roll, d) : "";
  return `<div class="spell${open}"><div class="top"><span class="nm" data-act="toggleSpell" data-n="${esc(name)}">${esc(name)}${always ? "<small>(always)</small>" : ""}</span>${tags}<span class="btns">${btns}</span></div>
    <div class="detail"><b>${sp.time}</b> · ${sp.range} · ${sp.duration}${rollTxt ? " · " + rollTxt : ""}<br>${esc(sp.text)}</div></div>`;
}
function describeRoll(r, d) {
  if (r.kind === "attack") return `spell attack ${sgn(d.spell.atk)}, ${r.damage.replace("{mod}", d.spell.mod)} ${r.type}`;
  if (r.kind === "save") return `DC ${d.spell.dc} ${r.save.toUpperCase()} save${r.damage ? `, ${r.damage} ${r.type}${r.half ? " (half)" : ""}` : ""}`;
  if (r.kind === "heal") return `heals ${r.formula.replace("{mod}", d.spell.mod)}`;
  if (r.kind === "missiles") return `${r.darts} darts × ${r.each} ${r.type}`;
  if (r.kind === "pool") return `${r.formula} HP pool`;
  return "";
}

function renderSpells(c, s, d) {
  const sp = d.spell;
  const slots = Object.keys(sp.slots).map((L) => {
    const max = sp.slots[L], used = s.slotsUsed[L] || 0;
    const dots = []; for (let i = 0; i < max; i++) dots.push(`<span class="pip ${i < max - used ? "" : "used"}" data-act="slot" data-l="${L}" data-i="${i}"></span>`);
    return `<div class="slotlvl"><span class="lbl">${ORD[L]}</span><span class="pips">${dots.join("")}<span class="cnt">${max - used}/${max}</span></span></div>`;
  }).join("");
  const head = `<div class="slots">${slots}<span class="spacer"></span><span class="muted" style="font-size:11px">DC ${sp.dc} · atk ${sgn(sp.atk)} · ${sp.ability.toUpperCase()}</span></div>`;
  const cant = sp.cantrips.length ? `<div class="subhead">Cantrips</div>${sp.cantrips.map((n) => spellRow(c, s, d, n)).join("")}` : "";
  const prepped = [...sp.always.map((n) => spellRow(c, s, d, n, { always: true })), ...sp.prep.map((n) => spellRow(c, s, d, n))].join("");
  const manage = `<div class="subhead flex">Prepared ${sp.prep.length}/${sp.prepCount}${sp.always.length ? ` (+${sp.always.length} always)` : ""}<span class="spacer"></span><button class="sm" data-act="prepOpen">${UI.prepOpen ? "Done" : "Change prepared…"}</button></div>`;
  let prepUI = "";
  if (UI.prepOpen) {
    const list = sp.known.filter((n) => !sp.always.includes(n)).sort((a, b) => (SPELLS[a]?.level ?? 0) - (SPELLS[b]?.level ?? 0) || a.localeCompare(b));
    prepUI = `<div class="prep notice">${list.map((n) => { const on = sp.prep.includes(n); const dis = !on && sp.prep.length >= sp.prepCount; return `<label><input type="checkbox" data-act="prepToggle" data-n="${esc(n)}" ${on ? "checked" : ""} ${dis ? "disabled" : ""}> ${esc(n)} <span class="tag">${ORD[SPELLS[n]?.level] || "cantrip"}</span></label>`; }).join("")}
      ${sp.always.map((n) => `<label class="always"><input type="checkbox" checked disabled> ${esc(n)} <span class="tag">always</span></label>`).join("")}
      <div class="muted" style="font-size:11px;margin-top:4px">Prepared spells can be changed after a long rest.</div></div>`;
  }
  const book = sp.isWizard ? `<div class="subhead">Spellbook</div><div class="muted" style="font-size:12px">${sp.known.map(esc).join(", ")}</div>` : "";
  return head + cant + manage + prepUI + prepped + book;
}

function renderRest(c, s, d, isGM) {
  let restUI = "";
  if (UI.rest === "short") {
    const n = UI.restHd || 0;
    const ar = d.resources["Arcane Recovery"];
    const arUI = ar ? `<div class="row"><div class="nm">Arcane Recovery<small>${ar.max - ar.used ? "available" : "already used today"}</small></div><div class="btns">
      ${d.lvl >= 3 ? `<button class="sm" data-act="arcane" data-m="two1" ${ar.max - ar.used ? "" : "disabled"}>Two 1st-level slots</button><button class="sm" data-act="arcane" data-m="one2" ${ar.max - ar.used ? "" : "disabled"}>One 2nd-level slot</button>` : `<button class="sm" data-act="arcane" data-m="one1" ${ar.max - ar.used ? "" : "disabled"}>One 1st-level slot</button>`}</div></div>` : "";
    const shortRes = Object.values(d.resources).filter((r) => r.recharge === "short" && r.used > 0).map((r) => r.name);
    restUI = `<div class="notice">
      <div class="row"><div class="nm">Spend hit dice<small>${d.hdLeft} of ${d.hdTotal} ${c.hp.hitDie} left · each heals 1${c.hp.hitDie} ${sgn(d.mods.con)}</small></div>
        <div class="btns"><button class="sm" data-act="hdDelta" data-v="-1" ${n <= 0 ? "disabled" : ""}>−</button><b>${n}</b><button class="sm" data-act="hdDelta" data-v="1" ${n >= d.hdLeft ? "disabled" : ""}>+</button><button class="sm primary" data-act="hdRoll" ${n <= 0 ? "disabled" : ""}>Roll & heal</button></div></div>
      ${arUI}
      <div class="row"><div class="nm">Finish short rest<small>${shortRes.length ? "Recovers: " + esc(shortRes.join(", ")) : "Nothing else to recover"}</small></div><div class="btns"><button class="sm primary" data-act="shortRestDone">Finish</button><button class="sm ghost" data-act="restCancel">Cancel</button></div></div>
    </div>`;
  } else if (UI.rest === "long") {
    restUI = `<div class="notice">Long rest: full HP, temp HP cleared, all features and spell slots recovered, ${Math.max(1, Math.floor(d.lvl / 2))} hit ${d.lvl >= 4 ? "dice" : "die"} regained.<br>
      <button class="sm primary" data-act="longRestDone">Confirm long rest</button> <button class="sm ghost" data-act="restCancel">Cancel</button></div>`;
  }
  let lvlUI = "";
  if (d.lvl >= MAX_LEVEL) lvlUI = `<div class="muted" style="font-size:12px">Level ${d.lvl} — maximum for this adventure.</div>`;
  else if (!isGM) lvlUI = `<div class="muted" style="font-size:12px">Level ${d.lvl}. The DM levels you up from their screen.</div>`;
  else if (UI.levelup && UI.levelup.charId === c.id) lvlUI = renderLevelUp(c, s, d);
  else lvlUI = `<button data-act="levelupOpen">Level up to ${d.lvl + 1}…</button>`;
  return `<div class="flex" style="margin-bottom:6px"><button data-act="rest" data-v="short">Short rest…</button><button data-act="rest" data-v="long">Long rest…</button><span class="spacer"></span>${lvlUI.startsWith("<button") ? lvlUI : ""}</div>${restUI}${lvlUI.startsWith("<button") ? "" : lvlUI}`;
}

function renderLevelUp(c, s, d) {
  const L = d.lvl + 1, lu = UI.levelup;
  const feats = (c.featuresByLevel[String(L)] || []).map((f) => `<div class="gain"><b>${esc(f.name)}</b> <span class="muted">${esc(f.description)}</span></div>`).join("");
  const sc = c.spellcasting; let spellTxt = "";
  if (sc) {
    const slots = sc.slotsByLevel[String(L)];
    if (slots) spellTxt += `<div class="gain"><b>Spell slots</b> ${Object.keys(slots).map((k) => `${slots[k]}× ${ORD[k]}`).join(", ")} · prepare ${sc.preparedCountByLevel[String(L)]}</div>`;
    const always = (sc.alwaysPreparedByLevel || {})[String(L)];
    if (always) spellTxt += `<div class="gain"><b>Always prepared</b> ${esc(always.join(", "))}</div>`;
  }
  const die = d.hitDieSides, bonus = c.hp.hpPerLevelBonus, avg = DIE_AVG[c.hp.hitDie] + bonus;
  const hpUI = lu.hp == null
    ? `<button class="sm" data-act="luHp" data-m="roll">Roll 1${c.hp.hitDie}+${bonus}</button> <button class="sm" data-act="luHp" data-m="avg">Take average (${avg})</button>`
    : `<b>+${lu.hp} HP</b> <span class="muted">(${lu.hpText})</span> <button class="sm ghost" data-act="luHpReset">change</button>`;
  let picks = "";
  if (sc && sc.spellbook) {
    const maxL = Math.max(...Object.keys(sc.slotsByLevel[String(L)]).map(Number));
    const known = [...sc.spellbook, ...(s.book || [])];
    const options = [];
    for (const lv of Object.keys(sc.availableSpells)) if (+lv <= maxL) for (const n of sc.availableSpells[lv]) if (!known.includes(n)) options.push(n);
    picks = `<div class="gain"><b>Add 2 spells to spellbook</b> (${lu.picks.length}/2)</div><div class="prep">${options.map((n) => `<label><input type="checkbox" data-act="luPick" data-n="${esc(n)}" ${lu.picks.includes(n) ? "checked" : ""} ${!lu.picks.includes(n) && lu.picks.length >= 2 ? "disabled" : ""}> ${esc(n)} <span class="tag">${ORD[SPELLS[n]?.level]}</span></label>`).join("")}</div>`;
  }
  const ready = lu.hp != null && (!(sc && sc.spellbook) || lu.picks.length === 2);
  return `<div class="notice levelup"><div class="gain" style="font-size:14px"><b>${esc(c.name)} → level ${L}</b></div>
    <div class="gain"><b>Hit points</b> ${hpUI}</div>${feats}${spellTxt}${picks}
    <div class="flex" style="margin-top:6px"><button class="primary" data-act="luConfirm" ${ready ? "" : "disabled"}>Confirm level ${L}</button><button class="ghost" data-act="luCancel">Cancel</button></div></div>`;
}

function renderLogInner() {
  if (!UI.log.length) return `<div class="muted">No rolls yet.</div>`;
  return UI.log.map((e, i) => {
    const cls = e.crit || e.nat20 || e.good ? " crit" : e.fumble ? " fumble" : "";
    const time = new Date(e.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const lucky = e.lucky && e.charId === UI.charId && i === UI.log.findIndex((x) => x.lucky && x.charId === e.charId) && Date.now() - e.t < 120000
      ? ` <button class="sm lucky" data-act="luckyReroll" data-i="${i}">Lucky: reroll the 1</button>` : "";
    return `<div class="e${cls}"><span class="who">${esc(e.who)}</span> ${esc(e.label)}${e.total != null ? `<span class="tot">${e.total}</span>` : ""}${e.crit ? " <b>CRIT</b>" : e.nat20 ? " <b>nat 20</b>" : ""}${e.fumble ? " <b>nat 1</b>" : ""}${lucky}<br><span class="det">${esc(e.text || "")} <span style="float:right">${time}</span></span></div>`;
  }).join("");
}
function renderLog() { const el = document.getElementById("log"); if (el) el.innerHTML = renderLogInner(); }

let toastT;
function toast(text) {
  const el = document.getElementById("toast"); if (!el) return;
  el.textContent = text; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function subst(formula, d) { return String(formula).replace("{level}", d.lvl).replace("{mod}", d.spell ? d.spell.mod : 0).replace("{prof}", PROF); }

function addUpcast(formula, upcast, slotL, spellL) {
  const extra = Math.max(0, slotL - spellL);
  if (!upcast || !extra) return formula;
  const t = parseTerms(upcast)[0];
  return `${formula}+${t.count * extra}d${t.sides}`;
}

function castSpell(c, s, d, name, slotArg) {
  const sp = SPELLS[name] || { level: 1 };
  const ritual = slotArg === "ritual";
  const slotL = ritual ? sp.level : +slotArg;
  const label = `casts ${name}${slotL > sp.level ? ` (${ORD[slotL]}-level slot)` : ritual ? " (ritual)" : ""}`;
  const r = sp.roll;
  let text = "", total = null, kind = "info", crit = false;
  if (r) {
    if (r.kind === "attack") {
      const hit = rollD20(d.spell.atk, UI.adv, 20);
      const dmg = rollFormula(subst(addUpcast(r.damage, r.upcast, slotL, sp.level), d), { double: hit.crit });
      total = hit.total; kind = "attack"; crit = hit.crit;
      text = `attack ${hit.text} → ${hit.total}${hit.crit ? " CRIT" : ""} · damage ${dmg.text} = ${dmg.total} ${r.type}`;
      if (UI.adv !== 0) { UI.adv = 0; }
    } else if (r.kind === "save") {
      text = `DC ${d.spell.dc} ${r.save.toUpperCase()} save`;
      if (r.damage) { const dmg = rollFormula(subst(addUpcast(r.damage, r.upcast, slotL, sp.level), d)); total = dmg.total; kind = "damage"; text += ` · ${dmg.text} = ${dmg.total} ${r.type}${r.half ? " (half on save)" : ""}`; }
    } else if (r.kind === "heal") {
      let f = subst(addUpcast(r.formula, r.upcast, slotL, sp.level), d);
      if (d.spell.discipleOfLife && sp.level > 0) f += `+${2 + slotL}`;
      const h = rollFormula(f); total = h.total; kind = "heal"; text = `heals ${h.text} = ${h.total}${d.spell.discipleOfLife && sp.level > 0 ? " (incl. Disciple of Life)" : ""}`;
    } else if (r.kind === "missiles") {
      const darts = r.darts + Math.max(0, slotL - sp.level); const parts = []; let sum = 0;
      for (let i = 0; i < darts; i++) { const x = rollFormula(r.each); parts.push(x.total); sum += x.total; }
      total = sum; kind = "damage"; text = `${darts} darts: ${parts.join(" + ")} = ${sum} ${r.type}`;
    } else if (r.kind === "pool") {
      const p = rollFormula(addUpcast(r.formula, r.upcast, slotL, sp.level)); total = p.total; kind = "info"; text = `${p.text} = ${p.total} HP of creatures`;
    }
  }
  post(c, { label, total, text, kind, crit });
  if (sp.level > 0 && !ritual) update(c.id, (st) => { st.slotsUsed[slotL] = (st.slotsUsed[slotL] || 0) + 1; });
  else render();
}

async function onAction(act, el, ev) {
  const c = UI.charId ? byId(UI.charId) : null;
  const s = c ? stateOf(c.id) : null;
  const d = c ? derive(c, s) : null;
  const ds = el.dataset;
  switch (act) {
    case "toggleSec": UI.open[ds.id] = UI.open[ds.id] === false; saveUi(); render(); break;
    case "toggleFeat": UI.open["f:" + ds.n] = !UI.open["f:" + ds.n]; render(); break;
    case "toggleSpell": UI.open["s:" + ds.n] = !UI.open["s:" + ds.n]; render(); break;
    case "menu": UI.menu = !UI.menu; render(); break;
    case "popups": UI.popups = !UI.popups; UI.menu = false; saveUi(); render(); break;
    case "claims": UI.acctClaimsOpen = !UI.acctClaimsOpen; UI.menu = false; render(); break;
    case "switch": UI.menu = false; UI.charId = null; saveUi(); render(); break;
    case "tab": UI.charId = ds.id; UI.levelup = null; UI.rest = null; UI.prepOpen = false; saveUi(); render(); break;
    case "claim": {
      UI.charId = ds.id; saveUi();
      const claims = { ...(META[CLAIMS_KEY] || {}) };
      claims[ME.id] = { charId: ds.id, name: ME.name, id: ME.id };
      META[CLAIMS_KEY] = claims; render();
      await B.setMeta({ [CLAIMS_KEY]: claims });
      break;
    }
    case "resetChar": UI.menu = false; UI.confirmReset = true; render(); break;
    case "cancelReset": UI.confirmReset = false; render(); break;
    case "resetChar2": UI.confirmReset = false; await update(c.id, (st) => Object.assign(st, defaults(c))); post(c, { label: "was reset to level 1 by the DM", kind: "info" }); break;

    case "adv": UI.adv = +ds.v; renderRollbar(); break;
    case "customRoll": {
      const f = document.getElementById("custom").value.trim(); if (!f) break;
      if (/^(\d*d20)?\s*([+-]\s*\d+)?$/i.test(f) && /d20/i.test(f)) { const b = +(f.replace(/\s+/g, "").replace(/^\d*d20/i, "") || 0); d20Roll(c, d, `rolls ${f}`, b, "custom"); }
      else { try { const r = rollFormula(f); post(c, { label: `rolls ${f}`, total: r.total, text: r.text, kind: "custom" }); } catch { toast("Can't read that formula"); } }
      document.getElementById("custom").value = "";
      break;
    }
    case "check": d20Roll(c, d, `${ABIL_NAME[ds.a]} check`, d.mods[ds.a]); break;
    case "save": d20Roll(c, d, `${ABIL_NAME[ds.a]} save`, d.saves[ds.a], "save"); break;
    case "skill": { const sk = SKILLS.find((x) => x[0] === ds.k); d20Roll(c, d, `${sk[1]} check`, d.skills[ds.k]); break; }
    case "initiative": d20Roll(c, d, "Initiative", c.initiative, "initiative"); break;

    case "hit": {
      const a = c.attacks[+ds.i];
      const r = d20Roll(c, d, `${a.name} attack`, a.attackBonus, "attack");
      UI.lastAttack[c.id] = { i: +ds.i, crit: r.crit, t: Date.now() };
      render();
      break;
    }
    case "dmg": {
      const a = c.attacks[+ds.i]; const la = UI.lastAttack[c.id];
      const crit = la && la.i === +ds.i && la.crit && Date.now() - la.t < 90000;
      const r = rollFormula(a.damage, { double: crit });
      post(c, { label: `${a.name} damage${crit ? " (critical)" : ""}`, total: r.total, text: `${r.text} ${a.damageType}`, kind: "damage" });
      if (crit) { UI.lastAttack[c.id] = null; render(); }
      break;
    }
    case "sneak": { const la = UI.lastAttack[c.id]; const crit = la && la.i === +ds.i && la.crit && Date.now() - la.t < 90000; const r = rollFormula(d.sneakDie, { double: crit }); post(c, { label: `Sneak Attack${crit ? " (critical)" : ""}`, total: r.total, text: r.text, kind: "damage" }); break; }
    case "rollFeat": { const r = rollFormula(ds.roll); post(c, { label: ds.n, total: r.total, text: r.text, kind: "feature" }); break; }

    case "damage": case "heal": {
      const inp = document.getElementById("hpamt"); const n = Math.max(0, parseInt(inp.value || "0", 10)); if (!n) break;
      await update(c.id, (st) => {
        if (act === "damage") { let left = n; const fromT = Math.min(st.thp, left); st.thp -= fromT; left -= fromT; st.hp = Math.max(0, st.hp - left); if (st.hp === 0 && left >= d.maxHp) st.ds.f = 3; }
        else { if (st.hp === 0) st.ds = { s: 0, f: 0 }; st.hp = Math.min(d.maxHp, st.hp + n); }
      });
      post(c, { label: act === "damage" ? `takes ${n} damage` : `heals ${n}`, kind: "info", text: `HP ${stateOf(c.id).hp}/${d.maxHp}` });
      break;
    }
    case "editAc": if (!UI.editAc && !ev.target.closest("input")) { UI.editAc = true; render(); const i = document.querySelector('input[data-field="ac"]'); if (i) { i.focus(); i.select(); } } break;
    case "mageArmor": await update(c.id, (st) => { st.acOverride = el.checked ? 15 : null; }); break;
    case "deathSave": {
      const r = rollD20(0, UI.adv, 20); UI.adv = 0;
      let txt = r.text, outcome;
      await update(c.id, (st) => {
        if (r.d20 === 20) { st.hp = 1; st.ds = { s: 0, f: 0 }; outcome = "nat 20 — back up with 1 HP!"; }
        else if (r.d20 === 1) { st.ds.f = Math.min(3, st.ds.f + 2); outcome = "nat 1 — two failures"; }
        else if (r.total >= 10) { st.ds.s = Math.min(3, st.ds.s + 1); outcome = "success"; if (st.ds.s >= 3) { outcome = "third success — stable"; st.ds = { s: 0, f: 0 }; } }
        else { st.ds.f = Math.min(3, st.ds.f + 1); outcome = "failure"; if (st.ds.f >= 3) outcome = "third failure…"; }
      });
      post(c, { label: `Death save: ${outcome}`, total: r.total, text: txt, kind: "save", nat20: r.d20 === 20, fumble: r.d20 === 1 });
      break;
    }
    case "ds": await update(c.id, (st) => { const i = +ds.i; st.ds[ds.k] = st.ds[ds.k] > i ? i : i + 1; }); break;
    case "stabilize": await update(c.id, (st) => { st.ds = { s: 0, f: 0 }; }); post(c, { label: "is stable", kind: "info" }); break;

    case "pip": { const r = d.resources[ds.r]; const i = +ds.i; await update(c.id, (st) => { const left = r.max - (st.used[ds.r] || 0); st.used[ds.r] = left > i ? r.max - i : r.max - i - 1; st.used[ds.r] = Math.max(0, Math.min(r.max, st.used[ds.r])); }); break; }
    case "use": await update(c.id, (st) => { st.used[ds.r] = (st.used[ds.r] || 0) + 1; }); post(c, { label: `uses ${ds.r}`, kind: "feature" }); break;
    case "useRoll": { const r = rollFormula(ds.roll); await update(c.id, (st) => { st.used[ds.r] = (st.used[ds.r] || 0) + 1; }); post(c, { label: `uses ${ds.r}`, total: r.total, text: r.text, kind: "feature" }); break; }
    case "secondWind": { const r = rollFormula(`1d10+${d.lvl}`); await update(c.id, (st) => { st.used["Second Wind"] = (st.used["Second Wind"] || 0) + 1; st.hp = Math.min(d.maxHp, st.hp + r.total); }); post(c, { label: "Second Wind", total: r.total, text: `${r.text} HP regained`, kind: "heal" }); break; }
    case "layOnHands": { const n = Math.max(1, parseInt(document.getElementById("loh").value || "0", 10)); const r = d.resources["Lay on Hands"]; const amt = Math.min(n, r.max - r.used); if (!amt) break; await update(c.id, (st) => { st.used["Lay on Hands"] = (st.used["Lay on Hands"] || 0) + amt; }); post(c, { label: `Lay on Hands`, total: amt, text: `${amt} HP healed · ${r.max - r.used - amt} left in pool`, kind: "heal" }); break; }
    case "spendKi": await update(c.id, (st) => { st.used["Ki"] = (st.used["Ki"] || 0) + 1; }); post(c, { label: `uses ${ds.n} (1 ki)`, kind: "feature" }); break;
    case "flurry": {
      const ua = c.attacks.find((a) => a.name === "Unarmed Strike");
      const r1 = rollD20(ua.attackBonus, UI.adv, 20), r2 = rollD20(ua.attackBonus, UI.adv, 20); UI.adv = 0;
      await update(c.id, (st) => { st.used["Ki"] = (st.used["Ki"] || 0) + 1; });
      post(c, { label: "Flurry of Blows (1 ki): two unarmed strikes", text: `strike 1: ${r1.text} → ${r1.total}${r1.crit ? " CRIT" : ""} · strike 2: ${r2.text} → ${r2.total}${r2.crit ? " CRIT" : ""} · each hit ${ua.damage}`, kind: "attack", crit: r1.crit || r2.crit });
      break;
    }
    case "throwBack": {
      const r = rollD20(4, UI.adv, 20); UI.adv = 0; const dmg = rollFormula("1d4+2", { double: r.crit });
      await update(c.id, (st) => { st.used["Ki"] = (st.used["Ki"] || 0) + 1; });
      post(c, { label: "Deflect Missiles: throws it back (1 ki)", total: r.total, text: `${r.text} · damage ${dmg.text} = ${dmg.total}`, kind: "attack", crit: r.crit });
      break;
    }
    case "smite": {
      const L = +ds.l; const undead = document.getElementById("smiteUndead")?.checked;
      const r = rollFormula(`${1 + L}d8${undead ? "+1d8" : ""}`);
      await update(c.id, (st) => { st.slotsUsed[L] = (st.slotsUsed[L] || 0) + 1; });
      post(c, { label: `Divine Smite (${ORD[L]} slot${undead ? ", vs Undead/Fiend" : ""})`, total: r.total, text: `${r.text} radiant`, kind: "damage" });
      break;
    }

    case "slot": { const L = ds.l, i = +ds.i, max = d.spell.slots[L]; await update(c.id, (st) => { const left = max - (st.slotsUsed[L] || 0); st.slotsUsed[L] = left > i ? max - i : max - i - 1; st.slotsUsed[L] = Math.max(0, Math.min(max, st.slotsUsed[L])); }); break; }
    case "cast": castSpell(c, s, d, ds.n, ds.l); break;
    case "prepOpen": UI.prepOpen = !UI.prepOpen; render(); break;
    case "prepToggle": await update(c.id, (st) => { const i = st.prep.indexOf(ds.n); if (i >= 0) st.prep.splice(i, 1); else st.prep.push(ds.n); }); break;

    case "rest": UI.rest = ds.v; UI.restHd = 0; UI.levelup = null; render(); break;
    case "restCancel": UI.rest = null; render(); break;
    case "hdDelta": UI.restHd = Math.max(0, Math.min(d.hdLeft, (UI.restHd || 0) + +ds.v)); render(); break;
    case "hdRoll": {
      const n = UI.restHd || 0; if (!n) break;
      const r = rollFormula(`${n}${c.hp.hitDie}+${n * d.mods.con}`); const heal = Math.max(0, r.total);
      await update(c.id, (st) => { st.hdUsed = (st.hdUsed || 0) + n; st.hp = Math.min(d.maxHp, st.hp + heal); });
      UI.restHd = 0; post(c, { label: `spends ${n} hit ${n > 1 ? "dice" : "die"}`, total: heal, text: `${r.text} HP regained`, kind: "heal" }); render();
      break;
    }
    case "arcane": {
      await update(c.id, (st) => {
        st.used["Arcane Recovery"] = (st.used["Arcane Recovery"] || 0) + 1;
        if (ds.m === "one1") st.slotsUsed[1] = Math.max(0, (st.slotsUsed[1] || 0) - 1);
        if (ds.m === "two1") st.slotsUsed[1] = Math.max(0, (st.slotsUsed[1] || 0) - 2);
        if (ds.m === "one2") st.slotsUsed[2] = Math.max(0, (st.slotsUsed[2] || 0) - 1);
      });
      post(c, { label: "Arcane Recovery", text: ds.m === "one2" ? "recovers one 2nd-level slot" : ds.m === "two1" ? "recovers two 1st-level slots" : "recovers one 1st-level slot", kind: "feature" });
      break;
    }
    case "shortRestDone": {
      await update(c.id, (st) => { for (const r of Object.values(d.resources)) if (r.recharge === "short") delete st.used[r.name]; });
      UI.rest = null; post(c, { label: "finishes a short rest", kind: "info" }); render();
      break;
    }
    case "longRestDone": {
      await update(c.id, (st) => { st.hp = d.maxHp; st.thp = 0; st.used = {}; st.slotsUsed = {}; st.ds = { s: 0, f: 0 }; st.hdUsed = Math.max(0, (st.hdUsed || 0) - Math.max(1, Math.floor(d.lvl / 2))); st.acOverride = st.acOverride === 15 && c.id === "aren" ? null : st.acOverride; });
      UI.rest = null; post(c, { label: "finishes a long rest", kind: "info" }); render();
      break;
    }

    case "levelupOpen": UI.levelup = { charId: c.id, hp: null, hpText: "", picks: [] }; UI.rest = null; render(); break;
    case "luCancel": UI.levelup = null; render(); break;
    case "luHp": {
      const bonus = c.hp.hpPerLevelBonus;
      if (ds.m === "roll") { const r = rollFormula(`1${c.hp.hitDie}+${bonus}`); UI.levelup.hp = Math.max(1, r.total); UI.levelup.hpText = r.text; }
      else { UI.levelup.hp = DIE_AVG[c.hp.hitDie] + bonus; UI.levelup.hpText = `average ${DIE_AVG[c.hp.hitDie]} + ${bonus}`; }
      render(); break;
    }
    case "luHpReset": UI.levelup.hp = null; render(); break;
    case "luPick": { const p = UI.levelup.picks; const i = p.indexOf(ds.n); if (i >= 0) p.splice(i, 1); else if (p.length < 2) p.push(ds.n); render(); break; }
    case "luConfirm": {
      const lu = UI.levelup; const L = d.lvl + 1;
      await update(c.id, (st) => {
        st.lvl = L; st.hpGains.push(lu.hp); st.hp += lu.hp;
        if (lu.picks.length) st.book.push(...lu.picks);
        if (c.id === "arthur" && L === 2 && !st.prep.length) st.prep = DEFAULT_PREP.arthur.slice();
      });
      const gained = (c.featuresByLevel[String(L)] || []).map((f) => f.name).join(", ");
      post(c, { label: `reaches level ${L}!`, text: `+${lu.hp} HP${gained ? " · " + gained : ""}${lu.picks.length ? " · learns " + lu.picks.join(", ") : ""}`, kind: "info", good: true });
      UI.levelup = null; render();
      break;
    }

    case "luckyReroll": {
      const e = UI.log[+ds.i]; if (!e) break;
      const r = rollD20(e.bonus || 0, 0, e.kind === "attack" ? d.critAt : 20);
      UI.log.forEach((x) => { if (x.lucky && x.charId === c.id) x.lucky = false; });
      post(c, { label: `${e.label} (Lucky reroll)`, total: r.total, text: r.text, kind: e.kind, crit: e.kind === "attack" && r.crit, nat20: r.d20 === 20, fumble: r.fumble, bonus: e.bonus });
      break;
    }
  }
}

async function onField(field, el) {
  const c = byId(UI.charId); if (!c) return;
  if (field === "notes") await update(c.id, (st) => { st.notes = el.value.slice(0, 1500); });
  if (field === "thp") await update(c.id, (st) => { st.thp = Math.max(0, parseInt(el.value || "0", 10) || 0); });
  if (field === "ac") { const v = parseInt(el.value, 10); UI.editAc = false; await update(c.id, (st) => { st.acOverride = isNaN(v) || v === c.ac ? null : v; }); }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  B = await makeBackend();
  status(B.kind === "obr" ? "Connecting to Owlbear…" : "Starting in local test mode…");
  const slow = setTimeout(() => status(`Still waiting for Owlbear's ready signal (SDK ${OBR && OBR.isAvailable ? "available" : "not available"}). Try closing and reopening the panel.`), 8000);
  await B.ready();
  clearTimeout(slow);
  status("Loading character data…");
  const [chars, spells] = await Promise.all([fetch("characters.json").then((r) => r.json()), fetch("spells.json").then((r) => r.json())]);
  DATA = chars; SPELLS = spells;
  status("Reading room state…");
  ME = await B.player();
  META = (await B.getMeta()) || {};
  const applyTheme = (m) => document.documentElement.setAttribute("data-theme", m === "LIGHT" ? "light" : "dark");
  applyTheme(await B.theme()); B.onTheme(applyTheme);
  B.onMeta((m) => { META = m || {}; render(); });
  B.onMsg(addLog);
  B.onPlayer((p) => { ME = p; render(); });
  if (ME.role !== "GM") {
    const claims = META[CLAIMS_KEY] || {};
    if (!(claims[ME.id] && byId(claims[ME.id].charId))) UI.charId = null;
    else UI.charId = claims[ME.id].charId;
  }
  render();

  app.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    if (el.tagName === "INPUT" && el.type === "checkbox") return; // handled on change
    const act = el.dataset.act;
    if (act !== "menu" && UI.menu && !ev.target.closest(".menu")) { UI.menu = false; }
    onAction(act, el, ev).catch((e) => { console.error(e); toast("Something went wrong: " + e.message); });
  });
  app.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset.act && el.type === "checkbox") { onAction(el.dataset.act, el, ev).catch(console.error); return; }
    if (el.dataset.field) onField(el.dataset.field, el).catch(console.error);
  });
  app.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.dataset.enter) { ev.preventDefault(); const b = app.querySelector(`[data-act="${ev.target.dataset.enter}"]`); if (b) b.click(); }
    if (ev.key === "Enter" && ev.target.dataset.field === "ac") ev.target.blur();
    if (ev.key === "Enter" && ev.target.id === "hpamt") { ev.preventDefault(); app.querySelector('[data-act="damage"]').click(); }
  });
  app.addEventListener("focusout", () => { if (UI.dirty) setTimeout(() => { if (!isTyping()) render(); }, 50); });
  document.addEventListener("click", (ev) => { if (UI.menu && !ev.target.closest(".menu")) { UI.menu = false; render(); } });
}

boot().catch((e) => { console.error(e); app.innerHTML = `<div class="notice warn">Failed to start: ${esc(e.message)}</div>`; });
