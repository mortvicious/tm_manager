import AppKit
import SwiftUI
import UserNotifications

/// `GET /api/push` (shared `PushStatus`) — only what Preferences shows.
struct PushStatusLite: Decodable, Equatable, Sendable {
    struct Device: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let label: String
        let kinds: [String]
    }
    let enabled: Bool
    let devices: [Device]
}

/// The Preferences window (docs/menubar.md § Notifications): the system
/// permission, the desktop channel, one toggle per kind, the swap line, and
/// the Web Push devices that would send the same news.
struct NotificationsView: View {
    let store: Store
    @State private var push: PushStatusLite?
    @State private var pushError: String?
    @State private var pushNote: String?

    private var notifier: Notifier { store.notifier }

    var body: some View {
        Form {
            Section {
                permissionRow
            }
            Section("Desktop channel") {
                Picker("Notify on this Mac through", selection: Binding(
                    get: { notifier.settings.channel },
                    set: { notifier.setChannel($0) }
                )) {
                    Text("TM Bar").tag(DesktopChannel.tmBar)
                    Text("the browser (Web Push)").tag(DesktopChannel.webPush)
                }
                .pickerStyle(.radioGroup)
                Text(notifier.settings.channel == .tmBar
                     ? "TM Bar posts every kind below. Turn the same kinds off in this Mac's browser (below) so nothing arrives twice."
                     : "The browser's Web Push posts questions, needs attention, reviews and the memory fuse (Anomalies). TM Bar keeps only what Web Push cannot send: the API stopping, Rebuild & restart, the swap line.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Notify me about") {
                ForEach(NotifyKind.allCases) { kind in kindRow(kind) }
                HStack {
                    Text("Swap alert line")
                    Spacer()
                    Stepper(value: Binding(get: { notifier.settings.swapLine }, set: { notifier.setSwapLine($0) }),
                            in: 0...100, step: 5) {
                        Text(notifier.settings.swapLine == 0 ? "off" : "\(notifier.settings.swapLine)%").monospacedDigit()
                    }
                }
                .disabled(!notifier.settings.enabled.contains(.swap))
            }
            Section("Web Push devices") { pushSection }
            Section {
                HStack {
                    Button("Send a test") { notifier.test() }
                        .disabled(notifier.authorization == .denied)
                    Spacer()
                    if let last = notifier.recent.first {
                        Text("last: \(last.alert.title), \(Format.elapsed(since: last.at)) ago")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .frame(minHeight: 560)
        .task { await loadPush() }
        .onAppear { notifier.refreshAuthorization() }
    }

    // MARK: rows

    @ViewBuilder private var permissionRow: some View {
        switch notifier.authorization {
        case .authorized, .provisional, .ephemeral:
            Label("Notifications allowed", systemImage: "checkmark.circle").foregroundStyle(.green)
        case .denied:
            HStack {
                Label("Notifications are off for TM Bar", systemImage: "bell.slash").foregroundStyle(.orange)
                Spacer()
                Button("System Settings…") { Self.openSystemSettings() }
            }
        default:
            HStack {
                Label("TM Bar has not asked yet", systemImage: "bell").foregroundStyle(.secondary)
                Spacer()
                Button("Allow…") { Task { await notifier.askIfNeeded() } }
            }
        }
    }

    private func kindRow(_ kind: NotifyKind) -> some View {
        let leftToPush = notifier.settings.channel == .webPush && kind.pushKind != nil
        return Toggle(isOn: Binding(
            get: { notifier.settings.enabled.contains(kind) && !leftToPush },
            set: { notifier.setEnabled(kind, $0) }
        )) {
            VStack(alignment: .leading, spacing: 1) {
                Text(kind.label)
                Text(leftToPush ? "Web Push sends this (desktop channel)" : kind.hint)
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .disabled(leftToPush)
    }

    // MARK: Web Push

    /// the Web Push kinds TM Bar sends itself right now
    private var tmBarPushKinds: Set<String> {
        guard notifier.settings.channel == .tmBar else { return [] }
        return Set(NotifyKind.allCases.filter { notifier.settings.posts($0) }.compactMap(\.pushKind))
    }

    @ViewBuilder private var pushSection: some View {
        if let pushError {
            Text(pushError).font(.caption).foregroundStyle(.secondary)
        } else if let push {
            if push.devices.isEmpty {
                Text(push.enabled ? "No browser is subscribed to Web Push." : "Web Push is off on the server.")
                    .font(.caption).foregroundStyle(.secondary)
                if notifier.settings.channel == .webPush {
                    Text("With no device, nothing posts what the channel leaves to Web Push.")
                        .font(.caption).foregroundStyle(.orange)
                }
            } else {
                ForEach(push.devices) { device in deviceRow(device) }
                Text("The server cannot tell which device is this Mac — the label is what the browser set when it subscribed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let pushNote { Text(pushNote).font(.caption).foregroundStyle(.secondary) }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func deviceRow(_ d: PushStatusLite.Device) -> some View {
        let overlap = Set(d.kinds).intersection(tmBarPushKinds).sorted()
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text(d.label.isEmpty ? "unnamed device" : d.label)
                Text(overlap.isEmpty ? "nothing TM Bar also sends" : "also sends: \(overlap.joined(separator: ", "))")
                    .font(.caption).foregroundStyle(overlap.isEmpty ? Color.secondary : .orange)
            }
            Spacer()
            if !overlap.isEmpty {
                Button("Turn these off") { Task { await stripOverlap(d, overlap) } }
                    .help("Removes \(overlap.joined(separator: ", ")) from this device's Web Push kinds. Every other kind stays (Anomalies also carries cost and long-run alerts).")
            }
        }
    }

    private func loadPush() async {
        do {
            push = try await store.client.get("/api/push", as: PushStatusLite.self)
            pushError = nil
        } catch {
            pushError = store.host?.api.up == false ? "The API is down — Web Push devices show when it is up." : Store.describe(error)
        }
    }

    /// PATCH the device's kinds minus the overlap — the web page's own request
    /// (loopback Origin), so the push route's browser-only guard judges it as a click.
    private func stripOverlap(_ d: PushStatusLite.Device, _ overlap: [String]) async {
        let kinds = d.kinds.filter { !overlap.contains($0) }
        do {
            let r = try await store.client.patch("/api/push/devices/\(d.id)", ["kinds": kinds])
            pushNote = r.ok ? "\(d.label): \(overlap.joined(separator: ", ")) turned off." : (r.error ?? "HTTP \(r.status)")
        } catch {
            pushNote = Store.describe(error)
        }
        await loadPush()
    }

    static func openSystemSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }
}
