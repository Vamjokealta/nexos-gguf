package com.nexus.agent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.nexus.agent.MainActivity
import com.nexus.agent.db.NexusDatabase
import com.nexus.agent.server.KtorDaemonServer
import com.nexus.agent.storage.StorageManager

/**
 * 24/7 Persistent Nexus Daemon Foreground Service.
 * Ensures local inference, Telegram polling, and Ktor server survive screen-off and Doze mode.
 */
class NexusDaemonService : Service() {

    companion object {
        const val CHANNEL_ID = "nexus_daemon_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START = "com.nexus.agent.ACTION_START"
        const val ACTION_STOP = "com.nexus.agent.ACTION_STOP"
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var database: NexusDatabase
    private lateinit var storageManager: StorageManager
    private var daemonServer: KtorDaemonServer? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        storageManager = StorageManager(this)
        val dbFile = java.io.File(storageManager.databasesDir, NexusDatabase.DATABASE_NAME)
        database = NexusDatabase(this, dbFile.absolutePath)

        // Crash Recovery: safely restore any tasks that were PROCESSING when the app crashed/stopped
        val recoveredCount = database.recoverPendingQueue()
        database.logAudit("DAEMON_START", "INFO", "Daemon started. Recovered $recoveredCount interrupted queue tasks.")

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NexusAgent::DaemonWakeLock")

        // Start Ktor loopback HTTP/WebSocket server on 127.0.0.1:8765
        daemonServer = KtorDaemonServer(database, storageManager, port = 8765)
        daemonServer?.start()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification("NEXUS GGUF Agent Active", "Local AI Engine & Telegram Orchestrator running")
        startForeground(NOTIFICATION_ID, notification)

        return START_STICKY
    }

    private fun buildNotification(title: String, content: String): Notification {
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Nexus GGUF Agent Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps local offline AI inference and Telegram orchestration active"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        database.logAudit("DAEMON_STOP", "INFO", "Daemon stopped gracefully.")
        daemonServer?.stop()
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
