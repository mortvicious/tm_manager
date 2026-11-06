import Foundation

// The notification rules (docs/menubar.md § Notifications). Pure: the store
// hands each poll's readings to `NotifyEngine.step`, which says what to post.
// One notification per EPISODE — the same rule the Telegram/push notifiers
// follow — and the first reading is always a baseline, so launching TM Bar
// never replays what was already true.

/// What TM Bar can notify about. `pushKind` = the Web Push kind (shared
/// `PUSH_KINDS`) that already sends the same news; with the desktop channel
/// set to Web Push those are left to the browser.
enum NotifyKind: String, CaseIterable, Codable, Sendable, Identifiable {
    case crash, rebuild, memory, swap, question, attention, review

    var id: String { rawValue }

    var label: String {
        switch self {
        case .crash: "API stopped unexpectedly"
        case .rebuild: "Rebuild & restart finished or failed"
        case .memory: "Memory fuse tripped"
        case .swap: "Swap above the alert line"
        case .question: "Questions"
        case .attention: "Needs attention"
        case .review: "Ready for review"
        }
    }

    var hint: String {
        switch self {
        case .crash: "a crash, a kill or an unannounced signal — never a Stop, Restart or Rebuild somebody asked for"
        case .rebuild: "the job's outcome, also when you started it from the web page"
        case .memory: "the memory fuse started holding new work (docs/memory.md)"
        case .swap: "this Mac's swap use crossed the line below, fuse armed or not"
        case .question: "an agent asks you something"
        case .attention: "an agent is stuck on a prompt in its hidden terminal"
        case .review: "a task's review settled and it waits for you"
        }
    }

    /// the Web Push kind that sends the same news, if any
    var pushKind: String? {
        switch self {
        case .question: "question"
        case .attention: "attention"
        case .review: "review"
        case .memory: "anomaly" // the `memory-pressure` anomaly
        case .crash, .rebuild, .swap: nil // the API is down / the job is the front door's / no push rule
        }
    }

    var isInbox: Bool { self == .question || self == .attention || self == .review }

    /// on until turned off: the server's own health. The Inbox kinds are opt-in.
    var defaultOn: Bool { !isInbox }

    /// plays a sound
    var urgent: Bool { self == .crash || self == .question || self == .attention }
}

/// Where desktop notifications come from on this Mac — one channel, never both.
enum DesktopChannel: String, CaseIterable, Codable, Sendable {
    /// TM Bar posts every kind that is on
    case tmBar
    /// the browser's Web Push posts what it covers; TM Bar keeps the rest
    case webPush
}

/// A snapshot of the preferences the engine reads (Prefs.swift persists them).
struct NotifySettings: Equatable, Sendable {
    var enabled: Set<NotifyKind> = Set(NotifyKind.allCases.filter(\.defaultOn))
    var channel: DesktopChannel = .tmBar
    /// swap % that opens a swap episode; 0 = off
    var swapLine: Int = 80

    static let swapHysteresis = 5

    /// TM Bar posts this kind
    func posts(_ kind: NotifyKind) -> Bool {
        guard enabled.contains(kind) else { return false }
        if kind == .swap && swapLine <= 0 { return false }
        return channel == .tmBar || kind.pushKind == nil
    }

    /// the summary route must be read even with the menu closed (Inbox rows,
    /// and a swap reading the fuse only takes while it is armed)
    var needsSummary: Bool { NotifyKind.allCases.contains { ($0.isInbox || $0 == .swap) && posts($0) } }
}

/// One notification the engine decided to post.
struct Alert: Equatable, Sendable {
    let kind: NotifyKind
    /// the episode key: also the notification's identifier
    let key: String
    let title: String
    let body: String
    /// in-app path the click opens (`/?task=<id>&tab=review`, `/inbox`, `/dashboard`)
    let path: String
}

/// Once-per-episode bookkeeping for a set-valued source: an alert fires only
/// for a key that was not active on the previous reading. A missing reading
/// (API down, route failing) is simply not passed in, so `active` is kept and
/// nothing re-fires when the API comes back in the same state.
struct EpisodeTracker: Sendable {
    private(set) var active: Set<String> = []
    private(set) var seeded = false

    mutating func update(_ current: [Alert]) -> [Alert] {
        let keys = Set(current.map(\.key))
        defer {
            active = keys
            seeded = true
        }
        guard seeded else { return [] }
        var seen = Set<String>()
        return current.filter { !active.contains($0.key) && seen.insert($0.key).inserted }
    }

    mutating func reset() {
        active = []
        seeded = false
    }
}

/// The inputs of one poll. `nil` = no reading this time.
struct NotifyReading: Sendable {
    var host: HostStatus?
    /// the fuse as last read (summary or /api/orchestrator)
    var fuseTripped: Bool?
    var fuseReason: String?
    var swapPct: Double?
    /// a summary read THIS poll (never a stale one)
    var summary: MenubarSummary?
    /// the summary was wanted for notifications this poll (false = the inbox
    /// source is off, so its episodes start over when it comes back)
    var inboxWanted: Bool = true
    var now: Date = Date()
}

struct NotifyEngine: Sendable {
    /// the API counts as recovered after this long up; a crash loop inside it is ONE episode
    static let crashSettle: TimeInterval = 60

    private var crashSeeded = false
    private var lastExitAt: String?
    private(set) var crashOpen = false
    private var rebuild = EpisodeTracker()
    private var fuse = EpisodeTracker()
    private var inbox = EpisodeTracker()
    private var swapSeeded = false
    private(set) var swapOpen = false
    private var swapEpisode = 0

    /// Every source is stepped whatever the settings say — so turning a kind
    /// on never replays its current state — and only what `settings.posts`
    /// keeps is returned.
    mutating func step(_ r: NotifyReading, settings: NotifySettings) -> [Alert] {
        var out: [Alert] = []
        if let host = r.host {
            out += stepCrash(host, now: r.now)
            out += rebuild.update(rebuildAlert(host).map { [$0] } ?? [])
        }
        if let tripped = r.fuseTripped {
            out += fuse.update(tripped ? [fuseAlert(r.fuseReason)] : [])
        }
        if let swap = r.swapPct { out += stepSwap(swap, line: settings.swapLine) }
        if !r.inboxWanted {
            inbox.reset()
        } else if let s = r.summary, let items = s.inbox.items {
            out += inbox.update(items.compactMap(inboxAlert))
        }
        return out.filter { settings.posts($0.kind) }
    }

    // MARK: crash

    /// An unexpected exit opens an episode; it closes once the API has been up
    /// `crashSettle` straight. A crash loop with backoff is one notification.
    private mutating func stepCrash(_ host: HostStatus, now: Date) -> [Alert] {
        let exit = host.api.lastExit
        defer { lastExitAt = exit?.at }
        if crashOpen, host.api.up, let booted = Format.date(host.api.bootedAt),
           now.timeIntervalSince(booted) >= Self.crashSettle {
            crashOpen = false
        }
        guard crashSeeded else {
            crashSeeded = true
            return []
        }
        guard let exit, exit.at != lastExitAt, Self.unexpected(exit, host) else { return [] }
        guard !crashOpen else { return [] }
        crashOpen = true
        return [Alert(kind: .crash, key: "crash:\(exit.at)", title: "Task manager API stopped unexpectedly",
                      body: Self.crashBody(exit, host), path: "/dashboard")]
    }

    /// The front door's verdict when it gives one (`expected`, read off the
    /// stop-cause record). An older front door gives none: then a stop it was
    /// asked for (desired down) or a rebuild's restart is expected, and so is
    /// a clean exit 0 (the restart route exits 0); a signal or a non-zero code is not.
    static func unexpected(_ exit: HostStatus.API.Exit, _ host: HostStatus) -> Bool {
        if let expected = exit.expected { return !expected }
        if host.api.desired != "up" { return false }
        if host.rebuild?.inProgress == true { return false }
        return exit.signal != nil || (exit.code ?? 0) != 0
    }

    static func crashBody(_ exit: HostStatus.API.Exit, _ host: HostStatus) -> String {
        let how = exit.signal ?? exit.code.map { "exit \($0)" } ?? "exit"
        var what: String
        switch exit.cause {
        case "crash": what = "It crashed" + (exit.detail.map { ": \($0)" } ?? "") + "."
        case "signal": what = "It got \(how) that nobody announced."
        case "unknown": what = "It ended (\(how)) without a stop record — killed, out of memory, or a hard crash."
        default: what = "It ended (\(how))."
        }
        let next = host.api.desired == "up" && host.api.managed
            ? "The front door is restarting it."
            : "It stays down — start it from TM Bar."
        return "\(what) \(next)"
    }

    // MARK: rebuild

    private func rebuildAlert(_ host: HostStatus) -> Alert? {
        guard let job = host.rebuild, let finished = job.finishedAt else { return nil }
        let key = "rebuild:\(job.startedAt ?? finished)"
        switch job.state {
        case "done":
            var body = "The new build is live."
            if job.continued == true { body += " The queue was continued." }
            if let e = job.error { body += " \(e)" }
            return Alert(kind: .rebuild, key: key, title: "Rebuild & restart finished", body: body, path: "/")
        case "failed":
            if job.reason == "cancelled" { return nil } // the human cancelled it; not news to them
            let why = job.error ?? job.reason ?? "no reason given"
            return Alert(kind: .rebuild, key: key, title: "Rebuild & restart failed", body: why, path: "/")
        default:
            return nil
        }
    }

    // MARK: memory

    private func fuseAlert(_ reason: String?) -> Alert {
        Alert(kind: .memory, key: "memory:fuse", title: "Memory fuse tripped",
              body: (reason ?? "Memory is tight") + " — new automatic work waits until it clears.", path: "/dashboard")
    }

    /// Opens at or above the line, closes `swapHysteresis` points below it — a
    /// reading wobbling around the line is one episode.
    private mutating func stepSwap(_ pct: Double, line: Int) -> [Alert] {
        guard line > 0 else {
            swapOpen = false
            swapSeeded = false
            return []
        }
        let wasSeeded = swapSeeded
        swapSeeded = true
        if swapOpen {
            if pct < Double(line - NotifySettings.swapHysteresis) { swapOpen = false }
            return []
        }
        guard pct >= Double(line) else { return [] }
        swapOpen = true
        swapEpisode += 1
        guard wasSeeded else { return [] } // above the line at launch: the baseline
        return [Alert(kind: .swap, key: "swap:\(swapEpisode)", title: "Swap above \(line)%",
                      body: "This Mac is using \(Int(pct.rounded()))% of its swap. Memory is tight: agents and builds slow down.",
                      path: "/dashboard")]
    }

    // MARK: inbox

    private func inboxAlert(_ i: MenubarSummary.Inbox.Item) -> Alert? {
        guard let kind = NotifyKind(rawValue: i.kind), kind.isInbox else { return nil }
        let task = i.taskId.map { "/?task=\($0)" } ?? "/inbox"
        let repo = i.repoName.map { " · \($0)" } ?? ""
        switch kind {
        case .question:
            return Alert(kind: kind, key: i.key, title: "Question", body: "\(i.title)\(repo) — an agent asks you", path: task)
        case .attention:
            return Alert(kind: kind, key: i.key, title: "Needs attention", body: "\(i.title)\(repo) — stuck on a prompt", path: task)
        case .review:
            let path = i.taskId.map { "/?task=\($0)&tab=review" } ?? "/inbox"
            return Alert(kind: kind, key: i.key, title: i.ready ? "Ready to land" : "Ready for review",
                         body: "\(i.title)\(repo)", path: path)
        default:
            return nil
        }
    }
}
