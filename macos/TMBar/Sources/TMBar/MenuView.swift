import AppKit
import SwiftUI

/// The window behind the menu-bar item (MenuBarExtra `.window` style). Native
/// chrome only: system fonts, SF Symbols, system colours (docs/menubar.md § Look).
struct MenuView: View {
    let store: Store

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            Divider()
            serverSection
            if store.host?.api.up == true {
                Divider()
                tasksSection
                Divider()
                inboxSection
                memorySection
            }
            if let msg = store.actionMessage {
                Text(msg).font(.caption).foregroundStyle(.secondary)
            }
            Divider()
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
                    row("arrow.triangle.2.circlepath", "Rebuild & restart: \(r.step ?? r.state)", color: .orange)
                } else if let r = h.rebuild, r.state == "failed", let err = r.error {
                    secondary("Last rebuild failed: \(err)", color: .red)
                }
                if h.host.stale == true {
                    secondary("Front door code changed — restart " + (h.host.service == "launchd" ? "with npm run service:restart" : "npm start"), color: .orange)
                }
                if h.host.dev { secondary("Dev mode (page on :5173)") }
            }
        } else {
            VStack(alignment: .leading, spacing: 3) {
                row("exclamationmark.triangle", "Front door not answering", color: .red)
                secondary("\(store.client.base.absoluteString) — \(store.hostError ?? "no reply")")
                secondary("Start it with npm start or npm run service:install")
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
            Browser.open(Browser.taskURL(base: store.pageBase, id: t.id))
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
                Browser.open(Browser.pageURL(base: store.pageBase, path: "/inbox"))
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
            Button("Open task manager") { Browser.open(store.pageBase) }
                .keyboardShortcut("o")
            if let h = store.host, !h.api.up {
                Button("Start server") { Task { await store.startServer() } }
            }
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
