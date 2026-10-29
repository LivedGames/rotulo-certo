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
{"legivel":true,"nome":"string ou null","liquido":false,"porcao":30,"ultraprocessado":false,"tags":["lactose"],
 "por100":{"kcal":0,"prot":0,"carb":0,"acucar":0,"acucarAdic":0,"gord":0,"gordSat":0,"gordTrans":0,"fibra":0,"sodio":0}}
Regras:
- "por100" é por 100 g (sólido) ou 100 ml (líquido). Se o rótulo só mostra por porção, converta para 100 usando o tamanho da porção.
- "sodio" em miligramas. "porcao" em g ou ml (só o número). Use null para o que não aparece.
- "liquido": true se a tabela é por 100 ml.
- "tags": inclua "lactose" se tem leite/derivados, "gluten" se contém glúten, "amendoim", e "origem_animal" se tem carne, leite, ovo, mel, gelatina ou peixe. Lista vazia se não der para saber.
- "ultraprocessado": true se os ingredientes têm aditivos de uso industrial (aromatizantes, corantes, emulsificantes, xarope de glicose, gordura hidrogenada etc.); null se não houver lista de ingredientes.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ erro: "metodo" });
  }
  const provedores = [
    ["Groq", limparChave(process.env.GROQ_API_KEY, "GROQ_API_KEY"), pedirGroq],
    ["OpenRouter", limparChave(process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"), pedirOpenRouter],
    ["Gemini", limparChave(process.env.GEMINI_API_KEY, "GEMINI_API_KEY"), pedirGemini],
    ["Claude", limparChave(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY"), pedirClaude],
  ].filter(([, chave]) => chave);
  if (!provedores.length) {
    console.error("Nenhuma chave configurada. Variáveis com 'KEY' no nome:", Object.keys(process.env).filter(k => /KEY/i.test(k)).join(", ") || "nenhuma");
    return res.status(500).json({ erro: "sem_chave", detalhe: "Nenhuma variável GROQ_API_KEY, OPENROUTER_API_KEY ou GEMINI_API_KEY neste servidor." });
  }

  let corpo = req.body;
  if (typeof corpo === "string") { try { corpo = JSON.parse(corpo); } catch { corpo = null; } }
  const imagens = Array.isArray(corpo?.imagens) ? corpo.imagens.slice(0, MAX_IMAGENS) : [];
  if (!imagens.length) return res.status(400).json({ erro: "image_rejected" });

  const fotos = [];
  for (const b64 of imagens) {
    const tipo = typeof b64 === "string" ? tipoDaImagem(b64) : null;
    if (!tipo || b64.length > MAX_BYTES_IMAGEM) return res.status(400).json({ erro: "image_rejected" });
    fotos.push({ tipo, b64 });
  }

  let ultimo = null;
  for (const [nome, chave, pedir] of provedores) {
    try {
      const r = await pedir(chave, fotos);
      if (r.erro) { ultimo = r; continue; }
      const dados = extrairJSON(r.texto);
      if (!dados) { console.error(`Resposta sem JSON (${nome}):`, String(r.texto).slice(0, 300)); ultimo = { status: 502, erro: "invalid_json", detalhe: `${nome} não devolveu JSON.` }; continue; }
      return res.status(200).json(dados);
    } catch (e) {
      console.error(`Falha ao chamar ${nome}:`, e);
      ultimo = { status: 502, erro: "servidor", detalhe: `${nome}: ${e.message}` };
    }
  }
  return res.status(ultimo.status).json({ erro: ultimo.erro, detalhe: ultimo.detalhe });
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

async function pedirCompativelOpenAI(origem, url, chave, modelo, fotos, extras = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${chave}`, "content-type": "application/json", ...extras },
    body: JSON.stringify({
      model: modelo,
      temperature: 0,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: PROMPT },
        ...fotos.map(f => ({ type: "image_url", image_url: { url: `data:${f.tipo};base64,${f.b64}` } })),
      ] }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp(origem, r.status, j);
  return { texto: j?.choices?.[0]?.message?.content || "" };
}

function pedirGroq(chave, fotos) {
  return pedirCompativelOpenAI("do Groq", "https://api.groq.com/openai/v1/chat/completions", chave, MODELO_GROQ, fotos);
}

function pedirOpenRouter(chave, fotos) {
  return pedirCompativelOpenAI("do OpenRouter", "https://openrouter.ai/api/v1/chat/completions", chave, MODELO_OPENROUTER, fotos,
    { "x-title": "Rotulo Certo" });
}

async function pedirGemini(chave, fotos) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": chave, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        ...fotos.map(f => ({ inline_data: { mime_type: f.tipo, data: f.b64 } })),
        { text: PROMPT },
      ] }],
      generationConfig: { response_mime_type: "application/json", temperature: 0 },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp("do Gemini", r.status, j);
  const partes = j?.candidates?.[0]?.content?.parts || [];
  return { texto: partes.map(p => p.text || "").join("\n") };
}

async function pedirClaude(chave, fotos) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": chave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODELO_CLAUDE, max_tokens: 1024,
      messages: [{ role: "user", content: [
        ...fotos.map(f => ({ type: "image", source: { type: "base64", media_type: f.tipo, data: f.b64 } })),
        { type: "text", text: PROMPT },
      ] }],
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return erroHttp("do Claude", r.status, j);
  return { texto: (j?.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") };
}

export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };
