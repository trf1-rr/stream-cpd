/* Overlay de sensores (SNMP) reutilizavel — usado por index.html e view.html.
   Expoe window.SensorHUD: register/clear/start/stop/setVisible/forceRefresh.
   Le /api/sensors, desenha velocimetro ou texto, mantem a regressiva e o
   painel de ajustes (config salva em localStorage, compartilhada entre paginas). */
window.SensorHUD = (function () {
  "use strict";

  var HUD_DEFAULTS = {
    mode: "gauge",             // "gauge" (velocimetro) | "text"
    pos: "top-left",
    scale: 1.0,
    opacity: 0.5,
    font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    colorOk: "#3fb950",
    colorWarn: "#f0b429",
    colorCrit: "#f85149",
    colorText: "#e6edf3",
    title: "",
    titleSize: 16,
    titleColor: "#e6edf3",
    titleFont: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  };

  function loadHudCfg() {
    var c = {};
    for (var k in HUD_DEFAULTS) c[k] = HUD_DEFAULTS[k];
    try {
      var saved = JSON.parse(localStorage.getItem("hudCfg") || "{}");
      for (var s in saved) if (s in c) c[s] = saved[s];
    } catch (e) {}
    return c;
  }
  function saveHudCfg() {
    try { localStorage.setItem("hudCfg", JSON.stringify(hudCfg)); } catch (e) {}
  }

  var hudCfg = loadHudCfg();
  var huds = [];
  var lastSensors = null;
  var pollTimer = null;
  var POLL_SECONDS = 60;
  var countdown = POLL_SECONDS;
  var visible = true;
  var refreshEl = null;

  // ---------- render ----------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function stateOf(s) {
    if (s.value == null) return "";
    if (s.crit != null && s.value >= s.crit) return "crit";
    if (s.warn != null && s.value >= s.warn) return "warn";
    return "";
  }

  var G_START = 225, G_SWEEP = 270, GC = 60, GR = 46;
  function polar(r, ang) {
    var a = (ang - 90) * Math.PI / 180;
    return [GC + r * Math.cos(a), GC + r * Math.sin(a)];
  }
  function arcPath(r, a0, a1) {
    var n = 40, d = "";
    for (var i = 0; i <= n; i++) {
      var p = polar(r, a0 + (a1 - a0) * i / n);
      d += (i ? "L" : "M") + p[0].toFixed(2) + " " + p[1].toFixed(2) + " ";
    }
    return d.trim();
  }
  function buildGauge(s) {
    var hasVal = s.value != null;
    var min = s.min != null ? s.min : 0;
    var max = s.max != null ? s.max : 100;
    var f = hasVal ? (s.value - min) / (max - min) : 0;
    f = Math.max(0, Math.min(1, f));
    var va = G_START + f * G_SWEEP;

    var state = stateOf(s);
    var color = state === "crit" ? hudCfg.colorCrit : state === "warn" ? hudCfg.colorWarn : hudCfg.colorOk;

    var track = arcPath(GR, G_START, G_START + G_SWEEP);
    var fill = arcPath(GR, G_START, va);

    var ticks = "";
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var ta = G_START + t * G_SWEEP;
      var o = polar(GR, ta), i = polar(GR - 7, ta);
      ticks += '<line x1="' + o[0].toFixed(1) + '" y1="' + o[1].toFixed(1) +
        '" x2="' + i[0].toFixed(1) + '" y2="' + i[1].toFixed(1) +
        '" stroke="rgba(255,255,255,.4)" stroke-width="1.6"/>';
    });

    var needle = "";
    if (hasVal) {
      var tip = polar(GR - 8, va);
      var b1 = polar(6, va + 90), b2 = polar(6, va - 90);
      needle =
        '<polygon points="' + tip[0].toFixed(1) + ',' + tip[1].toFixed(1) + ' ' +
        b1[0].toFixed(1) + ',' + b1[1].toFixed(1) + ' ' +
        b2[0].toFixed(1) + ',' + b2[1].toFixed(1) + '" fill="' + color + '"/>' +
        '<circle cx="' + GC + '" cy="' + GC + '" r="5.5" fill="' + color + '"/>' +
        '<circle cx="' + GC + '" cy="' + GC + '" r="2.5" fill="#0d1117"/>';
    }

    var svg =
      '<svg viewBox="0 0 120 120">' +
        '<path d="' + track + '" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="9" stroke-linecap="round"/>' +
        (hasVal ? '<path d="' + fill + '" fill="none" stroke="' + color + '" stroke-width="9" stroke-linecap="round"/>' : '') +
        ticks + needle +
      '</svg>';

    var unit = s.unit ? '<small>' + esc(s.unit) + '</small>' : '';
    return '<div class="gauge ' + state + '">' + svg +
      '<div class="icon">' + (s.icon || '') + '</div>' +
      '<div class="val">' + (hasVal ? String(s.value) : '--') + unit + '</div>' +
      '</div>';
  }
  function buildTextRow(s) {
    var st = stateOf(s);
    var unit = s.unit ? "<small>" + esc(s.unit) + "</small>" : "";
    return '<div class="trow' + (st ? " " + st : "") + '">' +
      '<span class="ti">' + (s.icon || "") + "</span>" +
      '<span class="tl">' + esc(s.label || "") + "</span>" +
      '<span class="tv">' + (s.value != null ? String(s.value) : "--") + unit + "</span>" +
      "</div>";
  }
  function buildHudInto(el, data) {
    var titleHtml = hudCfg.title ? '<div class="hud-title">' + esc(hudCfg.title) + "</div>" : "";
    if (!data || data.enabled === false || data.ok === false) {
      el.innerHTML = titleHtml;
      return;
    }
    var html = titleHtml;
    if (hudCfg.mode === "text") {
      html += '<div class="hud-text">' + (data.sensors || []).map(buildTextRow).join("") + "</div>";
    } else {
      html += (data.sensors || []).map(buildGauge).join("");
    }
    (data.alarms || []).forEach(function (label) {
      html += '<div class="alarm">⚠ ' + esc(label) + "</div>";
    });
    el.innerHTML = html;
  }

  function styleHud(el) {
    var c = hudCfg;
    var isRight = c.pos.indexOf("right") >= 0;
    var isCenter = c.pos.indexOf("center") >= 0;
    var isBottom = c.pos.indexOf("bottom") >= 0;
    el.style.top = isBottom ? "auto" : "44px";
    el.style.bottom = isBottom ? "12px" : "auto";
    var tx = "";
    if (isCenter) { el.style.left = "50%"; el.style.right = "auto"; tx = "translateX(-50%) "; }
    else if (isRight) { el.style.left = "auto"; el.style.right = "12px"; }
    else { el.style.left = "12px"; el.style.right = "auto"; }
    el.style.transformOrigin =
      (isCenter ? "center" : isRight ? "right" : "left") + " " + (isBottom ? "bottom" : "top");
    el.style.transform = tx + "scale(" + c.scale + ")";
    el.style.fontFamily = c.font;
    el.style.setProperty("--hud-bg-alpha", c.opacity);
    el.style.setProperty("--hud-text", c.colorText);
    el.style.setProperty("--hud-warn", c.colorWarn);
    el.style.setProperty("--hud-crit", c.colorCrit);
    el.style.setProperty("--hud-title-size", c.titleSize + "px");
    el.style.setProperty("--hud-title-color", c.titleColor);
    el.style.setProperty("--hud-title-font", c.titleFont);
  }

  function applyAll() { huds.forEach(styleHud); }
  function refreshAll() { huds.forEach(function (el) { buildHudInto(el, lastSensors); }); }

  // ---------- poll + regressiva ----------
  function pollSensors() {
    fetch("/api/sensors")
      .then(function (r) { return r.json(); })
      .then(function (data) { lastSensors = data; refreshAll(); })
      .catch(function () {});
  }
  function updateCountdownLabel() {
    if (refreshEl) refreshEl.textContent = "⟳ " + countdown + "s";
  }
  function tick() {
    countdown -= 1;
    if (countdown <= 0) { pollSensors(); countdown = POLL_SECONDS; }
    updateCountdownLabel();
  }
  function forceRefresh() {
    pollSensors();
    countdown = POLL_SECONDS;
    updateCountdownLabel();
  }
  function start() {
    if (pollTimer) return;
    forceRefresh();
    pollTimer = setInterval(tick, 1000);
  }
  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---------- API de registro ----------
  function register(el) {
    huds.push(el);
    styleHud(el);
    el.classList.toggle("hidden", !visible);
    if (lastSensors) buildHudInto(el, lastSensors);
  }
  function clear() { huds = []; }
  function setVisible(on) {
    visible = on;
    huds.forEach(function (el) { el.classList.toggle("hidden", !on); });
    if (refreshEl) refreshEl.classList.toggle("hidden", !on);
  }

  // ---------- painel de ajustes ----------
  var FONT_OPTS =
    '<option value="system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif">Sistema</option>' +
    '<option value="\'Segoe UI Semibold\', \'Segoe UI\', Roboto, sans-serif">Segoe UI</option>' +
    '<option value="ui-monospace, SFMono-Regular, Consolas, monospace">Monoespaçada</option>' +
    '<option value="Georgia, \'Times New Roman\', serif">Serifada</option>' +
    '<option value="\'Arial Narrow\', \'Segoe UI\', sans-serif">Condensada</option>';

  var SETTINGS_HTML =
    '<h3>Ajustar sensores</h3>' +
    '<div class="row"><span>Exibição</span><select id="cfgMode">' +
      '<option value="gauge">Velocímetro</option><option value="text">Somente texto</option></select></div>' +
    '<div class="row"><span>Posição</span><select id="cfgPos">' +
      '<option value="top-left">Superior esquerda</option><option value="top-right">Superior direita</option>' +
      '<option value="bottom-left">Inferior esquerda</option><option value="bottom-right">Inferior direita</option>' +
      '<option value="top-center">Superior centro</option><option value="bottom-center">Inferior centro</option></select></div>' +
    '<div class="row"><span>Tamanho <b id="cfgScaleVal"></b></span><input type="range" id="cfgScale" min="60" max="180" step="5"></div>' +
    '<div class="row"><span>Opacidade do fundo <b id="cfgOpacityVal"></b></span><input type="range" id="cfgOpacity" min="0" max="95" step="5"></div>' +
    '<div class="row"><span>Fonte</span><select id="cfgFont">' + FONT_OPTS + '</select></div>' +
    '<div class="row"><span>Cores</span><div class="colors">' +
      '<label>Normal<input type="color" id="cfgColorOk"></label>' +
      '<label>Alerta<input type="color" id="cfgColorWarn"></label>' +
      '<label>Crítico<input type="color" id="cfgColorCrit"></label>' +
      '<label>Texto<input type="color" id="cfgColorText"></label></div></div>' +
    '<hr>' +
    '<div class="row"><span>Título</span><input type="text" id="cfgTitle" placeholder="(sem título)" maxlength="40"></div>' +
    '<div class="row"><span>Título: tamanho <b id="cfgTitleSizeVal"></b></span><input type="range" id="cfgTitleSize" min="10" max="34" step="1"></div>' +
    '<div class="row"><span>Título: fonte</span><select id="cfgTitleFont">' + FONT_OPTS + '</select></div>' +
    '<div class="row"><span>Título: cor</span><input type="color" id="cfgTitleColor" style="height:28px"></div>' +
    '<div class="foot"><span class="note">Salvo neste navegador.</span><button id="cfgReset">Restaurar padrão</button></div>';

  function ensureSettingsPanel() {
    var panel = document.getElementById("hudSettings");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "hudSettings";
      panel.className = "settings hidden";
      panel.innerHTML = SETTINGS_HTML;
      document.body.appendChild(panel);
    }
    return panel;
  }

  function wireSettings() {
    var $ = function (id) { return document.getElementById(id); };
    var cfgMode = $("cfgMode");
    if (!cfgMode) return;
    var cfgPos = $("cfgPos"), cfgScale = $("cfgScale"), cfgScaleVal = $("cfgScaleVal"),
        cfgOpacity = $("cfgOpacity"), cfgOpacityVal = $("cfgOpacityVal"), cfgFont = $("cfgFont"),
        cfgOk = $("cfgColorOk"), cfgWarn = $("cfgColorWarn"), cfgCrit = $("cfgColorCrit"), cfgText = $("cfgColorText"),
        cfgTitle = $("cfgTitle"), cfgTitleSize = $("cfgTitleSize"), cfgTitleSizeVal = $("cfgTitleSizeVal"),
        cfgTitleFont = $("cfgTitleFont"), cfgTitleColor = $("cfgTitleColor");

    function syncControls() {
      cfgMode.value = hudCfg.mode;
      cfgPos.value = hudCfg.pos;
      cfgScale.value = Math.round(hudCfg.scale * 100);
      cfgScaleVal.textContent = Math.round(hudCfg.scale * 100) + "%";
      cfgOpacity.value = Math.round(hudCfg.opacity * 100);
      cfgOpacityVal.textContent = Math.round(hudCfg.opacity * 100) + "%";
      cfgFont.value = hudCfg.font;
      cfgOk.value = hudCfg.colorOk;
      cfgWarn.value = hudCfg.colorWarn;
      cfgCrit.value = hudCfg.colorCrit;
      cfgText.value = hudCfg.colorText;
      cfgTitle.value = hudCfg.title;
      cfgTitleSize.value = hudCfg.titleSize;
      cfgTitleSizeVal.textContent = hudCfg.titleSize + "px";
      cfgTitleFont.value = hudCfg.titleFont;
      cfgTitleColor.value = hudCfg.titleColor;
    }
    function styleOnly() { applyAll(); saveHudCfg(); }
    function rebuild() { applyAll(); refreshAll(); saveHudCfg(); }

    cfgMode.onchange = function () { hudCfg.mode = cfgMode.value; rebuild(); };
    cfgPos.onchange = function () { hudCfg.pos = cfgPos.value; styleOnly(); };
    cfgScale.oninput = function () {
      hudCfg.scale = (+cfgScale.value) / 100; cfgScaleVal.textContent = cfgScale.value + "%"; styleOnly();
    };
    cfgOpacity.oninput = function () {
      hudCfg.opacity = (+cfgOpacity.value) / 100; cfgOpacityVal.textContent = cfgOpacity.value + "%"; styleOnly();
    };
    cfgFont.onchange = function () { hudCfg.font = cfgFont.value; styleOnly(); };
    cfgOk.oninput = function () { hudCfg.colorOk = cfgOk.value; rebuild(); };
    cfgWarn.oninput = function () { hudCfg.colorWarn = cfgWarn.value; rebuild(); };
    cfgCrit.oninput = function () { hudCfg.colorCrit = cfgCrit.value; rebuild(); };
    cfgText.oninput = function () { hudCfg.colorText = cfgText.value; styleOnly(); };
    cfgTitle.oninput = function () { hudCfg.title = cfgTitle.value; rebuild(); };
    cfgTitleSize.oninput = function () {
      hudCfg.titleSize = +cfgTitleSize.value; cfgTitleSizeVal.textContent = cfgTitleSize.value + "px"; styleOnly();
    };
    cfgTitleFont.onchange = function () { hudCfg.titleFont = cfgTitleFont.value; styleOnly(); };
    cfgTitleColor.oninput = function () { hudCfg.titleColor = cfgTitleColor.value; styleOnly(); };
    var reset = $("cfgReset");
    if (reset) reset.onclick = function () {
      for (var k in HUD_DEFAULTS) hudCfg[k] = HUD_DEFAULTS[k];
      syncControls(); rebuild();
    };
    syncControls();
  }

  function wireControls() {
    refreshEl = document.getElementById("refreshCountdown");
    if (refreshEl) refreshEl.onclick = forceRefresh;
    var gear = document.getElementById("hudCfgBtn");
    var panel = document.getElementById("hudSettings");
    if (gear && panel) gear.onclick = function () { panel.classList.toggle("hidden"); };
    var tog = document.getElementById("toggleHud");
    if (tog) tog.onclick = function () {
      setVisible(!visible);
      tog.textContent = "Sensores: " + (visible ? "on" : "off");
    };
  }

  function init() {
    ensureSettingsPanel();
    wireControls();
    wireSettings();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return {
    register: register, clear: clear, start: start, stop: stop,
    setVisible: setVisible, forceRefresh: forceRefresh
  };
})();
