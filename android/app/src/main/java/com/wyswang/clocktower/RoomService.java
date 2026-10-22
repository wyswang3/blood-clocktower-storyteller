package com.wyswang.clocktower;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;

/** 独立进程运行 Node，一局结束可以完整停止，下次打开不受 V8 不可重启限制。 */
public class RoomService extends Service {
    static final int STATUS = 1, STOP = 2;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Messenger messenger = new Messenger(new Handler(Looper.getMainLooper(), msg -> {
        if (msg.sendingUid != android.os.Process.myUid()) return true;
        if (msg.what == STATUS && msg.replyTo != null) {
            Message reply = Message.obtain(null, STATUS);
            Bundle data = new Bundle();
            data.putInt("port", port); data.putString("token", token); data.putString("error", failure);
            reply.setData(data);
            try { msg.replyTo.send(reply); } catch (RemoteException ignored) {}
        } else if (msg.what == STOP) stopRoom();
        return true;
    }));
    private volatile int port;
    private volatile String token = "", failure = "";
    private boolean started;
    private volatile boolean stopping;
    private PowerManager.WakeLock wake;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;

    private native int startRuntime(String script, String data, String nativeDir, int port,
                                    String token, String lanIp, boolean internet);

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("room", "对局运行状态", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new Notification.Builder(this, "room")
                .setSmallIcon(com.wyswang.clocktower.R.drawable.ic_clocktower).setContentTitle("血染说书人正在运行")
                .setContentText("点击回到房间；请在应用内关闭房间。")
                .setContentIntent(pending).setOngoing(true).build();
        startForeground(7, notification);
        PowerManager pm = getSystemService(PowerManager.class);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "clocktower:room");
        wake.setReferenceCounted(false);
        renewWake();
    }

    private void renewWake() {
        if (stopping) return;
        wake.acquire(70 * 60 * 1000L);
        main.postDelayed(this::renewWake, 60 * 60 * 1000L);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (started) return START_NOT_STICKY;
        started = true;
        final boolean internet = intent == null || intent.getBooleanExtra("internet", true);
        byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
        StringBuilder encoded = new StringBuilder();
        for (byte b : random) encoded.append(String.format(Locale.ROOT, "%02x", b & 255));
        token = encoded.toString();
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            port = socket.getLocalPort();
        } catch (IOException e) { failure = "无法启动房间，请关闭应用后重新打开。"; return START_NOT_STICKY; }
        new Thread(() -> {
            try {
                String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                File game = new File(getFilesDir(), "game-" + version);
                if (!new File(game, ".complete").exists()) {
                    copyAssets("game", game);
                    try (FileOutputStream complete = new FileOutputStream(new File(game, ".complete"))) { complete.write(1); }
                }
                System.loadLibrary("node"); System.loadLibrary("clocktower");
                main.post(this::watchNetwork);
                startRuntime(new File(game, "server.js").getAbsolutePath(), getFilesDir().getAbsolutePath(),
                        getApplicationInfo().nativeLibraryDir, port, token, lanAddress(), internet);
                if (!stopping) failure = "房间服务已停止，请点连接设置中的「重启应用服务」。";
            } catch (Throwable e) {
                // 不把可能含密钥/私密路径的运行时错误写入 logcat 或公共页面。
                failure = "房间启动失败。请确认已安装适合本机的版本，再点「重启应用服务」。";
            }
        }, "clocktower-node").start();
        return START_NOT_STICKY;
    }

    private void copyAssets(String asset, File destination) throws IOException {
        String[] children = getAssets().list(asset);
        if (children != null && children.length > 0) {
            if (!destination.isDirectory() && !destination.mkdirs()) throw new IOException("mkdir");
            for (String child : children) copyAssets(asset + "/" + child, new File(destination, child));
        } else {
            try (InputStream in = getAssets().open(asset); OutputStream out = new FileOutputStream(destination)) {
                byte[] bytes = new byte[32768]; int count;
                while ((count = in.read(bytes)) != -1) out.write(bytes, 0, count);
            }
        }
    }

    private String lanAddress() {
        try {
            ConnectivityManager cm = getSystemService(ConnectivityManager.class);
            // 优先 Wi-Fi；Android 可能禁止 Node 枚举网卡，由系统 API 提供地址。
            Network[] networks = cm.getAllNetworks();
            for (int pass = 0; pass < 2; pass++) for (Network network : networks) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (pass == 0 && (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))) continue;
                LinkProperties props = cm.getLinkProperties(network);
                if (props == null) continue;
                for (LinkAddress link : props.getLinkAddresses()) {
                    InetAddress address = link.getAddress();
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) return address.getHostAddress();
                }
            }
        } catch (Exception ignored) {}
        return "";
    }

    private void watchNetwork() {
        connectivity = getSystemService(ConnectivityManager.class);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { changed(); }
            @Override public void onLost(Network network) { changed(); }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) { changed(); }
            private void changed() {
                main.removeCallbacks(networkChanged);
                main.postDelayed(networkChanged, 1800);
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }
    private final Runnable networkChanged = () -> new Thread(() -> {
        try { localRequest("POST", "/__native/network/" + (lanAddress().isEmpty() ? "none" : lanAddress())); }
        catch (IOException ignored) {}
    }, "room-network").start();

    private void localRequest(String method, String path) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection();
        try {
            conn.setRequestMethod(method); conn.setRequestProperty("X-Btc-Native", token);
            conn.setConnectTimeout(2000); conn.setReadTimeout(3000);
            if (conn.getResponseCode() != 200) throw new IOException("local request failed");
            try (InputStream in = conn.getInputStream()) { while (in.read() != -1) {} }
        } finally { conn.disconnect(); }
    }

    private void stopRoom() {
        if (stopping) return;
        stopping = true;
        new Thread(() -> {
            try { localRequest("POST", "/__native/stop"); } catch (IOException ignored) {}
            main.post(() -> { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); });
        }, "room-stop").start();
    }

    @Override public IBinder onBind(Intent intent) { return messenger.getBinder(); }
    @Override public void onDestroy() {
        stopping = true;
        main.removeCallbacksAndMessages(null);
        if (connectivity != null && networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
        // 仅结束 :room 独立进程，主界面仍可重新创建服务。
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
