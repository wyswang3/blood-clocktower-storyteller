package com.wyswang.clocktower;

import android.app.*;
import android.content.*;
import android.os.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.json.JSONObject;

/** 真正启动 APK 中的 Node 和 WebView；不用真实 DeepSeek 密钥。 */
public class SmokeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    private void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent intent = new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            MainActivity activity = (MainActivity) startActivitySync(intent);
            CountDownLatch replyReady = new CountDownLatch(1);
            Bundle[] nativeConfig = new Bundle[1];
            Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), msg -> {
                if (msg.getData().getInt("port") > 0) { nativeConfig[0] = msg.getData(); replyReady.countDown(); }
                return true;
            }));
            ServiceConnection connection = new ServiceConnection() {
                @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                    Message query = Message.obtain(null, RoomService.STATUS); query.replyTo = replies;
                    try { new Messenger(binder).send(query); } catch (RemoteException ignored) {}
                }
                @Override public void onServiceDisconnected(ComponentName name) {}
            };
            getTargetContext().bindService(new Intent(getTargetContext(), RoomService.class), connection, Context.BIND_AUTO_CREATE);
            check(replyReady.await(15, TimeUnit.SECONDS), "native IPC did not respond");
            int port = nativeConfig[0].getInt("port");
            String token = nativeConfig[0].getString("token");
            JSONObject status = null;
            for (int i = 0; i < 90; i++) {
                try { status = json(port, "/__native/status", token); break; } catch (Exception ignored) { Thread.sleep(1000); }
            }
            check(status != null && status.optString("pin").length() >= 4, "embedded Node did not start");
            check(json(port, "/health", "").optBoolean("ok"), "health failed");
            check(!json(port, "/state/public", "").has("pin"), "public state leaked host PIN");
            try { json(port, "/__native/status", ""); throw new AssertionError("native status was public"); } catch (IOException expected) {}
            String nativeDir = getTargetContext().getApplicationInfo().nativeLibraryDir;
            java.lang.Process tunnel = new ProcessBuilder(nativeDir + "/libcloudflared.so", "--version").redirectErrorStream(true).start();
            check(tunnel.waitFor(15, TimeUnit.SECONDS) && tunnel.exitValue() == 0, "bundled cloudflared cannot execute");
            // 在真实 Android WebView 中确认页面脚本、WebSocket 与房主认证共同成功。
            java.lang.reflect.Field field = MainActivity.class.getDeclaredField("web"); field.setAccessible(true);
            android.webkit.WebView web = (android.webkit.WebView) field.get(activity);
            boolean rendered = false;
            for (int i = 0; i < 45; i++) {
                CountDownLatch evaluated = new CountDownLatch(1); String[] text = new String[1];
                runOnMainSync(() -> web.evaluateJavascript("document.body.innerText", value -> { text[0] = value; evaluated.countDown(); }));
                evaluated.await(3, TimeUnit.SECONDS);
                if (text[0] != null && text[0].contains("开始游戏") && text[0].contains("连接 DeepSeek")) { rendered = true; break; }
                Thread.sleep(1000);
            }
            check(rendered, "host lobby did not render inside WebView");
            getTargetContext().unbindService(connection);
            // 覆盖“主界面仍绑定时重启服务”，避免 stopSelf 被绑定阻止而卡在旧进程。
            java.lang.reflect.Field messengerField = MainActivity.class.getDeclaredField("service"); messengerField.setAccessible(true);
            java.lang.reflect.Field portField = MainActivity.class.getDeclaredField("port"); portField.setAccessible(true);
            java.lang.reflect.Field tokenField = MainActivity.class.getDeclaredField("token"); tokenField.setAccessible(true);
            final int oldPort = port;
            runOnMainSync(() -> {
                try { ((Messenger) messengerField.get(activity)).send(Message.obtain(null, RoomService.STOP)); }
                catch (Exception error) { throw new RuntimeException(error); }
            });
            JSONObject recovered = null; int recoveredPort = 0; String recoveredToken = "";
            for (int i = 0; i < 60; i++) {
                final int[] nextPort = new int[1]; final String[] nextToken = new String[1];
                runOnMainSync(() -> {
                    try { nextPort[0] = portField.getInt(activity); nextToken[0] = (String) tokenField.get(activity); }
                    catch (Exception error) { throw new RuntimeException(error); }
                });
                if (nextPort[0] > 0 && nextPort[0] != oldPort) {
                    try { recovered = json(nextPort[0], "/__native/status", nextToken[0]); recoveredPort = nextPort[0]; recoveredToken = nextToken[0]; break; } catch (Exception ignored) {}
                }
                Thread.sleep(1000);
            }
            check(recovered != null && recovered.optString("pin").equals(status.optString("pin")), "native restart did not restore room");
            boolean publicVerified = false;
            for (int i = 0; i < 70; i++) {
                JSONObject current = json(recoveredPort, "/__native/status", recoveredToken);
                String join = current.optString("joinUrl");
                if (join.startsWith("https://") && join.endsWith("/player")) {
                    try { publicVerified = publicHealth(join.substring(0, join.length() - 7) + "/health"); } catch (Exception ignored) {}
                    if (publicVerified) break;
                }
                Thread.sleep(1000);
            }
            Thread.sleep(3000);
            android.graphics.Bitmap screenshot = getUiAutomation().takeScreenshot();
            check(screenshot != null, "screenshot unavailable");
            try (FileOutputStream output = new FileOutputStream(new File(getTargetContext().getFilesDir(), "smoke-tablet.png"))) {
                screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            screenshot.recycle();
            result.putString("stream", "SMOKE_OK: embedded Node, IPC, private control, public isolation, cloudflared executable, WebView lobby, native process restart and restore\n"
                    + (publicVerified ? "PUBLIC_ROUNDTRIP_OK\n" : "PUBLIC_NOT_VERIFIED: requires on-site network validation\n"));
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            // 只输出断言标签，不输出运行时状态/令牌/身份。
            result.putString("stream", "SMOKE_FAILED: " + error.getClass().getSimpleName()
                    + (error instanceof AssertionError ? ": " + error.getMessage() : "") + "\n");
            finish(Activity.RESULT_CANCELED, result);
        }
    }
    private JSONObject json(int port, String path, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        conn.setConnectTimeout(1000); conn.setReadTimeout(2000);
        if (!token.isEmpty()) conn.setRequestProperty("X-Btc-Native", token);
        try {
            if (conn.getResponseCode() != 200) throw new IOException("HTTP rejected");
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { conn.disconnect(); }
    }
    private boolean publicHealth(String address) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        conn.setConnectTimeout(3000); conn.setReadTimeout(5000);
        try {
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[2048]; int count;
                while ((count = in.read(buffer)) != -1) { if (out.size() + count > 8192) return false; out.write(buffer, 0, count); }
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name())).optBoolean("ok");
            }
        } finally { conn.disconnect(); }
    }
}
