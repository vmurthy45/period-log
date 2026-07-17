"use strict";
/* Period Log — offline-first period tracker. Data lives in localStorage on this device. */

const LS_DATA = "periodlog.v1";
const LS_THEME = "periodlog.theme";

/* ---------------- state & storage ---------------- */
let periods = [];   // {id, start, end, auto}  auto = end date was predicted, not user-set
let profile = {};   // {dob, weight, height, luteal, cycleOv, durOv}
let selected = null;        // ISO date shown in hero / sheet
let calFrom = null;         // first rendered month "YYYY-MM"
let editingPeriodId = null;
let currentTab = "cal";
let calScrolled = false;

function load() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (raw) {
      const d = JSON.parse(raw);
      periods = d.periods || [];
      profile = d.profile || {};
      return;
    }
  } catch (e) { /* corrupted store — start fresh */ }
  periods = [];
  profile = {};
}
function save() {
  localStorage.setItem(LS_DATA, JSON.stringify({ v: 1, periods, profile }));
}
function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2));
}

/* ---------------- date helpers (all UTC-based, ISO strings) ---------------- */
const DAY = 86400000;
const isoMs = (iso) => Date.parse(iso);                       // UTC midnight
const msISO = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => msISO(isoMs(iso) + n * DAY);
const dayDiff = (a, b) => Math.round((isoMs(b) - isoMs(a)) / DAY);
function todayISO() {
  const n = new Date();
  return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtNZDate = (iso) => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
const fmtShort = (iso) => { const [, m, d] = iso.split("-"); return +d + " " + MONTHS[+m - 1]; };
const fmtLong = (iso) => { const [y, m, d] = iso.split("-"); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
function fmtRange(a, b) {
  const [, ma] = a.split("-"), [, mb] = b.split("-");
  return ma === mb ? `${+a.slice(8)}–${+b.slice(8)} ${MONTHS[+ma - 1]}` : `${fmtShort(a)} – ${fmtShort(b)}`;
}
const monthKey = (iso) => iso.slice(0, 7);
function monthAdd(key, n) {
  let [y, m] = key.split("-").map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return y + "-" + String(m).padStart(2, "0");
}
const daysInMonth = (key) => { const [y, m] = key.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const fmtTick = (ms) => { const d = new Date(ms); return MONTHS[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2); };

/* ---------------- tiny DOM helpers ---------------- */
const $ = (s) => document.querySelector(s);
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
  return n;
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- derived data & predictions ---------------- */
function derived() {
  const list = [...periods].sort((a, b) => a.start.localeCompare(b.start)).map((p) => ({ ...p }));
  for (let i = 0; i < list.length; i++) {
    list[i].duration = dayDiff(list[i].start, list[i].end) + 1;
    list[i].cycle = i > 0 ? dayDiff(list[i - 1].start, list[i].start) : null;
  }
  return list;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function stats() {
  const list = derived();
  const cycles = list.filter((p) => p.cycle != null && p.cycle >= 15 && p.cycle <= 90).map((p) => p.cycle);
  const durs = list.map((p) => p.duration).filter((d) => d >= 1 && d <= 14);
  const recentCycles = cycles.slice(-6), recentDurs = durs.slice(-6);
  const avgCycle = profile.cycleOv || (recentCycles.length ? Math.round(mean(recentCycles)) : 28);
  const avgDur = profile.durOv || (recentDurs.length ? Math.round(mean(recentDurs)) : 5);
  const luteal = profile.luteal || 14;
  const last = list[list.length - 1] || null;
  // future predicted period starts (from the last logged start)
  const predStarts = [];
  if (last) for (let k = 1; k <= 24; k++) predStarts.push(addDays(last.start, k * avgCycle));
  return { list, cycles, recentCycles, avgCycle, avgDur, luteal, last, predStarts };
}

/* Per-day classification maps for the calendar + chance lookups.
   Historical ovulation uses the actual next period start; future uses predictions. */
function dayMaps(st) {
  const period = new Set(), pred = new Set(), ov = new Set(), high = new Set(), med = new Set();
  for (const p of st.list)
    for (let d = p.start; d <= p.end; d = addDays(d, 1)) period.add(d);
  for (const s of st.predStarts)
    for (let i = 0; i < st.avgDur; i++) {
      const d = addDays(s, i);
      if (!period.has(d)) pred.add(d);
    }
  const ovDates = [];
  for (let i = 1; i < st.list.length; i++) ovDates.push(addDays(st.list[i].start, -st.luteal));
  for (const s of st.predStarts) ovDates.push(addDays(s, -st.luteal));
  for (const o of ovDates) {
    if (!period.has(o) && !pred.has(o)) ov.add(o);
    for (let i = -5; i <= 2; i++) {
      const d = addDays(o, i);
      if (period.has(d) || pred.has(d)) continue;
      if (i >= -2 && i <= 1) high.add(d);
      else med.add(d);
    }
  }
  return { period, pred, ov, high, med };
}

function cycleDayFor(iso, st) {
  let best = null;
  for (const p of st.list) if (p.start <= iso) best = p.start;
  if (best == null) return null;
  return dayDiff(best, iso) + 1;
}

// {phase, predicted, chance, cycleDay, hue} for one date
function dayInfo(iso, st, maps) {
  const cycleDay = cycleDayFor(iso, st);
  if (!st.list.length) return { phase: null, predicted: false, chance: null, cycleDay, hue: "plain" };
  let phase = null, predicted = false, hue = "rose";
  if (maps.period.has(iso)) phase = "period";
  else if (maps.pred.has(iso)) { phase = "period"; predicted = true; }
  else if (maps.ov.has(iso)) { phase = "ovulation"; predicted = true; hue = "violet"; }
  else if (maps.high.has(iso) || maps.med.has(iso)) { phase = "fertile window"; predicted = true; hue = "violet"; }
  else hue = "plain";
  const chance = maps.high.has(iso) ? "High" : maps.med.has(iso) ? "Medium" : "Low";
  return { phase, predicted, chance, cycleDay, hue };
}

/* ---------------- tabs ---------------- */
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab").forEach((s) => { s.hidden = s.id !== "tab-" + name; });
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  if (name === "cal") { renderCalendar(); updateHero(); }
  if (name === "dash") renderDash();
  if (name === "history") renderHistory();
  if (name === "data") renderData();
  if (name !== "cal") window.scrollTo(0, 0);
}

/* ---------------- calendar ---------------- */
function calRange() {
  const today = todayISO();
  if (!calFrom) {
    const list = derived();
    const first = list.length ? monthKey(list[0].start) : monthAdd(monthKey(today), -5);
    calFrom = first < monthAdd(monthKey(today), -5) ? first : monthAdd(monthKey(today), -5);
  }
  return { from: calFrom, to: monthAdd(monthKey(today), 3) };
}

function renderCalendar() {
  const st = stats();
  const maps = dayMaps(st);
  const { from, to } = calRange();
  const today = todayISO();
  const box = $("#calendar");
  box.textContent = "";
  const dows = ["M", "T", "W", "T", "F", "S", "S"];
  for (let mk = from; mk <= to; mk = monthAdd(mk, 1)) {
    const [y, m] = mk.split("-").map(Number);
    const month = el("div", "month");
    month.id = "m-" + mk;
    month.appendChild(el("h4", null, MONTHS_FULL[m - 1] + (y === +today.slice(0, 4) ? "" : " " + y)));
    const dow = el("div", "dow");
    for (const d of dows) dow.appendChild(el("span", null, d));
    month.appendChild(dow);
    const n = daysInMonth(mk);
    const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
    let week = el("div", "week");
    for (let i = 0; i < firstDow; i++) {
      const blank = el("button", "day");
      blank.disabled = true;
      week.appendChild(blank);
    }
    for (let d = 1; d <= n; d++) {
      const iso = mk + "-" + String(d).padStart(2, "0");
      const b = el("button", "day");
      b.dataset.iso = iso;
      const num = el("span", "n", String(d));
      b.appendChild(num);
      if (maps.period.has(iso)) b.classList.add("period");
      else if (maps.pred.has(iso)) b.classList.add("pred");
      else if (maps.ov.has(iso)) b.classList.add("ov");
      else if (maps.high.has(iso) || maps.med.has(iso)) b.classList.add("fertile");
      if (iso === today) b.classList.add("today");
      if (iso === selected) b.classList.add("sel");
      b.addEventListener("click", () => selectDay(iso));
      week.appendChild(b);
      if ((firstDow + d) % 7 === 0 || d === n) {
        month.appendChild(week);
        week = el("div", "week");
      }
    }
    box.appendChild(month);
  }
  if (!calScrolled) {
    calScrolled = true;
    const cur = document.getElementById("m-" + monthKey(today));
    if (cur) requestAnimationFrame(() => cur.scrollIntoView({ block: "start" }));
  }
}

function selectDay(iso) {
  selected = iso;
  document.querySelectorAll(".day.sel").forEach((b) => b.classList.remove("sel"));
  const b = document.querySelector(`.day[data-iso="${iso}"]`);
  if (b) b.classList.add("sel");
  updateHero();
  openSheet(iso);
}

function updateHero() {
  const iso = selected || todayISO();
  const st = stats();
  const info = dayInfo(iso, st, dayMaps(st));
  $("#heroDate").textContent = (iso === todayISO() ? "Today, " : "") + fmtLong(iso);
  $("#heroPhase").textContent = info.phase || "—";
  $("#heroPhaseSub").textContent = info.phase ? (info.predicted ? "(prediction)" : "") : "no phase data";
  $("#heroChance").textContent = info.chance || "—";
  $("#heroCycleDay").textContent = info.cycleDay != null ? info.cycleDay : "—";
  const hero = $("#hero");
  hero.classList.toggle("violet", info.hue === "violet");
  hero.classList.toggle("plain", info.hue === "plain");
}

/* ---------------- bottom sheet ---------------- */
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheetBack").hidden = true;
  $("#editForm").hidden = true;
  editingPeriodId = null;
}

function openSheet(iso) {
  const st = stats();
  const maps = dayMaps(st);
  const info = dayInfo(iso, st, maps);
  $("#sheet").hidden = false;
  $("#sheetBack").hidden = false;
  $("#editForm").hidden = true;
  editingPeriodId = null;
  $("#sheetTitle").textContent = fmtLong(iso);

  const infoBox = $("#sheetInfo");
  infoBox.textContent = "";
  if (info.phase) {
    const pill = el("span", "pill" + (info.hue === "violet" ? " violet" : ""), info.phase + (info.predicted ? " · predicted" : ""));
    infoBox.appendChild(pill);
  }
  if (info.chance) infoBox.appendChild(el("span", "pill plain", info.chance + " chance of pregnancy"));
  if (info.cycleDay != null) infoBox.appendChild(el("span", "pill plain", "cycle day " + info.cycleDay));
  if (!st.list.length) infoBox.appendChild(el("div", "hint", "No periods logged yet — tap the button below on the first day of a period to get started."));

  const actions = $("#sheetActions");
  actions.textContent = "";
  const inPeriod = periods.find((p) => p.start <= iso && iso <= p.end);

  if (inPeriod) {
    if (iso !== inPeriod.end && iso >= inPeriod.start) {
      const endBtn = el("button", "btn primary", `End this period on ${fmtShort(iso)}`);
      endBtn.addEventListener("click", () => {
        inPeriod.end = iso;
        inPeriod.auto = false;
        afterChange(`Period set to ${fmtRange(inPeriod.start, inPeriod.end)}`);
      });
      actions.appendChild(endBtn);
    }
    const editBtn = el("button", "btn", "Edit dates…");
    editBtn.addEventListener("click", () => startSheetEdit(inPeriod));
    actions.appendChild(editBtn);
    const delBtn = el("button", "btn danger", "Delete this period");
    delBtn.addEventListener("click", () => {
      if (confirm(`Delete the period ${fmtRange(inPeriod.start, inPeriod.end)}?`)) {
        periods = periods.filter((p) => p.id !== inPeriod.id);
        afterChange("Period deleted");
      }
    });
    actions.appendChild(delBtn);
    return;
  }

  // extend the most recent earlier period to end here
  let prev = null;
  for (const p of periods) if (p.start <= iso && (!prev || p.start > prev.start)) prev = p;
  if (prev && iso > prev.end && dayDiff(prev.start, iso) < 21) {
    const extBtn = el("button", "btn violet", `Mark as end of period started ${fmtShort(prev.start)}`);
    extBtn.addEventListener("click", () => {
      prev.end = iso;
      prev.auto = false;
      afterChange(`Period set to ${fmtRange(prev.start, prev.end)} (${dayDiff(prev.start, iso) + 1} days)`);
    });
    actions.appendChild(extBtn);
  }

  // start a new period here
  let next = null;
  for (const p of periods) if (p.start > iso && (!next || p.start < next.start)) next = p;
  let predEnd = addDays(iso, st.avgDur - 1);
  if (next && predEnd >= next.start) predEnd = addDays(next.start, -1);
  if (!next || predEnd >= iso) {
    const startBtn = el("button", "btn primary", `Start period on ${fmtShort(iso)}`);
    startBtn.addEventListener("click", () => {
      periods.push({ id: uid(), start: iso, end: predEnd, auto: predEnd !== iso ? true : false });
      afterChange(`Period logged ${fmtRange(iso, predEnd)} — end is predicted, tap the real last day to adjust`);
    });
    actions.appendChild(startBtn);
    actions.appendChild(el("div", "hint",
      `End date will be pre-filled as ${fmtShort(predEnd)} from your average of ${st.avgDur} days. Tap the actual last day afterwards to correct it.`));
  }
}

function startSheetEdit(p) {
  editingPeriodId = p.id;
  $("#sheetActions").textContent = "";
  $("#editForm").hidden = false;
  $("#eStart").value = p.start;
  $("#eEnd").value = p.end;
}

function onEditSubmit(ev) {
  ev.preventDefault();
  const p = periods.find((x) => x.id === editingPeriodId);
  if (!p) return;
  const start = $("#eStart").value, end = $("#eEnd").value;
  if (!start || !end || end < start) { toast("End date must be on or after the start"); return; }
  if (dayDiff(start, end) > 20 && !confirm("That period is longer than 3 weeks — save anyway?")) return;
  const clash = periods.find((x) => x.id !== p.id && x.start <= end && start <= x.end);
  if (clash) { toast(`Overlaps the period ${fmtRange(clash.start, clash.end)}`); return; }
  p.start = start;
  p.end = end;
  p.auto = false;
  afterChange("Period updated");
}

function afterChange(msg) {
  save();
  closeSheet();
  renderCalendar();
  updateHero();
  if (msg) toast(msg);
}

/* ---------------- dashboard ---------------- */
function tile(label, value, unit, note, cls) {
  const t = el("div", "tile");
  t.appendChild(el("div", "t-label", label));
  const v = el("div", "t-value" + (cls ? " " + cls : ""), value);
  if (unit) v.appendChild(el("span", "t-unit", unit));
  t.appendChild(v);
  if (note) t.appendChild(el("div", "t-note", note));
  return t;
}

function renderDash() {
  const st = stats();
  const today = todayISO();
  const tiles = $("#tiles");
  tiles.textContent = "";

  if (!st.list.length) {
    tiles.appendChild(tile("No data yet", "—", "", "Log your first period on the Calendar tab"));
    $("#predBody").textContent = "";
    $("#predBody").appendChild(el("div", "empty", "Predictions appear after your first logged period."));
    clearChartBox($("#chartCycle"));
    clearChartBox($("#chartDur"));
    $("#insightsList").textContent = "";
    return;
  }

  const nextStart = st.predStarts.find((s) => s >= today) || st.predStarts[0];
  const late = st.last && dayDiff(st.last.start, today) >= st.avgCycle && today < nextStart;
  const daysTo = dayDiff(today, nextStart);
  const nextOv = addDays(nextStart, -st.luteal);
  const ovNote = nextOv >= today
    ? `fertile ${fmtRange(addDays(nextOv, -5), addDays(nextOv, 1))}`
    : "past for this cycle";
  const cycleDay = cycleDayFor(today, st);

  tiles.appendChild(tile("Avg cycle", String(st.avgCycle), "days",
    profile.cycleOv ? "manual override" : `last ${st.recentCycles.length || 0} cycles`));
  tiles.appendChild(tile("Avg duration", String(st.avgDur), "days", profile.durOv ? "manual override" : "of bleeding"));
  tiles.appendChild(tile("Next period", fmtShort(nextStart), "",
    daysTo > 0 ? `in ${daysTo} day${daysTo === 1 ? "" : "s"}` : daysTo === 0 ? "expected today" : `${-daysTo} days late`, "rose"));
  tiles.appendChild(tile("Ovulation", fmtShort(nextOv), "", ovNote, "accent"));
  tiles.appendChild(tile("Cycle day", cycleDay != null ? String(cycleDay) : "—", "", `since ${fmtShort(st.last.start)}`));
  tiles.appendChild(tile("Periods logged", String(st.list.length), "", `since ${fmtShort(st.list[0].start)}`));

  // upcoming predictions
  const pb = $("#predBody");
  pb.textContent = "";
  const upcoming = st.predStarts.filter((s) => addDays(s, st.avgDur - 1) >= today).slice(0, 3);
  for (const s of upcoming) {
    const ov = addDays(s, -st.luteal);
    const row = el("div", "pred-row");
    row.appendChild(el("span", "pr-when", fmtShort(s)));
    const d = el("div");
    d.append("Period ");
    d.appendChild(el("strong", null, fmtRange(s, addDays(s, st.avgDur - 1))));
    d.append(" · fertile ");
    const f = el("span", "fert", fmtRange(addDays(ov, -5), addDays(ov, 1)));
    d.appendChild(f);
    d.append(` · ovulation ${fmtShort(ov)}`);
    row.appendChild(d);
    pb.appendChild(row);
  }
  if (late) {
    const row = el("div", "pred-row");
    row.appendChild(el("span", "pr-when", "Note"));
    row.appendChild(el("div", null, `Your period is running later than your ${st.avgCycle}-day average — predictions shift once you log it.`));
    pb.prepend(row);
  }

  renderCycleChart(st);
  renderDurChart(st);
  renderInsights(st);
}

function renderCycleChart(st) {
  const pts = st.list.filter((p) => p.cycle != null).map((p, i, arr) => ({
    x: isoMs(p.start), y: p.cycle,
    tipLines: [
      { v: p.cycle + " days", label: "cycle", strong: true },
      { v: `ended ${fmtNZDate(p.start)}`, label: "" },
    ],
  }));
  lineChart($("#chartCycle"), pts, { fmtY: (v) => String(Math.round(v)) });
}

function renderDurChart(st) {
  const bars = st.list.map((p) => ({
    label: fmtShort(p.start).replace(" ", " "),
    y: p.duration,
    tipLines: [
      { v: p.duration + " days", label: "", strong: true },
      { v: fmtRange(p.start, p.end) + (p.auto ? " · end estimated" : ""), label: "" },
    ],
  }));
  barChart($("#chartDur"), bars, { fmtY: (v) => String(Math.round(v)) });
}

function renderInsights(st) {
  const ul = $("#insightsList");
  ul.textContent = "";
  const add = (emoji, frag) => {
    const li = el("li");
    li.appendChild(el("span", "em", emoji));
    const d = el("div");
    d.append(...frag);
    li.appendChild(d);
    ul.appendChild(li);
  };
  const b = (t) => el("strong", null, t);

  if (st.recentCycles.length >= 3) {
    const m = mean(st.recentCycles);
    const sd = Math.sqrt(mean(st.recentCycles.map((c) => (c - m) * (c - m))));
    add("📈", [`Your last ${st.recentCycles.length} cycles averaged `, b(m.toFixed(1) + " days"),
      `, varying by about `, b("±" + sd.toFixed(1) + " days"),
      sd <= 2 ? " — very regular." : sd <= 5 ? " — fairly regular." : " — quite variable, so predictions are rougher."]);
  }
  if (st.cycles.length >= 2) {
    const sorted = [...st.list].filter((p) => p.cycle != null).sort((a, c) => a.cycle - c.cycle);
    const lo = sorted[0], hi = sorted[sorted.length - 1];
    add("↕️", [`Shortest cycle `, b(lo.cycle + " days"), ` (ended ${fmtNZDate(lo.start)}), longest `,
      b(hi.cycle + " days"), ` (ended ${fmtNZDate(hi.start)}).`]);
  }
  const spanDays = dayDiff(st.list[0].start, st.list[st.list.length - 1].start);
  if (st.list.length >= 2) {
    add("🗓", [b(String(st.list.length) + " periods"), ` logged over `,
      b((spanDays / 30.44).toFixed(0) + " months"), ` — since ${fmtNZDate(st.list[0].start)}.`]);
  }
  if (profile.luteal && profile.luteal !== 14) {
    add("⚙️", [`Ovulation is predicted `, b(profile.luteal + " days"), ` before each period (custom luteal setting).`]);
  }
  if (!ul.childNodes.length) add("·", ["Log a few more periods to unlock trends."]);
}

/* ---------------- history ---------------- */
function renderHistory() {
  const st = stats();
  $("#avgCycleTxt").textContent = st.recentCycles.length || profile.cycleOv ? st.avgCycle + " days" : "—";
  $("#avgDurTxt").textContent = st.list.length || profile.durOv ? st.avgDur + " days" : "—";
  const tb = $("#historyBody");
  tb.textContent = "";
  if (!st.list.length) {
    const tr = el("tr");
    const td = el("td", "empty", "No periods logged yet.");
    td.colSpan = 4;
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  for (const p of [...st.list].reverse()) {
    const tr = el("tr");
    tr.appendChild(el("td", null, fmtNZDate(p.start)));
    const tdEnd = el("td", null, fmtNZDate(p.end));
    if (p.auto) tdEnd.appendChild(el("span", "auto", " est"));
    tr.appendChild(tdEnd);
    tr.appendChild(el("td", null, String(p.duration)));
    tr.appendChild(el("td", "cyc", p.cycle != null ? String(p.cycle) : "—"));
    tr.addEventListener("click", () => {
      switchTab("cal");
      selectDay(p.start);
      const real = periods.find((x) => x.id === p.id);
      if (real) startSheetEdit(real);
    });
    tb.appendChild(tr);
  }
}

/* ---------------- data tab ---------------- */
function renderData() {
  const st = stats();
  $("#dataSummary").textContent = st.list.length
    ? `${st.list.length} periods on this device · tracking since ${fmtNZDate(st.list[0].start)}.`
    : "No periods on this device yet.";
  $("#pDob").value = profile.dob || "";
  $("#pWeight").value = profile.weight ?? "";
  $("#pHeight").value = profile.height ?? "";
  $("#pLuteal").value = profile.luteal ?? "";
  $("#pCycleOv").value = profile.cycleOv ?? "";
  $("#pDurOv").value = profile.durOv ?? "";
  $("#shareBtn").hidden = !(navigator.share && navigator.canShare &&
    navigator.canShare({ files: [new File(["x"], "x.csv", { type: "text/csv" })] }));
}

function onProfileSubmit(ev) {
  ev.preventDefault();
  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
  profile = {
    dob: $("#pDob").value || null,
    weight: num("#pWeight"),
    height: num("#pHeight"),
    luteal: num("#pLuteal") ? Math.round(num("#pLuteal")) : null,
    cycleOv: num("#pCycleOv") ? Math.round(num("#pCycleOv")) : null,
    durOv: num("#pDurOv") ? Math.round(num("#pDurOv")) : null,
  };
  save();
  toast("Profile saved — predictions updated");
}

function toCSV() {
  const head = "Start date,End date,Duration (days),Cycle (days),End estimated";
  const lines = derived().map((p) =>
    [p.start, p.end, p.duration, p.cycle ?? "", p.auto ? "yes" : ""].join(","));
  return head + "\n" + lines.join("\n") + "\n";
}
function csvFileName() {
  return "period-log-" + new Date().toISOString().slice(0, 10) + ".csv";
}
function downloadCSV() {
  const blob = new Blob([toCSV()], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = csvFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast("CSV downloaded");
}
async function shareCSV() {
  try {
    await navigator.share({ files: [new File([toCSV()], csvFileName(), { type: "text/csv" })], title: "Period Log export" });
  } catch (e) { /* user cancelled the share sheet */ }
}

function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}
function parseDateCell(s) {
  s = (s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}
function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error("No data rows found");
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const iStart = col("start"), iEnd = col("end");
  if (iStart < 0) throw new Error("Missing a Start date column");
  const out = [];
  for (const r of rows.slice(1)) {
    const start = parseDateCell(r[iStart]);
    if (!start) continue;
    let end = iEnd >= 0 ? parseDateCell(r[iEnd]) : null;
    if (!end || end < start) end = addDays(start, 4);
    out.push({ id: uid(), start, end, auto: !(iEnd >= 0 && parseDateCell(r[iEnd])) });
  }
  if (!out.length) throw new Error("No valid rows found");
  out.sort((a, b) => a.start.localeCompare(b.start));
  // drop overlapping rows rather than fail the whole import
  const clean = [];
  for (const p of out) {
    const last = clean[clean.length - 1];
    if (last && p.start <= last.end) continue;
    clean.push(p);
  }
  return clean;
}

/* ---------------- charts (shared with the other Log apps) ---------------- */
function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = mag;
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= step0) { step = m * mag; break; }
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}
function clearChartBox(box) {
  box.textContent = "";
  box.appendChild(el("div", "empty", "Not enough data yet."));
}
function makeTip(box) {
  const tip = el("div", "viz-tip");
  tip.hidden = true;
  box.appendChild(tip);
  return tip;
}
function placeTip(tip, box, px, py) {
  tip.hidden = false;
  const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = px + 12;
  if (x + tw > bw - 4) x = px - tw - 12;
  let y = py - th - 10;
  if (y < 0) y = py + 14;
  tip.style.left = Math.max(2, x) + "px";
  tip.style.top = y + "px";
}
function tipRow(tip, label, value, strongValue) {
  const r = el("div");
  if (strongValue) {
    r.appendChild(el("span", "v", value));
    if (label) { r.append(" "); r.append(label); }
  } else {
    r.append(label + (label ? " " : ""));
    r.appendChild(el("span", null, value));
  }
  tip.appendChild(r);
}

function lineChart(box, pts, { fmtY, height = 200 }) {
  box.textContent = "";
  if (pts.length < 2) { box.appendChild(el("div", "empty", "Needs at least 2 completed cycles.")); return; }
  const W = Math.max(box.clientWidth, 280), H = height;
  const M = { l: 34, r: 14, t: 12, b: 24 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys));
  const X = (v) => M.l + ((v - x0) / (x1 - x0 || 1)) * iw;
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo || 1)) * ih;

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  for (const t of ticks) {
    svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: "var(--grid)", "stroke-width": 1 }));
    const txt = sv("text", { x: M.l - 7, y: Y(t) + 3.5, "text-anchor": "end" });
    txt.textContent = fmtY(t);
    svg.appendChild(txt);
  }
  svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(lo), y2: Y(lo), stroke: "var(--axis)", "stroke-width": 1 }));

  const nT = Math.min(4, pts.length);
  const seen = new Set();
  for (let i = 0; i < nT; i++) {
    const p = pts[Math.round((i * (pts.length - 1)) / (nT - 1 || 1))];
    const lab = fmtTick(p.x);
    if (seen.has(lab)) continue;
    seen.add(lab);
    const anchor = i === 0 ? "start" : i === nT - 1 ? "end" : "middle";
    const txt = sv("text", { x: X(p.x), y: H - 7, "text-anchor": anchor });
    txt.textContent = lab;
    svg.appendChild(txt);
  }

  const dLine = pts.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
  const dArea = dLine + ` L ${X(pts[pts.length - 1].x).toFixed(1)} ${Y(lo)} L ${X(pts[0].x).toFixed(1)} ${Y(lo)} Z`;
  svg.appendChild(sv("path", { d: dArea, fill: "var(--series-wash)" }));
  svg.appendChild(sv("path", { d: dLine, fill: "none", stroke: "var(--series-1)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  const dots = [];
  for (const p of pts) {
    svg.appendChild(sv("circle", { cx: X(p.x), cy: Y(p.y), r: 5.5, fill: "var(--surface)" }));
    const d = sv("circle", { cx: X(p.x), cy: Y(p.y), r: 3.5, fill: "var(--series-1)" });
    svg.appendChild(d);
    dots.push(d);
  }
  const lastP = pts[pts.length - 1];
  const endTxt = sv("text", { x: X(lastP.x) - 4, y: Y(lastP.y) - 9, "text-anchor": "end", class: "dl" });
  endTxt.textContent = fmtY(lastP.y);
  svg.appendChild(endTxt);

  const cross = sv("line", { y1: M.t, y2: H - M.b, stroke: "var(--axis)", "stroke-width": 1, opacity: 0 });
  svg.appendChild(cross);
  const tip = makeTip(box);
  let hi_i = -1;
  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(X(p.x) - mx); if (d < bd) { bd = d; best = i; } });
    const p = pts[best];
    cross.setAttribute("x1", X(p.x)); cross.setAttribute("x2", X(p.x));
    cross.setAttribute("opacity", 1);
    if (hi_i >= 0) dots[hi_i].setAttribute("r", 3.5);
    dots[best].setAttribute("r", 5);
    hi_i = best;
    tip.textContent = "";
    for (const l of p.tipLines) tipRow(tip, l.label, l.v, l.strong);
    placeTip(tip, box, (X(p.x) / W) * rect.width, (Y(p.y) / H) * rect.height);
  }
  function onLeave() {
    cross.setAttribute("opacity", 0);
    tip.hidden = true;
    if (hi_i >= 0) dots[hi_i].setAttribute("r", 3.5);
    hi_i = -1;
  }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerdown", onMove);
  svg.addEventListener("pointerleave", onLeave);
  box.appendChild(svg);
}

function barChart(box, bars, { fmtY, height = 200 }) {
  box.textContent = "";
  if (!bars.length) { box.appendChild(el("div", "empty", "Not enough data yet.")); return; }
  const W = Math.max(box.clientWidth, 280), H = height;
  const M = { l: 34, r: 8, t: 12, b: 24 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const { lo, hi, ticks } = niceTicks(0, Math.max(...bars.map((b) => b.y), 1));
  const Y = (v) => M.t + (1 - (v - lo) / (hi - lo || 1)) * ih;
  const band = iw / bars.length;
  const bw = Math.min(24, Math.max(3, band - 2));

  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
  for (const t of ticks) {
    svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(t), y2: Y(t), stroke: "var(--grid)", "stroke-width": 1 }));
    const txt = sv("text", { x: M.l - 7, y: Y(t) + 3.5, "text-anchor": "end" });
    txt.textContent = fmtY(t);
    svg.appendChild(txt);
  }
  svg.appendChild(sv("line", { x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0), stroke: "var(--axis)", "stroke-width": 1 }));

  const tip = makeTip(box);
  const rects = [];
  bars.forEach((b, i) => {
    const cx = M.l + band * i + band / 2;
    const x = cx - bw / 2;
    const yTop = Y(b.y), y0 = Y(0);
    const h = Math.max(y0 - yTop, 0);
    const r = Math.min(4, bw / 2, h);
    const d = h <= 0 ? "" :
      `M ${x} ${y0} L ${x} ${yTop + r} Q ${x} ${yTop} ${x + r} ${yTop} L ${x + bw - r} ${yTop} Q ${x + bw} ${yTop} ${x + bw} ${yTop + r} L ${x + bw} ${y0} Z`;
    const path = sv("path", { d, fill: "var(--series-1)" });
    svg.appendChild(path);
    rects.push(path);
    const hit = sv("rect", { x: M.l + band * i, y: M.t, width: band, height: ih, fill: "transparent" });
    hit.addEventListener("pointermove", () => {
      rects.forEach((p) => p.setAttribute("opacity", 1));
      path.setAttribute("opacity", 0.75);
      tip.textContent = "";
      for (const l of b.tipLines) tipRow(tip, l.label, l.v, l.strong);
      const rect = svg.getBoundingClientRect();
      placeTip(tip, box, (cx / W) * rect.width, (yTop / H) * rect.height);
    });
    hit.addEventListener("pointerleave", () => { path.setAttribute("opacity", 1); tip.hidden = true; });
    svg.appendChild(hit);
  });

  const every = Math.ceil(bars.length / 6);
  bars.forEach((b, i) => {
    if (i % every && i !== bars.length - 1) return;
    const txt = sv("text", { x: M.l + band * i + band / 2, y: H - 7, "text-anchor": "middle" });
    txt.textContent = b.label;
    svg.appendChild(txt);
  });
  box.appendChild(svg);
}

/* ---------------- theme ---------------- */
function applyTheme() {
  const t = localStorage.getItem(LS_THEME) || "auto";
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const cur = localStorage.getItem(LS_THEME) || "auto";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem(LS_THEME, next);
  applyTheme();
  toast("Theme: " + next);
  if (currentTab === "dash") renderDash();
}

/* ---------------- wire up ---------------- */
function init() {
  load();
  applyTheme();
  selected = todayISO();

  document.querySelectorAll(".tabbar button").forEach((b) =>
    b.addEventListener("click", () => { closeSheet(); switchTab(b.dataset.tab); }));

  $("#sheetClose").addEventListener("click", closeSheet);
  $("#sheetBack").addEventListener("click", closeSheet);
  $("#editForm").addEventListener("submit", onEditSubmit);
  $("#eDeleteBtn").addEventListener("click", () => {
    const p = periods.find((x) => x.id === editingPeriodId);
    if (p && confirm(`Delete the period ${fmtRange(p.start, p.end)}?`)) {
      periods = periods.filter((x) => x.id !== p.id);
      afterChange("Period deleted");
    }
  });
  $("#earlierBtn").addEventListener("click", () => {
    calFrom = monthAdd(calRange().from, -6);
    const anchor = document.getElementById("m-" + monthAdd(calFrom, 6));
    renderCalendar();
    if (anchor) document.getElementById(anchor.id)?.scrollIntoView({ block: "start" });
  });

  $("#themeBtn").addEventListener("click", cycleTheme);
  $("#profileForm").addEventListener("submit", onProfileSubmit);
  $("#exportBtn").addEventListener("click", downloadCSV);
  $("#shareBtn").addEventListener("click", shareCSV);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try {
      const records = importCSV(await f.text());
      if (confirm(`Replace the ${periods.length} periods on this device with ${records.length} imported ones?`)) {
        periods = records;
        save();
        calFrom = null;
        toast(`Imported ${records.length} periods`);
        renderData();
      }
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
  });
  $("#wipeBtn").addEventListener("click", () => {
    if (confirm("Erase ALL period data and your profile from this device? Consider exporting a CSV first.") &&
        confirm("Really erase everything? This cannot be undone.")) {
      periods = [];
      profile = {};
      save();
      calFrom = null;
      toast("All data erased");
      renderData();
    }
  });

  let rT = null;
  window.addEventListener("resize", () => {
    clearTimeout(rT);
    rT = setTimeout(() => { if (currentTab === "dash") renderDash(); }, 200);
  });

  switchTab("cal");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
