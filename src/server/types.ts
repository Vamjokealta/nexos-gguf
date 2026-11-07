/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type QueueStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface QueueItem {
  id: number;
  taskId: string;
  source: 'telegram_bot' | 'telegram_user' | 'web_dashboard';
  chatId: number;
  userId: number;
  messageId: number;
  rawText: string;
  priority: number;
  status: QueueStatus;
  retryCount: number;
  maxRetries: number;
  errorLog: string | null;
  deduplicationHash: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface KnowledgeDocument {
  id: number;
  title: string;
  sourcePath: string;
  docType: 'txt' | 'md' | 'json' | 'pdf' | 'html' | 'url';
  docHash: string;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeChunk {
  id: number;
  docId: number;
  chunkIndex: number;
  content: string;
  metadata: string | null;
  score?: number;
}

export interface FaqItem {
  id: number;
  question: string;
  answer: string;
  keywords: string[];
  enabled: boolean;
  priority: number;
  matchCount: number;
  createdAt: number;
}

export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  maxTokens: number;
  isDefault: boolean;
  updatedAt: number;
}

export interface ConfigSetting {
  key: string;
  value: string;
  updatedAt: number;
}

export interface AuditLog {
  id: number;
  eventType: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TOOL';
  details: string;
  timestamp: number;
}

export interface StorageMetrics {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  modelsCount: number;
  knowledgeDocsCount: number;
  basePath: string;
}

export interface LocalModelInfo {
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  sizeMB: number;
  lastModified: number;
  quantization?: string;
  parametersEstimate?: string;
}

export interface DaemonStatus {
  status: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  uptimeSeconds: number;
  ramUsedMB: number;
  ramTotalMB: number;
  modelLoaded: boolean;
  activeModelName: string | null;
  queuePendingCount: number;
  queueProcessingCount: number;
  queueCompletedCount: number;
  queueFailedCount: number;
  telegramConnected: boolean;
  telegramMode: 'BOT_API' | 'USER_ACCOUNT' | 'DISCONNECTED';
}
