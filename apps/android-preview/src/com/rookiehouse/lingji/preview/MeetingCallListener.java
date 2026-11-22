package com.rookiehouse.lingji.preview;

import android.app.Notification;
import android.os.Build;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public final class MeetingCallListener extends NotificationListenerService {
    private static final Set<String> APPS = new HashSet<>(Arrays.asList(
        "com.ss.android.lark", "com.larksuite.suite", "com.microsoft.teams", "us.zoom.videomeetings", "com.tencent.wemeet.app"
    ));
    private static final Set<String> calls = ConcurrentHashMap.newKeySet();
    private static volatile boolean connected;

    static boolean connected() { return connected; }
    static boolean inMeeting() { return !calls.isEmpty(); }

    @Override public void onListenerConnected() {
        calls.clear();
        StatusBarNotification[] active = getActiveNotifications();
        if (active != null) for (StatusBarNotification notification : active) onNotificationPosted(notification);
        connected = true;
    }

    @Override public void onListenerDisconnected() {
        connected = false;
        calls.clear();
    }

    @Override public void onNotificationPosted(StatusBarNotification entry) {
        if (!APPS.contains(entry.getPackageName())) return;
        Notification notification = entry.getNotification();
        int type = Build.VERSION.SDK_INT >= 34 && notification.extras != null
            ? notification.extras.getInt(Notification.EXTRA_CALL_TYPE) : 0;
        if (entry.isOngoing() && Notification.CATEGORY_CALL.equals(notification.category)
                && (type == 0 || type == Notification.CallStyle.CALL_TYPE_ONGOING)) calls.add(entry.getKey());
        else calls.remove(entry.getKey());
    }

    @Override public void onNotificationRemoved(StatusBarNotification entry) { calls.remove(entry.getKey()); }
}
