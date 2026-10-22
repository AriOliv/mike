// Facade for the legal-agent module: the legal team's chat agent per
// organization (persona, tone, hours, who may ask for what, when a person
// decides) and the installation assistant for its chat channels. The chat
// itself runs on Hermes; it reads its settings through Mike's MCP server
// (getAgentConfigForBot, behind the tool mike_agente_config).

export {
    getLegalAgent,
    saveLegalAgentSettings,
    saveLegalAgentChannel,
    getLegalAgentChannelSetup,
    setLegalAgentChannelStatus,
    deleteLegalAgentChannel,
    getAgentConfigForBot,
    mcpUrl,
    type Caller,
    type AgentChannel,
    type LegalAgentView,
} from "./legalAgent.store";
export {
    agentConfigForBot,
    mayAsk,
    withinHours,
    DISCLAIMER,
    FIXED_ESCALATIONS,
    MAX_REMINDERS,
    type AgentSettings,
} from "./legalAgent.settings";
export { channelSetup, looksLikeSecret, type ChannelKind, type ChannelSetup } from "./legalAgent.setup";
export { AGENT_TOOLS, agentConfigTool, type AgentToolContext } from "./legalAgent.mcp";
export {
    resolveChatIdentity,
    createLinkChallenge,
    previewChatLink,
    confirmChatLink,
    listMyChatLinks,
    revokeMyChatLink,
    validIdentity,
    LINK_DAYS,
    CHALLENGE_MINUTES,
    type ChatLink,
} from "./legalAgent.links";
