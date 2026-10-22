#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <unistd.h>
#include "node.h"

static std::string utf(JNIEnv* env, jstring text) {
    const char* value = env->GetStringUTFChars(text, nullptr);
    std::string copy(value);
    env->ReleaseStringUTFChars(text, value);
    return copy;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_wyswang_clocktower_RoomService_startRuntime(JNIEnv* env, jobject,
        jstring script, jstring dataDir, jstring nativeDir, jint port,
        jstring token, jstring lanIp, jboolean internet) {
    const auto file = utf(env, script), data = utf(env, dataDir), libs = utf(env, nativeDir);
    setenv("PORT", std::to_string(port).c_str(), 1);
    setenv("ROOM_FILE", (data + "/room.json").c_str(), 1);
    setenv("AI_CONFIG_FILE", (data + "/ai.local.json").c_str(), 1);
    setenv("TMPDIR", data.c_str(), 1);
    setenv("HOME", data.c_str(), 1);
    setenv("BTC_NATIVE_TOKEN", utf(env, token).c_str(), 1);
    setenv("BTC_LAN_IP", utf(env, lanIp).c_str(), 1);
    setenv("CLOUDFLARED_PATH", (libs + "/libcloudflared.so").c_str(), 1);
    setenv("TUNNEL", internet ? "1" : "0", 1);
    chdir(data.c_str());
    // libuv 要求参数在连续内存中；argv 还须保留结尾 nullptr。
    std::vector<char> buffer(5 + file.size() + 1);
    std::memcpy(buffer.data(), "node", 5);
    std::memcpy(buffer.data() + 5, file.c_str(), file.size() + 1);
    char* argv[] = {buffer.data(), buffer.data() + 5, nullptr};
    return node::Start(2, argv);
}
