"""Gateway RTSP -> HLS: expoe cameras Dahua/Intelbras em HTTP para o navegador."""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
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

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _validate(channel: int, subtype: int) -> None:
    if not 1 <= channel <= 64:
        raise HTTPException(400, f"canal invalido: {channel}")
    if subtype not in (0, 1, 2):
        raise HTTPException(400, f"subtype invalido: {subtype}")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


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
