/* Player HLS multi-camera com reconexao automatica.
   O overlay de sensores fica em hud.js (window.SensorHUD). */
(function () {
  "use strict";

  var grid = document.getElementById("grid");
  var subtypeSel = document.getElementById("subtype");
  var layoutSel = document.getElementById("layout");
  var players = [];

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
    this.hud = el("div", "hud");

    this.root.appendChild(this.video);
    this.root.appendChild(this.status);
    this.root.appendChild(this.hud);
    this.root.appendChild(bar);

    SensorHUD.register(this.hud);
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
    SensorHUD.clear();
    players = [];
    grid.innerHTML = "";
    channels.forEach(function (ch) {
      var p = new Player(ch);
      players.push(p);
      grid.appendChild(p.root);
      p.load();
    });
    SensorHUD.start();
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

  // Pausa os streams quando a aba fica oculta, liberando o ffmpeg no servidor
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      SensorHUD.stop();
      players.forEach(function (p) { p.destroy(); });
    } else if (channels.length) {
      players.forEach(function (p) { p.load(); });
      SensorHUD.start();
    }
  });
})();
