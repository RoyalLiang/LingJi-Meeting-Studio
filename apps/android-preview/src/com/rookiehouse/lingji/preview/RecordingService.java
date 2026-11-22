package com.rookiehouse.lingji.preview;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

public final class RecordingService extends Service {
    private static final String CHANNEL = "recording-status";

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        boolean paused = intent != null && intent.getBooleanExtra("paused", false);
        int elapsed = intent == null ? 0 : intent.getIntExtra("elapsed", 0);
        startForeground(1, notification(this, paused, elapsed, null));
        return START_NOT_STICKY;
    }

    static Notification notification(Service service, boolean paused, int elapsed, String waiting) {
        NotificationManager manager = service.getSystemService(NotificationManager.class);
        NotificationChannel previous = manager.getNotificationChannel("recording");
        String channelId = previous != null && previous.getImportance() == NotificationManager.IMPORTANCE_NONE
            ? previous.getId() : CHANNEL;
        NotificationChannel channel = new NotificationChannel(channelId, "录音状态", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setSound(null, null);
        channel.setShowBadge(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
        Intent open = new Intent(service, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent launch = PendingIntent.getActivity(service, 0, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder notification = new Notification.Builder(service, channelId)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(waiting != null ? "聆记自动记录待命" : paused ? "聆记录音已暂停" : "聆记正在录音")
            .setContentText(waiting != null ? waiting : paused ? android.text.format.DateUtils.formatElapsedTime(elapsed) : "点此返回录音")
            .setContentIntent(launch)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(waiting == null && !paused)
            .setWhen(System.currentTimeMillis() - 1000L * elapsed)
            .setUsesChronometer(waiting == null && !paused);
        if (Build.VERSION.SDK_INT >= 31) {
            notification.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return notification.build();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
