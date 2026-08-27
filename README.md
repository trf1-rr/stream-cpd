# stream-cpd — RTSP para o navegador

Converte streams RTSP de DVR/câmeras Dahua/Intelbras em **HLS**, que qualquer
navegador moderno reproduz — sem plugin, sem VLC, sem ActiveX.

```
rtsp://admin:admin@172.29.4.120:554/cam/realmonitor?channel=N&subtype=1
                       |
                  [ ffmpeg ]  RTSP -> HLS (segmentos .ts)
                       |
                  [ FastAPI ]  http://SEU_HOST:8080
                       |
                  [ hls.js ]  <video> no navegador
```

## Por que HLS

RTSP não é suportado nativamente por nenhum navegador. O ffmpeg reempacota o
fluxo em segmentos HTTP curtos (`.ts`) que o `hls.js` alimenta em um `<video>`
comum. A latência fica em torno de **2–4 s** — adequado para monitoramento.
Se você precisa de sub-segundo, o caminho é WebRTC (veja *Alternativas*).

## Deploy no Easypanel

O projeto é só um Dockerfile — não precisa de compose.

1. **Suba o código para um repositório Git** (GitHub/GitLab). No Easypanel:
   *Create Service → App*.
2. **Source**: aponte para o repositório e branch.
3. **Build**: escolha o método **Dockerfile** (caminho `Dockerfile`, contexto `/`).
   O Easypanel detecta sozinho na maioria dos casos.
4. **Environment**: cole o conteúdo de [`easypanel.env`](easypanel.env) no editor
   de variáveis e ajuste IP, usuário, senha e canais.
5. **Domains**: adicione um domínio apontando para a **porta 8080** (o serviço
   também respeita a variável `PORT` se você preferir outra).
6. **Deploy**. O player fica na raiz do domínio.

> Se preferir não usar Git, use *Create Service → App → Source: Docker Image*
> depois de publicar a imagem em um registry:
> `docker build -t seu-registry/stream-cpd . && docker push seu-registry/stream-cpd`

### O servidor precisa enxergar a câmera

`172.29.4.120` é um IP privado. O container do Easypanel só abre esse RTSP se o
servidor onde o Easypanel roda estiver **na mesma rede** (ou com rota/VPN até
ela). Se o Easypanel estiver em uma VPS na internet, o stream não vai subir —
nesse caso rode este serviço em uma máquina dentro do CPD, ou monte uma VPN
entre a VPS e a rede local. Confira antes com o teste de `ffprobe` em
*Diagnóstico*.

### Sobre o disco

Os segmentos HLS são gravados em `/tmp/hls` dentro do container, poucos
megabytes por canal, e são apagados quando o canal fica ocioso. Não precisa de
volume — na verdade **não monte volume nesse caminho**, ele é descartável de
propósito.

## Rodar local (opcional)

O `docker-compose.yml` existe só para testes na sua máquina:

```bash
cp .env.example .env
docker compose up -d --build
```

Ou sem compose:

```bash
docker build -t stream-cpd .
docker run -d --name stream-cpd -p 8080:8080 --env-file easypanel.env stream-cpd
```

Abra **http://localhost:8080**.

## Endpoints

| Rota | Descrição |
|---|---|
| `GET /` | Player com grade de câmeras |
| `GET /view/{canal}?subtype=0` | Uma câmera ocupando a tela inteira |
| `GET /stream/{canal}/index.m3u8?subtype=1` | Playlist HLS — **cole esta URL no VLC/OBS** |
| `GET /stream/{canal}/seg_00001.ts` | Segmento de vídeo |
| `GET /api/channels` | Canais configurados |
| `GET /api/streams` | Status dos processos ffmpeg ativos |
| `GET /api/sensors` | Leituras SNMP (temperatura/umidade) do overlay |
| `POST /api/streams/{canal}/stop` | Encerra o ffmpeg de um canal |
| `GET /healthz` | Health check |

Para embutir uma câmera em outra página:

```html
<video id="cam" controls muted autoplay playsinline></video>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17"></script>
<script>
  const hls = new Hls();
  hls.loadSource("http://IP_DO_SERVIDOR:8080/stream/1/index.m3u8?subtype=1");
  hls.attachMedia(document.getElementById("cam"));
</script>
```

## Como funciona o ciclo de vida

Nenhum ffmpeg roda até alguém pedir. Ao abrir `/stream/3/index.m3u8`, o canal 3
sobe; enquanto o navegador buscar segmentos, ele continua vivo. Passados
`IDLE_TIMEOUT` segundos sem requisição, o processo é encerrado e os segmentos
apagados. Se o ffmpeg morrer com um cliente ainda assistindo, o supervisor o
reergue automaticamente. Assim 32 canais configurados custam CPU apenas pelos
que estão sendo vistos.

## Configuração (variáveis de ambiente)

| Variável | Padrão | Observação |
|---|---|---|
| `RTSP_USER` / `RTSP_PASSWORD` | `admin` / `admin` | Caracteres especiais são escapados automaticamente |
| `RTSP_HOST` / `RTSP_PORT` | `172.29.4.120` / `554` | |
| `RTSP_PATH` | `/cam/realmonitor?channel={channel}&subtype={subtype}` | Troque para outros fabricantes |
| `RTSP_SUBTYPE` | `1` | `0` = principal (HD), `1` = substream |
| `RTSP_TRANSPORT` | `tcp` | `udp` reduz latência mas perde pacotes |
| `CHANNELS` | `1-4` | `1,2,5` ou `1-8` ou `1-4,7,9` |
| `TRANSCODE` | `false` | `true` **só** se a câmera for H.265 |
| `HLS_TIME` | `1` | Segmento menor = menos latência, mais requisições |
| `IDLE_TIMEOUT` | `30` | Segundos sem cliente até matar o ffmpeg |
| `SNMP_ENABLED` | `true` | Overlay de temperatura/umidade no vídeo; `false` desliga |
| `SNMP_HOST` / `SNMP_COMMUNITY` / `SNMP_PORT` | `172.29.4.22` / `public` / `161` | Controlador Conflex lido por SNMP v1 (OIDs em `app/config.py`) |

### Outros fabricantes

```bash
# Hikvision
RTSP_PATH=/Streaming/Channels/{channel}02
# Axis
RTSP_PATH=/axis-media/media.amp?camera={channel}
# ONVIF genérico
RTSP_PATH=/onvif{channel}
```

## Diagnóstico

**Tela preta e nada acontece.** Teste o RTSP direto de dentro do container —
isso isola problema de rede/credencial de problema da aplicação.
No Easypanel: abra o serviço → aba **Console** e rode:

```bash
ffprobe -rtsp_transport tcp \
  "rtsp://admin:admin@172.29.4.120:554/cam/realmonitor?channel=1&subtype=1"
```

- `401 Unauthorized` → usuário/senha errados em `RTSP_USER` / `RTSP_PASSWORD`.
- `Connection timed out` → o container não alcança a câmera. Veja
  *O servidor precisa enxergar a câmera*, acima.
- `Unknown codec hevc` / vídeo não roda mas o playlist carrega → a câmera é
  H.265. Ponha `TRANSCODE=true` nas variáveis e faça um novo deploy.

**Ver o que o ffmpeg está reclamando.** Os erros do ffmpeg vão para os logs do
serviço (aba **Logs** no Easypanel). O estado de cada canal também sai em JSON:

```
https://seu-dominio/api/streams
```

**Latência alta.** Baixe `HLS_TIME` para `0.5` e `HLS_LIST_SIZE` para `3`.
Abaixo disso o overhead de requisições passa a dominar.

**CPU alta.** `TRANSCODE=false` (padrão) apenas copia os pacotes e gasta ~2 % de
um core por canal. Com `TRANSCODE=true` cada canal consome um core inteiro —
use somente quando a câmera for H.265, e prefira `subtype=1`.

## Segurança

O serviço não tem autenticação: **qualquer um que abra o domínio vê as
câmeras.** As credenciais RTSP ficam apenas no servidor — nunca chegam ao
navegador — mas o vídeo em si fica aberto.

Se publicar um domínio no Easypanel, proteja antes de sair usando:

- ative **HTTPS/Let's Encrypt** no domínio (o Easypanel faz isso na aba Domains);
- ponha **Basic Auth** no serviço, ou deixe-o sem domínio público e acesse via
  IP interno/VPN;
- nunca reaproveite a senha `admin/admin` da câmera — troque no DVR e atualize
  `RTSP_PASSWORD`.

## Alternativas

Para latência abaixo de 1 s, o caminho é WebRTC — o [MediaMTX](https://github.com/bluenviron/mediamtx)
faz RTSP→WebRTC pronto para uso. O custo é maior complexidade (STUN/TURN,
sinalização) e HTTPS obrigatório na maioria dos navegadores. Para monitoramento
de CFTV, os 2–4 s do HLS costumam ser aceitáveis.
