# Rótulo Certo nas lojas de apps

O site já é um app instalável (PWA). As lojas aceitam esse tipo de app empacotado pelo PWABuilder, da Microsoft.

## 1. Gerar os pacotes
1. Abra https://www.pwabuilder.com e cole o endereço do app no Railway (ex.: https://rotulo-certo-production.up.railway.app).
2. Ele mostra uma nota do app. Clique em **Package for stores**.
3. Escolha a loja: Android, iOS ou Windows. Ele baixa um arquivo .zip com o pacote e as instruções.

## 2. Google Play (Android)
- Conta de desenvolvedor: taxa única de US$ 25 em https://play.google.com/console.
- No PWABuilder, escolha **Android**, preencha o nome do pacote (ex.: `br.com.rotulocerto`) e baixe.
- O zip traz um arquivo `assetlinks.json`. Copie o conteúdo dele e cole na variável `ASSETLINKS_JSON` do Railway. Isso faz o app abrir sem a barra do navegador.
- Envie o arquivo `.aab` no Play Console. Contas pessoais novas precisam passar por um período de teste fechado com testadores antes da publicação; o Play Console mostra as regras atuais.
- Guarde o arquivo de assinatura (`signing.keystore`) e as senhas. Sem eles você não consegue publicar atualizações.

## 3. App Store (iPhone)
- Conta Apple Developer: US$ 99 por ano.
- Precisa de um Mac com Xcode (ou um serviço de Mac na nuvem) para compilar o pacote do PWABuilder.
- A Apple recusa apps que são "só um site dentro de uma moldura". O Rótulo Certo tem câmera, modo sem internet, diário e gráficos, o que ajuda, mas a aprovação não é garantida.

## 4. Microsoft Store (Windows)
- No PWABuilder, escolha **Windows** e siga as instruções para enviar pelo Partner Center (https://partner.microsoft.com).

## Atualizações
- Mudanças no site aparecem no app instalado e nos apps das lojas sem nova publicação, porque eles abrem o próprio site.
- Ao publicar uma versão nova, aumente o número de `VERSAO` no arquivo `sw.js` (ex.: `rotulo-certo-v2`). Assim todos recebem a versão nova.
