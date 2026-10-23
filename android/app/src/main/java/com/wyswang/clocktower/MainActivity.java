package com.wyswang.clocktower;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

/** 原生启动器只管理服务和连接，不读取玩家身份，也不接触 DeepSeek 密钥。 */
public class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Messenger service;
    private boolean bound, active, polling, closing;
    private int port;
    private String token = "", loadedOrigin = "", joinUrl = "";
    private WebView web;
    private TextView status, loading;
    private final Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), msg -> {
        if (msg.what != RoomService.STATUS || closing) return true;
        port = msg.getData().getInt("port"); token = msg.getData().getString("token", "");
        String error = msg.getData().getString("error", "");
        if (!error.isEmpty()) { status.setText(error); loading.setText(error); return true; }
        pollServer(); return true;
    }));
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) { service = new Messenger(binder); askStatus(); }
        @Override public void onServiceDisconnected(ComponentName name) {
            service = null; port = 0; token = ""; loadedOrigin = ""; joinUrl = "";
            if (!closing) { status.setText("房间服务已停止，正在恢复…"); main.postDelayed(MainActivity.this::restartBinding, 1500); }
        }
    };

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(25, 20, 31));
        getWindow().setNavigationBarColor(Color.rgb(25, 20, 31));
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(20, 18, 27));
        if (Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        status = new TextView(this); status.setTextColor(Color.rgb(235, 224, 240)); status.setPadding(16, 8, 16, 4); status.setText("正在准备房间，首次打开请稍等…");
        root.addView(status);
        LinearLayout buttons = new LinearLayout(this);
        addButton(buttons, "分享加入链接", v -> share());
        addButton(buttons, "连接设置", v -> settings());
        addButton(buttons, "关闭房间", v -> confirmClose());
        root.addView(buttons);
        FrameLayout content = new FrameLayout(this);
        web = new WebView(this); WebSettings config = web.getSettings();
        config.setJavaScriptEnabled(true); config.setDomStorageEnabled(true);
        config.setAllowFileAccess(false); config.setAllowContentAccess(false);
        config.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= 26) config.setSafeBrowsingEnabled(true);
        web.setBackgroundColor(Color.rgb(20, 18, 27));
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() == port) return false;
                if ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) { web.clearHistory(); }
        });
        web.setWebChromeClient(new WebChromeClient());
        // 不安装 JavaScript bridge，不向网页暴露原生管理令牌。
        content.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new TextView(this); loading.setTextColor(Color.WHITE); loading.setTextSize(20);
        loading.setGravity(Gravity.CENTER); loading.setText("正在启动说书人…\n无需安装其他软件或输入命令。");
        loading.setBackgroundColor(Color.rgb(20, 18, 27)); content.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        root.addView(content, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
        startRoom();
    }

    private void addButton(LinearLayout row, String title, View.OnClickListener click) {
        Button button = new Button(this); button.setText(title); button.setTextSize(13); button.setAllCaps(false); button.setOnClickListener(click);
        row.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
    }
    private boolean internetMode() { return getPreferences(MODE_PRIVATE).getBoolean("internet", true); }
    private void startRoom() {
        Intent intent = new Intent(this, RoomService.class).putExtra("internet", internetMode());
        startForegroundService(intent);
        bound = bindService(intent, connection, BIND_AUTO_CREATE);
    }
    private void restartBinding() {
        if (closing || isFinishing()) return;
        if (bound) { unbindService(connection); bound = false; }
        startRoom();
    }
    private void askStatus() {
        if (service == null || closing) return;
        Message message = Message.obtain(null, RoomService.STATUS); message.replyTo = replies;
        try { service.send(message); } catch (RemoteException ignored) {}
    }
    private final Runnable ticker = new Runnable() {
        @Override public void run() { if (active && !closing) { askStatus(); main.postDelayed(this, 2000); } }
    };
    @Override public void onResume() { super.onResume(); active = true; web.onResume(); main.post(ticker); }
    @Override public void onPause() { active = false; main.removeCallbacks(ticker); web.onPause(); super.onPause(); }

    private JSONObject request(String method, String path) throws Exception {
        int currentPort = port; String currentToken = token;
        if (currentPort == 0 || currentToken.isEmpty()) throw new IOException("not ready");
        HttpURLConnection conn = (HttpURLConnection) new URL("http://127.0.0.1:" + currentPort + path).openConnection();
        try {
            conn.setConnectTimeout(1800); conn.setReadTimeout(3000); conn.setRequestMethod(method);
            conn.setRequestProperty("X-Btc-Native", currentToken);
            if (conn.getResponseCode() != 200) throw new IOException("request failed");
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = in.read(buffer)) != -1) { if (out.size() + count > 65536) throw new IOException("oversize"); out.write(buffer, 0, count); }
                return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { conn.disconnect(); }
    }
    private void pollServer() {
        if (polling || closing || port == 0) return;
        polling = true;
        io.execute(() -> {
            try {
                JSONObject data = request("GET", "/__native/status");
                main.post(() -> {
                    polling = false;
                    if (closing) return;
                    joinUrl = data.optString("joinUrl", "");
                    status.setText(data.optString("message", "房间已启动"));
                    String origin = "http://127.0.0.1:" + port;
                    if (!origin.equals(loadedOrigin)) {
                        loadedOrigin = origin;
                        web.loadUrl(origin + "/host?pin=" + Uri.encode(data.optString("pin")));
                        loading.setVisibility(View.GONE);
                    }
                });
            } catch (Exception e) { main.post(() -> { polling = false; if (!closing) status.setText("正在连接本机房间…首次启动可能需要半分钟。"); }); }
        });
    }

    private void share() {
        if (joinUrl.isEmpty()) { new AlertDialog.Builder(this).setMessage("房间链接还没准备好。请确认平板能上网，或在连接设置中选择同一 Wi-Fi。").setPositiveButton("知道了", null).show(); return; }
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "来玩血染钟楼，点链接选座位：\n" + joinUrl);
        startActivity(Intent.createChooser(send, "把加入链接发给朋友"));
    }
    private void action(String path, String notice) {
        status.setText(notice);
        io.execute(() -> {
            try { request("POST", path); main.post(this::askStatus); }
            catch (Exception e) { main.post(() -> status.setText("操作未完成，请稍等后重试，或重启应用服务。")); }
        });
    }
    private void settings() {
        String[] choices = {"各用流量 / Wi-Fi（自动连接公网）", "大家连同一 Wi-Fi / 手机热点", "重新连接公网", "重启应用服务", "使用帮助"};
        new AlertDialog.Builder(this).setTitle("连接设置").setItems(choices, (dialog, which) -> {
            if (which < 2) {
                final boolean internet = which == 0;
                // 只有本机服务确认收到后才记住选择，失败不会假装已切换。
                io.execute(() -> {
                    try {
                        request("POST", "/__native/mode/" + (internet ? "internet" : "lan"));
                        getPreferences(MODE_PRIVATE).edit().putBoolean("internet", internet).apply();
                        main.post(this::askStatus);
                    } catch (Exception e) { main.post(() -> status.setText("连接方式未切换，请重试。")); }
                });
            } else if (which == 2) {
                getPreferences(MODE_PRIVATE).edit().putBoolean("internet", true).apply();
                action("/__native/retry", "正在重新连接公网，旧链接将失效…");
            } else if (which == 3) {
                new AlertDialog.Builder(this).setMessage("会保存当前对局并重启服务。公网加入链接可能变化，需要重新分享。").setNegativeButton("取消", null)
                        .setPositiveButton("重启", (d, w) -> { loadedOrigin = ""; joinUrl = ""; sendStop(); }).show();
            } else {
                new AlertDialog.Builder(this).setTitle("三步开局").setMessage("1. 大厅点「连接 DeepSeek」填写 API Key，可先跳过。\n2. 点顶部「分享加入链接」，朋友用手机浏览器打开、选座位。\n3. 全员到齐后点「开始游戏」。\n\n请让平板保持联网和供电；切出应用后通知栏仍显示房间运行。公网失败可重试，或改用同一 Wi-Fi / 热点。升级请直接覆盖安装，卸载会清除密钥和存档。")
                        .setPositiveButton("知道了", null).show();
            }
        }).show();
    }
    private void sendStop() {
        if (service != null) try { service.send(Message.obtain(null, RoomService.STOP)); } catch (RemoteException ignored) {}
        else if (!closing) restartBinding();
    }
    private void confirmClose() {
        new AlertDialog.Builder(this).setTitle("关闭房间？").setMessage("会保存进度并断开所有手机，下次打开可恢复。公网链接下次可能变化。")
                .setNegativeButton("继续玩", null).setPositiveButton("保存并关闭", (dialog, which) -> { closing = true; sendStop(); finishAndRemoveTask(); }).show();
    }
    @Override public void onBackPressed() {
        new AlertDialog.Builder(this).setMessage("回到桌面后房间继续运行。需要结束时请点「关闭房间」。").setNegativeButton("留在房间", null)
                .setPositiveButton("回到桌面", (dialog, which) -> moveTaskToBack(true)).show();
    }
    @Override public void onDestroy() {
        closing = true; main.removeCallbacksAndMessages(null);
        if (bound) unbindService(connection);
        web.destroy(); io.shutdown(); super.onDestroy();
    }
}
