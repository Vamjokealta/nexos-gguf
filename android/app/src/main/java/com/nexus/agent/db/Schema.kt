package com.nexus.agent.db

import kotlinx.serialization.Serializable

/**
 * Task queue status states
 */
enum class QueueStatus {
    QUEUED,
    PROCESSING,
    COMPLETED,
    FAILED,
    CANCELLED
}

/**
 * Priority levels for incoming queue tasks
 */
enum class TaskPriority(val value: Int) {
    LOW(1),
    NORMAL(5),
    HIGH(10),
    CRITICAL(20)
}

/**
 * Persistent Queue item model
 */
@Serializable
data class QueueItem(
    val id: Long = 0,
    val taskId: String,
    val source: String, // "telegram_bot", "telegram_user", "web_dashboard"
    val chatId: Long,
    val userId: Long,
    val messageId: Long,
    val rawText: String,
    val priority: Int = TaskPriority.NORMAL.value,
    val status: QueueStatus = QueueStatus.QUEUED,
    val retryCount: Int = 0,
    val maxRetries: Int = 3,
    val errorLog: String? = null,
    val deduplicationHash: String,
    val createdAt: Long = System.currentTimeMillis(),
    val startedAt: Long? = null,
    val completedAt: Long? = null
)

/**
 * Knowledge Base Document item
 */
@Serializable
data class KnowledgeDocument(
    val id: Long = 0,
    val title: String,
    val sourcePath: String,
    val docType: String, // "txt", "md", "json", "pdf", "html", "url"
    val docHash: String,
    val totalChunks: Int = 0,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis()
)

/**
 * Knowledge Chunk stored in FTS5
 */
@Serializable
data class KnowledgeChunk(
    val id: Long = 0,
    val docId: Long,
    val chunkIndex: Int,
    val content: String,
    val metadata: String? = null,
    val score: Double = 0.0
)

/**
 * Predefined FAQ entry for deterministic instant answering
 */
@Serializable
data class FaqItem(
    val id: Long = 0,
    val question: String,
    val answer: String,
    val keywords: List<String>,
    val enabled: Boolean = true,
    val priority: Int = 0,
    val matchCount: Int = 0,
    val createdAt: Long = System.currentTimeMillis()
)

/**
 * System Prompt Persona Profiles
 */
@Serializable
data class PromptProfile(
    val id: String,
    val name: String,
    val description: String,
    val systemPrompt: String,
    val temperature: Float = 0.7f,
    val topP: Float = 0.9f,
    val topK: Int = 40,
    val repeatPenalty: Float = 1.1f,
    val maxTokens: Int = 512,
    val isDefault: Boolean = false,
    val updatedAt: Long = System.currentTimeMillis()
)

/**
 * App Configuration Setting
 */
@Serializable
data class ConfigSetting(
    val key: String,
    val value: String,
    val updatedAt: Long = System.currentTimeMillis()
)

/**
 * Audit log entry for tracking system events and tool executions
 */
@Serializable
data class AuditLog(
    val id: Long = 0,
    val eventType: String,
    val level: String, // "INFO", "WARN", "ERROR", "TOOL"
    val details: String,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Conversation history for multi-turn context
 */
@Serializable
data class ConversationRecord(
    val id: Long = 0,
    val chatId: Long,
    val userId: Long,
    val role: String, // "user", "assistant", "tool"
    val content: String,
    val toolCalls: String? = null,
    val timestamp: Long = System.currentTimeMillis()
)
