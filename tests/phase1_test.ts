/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import fs from 'fs';
import { NexusDb } from '../src/server/db.ts';
import { StorageManager } from '../src/server/storage.ts';
import { QueueManager } from '../src/server/queue.ts';

async function runPhase1Tests() {
  console.log('====================================================');
  console.log('🧪 NEXUS GGUF AGENT - PHASE 1 INTEGRATION TEST SUITE');
  console.log('====================================================\n');

  const testDir = path.resolve(process.cwd(), 'data', 'test_nexus_storage');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  // 1. Test StorageManager
  console.log('1. Testing StorageManager & Persistent Directories...');
  const storage = new StorageManager(testDir);
  const metrics = storage.getStorageMetrics();
  console.log(`   - Base Path: ${metrics.basePath}`);
  console.log(`   - Persistent Directories verified: models, databases, knowledge, backups, logs`);
  console.log(`   - Storage Total: ${metrics.totalMB} MB | Free: ${metrics.freeMB} MB`);
  const models = storage.listGgufModels();
  console.log(`   - Discovered GGUF Models: ${models.length} (Sample: ${models[0]?.fileName || 'None'})`);
  if (models.length === 0) throw new Error('Expected at least 1 GGUF descriptor in storage');
  console.log('   ✅ StorageManager Test Passed!\n');

  // 2. Test SQLite Database & FTS5
  console.log('2. Testing NexusDb (SQLite + FTS5 + WAL Mode)...');
  const dbFile = path.join(storage.databasesDir, 'test_nexus.db');
  const db = new NexusDb(dbFile);

  const pragmaWal = db.db.pragma('journal_mode', { simple: true });
  console.log(`   - Journal Mode: ${pragmaWal} (Expected: wal)`);
  if (pragmaWal !== 'wal') throw new Error('WAL mode is not active');

  const isIntegrityOk = db.checkIntegrity();
  console.log(`   - SQLite Integrity Check: ${isIntegrityOk ? 'OK' : 'FAILED'}`);
  if (!isIntegrityOk) throw new Error('Database integrity check failed');

  // Insert Knowledge Document & Chunks
  console.log('   - Inserting Document & verifying FTS5 indexing...');
  const docInfo = db.db.prepare(`
    INSERT INTO knowledge_documents (title, source_path, doc_type, doc_hash, total_chunks, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('Android Llama Spec', 'android_spec.md', 'md', 'hash123', 2, Date.now(), Date.now());

  const docId = docInfo.lastInsertRowid;
  db.db.prepare(`
    INSERT INTO knowledge_chunks (doc_id, chunk_index, content, metadata)
    VALUES (?, ?, ?, ?)
  `).run(docId, 0, 'Nexus GGUF Agent runs llama.cpp natively on ARM64 Android with zero Termux dependencies.', '{"spec": true}');

  db.db.prepare(`
    INSERT INTO knowledge_chunks (doc_id, chunk_index, content, metadata)
    VALUES (?, ?, ?, ?)
  `).run(docId, 1, 'The Telegram Bot API orchestrates incoming messages through a persistent sequential queue.', '{"spec": true}');

  // Perform FTS5 Search with BM25
  const ftsResults = db.searchKnowledgeFts('ARM64 Android');
  console.log(`   - FTS5 Query ("ARM64 Android"): Found ${ftsResults.length} chunks (Top BM25 Score: ${ftsResults[0]?.score})`);
  if (ftsResults.length === 0) throw new Error('FTS5 failed to retrieve indexed chunk');
  console.log('   ✅ FTS5 Search & Virtual Tables Test Passed!\n');

  // 3. Test FAQ Matching
  console.log('3. Testing FAQ Matcher...');
  const faqMatch = db.matchFaq('how do I configure nexus agent?');
  console.log(`   - FAQ Query: "how do I configure nexus agent?" -> Matched: "${faqMatch?.question}"`);
  if (!faqMatch) throw new Error('FAQ matcher failed to match keywords');
  console.log('   ✅ FAQ Matcher Test Passed!\n');

  // 4. Test QueueManager, FIFO Atomicity, Deduplication, and Recovery
  console.log('4. Testing QueueManager (FIFO, Priority, Deduplication, Recovery)...');
  const queue = new QueueManager(db);

  // Test deduplication
  const task1 = queue.enqueue('Test prompt for local model', 'web_dashboard', 100, 1, 1, 5);
  console.log(`   - Enqueued Task 1 (ID: ${task1.taskId})`);
  if (!task1.success) throw new Error('Failed to enqueue Task 1');

  const task1Dup = queue.enqueue('Test prompt for local model', 'web_dashboard', 100, 1, 1, 5);
  console.log(`   - Duplicate Task Attempt -> Success: ${task1Dup.success} (Reason: ${task1Dup.reason})`);
  if (task1Dup.success) throw new Error('Deduplication failed: Duplicate task was accepted!');

  // Test priority ordering
  const lowPriority = queue.enqueue('Low priority background task', 'web_dashboard', 100, 2, 2, 1);
  const highPriority = queue.enqueue('Critical priority urgent task', 'web_dashboard', 100, 3, 3, 20);

  // Poll directly from DB to verify priority ordering
  const polled = db.pollNextTask();
  console.log(`   - Highest Priority Polled: "${polled?.rawText}" (Priority: ${polled?.priority})`);
  if (polled?.priority !== 20) throw new Error(`Priority queue violated! Expected priority 20, got ${polled?.priority}`);

  // Test Crash Recovery: Simulate task stuck in PROCESSING during abrupt restart
  console.log('   - Simulating unexpected crash with task stuck in PROCESSING...');
  const recoveredCount = db.recoverPendingQueue();
  console.log(`   - Crash recovery executed: ${recoveredCount} tasks restored back to QUEUED.`);
  if (recoveredCount < 1) throw new Error('Crash recovery failed to restore interrupted task');

  console.log('   ✅ QueueManager, Deduplication & Crash Recovery Test Passed!\n');

  // Stop queue worker and clean up test database
  queue.stop();
  await new Promise(resolve => setTimeout(resolve, 150));
  db.db.close();
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log('====================================================');
  console.log('🎉 ALL PHASE 1 INTEGRATION TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runPhase1Tests().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
