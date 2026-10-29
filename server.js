// Servidor para rodar fora da Vercel (no seu computador, Render, Railway, VPS etc.).
// Uso: GROQ_API_KEY=sua-chave node server.js   →   http://localhost:3000
import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PASTA = path.dirname(fileURLToPath(import.meta.url));

// Acha a pasta "api" mesmo que tenha sido enviada como "API" ou "Api"
const nomePastaApi = (await readdir(PASTA)).find(n => n.toLowerCase() === "api");
if (!nomePastaApi) { console.error("Erro: não encontrei a pasta api com o arquivo ler-rotulo.js."); process.exit(1); }
const nomeArquivo = (await readdir(path.join(PASTA, nomePastaApi))).find(n => n.toLowerCase() === "ler-rotulo.js");
if (!nomeArquivo) { console.error(`Erro: não encontrei ler-rotulo.js dentro da pasta ${nomePastaApi}.`); process.exit(1); }
const { default: lerRotulo } = await import(pathToFileURL(path.join(PASTA, nomePastaApi, nomeArquivo)).href);
const PORTA = Number(process.env.PORT) || 3000;
const LIMITE = 12_000_000; // tamanho máximo do pedido

// Carrega um arquivo .env simples, se existir
try {
  const env = await readFile(path.join(PASTA, ".env"), "utf8");
  for (const linha of env.split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

function adaptar(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  adaptar(res);
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/ler-rotulo") {
    let tamanho = 0; const partes = [];
    req.on("data", c => { tamanho += c.length; if (tamanho > LIMITE) { res.status(413).json({ erro: "image_rejected" }); req.destroy(); } else partes.push(c); });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try { req.body = JSON.parse(Buffer.concat(partes).toString("utf8") || "{}"); } catch { req.body = {}; }
      await lerRotulo(req, res);
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await readFile(path.join(PASTA, "index.html"));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(html);
  }

  res.status(404).end("Não encontrado");
}).listen(PORTA, () => {
  console.log(`Rótulo Certo rodando em http://localhost:${PORTA}`);
  if (!["GROQ_API_KEY","OPENROUTER_API_KEY","GEMINI_API_KEY","ANTHROPIC_API_KEY"].some(k => process.env[k])) console.log("Atenção: falta GROQ_API_KEY (ou outra chave de IA). A leitura por foto não vai funcionar.");
});
