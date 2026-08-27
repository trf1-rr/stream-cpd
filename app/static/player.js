/* Player HLS multi-camera com reconexao automatica. */
(function () {
  "use strict";

  var grid = document.getElementById("grid");
  var subtypeSel = document.getElementById("subtype");
  var layoutSel = document.getElementById("layout");
  var players = [];

  // ---- Overlay de sensores (SNMP) ----
  var lastSensors = null;
  var hudOn = true;
  var hudTimer = null;

  // Velocimetro: arco de 270deg com vao embaixo (225deg -> 495deg)
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

    var state = "";
    if (hasVal && s.crit != null && s.value >= s.crit) state = "crit";
    else if (hasVal && s.warn != null && s.value >= s.warn) state = "warn";
    var color = state === "crit" ? "#f85149" : state === "warn" ? "#f0b429" : "#3fb950";

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

    var unit = s.unit ? '<small>' + s.unit + '</small>' : '';
    return '<div class="gauge ' + state + '">' + svg +
      '<div class="icon">' + (s.icon || '') + '</div>' +
      '<div class="val">' + (hasVal ? String(s.value) : '--') + unit + '</div>' +
      '</div>';
  }

  function buildHud(hud, data) {
    hud.innerHTML = "";
    if (!data || data.enabled === false || data.ok === false) return;
    var html = (data.sensors || []).map(buildGauge).join("");
    (data.alarms || []).forEach(function (label) {
      html += '<div class="alarm">⚠ ' + label + '</div>';
    });
    hud.innerHTML = html;
  }

  function refreshHuds() {
    players.forEach(function (p) { buildHud(p.hud, lastSensors); });
  }

  function pollSensors() {
    fetch("/api/sensors")
      .then(function (r) { return r.json(); })
      .then(function (data) { lastSensors = data; refreshHuds(); })
      .catch(function () {});
  }

  function startHud() {
    if (hudTimer) return;
    pollSensors();
    hudTimer = setInterval(pollSensors, 5000);
  }

  function stopHud() {
    if (hudTimer) { clearInterval(hudTimer); hudTimer = null; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function Player(channel) {
    this.channel = channel;
    this.hls = null;
    this.retry = 0;
    this.timer = null;

    this.root = el("div", "cam");
    this.video = el("video");
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.controls = true;

    this.dot = el("span", "dot");
    var bar = el("div", "bar");
    bar.appendChild(this.dot);
    bar.appendChild(el("span", null, "Canal " + channel));
    var actions = el("div", "actions");
    var self = this;
    var fsBtn = el("button", null, "⛶ Tela cheia");
    fsBtn.title = "Tela cheia";
    fsBtn.onclick = function () { self.toggleFullscreen(); };
    var btn = el("button", null, "Reconectar");
    btn.onclick = function () { self.load(); };
    actions.appendChild(fsBtn);
    actions.appendChild(btn);
    bar.appendChild(actions);

    this.status = el("div", "status", "Conectando...");
    this.hud = el("div", "hud" + (hudOn ? "" : " hidden"));

    this.root.appendChild(this.video);
    this.root.appendChild(this.status);
    this.root.appendChild(this.hud);
    this.root.appendChild(bar);

    if (lastSensors) buildHud(this.hud, lastSensors);
  }

  Player.prototype.setState = function (state, message) {
    this.dot.className = "dot" + (state === "live" ? " live" : state === "error" ? " err" : "");
    if (state === "live") {
      this.status.className = "status hidden";
    } else {
      this.status.className = "status" + (state === "error" ? " error" : "");
      this.status.textContent = message || "";
    }
  };

  Player.prototype.toggleFullscreen = function () {
    var doc = document;
    var current = doc.fullscreenElement || doc.webkitFullscreenElement;
    if (current) {
      (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
      return;
    }
    if (this.root.requestFullscreen) {
      this.root.requestFullscreen().catch(function () {});
    } else if (this.root.webkitRequestFullscreen) {
      this.root.webkitRequestFullscreen();
    } else if (this.video.webkitEnterFullscreen) {
      // iOS Safari: so o elemento <video> vai a tela cheia
      this.video.webkitEnterFullscreen();
    }
  };

  Player.prototype.url = function () {
    return "/stream/" + this.channel + "/index.m3u8?subtype=" + subtypeSel.value;
  };

  Player.prototype.destroy = function () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.video.removeAttribute("src");
  };

  Player.prototype.scheduleRetry = function (reason) {
    var self = this;
    this.retry += 1;
    var delay = Math.min(2000 * this.retry, 15000);
    this.setState("error", reason + " - nova tentativa em " + (delay / 1000) + "s");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.load(); }, delay);
  };

  Player.prototype.load = function () {
    var self = this;
    this.destroy();
    this.setState("loading", "Conectando ao canal " + this.channel + "...");
    var src = this.url();

    // Safari / iOS reproduzem HLS nativamente
    if (!window.Hls || !window.Hls.isSupported()) {
      if (this.video.canPlayType("application/vnd.apple.mpegurl")) {
        this.video.src = src;
        this.video.addEventListener("loadeddata", function () {
          self.retry = 0;
          self.setState("live");
        });
        this.video.addEventListener("error", function () {
          self.scheduleRetry("Falha no stream");
        });
        this.video.play().catch(function () {});
        return;
      }
      this.setState("error", "Navegador sem suporte a HLS");
      return;
    }

    this.hls = new Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      maxBufferLength: 6,
      backBufferLength: 10,
      manifestLoadingTimeOut: 30000,
      manifestLoadingMaxRetry: 2,
      fragLoadingTimeOut: 20000
    });

    this.hls.on(Hls.Events.MANIFEST_PARSED, function () {
      self.video.play().catch(function () {});
    });

    this.hls.on(Hls.Events.FRAG_BUFFERED, function () {
      if (self.retry !== 0 || self.dot.className.indexOf("live") === -1) {
        self.retry = 0;
        self.setState("live");
      }
    });

    this.hls.on(Hls.Events.ERROR, function (_evt, data) {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          self.scheduleRetry("Camera indisponivel");
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          self.hls.recoverMediaError();
          break;
        default:
          self.scheduleRetry("Erro fatal");
      }
    });

    this.hls.loadSource(src);
    this.hls.attachMedia(this.video);
  };

  function render(channels) {
    players.forEach(function (p) { p.destroy(); });
    players = [];
    grid.innerHTML = "";
    channels.forEach(function (ch) {
      var p = new Player(ch);
      players.push(p);
      grid.appendChild(p.root);
      p.load();
    });
    startHud();
  }

  var channels = [];

  fetch("/api/channels")
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      channels = cfg.channels;
      subtypeSel.value = String(cfg.default_subtype);
      render(channels);
    })
    .catch(function () {
      grid.appendChild(el("div", "status error", "Nao foi possivel carregar a configuracao."));
    });

  layoutSel.onchange = function () { grid.className = "grid cols-" + layoutSel.value; };
  subtypeSel.onchange = function () { render(channels); };
  document.getElementById("reload").onclick = function () { render(channels); };

  var toggleHudBtn = document.getElementById("toggleHud");
  toggleHudBtn.onclick = function () {
    hudOn = !hudOn;
    players.forEach(function (p) {
      p.hud.className = "hud" + (hudOn ? "" : " hidden");
    });
    toggleHudBtn.textContent = "Sensores: " + (hudOn ? "on" : "off");
  };

  // Pausa os streams quando a aba fica oculta, liberando o ffmpeg no servidor
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopHud();
      players.forEach(function (p) { p.destroy(); });
    } else if (channels.length) {
      players.forEach(function (p) { p.load(); });
      startHud();
    }
  });
})();
