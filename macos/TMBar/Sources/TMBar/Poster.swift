import AppKit
import Foundation
import UserNotifications
import os

/// The UserNotifications side (docs/menubar.md § Notifications): asks for
/// permission the first time a kind is on, posts, and opens the page a click
/// names. Posting needs a real bundle — `swift run`'s bare binary has no
/// bundle id and `UNUserNotificationCenter.current()` traps there — so the
/// poster is only created inside `TM Bar.app` (`Poster.available`).
@MainActor
final class Poster: NSObject, UNUserNotificationCenterDelegate {
    static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    private let log = Logger(subsystem: "com.taskmanager.bar", category: "notify")
    /// the base pages open under; the store keeps it current (dev → Vite)
    var pageBase: () -> URL = { Config.baseURL() }
    /// how a page opens: the store's Open in choice (TM Bar's window or the browser)
    var opener: @MainActor (URL) -> Void = { Browser.open($0) }
    /// what the system says about TM Bar's notifications (Preferences shows it)
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    var onAuthorizationChange: ((UNAuthorizationStatus) -> Void)?

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    func start() {
        center.delegate = self
        refreshAuthorization()
    }

    func refreshAuthorization() {
        Task {
            let s = await center.notificationSettings().authorizationStatus
            authorization = s
            onAuthorizationChange?(s)
        }
    }

    /// Ask once; the system remembers the answer (System Settings → Notifications → TM Bar).
    func requestAuthorization() async -> Bool {
        do {
            let ok = try await center.requestAuthorization(options: [.alert, .sound])
            log.notice("authorization \(ok ? "granted" : "denied", privacy: .public)")
            refreshAuthorization()
            return ok
        } catch {
            log.error("authorization failed: \(error.localizedDescription, privacy: .public)")
            refreshAuthorization()
            return false
        }
    }

    func post(_ alert: Alert) {
        let content = UNMutableNotificationContent()
        content.title = alert.title
        content.body = alert.body
        content.sound = alert.kind.urgent ? .default : nil
        content.threadIdentifier = alert.kind.rawValue
        content.userInfo = ["path": alert.path, "kind": alert.kind.rawValue]
        // the episode key is the identifier: a re-post of the same episode
        // REPLACES the banner in Notification Center instead of stacking
        let request = UNNotificationRequest(identifier: alert.key, content: content, trigger: nil)
        log.notice("post \(alert.kind.rawValue, privacy: .public) \(alert.key, privacy: .public)")
        center.add(request) { [log] error in
            if let error { log.error("post failed: \(error.localizedDescription, privacy: .public)") }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// TM Bar is an LSUIElement app that is "active" while its menu is open:
    /// show the banner then too.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let path = response.notification.request.content.userInfo["path"] as? String
        else { return }
        await MainActor.run { self.open(path) }
    }

    func open(_ path: String) {
        guard let url = Self.url(base: pageBase(), path: path) else { return }
        log.notice("open \(url.absoluteString, privacy: .public)")
        opener(url)
    }

    /// `path` is an in-app path with an optional query (`/?task=…&tab=review`).
    nonisolated static func url(base: URL, path: String) -> URL? {
        guard path.hasPrefix("/"), let rel = URLComponents(string: path),
              var c = URLComponents(url: base, resolvingAgainstBaseURL: false)
        else { return nil }
        c.path = rel.path
        c.queryItems = rel.queryItems
        return c.url
    }
}
