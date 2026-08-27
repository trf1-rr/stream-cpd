"""Gateway RTSP -> HLS: expoe cameras Dahua/Intelbras em HTTP para o navegador."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

from . import snmp
from .config import SNMP_ALARMS, SNMP_SENSORS, settings
from .streamer import manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("main")

STATIC_DIR = Path(__file__).parent / "static"
SEGMENT_RE = re.compile(r"^seg_\d{5}\.ts$")

NO_CACHE = {
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.hls_root).mkdir(parents=True, exist_ok=True)
    manager.start_background()
    log.info("pronto. canais configurados: %s", settings.channels)
    log.info("origem: %s", settings.rtsp_url_masked(settings.channels[0]))
    yield
    await manager.shutdown()


app = FastAPI(
    title="RTSP -> HLS Gateway",
    description="Converte streams RTSP em HLS reproduzivel no navegador.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

class RevalidateStatic(StaticFiles):
    """Estaticos com 'no-cache': o navegador sempre revalida via ETag.

    Sem isso o browser aplica cache heuristico e pode servir um player.js
    antigo apos um deploy. Com ETag presente, arquivo inalterado responde
    304 (barato) e arquivo alterado baixa a versao nova automaticamente.
    """

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", RevalidateStatic(directory=str(STATIC_DIR)), name="static")


def _validate(channel: int, subtype: int) -> None:
    if not 1 <= channel <= 64:
        raise HTTPException(400, f"canal invalido: {channel}")
    if subtype not in (0, 1, 2):
        raise HTTPException(400, f"subtype invalido: {subtype}")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse(
        (STATIC_DIR / "index.html").read_text(encoding="utf-8"),
        headers=NO_CACHE,
    )


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "streams": len(manager.streams)}


@app.get("/api/channels")
async def list_channels() -> dict:
    return {
        "channels": settings.channels,
        "default_subtype": settings.rtsp_subtype,
    }


@app.get("/api/streams")
async def list_streams() -> dict:
    return {"streams": [s.info() for s in manager.streams.values()]}


_sensor_cache: dict = {"ts": 0.0, "data": None}
_sensor_lock = asyncio.Lock()


def _to_number(raw) -> float | None:
    if raw is None:
        return None
    try:
        return float(str(raw).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


@app.get("/api/sensors")
async def sensors() -> dict:
    """Le os sensores do Conflex via SNMP para o overlay do player.

    Resultado cacheado por alguns segundos: varios clientes/cameras compartilham
    a mesma leitura em vez de martelar o agente.
    """
    if not settings.snmp_enabled:
        return {"enabled": False, "sensors": [], "alarms": []}

    async with _sensor_lock:
        now = time.monotonic()
        cached = _sensor_cache["data"]
        if cached is not None and now - _sensor_cache["ts"] < 3.0:
            return cached

        oids = [s["oid"] for s in SNMP_SENSORS] + [a["oid"] for a in SNMP_ALARMS]
        try:
            raw = await asyncio.to_thread(
                snmp.get_many,
                settings.snmp_host,
                oids,
                settings.snmp_community,
                settings.snmp_port,
                1.5,
            )
        except Exception as exc:  # rede/parso: degrada sem derrubar o player
            log.warning("SNMP falhou: %s", exc)
            data = {"enabled": True, "ok": False, "sensors": [], "alarms": []}
            _sensor_cache.update(ts=now, data=data)
            return data

        sensors_out = []
        for spec in SNMP_SENSORS:
            num = _to_number(raw.get(spec["oid"]))
            value = (
                round(num * spec.get("scale", 1), spec.get("digits", 1))
                if num is not None
                else None
            )
            sensors_out.append(
                {
                    "label": spec["label"],
                    "value": value,
                    "unit": spec.get("unit", ""),
                    "icon": spec.get("icon", ""),
                    "min": spec.get("min", 0),
                    "max": spec.get("max", 100),
                    "warn": spec.get("warn"),
                    "crit": spec.get("crit"),
                }
            )

        alarms_out = [
            a["label"]
            for a in SNMP_ALARMS
            if (_to_number(raw.get(a["oid"])) or 0) != 0
        ]

        data = {
            "enabled": True,
            "ok": True,
            "sensors": sensors_out,
            "alarms": alarms_out,
        }
        _sensor_cache.update(ts=now, data=data)
        return data


@app.post("/api/streams/{channel}/stop")
async def stop_stream(
    channel: int, subtype: int = Query(default=settings.rtsp_subtype)
) -> dict:
    _validate(channel, subtype)
    stopped = await manager.stop(channel, subtype)
    return {"stopped": stopped, "channel": channel, "subtype": subtype}


@app.get("/stream/{channel}/index.m3u8")
async def playlist(
    channel: int, subtype: int = Query(default=settings.rtsp_subtype)
):
    """Playlist HLS. Inicia o ffmpeg do canal na primeira chamada."""
    _validate(channel, subtype)
    stream = await manager.get_or_start(channel, subtype)

    if not await stream.wait_ready():
        detail = stream.last_error or "sem resposta da camera dentro do timeout"
        log.error("canal %s nao ficou pronto: %s", channel, detail)
        raise HTTPException(
            status_code=504,
            detail=f"nao foi possivel abrir o canal {channel}: {detail}",
        )

    return FileResponse(
        stream.playlist,
        media_type="application/vnd.apple.mpegurl",
        headers=NO_CACHE,
    )


@app.get("/stream/{channel}/{segment}")
async def segment(
    channel: int, segment: str, subtype: int = Query(default=settings.rtsp_subtype)
):
    """Entrega um segmento .ts do canal."""
    _validate(channel, subtype)
    if not SEGMENT_RE.match(segment):
        raise HTTPException(404, "segmento invalido")

    stream = manager.get(channel, subtype)
    if stream is None:
        raise HTTPException(404, "stream nao iniciado")

    stream.touch()
    path = stream.dir / segment
    if not path.exists():
        raise HTTPException(404, "segmento expirado")

    return FileResponse(
        path,
        media_type="video/mp2t",
        headers={"Cache-Control": "public, max-age=10"},
    )


@app.exception_handler(HTTPException)
async def http_error(request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "path": str(request.url.path)},
    )
