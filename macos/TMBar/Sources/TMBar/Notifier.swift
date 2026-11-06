import Foundation
import Observation
import UserNotifications
import os

/// TM Bar's notifications (docs/menubar.md § Notifications): the preferences
/// (UserDefaults `com.taskmanager.bar`, keys `notify.*`), the engine's state,
/// and the poster. The store calls `observe` once per finished poll.
@MainActor
@Observable
final class Notifier {
    private(set) var settings: NotifySettings
    /// the system's answer (System Settings → Notifications → TM Bar)
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    /// the last few posts, newest first (Preferences shows them; verification)
    private(set) var recent: [(at: Date, alert: Alert)] = []

    @ObservationIgnored private var engine = NotifyEngine()
    @ObservationIgnored private var asking: Task<Void, Never>?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let poster: Poster?
    @ObservationIgnored private let log = Logger(subsystem: "com.taskmanager.bar", category: "notify")
    /// tests: what would have been posted
    @ObservationIgnored var sink: ((Alert) -> Void)?

    init(defaults: UserDefaults = .standard, post: Bool = Poster.available) {
        self.defaults = defaults
        settings = Self.load(defaults)
        poster = post ? Poster() : nil
        if let poster {
            poster.onAuthorizationChange = { [weak self] s in self?.authorization = s }
            poster.start()
        }
    }

    func setPageBase(_ base: @escaping () -> URL) { poster?.pageBase = base }
    func setOpener(_ open: @escaping @MainActor (URL) -> Void) { poster?.opener = open }

    // MARK: preferences

    private static func load(_ d: UserDefaults) -> NotifySettings {
        var s = NotifySettings()
        for kind in NotifyKind.allCases {
            if let on = d.object(forKey: "notify.\(kind.rawValue)") as? Bool {
                if on { s.enabled.insert(kind) } else { s.enabled.remove(kind) }
            }
        }
        if let raw = d.string(forKey: "notify.channel"), let c = DesktopChannel(rawValue: raw) { s.channel = c }
        if let line = d.object(forKey: "notify.swapLine") as? Int { s.swapLine = min(max(line, 0), 100) }
        return s
    }

    func setEnabled(_ kind: NotifyKind, _ on: Bool) {
        if on { settings.enabled.insert(kind) } else { settings.enabled.remove(kind) }
        defaults.set(on, forKey: "notify.\(kind.rawValue)")
        if on { Task { await askIfNeeded() } }
    }

    func setChannel(_ c: DesktopChannel) {
        settings.channel = c
        defaults.set(c.rawValue, forKey: "notify.channel")
    }

    func setSwapLine(_ line: Int) {
        settings.swapLine = min(max(line, 0), 100)
        defaults.set(settings.swapLine, forKey: "notify.swapLine")
    }

    // MARK: permission

    /// Ask the system once, when something would be posted. A denial is final
    /// until the human changes it in System Settings.
    func askIfNeeded() async {
        // single-flight: the launch ask and a toggle (or the test hook) must
        // not put two requests in front of usernoted at once
        if let asking {
            await asking.value
            return
        }
        guard let poster, !settings.enabled.isEmpty else { return }
        let task = Task { @MainActor in
            let s = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            self.authorization = s
            if s == .notDetermined { _ = await poster.requestAuthorization() }
        }
        asking = task
        await task.value
        asking = nil
    }

    func refreshAuthorization() { poster?.refreshAuthorization() }

    // MARK: the rules

    /// One finished poll's readings → the alerts to post.
    func observe(_ reading: NotifyReading) {
        let alerts = engine.step(reading, settings: settings)
        for a in alerts { deliver(a) }
    }

    /// Preferences' "Send a test" and `TM_BAR_NOTIFY_TEST=1`.
    func test() {
        deliver(Alert(kind: .rebuild, key: "test:\(Date().timeIntervalSince1970)", title: "TM Bar test",
                      body: "Notifications from TM Bar work. A click opens the task manager.", path: "/"))
    }

    private func deliver(_ a: Alert) {
        log.notice("notify \(a.kind.rawValue, privacy: .public) \(a.key, privacy: .public) → \(a.path, privacy: .public)")
        recent.insert((Date(), a), at: 0)
        if recent.count > 8 { recent.removeLast() }
        sink?(a)
        poster?.post(a)
    }
}
