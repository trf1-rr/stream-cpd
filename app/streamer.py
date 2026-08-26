"""Gerencia processos ffmpeg que convertem RTSP -> HLS sob demanda."""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
from pathlib import Path

from .config import settings

log = logging.getLogger("streamer")


class Stream:
    """Um canal RTSP sendo convertido para HLS."""

    def __init__(self, channel: int, subtype: int) -> None:
        self.channel = channel
        self.subtype = subtype
        self.key = f"{channel}_{subtype}"
        self.dir = Path(settings.hls_root) / self.key
        self.playlist = self.dir / "index.m3u8"
        self.proc: asyncio.subprocess.Process | None = None
        self.last_access = time.monotonic()
        self.started_at: float | None = None
        self.last_error: str | None = None
        self.restarts = 0
        self._lock = asyncio.Lock()
        self._watchdog: asyncio.Task | None = None

    def _ffmpeg_cmd(self) -> list[str]:
        url = settings.rtsp_url(self.channel, self.subtype)
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel", "error",
            "-fflags", "+genpts",
            "-rtsp_transport", settings.rtsp_transport,
            "-timeout", "5000000",
            "-use_wallclock_as_timestamps", "1",
            "-i", url,
        ]

        if settings.transcode:
            cmd += [
                "-c:v", "libx264",
                "-preset", settings.x264_preset,
                "-tune", "zerolatency",
                "-profile:v", "baseline",
                "-level", "3.1",
                "-pix_fmt", "yuv420p",
                "-b:v", settings.video_bitrate,
                "-maxrate", settings.video_bitrate,
                "-bufsize", "2M",
                "-g", "30",
                "-sc_threshold", "0",
            ]
        else:
            cmd += ["-c:v", "copy"]

        if settings.audio:
            cmd += ["-c:a", "aac", "-ar", "44100", "-b:a", "64k"]
        else:
            cmd += ["-an"]

        cmd += [
            "-f", "hls",
            "-hls_time", str(settings.hls_time),
            "-hls_list_size", str(settings.hls_list_size),
            "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
            "-hls_segment_type", "mpegts",
            "-hls_allow_cache", "0",
            "-hls_segment_filename", str(self.dir / "seg_%05d.ts"),
            str(self.playlist),
        ]
        return cmd

    async def start(self) -> None:
        async with self._lock:
            if self.is_running:
                return

            # limpa segmentos antigos antes de recomecar
            if self.dir.exists():
                shutil.rmtree(self.dir, ignore_errors=True)
            self.dir.mkdir(parents=True, exist_ok=True)

            cmd = self._ffmpeg_cmd()
            log.info(
                "canal %s: iniciando ffmpeg -> %s",
                self.channel,
                settings.rtsp_url_masked(self.channel, self.subtype),
            )
            self.proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            self.started_at = time.monotonic()
            self.last_error = None
            self._watchdog = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        """Consome o stderr do ffmpeg e guarda a ultima mensagem de erro."""
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        try:
            async for raw in proc.stderr:
                line = raw.decode(errors="replace").strip()
                if not line:
                    continue
                self.last_error = line
                log.warning("canal %s ffmpeg: %s", self.channel, line)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("canal %s: erro lendo stderr", self.channel)

    @property
    def is_running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def wait_ready(self, timeout: float | None = None) -> bool:
        """Aguarda o ffmpeg escrever o playlist com pelo menos um segmento."""
        timeout = timeout or settings.start_timeout
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.is_running:
                return False
            if self.playlist.exists():
                try:
                    if ".ts" in self.playlist.read_text(errors="replace"):
                        return True
                except OSError:
                    pass
            await asyncio.sleep(0.2)
        return False

    async def stop(self) -> None:
        async with self._lock:
            if self._watchdog:
                self._watchdog.cancel()
                self._watchdog = None
            if self.proc and self.proc.returncode is None:
                log.info("canal %s: encerrando ffmpeg", self.channel)
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()
            self.proc = None
            self.started_at = None
            shutil.rmtree(self.dir, ignore_errors=True)

    def touch(self) -> None:
        self.last_access = time.monotonic()

    def info(self) -> dict:
        return {
            "channel": self.channel,
            "subtype": self.subtype,
            "running": self.is_running,
            "uptime": round(time.monotonic() - self.started_at, 1) if self.started_at else 0,
            "idle": round(time.monotonic() - self.last_access, 1),
            "restarts": self.restarts,
            "last_error": self.last_error,
            "source": settings.rtsp_url_masked(self.channel, self.subtype),
        }


class StreamManager:
    """Pool de streams: cria sob demanda, reinicia em falha, mata quando ocioso."""

    def __init__(self) -> None:
        self.streams: dict[str, Stream] = {}
        self._reaper: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def get_or_start(self, channel: int, subtype: int) -> Stream:
        key = f"{channel}_{subtype}"
        async with self._lock:
            stream = self.streams.get(key)
            if stream is None:
                stream = Stream(channel, subtype)
                self.streams[key] = stream

        stream.touch()
        if not stream.is_running:
            await stream.start()
        return stream

    def get(self, channel: int, subtype: int) -> Stream | None:
        return self.streams.get(f"{channel}_{subtype}")

    async def stop(self, channel: int, subtype: int) -> bool:
        stream = self.get(channel, subtype)
        if stream is None:
            return False
        await stream.stop()
        return True

    async def stop_all(self) -> None:
        await asyncio.gather(
            *(s.stop() for s in self.streams.values()), return_exceptions=True
        )
        self.streams.clear()

    def start_background(self) -> None:
        if self._reaper is None:
            self._reaper = asyncio.create_task(self._loop())

    async def shutdown(self) -> None:
        if self._reaper:
            self._reaper.cancel()
            self._reaper = None
        await self.stop_all()

    async def _loop(self) -> None:
        """A cada 5s encerra streams ociosos e reergue os que morreram sozinhos."""
        while True:
            try:
                await asyncio.sleep(5)
                now = time.monotonic()
                for stream in list(self.streams.values()):
                    idle = now - stream.last_access
                    if stream.is_running and idle > settings.idle_timeout:
                        log.info(
                            "canal %s ocioso ha %.0fs: encerrando", stream.channel, idle
                        )
                        await stream.stop()
                    elif not stream.is_running and idle <= settings.idle_timeout:
                        # ainda ha cliente assistindo mas o ffmpeg caiu
                        stream.restarts += 1
                        log.warning(
                            "canal %s: ffmpeg caiu, reiniciando (tentativa %d)",
                            stream.channel,
                            stream.restarts,
                        )
                        await asyncio.sleep(settings.restart_backoff)
                        await stream.start()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("erro no loop de manutencao")


manager = StreamManager()
