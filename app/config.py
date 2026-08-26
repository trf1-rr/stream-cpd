"""Configuracoes carregadas de variaveis de ambiente."""
import os
from dataclasses import dataclass, field


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on", "sim")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _parse_channels(raw: str) -> list[int]:
    """Aceita '1,2,3' ou '1-8' ou combinacoes: '1-4,7,9'."""
    channels: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start, _, end = part.partition("-")
            channels.extend(range(int(start), int(end) + 1))
        else:
            channels.append(int(part))
    return sorted(set(channels))


@dataclass
class Settings:
    rtsp_user: str = os.getenv("RTSP_USER", "admin")
    rtsp_password: str = os.getenv("RTSP_PASSWORD", "admin")
    rtsp_host: str = os.getenv("RTSP_HOST", "172.29.4.120")
    rtsp_port: int = _env_int("RTSP_PORT", 554)
    # {channel} e {subtype} sao substituidos em tempo de execucao
    rtsp_path: str = os.getenv(
        "RTSP_PATH", "/cam/realmonitor?channel={channel}&subtype={subtype}"
    )
    rtsp_subtype: int = _env_int("RTSP_SUBTYPE", 1)
    rtsp_transport: str = os.getenv("RTSP_TRANSPORT", "tcp")  # tcp | udp

    channels: list[int] = field(
        default_factory=lambda: _parse_channels(os.getenv("CHANNELS", "1-4"))
    )

    # HLS
    hls_root: str = os.getenv("HLS_ROOT", "/tmp/hls")
    hls_time: float = float(os.getenv("HLS_TIME", "1"))
    hls_list_size: int = _env_int("HLS_LIST_SIZE", 6)

    # Transcodificacao: 0 = copy (mais leve, exige H.264 na camera)
    #                   1 = reencode para H.264 (compatibilidade maxima)
    transcode: bool = _env_bool("TRANSCODE", False)
    video_bitrate: str = os.getenv("VIDEO_BITRATE", "1200k")
    x264_preset: str = os.getenv("X264_PRESET", "veryfast")
    audio: bool = _env_bool("AUDIO", False)

    # Gerencia de processos
    idle_timeout: int = _env_int("IDLE_TIMEOUT", 30)      # segundos sem request -> mata ffmpeg
    start_timeout: int = _env_int("START_TIMEOUT", 20)     # segundos aguardando 1o playlist
    restart_backoff: int = _env_int("RESTART_BACKOFF", 3)  # segundos entre reinicios

    def rtsp_url(self, channel: int, subtype: int | None = None) -> str:
        from urllib.parse import quote

        sub = self.rtsp_subtype if subtype is None else subtype
        path = self.rtsp_path.format(channel=channel, subtype=sub)
        user = quote(self.rtsp_user, safe="")
        pwd = quote(self.rtsp_password, safe="")
        return f"rtsp://{user}:{pwd}@{self.rtsp_host}:{self.rtsp_port}{path}"

    def rtsp_url_masked(self, channel: int, subtype: int | None = None) -> str:
        sub = self.rtsp_subtype if subtype is None else subtype
        path = self.rtsp_path.format(channel=channel, subtype=sub)
        return f"rtsp://{self.rtsp_user}:***@{self.rtsp_host}:{self.rtsp_port}{path}"


settings = Settings()
