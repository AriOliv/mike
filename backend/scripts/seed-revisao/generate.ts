// Generates the preview seed for the contract review (Revisão por playbook):
// two fictitious Word contracts with the review's suggestions as real tracked
// changes, and the SQL that ties them to the preview's seed cards
// (deploy/gke/seed/integration/extra-revisao.sql in the infra checkout).
//
// The tracked changes are made with the same function the review uses
// (applyTrackedEdits), and the SQL records the w:ids it returned, so accepting
// or rejecting a suggestion in the preview acts on the real file.
//
//   npx tsx scripts/seed-revisao/generate.ts <out-dir>
//
// Everything is fictitious: parties end in "(fictícia)" like the base seed.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { applyTrackedEdits, type EditInput } from "../../src/lib/docxTrackedChanges";
import { AVENIA_PLAYBOOK_CONTENT, AVENIA_PLAYBOOK_NAME } from "../../src/modules/contract-review/contractReview.playbook";
import { evaluateRules, overallRisk, RULES_VERSION } from "../../src/modules/contract-review/contractReview.rules";
import { locateQuote, type Ficha, type FichaPath } from "../../src/modules/contract-review/contractReview.ficha";
import { extractDocxBodyText } from "../../src/lib/docxTrackedChanges";

type Clause = { heading: string; text: string };
type Finding = {
    id: string;
    topicId: string;
    ruleId: string;
    ruleName: string;
    status: "acceptable" | "needs_review" | "unacceptable" | "missing_required" | "not_applicable";
    quote: string;
    location: string;
    analysis: string;
    suggestedText: string;
    insertAfter?: string;
};
type FieldSeed = { path: FichaPath; value: unknown; quote?: string; clause?: string; status?: string; state?: string };
type Contract = {
    key: string;
    projectId: string;
    documentId: string;
    originalVersionId: string;
    reviewedVersionId: string;
    runId: string;
    filename: string;
    title: string;
    parties: string;
    clauses: Clause[];
    summary: string;
    findings: Finding[];
    /** Findings already decided by the Legal team, for the "decided" state. */
    decided: { findingId: string; decision: "aceito" | "rejeitado"; reason?: string }[];
    ficha: FieldSeed[];
};

const uuid = (prefix: string, n: number) => `00000000-0000-4000-${prefix}-${String(n).padStart(12, "0")}`;

const CONTRACTS: Contract[] = [
    {
        key: "nuvem",
        projectId: "00000000-0000-4000-a000-000000000003",
        documentId: "00000000-0000-4000-d100-000000000001",
        originalVersionId: "00000000-0000-4000-e100-000000000001",
        reviewedVersionId: uuid("e200", 1),
        runId: uuid("b200", 1),
        filename: "SaaS Nuvem Contábil (fictícia).docx",
        title: "CONTRATO DE LICENÇA DE SOFTWARE COMO SERVIÇO",
        parties:
            'Entre AVENIA DEMO PAGAMENTOS LTDA. (fictícia) ("Avenia", CONTRATANTE) e NUVEM CONTÁBIL S.A. (fictícia) ("Nuvem", CONTRATADA).',
        clauses: [
            { heading: "Cláusula 1 – Objeto", text: "1.1 A CONTRATADA licencia à Avenia o uso da plataforma de contabilidade em nuvem, na modalidade software como serviço." },
            {
                heading: "Cláusula 5 – Vigência e Renovação",
                text: "5.1 Este Contrato vigorará por 12 (doze) meses e será renovado automaticamente por iguais períodos, salvo manifestação em contrário com antecedência mínima de 30 (trinta) dias.",
            },
            {
                heading: "Cláusula 7 – Cessão",
                text: "7.1 A Avenia não poderá ceder este Contrato, no todo ou em parte, sem o prévio consentimento por escrito da CONTRATADA.",
            },
            {
                heading: "Cláusula 9 – Dados Pessoais",
                text: "9.1 As Partes tratarão dados pessoais conforme a Lei nº 13.709/2018, nos termos da Política de Privacidade disponível no site da CONTRATADA.",
            },
            {
                heading: "Cláusula 11 – Responsabilidade",
                text: "11.1 A responsabilidade de cada Parte fica limitada ao valor pago nos 12 (doze) meses anteriores ao evento, excluídos lucros cessantes e danos indiretos.",
            },
            {
                heading: "Cláusula 20 – Foro",
                text: "20.1 Este Contrato é regido pelas leis do Estado de Nova York, EUA, e fica eleito o foro da cidade de Nova York.",
            },
        ],
        summary:
            "O contrato diverge do Playbook Avenia v1 em três pontos: aviso de não renovação de 30 dias, cessão vedada à Avenia sem exceção para o grupo e lei e foro de Nova York. A LGPD precisa de revisão; a limitação de responsabilidade está alinhada.",
        findings: [
            {
                id: "nuvem-renovacao",
                topicId: "avenia-vigencia",
                ruleId: "avenia-renovacao-aviso",
                ruleName: "Renovação e aviso prévio",
                status: "unacceptable",
                quote: "salvo manifestação em contrário com antecedência mínima de 30 (trinta) dias",
                location: "Cláusula 5.1",
                analysis: "Renovação automática com aviso de apenas 30 dias. O playbook pede de 60 a 90 dias, para a decisão sair antes do ciclo de aprovação interna.",
                suggestedText: "salvo manifestação em contrário com antecedência mínima de 60 (sessenta) dias",
            },
            {
                id: "nuvem-cessao",
                topicId: "avenia-alteracao-parte",
                ruleId: "avenia-cessao",
                ruleName: "Cessão do contrato",
                status: "unacceptable",
                quote: "7.1 A Avenia não poderá ceder este Contrato, no todo ou em parte, sem o prévio consentimento por escrito da CONTRATADA.",
                location: "Cláusula 7",
                analysis: "A Avenia não pode ceder nem para empresas do grupo. O padrão é cessão recíproca com consentimento, livre para afiliadas.",
                suggestedText:
                    "7.1 Nenhuma das Partes poderá ceder este Contrato sem o prévio consentimento por escrito da outra, exceto a cessão a sociedades do mesmo grupo econômico ou a sucessoras por fusão, cisão ou incorporação, mediante simples notificação.",
            },
            {
                id: "nuvem-lgpd",
                topicId: "avenia-dados",
                ruleId: "avenia-lgpd-papeis",
                ruleName: "LGPD: papéis e obrigações",
                status: "needs_review",
                quote: "nos termos da Política de Privacidade disponível no site da CONTRATADA",
                location: "Cláusula 9.1",
                analysis: "As regras de tratamento ficam num documento externo, que pode mudar, e os papéis de controladora e operadora não estão definidos.",
                suggestedText:
                    "atuando a Avenia como controladora e a CONTRATADA como operadora, que comunicará qualquer incidente de segurança em até 48 (quarenta e oito) horas de sua ciência",
            },
            {
                id: "nuvem-responsabilidade",
                topicId: "avenia-responsabilidade",
                ruleId: "avenia-limitacao-responsabilidade",
                ruleName: "Limitação de responsabilidade",
                status: "acceptable",
                quote: "limitada ao valor pago nos 12 (doze) meses anteriores ao evento",
                location: "Cláusula 11.1",
                analysis: "Teto recíproco de 12 meses, com exclusão de danos indiretos: igual à posição padrão.",
                suggestedText: "",
            },
            {
                id: "nuvem-foro",
                topicId: "avenia-disputas",
                ruleId: "avenia-foro",
                ruleName: "Lei aplicável e foro",
                status: "unacceptable",
                quote: "20.1 Este Contrato é regido pelas leis do Estado de Nova York, EUA, e fica eleito o foro da cidade de Nova York.",
                location: "Cláusula 20",
                analysis: "Lei e foro estrangeiros para a entidade brasileira da Avenia.",
                suggestedText: "20.1 Este Contrato é regido pelas leis da República Federativa do Brasil, e fica eleito o foro da Comarca de São Paulo/SP.",
            },
        ],
        decided: [],
        ficha: [
            { path: "identificacao.tipo_contrato", value: { categoria: "licenca_saas" }, status: "inferido" },
            { path: "identificacao.papel_avenia", value: "contratante", quote: '("Avenia", CONTRATANTE)', clause: "Preâmbulo", state: "confirmado" },
            { path: "identificacao.contraparte", value: { nome: "NUVEM CONTÁBIL S.A. (fictícia)" }, quote: "NUVEM CONTÁBIL S.A. (fictícia)", clause: "Preâmbulo", state: "confirmado" },
            { path: "vigencia.prazo", value: { tipo: "determinado", duracao: { amount: 12, unit: "meses", day_count: "nao_especificado" } }, quote: "vigorará por 12 (doze) meses", clause: "cl. 5.1" },
            {
                path: "vigencia.renovacao",
                value: { tipo: "automatica", aviso_nao_renovacao: { amount: 30, unit: "dias", day_count: "nao_especificado" }, limite_renovacoes: null },
                quote: "será renovado automaticamente por iguais períodos",
                clause: "cl. 5.1",
            },
            { path: "rescisao.imotivada", value: null, status: "nao_encontrado" },
            { path: "alteracao_parte.cessao", value: { regime: "vedada", aplica_a: "avenia", excecoes: [] }, quote: "A Avenia não poderá ceder este Contrato", clause: "cl. 7.1" },
            { path: "dados_pessoais.compartilhamento", value: true, quote: "As Partes tratarão dados pessoais", clause: "cl. 9.1" },
            { path: "dados_pessoais.dpa", value: "por_referencia", quote: "Política de Privacidade disponível no site da CONTRATADA", clause: "cl. 9.1" },
            {
                path: "responsabilidade.limitacao",
                value: { existe: true, protege: "ambas", tipo: "meses_remuneracao", meses: 12 },
                quote: "limitada ao valor pago nos 12 (doze) meses anteriores ao evento",
                clause: "cl. 11.1",
            },
            { path: "foro.lei_aplicavel", value: { jurisdicao: "US-NY" }, quote: "regido pelas leis do Estado de Nova York", clause: "cl. 20.1" },
        ],
    },
    {
        key: "datavale",
        projectId: "00000000-0000-4000-a000-000000000007",
        documentId: "00000000-0000-4000-d100-000000000005",
        originalVersionId: "00000000-0000-4000-e100-000000000005",
        reviewedVersionId: uuid("e200", 5),
        runId: uuid("b200", 5),
        filename: "Contrato de dados DataVale (fictícia).docx",
        title: "CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE ANÁLISE DE DADOS",
        parties:
            'Entre AVENIA DEMO PAGAMENTOS LTDA. (fictícia) ("Avenia", CONTRATANTE) e DATAVALE ANALYTICS LTDA. (fictícia) ("DataVale", CONTRATADA).',
        clauses: [
            { heading: "Cláusula 1 – Objeto", text: "1.1 A CONTRATADA prestará à Avenia serviços de análise de dados transacionais para prevenção a fraudes." },
            {
                heading: "Cláusula 6 – Alteração de Controle",
                text: "6.1 A alteração do controle societário da Avenia dependerá de anuência prévia da CONTRATADA, sob pena de rescisão.",
            },
            {
                heading: "Cláusula 8 – Dados Pessoais",
                text: "8.1 A CONTRATADA poderá armazenar os dados em servidores localizados fora do Brasil.",
            },
            {
                heading: "Cláusula 10 – Confidencialidade",
                text: "10.1 As Partes manterão sigilo sobre as informações recebidas e somente as revelarão a autoridades mediante aviso prévio à outra Parte.",
            },
            {
                heading: "Cláusula 12 – Multa",
                text: "12.1 Em caso de rescisão antecipada pela Avenia, será devida multa de 50% (cinquenta por cento) do valor total do Contrato.",
            },
        ],
        summary:
            "O contrato diverge em mudança de controle, confidencialidade com autoridades e multa rescisória. A transferência internacional de dados precisa de mecanismo da LGPD. A cessão já foi decidida pelo Legal.",
        findings: [
            {
                id: "datavale-controle",
                topicId: "avenia-alteracao-parte",
                ruleId: "avenia-mudanca-controle",
                ruleName: "Mudança de controle",
                status: "unacceptable",
                quote: "6.1 A alteração do controle societário da Avenia dependerá de anuência prévia da CONTRATADA, sob pena de rescisão.",
                location: "Cláusula 6",
                analysis: "Rodada de investimento ou M&A passaria a depender da DataVale, e o contrato não define 'controle'.",
                suggestedText:
                    "6.1 A alteração do controle societário de qualquer das Partes será comunicada à outra em até 30 (trinta) dias, não constituindo hipótese de rescisão. 'Controle' significa a titularidade da maioria do capital votante.",
            },
            {
                id: "datavale-transferencia",
                topicId: "avenia-dados",
                ruleId: "avenia-lgpd-papeis",
                ruleName: "LGPD: papéis e obrigações",
                status: "needs_review",
                quote: "8.1 A CONTRATADA poderá armazenar os dados em servidores localizados fora do Brasil.",
                location: "Cláusula 8.1",
                analysis: "Dados saem do Brasil sem as cláusulas-padrão da ANPD ou outra hipótese do art. 33 da LGPD.",
                suggestedText:
                    "8.1 A CONTRATADA poderá armazenar os dados em servidores localizados fora do Brasil, desde que adote as cláusulas-padrão contratuais aprovadas pela ANPD.",
            },
            {
                id: "datavale-confidencialidade",
                topicId: "avenia-dados",
                ruleId: "avenia-confidencialidade-reguladores",
                ruleName: "Confidencialidade e reguladores",
                status: "unacceptable",
                quote: "e somente as revelarão a autoridades mediante aviso prévio à outra Parte",
                location: "Cláusula 10.1",
                analysis: "A Avenia teria de avisar a contraparte antes de cumprir requisição de autoridade, o que conflita com o sigilo das comunicações ao COAF.",
                suggestedText:
                    "ressalvada a divulgação exigida por lei, regulador ou ordem judicial, que independe de aviso à outra Parte quando a lei ou a autoridade o vedar",
            },
            {
                id: "datavale-multa",
                topicId: "avenia-responsabilidade",
                ruleId: "avenia-multa",
                ruleName: "Multas (rescisória, moratória e por descumprimento)",
                status: "unacceptable",
                quote: "será devida multa de 50% (cinquenta por cento) do valor total do Contrato",
                location: "Cláusula 12.1",
                analysis: "Multa sobre o valor total e acima de 20%: sair fica mais caro que continuar.",
                suggestedText: "será devida multa de 20% (vinte por cento) sobre o saldo remanescente do Contrato",
            },
        ],
        decided: [{ findingId: "datavale-multa", decision: "aceito" }],
        ficha: [
            { path: "identificacao.tipo_contrato", value: { categoria: "prestacao_servicos" }, status: "inferido" },
            { path: "identificacao.papel_avenia", value: "contratante", quote: '("Avenia", CONTRATANTE)', clause: "Preâmbulo" },
            {
                path: "alteracao_parte.mudanca_controle",
                value: { regime: "consentimento_previo", aplica_a: "avenia", direito_rescisao_contraparte: true, define_controle: false },
                quote: "dependerá de anuência prévia da CONTRATADA, sob pena de rescisão",
                clause: "cl. 6.1",
            },
            { path: "dados_pessoais.compartilhamento", value: true, quote: "análise de dados transacionais", clause: "cl. 1.1", state: "confirmado" },
            {
                path: "dados_pessoais.transferencia_internacional",
                value: { ocorre: true, mecanismo: null },
                quote: "servidores localizados fora do Brasil",
                clause: "cl. 8.1",
            },
            {
                path: "regulatorio.confidencialidade",
                value: { existe: true, carve_out_autoridades: false, exige_aviso_previo_a_contraparte: true },
                quote: "somente as revelarão a autoridades mediante aviso prévio à outra Parte",
                clause: "cl. 10.1",
            },
            {
                path: "rescisao.multa_rescisoria",
                value: { existe: true, tipo: "percentual_valor_total", percentual: 50, meses: null, devida_por: "avenia" },
                quote: "será devida multa de 50% (cinquenta por cento) do valor total do Contrato",
                clause: "cl. 12.1",
            },
        ],
    },
];

const LEGAL = "(select id from public._seed_users where role = 'legal') legal";
const q = (value: unknown) => (value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`);
const j = (value: unknown) => `${q(JSON.stringify(value))}::jsonb`;

async function build(contract: Contract, outDir: string): Promise<string> {
    const paragraphs = [new Paragraph({ text: contract.title, heading: HeadingLevel.TITLE }), new Paragraph({ text: contract.parties })];
    for (const clause of contract.clauses)
        paragraphs.push(new Paragraph({ text: clause.heading, heading: HeadingLevel.HEADING_2 }), new Paragraph({ text: clause.text }));
    const original = await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
    const text = await extractDocxBodyText(original);

    const edits: { finding: Finding; edit: EditInput }[] = contract.findings
        .filter((f) => f.suggestedText && f.quote)
        .map((finding) => ({
            finding,
            edit: { find: finding.quote, replace: finding.suggestedText, context_before: "", context_after: "", reason: finding.ruleName },
        }));
    for (const { finding } of edits)
        if (!text.includes(finding.quote)) throw new Error(`quote not in ${contract.key}: ${finding.quote}`);
    const result = await applyTrackedEdits(original, edits.map((e) => e.edit), { author: "Agente de revisão" });
    if (result.errors.length) throw new Error(`${contract.key}: ${JSON.stringify(result.errors)}`);

    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, `${contract.key}-original.docx`), original);
    writeFileSync(path.join(outDir, `${contract.key}-revisado.docx`), result.bytes);

    const storagePath = `seed/revisao/${contract.key}-revisado.docx`;
    const originalPath = `seed/revisao/${contract.key}-original.docx`;
    const sql: string[] = [`-- ${contract.filename}`];
    // The original replaces the Início's placeholder path, so version 1 is a real file too.
    sql.push(
        `update public.document_versions set storage_path = ${q(originalPath)} where id = ${q(contract.originalVersionId)} and storage_path like 'seed/inicio/%';`,
        `insert into public.document_versions (id, document_id, storage_path, filename, version_number, source, file_type)
values (${q(contract.reviewedVersionId)}, ${q(contract.documentId)}, ${q(storagePath)}, ${q(contract.filename)}, 2, 'assistant_edit', 'docx')
on conflict (id) do nothing;`,
        `update public.documents set current_version_id = ${q(contract.reviewedVersionId)} where id = ${q(contract.documentId)};`,
    );

    const editByFinding = new Map<string, Record<string, unknown>>();
    result.changes.forEach((change, i) => {
        const { finding } = edits[i];
        const editId = uuid("b300", Number(contract.reviewedVersionId.slice(-1)) * 100 + i + 1);
        editByFinding.set(finding.id, {
            kind: "edit",
            edit_id: editId,
            document_id: contract.documentId,
            version_id: contract.reviewedVersionId,
            version_number: 2,
            change_id: change.id,
            del_w_id: change.delId,
            ins_w_id: change.insId,
            deleted_text: change.deletedText,
            inserted_text: change.insertedText,
            context_before: change.contextBefore,
            context_after: change.contextAfter,
            reason: finding.ruleName,
            status: "pending",
        });
        sql.push(`insert into public.document_edits (id, document_id, version_id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after, status)
values (${q(editId)}, ${q(contract.documentId)}, ${q(contract.reviewedVersionId)}, ${q(change.id)}, ${q(change.delId)}, ${q(change.insId)}, ${q(change.deletedText)}, ${q(change.insertedText)}, ${q(change.contextBefore)}, ${q(change.contextAfter)}, 'pending')
on conflict (id) do nothing;`);
    });

    const findings = contract.findings.map((finding) => ({
        ...finding,
        insertAfter: finding.insertAfter ?? "",
        edit: editByFinding.get(finding.id) ?? null,
    }));
    const content = { ...AVENIA_PLAYBOOK_CONTENT };
    sql.push(`insert into public.playbook_runs (id, playbook_id, content_json, document_id, edited_version_id, user_id, model, document_name, review_mode, review_scope, status, summary, findings_json, started_at, completed_at, created_at, updated_at)
select ${q(contract.runId)}, ${q(PLAYBOOK_ID)}, ${j(content)}, ${q(contract.documentId)}, ${q(contract.reviewedVersionId)}, legal.id, 'previa-stub', ${q(contract.filename)}, 'strict', 'full', 'completed', ${q(contract.summary)}, ${j(findings)}, now() - interval '2 hours', now() - interval '118 minutes', now() - interval '2 hours', now() - interval '118 minutes'
from ${LEGAL} on conflict (id) do nothing;`);
    sql.push(`insert into public.contract_review_runs (run_id, project_id, document_id, playbook_id, user_id, created_at)
select ${q(contract.runId)}, ${q(contract.projectId)}, ${q(contract.documentId)}, ${q(PLAYBOOK_ID)}, legal.id, now() - interval '2 hours'
from ${LEGAL} on conflict (run_id) do nothing;`);
    for (const decided of contract.decided)
        sql.push(`insert into public.contract_review_decisions (run_id, finding_id, decision, reason, decided_by, decided_at)
values (${q(contract.runId)}, ${q(decided.findingId)}, ${q(decided.decision)}, ${q(decided.reason ?? null)}, 'Legal Demo', now() - interval '90 minutes')
on conflict (run_id, finding_id) do nothing;`);

    // The Ficha, in the schema's envelope, with quotes verified against the text.
    const ficha: Ficha = {};
    for (const seed of contract.ficha) {
        const located = seed.quote ? locateQuote(text, seed.quote) : null;
        if (seed.quote && located?.match === "nao_encontrado") throw new Error(`ficha quote not in ${contract.key}: ${seed.quote}`);
        ficha[seed.path] = {
            status: (seed.status ?? (seed.value === null ? "nao_encontrado" : "encontrado")) as NonNullable<Ficha[FichaPath]>["status"],
            value: seed.value,
            citations: seed.quote ? [{ quote: seed.quote, clause: seed.clause ?? null, span: located!.span, verified: true, match: located!.match }] : [],
            confidence: seed.value === null ? null : "alta",
            origin: "ia",
            notes: seed.status === "inferido" ? "Inferido do objeto do contrato." : null,
            review: {
                state: (seed.state ?? "pendente") as "pendente" | "confirmado",
                by: seed.state ? "Legal Demo" : null,
                at: seed.state ? new Date(Date.UTC(2026, 9, 20, 12)).toISOString() : null,
                comment: null,
            },
        };
    }
    const findingsRules = evaluateRules(ficha);
    sql.push(`insert into public.contract_fichas (project_id, schema_version, ficha, document_id, document_version_id, model, prompt_version, rules_version, findings, risk_overall, extracted_at, updated_at)
values (${q(contract.projectId)}, '1.0', ${j(ficha)}, ${q(contract.documentId)}, ${q(contract.reviewedVersionId)}, 'previa-stub', 'ficha-revisao-v1', ${q(RULES_VERSION)}, ${j(findingsRules)}, ${q(overallRisk(findingsRules))}, now() - interval '3 hours', now() - interval '3 hours')
on conflict (project_id) do nothing;`);
    // The feed shows who did what.
    sql.push(`insert into public.card_events (project_id, actor_type, actor_id, actor_name, on_behalf_of, action, after, source, at)
select ${q(contract.projectId)}, 'agent', 'agent:revisor@1', 'Agente de revisão', legal.id::text, 'review.completed', ${j({ document: contract.filename, run: contract.runId, sources: 3 })}, 'agent', now() - interval '118 minutes'
from ${LEGAL} where not exists (select 1 from public.card_events e where e.project_id = ${q(contract.projectId)} and e.action = 'review.completed' and e.after->>'run' = ${q(contract.runId)});`);
    for (const decided of contract.decided) {
        const finding = contract.findings.find((f) => f.id === decided.findingId)!;
        sql.push(`insert into public.card_events (project_id, actor_type, actor_id, actor_name, action, field, after, source, at)
select ${q(contract.projectId)}, 'user', legal.id::text, 'Legal Demo', ${q(`review.clause_${decided.decision}`)}, ${q(finding.ruleName)}, ${j({ run: contract.runId, clause: finding.ruleName, reason: decided.reason ?? null })}, 'ui', now() - interval '90 minutes'
from ${LEGAL} where not exists (select 1 from public.card_events e where e.project_id = ${q(contract.projectId)} and e.action = ${q(`review.clause_${decided.decision}`)} and e.after->>'run' = ${q(contract.runId)});`);
    }
    return sql.join("\n");
}

const PLAYBOOK_ID = uuid("b100", 1);

async function main() {
    // A fixed clock: the tracked-change ids embed Date.now(), and the seed
    // must come out the same on every run.
    const fixed = Date.UTC(2026, 9, 20, 12);
    Date.now = () => fixed;
    const outDir = process.argv[2];
    if (!outDir) throw new Error("usage: generate.ts <out-dir>");
    const parts: string[] = [];
    for (const contract of CONTRACTS) parts.push(await build(contract, outDir));
    const header = `-- requires-table: public.contract_review_runs public.contract_fichas public.card_events public.document_edits public.watched_folders
-- Seed sintético da Revisão por playbook (PR #12) para a prévia. 100% fictício.
-- Gerado por backend/scripts/seed-revisao/generate.ts no branch feat/revisao-playbook:
-- não edite à mão, rode o gerador de novo. Depende do extra-inicio.sql (documentos
-- 00000000-0000-4000-d100-...1 e ...5) e dos arquivos .docx gerados juntos, que
-- precisam estar no storage em seed/revisao/<chave>-{original,revisado}.docx.
-- Idempotente: ids fixos, on conflict do nothing.

begin;

-- Playbook Avenia v1, do usuário legal (os cards do seed são pessoais).
insert into public.playbooks (id, user_id, visibility, name, description, content_json, created_at, updated_at)
select ${q(PLAYBOOK_ID)}, u.id, 'private', ${q(AVENIA_PLAYBOOK_NAME)}, ${q(AVENIA_PLAYBOOK_CONTENT.description)}, ${j(AVENIA_PLAYBOOK_CONTENT)}, now() - interval '1 day', now() - interval '1 day'
from public._seed_users u where u.role = 'legal'
on conflict (id) do nothing;
`;
    const body = parts;
    writeFileSync(path.join(outDir, "extra-revisao.sql"), `${header}\n${body.join("\n\n")}\n\ncommit;\n`);
    console.log(`wrote ${outDir}`);
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
