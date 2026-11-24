import AVFoundation

final class NativeMicrophone {
    private let session = AVAudioSession.sharedInstance()
    private var capture: Capture?
    private var startingID: String?
    private var engine: AVAudioEngine?
    private var interruption: NSObjectProtocol?
    private var wantsRecording = false
    private let reply: (String) -> Void

    init(reply: @escaping (String) -> Void) {
        self.reply = reply
        interruption = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
    }

    deinit {
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        stopEngine()
    }

    func receive(_ command: String) {
        guard command.count <= 80 else { return }
        let parts = command.split(separator: ":")
        guard parts.count == 2 || parts.count == 3, UUID(uuidString: String(parts[1])) != nil else { return }
        let id = String(parts[1])
        if parts[0] == "native-start" && parts.count == 2 {
            start(id)
            return
        }
        guard let capture, capture.id == id else {
            if parts[0] == "native-read" && parts.count == 3 && startingID == id {
                send(id, "read:\(parts[2]):starting")
            }
            return
        }
        switch parts[0] {
        case "native-read":
            guard parts.count == 3, let offset = Int(parts[2]), offset >= 0, offset.isMultiple(of: 2) else { return }
            capture.read(offset: offset) { [weak self] result in self?.send(id, "read:\(offset):" + result) }
        case "native-status":
            capture.status { [weak self] result in self?.send(id, result) }
        case "native-pause":
            wantsRecording = false
            stopEngine()
        case "native-resume":
            wantsRecording = true
            resume(capture)
        case "native-finish":
            finish()
        case "native-release":
            capture.remove()
            self.capture = nil
        default:
            break
        }
    }

    func finish() {
        wantsRecording = false
        startingID = nil
        stopEngine()
        capture?.finish()
    }

    private func send(_ id: String, _ result: String) {
        reply(id + ":" + result)
    }

    private func start(_ id: String) {
        guard engine == nil, startingID == nil else { send(id, "error"); return }
        startingID = id
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.startingID == id else { return }
                self.startingID = nil
                guard granted else { self.send(id, "permission"); return }
                do {
                    let recording = try Capture(id: id)
                    self.capture = recording
                    try self.startEngine(recording)
                    self.wantsRecording = true
                    recording.status { [weak self] result in self?.send(id, result) }
                } catch {
                    self.stopEngine()
                    self.capture?.remove()
                    self.capture = nil
                    self.send(id, "error")
                }
            }
        }
    }

    private func startEngine(_ capture: Capture) throws {
        guard engine == nil else { return }
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)
        let recorder = AVAudioEngine()
        let input = recorder.inputNode
        let hardware = input.outputFormat(forBus: 0)
        guard hardware.channelCount > 0, hardware.sampleRate > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: hardware, to: format),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_384) else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: hardware) { [weak self] input, _ in
            var used = false
            let result = converter.convert(to: output, error: nil) { _, status in
                status.pointee = used ? .noDataNow : .haveData
                guard !used else { return nil }
                used = true
                return input
            }
            guard result != .error, let samples = output.int16ChannelData?[0], output.frameLength > 0 else { return }
            let count = Int(output.frameLength)
            var energy = 0.0
            for index in 0..<count {
                let value = Double(samples[index]) / 32_768
                energy += value * value
            }
            let bytes = Data(bytes: samples, count: count * 2)
            capture.append(bytes, rms: sqrt(energy / Double(count))) { [weak self] in
                guard let self, self.capture === capture else { return }
                self.finish()
            }
        }
        engine = recorder
        recorder.prepare()
        try recorder.start()
    }

    private func stopEngine(deactivate: Bool = true) {
        if let engine {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            self.engine = nil
        }
        if deactivate { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
    }

    private func resume(_ capture: Capture) {
        do {
            try startEngine(capture)
            send(capture.id, "native-resumed")
        } catch {
            stopEngine()
            send(capture.id, "native-paused")
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard let capture, wantsRecording,
              let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            stopEngine(deactivate: false)
            send(capture.id, "native-paused")
        } else if let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
                  AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) {
            resume(capture)
        }
    }
}

private final class Capture {
    let id: String
    private let queue = DispatchQueue(label: "com.tts.meeting.microphone-file", qos: .userInitiated)
    private let url: URL
    private let file: FileHandle
    private let chunkSize = 32_000
    private let limit = 0xffff_ffda
    private var bytesWritten = 0
    private var level = 0.0
    private var ended = false
    private var failed = false

    init(id: String) throws {
        self.id = id
        let directory = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("LingJiRecording", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        url = directory.appendingPathComponent(id + ".pcm")
        try Data().write(to: url, options: [.withoutOverwriting, .completeFileProtectionUntilFirstUserAuthentication])
        file = try FileHandle(forUpdating: url)
    }

    func append(_ bytes: Data, rms: Double, limitReached: @escaping () -> Void) {
        queue.async {
            guard !self.ended, !self.failed, self.bytesWritten < self.limit else { return }
            let pcm = bytes.prefix(self.limit - self.bytesWritten)
            do {
                try self.file.seek(toOffset: UInt64(self.bytesWritten))
                try self.file.write(contentsOf: pcm)
                self.level = rms
                self.bytesWritten += pcm.count
            } catch {
                self.failed = true
            }
            if self.failed || self.bytesWritten == self.limit { DispatchQueue.main.async(execute: limitReached) }
        }
    }

    func read(offset: Int, reply: @escaping (String) -> Void) {
        queue.async {
            let available = self.bytesWritten - offset
            let result: String
            if available < 0 {
                result = "error"
            } else if available < self.chunkSize && !self.ended {
                result = "wait"
            } else if available == 0 {
                result = self.failed ? "error" : "end"
            } else {
                do {
                    let count = min(available, self.chunkSize)
                    try self.file.seek(toOffset: UInt64(offset))
                    if let bytes = try self.file.read(upToCount: count), bytes.count == count {
                        result = bytes.base64EncodedString()
                    } else {
                        result = "error"
                    }
                } catch {
                    result = "error"
                }
            }
            DispatchQueue.main.async { reply(result) }
        }
    }

    func status(reply: @escaping (String) -> Void) {
        queue.async {
            let result = "status:\(self.bytesWritten):\(self.level)"
            DispatchQueue.main.async { reply(result) }
        }
    }

    func finish() { queue.async { self.ended = true } }

    func remove() {
        queue.async {
            try? self.file.close()
            try? FileManager.default.removeItem(at: self.url)
        }
    }
}
