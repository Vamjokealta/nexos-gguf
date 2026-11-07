package com.nexus.agent.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.nexus.agent.service.NexusDaemonService

/**
 * BootReceiver ensures that the NexusDaemonService is automatically restarted
 * whenever the Android device completes booting or the application is updated.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            val serviceIntent = Intent(context, NexusDaemonService::class.java).apply {
                action = NexusDaemonService.ACTION_START
            }
            ContextCompat.startForegroundService(context, serviceIntent)
        }
    }
}
