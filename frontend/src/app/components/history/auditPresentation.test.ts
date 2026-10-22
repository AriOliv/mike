import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@/app/lib/mikeApi";
import {
  auditAction,
  auditActor,
  auditDestination,
  auditDetailFields,
  auditSubject,
  auditSubjectEmail,
  auditSummary,
  auditTimestamp,
} from "./auditPresentation";

const event: AuditEvent = {
  id: "event",
  action: "org.member.role_changed",
  title: "jamie@example.com",
  status: "completed",
  created_at: "2026-10-14T02:42:00Z",
  user_display_name: "Alex Chen",
  user_email: "alex@example.com",
  surface: "organization",
  project_id: null,
  chat_id: null,
  document_id: null,
  review_id: null,
  model: null,
  detail: {
    previous_role: "member",
    role: "admin",
    target_user_id: "target-id",
  },
};

describe("audit event presentation", () => {
  it.each(["org.member.role_changed", "org.invite.created", "org.private_content.permission_changed"])("prefers the affected person's name for %s and retains the recorded email", (action) => {
    const named = { ...event, action, affected_user_display_name: " Jamie Morgan " };
    expect(auditSubject(named).name).toBe("Jamie Morgan");
    expect(auditSubjectEmail(named)).toBe("jamie@example.com");
    expect(auditSubject({ ...named, affected_user_display_name: " " }).name).toBe("jamie@example.com");
  });
  it("never replaces an affected document's title with a person's name", () => {
    const document = { ...event, action: "document.edited", title: "NDA.docx", affected_user_display_name: "Jamie Morgan" };
    expect(auditSubject(document).name).toBe("NDA.docx");
    expect(auditSubjectEmail(document)).toBeNull();
  });
  it("distinguishes the actor, affected member, and recorded role change", () => {
    expect(auditActor(event)).toBe("Alex Chen");
    expect(auditSubject(event)).toEqual({
      type: "Member",
      label: "Membro",
      name: "jamie@example.com",
      context: "Organização",
    });
    expect(auditDetailFields(event)).toEqual([
      { label: "Papel", value: "Membro → Admin" },
    ]);
    expect(auditSummary(event, false)).toBe(
      "Alex Chen mudou o papel de jamie@example.com na organização.",
    );
    expect(auditSummary(event, true)).toMatch(/^Você mudou/);
  });
  it("does not invent previous values or expose identifiers as names", () => {
    expect(auditDetailFields({ ...event, detail: { role: "admin" } })).toEqual([
      { label: "Papel", value: "Admin" },
    ]);
    expect(
      auditSubject({
        ...event,
        title: "00000000-0000-4000-8000-000000000001",
        detail: {},
      }).name,
    ).toBe("-");
    expect(auditSubject({ ...event, title: null, detail: null }).name).toBe(
      "-",
    );
    expect(
      auditDestination({ ...event, title: null, detail: null }),
    ).toBeNull();
  });
  it("presents invitation recipients and invited roles", () => {
    const invite = {
      ...event,
      action: "org.invite.created",
      detail: { role: "member" },
    };
    expect(auditAction(invite)).toBe("Convite enviado");
    expect(auditSubject(invite).type).toBe("Recipient");
    expect(auditSubject(invite).label).toBe("Destinatário");
    expect(auditDetailFields(invite)).toEqual([
      { label: "Papel do convite", value: "Membro" },
    ]);
  });
  it("uses recorded context without loading private project names", () => {
    expect(
      auditSubject({
        ...event,
        action: "document.uploaded",
        title: "NDA.docx",
        detail: { project_name: "Acquisition", organization_name: "Acme" },
      }),
    ).toEqual({
      type: "Document",
      label: "Documento",
      name: "NDA.docx",
      context: "Acme · Acquisition",
    });
  });
  it("keeps failed actions from reading as successful changes", () => {
    const failed = { ...event, action: "document.uploaded", status: "failed" };
    expect(auditAction(failed)).toBe("Envio de documento");
    expect(auditSummary(failed, false)).toBe("Envio de documento: falhou.");
    expect(auditSummary({ ...failed, status: "cancelled" }, false)).toBe(
      "Envio de documento: cancelada.",
    );
  });
  it("keeps zero counts and false values but leaves unknown metadata out of primary details", () => {
    expect(
      auditDetailFields({
        ...event,
        action: "org.router_models.updated",
        detail: { model_count: 0, secret_id: "id" },
      }),
    ).toEqual([{ label: "Modelos disponíveis", value: "0" }]);
    expect(
      auditDetailFields({
        ...event,
        action: "org.api_key.disabled",
        detail: { enabled: false },
      }),
    ).toEqual([{ label: "Ativada", value: "Não" }]);
  });
  it("does not send Word chat ids to web chat routes", () => {
    expect(
      auditDestination({ ...event, surface: "word", chat_id: "word-chat" }),
    ).toBeNull();
    expect(
      auditDestination({
        ...event,
        surface: "project",
        project_id: "p",
        chat_id: "c",
      })?.href,
    ).toBe("/projects/p/assistant/chat/c");
  });
  it("handles missing identities and provides an exact timestamp with seconds and timezone", () => {
    expect(auditActor({ ...event, user_display_name: null })).toBe(
      "alex@example.com",
    );
    expect(
      auditActor({ ...event, user_display_name: null, user_email: null }),
    ).toBe("Pessoa desconhecida");
    expect(auditTimestamp(event.created_at, true)).toBe(
      new Date(event.created_at).toLocaleString("pt-BR", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      }),
    );
  });
});
