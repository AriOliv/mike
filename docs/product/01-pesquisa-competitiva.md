# 01 · Pesquisa competitiva e padrões de UX para a workstation do Legal

> Autor: Sonar (Mike Product Squad) · 2026-10-20 · para o "Legal Manager" e o Prism (UX).
> Fontes: sites, help centers e release notes dos fornecedores, imprensa especializada
> (Artificial Lawyer, LawNext, Legal IT Insider), G2/Capterra/Reclame Aqui e estimativas de
> preço do Vendr ou de blogs de concorrentes. Preço quase nunca é público. Trate as faixas
> como indício, não como cotação. Onde algo não foi confirmado, está escrito.

## Resumo em 6 linhas

1. O mercado convergiu em **outubro de 2026** num mesmo desenho: *intake agêntico no Slack*
   (Legora 13/10, Harvey 14/10, SpotDraft Fall Release), *grid tabular com célula verificável*
   (Legora, Harvey, Evisort) e *revisão por playbook com semáforo* (Spellbook, Luminance, LegalOn).
2. **Prazos e obrigações continuam fracos em todos.** A Legora terceiriza para a Sirion, a GC AI
   não tem, e no Harvey é só um painel. O Mike já tem radar de prazos e calendário. É a cunha.
3. **Chat com a base inteira é promessa mal entregue.** SpotDraft responde 1 contrato por vez e
   LinkSquares, até 5. Fazer bem, com citação do trecho, já diferencia.
4. **Ninguém serve um Legal de 3 a 4 pessoas com IA de verdade.** Os gringos cobram de
   US$ 30 mil a 200 mil por ano, com mínimo de assentos. A Looplex começa em R$ 6 mil/mês.
   A Juridoc é barata, mas a IA é rasa.
5. **No Brasil nenhum fornecedor faz intake por WhatsApp**, só o netLex declara qual LLM usa
   (OpenAI), e nenhum é self-hosted.
6. **O upstream do Mike já tem a base do grid** (tabular review com citações, playbooks e
   reviews, workspaces e sharing). O fork está 828 commits atrás. Trazer o upstream é
   pré-requisito para copiar os padrões abaixo sem reinventar.

---

## 1. Tabela comparativa

Legenda: ● forte · ◐ parcial ou early access · ○ ausente ou não encontrado.

| Produto | Persona | Repositório + extração | Prazos/alertas | Intake de outras áreas | Aprovações | Chat na base | Playbook/redline | Preço (indício) |
|---|---|---|---|---|---|---|---|---|
| **Legora** | Big law, migrando para in-house | ◐ (Tabular Review; repositório via Sirion) | ○ (Sirion) | ● Slack (out/26), Teams/e-mail prometidos | ◐ advogado aprova o rascunho | ● sobre a tabela | ● Word/Outlook | ~US$ 3 mil/assento/ano, mín. 10 |
| **Harvey** | Big law e 1.600+ in-house | ● Vault (10 mil docs/tabela) | ◐ "upcoming obligations" no Insights | ◐ e-mail/Slack/Jira (early access) | ◐ checkpoints no Agent Builder | ● Vault inteiro | ● Word, multi-agent | US$ 1–2 mil/assento/mês, mín. 25–50 (contestado) |
| **GC AI** | GC solo até departamento in-house | ● Contract Intelligence (Drive/SharePoint) | ○ | ◐ self-service para áreas | ○ | ● citação por trecho exato | ● Word | US$ 500/assento/mês (público) |
| **Spellbook** | GC de scale-up, 5–12 pessoas | ○ | ○ | ○ | ○ | ○ (1 doc) | ● Word, Passou/Falhou | ~US$ 500/usuário/mês |
| **Robin AI** | — | Empresa desmontada (2025): serviços vendidos à Scissero, engenheiros na Microsoft | | | | | | Alerta de "não fazer" |
| **LegalOn** | In-house mid-market | ● Vault com prévia da extração | ● tela única de prazos + e-mail | ● Slack/Teams/e-mail/form, agente completa o pedido | ◐ Triage Agent (early) | ◐ | ● 135+ playbooks prontos | ~US$ 3,5 mil/usuário/ano, módulos à parte |
| **Ironclad** | Mid/enterprise, Salesforce | ● Smart Import (19 campos, 175 cláusulas) | ● Upcoming Renewals + Renewal Brief | ● Slack + launch form pré-preenchido | ● Workflow Designer | ● respeita permissão | ● Jurist no Word | mediana ~US$ 40 mil/ano + IA à parte |
| **SpotDraft** | Mid-market SaaS | ● Key Pointers | ● Obligations: extrair → atribuir → evidência | ● e-mail/Slack viram pedido | ● IA escala só o que desvia | ◐ (1 contrato por vez na doc) | ● VerifAI no Word | US$ 5–35 mil/ano |
| **Juro** | Startups e scale-ups | ● (nasce estruturado no editor) | ● até 5 lembretes por data | ◐ Slack/"legal front door" | ● condicional no-code | ◐ | ● Review Agent | mediana ~US$ 31 mil/ano, usuários ilimitados |
| **LinkSquares** | In-house 200+ func. | ● Smart Values (lâmpada = IA) | ◐ | ● **e-mail encaminhado vira task** | ◐ (exige script) | ◐ (até 5 contratos) | ● | média ~US$ 31 mil/ano + setup |
| **Workday/Evisort** | Enterprise Workday | ● **pergunta vira coluna** (Document X-Ray) | ◐ alertas agênticos anunciados | ● intake com follow-up | ● gerado por texto | ● repositório inteiro | ◐ | US$ 30–250 mil/ano |
| **Luminance** | Enterprise e escritórios | ● | ● renovações/exposição | ○ self-service | ● condicional | ● Ask Lumi | ● **semáforo por cláusula**, negociação autônoma | "seis dígitos" |
| **netLex** 🇧🇷 | Jurídico enterprise (Ambev, iFood) | ● | ◐ Management Agent (early) | ● Legal Intake + agente em Slack/Teams | ● | ◐ netLex AI (OpenAI) | ◐ Review Agent (early) | sob consulta |
| **Projuris** 🇧🇷 | Jurídico com contencioso | ● | ● antes/depois do vencimento | ● **Requisição vira contrato** | ● papéis + SLA | ◐ "Pergunte à Projuris IA", créditos | ◐ risco em minuta | sob consulta; IA por créditos |
| **Looplex** 🇧🇷 | Bancos e escritórios grandes | ● GED | ● obrigações recorrentes | ● formulário dinâmico | ● | ○ (sistema de regras) | ● cláusulas pré-aprovadas | R$ 6k / 16,5k / 50k por mês (público) |
| **Juridoc** 🇧🇷 | PME e escritórios | ◐ | ◐ lembretes | ◐ formulários | ◐ | ○ | ○ | ~R$ 120–260/mês |
| **Contraktor / Linte** 🇧🇷 | Jurídico mid-market | ● | ◐ | ● (Linte: triagem por IA) | ● | ◐ (Contraktor: MCP com 130+ ações) | ◐ | sob consulta |

**Leitura rápida.** Os gringos de IA (Legora, Harvey, GC AI, Spellbook) são fortes em
análise e fracos em ciclo de vida. Os CLMs clássicos (Ironclad, SpotDraft, Juro,
LinkSquares) são fortes em fluxo e fracos em IA sobre a base. Os brasileiros são CLMs
clássicos com IA em early access ou cobrada por crédito. **O espaço do Mike é juntar os
dois lados para um time pequeno, em PT-BR e sem setup de semanas.**

---

## 2. Top 10 padrões de UX para copiar

Ordem de prioridade: valor para um Legal de head + 2 a 3 pessoas numa fintech, dividido
pelo esforço sobre o que o Mike (fork + upstream) já tem.

### 1. Campo extraído com citação clicável e estado "verificado" · Harvey, Ironclad, LinkSquares
**Fluxo:** página do contrato com o documento à esquerda e os campos da planilha do Legal à
direita (vigência, renovação automática, aviso prévio, multa, cessão, change of control,
LGPD). Cada valor tem:
- ícone de origem: IA ou humano (a "lâmpada" da LinkSquares);
- clique que rola o documento até o trecho e o destaca (o "View in document" da Ironclad);
- estado **A conferir / Verificado / Sinalizado**, com quem verificou e quando;
- **reprocessar nunca sobrescreve campo verificado** (Harvey).

**Por que importa:** é o que faz o Legal confiar na base. Sem isso, a planilha volta a ser
preenchida à mão. A dor nº 1 dos concorrentes é extração errada sem revisão.

### 2. Tabela-portfólio onde a pergunta vira coluna · Evisort, Legora, Harvey, LegalOn
**Fluxo:** grid com uma linha por contrato e as colunas da planilha de referência como
padrão.
- "+ Coluna" aceita uma pergunta em linguagem natural ("tem cláusula de exclusividade?")
  com tipo definido (data, valor, sim/não, lista).
- A coluna roda no acervo todo, e cada célula abre o drawer do padrão 1.
- Filtros salvos como **Visões**, por exemplo "renova automaticamente em até 90 dias" e
  "compartilha dados como operador".
- Exportação para Excel no formato da planilha atual.

**Por que importa:** substitui o "Controle de Contratos - tabela base.xlsx" sem mudar o
modelo mental do time. O upstream do Mike já tem tabular review: é adaptar, não construir.

### 3. Alerta ancorado no prazo do aviso prévio, com ação · Ironclad, Juro, SpotDraft
**Fluxo:**
- Para contratos com renovação automática, a data-alvo é **vencimento − aviso prévio**, não
  o vencimento.
- Lembretes em 90, 60, 30 e 7 dias antes dessa data, com cadência por contrato (Juro deixa
  até 5).
- O alerta vai para o responsável no Slack e por e-mail e já traz contraparte, valor, tipo
  de renovação e um **Renewal Brief** em 5 linhas (Ironclad).
- Botões no próprio alerta: **Renovar · Não renovar · Renegociar · Adiar**. "Não renovar"
  cria a tarefa de notificar a contraparte.

**Por que importa:** perder uma janela de aviso prévio custa dinheiro real, e todos os
concorrentes são fracos aqui. O Mike já tem radar e Google Calendar. Falta ancorar no aviso
prévio e pôr a ação no alerta. (Ação "renovar/não renovar" dentro do e-mail: só achei em
blog da SpotDraft, não em documentação.)

### 4. Intake no Slack: thread vira pedido, agente pergunta o que falta, resposta volta na thread · Legora, SpotDraft, LegalOn, Checkbox
**Fluxo:**
1. A pessoa de outra área menciona o bot em `#juridico`, ou encaminha um e-mail para
   `juridico@` (LinkSquares).
2. O agente identifica o tipo (NDA, fornecedor, parceria, dúvida) e pergunta **na thread** só
   o que falta: contraparte, valor, prazo, anexo.
3. O pedido vira card com tipo, solicitante, responsável, prazo e status.
4. Dúvidas recorrentes ("qual NDA uso?") são respondidas direto pela política (Checkbox),
   com link.
5. A cada mudança de status, o solicitante recebe aviso na mesma thread.
6. A devolutiva aprovada pelo advogado é postada na thread.

**Por que importa:** o Legal pequeno some em pedidos soltos no DM. Isso dá fila única,
métricas de demanda por área e zero tela nova para o resto da empresa. O Hermes já tem bot
de Slack e WhatsApp.

### 5. Home com "depende de mim" · SpotDraft, Ironclad
**Fluxo:** no topo, contadores clicáveis:
- **Pedidos novos**
- **Para revisar**
- **Prazos nesta semana**
- **Campos a conferir**

Abaixo, abas **Atribuído a mim / Participando / Concluídos**. Cada linha mostra o próximo
passo e abre o item.

**Por que importa:** responde "o que eu faço agora?" em 2 segundos. É o que separa
ferramenta usada todo dia de ferramenta esquecida.

### 6. Chat com a base inteira, com escopo e citação do trecho · Harvey Vault, Evisort, Luminance, GC AI
**Fluxo:**
- Caixa de pergunta com chips de escopo antes de enviar: *Todos · Visão atual ·
  Contraparte X · Tipo*.
- A resposta é agregada ("7 contratos têm change of control; 2 exigem autorização") e traz a
  **lista dos contratos citados com o trecho exato**.
- "Transformar em coluna" leva a resposta para o grid do padrão 2.

**Por que importa:** é o pedido explícito do Legal ("conversar com toda a base"). Os
concorrentes param em 1 a 5 contratos. O "acervo" do Mike já existe e precisa de escopo,
citação por trecho e ponte para o grid.

### 7. Revisão contra playbook com semáforo e redline aceitável · Luminance, Spellbook, LegalOn, SpotDraft VerifAI
**Fluxo:**
- O contrato da contraparte entra e o painel lista cada cláusula do playbook como 🟢 Ok /
  🟡 Desvio aceitável / 🔴 Fora da política.
- Cada desvio traz uma explicação curta (não um score) e o texto de fallback proposto.
- Aceitar ou rejeitar gera tracked change no .docx.
- A saída é uma **lista de pontos para o solicitante** em linguagem de negócio (LegalOn).

**Por que importa:** é o "analista sênior que poupa tempo" do briefing. Comece com
playbooks prontos de NDA, prestação de serviço e DPA/LGPD: configurar playbook por semanas é
a reclamação nº 1 do Spellbook e da Luminance.

### 8. Conferir extração numa amostra antes do lote · LegalOn Vault, Ironclad Smart Import
**Fluxo:** ao importar o acervo (Drive), a extração roda primeiro em cerca de 10 contratos.
O Legal confere e ajusta as definições de campo e só então solta o lote inteiro. Depois
aparece um resumo do lote (por contraparte, tipo e status) e a fila "a conferir".

**Por que importa:** a primeira carga do acervo define a confiança no produto. Errar 300
contratos de uma vez queima o produto com o time.

### 9. Pedido vira contrato: um único objeto do intake ao arquivo · Projuris, SpotDraft
**Fluxo:** o card do pedido acumula tudo (mensagens, minutas, análise, aprovação, assinatura)
e, ao assinar, **vira o registro do contrato** com os campos já preenchidos. O solicitante é
o "dono de negócio" do contrato e recebe os alertas dele.

**Por que importa:** evita a planilha paralela e resolve a coluna "Área responsável" de
graça. Casa com a esteira de 6 etapas do Mike.

### 10. Aprovação humana antes de qualquer ação externa · GC AI, Harvey Agent Builder
**Fluxo:** quando um agente for mandar e-mail à contraparte, postar devolutiva, notificar não
renovação ou escrever no Drive/Notion, ele mostra um cartão "Vou fazer X, ok?" com prévia e o
advogado aprova com um clique. Há regra por tipo: "NDA padrão pode sair sem revisão" (Legora).

**Por que importa:** é multi-agent sem medo. Mantém o Legal no controle e cria a trilha de
auditoria que a fintech precisa.

**Menções honrosas, para depois:** "porquê aceitamos isso" guardado por concessão
(Institutional Memory, Luminance); busca por cláusula similar (LinkSquares); contraparte
editando no navegador sem conta (Juro); questionário que gera minuta de template
(Looplex/netLex).

---

## 3. O que NÃO fazer

1. **Setup longo antes do primeiro valor.** Ironclad leva ~4 meses, LinkSquares cobra até
   US$ 75 mil de implantação, Spellbook pede 2 a 4 semanas de playbook. Regra do Mike: o
   Legal sobe 10 contratos e vê a planilha preenchida no primeiro dia.
2. **Extração sem verificação humana.** LinkSquares errou ~30% das renovações num teste e a
   SpotDraft detecta parte errada. Todo campo de IA nasce "a conferir".
3. **Citação só no nível do documento.** É a crítica à Legora. Cite o trecho, com destaque.
4. **Chat limitado a 1 a 5 documentos** (SpotDraft, LinkSquares) vendido como "pergunte à
   base".
5. **Workflow rígido que precisa ser reiniciado** para trocar um aprovador ou corrigir um
   passo (Ironclad, LinkSquares). Etapas editáveis com o card em voo.
6. **Templates e configurações que só o suporte altera** (SpotDraft). O Legal edita
   playbook, campos e templates sozinho.
7. **Busca ruim.** É a tag mais citada no G2 da Ironclad. Busca full-text e semântica desde
   o dia 1.
8. **Tudo vira add-on ou crédito** (Ironclad Jurist à parte, Projuris por créditos). Sem
   medidor de uso na cara do usuário.
9. **Autonomia em cláusula sensível** (negociação autônoma da Luminance). Agente propõe,
   advogado decide.
10. **Depender de humanos por trás para a IA funcionar** (Robin AI quebrou assim). Tudo o que
    o produto promete precisa rodar sozinho.
11. **Tela nova para o resto da empresa.** Quem pede análise fica no Slack, WhatsApp ou
    e-mail. O Mike é a workstation do Legal, não de todo mundo.

---

## 4. Onde o Mike se diferencia

| Eixo | Posição do Mike | Contra quem |
|---|---|---|
| **Open source + self-host** | Contratos e dados de clientes não saem da infra da Avenia, com trilha de auditoria própria. Para fintech regulada (Bacen, LGPD, sigilo bancário) isso é argumento de compliance, não só de custo. | Todos são SaaS; o netLex manda para a OpenAI. |
| **Modelo escolhido pelo cliente** | Endpoint OpenAI-compatible (já no fork) via LiteLLM da Avenia: Claude, Gemini, OpenAI ou local, por tarefa, com custo visível. | Ninguém no Brasil declara o modelo, e os gringos travam no deles. |
| **Custo para time pequeno** | Sem assento mínimo; o custo é infra + tokens. Um Legal de 4 pessoas paga uma fração de qualquer opção. | Harvey/Legora (mín. 10–50 assentos), Looplex (R$ 6k+/mês). |
| **PT-BR e direito brasileiro de verdade** | Planilha do Legal como schema nativo, playbooks em PT-BR (LGPD controlador/operador, multa e correção por IPCA/IGP-M, foro, cessão e change of control no padrão BR), datas e valores BR. | Gringos em inglês; brasileiros com IA rasa ou em early access. |
| **Hermes como canal (Slack + WhatsApp)** | Intake, dúvida rápida, status e alerta de prazo onde a empresa já conversa. **WhatsApp não existe em nenhum concorrente**, e no Brasil é onde metade das conversas de negócio acontece. | Legora e Harvey só Slack (out/26); netLex com Slack/Teams em early access. |
| **Integração com dados internos** | Card do contrato com contexto da contraparte: Pipedrive (dono da conta, deal), warehouse (cliente ativo, receita, volume, KYB) e registro de compliance. O Legal prioriza pelo peso do relacionamento. O roadmap do `avn-clm` já mapeou isso. | Nenhum CLM conecta ao warehouse do cliente sem projeto de integração caro. |
| **Prazos e obrigações como produto principal** | Radar, calendário e Google Calendar já existem. Com a âncora no aviso prévio, o alerta com ação e o Renewal Brief, o Mike faz bem o que ninguém faz. | Fraqueza geral, inclusive Harvey e Legora. |
| **MCP nos dois sentidos** | Expor o acervo como MCP (para o Claude de cada pessoa da Avenia perguntar "temos contrato com X?") e consumir os MCPs que a Avenia já roda (Notion, Drive, Slack, assinatura). | No Brasil virou padrão (Projuris, Contraktor, Clicksign); é obrigatório e barato. |

---

## 5. Recomendação de sequência (para o maestro decidir)

1. **Trazer o upstream do Mike** (828 commits) antes de construir padrões de UX: tabular
   review com citações, playbooks/reviews, workspaces e sharing já resolvem os padrões 2, 7
   e parte do 1. Construir por cima do fork velho é retrabalho.
2. **Semana 1–2:** padrões 1 + 2 + 8 sobre a planilha do Legal (página do contrato,
   portfólio, importação com amostra). É o que o Legal valida primeiro na prévia.
3. **Semana 3:** padrão 3 (alerta ancorado no aviso prévio, com ação) e padrão 5 (home).
4. **Semana 4+:** padrão 4 via Hermes no Slack (WhatsApp em seguida) e padrão 6 com escopo e
   ponte para o grid.
5. Padrões 7, 9 e 10 entram junto com o intake, porque dependem do card de pedido.

## Pendências

- Nenhum fluxo foi testado nos produtos (sem trial). As descrições vêm de documentação e
  imprensa. Vale uma demo gravada de Legora Intake e Harvey Vault para o Prism.
- Não confirmados: ação "renovar/não renovar" dentro do e-mail (SpotDraft); "Ironclad Agent"
  com 10+ agentes (out/26, só blog de terceiro); layout da página do contrato do LegalOn.
- Preços são estimativas de terceiros, alguns com viés de concorrente.
