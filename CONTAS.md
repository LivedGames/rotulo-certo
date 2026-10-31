# Ligar contas, sincronização e base própria (Railway)

## 1. Banco de dados (obrigatório)
1. No seu projeto do Railway, clique em **+ Create → Database → Add PostgreSQL**.
2. Abra o serviço do app (`rotulo-certo`) → aba **Variables** → **New Variable**.
3. Nome: `DATABASE_URL`. Valor: `${{Postgres.DATABASE_URL}}` (o Railway sugere a referência ao digitar `${{`).
4. Espere o deploy. No log deve aparecer: `Banco pronto: contas e base própria ligadas.`
As tabelas são criadas sozinhas na primeira vez.

## 2. Administrador da base (recomendado)
- Variável `ADMIN_EMAILS` = seu e-mail (vários separados por vírgula).
- Com essa conta, a aba Perfil mostra o **Painel da base**: produtos em revisão, denúncias, aprovar, voltar versão anterior e apagar.

## 3. Entrar com Google (opcional)
1. Acesse https://console.cloud.google.com e crie um projeto (ex.: "Rotulo Certo").
2. **APIs e serviços → Tela de consentimento OAuth**: tipo **Externo**; preencha nome do app, e-mail de suporte e o link da política: `https://SEU-APP.up.railway.app/privacidade`.
3. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth** → tipo **Aplicativo da Web**.
4. Em **Origens JavaScript autorizadas**, adicione `https://SEU-APP.up.railway.app` (e o seu domínio, se tiver).
5. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e crie a variável `GOOGLE_CLIENT_ID` no Railway.
6. Para qualquer pessoa conseguir entrar, publique a tela de consentimento (botão **Publicar app**).

## 4. E-mail de "Esqueci a senha" (opcional)
1. Crie conta em https://resend.com e gere uma **API Key**. Variável: `RESEND_API_KEY`.
2. Sem domínio próprio, o Resend só envia para o e-mail da sua conta (bom para testar).
3. Para enviar a todos: em **Domains**, adicione seu domínio, configure os registros DNS e crie a variável
   `EMAIL_REMETENTE` = `Rótulo Certo <nao-responda@seudominio.com.br>`.

## 5. Outras variáveis
- `CONTATO_EMAIL`: e-mail mostrado na Política de Privacidade (exigida pelas lojas e pela LGPD).
- `BASE_URL`: endereço público do app, se usar domínio próprio (ex.: `https://rotulocerto.com.br`). Usado no link do e-mail.
- `LIMITE_IA_HORA`: leituras por foto/IA por aparelho por hora (padrão 40).

## Como funciona
- **Conta:** e-mail e senha (guardada com hash scrypt) ou Google. Sessão vale 90 dias.
- **Sincronização:** cada mudança é enviada em 2 segundos; sem internet, envia quando voltar. Ao entrar pela primeira vez num aparelho que já tem dados, o app junta os dados do aparelho com os da conta.
- **Base própria:** ao escanear, o app procura primeiro na sua base, depois no Open Food Facts. Produto fotografado ou corrigido por um usuário logado entra na hora com o selo "Cadastrado por usuário"; com 2 confirmações de outras pessoas vira "Confirmado". Com 3 denúncias a mais que confirmações, sai da busca e vai para revisão no painel. Toda correção guarda a versão anterior.
- **Excluir conta:** apaga perfil, diário, pesos e listas. Produtos cadastrados ficam na base sem o nome da pessoa.

## Antes de divulgar
- Revise a Política de Privacidade (`privacidade.html`) com alguém de confiança ou um advogado; ela é um modelo.
- Faça backup do banco: no Railway, serviço Postgres → **Backups** (nos planos que oferecem).
