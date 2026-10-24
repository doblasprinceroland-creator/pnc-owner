// PNC WiFi owner dashboard (2026-10-24).
//
// Reads the router's summary from ntfy (topic "<topic>-dash", published by
// pnc-dash in configs/mikrotik/pnc-dashboard.rsc), recent alerts from "<topic>",
// and sends commands to "<topic>-cmd" (read by pnc-inbox). The topic is the only
// secret: it is typed once and kept in this phone's localStorage, never in a URL
// of this page. No server of our own, nothing opened on the router.
(() => {
  "use strict";

  const NTFY = "https://ntfy.sh/";
  const TOPIC_KEY = "pncOwnerTopic";
  const POLL_MS = 30000;
  const FAST_POLL_MS = 5000;
  const FAST_FOR_MS = 90000;
  const ALERTS_MS = 60000;
  const STALE_S = 40 * 60;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const $ = id => document.getElementById(id);
  let topic = "";
  let dash = null;
  let fastUntil = 0;
  let pollTimer = 0;
  let alertsTimer = 0;
  let lastAlertsAt = 0;

  function store(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (_) {}
  }

  function read(key) {
    try { return localStorage.getItem(key) || ""; } catch (_) { return ""; }
  }

  // ---------- formatting ----------
  const peso = n => "₱" + Math.round(Number(n) || 0).toLocaleString("en-US");
  const pesoShort = n => {
    n = Number(n) || 0;
    if (n >= 10000) return "₱" + Math.round(n / 1000) + "k";
    if (n >= 1000) return "₱" + (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return "₱" + n;
  };

  function span(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + " min";
    return sec + " s";
  }

  function ago(sec) {
    if (sec < 60) return "just now";
    return span(sec) + " ago";
  }

  function clock(epoch) {
    return new Date(epoch * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function ymd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }

  function dayLabel(date) {
    return DAYS[date.getDay()] + ", " + MONTHS[date.getMonth()] + " " + date.getDate();
  }

  function hourLabel(h) {
    const suffix = h < 12 ? "AM" : "PM";
    const n = h % 12 === 0 ? 12 : h % 12;
    return n + " " + suffix;
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  // ---------- ntfy ----------
  const url = suffix => NTFY + encodeURIComponent(topic + suffix);

  async function lines(u) {
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) throw new Error("ntfy " + res.status);
    return (await res.text()).split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(m => m && m.event === "message");
  }

  async function fetchDash() {
    const msgs = await lines(url("-dash") + "/json?poll=1&since=latest");
    for (let i = msgs.length - 1; i >= 0; i--) {
      try {
        const d = JSON.parse(msgs[i].message);
        if (d && d.v === 1) return d;
      } catch (_) {}
    }
    return null;
  }

  async function send(cmd) {
    const res = await fetch(url("-cmd"), { method: "POST", body: cmd });
    if (!res.ok) throw new Error("ntfy " + res.status);
  }

  async function command(cmd, done) {
    try {
      await send(cmd);
      toast(done || "Sent. The router picks it up within a minute.");
      fastUntil = Date.now() + FAST_FOR_MS;
      schedule(FAST_POLL_MS);
      return true;
    } catch (_) {
      toast("Could not send. Is this phone online?");
      return false;
    }
  }

  // ---------- rendering ----------
  function setPill(id, state, text) {
    const el = $(id);
    el.className = "pill " + state;
    el.querySelector("small").textContent = text;
  }

  function banner(text, bad) {
    const el = $("banner");
    if (!text) { el.className = "banner hidden"; return; }
    el.className = "banner" + (bad ? " bad" : "");
    el.textContent = text;
  }

  function render() {
    const d = dash;
    const now = Date.now() / 1000;
    const updated = $("updated");
    if (!d) {
      updated.textContent = "Waiting for the router…";
      banner("No update from the router yet. It sends one at least every 30 minutes; tap refresh to ask now. If this stays, check the topic name.", false);
      return;
    }
    const age = now - d.t;
    const stale = age > STALE_S;
    updated.textContent = "Updated " + ago(age);
    updated.classList.toggle("stale", stale);

    // Health
    if (stale) setPill("hNet", "warn", "unknown");
    else if (d.net === "down") setPill("hNet", "bad", "Down" + (d.netDown ? " since " + clock(d.netDown) : ""));
    else setPill("hNet", "ok", "Up");
    if (stale) setPill("hJf", "warn", "unknown");
    else if (d.jf === "up") setPill("hJf", "ok", "Taking coins");
    else if (d.jf === "down") setPill("hJf", "bad", "Not responding");
    else setPill("hJf", "warn", "Checking…");
    setPill("hRouter", stale ? "bad" : "ok", stale ? "Silent " + span(age) : "Up " + span(d.up + Math.max(0, age)));

    if (stale) banner("No update from the router for " + span(age) + ". It may be switched off, or the shop's internet is down. Numbers below are from " + clock(d.t) + ".", true);
    else if (d.net === "down") banner("Internet is down" + (d.netDown ? " since " + clock(d.netDown) : "") + ". Customers see the outage screen and can't pay; time they use now is given back when it returns.", true);
    else if (d.jf === "down") banner("JuanFi is not responding, so customers can't insert coins. Check its power and cable.", true);
    else banner("", false);

    // Today
    const date = ymd(d.d) || new Date();
    $("todayDate").textContent = dayLabel(date);
    $("todayAmt").textContent = peso(d.amt);
    $("todaySub").textContent = d.n === 0 ? "No sales yet today" :
      d.n + (d.n === 1 ? " sale" : " sales") + " · " + d.new + " new · " + d.ext + " Add Time";
    const hours = Array.isArray(d.h) ? d.h : [];
    const max = Math.max(1, ...hours);
    let peak = -1;
    hours.forEach((v, i) => { if (v > 0 && (peak < 0 || v > hours[peak])) peak = i; });
    const isToday = date.toDateString() === new Date().toDateString();
    const nowHour = new Date().getHours();
    $("hours").innerHTML = "";
    hours.forEach((v, i) => {
      const bar = document.createElement("i");
      bar.style.height = Math.max(6, Math.round(v / max * 100)) + "%";
      bar.className = (v > 0 ? "on" : "") + (i === peak ? " peak" : "") + (isToday && i === nowHour ? " now" : "");
      bar.title = hourLabel(i) + ": " + peso(v);
      $("hours").appendChild(bar);
    });
    $("busiest").textContent = peak >= 0 ? "Busiest hour: " + hourLabel(peak) + " (" + peso(hours[peak]) + ")" : "";

    // Coin box
    $("boxAmt").textContent = peso(d.box);
    const since = ymd(d.boxSince);
    $("boxSince").textContent = since ? "since " + MONTHS[since.getMonth()] + " " + since.getDate() : "";
    const ratio = d.boxNext > 0 ? Math.min(1, d.box / d.boxNext) : 0;
    $("boxBar").style.width = Math.round(ratio * 100) + "%";
    $("boxBar").parentElement.classList.toggle("full", ratio >= 0.9);
    $("boxNext").textContent = "Reminder at " + peso(d.boxNext);

    // Online + events
    $("online").textContent = String(d.online);
    $("events").textContent = "Today: " + d.rst + " router restart" + (d.rst === 1 ? "" : "s") +
      " · " + d.jfo + " JuanFi outage" + (d.jfo === 1 ? "" : "s");

    renderChart(d, date);

    // Notice
    const nn = $("noticeNow");
    if (d.notice) { nn.textContent = d.notice; nn.className = "notice-now on"; }
    else { nn.textContent = "No notice on the portal right now."; nn.className = "notice-now muted"; }
  }

  function renderChart(d, today) {
    const byDate = {};
    (Array.isArray(d.hist) ? d.hist : []).forEach(row => { if (Array.isArray(row)) byDate[row[0]] = Number(row[1]) || 0; });
    const cols = [];
    for (let back = 13; back >= 0; back--) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      const key = day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
      const value = back === 0 ? Number(d.amt) || 0 : byDate[key];
      cols.push({ day, value, today: back === 0, known: back === 0 || key in byDate });
    }
    const max = Math.max(1, ...cols.map(c => c.value || 0));
    const chart = $("chart");
    chart.innerHTML = "";
    cols.forEach(c => {
      const col = document.createElement("div");
      col.className = "col" + (c.today ? " today" : "") + (c.known ? "" : " empty");
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = c.known && c.value > 0 ? pesoShort(c.value) : "";
      const bar = document.createElement("span");
      bar.className = "bar";
      bar.style.height = c.known ? Math.max(2, Math.round((c.value || 0) / max * 78)) + "%" : "2%";
      const label = document.createElement("span");
      label.className = "day";
      label.textContent = c.today ? "Today" : DAYS[c.day.getDay()].slice(0, 2);
      col.append(val, bar, label);
      col.title = dayLabel(c.day) + (c.known ? ": " + peso(c.value) : ": no data");
      chart.appendChild(col);
    });
    const known = cols.filter(c => c.known).length;
    const week = cols.slice(7).reduce((s, c) => s + (c.value || 0), 0);
    const prevKnown = cols.slice(0, 7).filter(c => c.known);
    const prev = prevKnown.reduce((s, c) => s + (c.value || 0), 0);
    if (prevKnown.length > 0) {
      const diff = week - prev;
      $("weekCmp").textContent = "7 days " + peso(week) + " · " + (diff >= 0 ? "+" : "−") + peso(Math.abs(diff)) + " vs before";
    } else {
      $("weekCmp").textContent = "7 days " + peso(week);
    }
    $("chartNote").textContent = known < 14 ? "History started " + dayLabel(cols.find(c => c.known).day) + "; the chart fills in day by day." : "";
  }

  // ---------- alerts ----------
  async function loadAlerts() {
    lastAlertsAt = Date.now();
    const list = $("alerts");
    try {
      const msgs = (await lines(url("") + "/json?poll=1&since=12h")).reverse().slice(0, 15);
      list.innerHTML = "";
      if (msgs.length === 0) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "No alerts in the last 12 hours.";
        list.appendChild(li);
        return;
      }
      msgs.forEach(m => {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = clock(m.time) + " · " + ago(Date.now() / 1000 - m.time);
        li.appendChild(t);
        if (m.title) {
          const b = document.createElement("b");
          b.textContent = m.title;
          li.appendChild(b);
        }
        const body = document.createElement("div");
        body.className = "body";
        body.textContent = m.message;
        li.appendChild(body);
        list.appendChild(li);
      });
    } catch (_) {
      list.innerHTML = "";
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Could not load alerts. Is this phone online?";
      list.appendChild(li);
    }
  }

  // ---------- polling ----------
  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  async function poll() {
    if (document.hidden) return;
    const before = dash ? dash.t : 0;
    try {
      const d = await fetchDash();
      if (d) dash = d;
      render();
    } catch (_) {
      $("updated").textContent = "Offline";
      banner("Can't reach ntfy.sh. Check this phone's internet connection.", false);
    }
    if (dash && dash.t !== before && Date.now() < fastUntil && before) {
      fastUntil = 0;
      $("refreshBtn").classList.remove("spin");
      toast("Updated.");
    }
    if (Date.now() >= fastUntil) $("refreshBtn").classList.remove("spin");
    if (Date.now() - lastAlertsAt >= ALERTS_MS) loadAlerts();
    schedule(Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
  }

  // Re-render every 30 s so "updated … ago" stays true between polls.
  setInterval(() => { if (dash && !document.hidden) render(); }, 30000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && topic) { lastAlertsAt = 0; poll(); }
  });

  // ---------- actions ----------
  function wire() {
    $("refreshBtn").addEventListener("click", async () => {
      $("refreshBtn").classList.add("spin");
      const ok = await command("refresh", "Asked the router for fresh numbers…");
      if (!ok) $("refreshBtn").classList.remove("spin");
      lastAlertsAt = 0;
    });

    $("emptiedBtn").addEventListener("click", () => {
      const amt = dash ? peso(dash.box) : "the coin box";
      if (confirm("Did you empty the coin box? This sets the count (" + amt + ") back to ₱0.")) command("emptied");
    });

    const input = $("noticeInput");
    const count = () => { $("noticeCount").textContent = input.value.length + "/160"; };
    input.addEventListener("input", count);
    $("noticeForm").addEventListener("submit", async e => {
      e.preventDefault();
      const text = input.value.replace(/\s+/g, " ").trim().slice(0, 160);
      if (!text) { toast("Type the message first."); return; }
      if (await command("notice " + text, "Notice sent. It shows on the portal within a minute.")) { input.value = ""; count(); }
    });
    $("noticeOff").addEventListener("click", () => {
      if (dash && !dash.notice) { toast("There is no notice to remove."); return; }
      command("notice off", "Removing the notice…");
    });

    document.querySelectorAll("[data-cmd]").forEach(btn => {
      btn.addEventListener("click", () => command(btn.dataset.cmd, "Requested. It arrives in your ntfy app within a minute."));
    });

    $("forgetBtn").addEventListener("click", () => {
      if (!confirm("Disconnect this phone from the dashboard? You'll need the topic name to connect again.")) return;
      store(TOPIC_KEY, null);
      location.reload();
    });
  }

  // ---------- setup ----------
  function showSetup() {
    $("app").classList.add("hidden");
    $("setup").classList.remove("hidden");
    $("showTopic").addEventListener("change", e => { $("topicInput").type = e.target.checked ? "text" : "password"; });
    $("setupForm").addEventListener("submit", async e => {
      e.preventDefault();
      const value = $("topicInput").value.trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        $("setupMsg").textContent = "Topic names use only letters, numbers, - and _.";
        return;
      }
      topic = value;
      store(TOPIC_KEY, value);
      // Ask for a fresh update so a correct topic proves itself within a minute.
      try { await send("refresh"); } catch (_) {}
      start();
    });
  }

  function start() {
    $("setup").classList.add("hidden");
    $("app").classList.remove("hidden");
    fastUntil = Date.now() + FAST_FOR_MS;
    poll();
    loadAlerts();
  }

  function boot() {
    wire();
    topic = read(TOPIC_KEY);
    if (topic) start(); else showSetup();
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  boot();
})();
