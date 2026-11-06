import AppKit
import SwiftUI

/// The window behind the menu-bar item (MenuBarExtra `.window` style). Native
/// chrome only: system fonts, SF Symbols, system colours (docs/menubar.md § Look).
struct MenuView: View {
    let store: Store
    /// the two-press control that is armed (Uninstall, Force …); disarms after 4 s
    @State private var armed: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            serverSection
            ControlsView(store: store)
            serviceSection
            if store.host?.api.up == true {
                Divider()
                tasksSection
                Divider()
                inboxSection
                memorySection
            }
            Divider()
            loginRow
            footer
        }
        .padding(12)
        .frame(width: 340)
        .onAppear { store.setMenuOpen(true) }
        .onDisappear { store.setMenuOpen(false) }
    }

    // MARK: header

    private var header: some View {
        HStack {
            Image(systemName: store.state.symbol)
                .foregroundStyle(tint(store.state))
            Text("Task manager").font(.headline)
            Spacer()
            Text(stateWord(store.state)).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    // MARK: server

    @ViewBuilder private var serverSection: some View {
        if let h = store.host {
            VStack(alignment: .leading, spacing: 3) {
                if h.api.up {
                    row("server.rack", "API up" + (Format.ago(h.api.bootedAt).map { " · booted \($0)" } ?? "")
                        + " · \(h.api.restarts) restart\(h.api.restarts == 1 ? "" : "s")")
                } else {
                    row("stop.circle", "API stopped" + (h.api.desired == "down" ? " (stopped on purpose)" : ""), color: .red)
                }
                if let exit = h.api.lastExit {
                    let how = exit.signal ?? exit.code.map { "code \($0)" } ?? "?"
                    secondary("Last exit: \(how)" + (Format.ago(exit.at).map { ", \($0)" } ?? ""))
                }
                if let err = h.api.lastError { secondary("Last error: \(err)", color: .red) }
                if let r = h.rebuild, r.inProgress {
                    row("arrow.triangle.2.circlepath", "Rebuild & restart running" + (r.drain == true ? " (drain)" : ""), color: .orange)
                }
                if h.host.stale == true {
                    secondary("Front door code changed — " + (h.host.service == "launchd" ? "Restart service below" : "restart npm start"), color: .orange)
                }
                if h.host.dev { secondary("Dev mode (page on :5173)") }
            }
        } else {
            VStack(alignment: .leading, spacing: 3) {
                row("exclamationmark.triangle", "Front door not answering", color: .red)
                secondary("\(store.client.base.absoluteString) — \(store.hostError ?? "no reply")")
            }
        }
    }

    // MARK: service (docs/menubar.md § Service)

    @ViewBuilder private var serviceSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            serviceStatus
            if store.serviceRunning == nil { serviceButtons }
            if let cmd = store.serviceRunning {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(cmd.progress).font(.caption).foregroundStyle(.secondary)
                }
            } else if let o = store.serviceOutcome {
                secondary(o.summary, color: o.ok ? .secondary : .red)
                ForEach(o.warnings, id: \.self) { secondary($0, color: .orange) }
                if o.refusedWhileWorking {
                    twoPress("force-\(o.command.rawValue)", "Force \(o.command.rawValue) — kills running agents",
                             confirm: "Confirm: kill agents and \(o.command.rawValue)", role: .destructive) {
                        await store.runService(o.command, force: true)
                    }
                }
            }
            logsRow
        }
    }

    @ViewBuilder private var serviceStatus: some View {
        let svc = store.service
        if let h = store.host {
            switch store.runsAs(h) {
            case "launchd":
                row("gearshape.2", "Runs as the launchd service" + (svc?.pid.map { " · pid \($0)" } ?? ""))
            case "dev":
                row("hammer", "Runs in dev (npm run dev)")
            default:
                row("terminal", "Runs in a terminal (npm start)")
                if svc?.installed != true {
                    secondary("To run it as a service: stop npm start (Ctrl-C in its terminal), then Install service here.")
                }
            }
        } else if let svc {
            if svc.loaded && svc.running {
                row("gearshape.2", "Service running" + (svc.pid.map { " · pid \($0)" } ?? "") + " — not answering yet", color: .orange)
            } else if svc.loaded {
                row("gearshape.2", "Service stopped" + (svc.state.map { " (\($0))" } ?? ""), color: .red)
            } else if svc.installed {
                row("gearshape.2", "Service installed, not loaded", color: .red)
            } else {
                row("gearshape.2", "Service not installed")
            }
        }
    }

    @ViewBuilder private var serviceButtons: some View {
        let svc = store.service
        HStack(spacing: 6) {
            if let h = store.host {
                if store.runsAs(h) == "launchd" {
                    actionButton("Restart service") { await store.runService(.restart) }
                        .help("Restart the front door and the API (refused while agents work)")
                    actionButton("Reinstall") { await store.runService(.install) }
                        .help("Rewrite the plist from scripts/service.mjs and reload it (refused while agents work)")
                    twoPress("uninstall", "Uninstall…", confirm: "Confirm uninstall", role: .destructive) {
                        await store.runService(.uninstall)
                    }
                    .help("Stop the service and remove its plist — the task manager stays down until npm start")
                } else if svc?.loaded == true || svc?.installed == true {
                    // a service exists but a terminal/dev front door holds the port
                    twoPress("uninstall", "Uninstall service…", confirm: "Confirm uninstall", role: .destructive) {
                        await store.runService(.uninstall)
                    }
                } else {
                    Button("Install service") {}
                        .disabled(true)
                        .help("Stop the terminal front door first — the installer refuses while its port is taken")
                }
            } else if let svc {
                if svc.loaded && svc.running {
                    actionButton("Restart service") { await store.runService(.restart) }
                } else if svc.loaded || svc.installed {
                    actionButton("Start service", prominent: true) { await store.runService(.start) }
                } else {
                    actionButton("Install service", prominent: true) { await store.runService(.install) }
                        .help("Write ~/Library/LaunchAgents/\(svc.label).plist and start it (npm run service:install)")
                }
                if svc.loaded || svc.installed {
                    twoPress("uninstall", "Uninstall…", confirm: "Confirm uninstall", role: .destructive) {
                        await store.runService(.uninstall)
                    }
                }
            }
        }
        .controlSize(.small)
    }

    @ViewBuilder private var logsRow: some View {
        if let dir = store.logDir {
            let present = Logs.files.filter { FileManager.default.fileExists(atPath: dir + "/" + $0.1) }
            if !present.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text").foregroundStyle(.secondary).frame(width: 14)
                    Text("Logs").font(.caption).foregroundStyle(.secondary)
                    ForEach(present, id: \.1) { name, file in
                        Button(name) { Logs.open(dir + "/" + file) }
                            .help("Open \(file) in Console")
                    }
                    Button { Logs.reveal(dir) } label: { Image(systemName: "folder") }
                        .help("Show \(dir) in Finder")
                }
                .controlSize(.small)
            }
        }
    }

    private func actionButton(_ title: String, prominent: Bool = false, _ action: @escaping @MainActor () async -> Void) -> some View {
        Button(title) { Task { await action() } }
            .buttonStyle(prominent ? AnyPrimitiveButtonStyle(.borderedProminent) : AnyPrimitiveButtonStyle(.bordered))
    }

    /// A control that needs two presses within 4 s — for the ones that stop
    /// the task manager or kill agents.
    private func twoPress(_ key: String, _ title: String, confirm: String, role: ButtonRole? = nil,
                          _ action: @escaping @MainActor () async -> Void) -> some View {
        Button(armed == key ? confirm : title, role: role) {
            if armed == key {
                armed = nil
                Task { await action() }
            } else {
                armed = key
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    if armed == key { armed = nil }
                }
            }
        }
        .tint(armed == key ? .red : nil)
    }

    // MARK: login item

    @ViewBuilder private var loginRow: some View {
        if LoginItem.available {
            VStack(alignment: .leading, spacing: 2) {
                Toggle("Open TM Bar at login", isOn: Binding(
                    get: { store.loginStatus == .enabled || store.loginStatus == .requiresApproval },
                    set: { store.setLogin($0) }
                ))
                .toggleStyle(.checkbox)
                .controlSize(.small)
                if store.loginStatus == .requiresApproval {
                    HStack {
                        secondary("Allow it in System Settings → Login Items", color: .orange)
                        Button("Open") { LoginItem.openSettings() }.controlSize(.small)
                    }
                }
                if let e = store.loginError { secondary(e, color: .red) }
            }
        }
    }

    // MARK: tasks

    @ViewBuilder private var tasksSection: some View {
        if let err = store.summaryError {
            secondary(err, color: .orange)
        } else if let s = store.summary {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(taskHeading(s)).font(.subheadline.weight(.semibold))
                    Spacer()
                    if s.queue.paused {
                        Label("Paused", systemImage: "pause.circle").font(.caption).foregroundStyle(.orange)
                    } else if !s.queue.enabled {
                        Text("queue off").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if s.tasks.isEmpty {
                    secondary("Nothing running")
                } else {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(s.tasks.prefix(12)) { t in taskRow(t, now: ctx.date) }
                        }
                    }
                    if s.tasks.count > 12 { secondary("+ \(s.tasks.count - 12) more") }
                }
            }
        } else {
            secondary("Loading…")
        }
    }

    private func taskHeading(_ s: MenubarSummary) -> String {
        let running = s.tasks.filter { $0.status == "running" }.count
        let waiting = s.tasks.count - running
        var parts = ["\(running) running"]
        if waiting > 0 { parts.append("\(waiting) waiting") }
        return parts.joined(separator: " · ") + "  (\(s.queue.running)/\(s.queue.concurrency) slots)"
    }

    private func taskRow(_ t: MenubarSummary.TaskRow, now: Date) -> some View {
        Button {
            store.openPage(Browser.taskURL(base: store.pageBase, id: t.id))
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: taskSymbol(t))
                    .foregroundStyle(t.asking || t.needsAttention ? Color.orange : (t.status == "waiting" ? .secondary : .green))
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 0) {
                    Text(t.title).lineLimit(1).truncationMode(.tail)
                    if let repo = t.repoName {
                        Text(repo + (t.asking ? " · asks you" : t.needsAttention ? " · needs attention" : "")
                            + (t.status == "waiting" ? " · waiting" : ""))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if let start = Format.date(t.startedAt) {
                    Text(Format.elapsed(since: start, now: now))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle())
        .help("Open “\(t.title)”")
    }

    private func taskSymbol(_ t: MenubarSummary.TaskRow) -> String {
        if t.asking { return "questionmark.circle.fill" }
        if t.needsAttention { return "exclamationmark.circle.fill" }
        return t.status == "waiting" ? "hourglass" : "play.circle.fill"
    }

    // MARK: inbox + memory

    @ViewBuilder private var inboxSection: some View {
        if let s = store.summary, store.summaryError == nil {
            Button {
                store.openPage(Browser.pageURL(base: store.pageBase, path: "/inbox"))
            } label: {
                HStack {
                    Image(systemName: s.inbox.total > 0 ? "tray.full.fill" : "tray")
                        .foregroundStyle(s.inbox.urgent ? Color.orange : .secondary)
                        .frame(width: 14)
                    Text(s.inbox.total == 0 ? "Inbox empty" : "Inbox \(s.inbox.total)")
                    Spacer()
                    if s.inbox.total > 0 {
                        Text("\(s.inbox.questions) question\(s.inbox.questions == 1 ? "" : "s") · \(s.inbox.needsYou) need\(s.inbox.needsYou == 1 ? "s" : "") you")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle())
        }
    }

    @ViewBuilder private var memorySection: some View {
        if let m = store.summary?.memory, store.summaryError == nil {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Image(systemName: "memorychip").foregroundStyle(m.hold != nil ? Color.red : .secondary).frame(width: 14)
                    Text("Memory \(Format.pct(m.freePct)) free · swap \(Format.pct(m.swapPct))")
                    Spacer()
                    Text(pressureWord(m.pressureLevel)).font(.caption).foregroundStyle(.secondary)
                }
                if m.tripped || m.hold != nil {
                    secondary("Fuse holding: \(m.hold ?? m.reason ?? "tripped")", color: .red)
                } else if !m.armed {
                    secondary("Memory fuse off")
                }
                if let h = store.summary?.heavy, h.held + h.waiting > 0 {
                    secondary("Heavy slots \(h.held)/\(h.max)" + (h.waiting > 0 ? " · \(h.waiting) waiting" : ""))
                }
            }
        } else if let m = store.orch?.memory, m.hold != nil {
            secondary("Memory fuse holding: \(m.hold ?? "")", color: .red)
        }
    }

    private func pressureWord(_ level: Int?) -> String {
        switch level {
        case 1: "normal"
        case 2: "warn"
        case 4: "critical"
        default: ""
        }
    }

    // MARK: footer

    private var footer: some View {
        HStack {
            Button("Open task manager") { store.openPage(store.pageBase) }
                .keyboardShortcut("o")
            // § The window: TM Bar's own WebKit window, or the browser (Brave when installed)
            Picker("Open in", selection: Binding(get: { store.openInWindow }, set: { store.openInWindow = $0 })) {
                Text("Window").tag(true)
                Text("Browser").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("Open pages in TM Bar's own window (system WebKit) or in the browser")
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q")
        }
        .controlSize(.small)
    }

    // MARK: bits

    private func row(_ symbol: String, _ text: String, color: Color = .secondary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol).foregroundStyle(color).frame(width: 14)
            Text(text).lineLimit(2)
        }
    }

    private func secondary(_ text: String, color: Color = .secondary) -> some View {
        Text(text).font(.caption).foregroundStyle(color).lineLimit(3).fixedSize(horizontal: false, vertical: true)
    }

    private func stateWord(_ s: BarState) -> String {
        switch s {
        case .unreachable: "unreachable"
        case .stopped: "stopped"
        case .rebuilding: "rebuilding"
        case .memoryHold: "memory hold"
        case .paused: "paused"
        case .running(let n): n > 0 ? "\(n) running" : "idle"
        }
    }

    private func tint(_ s: BarState) -> Color {
        switch s {
        case .unreachable, .stopped, .memoryHold: .red
        case .rebuilding, .paused: .orange
        case .running(let n): n > 0 ? .green : .secondary
        }
    }
}

/// `.bordered` or `.borderedProminent` chosen at run time.
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

/// A menu-like row: highlight on hover, no bezel.
struct RowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Hovering { hovering in
            configuration.label
                .padding(.vertical, 2)
                .padding(.horizontal, 4)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(hovering || configuration.isPressed ? Color.primary.opacity(0.08) : .clear)
                )
        }
    }
}

private struct Hovering<Content: View>: View {
    @State private var hovering = false
    @ViewBuilder let content: (Bool) -> Content
    var body: some View {
        content(hovering).onHover { hovering = $0 }
    }
}
