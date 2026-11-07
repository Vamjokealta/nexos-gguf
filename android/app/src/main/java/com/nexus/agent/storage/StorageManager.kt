package com.nexus.agent.storage

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

/**
 * StorageManager handles:
 * - Scoped Storage layout for user models, knowledge, and backups.
 * - Storage Access Framework (SAF) persistable URI handling for user-selected GGUF files.
 * - Native File Descriptor extraction for zero-copy llama.cpp mmap.
 * - Offline-first persistence surviving app reinstallation.
 */
class StorageManager(private val context: Context) {

    companion object {
        const val DIR_MODELS = "models"
        const val DIR_DATABASES = "databases"
        const val DIR_KNOWLEDGE = "knowledge"
        const val DIR_BACKUPS = "backups"
        const val DIR_LOGS = "logs"
    }

    /**
     * Resolves the root storage directory.
     * Prefers shared external app directory: /sdcard/Android/data/com.nexus.agent/files/
     * Falls back to internal storage: /data/user/0/com.nexus.agent/files/
     */
    val baseDir: File by lazy {
        val external = context.getExternalFilesDir(null)
        if (external != null && (Environment.MEDIA_MOUNTED == Environment.getExternalStorageState(external) || !Environment.isExternalStorageRemovable())) {
            external
        } else {
            context.filesDir
        }
    }

    val modelsDir: File
        get() = getOrCreateSubdir(DIR_MODELS)

    val databasesDir: File
        get() = getOrCreateSubdir(DIR_DATABASES)

    val knowledgeDir: File
        get() = getOrCreateSubdir(DIR_KNOWLEDGE)

    val backupsDir: File
        get() = getOrCreateSubdir(DIR_BACKUPS)

    val logsDir: File
        get() = getOrCreateSubdir(DIR_LOGS)

    private fun getOrCreateSubdir(name: String): File {
        val dir = File(baseDir, name)
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    /**
     * Obtains durable persistable permission for an imported GGUF file URI
     */
    fun persistUriPermission(uri: Uri): Boolean {
        return try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Extracts a native Linux file descriptor (fd) from a SAF content URI.
     * This fd can be directly passed via JNI to llama.cpp's llama_model_load_from_fd() or mmap().
     */
    fun getFileDescriptorFromUri(uri: Uri): Int {
        val pfd: ParcelFileDescriptor = context.contentResolver.openFileDescriptor(uri, "r")
            ?: throw IllegalStateException("Could not open ParcelFileDescriptor for $uri")
        return pfd.detachFd()
    }

    /**
     * Returns total and available storage space in MB
     */
    fun getStorageMetrics(): StorageMetrics {
        val totalBytes = baseDir.totalSpace
        val freeBytes = baseDir.freeSpace
        val usedBytes = totalBytes - freeBytes

        return StorageMetrics(
            totalMB = totalBytes / (1024 * 1024),
            freeMB = freeBytes / (1024 * 1024),
            usedMB = usedBytes / (1024 * 1024),
            modelsCount = modelsDir.listFiles { f -> f.extension.equals("gguf", ignoreCase = true) }?.size ?: 0,
            knowledgeDocsCount = knowledgeDir.listFiles()?.size ?: 0,
            basePath = baseDir.absolutePath
        )
    }

    /**
     * Copies a file safely into the persistent knowledge folder
     */
    fun saveKnowledgeFile(filename: String, inputBytes: ByteArray): File {
        val targetFile = File(knowledgeDir, filename)
        FileOutputStream(targetFile).use { it.write(inputBytes) }
        return targetFile
    }

    /**
     * Scans for local GGUF models in the persistent models directory
     */
    fun listGgufModels(): List<LocalModelInfo> {
        val models = mutableListOf<LocalModelInfo>()
        val files = modelsDir.listFiles { file -> file.extension.equals("gguf", ignoreCase = true) }
        files?.forEach { file ->
            models.add(
                LocalModelInfo(
                    fileName = file.name,
                    absolutePath = file.absolutePath,
                    sizeBytes = file.length(),
                    sizeMB = file.length() / (1024 * 1024),
                    lastModified = file.lastModified()
                )
            )
        }
        return models
    }
}

data class StorageMetrics(
    val totalMB: Long,
    val freeMB: Long,
    val usedMB: Long,
    val modelsCount: Int,
    val knowledgeDocsCount: Int,
    val basePath: String
)

data class LocalModelInfo(
    val fileName: String,
    val absolutePath: String,
    val sizeBytes: Long,
    val sizeMB: Long,
    val lastModified: Long
)
