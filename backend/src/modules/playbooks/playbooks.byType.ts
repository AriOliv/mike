// Which playbook reviews a contract of a given type, when nobody picked one.
//
// A playbook declares the contract types it is written for in its own
// `documentTypes` ("NDA", "Prestação de serviços", …). A review that was not
// handed a playbook — the watched folder has none, or the contract was opened
// without choosing — looks for a playbook that names the contract's type
// (projects.contract_type, set by the terms extraction) and uses it. Only the
// organization's shared playbooks count: a private draft never reviews the
// team's contracts on its own.

import type { Db } from "../../lib/supabase";
import { listPlaybooks, type Playbook } from "./playbooks.operations";

/** Lower-case, accent-free, single-spaced: "Acordo de Confidencialidade" ~ "acordo de confidencialidade". */
function typeKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The names a confidentiality agreement goes by, so a contract classified as
// one of them matches a playbook written for any other.
const SYNONYMS: string[][] = [
  [
    "nda",
    "mnda",
    "acordo de confidencialidade",
    "termo de confidencialidade",
    "contrato de confidencialidade",
    "non disclosure agreement",
    "mutual non disclosure agreement",
    "confidentiality agreement",
  ],
];

function typeKeys(value: string): string[] {
  const key = typeKey(value);
  if (!key) return [];
  return SYNONYMS.find((group) => group.includes(key)) ?? [key];
}

/**
 * The playbook among `playbooks` written for `contractType`, or null. Only
 * organization playbooks are candidates; when several match, the most
 * recently updated wins.
 */
export function playbookForContractType(
  playbooks: Playbook[],
  contractType: string | null | undefined,
): Playbook | null {
  const wanted = new Set(typeKeys(contractType ?? ""));
  if (!wanted.size) return null;
  const matches = playbooks.filter(
    (playbook) =>
      playbook.visibility === "organization" &&
      playbook.content.documentTypes.some((type) =>
        typeKeys(type).some((key) => wanted.has(key)),
      ),
  );
  matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return matches[0] ?? null;
}

/**
 * Finds, among the playbooks `userId` can open in the organization's
 * workspace, the one written for `contractType`. Null without an
 * organization, a type, or a match.
 */
export async function findPlaybookForContractType(
  db: Db,
  args: { userId: string; userEmail?: string | null; orgId: string | null; contractType: string | null | undefined },
): Promise<Playbook | null> {
  if (!args.orgId || !args.contractType?.trim()) return null;
  const playbooks = await listPlaybooks(args.userId, db, {
    workspace: args.orgId,
    email: args.userEmail ?? null,
  });
  return playbookForContractType(playbooks, args.contractType);
}
