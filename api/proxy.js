// api/proxy.js
// Proxy universal para NerdPixelTV Player
// Resolve CORS tanto para listas M3U/Xtream quanto para streams HLS (.m3u8/.ts)
//
// Uso:
//   /api/proxy?url=<URL_ORIGINAL_ENCODADA>
//
// Roda como Vercel Serverless Function (Node.js runtime).

export default async function handler(req, res) {
  // CORS aberto pro player (qualquer origem pode chamar este proxy)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const targetUrl = req.query.url;

  if (!targetUrl) {
    res.status(400).json({ error: "Parâmetro 'url' é obrigatório. Uso: /api/proxy?url=..." });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (e) {
    res.status(400).json({ error: "URL inválida." });
    return;
  }

  // Segurança básica: só permite http/https
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    res.status(400).json({ error: "Protocolo não permitido." });
    return;
  }

  try {
    const upstreamHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    };

    // Repassa o header Range para permitir seek em vídeos (.ts/.mp4) e streaming parcial
    if (req.headers.range) {
      upstreamHeaders["Range"] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const contentType = upstreamRes.headers.get("content-type") || "";
    const isPlaylist =
      contentType.includes("mpegurl") ||
      contentType.includes("vnd.apple.mpegurl") ||
      targetUrl.toLowerCase().includes(".m3u8") ||
      targetUrl.toLowerCase().includes("type=m3u") ||
      targetUrl.toLowerCase().includes("get.php");

    // ---- CASO 1: é uma playlist M3U/M3U8 (texto) ----
    // Precisamos reescrever as URLs internas da playlist para passarem pelo proxy também,
    // senão os .ts/.m3u8 referenciados dentro dela vão tentar carregar direto do servidor
    // de origem e cair no mesmo bloqueio de CORS.
    if (isPlaylist) {
      const text = await upstreamRes.text();

      // Se for um M3U "Xtream" comum (lista de canais), não tem sub-playlists,
      // mas algumas listas .m3u8 (HLS real) referenciam segmentos/variantes relativas.
      const rewritten = rewritePlaylistUrls(text, targetUrl);

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.status(upstreamRes.status).send(rewritten);
      return;
    }

    // ---- CASO 2: é mídia binária (.ts, .mp4, segmentos, etc) ----
    res.status(upstreamRes.status);

    // Repassa headers relevantes de mídia
    const passthroughHeaders = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ];
    passthroughHeaders.forEach((h) => {
      const v = upstreamRes.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    const arrayBuffer = await upstreamRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(502).json({ error: "Falha ao buscar o conteúdo de origem.", detail: String(err) });
  }
}

// Reescreve URLs relativas/absolutas dentro de uma playlist M3U8
// para que cada linha de stream/segmento também passe pelo proxy.
function rewritePlaylistUrls(playlistText, baseUrl) {
  const lines = playlistText.split(/\r?\n/);
  const base = new URL(baseUrl);

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;

    let absolute;
    try {
      absolute = new URL(trimmed, base).toString();
    } catch (e) {
      return line;
    }

    return "/api/proxy?url=" + encodeURIComponent(absolute);
  });

  return out.join("\n");
}
