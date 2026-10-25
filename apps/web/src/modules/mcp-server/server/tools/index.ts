import type { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import type { AttachmentService } from "~/modules/attachments/server/service.ts";
import type { ChatRepo } from "~/modules/chat/server/repo.ts";
import type { ProjectService } from "~/modules/projects/server/service.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { ChatService } from "~/modules/chat/server/service.ts";
import type { StreamEngine } from "~/modules/chat/server/streaming.ts";
import type { DocumentService } from "~/modules/documents/server/document-service.ts";
import type { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import type { KnowledgeSearch } from "~/modules/knowledge/server/search.ts";
import type { LanguageRepo } from "~/modules/language/server/repo.ts";
import type { KnowledgeService } from "~/modules/knowledge/server/service.ts";
import type { MemoryService } from "~/modules/memory/server/service.ts";
import type { SkillReader } from "~/modules/skills/server/reader.ts";
import type { SkillRepo } from "~/modules/skills/server/repo.ts";
import type { Db } from "~/server/db.ts";
import type { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import type { ApiKeys } from "~/modules/api-keys/server/service.ts";
import type { ConnectedApps } from "../connected-apps.ts";
import { listChats, searchChats } from "./chats.ts";
import { getMessage, sendMessage, stopGeneration } from "./delegate.ts";
import { listAgents, listModels, listProjects } from "./lookup.ts";
import { createDocument, editDocument, listDocuments, readDocument } from "./documents.ts";
import { listCollections, readKnowledgeDocument, searchKnowledge } from "./knowledge.ts";
import { archiveChat, branchChat, keepChat, readChat, renameChat, retryMessage } from "./manage.ts";
import { deleteMemory, listMemories, saveMemory, updateMemory } from "./memory.ts";
import { listSkills, readSkillFile } from "./skills.ts";
import type { StorageQuota } from "~/modules/limits/server/storage.ts";

export const MCP_TOOLS = [
  listAgents,
  listModels,
  listProjects,
  listChats,
  searchChats,
  readChat,
  sendMessage,
  getMessage,
  stopGeneration,
  retryMessage,
  branchChat,
  keepChat,
  archiveChat,
  renameChat,
  listCollections,
  searchKnowledge,
  readKnowledgeDocument,
  listMemories,
  saveMemory,
  updateMemory,
  deleteMemory,
  listSkills,
  readSkillFile,
  listDocuments,
  readDocument,
  editDocument,
  createDocument,
] as const;

/**
 * Every service a tool may reach, which the runtime serving MCP must provide.
 * A tool needing one missing here fails to typecheck where it is installed.
 */
export type McpServices =
  | AgentRepo
  | ApiKeys
  | AttachmentRepo
  | AttachmentService
  | ChatRepo
  | ChatService
  | ConnectedApps
  | DocumentService
  | FeaturePolicy
  | IntegrationApprovals
  | IntegrationRepo
  | KnowledgeSearch
  | KnowledgeService
  | LanguageRepo
  | MemoryService
  | ProjectService
  | ProviderRepo
  | SkillReader
  | SkillRepo
  | StorageQuota
  | Db
  | StreamEngine
  | SyncBus;
