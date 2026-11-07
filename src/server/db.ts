/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { QueueItem, KnowledgeChunk, FaqItem, PromptProfile, AuditLog } from './types.ts';

export class NexusDb {
  public db: Database.Database;

  constructor(dbFilePath: string) {
    this.db = new Database(dbFilePath);
    this.configure();
    this.initSchema();
    this.seedDefaults();
  }

  private configure(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
  }

  private initSchema(): void {
    this.db.exec(`
      -- 1. Persistent Message Queue table
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

      CREATE INDEX IF NOT EXISTS idx_queue_poll ON queue_items (status, priority DESC, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_queue_dedup ON queue_items (deduplication_hash, status);

      -- 2. Knowledge Documents
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

      -- 3. Knowledge Chunks
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        FOREIGN KEY (doc_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );

      -- 4. SQLite FTS5 Virtual Table for full-text search with BM25 ranking
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        content,
        metadata,
        content='knowledge_chunks',
        content_rowid='id'
      );

      -- FTS synchronization triggers
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, metadata) VALUES('delete', old.id, old.content, old.metadata);
        INSERT INTO knowledge_fts(rowid, content, metadata) VALUES (new.id, new.content, new.metadata);
      END;

      -- 5. FAQ deterministic instant answering table
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

      -- 6. System Prompt Profiles
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

      -- 7. Configuration Settings
      CREATE TABLE IF NOT EXISTS config_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 8. Audit Logs
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        details TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON audit_logs (timestamp DESC);

      -- 9. Conversation History
      CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_chat ON conversation_history (chat_id, timestamp ASC);
    `);
  }

  private seedDefaults(): void {
    const now = Date.now();

    // Default prompt profiles
    const insertProfile = this.db.prepare(`
      INSERT OR IGNORE INTO prompt_profiles (
        id, name, description, system_prompt, temperature, top_p, top_k, repeat_penalty, max_tokens, is_default, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProfile.run(
      'default_assistant',
      'Default Assistant',
      'Balanced, accurate AI assistant with RAG-first verification',
      'You are Nexus, an autonomous offline-first AI agent running locally on Android ARM64.\n1. Prioritize internal knowledge over speculation.\n2. When knowledge is missing, search external sources.\n3. Be concise and precise.',
      0.7,
      0.9,
      40,
      1.1,
      512,
      1,
      now
    );

    insertProfile.run(
      'technical_specialist',
      'Technical Specialist',
      'Optimized for code analysis, architecture diagrams, and GitHub repository search',
      'You are Nexus Technical Engine. Inspect code repositories, file revisions, and syntax before answering.',
      0.3,
      0.85,
      40,
      1.1,
      1024,
      0,
      now
    );

    insertProfile.run(
      'customer_support',
      'Customer Support',
      'Polite, FAQ-driven guidance with direct links and instructions',
      'You are Nexus Customer Support. Provide friendly, accurate step-by-step guidance based strictly on approved FAQs.',
      0.5,
      0.9,
      40,
      1.1,
      512,
      0,
      now
    );

    // Default configuration settings
    const insertConfig = this.db.prepare(`
      INSERT OR IGNORE INTO config_settings (key, value, updated_at) VALUES (?, ?, ?)
    `);

    const defaults: Record<string, string> = {
      queue_enabled: 'true',
      max_queue_size: '500',
      max_concurrent_tasks: '1',
      persistent_queue: 'true',
      duplicate_detection: 'true',
      retry_failed_tasks: 'true',
      max_retries: '3',
      research_mode: 'AUTO',
      cpu_threads: '4',
      context_size: '2048',
      telegram_bot_enabled: 'false',
      telegram_bot_token: '',
      active_model: 'nexus-qwen2.5-0.5b-instruct-q4_k_m.gguf',
    };

    for (const [k, v] of Object.entries(defaults)) {
      insertConfig.run(k, v, now);
    }

    // Default FAQ
    const insertFaq = this.db.prepare(`
      INSERT OR IGNORE INTO faq_items (question, answer, keywords, enabled, priority, match_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertFaq.run(
      'How can I configure Nexus GGUF Agent?',
      'You can manage all settings, models, and tools directly through the web dashboard at http://127.0.0.1:8765 or via the Telegram /settings command.',
      JSON.stringify(['config', 'configure', 'settings', 'setup']),
      1,
      10,
      0,
      now
    );
  }

  /**
   * Recovers queue after an app restart or crash.
   * Interrupted tasks in PROCESSING are reset to QUEUED.
   */
  public recoverPendingQueue(): number {
    const stmt = this.db.prepare(`
      UPDATE queue_items
      SET status = 'QUEUED', started_at = NULL
      WHERE status = 'PROCESSING'
    `);
    const info = stmt.run();
    return info.changes;
  }

  public enqueueTask(item: Omit<QueueItem, 'id'>): { success: boolean; reason?: string } {
    // Check queue size limit
    const countRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM queue_items WHERE status IN ('QUEUED', 'PROCESSING')
    `).get() as { count: number };

    if (countRow.count >= 500) {
      this.logAudit('QUEUE_FULL', 'WARN', `Queue reached maximum capacity (500). Task ${item.taskId} rejected.`);
      return { success: false, reason: 'Queue limit exceeded (max 500)' };
    }

    // Deduplication check
    const dedupRow = this.db.prepare(`
      SELECT id FROM queue_items WHERE deduplication_hash = ? AND status IN ('QUEUED', 'PROCESSING') LIMIT 1
    `).get(item.deduplicationHash);

    if (dedupRow) {
      this.logAudit('QUEUE_DEDUP', 'INFO', `Duplicate task ignored (hash=${item.deduplicationHash})`);
      return { success: false, reason: 'Duplicate task already in queue' };
    }

    const stmt = this.db.prepare(`
      INSERT INTO queue_items (
        task_id, source, chat_id, user_id, message_id, raw_text, priority, status,
        retry_count, max_retries, error_log, deduplication_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?)
    `);

    stmt.run(
      item.taskId,
      item.source,
      item.chatId,
      item.userId,
      item.messageId,
      item.rawText,
      item.priority,
      item.retryCount || 0,
      item.maxRetries || 3,
      item.errorLog || null,
      item.deduplicationHash,
      item.createdAt || Date.now()
    );

    return { success: true };
  }

  public pollNextTask(): QueueItem | null {
    const txn = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM queue_items
        WHERE status = 'QUEUED'
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      `).get() as any;

      if (!row) return null;

      const now = Date.now();
      this.db.prepare(`
        UPDATE queue_items
        SET status = 'PROCESSING', started_at = ?
        WHERE id = ?
      `).run(now, row.id);

      return {
        id: row.id,
        taskId: row.task_id,
        source: row.source,
        chatId: row.chat_id,
        userId: row.user_id,
        messageId: row.message_id,
        rawText: row.raw_text,
        priority: row.priority,
        status: 'PROCESSING',
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        errorLog: row.error_log,
        deduplicationHash: row.deduplication_hash,
        createdAt: row.created_at,
        startedAt: now,
        completedAt: null,
      } as QueueItem;
    });

    return txn();
  }

  public completeTask(taskId: string, success: boolean, errorLog?: string): void {
    const now = Date.now();
    if (success) {
      this.db.prepare(`
        UPDATE queue_items
        SET status = 'COMPLETED', completed_at = ?, error_log = NULL
        WHERE task_id = ?
      `).run(now, taskId);
    } else {
      const row = this.db.prepare(`SELECT retry_count, max_retries FROM queue_items WHERE task_id = ?`).get(taskId) as any;
      const retryCount = (row?.retry_count || 0) + 1;
      const maxRetries = row?.max_retries || 3;

      if (retryCount < maxRetries) {
        this.db.prepare(`
          UPDATE queue_items
          SET status = 'QUEUED', retry_count = ?, error_log = ?, started_at = NULL
          WHERE task_id = ?
        `).run(retryCount, errorLog || 'Execution error', taskId);
        this.logAudit('TASK_RETRY', 'WARN', `Task ${taskId} failed. Re-queued (attempt ${retryCount + 1}/${maxRetries}).`);
      } else {
        this.db.prepare(`
          UPDATE queue_items
          SET status = 'FAILED', retry_count = ?, completed_at = ?, error_log = ?
          WHERE task_id = ?
        `).run(retryCount, now, errorLog || 'Max retries exhausted', taskId);
        this.logAudit('TASK_FAILED', 'ERROR', `Task ${taskId} permanently failed after ${retryCount} attempts.`);
      }
    }
  }

  public searchKnowledgeFts(query: string, limit = 5): KnowledgeChunk[] {
    const sanitized = query.replace(/"/g, '""').trim();
    if (!sanitized) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT c.id, c.doc_id, c.chunk_index, c.content, c.metadata, bm25(knowledge_fts) as score
        FROM knowledge_fts f
        JOIN knowledge_chunks c ON f.rowid = c.id
        WHERE knowledge_fts MATCH ?
        ORDER BY score ASC
        LIMIT ?
      `);
      const rows = stmt.all(`"${sanitized}"*`, limit) as any[];
      return rows.map(r => ({
        id: r.id,
        docId: r.doc_id,
        chunkIndex: r.chunk_index,
        content: r.content,
        metadata: r.metadata,
        score: r.score,
      }));
    } catch {
      return [];
    }
  }

  public matchFaq(query: string): FaqItem | null {
    const rows = this.db.prepare(`SELECT * FROM faq_items WHERE enabled = 1 ORDER BY priority DESC`).all() as any[];
    const normalized = query.toLowerCase().trim();

    for (const r of rows) {
      let keywords: string[] = [];
      try {
        keywords = JSON.parse(r.keywords);
      } catch {
        keywords = [];
      }

      if (
        normalized.includes(r.question.toLowerCase()) ||
        keywords.some(k => normalized.includes(k.toLowerCase()))
      ) {
        this.db.prepare(`UPDATE faq_items SET match_count = match_count + 1 WHERE id = ?`).run(r.id);
        return {
          id: r.id,
          question: r.question,
          answer: r.answer,
          keywords,
          enabled: r.enabled === 1,
          priority: r.priority,
          matchCount: r.match_count + 1,
          createdAt: r.created_at,
        };
      }
    }
    return null;
  }

  public logAudit(eventType: string, level: 'INFO' | 'WARN' | 'ERROR' | 'TOOL', details: string): void {
    this.db.prepare(`
      INSERT INTO audit_logs (event_type, level, details, timestamp)
      VALUES (?, ?, ?, ?)
    `).run(eventType, level, details, Date.now());
  }

  public checkIntegrity(): boolean {
    const row = this.db.pragma('integrity_check') as any[];
    return row.length > 0 && String(row[0].integrity_check).toLowerCase() === 'ok';
  }

  public vacuum(): void {
    this.db.exec('VACUUM');
  }

  public getTableStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    const tables = [
      'queue_items',
      'knowledge_documents',
      'knowledge_chunks',
      'faq_items',
      'prompt_profiles',
      'config_settings',
      'audit_logs',
      'conversation_history',
    ];

    for (const t of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get() as any;
        stats[t] = row?.count || 0;
      } catch {
        stats[t] = 0;
      }
    }
    return stats;
  }

  /**
   * Flushes WAL to main DB file and exports raw SQLite DB buffer
   */
  public checkpointAndGetDbPath(): string {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return (this.db as any).name;
  }

  /**
   * Full JSON export bundle
   */
  public exportJsonBundle(): any {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    return {
      appName: 'NEXUS GGUF AGENT',
      version: '1.0',
      exportedAt: Date.now(),
      tables: {
        config_settings: this.db.prepare(`SELECT * FROM config_settings`).all(),
        prompt_profiles: this.db.prepare(`SELECT * FROM prompt_profiles`).all(),
        faq_items: this.db.prepare(`SELECT * FROM faq_items`).all(),
        knowledge_documents: this.db.prepare(`SELECT * FROM knowledge_documents`).all(),
        knowledge_chunks: this.db.prepare(`SELECT * FROM knowledge_chunks`).all(),
        queue_items: this.db.prepare(`SELECT * FROM queue_items`).all(),
        audit_logs: this.db.prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 500`).all(),
      },
      stats: this.getTableStats(),
    };
  }

  /**
   * Import and restore from JSON bundle with transaction safety
   */
  public importJsonBundle(bundle: any, mode: 'merge' | 'replace' = 'replace'): { success: boolean; importedCounts: Record<string, number> } {
    if (!bundle || !bundle.tables) {
      throw new Error('Invalid JSON backup bundle format');
    }

    const importedCounts: Record<string, number> = {};

    const txn = this.db.transaction(() => {
      if (mode === 'replace') {
        // Clear existing tables in correct order
        this.db.exec(`
          DELETE FROM knowledge_chunks;
          DELETE FROM knowledge_documents;
          DELETE FROM faq_items;
          DELETE FROM queue_items;
        `);
      }

      // 1. Config Settings
      if (Array.isArray(bundle.tables.config_settings)) {
        const insertConfig = this.db.prepare(`
          INSERT INTO config_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);
        for (const row of bundle.tables.config_settings) {
          insertConfig.run(row.key, row.value, row.updated_at || Date.now());
        }
        importedCounts['config_settings'] = bundle.tables.config_settings.length;
      }

      // 2. Prompt Profiles
      if (Array.isArray(bundle.tables.prompt_profiles)) {
        const insertPrompt = this.db.prepare(`
          INSERT INTO prompt_profiles (id, name, description, system_prompt, temperature, top_p, top_k, repeat_penalty, max_tokens, is_default, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            system_prompt = excluded.system_prompt,
            temperature = excluded.temperature,
            top_p = excluded.top_p,
            top_k = excluded.top_k,
            repeat_penalty = excluded.repeat_penalty,
            max_tokens = excluded.max_tokens,
            is_default = excluded.is_default,
            updated_at = excluded.updated_at
        `);
        for (const p of bundle.tables.prompt_profiles) {
          insertPrompt.run(
            p.id, p.name, p.description, p.system_prompt, p.temperature,
            p.top_p, p.top_k || 40, p.repeat_penalty || 1.1, p.max_tokens,
            p.is_default, p.updated_at || Date.now()
          );
        }
        importedCounts['prompt_profiles'] = bundle.tables.prompt_profiles.length;
      }

      // 3. FAQ Items
      if (Array.isArray(bundle.tables.faq_items)) {
        const insertFaq = this.db.prepare(`
          INSERT OR REPLACE INTO faq_items (id, question, answer, keywords, enabled, priority, match_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const f of bundle.tables.faq_items) {
          insertFaq.run(
            f.id || null, f.question, f.answer,
            typeof f.keywords === 'string' ? f.keywords : JSON.stringify(f.keywords),
            f.enabled !== undefined ? (f.enabled ? 1 : 0) : 1,
            f.priority || 0, f.match_count || 0, f.created_at || Date.now()
          );
        }
        importedCounts['faq_items'] = bundle.tables.faq_items.length;
      }

      // 4. Knowledge Documents & Chunks
      if (Array.isArray(bundle.tables.knowledge_documents)) {
        const insertDoc = this.db.prepare(`
          INSERT OR REPLACE INTO knowledge_documents (id, title, source_path, doc_type, doc_hash, total_chunks, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const d of bundle.tables.knowledge_documents) {
          insertDoc.run(d.id, d.title, d.source_path, d.doc_type, d.doc_hash, d.total_chunks, d.created_at, d.updated_at);
        }
        importedCounts['knowledge_documents'] = bundle.tables.knowledge_documents.length;
      }

      if (Array.isArray(bundle.tables.knowledge_chunks)) {
        const insertChunk = this.db.prepare(`
          INSERT OR REPLACE INTO knowledge_chunks (id, doc_id, chunk_index, content, metadata)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const c of bundle.tables.knowledge_chunks) {
          insertChunk.run(c.id, c.doc_id, c.chunk_index, c.content, c.metadata);
        }
        importedCounts['knowledge_chunks'] = bundle.tables.knowledge_chunks.length;
      }

      // 5. Queue Items (preserve history if provided)
      if (Array.isArray(bundle.tables.queue_items)) {
        const insertQueue = this.db.prepare(`
          INSERT OR IGNORE INTO queue_items (
            id, task_id, source, chat_id, user_id, message_id, raw_text, priority, status,
            retry_count, max_retries, error_log, deduplication_hash, created_at, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const q of bundle.tables.queue_items) {
          insertQueue.run(
            q.id, q.task_id, q.source, q.chat_id, q.user_id, q.message_id,
            q.raw_text, q.priority, q.status, q.retry_count, q.max_retries,
            q.error_log, q.deduplication_hash, q.created_at, q.started_at, q.completed_at
          );
        }
        importedCounts['queue_items'] = bundle.tables.queue_items.length;
      }
    });

    txn();

    this.logAudit('DATABASE_IMPORT_JSON', 'INFO', `Restored database from JSON bundle (${mode} mode).`);
    return { success: true, importedCounts };
  }

  /**
   * Replaces current database with an uploaded SQLite .db file after verifying integrity
   */
  public replaceDatabaseFile(newDbBuffer: Buffer): { success: boolean; details?: string } {
    // Validate SQLite 3 header (first 16 bytes: "SQLite format 3\0")
    const header = newDbBuffer.subarray(0, 16).toString('ascii');
    if (!header.startsWith('SQLite format 3')) {
      throw new Error('Invalid file format: Not a valid SQLite 3 database');
    }

    const currentPath = (this.db as any).name as string;
    const tempPath = currentPath + '.tmp_import';

    // Write buffer to temp path
    fs.writeFileSync(tempPath, newDbBuffer);

    // Verify temp database integrity
    try {
      const testDb = new Database(tempPath);
      const testPragma = testDb.pragma('integrity_check') as any[];
      testDb.close();

      const isOk = testPragma.length > 0 && String(testPragma[0].integrity_check).toLowerCase() === 'ok';
      if (!isOk) {
        fs.unlinkSync(tempPath);
        throw new Error('Integrity check failed on uploaded SQLite database');
      }

      // Close current DB, replace file, reopen
      this.db.close();

      // Remove WAL files if present
      if (fs.existsSync(currentPath + '-wal')) fs.unlinkSync(currentPath + '-wal');
      if (fs.existsSync(currentPath + '-shm')) fs.unlinkSync(currentPath + '-shm');

      fs.renameSync(tempPath, currentPath);

      // Reopen connection
      this.db = new Database(currentPath);
      this.configure();
      this.logAudit('DATABASE_IMPORT_SQLITE', 'INFO', 'Successfully replaced active database from uploaded SQLite file.');
      return { success: true };
    } catch (err: any) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      throw err;
    }
  }

  public getSettings(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM config_settings`).all() as any[];
    const map: Record<string, string> = {};
    for (const r of rows) {
      map[r.key] = r.value;
    }
    return map;
  }

  public updateSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO config_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }
}
