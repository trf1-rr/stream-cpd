"""Cliente SNMP v1 minimo (GetRequest), puro Python — sem dependencias.

SNMP v1 e apenas BER/DER sobre UDP. Este modulo implementa o suficiente para
ler OIDs escalares do Conflex: encode de INTEGER/OCTET STRING/OID/NULL, o PDU
GetRequest com uma ou varias varbinds, e o parse da resposta.

E sincrono (socket bloqueante com timeout curto). Chame via asyncio.to_thread
para nao travar o event loop do FastAPI.
"""
from __future__ import annotations

import socket
import threading

_reqid_lock = threading.Lock()
_reqid = 0


def _next_reqid() -> int:
    global _reqid
    with _reqid_lock:
        _reqid = (_reqid + 1) & 0x7FFFFFFF
        return _reqid or 1


# ---- encoders BER -----------------------------------------------------------

def _enc_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    b = bytearray()
    while n:
        b.insert(0, n & 0xFF)
        n >>= 8
    return bytes([0x80 | len(b)]) + bytes(b)


def _tlv(tag: int, val: bytes) -> bytes:
    return bytes([tag]) + _enc_len(len(val)) + val


def _enc_int(n: int) -> bytes:
    if n == 0:
        return _tlv(0x02, b"\x00")
    b = bytearray()
    v = abs(n)
    while v:
        b.insert(0, v & 0xFF)
        v >>= 8
    if b[0] & 0x80:
        b.insert(0, 0)
    return _tlv(0x02, bytes(b))


def _enc_oid(oid: str) -> bytes:
    parts = [int(x) for x in oid.strip(".").split(".")]
    body = bytearray([40 * parts[0] + parts[1]])
    for p in parts[2:]:
        if p < 0x80:
            body.append(p)
        else:
            stack = []
            while p:
                stack.insert(0, p & 0x7F)
                p >>= 7
            for i in range(len(stack) - 1):
                stack[i] |= 0x80
            body.extend(stack)
    return _tlv(0x06, bytes(body))


# ---- decoders ---------------------------------------------------------------

def _read_tlv(data: bytes, i: int):
    tag = data[i]
    i += 1
    length = data[i]
    i += 1
    if length & 0x80:
        nb = length & 0x7F
        length = int.from_bytes(data[i:i + nb], "big")
        i += nb
    return tag, data[i:i + length], i + length


def _dec_oid(b: bytes) -> str:
    vals = [b[0] // 40, b[0] % 40]
    cur = 0
    for x in b[1:]:
        cur = (cur << 7) | (x & 0x7F)
        if not (x & 0x80):
            vals.append(cur)
            cur = 0
    return ".".join(map(str, vals))


def _dec_value(tag: int, b: bytes):
    if tag == 0x02:  # INTEGER
        return int.from_bytes(b, "big", signed=True)
    if tag == 0x04:  # OCTET STRING
        return b.decode("latin-1")
    if tag in (0x41, 0x42, 0x43):  # Counter / Gauge / TimeTicks
        return int.from_bytes(b, "big")
    if tag == 0x40:  # IpAddress
        return ".".join(map(str, b))
    # 0x05 NULL, 0x80/0x81/0x82 noSuchObject/Instance/endOfMibView
    return None


def _build_get(community: str, oids: list[str], reqid: int) -> bytes:
    varbinds = b"".join(_tlv(0x30, _enc_oid(o) + _tlv(0x05, b"")) for o in oids)
    pdu = _tlv(
        0xA0,  # GetRequest
        _enc_int(reqid) + _enc_int(0) + _enc_int(0) + _tlv(0x30, varbinds),
    )
    return _tlv(0x30, _enc_int(0) + _tlv(0x04, community.encode()) + pdu)


def _parse(data: bytes):
    """Retorna (error_status, {oid: valor})."""
    _, msg, _ = _read_tlv(data, 0)
    i = 0
    _, _, i = _read_tlv(msg, i)   # version
    _, _, i = _read_tlv(msg, i)   # community
    _, pdu, _ = _read_tlv(msg, i)
    j = 0
    _, _, j = _read_tlv(pdu, j)          # request-id
    _, errst, j = _read_tlv(pdu, j)      # error-status
    _, _, j = _read_tlv(pdu, j)          # error-index
    _, vbs, _ = _read_tlv(pdu, j)        # varbind list
    out: dict[str, object] = {}
    k = 0
    while k < len(vbs):
        _, vb, k = _read_tlv(vbs, k)
        p = 0
        _, oidb, p = _read_tlv(vb, p)
        vtag, valb, _ = _read_tlv(vb, p)
        out[_dec_oid(oidb)] = _dec_value(vtag, valb)
    return int.from_bytes(errst, "big"), out


def _query(host: str, port: int, community: str, oids: list[str], timeout: float):
    reqid = _next_reqid()
    msg = _build_get(community, oids, reqid)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(msg, (host, port))
        data, _ = s.recvfrom(65535)
    finally:
        s.close()
    return _parse(data)


def get_many(
    host: str,
    oids: list[str],
    community: str = "public",
    port: int = 161,
    timeout: float = 1.5,
) -> dict:
    """Le varias OIDs. Retorna {oid: valor} (valor ausente = OID omitida).

    Consulta uma OID por requisicao: o agente do Conflex so responde GETs com
    uma unica varbind (varias varbinds sao ignoradas). Cada consulta e um
    round-trip UDP de poucos ms; uma OID que falhe/expire e apenas pulada, sem
    derrubar as demais.
    """
    result: dict[str, object] = {}
    for oid in oids:
        try:
            errst, one = _query(host, port, community, [oid], timeout)
            if errst == 0:
                result.update(one)
        except OSError:
            pass
    return result
