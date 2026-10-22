"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import {
    SettingsShell,
    type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";

const TABS: SettingsShellTab[] = [
    { id: "account", label: "Conta", href: "/settings" },
    {
        id: "personalisation",
        label: "Personalização",
        href: "/settings/personalisation",
    },
    { id: "memory", label: "Memória", href: "/settings/memory" },
    { id: "appearance", label: "Aparência", href: "/settings/appearance" },
    { id: "features", label: "Recursos", href: "/settings/features" },
    {
        id: "privacy-data",
        label: "Privacidade e dados",
        href: "/settings/privacy-data",
    },
    {
        id: "my-activity",
        label: "Minha atividade",
        href: "/settings/my-activity",
    },
    { id: "security", label: "Segurança", href: "/settings/security" },
    { id: "models", label: "Preferências de modelo", href: "/settings/models" },
    {
        id: "byok",
        label: "Chaves próprias (BYOK)",
        href: "/settings/byok",
    },
    { id: "connectors", label: "Conectores", href: "/settings/connectors" },
    // Personal tokens for Claude Code, Codex and other agents (MCP, doc 09).
    {
        id: "agent-tokens",
        label: "Tokens para agentes",
        href: "/settings/agent-tokens",
    },
    // The organizations the person belongs to, and their invitations. Each
    // organization's own settings are a separate area, opened from here or
    // from the account menu.
    {
        id: "organizations",
        label: "Organizações",
        href: "/settings/organizations",
    },
];

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { user, isAuthenticated, authLoading } = useAuth();
    const invitationCount = useOrganizationInvitationCount(
        isAuthenticated && !authLoading ? user?.id : undefined,
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    // Minha atividade is linked from Settings but uses the full table-page layout.
    if (pathname === "/settings/my-activity") {
        return children;
    }

    return (
        <SettingsShell
            title="Configurações"
            navLabel="Configurações"
            tabs={TABS.map((tab) =>
                tab.id === "organizations" && invitationCount > 0
                    ? {
                          ...tab,
                          badge: (
                              <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
                                  {invitationCount}{" "}
                                  <span className="sr-only">
                                      {invitationCount === 1
                                          ? "convite pendente"
                                          : "convites pendentes"}
                                  </span>
                              </span>
                          ),
                      }
                    : tab,
            )}
            rootHref="/settings"
        >
            {children}
        </SettingsShell>
    );
}
