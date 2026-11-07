package com.nexus.agent.server

import com.nexus.agent.db.NexusDatabase
import com.nexus.agent.db.QueueItem
import com.nexus.agent.db.TaskPriority
import com.nexus.agent.storage.StorageManager
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

@Serializable
data class DaemonStatusResponse(
    val status: String,
    val uptimeSeconds: Long,
    val ramUsedMB: Long,
    val ramTotalMB: Long,
    val modelLoaded: Boolean,
    val activeModelName: String?,
    val queuePendingCount: Int,
    val queueProcessingCount: Int,
    val queueCompletedCount: Int,
    val queueFailedCount: Int,
    val telegramConnected: Boolean,
    val telegramMode: String
)

@Serializable
data class SearchKnowledgeRequest(
    val query: String,
    val limit: Int = 5
)

@Serializable
data class CreateQueueTaskRequest(
    val text: String,
    val source: String = "web_dashboard",
    val priority: Int = 5
)

/**
 * Embedded Ktor HTTP/WebSocket daemon server running on 127.0.0.1:8765.
 * Provides the persistent REST bridge for the Web Dashboard and external client tooling.
 */
class KtorDaemonServer(
    private val db: NexusDatabase,
    private val storage: StorageManager,
    private val port: Int = 8765
) {
    private var server: ApplicationEngine? = null
    private val startTime = System.currentTimeMillis()

    fun start() {
        if (server != null) return

        server = embeddedServer(CIO, port = port, host = "127.0.0.1") {
            install(ContentNegotiation) {
                json(Json {
                    prettyPrint = true
                    isLenient = true
                    ignoreUnknownKeys = true
                })
            }
            install(CORS) {
                anyHost()
                allowHeader("Content-Type")
                allowHeader("Authorization")
                allowMethod(io.ktor.http.HttpMethod.Get)
                allowMethod(io.ktor.http.HttpMethod.Post)
                allowMethod(io.ktor.http.HttpMethod.Delete)
                allowMethod(io.ktor.http.HttpMethod.Options)
            }
            install(WebSockets)

            configureRoutes(this, db, storage, startTime)
        }.start(wait = false)
    }

    fun stop() {
        server?.stop(gracePeriodMillis = 1000, timeoutMillis = 2000)
        server = null
    }

    private fun configureRoutes(
        app: Application,
        database: NexusDatabase,
        storageManager: StorageManager,
        startTimeMs: Long
    ) {
        app.routing {
            // 1. Daemon Status & Hardware Telemetry
            get("/api/status") {
                val runtime = Runtime.getRuntime()
                val usedMem = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
                val totalMem = runtime.maxMemory() / (1024 * 1024)

                val dbRaw = database.readableDatabase
                var pending = 0
                var processing = 0
                var completed = 0
                var failed = 0

                val c = dbRaw.rawQuery("SELECT status, count(*) FROM queue_items GROUP BY status", null)
                while (c.moveToNext()) {
                    val status = c.getString(0)
                    val count = c.getInt(1)
                    when (status) {
                        "QUEUED" -> pending = count
                        "PROCESSING" -> processing = count
                        "COMPLETED" -> completed = count
                        "FAILED" -> failed = count
                    }
                }
                c.close()

                call.respond(
                    DaemonStatusResponse(
                        status = "ONLINE",
                        uptimeSeconds = (System.currentTimeMillis() - startTimeMs) / 1000,
                        ramUsedMB = usedMem,
                        ramTotalMB = totalMem,
                        modelLoaded = false, // Updated by ModelManager in Phase 2
                        activeModelName = null,
                        queuePendingCount = pending,
                        queueProcessingCount = processing,
                        queueCompletedCount = completed,
                        queueFailedCount = failed,
                        telegramConnected = false,
                        telegramMode = "BOT_API"
                    )
                )
            }

            // 2. Queue Endpoints
            get("/api/queue") {
                val dbRaw = database.readableDatabase
                val cursor = dbRaw.rawQuery(
                    "SELECT id, task_id, source, raw_text, priority, status, retry_count, max_retries, error_log, created_at, started_at, completed_at FROM queue_items ORDER BY id DESC LIMIT 100",
                    null
                )
                val list = mutableListOf<Map<String, Any?>>()
                while (cursor.moveToNext()) {
                    list.add(
                        mapOf(
                            "id" to cursor.getLong(0),
                            "taskId" to cursor.getString(1),
                            "source" to cursor.getString(2),
                            "rawText" to cursor.getString(3),
                            "priority" to cursor.getInt(4),
                            "status" to cursor.getString(5),
                            "retryCount" to cursor.getInt(6),
                            "maxRetries" to cursor.getInt(7),
                            "errorLog" to cursor.getString(8),
                            "createdAt" to cursor.getLong(9),
                            "startedAt" to if (cursor.isNull(10)) null else cursor.getLong(10),
                            "completedAt" to if (cursor.isNull(11)) null else cursor.getLong(11)
                        )
                    )
                }
                cursor.close()
                call.respond(list)
            }

            post("/api/queue") {
                val req = call.receive<CreateQueueTaskRequest>()
                val taskId = "task_" + UUID.randomUUID().toString().substring(0, 8)
                val dedupHash = (req.text.trim().lowercase() + "_" + req.source).hashCode().toString()

                val item = QueueItem(
                    taskId = taskId,
                    source = req.source,
                    chatId = 0L,
                    userId = 0L,
                    messageId = 0L,
                    rawText = req.text,
                    priority = req.priority,
                    deduplicationHash = dedupHash
                )
                val enqueued = database.enqueueTask(item)
                if (enqueued) {
                    call.respond(HttpStatusCode.Created, mapOf("success" to true, "taskId" to taskId))
                } else {
                    call.respond(HttpStatusCode.Conflict, mapOf("success" to false, "error" to "Queue full or duplicate detected"))
                }
            }

            post("/api/queue/clear") {
                val dbRaw = database.writableDatabase
                dbRaw.execSQL("DELETE FROM queue_items WHERE status IN ('COMPLETED', 'FAILED');")
                call.respond(mapOf("success" to true))
            }

            // 3. Storage & Models
            get("/api/storage") {
                call.respond(storageManager.getStorageMetrics())
            }

            get("/api/models") {
                call.respond(storageManager.listGgufModels())
            }

            // 4. Knowledge Base & FTS5 Search
            post("/api/knowledge/search") {
                val req = call.receive<SearchKnowledgeRequest>()
                val chunks = database.searchKnowledgeFts(req.query, req.limit)
                call.respond(chunks)
            }

            // 5. FAQ Management
            get("/api/faq") {
                val dbRaw = database.readableDatabase
                val cursor = dbRaw.rawQuery("SELECT id, question, answer, keywords, enabled, priority, match_count, created_at FROM faq_items ORDER BY priority DESC", null)
                val list = mutableListOf<Map<String, Any?>>()
                while (cursor.moveToNext()) {
                    list.add(
                        mapOf(
                            "id" to cursor.getLong(0),
                            "question" to cursor.getString(1),
                            "answer" to cursor.getString(2),
                            "keywords" to cursor.getString(3),
                            "enabled" to (cursor.getInt(4) == 1),
                            "priority" to cursor.getInt(5),
                            "matchCount" to cursor.getInt(6),
                            "createdAt" to cursor.getLong(7)
                        )
                    )
                }
                cursor.close()
                call.respond(list)
            }

            // 6. Real-Time Telemetry WebSocket
            webSocket("/ws/telemetry") {
                val runtime = Runtime.getRuntime()
                while (isActive) {
                    val usedMem = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
                    val frameJson = buildJsonObject {
                        put("timestamp", System.currentTimeMillis())
                        put("ramUsedMB", usedMem)
                        put("tokensPerSecond", 0.0)
                    }.toString()

                    send(Frame.Text(frameJson))
                    delay(1000)
                }
            }
        }
    }
}
