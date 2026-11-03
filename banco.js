// Rótulo Certo — contas, sincronização dos dados e base própria de produtos (PostgreSQL).
// Variáveis no Railway:
//   DATABASE_URL       -> criada sozinha quando você adiciona um PostgreSQL ao projeto
//   GOOGLE_CLIENT_ID   -> para "Entrar com Google" (opcional)
//   RESEND_API_KEY     -> para o e-mail de "Esqueci a senha" (opcional)
//   EMAIL_REMETENTE    -> ex.: Rótulo Certo <nao-responda@seudominio.com.br>
//   ADMIN_EMAILS       -> e-mails que podem usar o painel da base, separados por vírgula
//   CONTATO_EMAIL      -> e-mail de contato mostrado na política de privacidade
import crypto from "node:crypto";
import pg from "pg";

const URL_BANCO = process.env.DATABASE_URL || "";
export const temBanco = !!URL_BANCO;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || "").trim();
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE || "Rótulo Certo <onboarding@resend.dev>";
const ADMINS = (process.env.ADMIN_EMAILS || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
const DIAS_SESSAO = 90;
const MAX_DADOS = 3_000_000; // tamanho máximo dos dados de um usuário (bytes de JSON)

let pool = null;
if (temBanco) {
  const local = /railway\.internal|localhost|127\.0\.0\.1/.test(URL_BANCO) || process.env.PGSSL === "0";
  pool = new pg.Pool({ connectionString: URL_BANCO, ssl: local ? false : { rejectUnauthorized: false }, max: 10 });
  pool.on("error", e => console.error("Erro no banco:", e.message));
}
const q = (sql, p) => pool.query(sql, p);

export async function prepararBanco() {
  if (!temBanco) { console.log("Sem DATABASE_URL: contas e base própria desligadas."); return; }
  await q(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      nome TEXT,
      senha_hash TEXT,
      google_sub TEXT UNIQUE,
      consentimento TIMESTAMPTZ,
      criado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      token_hash TEXT PRIMARY KEY,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS redefinicoes (
      token_hash TEXT PRIMARY KEY,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      expira TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dados_usuario (
      usuario_id INT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      dados JSONB NOT NULL,
      versao INT NOT NULL DEFAULT 1,
      atualizado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS produtos (
      codigo TEXT PRIMARY KEY,
      dados JSONB NOT NULL,
      criado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
      atualizado_por INT REFERENCES usuarios(id) ON DELETE SET NULL,
      confirmacoes INT NOT NULL DEFAULT 0,
      denuncias INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ativo',
      escaneamentos INT NOT NULL DEFAULT 0,
      criado TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS produtos_versoes (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL,
      dados JSONB NOT NULL,
      usuario_id INT REFERENCES usuarios(id) ON DELETE SET NULL,
      criado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS avaliacoes_produto (
      codigo TEXT NOT NULL REFERENCES produtos(codigo) ON DELETE CASCADE,
      usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL CHECK (tipo IN ('confirma','denuncia')),
      criado TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (codigo, usuario_id)
    );
    CREATE TABLE IF NOT EXISTS visitas (
      id BIGSERIAL PRIMARY KEY,
      dia DATE NOT NULL,
      tipo TEXT NOT NULL,
      nome TEXT NOT NULL,
      visitante TEXT NOT NULL,
      origem TEXT,
      valor INT,
      criado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS visitas_dia_idx ON visitas(dia);
    CREATE INDEX IF NOT EXISTS produtos_status_idx ON produtos(status);
    CREATE INDEX IF NOT EXISTS sessoes_usuario_idx ON sessoes(usuario_id);
  `);
  await q("DELETE FROM sessoes WHERE expira < now()");
  await q("DELETE FROM redefinicoes WHERE expira < now()");
  await q("DELETE FROM visitas WHERE dia < current_date - 400");
  console.log("Banco pronto: contas e base própria ligadas.");
}

/* ---------- utilidades ---------- */
const sha256 = t => crypto.createHash("sha256").update(t).digest("hex");
const tokenNovo = () => crypto.randomBytes(32).toString("base64url");
function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sal.toString("hex")}$${h.toString("hex")}`;
}
function senhaConfere(senha, guardado) {
  if (!guardado) return false;
  const [tipo, salHex, hHex] = guardado.split("$");
  if (tipo !== "scrypt") return false;
  const h = crypto.scryptSync(senha, Buffer.from(salHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const esperado = Buffer.from(hHex, "hex");
  return esperado.length === h.length && crypto.timingSafeEqual(esperado, h);
}
const emailValido = e => typeof e === "string" && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const SAL_VISITAS = process.env.SAL_VISITAS || crypto.createHash("sha256").update("visitas:" + (URL_BANCO || "")).digest("hex");
const ipDe = req => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const origemDe = req => process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host}`;

// limite simples de tentativas (memória do servidor)
const tentativas = new Map();
export function limitar(chave, max, janelaMs) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < janelaMs);
  if (lista.length >= max) { tentativas.set(chave, lista); return false; }
  lista.push(agora); tentativas.set(chave, lista);
  if (tentativas.size > 20000) for (const [k, v] of tentativas) if (!v.some(t => agora - t < janelaMs)) tentativas.delete(k);
  return true;
}

async function criarSessao(usuarioId) {
  const token = tokenNovo();
  await q("INSERT INTO sessoes (token_hash, usuario_id, expira) VALUES ($1, $2, now() + $3::interval)", [sha256(token), usuarioId, `${DIAS_SESSAO} days`]);
  return token;
}
export async function usuarioDe(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const r = await q(`SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = $1 AND s.expira > now()`, [sha256(m[1])]);
  return r.rows[0] || null;
}
const publico = u => ({ id: u.id, email: u.email, nome: u.nome || "", admin: ADMINS.includes(u.email), temSenha: !!u.senha_hash, google: !!u.google_sub });

async function enviarEmail(para, assunto, html) {
  if (!RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: EMAIL_REMETENTE, to: [para], subject: assunto, html }),
  });
  if (!r.ok) console.error("Erro ao enviar e-mail:", r.status, await r.text().catch(() => ""));
  return r.ok;
}

async function verificarGoogle(credencial) {
  if (!GOOGLE_CLIENT_ID || typeof credencial !== "string") return null;
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credencial));
  if (!r.ok) return null;
  const t = await r.json();
  const emissorOk = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
  const verificado = t.email_verified === true || t.email_verified === "true";
  if (t.aud !== GOOGLE_CLIENT_ID || !emissorOk || !verificado || !t.email || !t.sub) return null;
  return { sub: String(t.sub), email: String(t.email).toLowerCase(), nome: t.name ? String(t.name).slice(0, 60) : "" };
}

/* ---------- produtos: só campos conhecidos entram na base ---------- */
const NUTS = ["kcal","prot","carb","acucar","acucarAdic","gord","gordSat","gordTrans","fibra","sodio"];
const TAGS = ["leite","lactose","gluten","ovo","soja","amendoim","castanhas","peixe","crustaceos","gergelim","sulfitos","origem_animal"];
const numOuNulo = v => (v === null || v === undefined || v === "" || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;
function limparProduto(p) {
  if (!p || typeof p !== "object" || !p.n || typeof p.n !== "object") return null;
  const n = {}; for (const k of NUTS) n[k] = numOuNulo(p.n[k]);
  if (n.kcal === null || n.kcal < 0 || n.kcal > 950) return null;
  const lista = (v, ok) => Array.isArray(v) ? [...new Set(v.map(String).filter(ok))].slice(0, 40) : null;
  return {
    nome: String(p.nome || "Produto").slice(0, 120),
    liquido: !!p.liquido,
    porcao: numOuNulo(p.porcao),
    nova: [1, 2, 3, 4].includes(Number(p.nova)) ? Number(p.nova) : null,
    ns: /^[a-e]$/.test(String(p.ns || "")) ? String(p.ns) : null,
    categoria: p.categoria ? String(p.categoria).slice(0, 80) : null,
    catTag: p.catTag ? String(p.catTag).slice(0, 80) : null,
    aditivos: lista(p.aditivos, a => /^e\d{3,4}[a-z]?$/.test(a)),
    tags: lista(p.tags, t => TAGS.includes(t)) || [],
    tracos: lista(p.tracos, t => TAGS.includes(t)) || [],
    ingredientes: p.ingredientes ? String(p.ingredientes).slice(0, 3000) : null,
    alergInfo: !!p.alergInfo,
    n,
  };
}
async function estadoProduto(codigo, usuario) {
  const r = await q("SELECT * FROM produtos WHERE codigo = $1", [codigo]);
  const p = r.rows[0]; if (!p) return null;
  let minha = null;
  if (usuario) { const a = await q("SELECT tipo FROM avaliacoes_produto WHERE codigo = $1 AND usuario_id = $2", [codigo, usuario.id]); minha = a.rows[0]?.tipo || null; }
  return { codigo: p.codigo, produto: p.dados, confirmacoes: p.confirmacoes, denuncias: p.denuncias, status: p.status,
    meu: usuario ? p.criado_por === usuario.id || p.atualizado_por === usuario.id : false, minhaAvaliacao: minha, atualizado: p.atualizado };
}

/* ---------- rotas ---------- */
// devolve true se a rota foi atendida aqui
export async function rotasBanco(req, res, url) {
  const p = url.pathname, m = req.method, corpo = req.body || {};
  if (p === "/api/config") return res.json({ contas: temBanco, google: temBanco && GOOGLE_CLIENT_ID ? GOOGLE_CLIENT_ID : null, emailSenha: !!RESEND_API_KEY }), true;
  if (p !== "/api/visita" && !p.startsWith("/api/conta") && !p.startsWith("/api/dados") && !p.startsWith("/api/produtos") && !p.startsWith("/api/admin")) return false;
  if (!temBanco) return p === "/api/visita" ? (res.status(204).end(), true) : (res.status(503).json({ erro: "sem_banco", mensagem: "Contas ainda não estão ligadas neste servidor." }), true);

  try {
    const ip = ipDe(req);
    // ---- contador de visitas anônimo: sem cookies, sem guardar IP; o visitante é um código que muda todo dia
    if (p === "/api/visita" && m === "POST") {
      const ua = String(req.headers["user-agent"] || "");
      if (!limitar("visita:" + ip, 300, 3600e3) || /bot|crawl|spider|slurp|headless|lighthouse|preview/i.test(ua)) return res.status(204).end(), true;
      const nome = String(corpo.evento || corpo.pagina || "");
      if (!/^[a-z0-9_-]{1,40}$/.test(nome)) return res.status(400).json({ erro: "nome" }), true;
      const dia = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
      const visitante = sha256(`${dia}|${ip}|${ua}|${SAL_VISITAS}`).slice(0, 24);
      let origem = String(corpo.origem || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40) || null;
      if (/Instagram/.test(ua) && (!origem || origem === "direto")) origem = "instagram";
      const v = Number(corpo.valor), valor = Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : null;
      await q("INSERT INTO visitas (dia, tipo, nome, visitante, origem, valor) VALUES ($1, $2, $3, $4, $5, $6)", [dia, corpo.evento ? "evento" : "pagina", nome, visitante, origem, valor]);
      return res.status(204).end(), true;
    }
    // ---- criar conta
    if (p === "/api/conta/criar" && m === "POST") {
      if (!limitar("criar:" + ip, 10, 3600e3)) return res.status(429).json({ erro: "muitas_tentativas", mensagem: "Muitas tentativas. Espere um pouco." }), true;
      const email = String(corpo.email || "").trim().toLowerCase(), senha = String(corpo.senha || ""), nome = String(corpo.nome || "").trim().slice(0, 60);
      if (!emailValido(email)) return res.status(400).json({ erro: "email", mensagem: "Digite um e-mail válido." }), true;
      if (senha.length < 8) return res.status(400).json({ erro: "senha", mensagem: "A senha precisa ter pelo menos 8 caracteres." }), true;
      if (corpo.consentimento !== true) return res.status(400).json({ erro: "consentimento", mensagem: "Para criar a conta, aceite a política de privacidade." }), true;
      const existe = await q("SELECT id FROM usuarios WHERE email = $1", [email]);
      if (existe.rows.length) return res.status(409).json({ erro: "existe", mensagem: "Já existe uma conta com este e-mail. Toque em Entrar." }), true;
      const u = (await q("INSERT INTO usuarios (email, nome, senha_hash, consentimento) VALUES ($1, $2, $3, now()) RETURNING *", [email, nome, hashSenha(senha)])).rows[0];
      return res.json({ token: await criarSessao(u.id), usuario: publico(u) }), true;
    }
    // ---- entrar
    if (p === "/api/conta/entrar" && m === "POST") {
      const email = String(corpo.email || "").trim().toLowerCase(), senha = String(corpo.senha || "");
      if (!limitar("entrar:" + ip, 20, 900e3) || !limitar("entrar:" + email, 8, 900e3))
        return res.status(429).json({ erro: "muitas_tentativas", mensagem: "Muitas tentativas. Espere 15 minutos ou use “Esqueci a senha”." }), true;
      const u = (await q("SELECT * FROM usuarios WHERE email = $1", [email])).rows[0];
      if (!u || !senhaConfere(senha, u.senha_hash)) {
        const msg = u && !u.senha_hash ? "Esta conta usa o login com Google. Toque em “Entrar com Google”." : "E-mail ou senha incorretos.";
        return res.status(401).json({ erro: "credenciais", mensagem: msg }), true;
      }
      return res.json({ token: await criarSessao(u.id), usuario: publico(u) }), true;
    }
    // ---- Google
    if (p === "/api/conta/google" && m === "POST") {
      if (!limitar("google:" + ip, 20, 900e3)) return res.status(429).json({ erro: "muitas_tentativas", mensagem: "Muitas tentativas. Espere um pouco." }), true;
      const g = await verificarGoogle(corpo.credencial);
      if (!g) return res.status(401).json({ erro: "google", mensagem: "Não deu para confirmar o login com Google. Tente de novo." }), true;
      let u = (await q("SELECT * FROM usuarios WHERE google_sub = $1 OR email = $2 ORDER BY (google_sub = $1) DESC LIMIT 1", [g.sub, g.email])).rows[0];
      if (!u) {
        if (corpo.consentimento !== true) return res.status(400).json({ erro: "consentimento", mensagem: "Para criar a conta, aceite a política de privacidade." }), true;
        u = (await q("INSERT INTO usuarios (email, nome, google_sub, consentimento) VALUES ($1, $2, $3, now()) RETURNING *", [g.email, g.nome, g.sub])).rows[0];
      } else if (!u.google_sub) {
        u = (await q("UPDATE usuarios SET google_sub = $1, nome = COALESCE(NULLIF(nome, ''), $2) WHERE id = $3 RETURNING *", [g.sub, g.nome, u.id])).rows[0];
      }
      return res.json({ token: await criarSessao(u.id), usuario: publico(u) }), true;
    }
    // ---- esqueci a senha
    if (p === "/api/conta/esqueci" && m === "POST") {
      const email = String(corpo.email || "").trim().toLowerCase();
      if (!RESEND_API_KEY) return res.status(503).json({ erro: "sem_email", mensagem: "O envio de e-mail ainda não está configurado neste servidor." }), true;
      if (!limitar("esqueci:" + ip, 5, 3600e3) || !limitar("esqueci:" + email, 3, 3600e3)) return res.status(429).json({ erro: "muitas_tentativas", mensagem: "Já enviamos o e-mail. Espere um pouco antes de pedir de novo." }), true;
      const u = (await q("SELECT * FROM usuarios WHERE email = $1", [email])).rows[0];
      if (u) {
        const token = tokenNovo();
        await q("DELETE FROM redefinicoes WHERE usuario_id = $1", [u.id]);
        await q("INSERT INTO redefinicoes (token_hash, usuario_id, expira) VALUES ($1, $2, now() + interval '1 hour')", [sha256(token), u.id]);
        const link = `${origemDe(req)}/redefinir?token=${token}`;
        await enviarEmail(u.email, "Criar nova senha · Rótulo Certo",
          `<p>Olá${u.nome ? ", " + u.nome.replace(/[<>&]/g, "") : ""}.</p><p>Para criar uma nova senha no Rótulo Certo, abra o link abaixo. Ele vale por 1 hora.</p><p><a href="${link}">${link}</a></p><p>Se você não pediu, ignore este e-mail; sua senha continua a mesma.</p>`);
      }
      return res.json({ ok: true }), true; // mesma resposta exista ou não a conta
    }
    // ---- redefinir senha
    if (p === "/api/conta/redefinir" && m === "POST") {
      const senha = String(corpo.senha || "");
      if (senha.length < 8) return res.status(400).json({ erro: "senha", mensagem: "A senha precisa ter pelo menos 8 caracteres." }), true;
      const r = (await q("SELECT usuario_id FROM redefinicoes WHERE token_hash = $1 AND expira > now()", [sha256(String(corpo.token || ""))])).rows[0];
      if (!r) return res.status(400).json({ erro: "link", mensagem: "Este link expirou ou já foi usado. Peça um novo em “Esqueci a senha”." }), true;
      await q("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hashSenha(senha), r.usuario_id]);
      await q("DELETE FROM redefinicoes WHERE usuario_id = $1", [r.usuario_id]);
      await q("DELETE FROM sessoes WHERE usuario_id = $1", [r.usuario_id]);
      const u = (await q("SELECT * FROM usuarios WHERE id = $1", [r.usuario_id])).rows[0];
      return res.json({ token: await criarSessao(u.id), usuario: publico(u) }), true;
    }

    // ---- daqui para baixo: rotas que aceitam ou exigem login
    const usuario = await usuarioDe(req);

    // base de produtos: consulta não exige login
    const mp = p.match(/^\/api\/produtos\/(\d{8,14})$/);
    if (mp && m === "GET") {
      if (!limitar("prod:" + ip, 300, 3600e3)) return res.status(429).json({ erro: "muitas_tentativas" }), true;
      const est = await estadoProduto(mp[1], usuario);
      if (!est || est.status !== "ativo") return res.status(404).json({ erro: "nao_encontrado" }), true;
      await q("UPDATE produtos SET escaneamentos = escaneamentos + 1 WHERE codigo = $1", [mp[1]]);
      return res.json(est), true;
    }

    if (!usuario) return res.status(401).json({ erro: "sem_login", mensagem: "Entre na sua conta para continuar." }), true;

    if (p === "/api/conta/eu" && m === "GET") return res.json({ usuario: publico(usuario) }), true;
    if (p === "/api/conta/sair" && m === "POST") {
      const t = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      await q("DELETE FROM sessoes WHERE token_hash = $1", [sha256(t)]);
      return res.json({ ok: true }), true;
    }
    if (p === "/api/conta/excluir" && m === "POST") {
      if (usuario.senha_hash ? !senhaConfere(String(corpo.senha || ""), usuario.senha_hash) : corpo.confirmar !== "EXCLUIR")
        return res.status(401).json({ erro: "confirmacao", mensagem: usuario.senha_hash ? "Senha incorreta." : "Digite EXCLUIR para confirmar." }), true;
      await q("DELETE FROM usuarios WHERE id = $1", [usuario.id]); // apaga dados, sessões e avaliações; produtos ficam sem autor
      return res.json({ ok: true }), true;
    }

    // ---- sincronização dos dados do app
    if (p === "/api/dados" && m === "GET") {
      const r = (await q("SELECT dados, versao, atualizado FROM dados_usuario WHERE usuario_id = $1", [usuario.id])).rows[0];
      return res.json(r ? { dados: r.dados, versao: r.versao, atualizado: r.atualizado } : { dados: null, versao: 0 }), true;
    }
    if (p === "/api/dados" && m === "PUT") {
      const dados = corpo.dados, base = Number(corpo.versaoBase) || 0;
      if (!dados || typeof dados !== "object" || !Array.isArray(dados.perfis)) return res.status(400).json({ erro: "dados" }), true;
      if (JSON.stringify(dados).length > MAX_DADOS) return res.status(413).json({ erro: "grande", mensagem: "Seus dados passaram do limite. Apague parte do histórico." }), true;
      const atual = (await q("SELECT versao, dados FROM dados_usuario WHERE usuario_id = $1", [usuario.id])).rows[0];
      if (!atual) {
        const r = await q("INSERT INTO dados_usuario (usuario_id, dados, versao) VALUES ($1, $2, 1) RETURNING versao", [usuario.id, dados]);
        return res.json({ versao: r.rows[0].versao }), true;
      }
      if (atual.versao !== base) return res.status(409).json({ erro: "conflito", dados: atual.dados, versao: atual.versao }), true;
      const r = await q("UPDATE dados_usuario SET dados = $1, versao = versao + 1, atualizado = now() WHERE usuario_id = $2 AND versao = $3 RETURNING versao", [dados, usuario.id, base]);
      if (!r.rows.length) { const a = (await q("SELECT versao, dados FROM dados_usuario WHERE usuario_id = $1", [usuario.id])).rows[0]; return res.status(409).json({ erro: "conflito", dados: a.dados, versao: a.versao }), true; }
      return res.json({ versao: r.rows[0].versao }), true;
    }

    // ---- cadastrar ou corrigir produto na base
    if (p === "/api/produtos" && m === "POST") {
      if (!limitar("cad:" + usuario.id, 60, 3600e3)) return res.status(429).json({ erro: "muitas_tentativas", mensagem: "Muitos cadastros seguidos. Espere um pouco." }), true;
      const codigo = String(corpo.codigo || "").replace(/\D/g, "");
      if (!/^\d{8,14}$/.test(codigo)) return res.status(400).json({ erro: "codigo", mensagem: "Código de barras inválido." }), true;
      const prod = limparProduto(corpo.produto);
      if (!prod) return res.status(400).json({ erro: "produto", mensagem: "Faltam dados do produto (pelo menos as calorias)." }), true;
      const antes = (await q("SELECT dados FROM produtos WHERE codigo = $1", [codigo])).rows[0];
      if (antes) {
        await q("INSERT INTO produtos_versoes (codigo, dados, usuario_id) VALUES ($1, $2, $3)", [codigo, antes.dados, usuario.id]);
        await q("DELETE FROM avaliacoes_produto WHERE codigo = $1", [codigo]);
        await q("UPDATE produtos SET dados = $2, atualizado_por = $3, confirmacoes = 0, denuncias = 0, status = 'ativo', atualizado = now() WHERE codigo = $1", [codigo, prod, usuario.id]);
      } else {
        await q("INSERT INTO produtos (codigo, dados, criado_por, atualizado_por) VALUES ($1, $2, $3, $3)", [codigo, prod, usuario.id]);
      }
      return res.json(await estadoProduto(codigo, usuario)), true;
    }
    // ---- confirmar ou denunciar
    const ma = p.match(/^\/api\/produtos\/(\d{8,14})\/avaliar$/);
    if (ma && m === "POST") {
      const tipo = corpo.tipo === "denuncia" ? "denuncia" : "confirma";
      const est = await estadoProduto(ma[1], usuario);
      if (!est) return res.status(404).json({ erro: "nao_encontrado" }), true;
      if (est.meu) return res.status(400).json({ erro: "proprio", mensagem: "Você cadastrou ou corrigiu este produto; outra pessoa precisa confirmar." }), true;
      await q(`INSERT INTO avaliacoes_produto (codigo, usuario_id, tipo) VALUES ($1, $2, $3)
               ON CONFLICT (codigo, usuario_id) DO UPDATE SET tipo = EXCLUDED.tipo, criado = now()`, [ma[1], usuario.id, tipo]);
      await q(`UPDATE produtos SET
                 confirmacoes = (SELECT count(*) FROM avaliacoes_produto WHERE codigo = $1 AND tipo = 'confirma'),
                 denuncias = (SELECT count(*) FROM avaliacoes_produto WHERE codigo = $1 AND tipo = 'denuncia')
               WHERE codigo = $1`, [ma[1]]);
      await q(`UPDATE produtos SET status = CASE WHEN denuncias >= 3 AND denuncias > confirmacoes THEN 'revisao' ELSE 'ativo' END WHERE codigo = $1`, [ma[1]]);
      return res.json(await estadoProduto(ma[1], usuario)), true;
    }

    // ---- painel de administração
    if (p.startsWith("/api/admin")) {
      if (!ADMINS.includes(usuario.email)) return res.status(403).json({ erro: "proibido" }), true;
      if (p === "/api/admin/resumo" && m === "GET") {
        const r = (await q(`SELECT (SELECT count(*) FROM usuarios)::int AS usuarios, (SELECT count(*) FROM produtos)::int AS produtos,
          (SELECT count(*) FROM produtos WHERE status = 'revisao')::int AS revisao, (SELECT count(*) FROM produtos WHERE criado > now() - interval '7 days')::int AS novos7`)).rows[0];
        return res.json(r), true;
      }
      if (p === "/api/admin/visitas" && m === "GET") {
        const dias = Math.max(1, Math.min(90, Number(url.searchParams.get("dias")) || 7));
        const desde = "(now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1)";
        const pd = (n, t = "pagina") => `count(DISTINCT visitante) FILTER (WHERE tipo = '${t}' AND nome = '${n}')::int`;
        const porDia = (await q(`SELECT to_char(dia, 'YYYY-MM-DD') AS dia, ${pd("app")} AS app, ${pd("apresentacao")} AS apresentacao,
            ${pd("analisou", "evento")} AS analisaram, ${pd("diario", "evento")} AS diario
          FROM visitas WHERE dia >= ${desde} GROUP BY dia ORDER BY dia DESC`, [dias])).rows;
        const soma = k => porDia.reduce((t, d) => t + d[k], 0);
        const extra = (await q(`SELECT
            count(*) FILTER (WHERE tipo = 'evento' AND nome = 'instalou')::int AS instalaram,
            count(DISTINCT visitante) FILTER (WHERE tipo = 'evento' AND nome = 'apresentacao_fim')::int AS viram_tudo,
            (SELECT round(avg(mx), 1)::float FROM (SELECT max(valor) AS mx FROM visitas WHERE tipo = 'evento' AND nome = 'slides' AND dia >= ${desde} GROUP BY visitante) s) AS slides_media,
            (SELECT count(*) FROM usuarios WHERE criado >= ${desde})::int AS contas
          FROM visitas WHERE dia >= ${desde}`, [dias])).rows[0];
        const origens = (await q(`SELECT coalesce(origem, 'direto') AS origem, nome AS pagina, count(DISTINCT visitante)::int AS pessoas
          FROM visitas WHERE tipo = 'pagina' AND dia >= ${desde} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`, [dias])).rows;
        return res.json({ dias, totais: { app: soma("app"), apresentacao: soma("apresentacao"), analisaram: soma("analisaram"), diario: soma("diario"), ...extra }, porDia, origens }), true;
      }
      if (p === "/api/admin/contas" && m === "GET") {
        const r = await q(`SELECT u.nome, u.email, u.criado, (u.google_sub IS NOT NULL) AS google, (u.senha_hash IS NOT NULL) AS senha, d.atualizado AS ultimo_uso
          FROM usuarios u LEFT JOIN dados_usuario d ON d.usuario_id = u.id ORDER BY u.criado DESC LIMIT 500`);
        const t = (await q("SELECT count(*)::int AS n FROM usuarios")).rows[0].n;
        return res.json({ total: t, contas: r.rows }), true;
      }
      if (p === "/api/admin/produtos" && m === "GET") {
        const f = url.searchParams.get("filtro");
        const ordem = f === "mais" ? "escaneamentos DESC" : f === "denunciados" ? "denuncias DESC, atualizado DESC" : "atualizado DESC";
        const onde = f === "revisao" ? "WHERE status = 'revisao'" : f === "denunciados" ? "WHERE denuncias > 0" : "";
        const r = await q(`SELECT p.codigo, p.dados->>'nome' AS nome, p.confirmacoes, p.denuncias, p.status, p.escaneamentos, p.atualizado,
          (SELECT count(*) FROM produtos_versoes v WHERE v.codigo = p.codigo)::int AS versoes FROM produtos p ${onde} ORDER BY ${ordem} LIMIT 60`);
        return res.json({ produtos: r.rows }), true;
      }
      const mx = p.match(/^\/api\/admin\/produtos\/(\d{8,14})$/);
      if (mx && m === "POST") {
        const c = mx[1], acao = corpo.acao;
        if (acao === "aprovar") { await q("DELETE FROM avaliacoes_produto WHERE codigo = $1 AND tipo = 'denuncia'", [c]); await q("UPDATE produtos SET denuncias = 0, status = 'ativo' WHERE codigo = $1", [c]); }
        else if (acao === "apagar") await q("DELETE FROM produtos WHERE codigo = $1", [c]);
        else if (acao === "voltar") {
          const v = (await q("SELECT id, dados FROM produtos_versoes WHERE codigo = $1 ORDER BY id DESC LIMIT 1", [c])).rows[0];
          if (!v) return res.status(400).json({ erro: "sem_versao", mensagem: "Não há versão anterior deste produto." }), true;
          await q("UPDATE produtos SET dados = $2, status = 'ativo', denuncias = 0, confirmacoes = 0, atualizado = now() WHERE codigo = $1", [c, v.dados]);
          await q("DELETE FROM avaliacoes_produto WHERE codigo = $1", [c]);
          await q("DELETE FROM produtos_versoes WHERE id = $1", [v.id]);
        } else return res.status(400).json({ erro: "acao" }), true;
        return res.json({ ok: true }), true;
      }
    }
    return res.status(404).json({ erro: "rota" }), true;
  } catch (e) {
    console.error("Erro na rota", p, e);
    return res.status(500).json({ erro: "servidor", mensagem: "Erro no servidor. Tente de novo." }), true;
  }
}
