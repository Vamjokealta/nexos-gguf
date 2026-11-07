package com.nexus.agent.jni

/**
 * LlamaBridge provides JNI bindings to native llama.cpp compiled for ARM64-v8a.
 */
class LlamaBridge {

    companion object {
        init {
            try {
                System.loadLibrary("nexus_llama")
            } catch (e: UnsatisfiedLinkError) {
                // Allows running on devices or emulators before native library is placed
            }
        }
    }

    external fun nativeInitModelFromFd(fd: Int, nCtx: Int, nThreads: Int): Long
    external fun nativeFreeModel(modelHandle: Long)
    external fun nativeGetModelArch(modelHandle: Long): String
}
