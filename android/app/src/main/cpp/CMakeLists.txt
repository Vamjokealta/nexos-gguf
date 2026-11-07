cmake_minimum_required(VERSION 3.22.1)
project("nexus_llama_engine")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ARM NEON & Dot Product optimization flags for ARM64-v8a
if (${ANDROID_ABI} STREQUAL "arm64-v8a")
    add_definitions(-D__ARM_NEON -D__ARM_FEATURE_FP16_VECTOR_ARITHMETIC -D__ARM_FEATURE_DOTPROD)
endif()

add_library(
    nexus_llama
    SHARED
    llama_jni.cpp
)

target_include_directories(
    nexus_llama
    PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
)

find_library(log-lib log)
find_library(android-lib android)

target_link_libraries(
    nexus_llama
    ${log-lib}
    ${android-lib}
)
