"use client";

import { ProfilePhotoSettings } from "@/app/components/settings/ProfilePhotoSettings";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { Modal } from "@/app/components/modals/Modal";
import { FieldLabel } from "@/app/components/ui/form-field";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  MfaVerificationPopup,
  needsMfaVerification,
} from "@/app/components/popups/MfaVerificationPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { deleteAccount, isMfaRequiredError } from "@/app/lib/mikeApi";
import { authMessages } from "@/app/lib/authMessages";
import {
  describeError,
  notifyError,
} from "@/app/lib/userFacingError";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

interface EmailWarning {
  title: string;
  message: string;
}

/** Keyed by the `code` GoTrue returns from `PATCH /api/auth/email`. */
// One auth message source (authMessages.ts); only the email-field wording
// differs here, because a validation failure on this screen can only mean
// the address itself.
const EMAIL_ERROR_MESSAGES = authMessages({
  validation_failed: "Digite um endereço de e-mail válido.",
  invalid_request: "Digite um endereço de e-mail válido.",
  reauthentication_needed: "Entre de novo antes de trocar seu e-mail.",
});

const EMAIL_TAKEN_CODES = new Set(["email_exists", "user_already_exists"]);
const EMAIL_RATE_LIMIT_CODES = new Set([
  "over_email_send_rate_limit",
  "over_request_rate_limit",
]);

// The backend stores the plan name in English ("Free" by default).
const TIER_LABELS: Record<string, string> = { free: "Gratuito" };

function tierLabel(tier: string | undefined): string {
  const name = tier || "Free";
  return TIER_LABELS[name.toLowerCase()] ?? name;
}

/** Composes authenticated account settings, including profile-photo editing and account security controls. */
export default function SettingsPage() {
  const router = useRouter();
  const { user, signOut, updateEmail } = useAuth();
  const { profile, updateDisplayName } = useUserProfile();
  const [displayName, setDisplayName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const [saved, setSaved] = useState(false);
  const [email, setEmail] = useState("");
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<EmailWarning | null>(null);
  const [emailMfaOpen, setEmailMfaOpen] = useState(false);
  const [googleEmailModalOpen, setGoogleEmailModalOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [accountDeleteMfaOpen, setAccountDeleteMfaOpen] = useState(false);
  const requiresPasswordForEmailChange =
    user?.createdWithGoogle === true && profile?.passwordSet !== true;

  // Sync a profile that loads after mount, even while the name input is focused.
  // Otherwise an empty blur-autosave could overwrite the stored name.
  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
  }, [profile?.displayName]);

  useEffect(() => {
    if (user?.email) {
      setEmail(user.pendingEmail || user.email);
    }
  }, [user?.email, user?.pendingEmail]);

  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("emailChange") !==
        "processed" ||
      !user
    ) {
      return;
    }
    setEmailStatus(
      user.pendingEmail
        ? "Uma das confirmações foi aceita. Confirme a troca nos dois endereços, o atual e o novo, para concluir."
        : "E-mail atualizado.",
    );
    window.history.replaceState({}, "", "/settings");
  }, [user]);

  const handleDeleteAccount = async () => {
    devLog("[account/mfa] delete account requested");
    setIsDeleting(true);
    try {
      if (await needsMfaVerification()) {
        setDeleteConfirm(false);
        setAccountDeleteMfaOpen(true);
        setIsDeleting(false);
        return;
      }
      await deleteAccount();
      await signOut();
      router.push("/");
    } catch (error) {
      setIsDeleting(false);
      devLog("[account/mfa] delete account failed", {
        isMfaRequired: isMfaRequiredError(error),
        error,
      });
      if (isMfaRequiredError(error)) {
        setDeleteConfirm(false);
        setAccountDeleteMfaOpen(true);
        return;
      }
      setDeleteConfirm(false);
      notifyError(error, {
        action: "excluir sua conta",
        lang: "pt",
        // Retry re-opens the confirmation instead of deleting outright: a
        // button in a notice must never be the only thing between a stray
        // click and an irreversible account deletion.
        onRetry: () => setDeleteConfirm(true),
        supportNote: "Falha ao excluir a conta.",
      });
    }
  };

  const handleSaveEmail = async () => {
    if (requiresPasswordForEmailChange) {
      setGoogleEmailModalOpen(true);
      return;
    }
    const nextEmail = email.trim();
    if (!nextEmail || nextEmail === user?.email) return;

    devLog("[account/mfa] save email requested");
    setIsSavingEmail(true);
    setEmailStatus(null);
    setEmailWarning(null);
    try {
      if (await needsMfaVerification()) {
        setEmailMfaOpen(true);
        return;
      }

      const updatedUser = await updateEmail(nextEmail);
      const pendingEmail = updatedUser.pendingEmail;
      setEmail(pendingEmail || updatedUser.email);
      setEmailSaved(true);
      setEmailStatus(
        pendingEmail
          ? `Enviamos uma confirmação para o seu endereço atual e para ${pendingEmail}. Confirme as duas mensagens para concluir a troca. Até lá, seu e-mail continua ${updatedUser.email}.`
          : "E-mail atualizado.",
      );
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (error: unknown) {
      devLog("[account/mfa] save email failed", { error });
      // The backend passes GoTrue's `code` through, so the outcome is decided
      // by that code rather than by matching English in the message.
      const described = describeError(error, {
        action: "atualizar seu e-mail",
        lang: "pt",
        codeMessages: EMAIL_ERROR_MESSAGES,
        fallback: "Não consegui atualizar seu e-mail. Tente de novo.",
      });

      if (described.code && EMAIL_TAKEN_CODES.has(described.code)) {
        setEmail(user?.pendingEmail || user?.email || "");
        setEmailWarning({
          title: "E-mail já cadastrado",
          message: "Já existe uma conta com este e-mail.",
        });
        return;
      }

      if (
        (described.code && EMAIL_RATE_LIMIT_CODES.has(described.code)) ||
        described.kind === "rate_limited"
      ) {
        setEmail(user?.pendingEmail || user?.email || "");
        setEmailWarning({
          title: "Troca de e-mail indisponível",
          message:
            "Não dá para trocar de e-mail com tanta frequência. Espere alguns minutos e tente de novo.",
        });
        return;
      }

      setEmailStatus(described.message);
    } finally {
      setIsSavingEmail(false);
    }
  };

  const handleSaveDisplayName = async () => {
    const nextName = displayName.trim();
    if (nextName === (profile?.displayName ?? "")) return;
    setIsSavingName(true);
    const success = await updateDisplayName(nextName);
    setIsSavingName(false);

    // A failure is reported once, by the profile context's notice (message,
    // Retry, support); the field shows no second status for it.
    if (success) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!user) return null;

  return (
    <div className="space-y-8">
      {/* Profile Settings */}
      <section className="space-y-3">
        <SettingsHeading>Perfil</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div>
              <div className="flex items-start justify-between gap-3">
                <FieldLabel htmlFor="display-name">Nome de exibição</FieldLabel>
                <span
                  className="text-xs text-gray-400"
                  aria-live="polite"
                >
                  {isSavingName
                    ? "Salvando..."
                    : saved
                      ? "Salvo"
                      : ""}
                </span>
              </div>
              <SettingsTextInput
                id="display-name"
                type="text"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setSaved(false);
                }}
                onBlur={() => void handleSaveDisplayName()}
                placeholder="Digite seu nome"
              />
            </div>
          </SettingsRow>
          <ProfilePhotoSettings />
        </GlassCardUI>
      </section>

      {/* Email */}
      <section className="space-y-3">
        <SettingsHeading>E-mail</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <div className="space-y-2">
              <SettingsTextInput
                aria-label="Endereço de e-mail"
                type="email"
                value={email}
                disabled={requiresPasswordForEmailChange}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailStatus(null);
                  setEmailWarning(null);
                  setEmailSaved(false);
                }}
                placeholder="Digite seu e-mail"
              />
              {emailStatus ? (
                <p className="text-xs text-gray-500">{emailStatus}</p>
              ) : user.pendingEmail ? (
                <p className="text-xs text-gray-500">
                  Aguardando confirmação: {user.pendingEmail}
                </p>
              ) : null}
              {emailStatus && (
                <p className="text-xs text-gray-400">
                  E-mail atual: {user.email}
                </p>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveEmail}
                  disabled={
                    isSavingEmail ||
                    (!requiresPasswordForEmailChange &&
                      (!email.trim() ||
                        email.trim() === user.email ||
                        email.trim() === user.pendingEmail ||
                        emailSaved))
                  }
                  className="text-xs font-medium text-gray-700 transition-colors hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                >
                  {requiresPasswordForEmailChange
                    ? "Alterar"
                    : isSavingEmail
                      ? "Salvando..."
                      : emailSaved
                        ? "Salvo"
                        : "Salvar"}
                </button>
              </div>
            </div>
          </SettingsRow>
        </GlassCardUI>
      </section>

      {/* Plan */}
      <section className="space-y-3">
        <SettingsHeading>Plano</SettingsHeading>
        <GlassCardUI>
          <SettingsRow layout="stacked">
            <p className="text-base font-medium text-gray-500 capitalize">
              {tierLabel(profile?.tier)}
            </p>
          </SettingsRow>
        </GlassCardUI>
      </section>

      {/* Danger Zone */}
      <section className="space-y-3">
        <SettingsHeading tone="danger">Zona de perigo</SettingsHeading>
        <GlassCardUI>
          <SettingsRow>
            <div className="min-w-0 space-y-1">
              <SettingsLabel>Excluir conta</SettingsLabel>
              <SettingsDescription>
                Exclui de vez sua conta e seu espaço pessoal. O trabalho nas organizações segue a regra de remoção de membros.
              </SettingsDescription>
            </div>
            <PillButtonUI
              tone="danger"
              size="sm"
              onClick={() => setDeleteConfirm(true)}
              disabled={isDeleting}
              loading={isDeleting}
              className="w-full shrink-0 sm:w-auto"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Excluir conta
            </PillButtonUI>
          </SettingsRow>
        </GlassCardUI>
      </section>
      <ConfirmPopup
        open={deleteConfirm}
        title="Excluir conta?"
        message="Isso exclui de vez sua conta e seu espaço pessoal. Em cada organização, o trabalho compartilhado que não tem outro titular passa para um titular que continua na organização. O trabalho privado não compartilhado fica guardado por 30 dias, para os titulares da organização recuperarem ou excluírem. Antes, nomeie outro titular ou exclua cada organização em que só você é titular."
        confirmLabel="Excluir"
        confirmVariant="danger"
        confirmStatus={isDeleting ? "loading" : "idle"}
        cancelLabel="Cancelar"
        onCancel={() => {
          if (isDeleting) return;
          setDeleteConfirm(false);
        }}
        onConfirm={() => void handleDeleteAccount()}
      />
      <WarningPopup
        open={!!emailWarning}
        title={emailWarning?.title}
        message={emailWarning?.message}
        onClose={() => setEmailWarning(null)}
      />
      <Modal
        open={googleEmailModalOpen}
        onClose={() => setGoogleEmailModalOpen(false)}
        breadcrumbs={["Conta", "Trocar e-mail"]}
        size="sm"
        className="h-auto"
        primaryAction={{
          label: "Ir para Segurança",
          onClick: () => {
            setGoogleEmailModalOpen(false);
            router.push("/settings/security");
          },
        }}
      >
        <p className="pb-5 text-sm leading-relaxed text-gray-600">
          Sua conta foi criada com o Google. Para trocar o e-mail, primeiro crie
          uma senha em Configurações &gt; Segurança &gt; Senha.
        </p>
      </Modal>
      <MfaVerificationPopup
        open={accountDeleteMfaOpen}
        onCancel={() => setAccountDeleteMfaOpen(false)}
        onVerified={() => {
          devLog("[account/mfa] account delete verification callback");
          setAccountDeleteMfaOpen(false);
          void handleDeleteAccount();
        }}
        title="Verificação em duas etapas"
        message="Excluir a conta é uma ação sensível. Digite um código do seu app autenticador para continuar."
      />
      <MfaVerificationPopup
        open={emailMfaOpen}
        onCancel={() => setEmailMfaOpen(false)}
        onVerified={() => {
          devLog("[account/mfa] email verification callback");
          setEmailMfaOpen(false);
          void handleSaveEmail();
        }}
        title="Verificação em duas etapas"
        message="Trocar o e-mail é uma ação sensível. Digite um código do seu app autenticador para continuar."
      />
    </div>
  );
}
