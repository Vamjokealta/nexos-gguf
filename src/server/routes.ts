/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { NexusDb } from './db.ts';
import { StorageManager } from './storage.ts';
import { QueueManager } from './queue.ts';
import { DaemonStatus } from './types.ts';

export function createApiRouter(db: NexusDb, storage: StorageManager, queue: QueueManager): Router {
  const router = Router();
  const startTime = Date.now();

  // 1. Telemetry & Health Status
  router.get('/status', (req: Request, res: Response) => {
    const mem = process.memoryUsage();
    const stats = queue.getQueueStats();
    const settings = db.getSettings();

    const status: DaemonStatus = {
      status: 'ONLINE',
      uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
      ramUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
      ramTotalMB: Math.round(mem.heapTotal / (1024 * 1024)),
      modelLoaded: false,
      activeModelName: settings['active_model'] || 'nexus-qwen2.5-0.5b-instruct-q4_k_m.gguf',
      queuePendingCount: stats.pending,
      queueProcessingCount: stats.processing,
      queueCompletedCount: stats.completed,
      queueFailedCount: stats.failed,
      telegramConnected: settings['telegram_bot_enabled'] === 'true',
      telegramMode: settings['telegram_bot_enabled'] === 'true' ? 'BOT_API' : 'DISCONNECTED',
    };

    res.json(status);
  });

  // 2. Real-Time Telemetry Stream (SSE)
  router.get('/stream/telemetry', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
      const mem = process.memoryUsage();
      const stats = queue.getQueueStats();
      const payload = {
        timestamp: Date.now(),
        ramUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
        tokensPerSecond: 0.0,
        queuePending: stats.pending,
        queueProcessing: stats.processing,
        activeTaskId: stats.activeTask?.taskId || null,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }, 1000);

    req.on('close', () => {
      clearInterval(interval);
    });
  });

  // 3. Storage & Models
  router.get('/storage', (req: Request, res: Response) => {
    res.json(storage.getStorageMetrics());
  });

  router.get('/models', (req: Request, res: Response) => {
    res.json(storage.listGgufModels());
  });

  // 4. Queue Endpoints
  router.get('/queue', (req: Request, res: Response) => {
    const items = db.db.prepare(`
      SELECT id, task_id as taskId, source, raw_text as rawText, priority, status,
             retry_count as retryCount, max_retries as maxRetries, error_log as errorLog,
             created_at as createdAt, started_at as startedAt, completed_at as completedAt
      FROM queue_items
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const stats = queue.getQueueStats();
    res.json({ items, stats });
  });

  router.post('/queue', (req: Request, res: Response) => {
    const { text, source = 'web_dashboard', priority = 5 } = req.body;
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Text prompt is required' });
      return;
    }

    const result = queue.enqueue(text, source, 0, 0, 0, Number(priority));
    if (result.success) {
      res.status(201).json(result);
    } else {
      res.status(409).json(result);
    }
  });

  router.post('/queue/clear', (req: Request, res: Response) => {
    queue.clearFinished();
    res.json({ success: true });
  });

  router.post('/queue/retry', (req: Request, res: Response) => {
    const { taskId } = req.body;
    const ok = queue.retryTask(taskId);
    res.json({ success: ok });
  });

  router.post('/queue/cancel', (req: Request, res: Response) => {
    const { taskId } = req.body;
    const ok = queue.cancelTask(taskId);
    res.json({ success: ok });
  });

  router.post('/queue/pause', (req: Request, res: Response) => {
    queue.pause();
    res.json({ success: true, isPaused: true });
  });

  router.post('/queue/resume', (req: Request, res: Response) => {
    queue.resume();
    res.json({ success: true, isPaused: false });
  });

  // 5. Knowledge Base & FTS5
  router.get('/knowledge', (req: Request, res: Response) => {
    const docs = db.db.prepare(`
      SELECT id, title, source_path as sourcePath, doc_type as docType,
             doc_hash as docHash, total_chunks as totalChunks,
             created_at as createdAt, updated_at as updatedAt
      FROM knowledge_documents
      ORDER BY id DESC
    `).all();
    res.json(docs);
  });

  router.post('/knowledge/import', (req: Request, res: Response) => {
    const { title, content, docType = 'txt' } = req.body;
    if (!title || !content) {
      res.status(400).json({ error: 'Title and content are required' });
      return;
    }

    const docHash = Buffer.from(content).toString('base64').substring(0, 32);
    const existing = db.db.prepare(`SELECT id FROM knowledge_documents WHERE doc_hash = ?`).get(docHash);
    if (existing) {
      res.status(409).json({ error: 'Document already imported (duplicate content)' });
      return;
    }

    // Save document and chunk it
    const filename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${docType}`;
    storage.saveKnowledgeFile(filename, content);

    const now = Date.now();
    const docInfo = db.db.prepare(`
      INSERT INTO knowledge_documents (title, source_path, doc_type, doc_hash, total_chunks, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(title, filename, docType, docHash, now, now);

    const docId = docInfo.lastInsertRowid;

    // Simple paragraph/line chunking for Phase 1
    const chunks = content.split(/\n\s*\n/).filter((c: string) => c.trim().length > 0);
    const insertChunk = db.db.prepare(`
      INSERT INTO knowledge_chunks (doc_id, chunk_index, content, metadata)
      VALUES (?, ?, ?, ?)
    `);

    chunks.forEach((chunkText: string, idx: number) => {
      insertChunk.run(docId, idx, chunkText.trim(), JSON.stringify({ source: title, docId }));
    });

    db.db.prepare(`UPDATE knowledge_documents SET total_chunks = ? WHERE id = ?`).run(chunks.length, docId);
    db.logAudit('KNOWLEDGE_IMPORT', 'INFO', `Imported document "${title}" with ${chunks.length} chunks.`);

    res.status(201).json({ success: true, docId, totalChunks: chunks.length });
  });

  router.post('/knowledge/search', (req: Request, res: Response) => {
    const { query, limit = 5 } = req.body;
    const results = db.searchKnowledgeFts(query, Number(limit));
    res.json(results);
  });

  router.delete('/knowledge/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    db.db.prepare(`DELETE FROM knowledge_documents WHERE id = ?`).run(id);
    db.logAudit('KNOWLEDGE_DELETE', 'INFO', `Deleted knowledge document ID ${id}.`);
    res.json({ success: true });
  });

  // 6. Predefined FAQ Management
  router.get('/faq', (req: Request, res: Response) => {
    const items = db.db.prepare(`
      SELECT id, question, answer, keywords, enabled, priority, match_count as matchCount, created_at as createdAt
      FROM faq_items
      ORDER BY priority DESC, id ASC
    `).all().map((r: any) => ({
      ...r,
      enabled: r.enabled === 1,
      keywords: JSON.parse(r.keywords || '[]'),
    }));
    res.json(items);
  });

  router.post('/faq', (req: Request, res: Response) => {
    const { question, answer, keywords = [], priority = 0 } = req.body;
    if (!question || !answer) {
      res.status(400).json({ error: 'Question and answer are required' });
      return;
    }

    const info = db.db.prepare(`
      INSERT INTO faq_items (question, answer, keywords, enabled, priority, match_count, created_at)
      VALUES (?, ?, ?, 1, ?, 0, ?)
    `).run(question, answer, JSON.stringify(keywords), priority, Date.now());

    res.status(201).json({ success: true, id: info.lastInsertRowid });
  });

  router.delete('/faq/:id', (req: Request, res: Response) => {
    const { id } = req.params;
    db.db.prepare(`DELETE FROM faq_items WHERE id = ?`).run(id);
    res.json({ success: true });
  });

  // 7. System Prompts Profiles
  router.get('/prompts', (req: Request, res: Response) => {
    const profiles = db.db.prepare(`
      SELECT id, name, description, system_prompt as systemPrompt,
             temperature, top_p as topP, top_k as topK, repeat_penalty as repeatPenalty,
             max_tokens as maxTokens, is_default as isDefault, updated_at as updatedAt
      FROM prompt_profiles
      ORDER BY is_default DESC, name ASC
    `).all().map((r: any) => ({
      ...r,
      isDefault: r.isDefault === 1,
    }));
    res.json(profiles);
  });

  router.post('/prompts', (req: Request, res: Response) => {
    const { id, name, description, systemPrompt, temperature, topP, maxTokens, isDefault } = req.body;
    if (!id || !name || !systemPrompt) {
      res.status(400).json({ error: 'ID, name, and systemPrompt are required' });
      return;
    }

    if (isDefault) {
      db.db.prepare(`UPDATE prompt_profiles SET is_default = 0`).run();
    }

    db.db.prepare(`
      INSERT INTO prompt_profiles (id, name, description, system_prompt, temperature, top_p, max_tokens, is_default, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        system_prompt = excluded.system_prompt,
        temperature = excluded.temperature,
        top_p = excluded.top_p,
        max_tokens = excluded.max_tokens,
        is_default = excluded.is_default,
        updated_at = excluded.updated_at
    `).run(
      id,
      name,
      description || '',
      systemPrompt,
      temperature || 0.7,
      topP || 0.9,
      maxTokens || 512,
      isDefault ? 1 : 0,
      Date.now()
    );

    res.json({ success: true });
  });

  // 8. General Settings
  router.get('/settings', (req: Request, res: Response) => {
    res.json(db.getSettings());
  });

  router.post('/settings', (req: Request, res: Response) => {
    const settings = req.body;
    if (typeof settings !== 'object') {
      res.status(400).json({ error: 'Invalid settings body' });
      return;
    }
    for (const [k, v] of Object.entries(settings)) {
      db.updateSetting(k, String(v));
    }
    res.json({ success: true });
  });

  // 9. Audit Logs
  router.get('/logs', (req: Request, res: Response) => {
    const limit = Number(req.query.limit) || 100;
    const logs = db.db.prepare(`
      SELECT id, event_type as eventType, level, details, timestamp
      FROM audit_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    res.json(logs);
  });

  // 10. Database Integrity & Maintenance
  router.post('/system/integrity', (req: Request, res: Response) => {
    const isOk = db.checkIntegrity();
    db.vacuum();
    res.json({ integrity: isOk ? 'OK' : 'CORRUPTED' });
  });

  // 11. Database Stats & Table Metrics
  router.get('/backup/stats', (req: Request, res: Response) => {
    const stats = db.getTableStats();
    let dbSizeBytes = 0;
    try {
      const dbPath = (db.db as any).name;
      if (fs.existsSync(dbPath)) {
        dbSizeBytes = fs.statSync(dbPath).size;
      }
    } catch {}

    res.json({
      stats,
      dbSizeBytes,
      dbSizeKB: Math.round(dbSizeBytes / 1024),
    });
  });

  // 12. Backup Export (JSON Bundle & Raw SQLite DB)
  router.get('/backup/export/json', (req: Request, res: Response) => {
    const bundle = db.exportJsonBundle();
    const filename = `nexus_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(bundle, null, 2));
  });

  router.get('/backup/export/db', (req: Request, res: Response) => {
    const dbPath = db.checkpointAndGetDbPath();
    const filename = `nexus_agent_${new Date().toISOString().slice(0, 10)}.db`;
    res.download(dbPath, filename, (err) => {
      if (err) {
        console.error('Error downloading DB:', err);
      } else {
        db.logAudit('DATABASE_EXPORT_SQLITE', 'INFO', 'Exported raw SQLite database file.');
      }
    });
  });

  // Legacy route compatibility
  router.get('/backup', (req: Request, res: Response) => {
    const bundle = db.exportJsonBundle();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="nexus_backup.json"');
    res.send(JSON.stringify(bundle, null, 2));
  });

  // 13. Backup Import (JSON Bundle & Raw SQLite DB)
  router.post('/backup/import/json', (req: Request, res: Response) => {
    const { bundle, mode = 'replace' } = req.body;
    if (!bundle) {
      res.status(400).json({ error: 'Missing backup bundle payload' });
      return;
    }

    try {
      const result = db.importJsonBundle(bundle, mode);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'JSON Import failed' });
    }
  });

  router.post('/backup/import/db', (req: Request, res: Response) => {
    const { base64Data } = req.body;
    if (!base64Data || typeof base64Data !== 'string') {
      res.status(400).json({ error: 'Missing base64Data of the SQLite database' });
      return;
    }

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      const result = db.replaceDatabaseFile(buffer);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'SQLite Database file import failed' });
    }
  });

  // 14. Android APK Package & Build Automation Generator
  router.get('/apk/package', (req: Request, res: Response) => {
    const zipPath = path.resolve(process.cwd(), 'nexus-gguf-agent-android-source.zip');

    try {
      // Build zip of android directory, build files, gradle wrapper config, and workflow
      execSync(`zip -r -q "${zipPath}" android README.md build.gradle.kts settings.gradle.kts gradle .github`, { cwd: process.cwd() });
      res.download(zipPath, 'nexus-gguf-agent-android-source.zip');
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to create android source package: ' + err.message });
    }
  });

  return router;
}
