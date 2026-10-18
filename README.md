# Chá de Casa Nova - Luiz e Mara

Site de uma página para os convidados escolherem presentes. Cada escolha é gravada
na planilha Google. Hospedagem gratuita no GitHub Pages.

## O que cada arquivo faz

| Arquivo | Para que serve |
|---|---|
| `index.html` | A estrutura da página: título, texto de boas-vindas, busca, lista e janela de envio. |
| `style.css` | O visual: cores (verde `#ABCC97` e creme `#F2E3BD`), fontes, tamanhos de botão, celular e computador. |
| `script.js` | O comportamento: carrega a lista, controla as escolhas, envia o pedido e mostra a confirmação. **Aqui você cola a URL do Apps Script** (primeira linha de configuração do arquivo). |
| `Code.gs` | O servidor, dentro da planilha: entrega a lista, confere cada pedido e grava na aba `Reservas`. Também tem 3 funções para você rodar uma vez (ver abaixo). |
| `fotos/` | As 51 fotos dos itens, reduzidas para carregar rápido. O nome é o ID do item (`P01.jpg` = primeiro item da lista). |

## Como funciona, em resumo

1. O site pede a lista ao Apps Script. Ele devolve cada item com quanto ainda resta (nunca o nome de quem reservou).
2. O convidado escolhe os itens e envia. O Apps Script confere tudo de novo, uma pessoa por vez, e só então grava.
3. O restante de cada item é sempre calculado somando a aba `Reservas`.

## Funções para rodar no editor do Apps Script

| Função | Quando rodar |
|---|---|
| `corrigirTextos` | Uma vez, no começo. Corrige os textos autorizados (hermético, Loja Útil Mix, Xícaras de vidro/porcelana etc.). |
| `prepararPlanilha` | Uma vez, no começo, e de novo depois de adicionar itens novos. Cria a aba `Reservas`, a coluna `ID` (P01, P02...) e as fórmulas de `STATUS`, `RESERVADO` e `RESTANTE`. |
| `verificarPlanilha` | Antes de divulgar o link e sempre que mexer na lista. Aponta ID repetido, quantidade inválida e reserva acima do total. |

## Tarefas comuns

- **Cancelar ou corrigir uma reserva:** apague a linha dela na aba `Reservas`. O restante se recalcula sozinho.
- **Adicionar um item:** escreva uma linha nova no fim da aba `Página1` (QUANTIDADE, ITEM, LOJA), rode `prepararPlanilha` para ele ganhar ID e fórmulas, e envie a foto como `fotos/P52.jpg` (o número do ID novo) ao GitHub.
- **Reordenar a lista:** pode, depois de rodar `prepararPlanilha`. O ID acompanha o item. Atenção: as fotos soltas sobre a coluna C da planilha não acompanham a ordenação (o site não usa essas fotos, só as da pasta `fotos/`).
- **Mudou o `Code.gs`:** é preciso criar uma **nova versão** da implantação (Implantar > Gerenciar implantações > editar > Nova versão). Só salvar não basta.
- **Mudou `index.html`, `style.css`, `script.js` ou fotos:** reenvie os arquivos ao GitHub. O GitHub Pages leva de 1 a 2 minutos para atualizar.

## Segurança, em uma linha cada

- O servidor não confia no navegador: confere item, quantidade, tamanho de texto e repetição de envio.
- Duas pessoas pedindo o último item ao mesmo tempo: o servidor atende uma por vez; a segunda recebe o aviso de que acabou.
- Textos digitados que começam com `=`, `+`, `-` ou `@` são gravados como texto comum (não viram fórmula).
- Campo escondido anti-robô e limite de tentativas (8 por hora por nome, 100 a cada 10 minutos no total).
- A página usa `noindex`: o Google não deve listar o endereço.
