// Facade for the integrations-notion module: an organization's own Notion
// board, connected with its integration token (encrypted at rest), mapped
// field by field and stage by stage onto Mike's cards. Import and two-way
// sync build on this (later PRs). Replaces the env-wide mirror (lib/notion.ts)
// for organizations that connect.

export {
    getNotionConnection,
    connectNotion,
    disconnectNotion,
    listNotionDatabases,
    describeNotionBoard,
    saveNotionMapping,
    clientForOrg,
    looksLikeNotionToken,
    type Caller,
    type NotionConnectionView,
    type NotionDatabase,
    type BoardSchema,
} from "./notion.connection";
export {
    suggestFieldMap,
    suggestStageMap,
    readPage,
    writePage,
    MIKE_FIELDS,
    type FieldMap,
    type StageMap,
    type CardFields,
    type MikeField,
} from "./notion.mapping";
export { notionClient, notionErrorMessage, NotionError, type Fetch, type NotionClient } from "./notion.client";
export {
    previewNotionImport,
    applyNotionImport,
    planImport,
    readAllPages,
    type ImportPlan,
    type ImportItem,
    type ImportMatch,
    type ImportResult,
} from "./notion.import";
