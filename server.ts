/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { NexusDb } from './src/server/db.ts';
import { StorageManager } from './src/server/storage.ts';
import { QueueManager } from './src/server/queue.ts';
import { createApiRouter } from './src/server/routes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // CORS middleware for AI Studio preview & iframe proxy compatibility
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // JSON Body parsing with 10MB limit for knowledge imports & backup restores
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Initialize Storage, SQLite Database & Queue
  const storage = new StorageManager();
  const dbFile = path.join(storage.databasesDir, 'nexus_agent.db');
  const db = new NexusDb(dbFile);
  const queue = new QueueManager(db);

  // Mount API router at /api
  app.use('/api', createApiRouter(db, storage, queue));

  // In development, hook Vite middlewares
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // In production, serve dist folder
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Nexus Daemon] Running on http://0.0.0.0:${PORT}`);
    console.log(`[Nexus Storage] Persistent path: ${storage.baseDir}`);
  });
}

startServer().catch(err => {
  console.error('[Nexus Daemon] Fatal startup error:', err);
  process.exit(1);
});
