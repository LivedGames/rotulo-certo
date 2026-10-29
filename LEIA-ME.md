# Rótulo Certo

O que está nesta pasta:

- `index.html`: o app (perfil, scanner, nota)
- `api/ler-rotulo.js`: o servidor que lê a foto do rótulo com IA
- `server.js`: para rodar fora da Vercel

## 1. Pegue uma chave grátis do Google Gemini

1. Entre em https://aistudio.google.com/apikey com sua conta Google.
2. Clique em **Create API key** e copie a chave.
3. Não precisa cadastrar cartão. Sem cartão, a conta fica no plano gratuito e nada é cobrado.

O plano gratuito tem limite de leituras por dia. O Google não divulga o número e mostra o limite do seu projeto no AI Studio. Quando o limite acaba, o app avisa e você pode digitar os valores. A cota renova à meia-noite do horário do Pacífico (4h ou 5h da manhã em Brasília).

No plano gratuito, o Google pode usar as fotos enviadas para melhorar os produtos dele. Fotos de rótulo não têm problema, mas não use o app para enviar nada pessoal.

Não coloque a chave dentro do `index.html`. Ela fica só no servidor.

## 2a. Publicar na Vercel (recomendado, grátis)

1. Crie uma conta em https://vercel.com.
2. No terminal:
   ```
   npm i -g vercel
   cd rotulo-certo
   vercel
   vercel env add GEMINI_API_KEY
   vercel --prod
   ```
   No `vercel`, responda às perguntas com Enter. No `env add`, cole a chave e marque **Production**.
3. Abra o link `https://...vercel.app` no celular.

Sem terminal: suba a pasta para um repositório no GitHub, importe-o em vercel.com/new, adicione `GEMINI_API_KEY` em **Settings > Environment Variables** e clique em **Redeploy**.

## 2b. Rodar no seu computador ou em outro servidor (Render, Railway, VPS)

Precisa de Node 18 ou mais novo.

```
cd rotulo-certo
cp .env.example .env      # e cole sua chave no arquivo .env
npm start
```

Abra http://localhost:3000. A câmera no celular só funciona em **https**. Render e Railway já dão https: use `npm start` como comando de início e adicione `GEMINI_API_KEY` nas variáveis de ambiente.

## Problemas comuns

- **"A chave da IA está faltando ou é inválida"**: a variável não foi salva ou foi colada com espaço. Na Vercel, depois de mudar uma variável, rode `vercel --prod` de novo.
- **Erro de modelo não encontrado nos logs**: o Google troca os nomes dos modelos de tempos em tempos. Veja o nome atual de um modelo "Flash-Lite" no AI Studio e configure a variável `MODELO_GEMINI` com ele.
- **A Netlify Drop não serve**: ela publica só a página, sem o servidor, e a foto não funciona lá.

## Usar o Claude em vez do Gemini (pago)

Troque `GEMINI_API_KEY` por `ANTHROPIC_API_KEY`, com uma chave de https://console.anthropic.com. Se as duas estiverem configuradas, o app usa o Gemini.
