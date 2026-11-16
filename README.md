# Radar BSA v2.0

Aplicação Node.js sem dependências externas. Front-end servido pelo próprio backend; pesquisa manual e agendada usando Google News RSS público (sem Google API key), armazenamento JSON local, exportação de backup e importação CSV de CNPJs.

## Executar localmente

Requer Node.js 20+.

```bash
npm start
```

Acesse http://localhost:3000

## Publicar na Render

1. Envie o conteúdo desta pasta para um repositório GitHub.
2. Na Render, crie um Web Service conectado ao repositório.
3. Runtime: Node; Build Command: `npm install`; Start Command: `npm start`.
4. Para persistência real do JSON, use um serviço pago e monte um Persistent Disk em `/var/data`. O `render.yaml` já descreve essa configuração (plano Starter + disco de 1 GB); ajuste conforme sua conta.
5. Se o plano não permitir disco persistente, a aplicação ainda funciona, mas os dados locais podem ser perdidos em reinícios, suspensão ou deploy. Exporte backups regularmente.

## Como funciona a pesquisa

- Consulta feeds RSS públicos do Google News para Brasil, Chile, Argentina, Paraguai e Uruguai.
- Busca sinais em português e espanhol sobre centros de distribuição, investimentos, expansão industrial, armazenagem e automação.
- Pontua títulos e descrições por palavras-chave (0–20) para triagem.
- Deduplica notícias pela URL e registra a fonte original.
- Executa atualização diária às 07h de Brasília (America/Sao_Paulo) e permite busca manual.

## Limitações importantes

- Não é a API oficial do Google Search; utiliza feeds RSS públicos do Google News, que podem mudar, limitar resultados ou falhar temporariamente.
- O score não comprova intenção de compra nem representa probabilidade de fechamento.
- O sistema não extrai e-mails privados, não contorna login e não automatiza scraping de LinkedIn. A busca por contatos abre consultas públicas para validação humana.
- A empresa/organização pode não ser identificável automaticamente no título. Quando a extração não é segura, a ficha informa “Empresa a identificar”.
- A importação de CNPJs aceita CSV fornecido pelo usuário. Para detectar novas empresas, importe competências diferentes e compare a data de abertura; o app não baixa automaticamente o pacote massivo da Receita Federal.
- O agendador diário dentro do processo web depende de o serviço estar ativo e sem suspensão. Em instâncias gratuitas da Render, o web service pode suspender após inatividade; portanto, não há garantia de execução diária nesse plano. Para agenda diária confiável com arquivo local, use web service pago sempre ativo + Persistent Disk. Para produção robusta, recomenda-se migrar o job para Render Cron + armazenamento compartilhado (por exemplo, PostgreSQL) ou worker; Render Cron não acessa Persistent Disk.

## API local

- `GET /api/health`
- `GET /api/status`
- `GET /api/leads`
- `GET /api/runs`
- `POST /api/search` com `{ "countries": ["BR", "CL", "AR", "PY", "UY"] }`
- `PATCH /api/leads/:id`
- `POST /api/import/cnpj` com `{ "csv": "..." }`
- `GET /api/cnpj`
- `GET /api/export`

## Dados

Arquivo: `data/radar-data.json` (ou `DATA_DIR/radar-data.json`). Não comite dados pessoais ou listas de contatos no repositório. Guarde apenas informações empresariais públicas e necessárias, respeitando LGPD e os termos das fontes consultadas.
