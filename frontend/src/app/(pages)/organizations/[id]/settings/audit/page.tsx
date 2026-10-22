"use client";

import { useRouter } from "next/navigation";
import { AuditHistory } from "@/app/components/history/AuditHistory";
import {
  useOrganizationSettings,
  organizationSettingsHref,
} from "@/app/components/organizations/OrganizationSettingsShell";
import { EmptyState } from "@/app/components/ui/empty-state";
import { isOrgAdmin } from "@/app/lib/permissions";

export default function OrganizationAuditPage() {
  const router = useRouter();
  const { orgId, org } = useOrganizationSettings();
  if (!org) return null;
  if (!isOrgAdmin(org.role))
    return (
      <EmptyState
        title="Registro de auditoria"
        description="Só titulares e admins da organização veem o registro de auditoria."
      />
    );
  return (
    <AuditHistory
      key={orgId}
      orgId={orgId}
      onBack={() => router.push(organizationSettingsHref(orgId))}
    />
  );
}
