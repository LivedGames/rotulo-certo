// Lê a foto do rótulo com IA e devolve os valores nutricionais em JSON.
// Use UMA destas chaves (só no servidor; o navegador nunca a vê):
//   GEMINI_API_KEY     -> Google Gemini, tem plano gratuito (aistudio.google.com)
//   ANTHROPIC_API_KEY  -> Claude, pago por uso (console.anthropic.com)
// Se as duas existirem, usa o Gemini.

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
  const t = String(texto || "").trim();
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
  const chaveGemini = process.env.GEMINI_API_KEY;
  const chaveClaude = process.env.ANTHROPIC_API_KEY;
  if (!chaveGemini && !chaveClaude) return res.status(500).json({ erro: "sem_chave" });

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

  try {
    const r = chaveGemini ? await pedirGemini(chaveGemini, fotos) : await pedirClaude(chaveClaude, fotos);
    if (r.erro) return res.status(r.status).json({ erro: r.erro });
    const dados = extrairJSON(r.texto);
    if (!dados) return res.status(502).json({ erro: "invalid_json" });
    return res.status(200).json(dados);
  } catch (e) {
    console.error("Falha ao chamar a IA:", e);
    return res.status(502).json({ erro: "servidor" });
  }
}

function erroHttp(origem, status, j) {
  console.error(`Erro da API ${origem}:`, status, JSON.stringify(j));
  if (status === 429) return { status: 429, erro: "rate_limited" };
  if (status === 401 || status === 403) return { status: 500, erro: "sem_chave" };
  if (status === 400 && /API key|API_KEY/i.test(JSON.stringify(j))) return { status: 500, erro: "sem_chave" };
  return { status: 502, erro: "servidor" };
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
