package com.nexus.agent.db

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * NexusDatabase provides persistent, crash-resilient storage for:
 * - Persistent Message Queue (FIFO with retry and deduplication)
 * - FTS5-backed Knowledge Base & Chunk Index
 * - FAQ deterministic lookup tables
 * - Multi-profile System Prompts
 * - Configuration parameters & Audit logs
 */
class NexusDatabase(context: Context, dbPath: String? = null) : SQLiteOpenHelper(
    context,
    dbPath ?: DATABASE_NAME,
    null,
    DATABASE_VERSION
) {

    companion object {
        const val DATABASE_NAME = "nexus_agent.db"
        const val DATABASE_VERSION = 1
        private val json = Json { ignoreUnknownKeys = true }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        // Enable Write-Ahead Logging (WAL) for high performance and durability across crashes
        db.enableWriteAheadLogging()
        db.execSQL("PRAGMA foreign_keys = ON;")
        db.execSQL("PRAGMA synchronous = NORMAL;")
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.beginTransaction()
        try {
            // 1. Persistent Message Queue table
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS queue_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT UNIQUE NOT NULL,
                    source TEXT NOT NULL,
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    message_id INTEGER NOT NULL,
                    raw_text TEXT NOT NULL,
                    priority INTEGER DEFAULT 5,
                    status TEXT NOT NULL DEFAULT 'QUEUED',
                    retry_count INTEGER DEFAULT 0,
                    max_retries INTEGER DEFAULT 3,
                    error_log TEXT,
                    deduplication_hash TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    started_at INTEGER,
                    completed_at INTEGER
                );
                """.trimIndent()
            )

            // Index for fast FIFO processing by status, priority, and creation time
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_queue_poll ON queue_items (status, priority DESC, created_at ASC);")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_queue_dedup ON queue_items (deduplication_hash, status);")

            // 2. Knowledge Documents table
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS knowledge_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    source_path TEXT NOT NULL,
                    doc_type TEXT NOT NULL,
                    doc_hash TEXT UNIQUE NOT NULL,
                    total_chunks INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """.trimIndent()
            )

            // 3. Knowledge Chunks Table
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS knowledge_chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_id INTEGER NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    FOREIGN KEY (doc_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
                );
                """.trimIndent()
            )

            // 4. SQLite FTS5 Virtual Table for BM25 ranking over chunks
            db.execSQL(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
                    content,
                    metadata,
                    content='knowledge_chunks',
                    content_rowid='id'
                );
                """.trimIndent()
            )

            // Triggers to keep FTS5 synchronized with knowledge_chunks
            db.execSQL(
                """
                CREATE TRIGGER IF NOT EXISTS trg_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
                    INSERT INTO knowledge_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
                END;
                """.trimIndent()
            )
            db.execSQL(
                """
                CREATE TRIGGER IF NOT EXISTS trg_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
                    INSERT INTO knowledge_fts(knowledge_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
                END;
                """.trimIndent()
            )
            db.execSQL(
                """
                CREATE TRIGGER IF NOT EXISTS trg_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
                    INSERT INTO knowledge_fts(knowledge_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
                    INSERT INTO knowledge_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
                END;
                """.trimIndent()
            )

            // 5. Predefined FAQ Table for instant deterministic answers
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS faq_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    question TEXT NOT NULL,
                    answer TEXT NOT NULL,
                    keywords TEXT NOT NULL,
                    enabled INTEGER DEFAULT 1,
                    priority INTEGER DEFAULT 0,
                    match_count INTEGER DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                """.trimIndent()
            )

            // 6. System Prompt Profiles
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS prompt_profiles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    system_prompt TEXT NOT NULL,
                    temperature REAL DEFAULT 0.7,
                    top_p REAL DEFAULT 0.9,
                    top_k INTEGER DEFAULT 40,
                    repeat_penalty REAL DEFAULT 1.1,
                    max_tokens INTEGER DEFAULT 512,
                    is_default INTEGER DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
                """.trimIndent()
            )

            // 7. General Configuration & Key-Value state
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS config_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                """.trimIndent()
            )

            // 8. Audit and Tool Execution Logs
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    level TEXT NOT NULL,
                    details TEXT NOT NULL,
                    timestamp INTEGER NOT NULL
                );
                """.trimIndent()
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_logs_ts ON audit_logs (timestamp DESC);")

            // 9. Conversation History Table
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS conversation_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    tool_calls TEXT,
                    timestamp INTEGER NOT NULL
                );
                """.trimIndent()
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversation_history (chat_id, timestamp ASC);")

            // Seed default prompt profiles and settings
            seedInitialData(db)

            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Migration logic for future schema changes
    }

    /**
     * Seeds initial default system prompt profiles and configuration
     */
    private fun seedInitialData(db: SQLiteDatabase) {
        val now = System.currentTimeMillis()
        val defaultPrompts = listOf(
            PromptProfile(
                id = "default_assistant",
                name = "Default Assistant",
                description = "Balanced, accurate AI assistant with RAG-first verification",
                systemPrompt = """
                You are Nexus, an autonomous offline-first AI agent running locally on Android ARM64.
                Your duties:
                1. Always prioritize verified internal knowledge over speculation.
                2. If local knowledge is insufficient and research is permitted, invoke appropriate tools.
                3. Be concise, precise, and never hallucinate citations or facts.
                4. Maintain user privacy and safe offline operations.
                """.trimIndent(),
                temperature = 0.7f,
                topP = 0.9f,
                isDefault = true,
                updatedAt = now
            ),
            PromptProfile(
                id = "technical_specialist",
                name = "Technical Specialist",
                description = "Optimized for code analysis, architecture diagrams, and GitHub repository search",
                systemPrompt = """
                You are Nexus Technical Engine. Provide structured, technically rigorous answers.
                Always inspect GitHub files and code repositories with exact filenames and revisions before answering.
                Format code blocks cleanly with proper syntax highlighting.
                """.trimIndent(),
                temperature = 0.3f,
                topP = 0.85f,
                isDefault = false,
                updatedAt = now
            ),
            PromptProfile(
                id = "customer_support",
                name = "Customer Support",
                description = "Polite, empathetic, FAQ-driven guidance with direct links and instructions",
                systemPrompt = """
                You are Nexus Customer Support Assistant.
                Give clear, friendly, step-by-step assistance based strictly on approved organization FAQs and docs.
                If unsure, advise the user to contact the administrator.
                """.trimIndent(),
                temperature = 0.5f,
                topP = 0.9f,
                isDefault = false,
                updatedAt = now
            )
        )

        for (profile in defaultPrompts) {
            val cv = ContentValues().apply {
                put("id", profile.id)
                put("name", profile.name)
                put("description", profile.description)
                put("system_prompt", profile.systemPrompt)
                put("temperature", profile.temperature)
                put("top_p", profile.topP)
                put("top_k", profile.topK)
                put("repeat_penalty", profile.repeatPenalty)
                put("max_tokens", profile.maxTokens)
                put("is_default", if (profile.isDefault) 1 else 0)
                put("updated_at", profile.updatedAt)
            }
            db.insertWithOnConflict("prompt_profiles", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
        }

        // Seed initial default configurations
        val defaultConfigs = mapOf(
            "queue_enabled" to "true",
            "max_queue_size" to "500",
            "max_concurrent_tasks" to "1",
            "persistent_queue" to "true",
            "duplicate_detection" to "true",
            "retry_failed_tasks" to "true",
            "max_retries" to "3",
            "research_mode" to "AUTO", // OFF, AUTO, ALWAYS, GITHUB_ONLY, WEB_GITHUB
            "cpu_threads" to "4",
            "context_size" to "2048",
            "telegram_bot_enabled" to "false"
        )

        for ((key, value) in defaultConfigs) {
            val cv = ContentValues().apply {
                put("key", key)
                put("value", value)
                put("updated_at", now)
            }
            db.insertWithOnConflict("config_settings", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
        }

        // Seed sample FAQ
        val faqCv = ContentValues().apply {
            put("question", "How can I configure Nexus GGUF Agent?")
            put("answer", "You can manage all settings, models, and tools directly through the web dashboard at http://127.0.0.1:8765 or via the Telegram /settings command.")
            put("keywords", json.encodeToString(listOf("config", "configure", "settings", "setup")))
            put("enabled", 1)
            put("priority", 10)
            put("match_count", 0)
            put("created_at", now)
        }
        db.insertWithOnConflict("faq_items", null, faqCv, SQLiteDatabase.CONFLICT_IGNORE)
    }

    /**
     * Recovers queue after an app restart or crash.
     * Any task stuck in 'PROCESSING' is safely returned to 'QUEUED' so it is not lost.
     */
    fun recoverPendingQueue(): Int {
        val db = writableDatabase
        val cv = ContentValues().apply {
            put("status", QueueStatus.QUEUED.name)
            put("started_at", null as Long?)
        }
        return db.update(
            "queue_items",
            cv,
            "status = ?",
            arrayOf(QueueStatus.PROCESSING.name)
        )
    }

    /**
     * Enqueue a new incoming request with deduplication check and capacity constraint
     */
    @Synchronized
    fun enqueueTask(item: QueueItem): Boolean {
        val db = writableDatabase

        // 1. Check max queue size (limit to 500)
        val countCursor = db.rawQuery("SELECT COUNT(*) FROM queue_items WHERE status IN ('QUEUED', 'PROCESSING')", null)
        var pendingCount = 0
        if (countCursor.moveToFirst()) {
            pendingCount = countCursor.getInt(0)
        }
        countCursor.close()

        if (pendingCount >= 500) {
            logAudit("QUEUE_FULL", "WARN", "Queue reached maximum limit (500). Task ${item.taskId} rejected.")
            return false
        }

        // 2. Duplicate detection: check if an identical pending task already exists within recent window
        val dedupCursor = db.rawQuery(
            "SELECT id FROM queue_items WHERE deduplication_hash = ? AND status IN ('QUEUED', 'PROCESSING') LIMIT 1",
            arrayOf(item.deduplicationHash)
        )
        val isDuplicate = dedupCursor.moveToFirst()
        dedupCursor.close()

        if (isDuplicate) {
            logAudit("QUEUE_DEDUP", "INFO", "Duplicate task skipped: hash=${item.deduplicationHash}")
            return false
        }

        val cv = ContentValues().apply {
            put("task_id", item.taskId)
            put("source", item.source)
            put("chat_id", item.chatId)
            put("user_id", item.userId)
            put("message_id", item.messageId)
            put("raw_text", item.rawText)
            put("priority", item.priority)
            put("status", QueueStatus.QUEUED.name)
            put("retry_count", item.retryCount)
            put("max_retries", item.maxRetries)
            put("deduplication_hash", item.deduplicationHash)
            put("created_at", item.createdAt)
        }

        val rowId = db.insert("queue_items", null, cv)
        return rowId != -1L
    }

    /**
     * Atomically pops the highest priority oldest QUEUED task and marks it PROCESSING
     */
    @Synchronized
    fun pollNextTask(): QueueItem? {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val cursor = db.rawQuery(
                """
                SELECT id, task_id, source, chat_id, user_id, message_id, raw_text, priority,
                       status, retry_count, max_retries, error_log, deduplication_hash,
                       created_at, started_at, completed_at
                FROM queue_items
                WHERE status = 'QUEUED'
                ORDER BY priority DESC, created_at ASC
                LIMIT 1
                """.trimIndent(),
                null
            )

            if (!cursor.moveToFirst()) {
                cursor.close()
                db.setTransactionSuccessful()
                return null
            }

            val id = cursor.getLong(0)
            val taskId = cursor.getString(1)
            val source = cursor.getString(2)
            val chatId = cursor.getLong(3)
            val userId = cursor.getLong(4)
            val messageId = cursor.getLong(5)
            val rawText = cursor.getString(6)
            val priority = cursor.getInt(7)
            val retryCount = cursor.getInt(9)
            val maxRetries = cursor.getInt(10)
            val errorLog = cursor.getString(11)
            val dedupHash = cursor.getString(12)
            val createdAt = cursor.getLong(13)
            cursor.close()

            val now = System.currentTimeMillis()
            val updateCv = ContentValues().apply {
                put("status", QueueStatus.PROCESSING.name)
                put("started_at", now)
            }
            db.update("queue_items", updateCv, "id = ?", arrayOf(id.toString()))

            db.setTransactionSuccessful()

            return QueueItem(
                id = id,
                taskId = taskId,
                source = source,
                chatId = chatId,
                userId = userId,
                messageId = messageId,
                rawText = rawText,
                priority = priority,
                status = QueueStatus.PROCESSING,
                retryCount = retryCount,
                maxRetries = maxRetries,
                errorLog = errorLog,
                deduplicationHash = dedupHash,
                createdAt = createdAt,
                startedAt = now,
                completedAt = null
            )
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Updates task status to COMPLETED or FAILED (with retry scheduling if retries remain)
     */
    fun completeTask(taskId: String, success: Boolean, errorLog: String? = null) {
        val db = writableDatabase
        val now = System.currentTimeMillis()

        if (success) {
            val cv = ContentValues().apply {
                put("status", QueueStatus.COMPLETED.name)
                put("completed_at", now)
                put("error_log", null as String?)
            }
            db.update("queue_items", cv, "task_id = ?", arrayOf(taskId))
        } else {
            // Check retry count
            val cursor = db.rawQuery("SELECT retry_count, max_retries FROM queue_items WHERE task_id = ?", arrayOf(taskId))
            var retryCount = 0
            var maxRetries = 3
            if (cursor.moveToFirst()) {
                retryCount = cursor.getInt(0)
                maxRetries = cursor.getInt(1)
            }
            cursor.close()

            if (retryCount + 1 < maxRetries) {
                // Re-queue with incremented retry count
                val cv = ContentValues().apply {
                    put("status", QueueStatus.QUEUED.name)
                    put("retry_count", retryCount + 1)
                    put("error_log", errorLog)
                    put("started_at", null as Long?)
                }
                db.update("queue_items", cv, "task_id = ?", arrayOf(taskId))
                logAudit("TASK_RETRY", "WARN", "Task $taskId failed. Re-queued (attempt ${retryCount + 2}/$maxRetries). Error: $errorLog")
            } else {
                // Mark permanent FAILED
                val cv = ContentValues().apply {
                    put("status", QueueStatus.FAILED.name)
                    put("retry_count", retryCount + 1)
                    put("completed_at", now)
                    put("error_log", errorLog)
                }
                db.update("queue_items", cv, "task_id = ?", arrayOf(taskId))
                logAudit("TASK_FAILED", "ERROR", "Task $taskId permanently failed after ${retryCount + 1} attempts. Error: $errorLog")
            }
        }
    }

    /**
     * Search knowledge base using SQLite FTS5 with BM25 ranking
     */
    fun searchKnowledgeFts(query: String, limit: Int = 5): List<KnowledgeChunk> {
        val db = readableDatabase
        val results = mutableListOf<KnowledgeChunk>()
        // Clean query for FTS5 (escape quotes)
        val sanitizedQuery = query.replace("\"", "\"\"")
        val sql = """
            SELECT c.id, c.doc_id, c.chunk_index, c.content, c.metadata, bm25(knowledge_fts) as rank
            FROM knowledge_fts f
            JOIN knowledge_chunks c ON f.rowid = c.id
            WHERE knowledge_fts MATCH ?
            ORDER BY rank ASC
            LIMIT ?
        """.trimIndent()

        try {
            val cursor = db.rawQuery(sql, arrayOf("\"$sanitizedQuery\"*", limit.toString()))
            while (cursor.moveToNext()) {
                results.add(
                    KnowledgeChunk(
                        id = cursor.getLong(0),
                        docId = cursor.getLong(1),
                        chunkIndex = cursor.getInt(2),
                        content = cursor.getString(3),
                        metadata = cursor.getString(4),
                        score = cursor.getDouble(5)
                    )
                )
            }
            cursor.close()
        } catch (e: Exception) {
            logAudit("FTS_SEARCH_ERROR", "ERROR", "FTS query failed: ${e.message}")
        }
        return results
    }

    /**
     * Match query against FAQ keywords
     */
    fun matchFaq(query: String): FaqItem? {
        val db = readableDatabase
        val cursor = db.rawQuery("SELECT id, question, answer, keywords, enabled, priority, match_count, created_at FROM faq_items WHERE enabled = 1 ORDER BY priority DESC", null)
        val normalizedQuery = query.lowercase().trim()

        var bestMatch: FaqItem? = null
        while (cursor.moveToNext()) {
            val id = cursor.getLong(0)
            val question = cursor.getString(1)
            val answer = cursor.getString(2)
            val keywordsJson = cursor.getString(3)
            val enabled = cursor.getInt(4) == 1
            val priority = cursor.getInt(5)
            val matchCount = cursor.getInt(6)
            val createdAt = cursor.getLong(7)

            val keywords: List<String> = try {
                json.decodeFromString(keywordsJson)
            } catch (e: Exception) {
                emptyList()
            }

            // Direct exact or keyword match
            val isMatch = normalizedQuery.contains(question.lowercase()) ||
                    keywords.any { normalizedQuery.contains(it.lowercase()) }

            if (isMatch) {
                bestMatch = FaqItem(
                    id = id,
                    question = question,
                    answer = answer,
                    keywords = keywords,
                    enabled = enabled,
                    priority = priority,
                    matchCount = matchCount + 1,
                    createdAt = createdAt
                )
                break
            }
        }
        cursor.close()

        if (bestMatch != null) {
            // Increment match count
            val updateCv = ContentValues().apply {
                put("match_count", bestMatch.matchCount)
            }
            writableDatabase.update("faq_items", updateCv, "id = ?", arrayOf(bestMatch.id.toString()))
        }

        return bestMatch
    }

    /**
     * Write an audit log entry
     */
    fun logAudit(eventType: String, level: String, details: String) {
        val db = writableDatabase
        val cv = ContentValues().apply {
            put("event_type", eventType)
            put("level", level)
            put("details", details)
            put("timestamp", System.currentTimeMillis())
        }
        db.insert("audit_logs", null, cv)
    }

    /**
     * Database integrity check
     */
    fun checkIntegrity(): Boolean {
        val db = readableDatabase
        val cursor = db.rawQuery("PRAGMA integrity_check;", null)
        var isOk = false
        if (cursor.moveToFirst()) {
            val result = cursor.getString(0)
            isOk = result.equals("ok", ignoreCase = true)
        }
        cursor.close()
        return isOk
    }

    /**
     * Vacuum database to reclaim space
     */
    fun vacuum() {
        val db = writableDatabase
        db.execSQL("VACUUM;")
    }
}
