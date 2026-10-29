# Fila de publicação do Instagram

Fila de posts **já aprovados** da @fintureapp. O GitHub Actions roda a cada 15 minutos e publica
cada post quando chega o `publicar_em` dele, pela API oficial do Instagram.

A fila é alimentada pelo `aprovar.js` da rotina de posts, que fica na máquina local. Não edite à mão.

- `fila/<pasta>/post.json`: horário, legenda e imagens.
- `fila/<pasta>/publicado.json`: gravado quando o post sai. Depois disso os JPEGs são apagados.
- `fila/<pasta>/erro.json`: tentativas que falharam. Depois de 3 tentativas, o post fica parado.
  Quando uma execução falha, o GitHub manda um e-mail ao dono do repositório.

Secrets: `IG_ACCESS_TOKEN` e `IG_USER_ID`, renovados toda sexta pela rotina local.
