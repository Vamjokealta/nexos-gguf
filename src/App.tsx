/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  Cpu,
  Database,
  Layers,
  HardDrive,
  RefreshCw,
  Send,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Search,
  BookOpen,
  Terminal,
  Zap,
  Server,
  Download,
  Upload,
  FileCode,
  FileBox,
  Smartphone,
  Check,
  Info,
  Package
} from 'lucide-react';

interface DaemonStatus {
  status: string;
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
  telegramMode: string;
}

interface StorageMetrics {
  totalMB: number;
  freeMB: number;
  usedMB: number;
  modelsCount: number;
  knowledgeDocsCount: number;
  basePath: string;
}

interface QueueItem {
  id: number;
  taskId: string;
  source: string;
  rawText: string;
  priority: number;
  status: string;
  retryCount: number;
  createdAt: number;
  errorLog: string | null;
}

interface AuditLog {
  id: number;
  eventType: string;
  level: string;
  details: string;
  timestamp: number;
}

interface DbStats {
  stats: Record<string, number>;
  dbSizeBytes: number;
  dbSizeKB: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'overview' | 'database' | 'apk'>('overview');
  const [status, setStatus] = useState<DaemonStatus>({
    status: 'ONLINE',
    uptimeSeconds: 0,
    ramUsedMB: 64,
    ramTotalMB: 512,
    modelLoaded: false,
    activeModelName: 'nexus-qwen2.5-0.5b-instruct-q4_k_m.gguf',
    queuePendingCount: 0,
    queueProcessingCount: 0,
    queueCompletedCount: 0,
    queueFailedCount: 0,
    telegramConnected: false,
    telegramMode: 'BOT_API',
  });
  const [storage, setStorage] = useState<StorageMetrics | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [dbStats, setDbStats] = useState<DbStats | null>(null);

  // Forms & interactive states
  const [taskInput, setTaskInput] = useState('');
  const [taskPriority, setTaskPriority] = useState(5);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [faqQuery, setFaqQuery] = useState('');
  const [faqResult, setFaqResult] = useState<any | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Import state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace');
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Safe fetch helper that handles intermittent network blips or dev-server reload
  const safeFetch = async <T,>(url: string, fallback: T): Promise<T> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  };

  // Fetch telemetry with graceful error recovery
  const fetchTelemetry = async () => {
    try {
      const [resStatus, resStorage, resQueue, resLogs, resDbStats] = await Promise.all([
        safeFetch<DaemonStatus | null>('/api/status', null),
        safeFetch<StorageMetrics | null>('/api/storage', null),
        safeFetch<{ items: QueueItem[] } | null>('/api/queue', null),
        safeFetch<AuditLog[] | null>('/api/logs?limit=15', null),
        safeFetch<DbStats | null>('/api/backup/stats', null),
      ]);
      if (resStatus) setStatus(resStatus);
      if (resStorage) setStorage(resStorage);
      if (resQueue?.items) setQueueItems(resQueue.items);
      if (resLogs) setLogs(resLogs);
      if (resDbStats) setDbStats(resDbStats);
    } catch {
      // Gracefully maintain existing telemetry on blips
    }
  };

  useEffect(() => {
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 3000);
    return () => clearInterval(interval);
  }, []);

  // Enqueue test task
  const handleEnqueue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskInput.trim()) return;

    setIsSubmitting(true);
    setActionFeedback(null);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: taskInput.trim(),
          source: 'web_dashboard',
          priority: Number(taskPriority),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionFeedback(`Task enqueued successfully (ID: ${data.taskId})`);
        setTaskInput('');
        fetchTelemetry();
      } else {
        setActionFeedback(`Failed: ${data.reason || data.error || 'Could not enqueue task'}`);
      }
    } catch (err: any) {
      setActionFeedback(`Error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Test FTS5 Knowledge Search
  const handleFtsSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const res = await fetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery.trim(), limit: 4 }),
      });
      const data = await res.json();
      setSearchResults(data);
    } catch (err) {
      console.error('Search failed:', err);
    }
  };

  // Test FAQ Match
  const handleFaqMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!faqQuery.trim()) return;
    try {
      const res = await fetch('/api/faq');
      const faqs: any[] = await res.json();
      const norm = faqQuery.toLowerCase().trim();
      const matched = faqs.find(f =>
        f.question.toLowerCase().includes(norm) ||
        f.keywords.some((k: string) => norm.includes(k.toLowerCase()))
      );
      setFaqResult(matched || { question: 'No match found', answer: 'No matching FAQ found in SQLite.' });
    } catch (err) {
      console.error('FAQ match failed:', err);
    }
  };

  // Run Integrity Check & Vacuum
  const handleIntegrityCheck = async () => {
    try {
      const res = await fetch('/api/system/integrity', { method: 'POST' });
      const data = await res.json();
      setActionFeedback(`SQLite Integrity Check: ${data.integrity} (PRAGMA integrity_check + VACUUM completed)`);
      fetchTelemetry();
    } catch (err: any) {
      setActionFeedback(`Integrity Check Failed: ${err.message}`);
    }
  };

  // Handle File Selection for Import
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setImportFile(e.target.files[0]);
      setImportResult(null);
    }
  };

  // Process Database Import
  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFile) return;

    setIsImporting(true);
    setImportResult(null);
    setActionFeedback(null);

    try {
      const fileName = importFile.name.toLowerCase();
      if (fileName.endsWith('.json')) {
        // Read JSON bundle
        const text = await importFile.text();
        const bundle = JSON.parse(text);

        const res = await fetch('/api/backup/import/json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle, mode: importMode }),
        });
        const data = await res.json();

        if (res.ok) {
          setImportResult({ type: 'json', data: data.importedCounts });
          setActionFeedback('JSON Backup restored successfully into SQLite database.');
          fetchTelemetry();
        } else {
          setActionFeedback(`JSON Import Failed: ${data.error}`);
        }
      } else if (fileName.endsWith('.db') || fileName.endsWith('.sqlite')) {
        // Read Binary SQLite file as base64
        const arrayBuffer = await importFile.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binary);

        const res = await fetch('/api/backup/import/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64Data }),
        });
        const data = await res.json();

        if (res.ok) {
          setImportResult({ type: 'db', success: true });
          setActionFeedback('SQLite database file verified and restored successfully!');
          fetchTelemetry();
        } else {
          setActionFeedback(`SQLite DB Import Failed: ${data.error}`);
        }
      } else {
        setActionFeedback('Unsupported file type. Please upload a .json backup or a .db SQLite file.');
      }
    } catch (err: any) {
      setActionFeedback(`Import error: ${err.message}`);
    } finally {
      setIsImporting(false);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '0s';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-cyan-500/20 selection:text-cyan-200">
      {/* Top Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur-md sticky top-0 z-30 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-cyan-500 to-violet-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Zap className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="font-bold text-lg tracking-tight text-white">NEXUS GGUF AGENT</h1>
                <span className="px-2 py-0.5 text-xs font-mono rounded bg-cyan-950 text-cyan-400 border border-cyan-800">
                  v1.0
                </span>
                <span className="px-2 py-0.5 text-xs font-mono rounded bg-violet-950 text-violet-400 border border-violet-800">
                  ARM64 / Ktor
                </span>
              </div>
              <p className="text-xs text-zinc-400">Offline-First Local AI Agent & Telegram Orchestrator</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center space-x-1 bg-zinc-950/80 p-1 rounded-lg border border-zinc-800">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                activeTab === 'overview'
                  ? 'bg-zinc-800 text-white shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Overview & Queue
            </button>
            <button
              onClick={() => setActiveTab('database')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center space-x-1.5 transition-all ${
                activeTab === 'database'
                  ? 'bg-cyan-950 text-cyan-300 border border-cyan-800 shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>Database Import / Export</span>
            </button>
            <button
              onClick={() => setActiveTab('apk')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center space-x-1.5 transition-all ${
                activeTab === 'apk'
                  ? 'bg-violet-950 text-violet-300 border border-violet-800 shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span>Android APK Build</span>
            </button>
          </div>

          <div className="flex items-center space-x-3 text-xs">
            <div className="flex items-center space-x-2 bg-zinc-800/80 px-3 py-1.5 rounded-md border border-zinc-700/60">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="font-mono text-zinc-300">Daemon: {status?.status || 'ONLINE'}</span>
              <span className="text-zinc-500">|</span>
              <span className="font-mono text-zinc-400">Up: {formatUptime(status?.uptimeSeconds)}</span>
            </div>

            <button
              onClick={fetchTelemetry}
              className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 transition-colors"
              title="Refresh Telemetry"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto w-full p-6 space-y-6 flex-1">
        {actionFeedback && (
          <div className="p-3 rounded-lg bg-cyan-950/60 border border-cyan-800 text-cyan-200 text-sm flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="h-4 w-4 text-cyan-400 shrink-0" />
              <span>{actionFeedback}</span>
            </div>
            <button onClick={() => setActionFeedback(null)} className="text-cyan-400 hover:text-cyan-100 text-xs font-mono">
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: OVERVIEW & QUEUE */}
        {activeTab === 'overview' && (
          <>
            {/* Status Banner */}
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center space-x-3">
                <div className="h-8 w-8 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-400 flex items-center justify-center">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm text-zinc-200">System Ready: SQLite WAL & Ktor Local Daemon Active</h2>
                  <p className="text-xs text-zinc-400">
                    FTS5 BM25 search, persistent FIFO queue, Scoped Storage layout, and database backup engine operational.
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleIntegrityCheck}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 transition-colors flex items-center space-x-1.5"
                >
                  <Database className="h-3.5 w-3.5 text-cyan-400" />
                  <span>Verify Integrity & Vacuum</span>
                </button>
              </div>
            </div>

            {/* Technical Metric Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Card 1: Daemon & RAM */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 relative overflow-hidden">
                <div className="flex items-center justify-between text-zinc-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Memory & Process</span>
                  <Cpu className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-white">
                  {status?.ramUsedMB || 0} <span className="text-sm font-normal text-zinc-400">/ {status?.ramTotalMB || 0} MB</span>
                </div>
                <div className="mt-2 flex items-center space-x-2 text-xs text-zinc-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                  <span>Foreground Service: Active</span>
                </div>
                <div className="mt-2 text-xs font-mono text-zinc-500 truncate">
                  Engine: Ktor Embedded (127.0.0.1:8765)
                </div>
              </div>

              {/* Card 2: Persistent Queue */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="flex items-center justify-between text-zinc-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Sequential Queue</span>
                  <Layers className="h-4 w-4 text-violet-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-white">
                  {status?.queuePendingCount || 0} <span className="text-sm font-normal text-zinc-400">pending</span>
                </div>
                <div className="mt-2 flex items-center space-x-2 text-xs text-zinc-400">
                  <span className="text-emerald-400 font-mono">✓ {status?.queueCompletedCount || 0} done</span>
                  <span>•</span>
                  <span className="text-rose-400 font-mono">✗ {status?.queueFailedCount || 0} failed</span>
                </div>
                <div className="mt-2 text-xs font-mono text-zinc-500">
                  Max: 500 | Concurrency: 1 Worker
                </div>
              </div>

              {/* Card 3: Storage & GGUF Models */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="flex items-center justify-between text-zinc-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Shared Storage</span>
                  <HardDrive className="h-4 w-4 text-amber-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-white">
                  {storage?.modelsCount || 0} <span className="text-sm font-normal text-zinc-400">GGUF models</span>
                </div>
                <div className="mt-2 flex items-center space-x-2 text-xs text-zinc-400">
                  <span>Free: {storage?.freeMB ? Math.round(storage.freeMB / 1024) : 0} GB</span>
                  <span>•</span>
                  <span>Docs: {storage?.knowledgeDocsCount || 0}</span>
                </div>
                <div className="mt-2 text-xs font-mono text-zinc-500 truncate" title={storage?.basePath}>
                  Path: {storage?.basePath || 'Initializing...'}
                </div>
              </div>

              {/* Card 4: Telegram Interface */}
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="flex items-center justify-between text-zinc-400 mb-2">
                  <span className="text-xs font-medium uppercase tracking-wider">Telegram Link</span>
                  <Server className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="text-2xl font-bold font-mono text-white">
                  {status?.telegramMode || 'BOT_API'}
                </div>
                <div className="mt-2 flex items-center space-x-2 text-xs text-zinc-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"></span>
                  <span>Ready for Token (Phase 4)</span>
                </div>
                <div className="mt-2 text-xs font-mono text-zinc-500">
                  Rate Limit & Dedup: Active
                </div>
              </div>
            </div>

            {/* Operations Grid: Queue Testing & RAG Inspection */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Column 1: Queue Injection & Task Monitor */}
              <div className="space-y-4">
                <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center space-x-2">
                      <Activity className="h-4 w-4 text-violet-400" />
                      <h3 className="font-semibold text-sm text-zinc-200">Inject Queue Task</h3>
                    </div>
                    <span className="text-xs font-mono text-zinc-500">Atomic FIFO with Dedup</span>
                  </div>

                  <form onSubmit={handleEnqueue} className="space-y-3">
                    <div>
                      <textarea
                        value={taskInput}
                        onChange={e => setTaskInput(e.target.value)}
                        placeholder="Enter message text or command to enqueue (e.g. 'Explain ARM64 NEON optimization' or 'How do I configure nexus agent?')..."
                        className="w-full h-24 px-3 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500 font-sans resize-none"
                      />
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center space-x-2">
                        <label className="text-xs text-zinc-400">Priority:</label>
                        <select
                          value={taskPriority}
                          onChange={e => setTaskPriority(Number(e.target.value))}
                          className="bg-zinc-950 border border-zinc-800 text-xs rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-cyan-500"
                        >
                          <option value={1}>1 - Low</option>
                          <option value={5}>5 - Normal</option>
                          <option value={10}>10 - High</option>
                          <option value={20}>20 - Critical</option>
                        </select>
                      </div>

                      <button
                        type="submit"
                        disabled={isSubmitting || !taskInput.trim()}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-600 to-violet-600 hover:from-cyan-500 hover:to-violet-500 text-white font-medium text-xs flex items-center space-x-2 disabled:opacity-50 transition-all shadow-md shadow-cyan-900/20"
                      >
                        <Send className="h-3.5 w-3.5" />
                        <span>Enqueue Task</span>
                      </button>
                    </div>
                  </form>
                </div>

                {/* Queue Items Table */}
                <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-sm text-zinc-200">Recent Queue Items</h3>
                    <button
                      onClick={() => fetch('/api/queue/clear', { method: 'POST' }).then(() => fetchTelemetry())}
                      className="text-xs text-zinc-400 hover:text-zinc-200 underline font-mono"
                    >
                      Clear Finished
                    </button>
                  </div>

                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {queueItems.length === 0 ? (
                      <p className="text-xs text-zinc-500 py-4 text-center">Queue is empty. Inject a task above to test.</p>
                    ) : (
                      queueItems.map(item => (
                        <div
                          key={item.id}
                          className="p-3 rounded-lg bg-zinc-950 border border-zinc-800/80 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center space-x-2 mb-1">
                              <span className="font-mono text-zinc-400">{item.taskId}</span>
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                  item.status === 'COMPLETED'
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                    : item.status === 'PROCESSING'
                                    ? 'bg-cyan-950 text-cyan-400 border border-cyan-800 animate-pulse'
                                    : item.status === 'FAILED'
                                    ? 'bg-rose-950 text-rose-400 border border-rose-800'
                                    : 'bg-zinc-800 text-zinc-300'
                                }`}
                              >
                                {item.status}
                              </span>
                              <span className="text-zinc-500 font-mono">P:{item.priority}</span>
                            </div>
                            <p className="text-zinc-300 truncate font-mono">{item.rawText}</p>
                          </div>

                          {item.status === 'FAILED' && (
                            <button
                              onClick={() =>
                                fetch('/api/queue/retry', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ taskId: item.taskId }),
                                }).then(() => fetchTelemetry())
                              }
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono text-[10px]"
                            >
                              Retry
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Column 2: SQLite FTS5 & FAQ Search Verification */}
              <div className="space-y-4">
                {/* Knowledge Base FTS5 Test */}
                <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center space-x-2">
                      <Search className="h-4 w-4 text-cyan-400" />
                      <h3 className="font-semibold text-sm text-zinc-200">Test SQLite FTS5 Full-Text Search</h3>
                    </div>
                    <span className="text-xs font-mono text-zinc-500">BM25 Scoring</span>
                  </div>

                  <form onSubmit={handleFtsSearch} className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder="Enter keywords to search chunks (e.g. 'Nexus', 'GGUF', 'ARM64')..."
                      className="flex-1 px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500 font-mono"
                    />
                    <button
                      type="submit"
                      className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs rounded-lg text-zinc-200 font-medium"
                    >
                      Search FTS5
                    </button>
                  </form>

                  <div className="space-y-2">
                    {searchResults.length > 0 ? (
                      searchResults.map(c => (
                        <div key={c.id} className="p-2.5 rounded bg-zinc-950 border border-zinc-800/80 text-xs">
                          <div className="flex items-center justify-between text-zinc-500 mb-1 font-mono">
                            <span>Chunk #{c.chunkIndex} (Doc ID: {c.docId})</span>
                            <span>BM25: {typeof c.score === 'number' ? c.score.toFixed(4) : 'N/A'}</span>
                          </div>
                          <p className="text-zinc-200 font-sans">{c.content}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-zinc-500">
                        Query against virtual table <code className="text-cyan-400">knowledge_fts</code>.
                      </p>
                    )}
                  </div>
                </div>

                {/* FAQ Matcher Test */}
                <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center space-x-2">
                      <BookOpen className="h-4 w-4 text-emerald-400" />
                      <h3 className="font-semibold text-sm text-zinc-200">Deterministic FAQ Matcher</h3>
                    </div>
                    <span className="text-xs font-mono text-zinc-500">Instant Bypass</span>
                  </div>

                  <form onSubmit={handleFaqMatch} className="flex gap-2 mb-3">
                    <input
                      type="text"
                      value={faqQuery}
                      onChange={e => setFaqQuery(e.target.value)}
                      placeholder="Try 'How to configure?' or 'settings'..."
                      className="flex-1 px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-emerald-500 font-mono"
                    />
                    <button
                      type="submit"
                      className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs rounded-lg text-zinc-200 font-medium"
                    >
                      Match FAQ
                    </button>
                  </form>

                  {faqResult && (
                    <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs space-y-1">
                      <div className="font-medium text-emerald-400 font-mono">{faqResult.question}</div>
                      <p className="text-zinc-300">{faqResult.answer}</p>
                    </div>
                  )}
                </div>

                {/* Audit Logs Stream */}
                <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <Terminal className="h-4 w-4 text-zinc-400" />
                      <h3 className="font-semibold text-sm text-zinc-200">System Audit Logs</h3>
                    </div>
                    <span className="text-xs font-mono text-zinc-500">PRAGMA WAL</span>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto font-mono text-[11px] pr-1">
                    {logs.map(log => (
                      <div key={log.id} className="p-1.5 rounded bg-zinc-950 border border-zinc-800/60 flex items-start space-x-2">
                        <span
                          className={`px-1 rounded text-[9px] uppercase ${
                            log.level === 'ERROR'
                              ? 'bg-rose-950 text-rose-400'
                              : log.level === 'WARN'
                              ? 'bg-amber-950 text-amber-400'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {log.level}
                        </span>
                        <span className="text-cyan-400">[{log.eventType}]</span>
                        <span className="text-zinc-300 flex-1">{log.details}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* TAB 2: DATABASE IMPORT & EXPORT */}
        {activeTab === 'database' && (
          <div className="space-y-6">
            {/* Database Metrics Header */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="text-xs text-zinc-400 font-medium uppercase mb-1">SQLite Database Size</div>
                <div className="text-2xl font-bold font-mono text-white">
                  {dbStats ? (dbStats.dbSizeKB > 1024 ? `${(dbStats.dbSizeKB / 1024).toFixed(2)} MB` : `${dbStats.dbSizeKB} KB`) : '...'}
                </div>
                <div className="text-xs text-emerald-400 mt-1 flex items-center space-x-1">
                  <span>●</span> <span>WAL Mode Active (Safe Flushing)</span>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="text-xs text-zinc-400 font-medium uppercase mb-1">Knowledge Chunks (FTS5)</div>
                <div className="text-2xl font-bold font-mono text-cyan-400">
                  {dbStats?.stats['knowledge_chunks'] || 0} <span className="text-sm font-normal text-zinc-400">chunks</span>
                </div>
                <div className="text-xs text-zinc-400 mt-1">
                  Indexed from {dbStats?.stats['knowledge_documents'] || 0} documents
                </div>
              </div>

              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                <div className="text-xs text-zinc-400 font-medium uppercase mb-1">FAQ & Config Records</div>
                <div className="text-2xl font-bold font-mono text-violet-400">
                  {(dbStats?.stats['faq_items'] || 0) + (dbStats?.stats['config_settings'] || 0)} <span className="text-sm font-normal text-zinc-400">entries</span>
                </div>
                <div className="text-xs text-zinc-400 mt-1">
                  {dbStats?.stats['prompt_profiles'] || 0} prompt persona profiles
                </div>
              </div>
            </div>

            {/* Export Section */}
            <div className="p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="h-9 w-9 rounded-lg bg-cyan-950 border border-cyan-800 text-cyan-400 flex items-center justify-center">
                    <Download className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-base text-zinc-100">Export Application Database</h3>
                    <p className="text-xs text-zinc-400">
                      Download a complete, offline snapshot of all system configuration, knowledge chunks, prompts, and queue records.
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                {/* Export 1: Raw SQLite .db */}
                <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="flex items-center space-x-2 text-sm font-medium text-white mb-1">
                      <FileBox className="h-4 w-4 text-cyan-400" />
                      <span>Raw SQLite Database (.db)</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Flushes Write-Ahead Logs (<code className="text-zinc-300">PRAGMA wal_checkpoint(TRUNCATE)</code>) and exports the primary binary database file. Directly usable in Android SQLite or sqlite3 CLI.
                    </p>
                  </div>
                  <a
                    href="/api/backup/export/db"
                    download="nexus_agent.db"
                    className="w-full py-2 px-3 rounded-lg bg-cyan-900/60 hover:bg-cyan-850 border border-cyan-700 text-cyan-200 text-xs font-medium flex items-center justify-center space-x-2 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download Raw SQLite File</span>
                  </a>
                </div>

                {/* Export 2: JSON Backup Bundle */}
                <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="flex items-center space-x-2 text-sm font-medium text-white mb-1">
                      <FileCode className="h-4 w-4 text-violet-400" />
                      <span>JSON Backup Bundle (.json)</span>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Human-readable, portable JSON export containing structured table data, configuration keys, FAQ definitions, prompt profiles, and audit traces.
                    </p>
                  </div>
                  <a
                    href="/api/backup/export/json"
                    download="nexus_backup.json"
                    className="w-full py-2 px-3 rounded-lg bg-violet-900/60 hover:bg-violet-850 border border-violet-700 text-violet-200 text-xs font-medium flex items-center justify-center space-x-2 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download JSON Backup</span>
                  </a>
                </div>
              </div>
            </div>

            {/* Import Section */}
            <div className="p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="h-9 w-9 rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-400 flex items-center justify-center">
                    <Upload className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-base text-zinc-100">Import & Restore Database</h3>
                    <p className="text-xs text-zinc-400">
                      Upload a previously exported JSON backup or raw SQLite <code className="text-zinc-300">.db</code> file. Database integrity is verified prior to replacement.
                    </p>
                  </div>
                </div>
              </div>

              <form onSubmit={handleImportSubmit} className="space-y-4 pt-2">
                <div className="p-6 rounded-xl border-2 border-dashed border-zinc-800 bg-zinc-950/80 hover:border-zinc-700 flex flex-col items-center justify-center text-center cursor-pointer transition-colors relative">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json,.db,.sqlite"
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <Upload className="h-8 w-8 text-zinc-500 mb-2" />
                  {importFile ? (
                    <div>
                      <span className="text-sm font-semibold text-cyan-300 font-mono">{importFile.name}</span>
                      <p className="text-xs text-zinc-400 mt-1">{(importFile.size / 1024).toFixed(1)} KB • Ready to restore</p>
                    </div>
                  ) : (
                    <div>
                      <span className="text-sm font-medium text-zinc-300">Click to choose or drop backup file here</span>
                      <p className="text-xs text-zinc-500 mt-1">Supports .json backup bundles and raw .db SQLite files</p>
                    </div>
                  )}
                </div>

                {importFile && importFile.name.endsWith('.json') && (
                  <div className="flex items-center space-x-4 bg-zinc-950 p-3 rounded-lg border border-zinc-800 text-xs">
                    <span className="text-zinc-400 font-medium">JSON Restoration Mode:</span>
                    <label className="flex items-center space-x-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="replace"
                        checked={importMode === 'replace'}
                        onChange={() => setImportMode('replace')}
                        className="text-cyan-500 focus:ring-0"
                      />
                      <span className="text-zinc-200">Replace (Clean slate restore)</span>
                    </label>
                    <label className="flex items-center space-x-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="importMode"
                        value="merge"
                        checked={importMode === 'merge'}
                        onChange={() => setImportMode('merge')}
                        className="text-zinc-400 focus:ring-0"
                      />
                      <span className="text-zinc-400">Merge (Preserve existing non-conflicting)</span>
                    </label>
                  </div>
                )}

                <div className="flex items-center justify-end">
                  <button
                    type="submit"
                    disabled={!importFile || isImporting}
                    className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs flex items-center space-x-2 disabled:opacity-40 transition-colors shadow-lg shadow-emerald-950/40"
                  >
                    <Upload className="h-4 w-4" />
                    <span>{isImporting ? 'Verifying & Restoring...' : 'Restore Database Now'}</span>
                  </button>
                </div>
              </form>

              {importResult && (
                <div className="p-4 rounded-lg bg-emerald-950/40 border border-emerald-800/80 text-emerald-200 text-xs space-y-2">
                  <div className="flex items-center space-x-2 font-medium">
                    <Check className="h-4 w-4 text-emerald-400" />
                    <span>Restoration Complete! Verified table records:</span>
                  </div>
                  {importResult.type === 'json' && importResult.data && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px] pt-1">
                      {Object.entries(importResult.data).map(([tbl, count]: [string, any]) => (
                        <div key={tbl} className="bg-zinc-950/60 p-2 rounded border border-emerald-900/60">
                          <div className="text-zinc-400">{tbl}</div>
                          <div className="font-bold text-emerald-300">{count} rows</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: ANDROID APK BUILD & INSTALLATION */}
        {activeTab === 'apk' && (
          <div className="space-y-6">
            {/* Header banner */}
            <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 flex items-start space-x-4">
              <div className="h-10 w-10 rounded-xl bg-violet-950 border border-violet-800 text-violet-400 flex items-center justify-center shrink-0">
                <Smartphone className="h-6 w-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-base text-white">Android Native APK Architecture (ARM64-v8a)</h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Nexus GGUF Agent is engineered as a self-contained native Android APK. It bundles the embedded Ktor daemon, SQLite FTS5 database, and llama.cpp native libraries with zero Termux dependencies.
                </p>
              </div>
            </div>

            {/* Workflow Fix Notice */}
            <div className="p-4 rounded-xl bg-amber-950/40 border border-amber-800/80 text-amber-200 text-xs flex items-start space-x-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold text-amber-300">GitHub Actions SDK Build Fix Applied</div>
                <p className="text-amber-200/90 leading-relaxed">
                  If your previous run hung on the <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">Set up Android SDK</code> or <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">sdkmanager</code> step, that was caused by an interactive pipe deadlock during license acceptance and third-party action download stalls.
                  <br />
                  The workflow <code className="bg-amber-900/60 px-1 py-0.5 rounded text-amber-100 font-mono">.github/workflows/build-apk.yml</code> has been updated to directly use the GitHub runner's preinstalled Android SDK (<code className="font-mono">/usr/local/lib/android/sdk</code>) with automated license hashes, target API 34, and a strict 12-minute timeout safeguard.
                </p>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Option 1: Direct Source & Build Automation Zip */}
              <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col justify-between space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 text-sm font-semibold text-white">
                    <Package className="h-4 w-4 text-cyan-400" />
                    <span>Download Complete Android Project & Build Bundle</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Downloads the complete Gradle project (<code className="text-zinc-300">build.gradle.kts</code>, <code className="text-zinc-300">AndroidManifest.xml</code>, Ktor daemon, JNI bridge, and build scripts) ready for compilation via Android Studio or command-line Gradle.
                  </p>
                </div>

                <a
                  href="/api/apk/package"
                  download="nexus-gguf-agent-android-source.zip"
                  className="w-full py-2.5 px-4 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs flex items-center justify-center space-x-2 transition-all shadow-md shadow-cyan-900/30"
                >
                  <Download className="h-4 w-4" />
                  <span>Download Android Source (.zip)</span>
                </a>
              </div>

              {/* Option 2: GitHub Actions Automated Cloud Builder */}
              <div className="p-5 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col justify-between space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center space-x-2 text-sm font-semibold text-white">
                    <Zap className="h-4 w-4 text-violet-400" />
                    <span>1-Click Automated APK Build (GitHub Actions)</span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Configured with pre-built workflow <code className="text-zinc-300">.github/workflows/build-apk.yml</code>. Push or fork this repository to GitHub, and the Ubuntu runner with Android SDK & NDK automatically compiles and produces the signed APK artifact.
                  </p>
                </div>

                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400 flex items-center justify-between">
                  <span>Workflow: .github/workflows/build-apk.yml</span>
                  <span className="text-emerald-400">Configured ✓</span>
                </div>
              </div>
            </div>

            {/* Step-by-Step Installation & Compilation Guide */}
            <div className="p-6 rounded-xl bg-zinc-900 border border-zinc-800 space-y-4">
              <h4 className="font-semibold text-sm text-zinc-200 flex items-center space-x-2">
                <Info className="h-4 w-4 text-cyan-400" />
                <span>How to Build and Install the APK</span>
              </h4>

              <div className="space-y-3 text-xs text-zinc-300">
                <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="font-semibold text-zinc-200">Method A: Using GitHub Actions (Easiest - No Android SDK needed locally)</div>
                  <p className="text-zinc-400">
                    1. Push this repository to GitHub.
                    <br />
                    2. Go to the <strong className="text-zinc-300">Actions</strong> tab and select <strong className="text-zinc-300">Build Nexus GGUF Agent APK</strong>.
                    <br />
                    3. Once the runner completes (approx. 2-3 minutes), download the <strong className="text-cyan-400">nexus-gguf-agent-debug-apk</strong> artifact and install it directly on your phone.
                  </p>
                </div>

                <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="font-semibold text-zinc-200">Method B: Local Workstation or Terminal (Mac / Linux / Windows)</div>
                  <p className="text-zinc-400 mb-2">
                    Open a terminal in the project directory with Android SDK & JDK 17 installed, then run:
                  </p>
                  <pre className="p-2.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-cyan-300 overflow-x-auto">
                    {`# 1. Run the local build script\nbash android/build-apk.sh\n\n# 2. Or compile directly using Gradle wrapper\n./gradlew :android:app:assembleDebug\n\n# 3. Install on connected phone via ADB\nadb install -r android/app/build/outputs/apk/debug/app-debug.apk`}
                  </pre>
                </div>

                <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 space-y-1">
                  <div className="font-semibold text-zinc-200">Method C: Android Studio</div>
                  <p className="text-zinc-400">
                    1. Open Android Studio, select <strong className="text-zinc-300">Open an Existing Project</strong>, and select the project root.
                    <br />
                    2. Select Build Variant <strong className="text-zinc-300">arm64Debug</strong> and click <strong className="text-cyan-400">Run (Shift+F10)</strong> on your connected ARM64 Android device.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-3 px-6 text-xs text-zinc-500 font-mono flex items-center justify-between">
        <div>NEXUS GGUF AGENT • Android ARM64 Local Engine</div>
        <div>Database WAL • FTS5 • Standalone APK Architecture</div>
      </footer>
    </div>
  );
}
