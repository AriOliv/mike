import type { AuditEvent, OrgPrivateContentKind } from "@/app/lib/mikeApi";

export interface AuditPrivateAccess {
  kind: OrgPrivateContentKind;
  item_id: string;
  has_access: boolean;
}

/** Only organization audit responses contain this server-derived descriptor. */
export function auditPrivateAccess(
  event: AuditEvent,
): AuditPrivateAccess | null {
  const value = event.detail?.private_content_access;
  if (!event.org_id || !value || typeof value !== "object") return null;
  const access = value as Record<string, unknown>;
  if (
    !["project", "workflow", "chat", "tabular_review", "document"].includes(
      String(access.kind),
    ) ||
    typeof access.item_id !== "string" ||
    !access.item_id ||
    typeof access.has_access !== "boolean"
  )
    return null;
  return access as unknown as AuditPrivateAccess;
}

export const ACTION_LABELS: Record<string, string> = {
  "org.private_content.permission_changed":
    "Permissão de conteúdo privado alterada",
  "org.private_content.opened": "Conteúdo privado acessado",
  "org.private_content.closed": "Acesso a conteúdo privado encerrado",
  "org.api_key.saved": "Chave de provedor salva",
  "org.api_key.removed": "Chave de provedor removida",
  "org.api_key.enabled": "Chave de provedor ativada",
  "org.api_key.disabled": "Chave de provedor desativada",
  "org.personal_api_keys.allowed": "Chaves pessoais permitidas",
  "org.personal_api_keys.blocked": "Chaves pessoais bloqueadas",
  "org.created": "Organização criada",
  "org.deleted": "Organização excluída",
  "org.restored": "Organização restaurada",
  "org.purged": "Organização excluída de vez",
  "org.invite.created": "Convite enviado",
  "org.invite.accepted": "Convite aceito",
  "org.invite.declined": "Convite recusado",
  "org.invite.cancelled": "Convite cancelado",
  "org.invite.resent": "Convite reenviado",
  "org.member.role_changed": "Papel de membro alterado",
  "org.logo.updated": "Logo atualizado",
  "org.logo.removed": "Logo removido",
  "org.router_models.updated": "Modelos atualizados",
  "org.departure.item.transferred": "Trabalho de quem saiu transferido",
  "org.departure.item.archived": "Trabalho de quem saiu arquivado",
  "org.departure.item.recovered": "Trabalho de quem saiu recuperado",
  "org.departure.item.deleted": "Trabalho de quem saiu excluído",
  "org.departure.item.expired": "Trabalho de quem saiu expirado",
  "org.departure.member.departed": "Membro saiu",
  "org.member.removed": "Membro removido",
  "org.member.left": "Membro deixou a organização",
  "org.data.deleted": "Dados da organização excluídos",
  "chat.message": "Mensagem enviada",
  "document.uploaded": "Documento enviado",
  "document.generated": "Documento gerado",
  "document.edited": "Documento editado",
  "workflow.applied": "Workflow aplicado",
  "tabular.created": "Revisão criada",
  "tabular.generated": "Revisão concluída",
  "export.chats": "Conversas exportadas",
  "export.account": "Dados da conta exportados",
  "export.tabular": "Revisão exportada",
  "export.memory": "Memória exportada",
};

export const SURFACE_LABELS: Record<string, string> = {
  assistant: "Assistente",
  project: "Projeto",
  word: "Word",
  tabular: "Tabela",
  workflows: "Workflows",
  account: "Conta",
  organization: "Organização",
};

export function auditLabel(value: string): string {
  return value
    .replace(/[_.]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function auditAction(event: AuditEvent): string {
  const label = ACTION_LABELS[event.action] ?? auditLabel(event.action);
  // Failed or cancelled operations must not read as successful changes.
  if (event.status === "completed") return label;
  const operations: Record<string, string> = {
    "chat.message": "Envio de mensagem",
    "document.uploaded": "Envio de documento",
    "document.generated": "Geração de documento",
    "document.edited": "Edição de documento",
    "workflow.applied": "Aplicação de workflow",
    "tabular.created": "Criação de revisão",
    "tabular.generated": "Execução de revisão",
    "export.chats": "Exportação de conversas",
    "export.account": "Exportação da conta",
    "export.tabular": "Exportação de revisão",
    "export.memory": "Exportação de memória",
  };
  return operations[event.action] ?? label;
}

function detailText(event: AuditEvent, key: string): string | null {
  const value = event.detail?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Shown as the actor of events the system did on its own. */
export const SYSTEM_ACTOR = "Sistema";

export function auditActor(event: AuditEvent): string {
  return (
    event.user_display_name ||
    event.user_email ||
    (event.action === "org.purged" ||
    event.action === "org.departure.item.expired"
      ? SYSTEM_ACTOR
      : "Pessoa desconhecida")
  );
}

// `type` is the subject's kind, which the icons and checks compare;
// `label` is how it reads on screen.
const SUBJECT_TYPE_LABELS: Record<string, string> = {
  Item: "Item",
  Recipient: "Destinatário",
  Member: "Membro",
  Provider: "Provedor",
  Organization: "Organização",
  Document: "Documento",
  Chat: "Conversa",
  Workflow: "Workflow",
  Review: "Revisão",
  Chats: "Conversas",
  Account: "Conta",
  Memory: "Memória",
  Project: "Projeto",
  "Tabular Review": "Revisão",
};

export function auditSubject(event: AuditEvent) {
  const action = event.action;
  let type = "Item";
  if (action.startsWith("org.invite.")) type = "Recipient";
  else if (action === "org.private_content.permission_changed") type = "Member";
  else if (action.startsWith("org.private_content."))
    type = auditLabel(detailText(event, "kind") ?? "item");
  else if (
    action.startsWith("org.member.") ||
    action === "org.departure.member.departed"
  )
    type = "Member";
  else if (
    action.startsWith("org.api_key.") ||
    action === "org.router_models.updated"
  )
    type = "Provider";
  else if (action.startsWith("org.departure.item."))
    type = auditLabel(detailText(event, "kind") ?? "item");
  else if (action.startsWith("org.")) type = "Organization";
  else if (action.startsWith("document.")) type = "Document";
  else if (action.startsWith("chat.")) type = "Chat";
  else if (action.startsWith("workflow.")) type = "Workflow";
  else if (action.startsWith("tabular.") || action === "export.tabular")
    type = "Review";
  else if (action === "export.chats") type = "Chats";
  else if (action === "export.account") type = "Account";
  else if (action === "export.memory") type = "Memory";

  const title = event.title?.trim();
  // Some older member events stored a UUID in title. Keep identifiers in
  // technical details, not where a person's name or email is expected.
  const isId =
    title && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(title);
  const recordedName =
    title && !isId
      ? title
      : (detailText(event, "target_email") ??
        (type === "Provider" ? detailText(event, "provider") : null));
  const name = ["Member", "Recipient"].includes(type)
    ? event.affected_user_display_name?.trim() || recordedName
    : recordedName;
  const context = [
    detailText(event, "organization_name") ?? detailText(event, "org_name"),
    detailText(event, "project_name"),
  ].filter((value): value is string => Boolean(value));
  if (!context.length && event.surface)
    context.push(SURFACE_LABELS[event.surface] ?? auditLabel(event.surface));
  return {
    type,
    label: SUBJECT_TYPE_LABELS[type] ?? type,
    name: name ?? "-",
    context: [...new Set(context)].join(" · "),
  };
}

/** Retain the recorded email for identity tooltips and stable monogram colors. */
export function auditSubjectEmail(event: AuditEvent): string | null {
  if (!["Member", "Recipient"].includes(auditSubject(event).type)) return null;
  const email = (detailText(event, "target_email") ?? event.title)?.trim();
  return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
}

export function auditTimestamp(value: string, exact = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data indisponível";
  return date.toLocaleString("pt-BR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(exact ? ({ second: "2-digit", timeZoneName: "short" } as const) : {}),
  });
}

export type AuditDetailField = { label: string; value: string };

export function auditDetailFields(event: AuditEvent): AuditDetailField[] {
  const fields: AuditDetailField[] = [];
  const detail = event.detail ?? {};
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim())
      fields.push({ label, value });
    else if (typeof value === "number" && Number.isFinite(value))
      fields.push({ label, value: String(value) });
    else if (typeof value === "boolean")
      fields.push({ label, value: value ? "Sim" : "Não" });
  };
  const role = detailText(event, "role");
  const previous = detailText(event, "previous_role");
  if (event.action === "org.member.role_changed") {
    if (previous && role)
      add(
        event.status === "completed" ? "Papel" : "Mudança de papel pedida",
        `${auditRoleLabel(previous)} → ${auditRoleLabel(role)}`,
      );
    else if (role) add("Papel", auditRoleLabel(role));
    else if (previous) add("Papel anterior", auditRoleLabel(previous));
  } else if (event.action.startsWith("org.invite.") && role)
    add("Papel do convite", auditRoleLabel(role));
  else if (previous) add("Papel anterior", auditRoleLabel(previous));
  if (
    event.action.startsWith("org.departure.") ||
    event.action.startsWith("org.member.")
  ) {
    add("Itens transferidos", detail.transferred);
    add("Itens arquivados", detail.archived);
  }
  if (event.action === "org.router_models.updated")
    add("Modelos disponíveis", detail.model_count);
  if (
    event.action.startsWith("org.api_key.") ||
    event.action === "org.private_content.permission_changed"
  )
    add("Ativada", detail.enabled);
  if (event.action === "org.private_content.opened") add("Acesso", "Só leitura");
  const purgeAfter = detailText(event, "purge_after");
  if (purgeAfter && !Number.isNaN(new Date(purgeAfter).getTime()))
    add("Exclusão agendada", auditTimestamp(purgeAfter, true));
  if (event.action.startsWith("export.")) {
    add("Formato", detail.format);
    add("Documentos exportados", detail.document_count);
    add("Conversas exportadas", detail.chat_count);
  }
  return fields;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Titular",
  admin: "Admin",
  member: "Membro",
};

function auditRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? auditLabel(role);
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Concluído",
  cancelled: "Cancelado",
  failed: "Falhou",
};

export function auditStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? auditLabel(status);
}

export function auditSummary(event: AuditEvent, personal: boolean): string {
  const actor = personal ? "Você" : auditActor(event);
  const subject = auditSubject(event);
  if (event.status !== "completed")
    return `${auditAction(event)}: ${event.status === "failed" ? "falhou" : event.status === "cancelled" ? "cancelada" : auditStatusLabel(event.status).toLowerCase()}.`;
  const name =
    subject.name === "-" ? subject.label.toLowerCase() : subject.name;
  if (event.action === "org.member.role_changed")
    return `${actor} mudou o papel de ${name} na organização.`;
  if (
    event.action === "org.invite.created" ||
    event.action === "org.invite.resent"
  )
    return `${actor} ${event.action.endsWith("resent") ? "reenviou o convite para" : "convidou"} ${name}.`;
  if (event.action === "document.uploaded") return `${actor} enviou ${name}.`;
  if (event.action === "document.edited") return `${actor} editou ${name}.`;
  if (event.action === "document.generated")
    return `${actor} gerou ${name}.`;
  return `${auditAction(event)} · por ${personal ? "você" : actor}`;
}

export function auditDestination(
  event: AuditEvent,
): { href: string; label: string } | null {
  if (event.review_id)
    return {
      href: `/tabular-reviews/${encodeURIComponent(event.review_id)}`,
      label: "Abrir revisão",
    };
  if (event.chat_id && event.surface !== "word")
    return {
      href: event.project_id
        ? `/projects/${encodeURIComponent(event.project_id)}/assistant/chat/${encodeURIComponent(event.chat_id)}`
        : `/assistant/chat/${encodeURIComponent(event.chat_id)}`,
      label: "Abrir conversa",
    };
  if (event.project_id)
    return {
      href: `/projects/${encodeURIComponent(event.project_id)}`,
      label: "Abrir projeto",
    };
  const access = auditPrivateAccess(event);
  if (access && ["project", "chat", "tabular_review"].includes(access.kind)) {
    const target = {
      project: { path: "/projects/", label: "Abrir projeto" },
      chat: { path: "/assistant/chat/", label: "Abrir conversa" },
      tabular_review: { path: "/tabular-reviews/", label: "Abrir revisão" },
    }[access.kind as "project" | "chat" | "tabular_review"];
    return {
      href: `${target.path}${encodeURIComponent(access.item_id)}`,
      label: target.label,
    };
  }
  return null;
}
