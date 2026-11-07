package com.nexus.agent

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.nexus.agent.service.NexusDaemonService
import com.nexus.agent.storage.StorageManager

/**
 * MainActivity acts as the lightweight native Android host container.
 * - Starts the persistent 24/7 NexusDaemonService (Foreground Service).
 * - Hosts the WebView pointing to local loopback Ktor server (http://127.0.0.1:8765).
 * - Handles Android Storage Access Framework (SAF) intent for GGUF model selection.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var storageManager: StorageManager

    // Storage Access Framework launcher for selecting user GGUF models
    private val pickGgufLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val uri: Uri? = result.data?.data
            if (uri != null) {
                val persisted = storageManager.persistUriPermission(uri)
                if (persisted) {
                    Toast.makeText(this, "GGUF Model permission granted", Toast.LENGTH_SHORT).show()
                    webView.reload()
                } else {
                    Toast.makeText(this, "Failed to persist model permission", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        storageManager = StorageManager(this)

        // 1. Start the 24/7 background Foreground Service
        startNexusDaemonService()

        // 2. Setup embedded web view
        webView = WebView(this)
        setContentView(webView)

        configureWebView()

        // Load local loopback Ktor daemon dashboard
        webView.loadUrl("http://127.0.0.1:8765")
    }

    private fun startNexusDaemonService() {
        val serviceIntent = Intent(this, NexusDaemonService::class.java).apply {
            action = NexusDaemonService.ACTION_START
        }
        ContextCompat.startForegroundService(this, serviceIntent)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                // If local server is still initializing, retry in 1 second
                if (failingUrl?.contains("127.0.0.1") == true) {
                    view?.postDelayed({ view.reload() }, 1000)
                }
            }
        }
        webView.webChromeClient = WebChromeClient()
    }

    /**
     * Called when user wants to import an external GGUF model via SAF
     */
    fun launchGgufPicker() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "*/*"))
        }
        pickGgufLauncher.launch(intent)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
