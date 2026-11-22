package com.rookiehouse.lingji.preview;

import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.IBinder;
import android.util.Base64;
import java.util.ArrayDeque;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

public final class PlaybackCaptureService extends Service {
    private static final String[] SOURCES = {
        "com.ss.android.lark", "com.larksuite.suite", "com.microsoft.teams", "us.zoom.videomeetings", "com.tencent.wemeet.app"
    };
    private static final int RATE = 16000;
    private static final int SAMPLES = RATE / 4;
    private static final int QUIET_CHUNKS_TO_END = 60 * RATE / SAMPLES;
    private static final int NOTIFICATION = 2;
    static Consumer<String> messages;
    private static PlaybackCaptureService active;
    private final Handler main = new Handler(android.os.Looper.getMainLooper());
    private final AtomicInteger queued = new AtomicInteger();
    private volatile AudioRecord input;
    private volatile boolean running, paused;
    private MediaProjection projection;

    static void acknowledge() {
        if (active != null) active.queued.updateAndGet(count -> Math.max(0, count - 1));
    }

    static void changePause(boolean pause, int elapsed) {
        if (active == null) return;
        active.paused = pause;
        active.showStatus(pause, elapsed, null);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || running) return START_NOT_STICKY;
        try {
            showStatus(false, 0, "等待会议音频");
            Intent consent = intent.getParcelableExtra("consent");
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(intent.getIntExtra("result", 0), consent);
            if (projection == null) throw new IllegalStateException("Missing media projection");
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { stopSelf(); }
            }, main);
            AudioPlaybackCaptureConfiguration.Builder sources = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA).addMatchingUsage(AudioAttributes.USAGE_UNKNOWN);
            int found = 0;
            for (String source : SOURCES) {
                try {
                    sources.addMatchingUid(getPackageManager().getApplicationInfo(source, 0).uid);
                    found++;
                } catch (PackageManager.NameNotFoundException ignored) {}
            }
            if (found == 0) {
                send("system-audio-error:未找到可监听的会议应用");
                stopSelf();
                return START_NOT_STICKY;
            }
            AudioFormat format = new AudioFormat.Builder().setSampleRate(RATE)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();
            int minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord recorder = new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(Math.max(minimum, SAMPLES * 16))
                .setAudioPlaybackCaptureConfig(sources.build()).build();
            input = recorder;
            active = this;
            running = true;
            new Thread(() -> readAudio(recorder), "lingji-system-audio").start();
        } catch (RuntimeException failure) {
            send("system-audio-error:系统音频无法启动，请重新授权");
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void readAudio(AudioRecord recorder) {
        short[] samples = new short[SAMPLES];
        ArrayDeque<byte[]> lead = new ArrayDeque<>();
        boolean recording = false;
        int quietChunks = 0;
        try {
            recorder.startRecording();
            main.post(() -> { if (running) send("system-audio-armed"); });
            while (running) {
                int size = 0;
                while (running && size < SAMPLES) {
                    int count = recorder.read(samples, size, SAMPLES - size, AudioRecord.READ_BLOCKING);
                    if (count <= 0) throw new IllegalStateException("Audio read interrupted");
                    size += count;
                }
                if (!running || paused) {
                    quietChunks = 0;
                    continue;
                }
                byte[] bytes = new byte[SAMPLES * 2];
                long energy = 0;
                for (int i = 0; i < SAMPLES; i++) {
                    int sample = samples[i];
                    energy += sample * sample;
                    bytes[2 * i] = (byte)sample;
                    bytes[2 * i + 1] = (byte)(sample >> 8);
                }
                if (recording) {
                    quietChunks = energy / SAMPLES < 100 * 100 ? quietChunks + 1 : 0;
                    if (quietChunks >= QUIET_CHUNKS_TO_END) {
                        main.post(this::stopSelf);
                        return;
                    }
                    queue(bytes);
                } else if (energy / SAMPLES >= 220 * 220) {
                    lead.add(bytes);
                    if (lead.size() == 3) {
                        recording = true;
                        main.post(() -> {
                            if (!running) return;
                            showStatus(false, 0, null);
                            send("system-audio-detected");
                        });
                        while (!lead.isEmpty()) queue(lead.remove());
                    }
                } else {
                    lead.clear();
                }
            }
        } catch (RuntimeException failure) {
            if (running) main.post(() -> {
                send("system-audio-error:系统音频已中断，已接收片段会保存");
                stopSelf();
            });
        } finally {
            input = null;
            recorder.release();
        }
    }

    private void queue(byte[] bytes) {
        if (queued.incrementAndGet() > 32) throw new IllegalStateException("Playback capture consumer stalled");
        String data = Base64.encodeToString(bytes, Base64.NO_WRAP);
        main.post(() -> { if (running) send("system-audio-frame:" + data); });
    }

    private void showStatus(boolean pause, int elapsed, String waiting) {
        startForeground(NOTIFICATION, RecordingService.notification(this, pause, elapsed, waiting));
    }

    private static void send(String message) {
        if (messages != null) messages.accept(message);
    }

    @Override public void onDestroy() {
        running = false;
        if (active == this) active = null;
        AudioRecord recorder = input;
        if (recorder != null) {
            try { recorder.stop(); } catch (IllegalStateException ignored) {}
        }
        if (projection != null) projection.stop();
        send("system-audio-ended");
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
