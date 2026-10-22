import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocument,
  openOrgPrivateContent,
  closeOrgPrivateContent,
  getWorkflow,
  MikeApiError,
  type AuditEvent,
} from "@/app/lib/mikeApi";
import type { PanelDocument } from "@/app/components/shared/types";
import { HistoryEventModal } from "./HistoryEventModal";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  getDocument: vi.fn(),
  openOrgPrivateContent: vi.fn(),
  closeOrgPrivateContent: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock("@/app/components/shared/DocumentContent", () => ({
  DocumentContent: ({
    document,
    canEdit,
  }: {
    document: PanelDocument;
    canEdit: boolean;
  }) => (
    <div data-testid="document-preview" data-editable={canEdit}>
      {document.title}
    </div>
  ),
}));

const event: AuditEvent = {
  id: "event-id",
  action: "org.member.role_changed",
  title: "jamie@example.com",
  status: "completed",
  created_at: "2026-10-14T02:42:00Z",
  user_display_name: "Alex Chen",
  user_email: "alex@example.com",
  user_profile_photo: "data:image/png;base64,cGhvdG8=",
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
    custom: { enabled: false },
  },
};
const documentEvent = {
  ...event,
  action: "document.edited",
  title: "NDA.docx",
  document_id: "document-id",
  detail: null,
};

const file = {
  id: "document-id",
  filename: "Private NDA.docx",
  file_type: "docx",
  project_id: null,
  storage_path: null,
  pdf_storage_path: null,
  size_bytes: 100,
  page_count: 1,
  structure_tree: null,
  status: "ready" as const,
  created_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(openOrgPrivateContent).mockResolvedValue(undefined);
  vi.mocked(closeOrgPrivateContent).mockResolvedValue(undefined);
});

describe("HistoryEventModal", () => {
  it("leads with the action, identifies actor and affected member, and collapses metadata", async () => {
    const user = userEvent.setup();
    render(
      <HistoryEventModal
        title="Registro de auditoria"
        event={event}
        personal={false}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Papel de membro alterado" }),
    ).toBeVisible();
    expect(screen.getByText("Membro → Admin")).toBeVisible();
    expect(screen.getByText("Feito por")).toBeVisible();
    expect(screen.getByText("Alex Chen (alex@example.com)")).toBeVisible();
    const modal = within(screen.getByRole("dialog"));
    expect(
      modal.getByRole("img", { name: "Alex Chen" }).querySelector("img"),
    ).toHaveAttribute("src", event.user_profile_photo);
    expect(
      modal.getByRole("img", { name: "jamie@example.com" }),
    ).toHaveTextContent("J");
    expect(
      modal
        .getAllByText("jamie@example.com")
        .some((el) => el.closest("td") && !el.closest("details")),
    ).toBe(true);
    expect(screen.queryByText("Modelo", { exact: true })).toBeNull();
    const metadata = screen.getByText(/"target_user_id": "target-id"/);
    expect(metadata).not.toBeVisible();
    await user.click(screen.getByText("Detalhes técnicos"));
    expect(metadata).toBeVisible();
    expect(metadata).toHaveTextContent('"enabled": false');
  });
  it("uses You in personal details without repeating account identity", () => {
    render(
      <HistoryEventModal
        title="Minha atividade"
        event={event}
        personal
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Você mudou o papel de jamie@example.com na organização.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Feito por")).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Alex Chen" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("alex@example.com")).toBeNull();
  });
  it("does not offer links for an event whose content was redacted", () => {
    render(
      <HistoryEventModal
        title="Registro de auditoria"
        event={{
          ...documentEvent,
          title: null,
          document_id: null,
          detail: null,
        }}
        personal={false}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("-", { exact: true })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Abrir documento" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("loads documents only on demand, uses the shared read-only viewer, and returns to details", async () => {
    const user = userEvent.setup();
    vi.mocked(getDocument).mockResolvedValue({
      ...file,
      filename: "Current NDA.docx",
    });
    render(
      <HistoryEventModal
        title="Minha atividade"
        event={{ ...documentEvent, project_id: "project-id" }}
        personal
        onClose={vi.fn()}
      />,
    );
    expect(getDocument).not.toHaveBeenCalled();
    const openDocument = screen.getByRole("button", { name: "Abrir documento" });
    const openProject = screen.getByRole("link", { name: "Abrir projeto" });
    expect(openDocument.closest("footer")).not.toBeNull();
    expect(openProject.closest("footer")).not.toBeNull();
    expect(openDocument).toHaveClass("rounded-full");
    expect(openProject).toHaveClass("rounded-full");
    expect(openProject).toHaveAttribute("href", "/projects/project-id");
    await user.click(openDocument);
    expect(await screen.findByTestId("document-preview")).toHaveAttribute(
      "data-editable",
      "false",
    );
    expect(getDocument).toHaveBeenCalledWith("document-id");
    const back = screen.getByRole("button", { name: "Voltar" });
    expect(back.closest("footer")).not.toBeNull();
    expect(back).toHaveClass("rounded-full");
    await user.click(back);
    expect(
      screen.getByRole("heading", { name: "Documento editado" }),
    ).toBeVisible();
  });
  it.each([403, 404, 500])(
    "handles unavailable documents (%s) without exposing internal errors",
    async (status) => {
      const user = userEvent.setup();
      vi.mocked(getDocument)
        .mockRejectedValueOnce(
          new MikeApiError({ status, message: "database secret stack trace" }),
        )
        .mockResolvedValueOnce({
          ...file,
          filename: "Current NDA.docx",
        });
      render(
        <HistoryEventModal
          title="Minha atividade"
          event={documentEvent}
          personal
          initialPreview
          onClose={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          status === 500
            ? "Não consegui abrir este documento"
            : status === 403
              ? "Você não tem acesso a este documento."
              : "Este documento não está mais disponível.",
        ),
      );
      expect(screen.queryByText(/database secret/)).toBeNull();
      const retry = screen.getByRole("button", { name: "Tentar de novo" });
      expect(retry.closest("footer")).not.toBeNull();
      expect(retry).toHaveClass("rounded-full");
      await user.click(retry);
      expect(await screen.findByTestId("document-preview")).toBeVisible();
    },
  );
});

const privateEvent: AuditEvent = {
  ...documentEvent,
  org_id: "org-id",
  detail: {
    private_content_access: {
      kind: "document",
      item_id: "document-id",
      has_access: false,
    },
  },
};

describe("private content from audit events", () => {
  it("opens only on demand, logs before fetching, and lets the owner end access", async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    let grant!: () => void;
    vi.mocked(openOrgPrivateContent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          grant = resolve;
        }),
    );
    vi.mocked(getDocument).mockResolvedValue({
      ...file,
      filename: "Private NDA",
    });
    render(
      <HistoryEventModal
        title="Registro de auditoria"
        event={privateEvent}
        personal={false}
        onClose={vi.fn()}
        onAccessChange={changed}
      />,
    );
    expect(openOrgPrivateContent).not.toHaveBeenCalled();
    expect(getDocument).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Abrir documento" }));
    expect(openOrgPrivateContent).toHaveBeenCalledWith(
      "org-id",
      "document",
      "document-id",
    );
    expect(getDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Abrindo…" })).toBeDisabled();
    grant();
    expect(await screen.findByTestId("document-preview")).toHaveAttribute(
      "data-editable",
      "false",
    );
    expect(changed).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.click(screen.getByRole("button", { name: "Encerrar acesso" }));
    expect(closeOrgPrivateContent).toHaveBeenCalledWith(
      "org-id",
      "document",
      "document-id",
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Encerrar acesso" })).toBeNull(),
    );
    expect(changed).toHaveBeenCalledWith(false);
  });

  it("does not fetch or navigate if privileged opening is refused", async () => {
    const user = userEvent.setup();
    vi.mocked(openOrgPrivateContent).mockRejectedValueOnce(
      new MikeApiError({ status: 403, message: "private database detail" }),
    );
    render(
      <HistoryEventModal
        title="Registro de auditoria"
        event={privateEvent}
        personal={false}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Abrir documento" }));
    expect(await screen.findByText("Acesso indisponível")).toBeVisible();
    expect(screen.queryByText(/private database detail/)).toBeNull();
    expect(getDocument).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each([
    ["project", "Abrir projeto", "/projects/private-id"],
    ["chat", "Abrir conversa", "/assistant/chat/private-id"],
    ["tabular_review", "Abrir revisão", "/tabular-reviews/private-id"],
    ["workflow", "Abrir workflow", "/workflows/assistant/private-id"],
  ])(
    "opens a private %s from an access event using a logged footer button",
    async (kind, label, href) => {
      const user = userEvent.setup();
      vi.mocked(getWorkflow).mockResolvedValue({
        id: "private-id",
        metadata: { type: "assistant" },
      } as never);
      render(
        <HistoryEventModal
          title="Registro de auditoria"
          personal={false}
          onClose={vi.fn()}
          event={{
            ...event,
            org_id: "org-id",
            action: "org.private_content.opened",
            detail: {
              kind,
              item_id: "private-id",
              private_content_access: {
                kind,
                item_id: "private-id",
                has_access: true,
              },
            },
          }}
        />,
      );
      const button = screen.getByRole("button", { name: label });
      expect(button.closest("footer")).not.toBeNull();
      expect(button).toHaveClass("rounded-full");
      expect(screen.queryByRole("link")).toBeNull();
      expect(openOrgPrivateContent).not.toHaveBeenCalled();
      await user.click(button);
      await waitFor(() => expect(navigation.push).toHaveBeenCalledWith(href));
      expect(openOrgPrivateContent).toHaveBeenCalledWith(
        "org-id",
        kind,
        "private-id",
      );
      expect(
        vi.mocked(openOrgPrivateContent).mock.invocationCallOrder[0],
      ).toBeLessThan(navigation.push.mock.invocationCallOrder[0]);
    },
  );

  it("does not navigate after the modal closes during opening", async () => {
    const user = userEvent.setup();
    let grant!: () => void;
    vi.mocked(openOrgPrivateContent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          grant = resolve;
        }),
    );
    const { unmount } = render(
      <HistoryEventModal
        title="Registro de auditoria"
        personal={false}
        onClose={vi.fn()}
        event={{
          ...privateEvent,
          document_id: null,
          project_id: "project-id",
          detail: {
            private_content_access: {
              kind: "project",
              item_id: "project-id",
              has_access: false,
            },
          },
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    unmount();
    grant();
    await Promise.resolve();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("never uses privileged opening in personal activity", async () => {
    const user = userEvent.setup();
    render(
      <HistoryEventModal
        title="Minha atividade"
        event={privateEvent}
        personal
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Abrir documento" }));
    await screen.findByTestId("document-preview");
    expect(openOrgPrivateContent).not.toHaveBeenCalled();
  });
});
