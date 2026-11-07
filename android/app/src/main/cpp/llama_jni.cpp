/**
 * Nexus GGUF Agent - Native llama.cpp JNI Bridge for Android ARM64-v8a
 */

#include <jni.h>
#include <string>
#include <android/log.h>
#include <unistd.h>
#include <sys/mman.h>

#define TAG "NexusLlamaNative"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_nexus_agent_jni_LlamaBridge_nativeInitModelFromFd(
    JNIEnv* env,
    jobject /* this */,
    jint fd,
    jint n_ctx,
    jint n_threads
) {
    LOGI("Initializing GGUF model from native Linux file descriptor: %d (threads=%d, ctx=%d)", fd, n_threads, n_ctx);
    if (fd < 0) {
        LOGE("Invalid file descriptor: %d", fd);
        return 0;
    }
    // Return mock pointer address (simulating model handle for initial phase)
    return reinterpret_cast<jlong>(new int(fd));
}

JNIEXPORT void JNICALL
Java_com_nexus_agent_jni_LlamaBridge_nativeFreeModel(
    JNIEnv* env,
    jobject /* this */,
    jlong model_handle
) {
    if (model_handle != 0) {
        int* ptr = reinterpret_cast<int*>(model_handle);
        delete ptr;
        LOGI("Native GGUF model handle freed successfully");
    }
}

JNIEXPORT jstring JNICALL
Java_com_nexus_agent_jni_LlamaBridge_nativeGetModelArch(
    JNIEnv* env,
    jobject /* this */,
    jlong model_handle
) {
    return env->NewStringUTF("qwen2 / llama3 (ARM64 Optimized)");
}

}
