// Rótulo Certo — servidor único (página + leitura de rótulo por foto).
// No Railway: só configure a variável GROQ_API_KEY. O Railway define PORT sozinho.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const PORTA = Number(process.env.PORT) || 3000;
const LIMITE = 12_000_000; // tamanho máximo do pedido

// ===== Leitura da foto do rótulo =====
// Lê a foto do rótulo com IA e devolve os valores nutricionais em JSON.
// Configure pelo menos UMA destas chaves (só no servidor; o navegador nunca a vê):
//   GROQ_API_KEY        -> Groq, plano gratuito (console.groq.com)          [recomendado]
//   OPENROUTER_API_KEY  -> OpenRouter, modelos gratuitos (openrouter.ai)
//   GEMINI_API_KEY      -> Google Gemini, plano gratuito (aistudio.google.com)
//   ANTHROPIC_API_KEY   -> Claude, pago por uso (console.anthropic.com)
// Com várias chaves, tenta nesta ordem e passa para a próxima se uma falhar.

const MODELO_GROQ = process.env.MODELO_GROQ || "qwen/qwen3.8-27b";
const MODELO_OPENROUTER = process.env.MODELO_OPENROUTER || "openrouter/free";
const MODELO_GEMINI = process.env.MODELO_GEMINI || "gemini-3.5-flash-lite";
const MODELO_CLAUDE = process.env.MODELO || "claude-haiku-5-5";
const MAX_IMAGENS = 3;
const MAX_BYTES_IMAGEM = 3_500_000; // por imagem, já em base64

const PROMPT = `Você recebe foto(s) do rótulo de um alimento vendido no Brasil (tabela nutricional e, talvez, lista de ingredientes e frente da embalagem).
Extraia os dados e responda SOMENTE com um objeto JSON neste formato, sem nenhum texto antes ou depois:
{"legivel":true,"nome":"string ou null","categoria":"string curta","liquido":false,"porcao":30,"nova":4,"tags":["leite"],"pode_conter":["amendoim"],"aditivos":["e330"],
 "por100":{"kcal":0,"prot":0,"carb":0,"acucar":0,"acucarAdic":0,"gord":0,"gordSat":0,"gordTrans":0,"fibra":0,"sodio":0}}
Regras:
- "por100" é por 100 g (sólido) ou 100 ml (líquido). Se o rótulo só mostra por porção, converta para 100 usando o tamanho da porção.
- "sodio" em miligramas. "porcao" em g ou ml (só o número). Use null para o que não aparece.
- "liquido": true se a tabela é por 100 ml.
- "categoria": tipo do produto em português, curto e genérico, ex.: "Biscoitos recheados", "Iogurtes", "Refrigerantes".
- "tags": o que o produto CONTÉM, usando só estes códigos: "leite", "lactose", "gluten", "ovo", "soja", "amendoim", "castanhas", "peixe", "crustaceos", "gergelim", "sulfitos", "origem_animal". Use o quadro "ALÉRGICOS: CONTÉM..." do rótulo e a lista de ingredientes. "origem_animal" se tem carne, leite, ovo, mel, gelatina ou peixe. Produto "zero lactose" com leite: "leite" sem "lactose".
- "pode_conter": códigos do texto "PODE CONTER..." ou "contém traços de..." do rótulo, com os mesmos códigos. Lista vazia se o rótulo não fala nisso; null se a foto não mostra essa parte do rótulo.
- "nova": grau de processamento NOVA de 1 a 4 (4 = ultraprocessado: aromatizantes, corantes, emulsificantes, xarope de glicose, gordura hidrogenada etc.); null se não houver lista de ingredientes.
- "aditivos": códigos INS dos aditivos da lista de ingredientes, no formato "e" + número (ex.: "INS 330" vira "e330", "INS 150d" vira "e150d"). Se o aditivo aparece só pelo nome, use o código dele. Lista vazia se a lista de ingredientes não tem aditivos; null se a foto não mostra a lista de ingredientes.
- Se a imagem não for um rótulo legível, responda {"legivel":false}.`;

function extrairJSON(texto) {
  const t = String(texto || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  try { return JSON.parse(t); } catch {}
  const cerca = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cerca) { try { return JSON.parse(cerca[1]); } catch {} }
  const i = t.indexOf("{"), f = t.lastIndexOf("}");
  if (i >= 0 && f > i) { try { return JSON.parse(t.slice(i, f + 1)); } catch {} }
  return null;
}

function tipoDaImagem(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return null;
}

function provedoresConfigurados() {
  return [
    ["Groq", limparChave(process.env.GROQ_API_KEY, "GROQ_API_KEY"), pedirGroq],
    ["OpenRouter", limparChave(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"), pedirOpenRouter],
    ["Gemini", limparChave(process.env.GEMINI_API_KEY, "GEMINI_API_KEY"), pedirGemini],
    ["Claude", limparChave(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"), pedirClaude],
  ].filter(([, chave]) => chave);
}

// Tenta cada provedor configurado; devolve {dados} ou {status, erro, detalhe}
async function chamarIA(fotos, prompt) {
  const provedores = provedoresConfigurados();
  if (!provedores.length) {
    console.error("Nenhuma chave configurada. Variáveis com 'KEY' no nome:", Object.keys(process.env).filter(k => /KEY/i.test(k)).join(", ") || "nenhuma");
    return { status: 500, erro: "sem_chave", detalhe: "Nenhuma variável GROQ_API_KEY, OPENROUTER_API_KEY ou GEMINI_API_KEY neste servidor." };
  }
  let ultimo = null;
  for (const [nome, chave, pedir] of provedores) {
    try {
      const r = await pedir(chave, fotos, prompt);
      if (r.erro) { ultimo = r; continue; }
      const dados = extrairJSON(r.texto);
      if (!dados) { console.error(`Resposta sem JSON (${nome}):`, String(r.texto).slice(0, 300)); ultimo = { status: 502, erro: "invalid_json", detalhe: `${nome} não devolveu JSON.` }; continue; }
      return { dados };
    } catch (e) {
      console.error(`Falha ao chamar ${nome}:`, e);
      ultimo = { status: 502, erro: "servidor", detalhe: `${nome}: ${e.message}` };
    }
  }
  return ultimo;
}

function lerCorpo(req) {
  let corpo = req.body;
  if (typeof corpo === "string") { try { corpo = JSON.parse(corpo); } catch { corpo = null; } }
  return corpo || {};
}

async function lerRotulo(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ erro: "metodo" }); }
  const corpo = lerCorpo(req);
  const imagens = Array.isArray(corpo.imagens) ? corpo.imagens.slice(0, MAX_IMAGENS) : [];
  if (!imagens.length) return res.status(400).json({ erro: "image_rejected" });
  const fotos = [];
  for (const b64 of imagens) {
    const tipo = typeof b64 === "string" ? tipoDaImagem(b64) : null;
    if (!tipo || b64.length > MAX_BYTES_IMAGEM) return res.status(400).json({ erro: "image_rejected" });
    fotos.push({ tipo, b64 });
  }
  const r = await chamarIA(fotos, PROMPT);
  if (r.dados) return res.status(200).json(r.dados);
  return res.status(r.status).json({ erro: r.erro, detalhe: r.detalhe });
}

// ===== Alimentos digitados que não estão na tabela do app =====
const PROMPT_ALIMENTOS = `Você é um assistente de nutrição brasileiro. O usuário descreveu alimentos que comeu ou vai preparar.
Para CADA item da lista abaixo, estime a quantidade e os valores nutricionais. Use a Tabela Brasileira de Composição de Alimentos (TACO) quando o alimento existir nela; senão, use valores médios de produtos vendidos no Brasil.
Responda SOMENTE com um objeto JSON neste formato, sem nenhum texto antes ou depois:
{"itens":[{"texto":"o texto original do item","nome":"nome curto do alimento","gramas":120,"liquido":false,"nova":1,"tags":["leite"],"pode_conter":[],
 "por100":{"kcal":0,"prot":0,"carb":0,"acucarAdic":0,"gord":0,"gordSat":0,"fibra":0,"sodio":0}}]}
Regras:
- "gramas": quantidade total do item em g (ou ml, se líquido). Se o usuário não disse a quantidade, use uma porção caseira comum.
- "por100": valores por 100 g (ou 100 ml). "sodio" em mg. "acucarAdic" é açúcar adicionado (0 em frutas e alimentos in natura).
- "nova": grau de processamento NOVA de 1 a 4.
- "tags": o que o alimento contém, só com estes códigos: "leite", "lactose", "gluten", "ovo", "soja", "amendoim", "castanhas", "peixe", "crustaceos", "gergelim", "sulfitos", "origem_animal".
- "pode_conter": códigos que costumam aparecer como traços nesse tipo de alimento (lista vazia se nenhum).
- Se um item não for comida, devolva "nome": null para ele.
Itens:
`;
async function estimarAlimentos(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ erro: "metodo" }); }
  const corpo = lerCorpo(req);
  const itens = Array.isArray(corpo.itens) ? corpo.itens.map(t => String(t).slice(0, 120)).filter(Boolean).slice(0, 12) : [];
  if (!itens.length) return res.status(400).json({ erro: "sem_itens" });
  const r = await chamarIA([], PROMPT_ALIMENTOS + itens.map((t, i) => `${i + 1}. ${t}`).join("\n"));
  if (r.dados) return res.status(200).json(r.dados);
  return res.status(r.status).json({ erro: r.erro, detalhe: r.detalhe });
}

// Tira espaços, aspas, quebras de linha e "NOME=" colados por engano junto com a chave
function limparChave(v, nome) {
  if (!v) return "";
  const tira = x => x.replace(/^["'\s]+|["'\s]+$/g, "");
  let c = tira(String(v));
  if (c.startsWith(nome + "=")) c = tira(c.slice(nome.length + 1));
  return c;
}

function erroHttp(origem, status, j) {
  console.error(`Erro da API ${origem}:`, status, JSON.stringify(j));
  const detalhe = `${origem} respondeu ${status}: ${String(j?.error?.message || "").slice(0, 300)}`;
  if (status === 429) return { status: 429, erro: "rate_limited", detalhe };
  if (status === 401 || status === 403) return { status: 500, erro: "chave_invalida", detalhe };
  if (status === 400 && /API key|API_KEY/i.test(JSON.stringify(j))) return { status: 500, erro: "chave_invalida", detalhe };
  if (status === 404) return { status: 502, erro: "modelo", detalhe };
  return { status: 502, erro: "servidor", detalhe };
}

async function pedirCompativelOpenAI(origem, url, chave, modelo, fotos, prompt, extras = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${chave}`, "content-type": "application/json", ...extras },
    body: JSON.stringify({
      model: modelo,
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        ...fotos.map(f => ({ type: "image_url", image_url: { url: `data:${f.tipo};base64,${f.b64}` } })),
      ] }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp(origem, r.status, j);
  return { texto: j?.choices?.[0]?.message?.content || "" };
}

function pedirGroq(chave, fotos, prompt) {
  return pedirCompativelOpenAI("do Groq", "https://api.groq.com/openai/v1/chat/completions", chave, MODELO_GROQ, fotos, prompt);
}

function pedirOpenRouter(chave, fotos, prompt) {
  return pedirCompativelOpenAI("do OpenRouter", "https://openrouter.ai/api/v1/chat/completions", chave, MODELO_OPENROUTER, fotos, prompt,
    { "x-title": "Rotulo Certo" });
}

async function pedirGemini(chave, fotos, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": chave, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        ...fotos.map(f => ({ inline_data: { mime_type: f.tipo, data: f.b64 } })),
        { text: prompt },
      ] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0 },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp("do Gemini", r.status, j);
  const partes = j?.candidates?.[0]?.content?.parts || [];
  return { texto: partes.map(p => p.text || "").join("\n") };
}

async function pedirClaude(chave, fotos, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO_CLAUDE, max_tokens: 2000,
      messages: [{ role: "user", content: [
        ...fotos.map(f => ({ type: "image", source: { type: "base64", media_type: f.tipo, data: f.b64 } })),
        { type: "text", text: prompt },
      ] }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp("do Claude", r.status, j);
  return { texto: (j?.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") };
}


// ===== Servidor =====
function adaptar(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); return res; };
  return res;
}

http.createServer(async (req, res) => {
  adaptar(res);
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/api/ler-rotulo" || url.pathname === "/api/alimentos") {
    const rotina = url.pathname === "/api/alimentos" ? estimarAlimentos : lerRotulo;
    let tamanho = 0; const partes = [];
    req.on("data", c => { tamanho += c.length; if (tamanho > LIMITE) { res.status(413).json({ erro: "image_rejected" }); req.destroy(); } else partes.push(c); });
    req.on("end", async () => {
      if (res.writableEnded) return;
      try { req.body = JSON.parse(Buffer.concat(partes).toString("utf8") || "{}"); } catch { req.body = {}; }
      await rotina(req, res);
    });
    return;
  }

  // arquivos do app instalável (PWA)
  const ESTATICOS = {
    "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
    "/sw.js": "text/javascript; charset=utf-8",
    "/icon-192.png": "image/png", "/icon-512.png": "image/png", "/icon-maskable-512.png": "image/png",
    "/apple-touch-icon.png": "image/png", "/favicon.png": "image/png", "/favicon.ico": "image/png",
  };
  if (ESTATICOS[url.pathname]) {
    try {
      const arquivo = url.pathname === "/favicon.ico" ? "favicon.png" : url.pathname.slice(1);
      const dados = await readFile(path.join(PASTA, arquivo));
      res.setHeader("Content-Type", ESTATICOS[url.pathname]);
      res.setHeader("Cache-Control", url.pathname === "/sw.js" ? "no-cache" : "public, max-age=86400");
      return res.end(dados);
    } catch {
      return res.status(404).end("Não encontrado");
    }
  }
  // Google Play (TWA): cole o conteúdo do assetlinks.json na variável ASSETLINKS_JSON do Railway
  if (url.pathname === "/.well-known/assetlinks.json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(process.env.ASSETLINKS_JSON || "[]");
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = await readFile(path.join(PASTA, "index.html"));
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(html);
    } catch {
      return res.status(500).end("Falta o arquivo index.html ao lado do server.js.");
    }
  }

  res.status(404).end("Não encontrado");
}).listen(PORTA, () => {
  console.log(`Rótulo Certo rodando na porta ${PORTA}`);
  if (!["GROQ_API_KEY","OPENROUTER_API_KEY","GEMINI_API_KEY","ANTHROPIC_API_KEY"].some(k => process.env[k])) console.log("Atenção: falta GROQ_API_KEY. A leitura por foto não vai funcionar.");
});
