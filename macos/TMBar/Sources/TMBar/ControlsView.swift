import SwiftUI

/// The menu's Controls block (docs/menubar.md § Controls): server
/// Start/Stop/Restart, Rebuild & restart with the job's progress, Pause all /
/// Continue with the queue switch, the inline confirm and the last outcome.
struct ControlsView: View {
    let store: Store

    var body: some View {
        if let h = store.host {
            VStack(alignment: .leading, spacing: 6) {
                serverButtons(h)
                if h.api.up { queueRow }
                rebuildProgress(h)
                if let p = store.pending { confirmBox(p) }
                if let o = store.rebuildOutcome, !(h.rebuild?.inProgress ?? false) {
                    noteLine(o) { store.dismissRebuildOutcome() }
                }
                if let n = store.note { noteLine(n) { store.dismissNote() } }
            }
            .controlSize(.small)
        }
    }

    private var disabled: Bool { store.busy != nil }

    // MARK: server

    private func serverButtons(_ h: HostStatus) -> some View {
        let job = h.rebuild?.inProgress == true
        return HStack(spacing: 6) {
            if h.api.up {
                button(.restart(force: false), symbol: "arrow.clockwise")
                    .disabled(disabled || job)
                    .help("Restart the API (POST /host/restart). Refused while agents work; then you can force it.")
                button(.stop(force: false), symbol: "stop.fill")
                    .disabled(disabled || job)
                    .help("Stop the API (POST /host/stop). The front door stays up.")
            } else {
                button(.start, symbol: "play.fill")
                    .disabled(disabled || job)
                    .help("Start the API (POST /host/start)")
            }
            Spacer(minLength: 0)
            button(.rebuild, symbol: "hammer")
                .disabled(disabled || job)
                .help("Rebuild & restart, as a drain: new work pauses, live turns finish, then build, typecheck, restart, Continue.")
        }
    }

    // MARK: queue + pause

    @ViewBuilder private var queueRow: some View {
        let o = store.orch
        let paused = o?.paused == true
        HStack(spacing: 6) {
            Image(systemName: paused ? "pause.circle.fill" : (o?.enabled == true ? "tray.and.arrow.down" : "tray"))
                .foregroundStyle(paused ? Color.orange : .secondary)
                .frame(width: 14)
            Text(queueWords(o)).font(.caption).foregroundStyle(paused ? Color.orange : .secondary).lineLimit(2)
            Spacer(minLength: 4)
            if o != nil {
                if paused {
                    button(.resume, symbol: "play.circle").disabled(disabled)
                        .help("Continue: resume the suspended tasks in their own sessions, then the queues pick up.")
                } else {
                    button(.pause, symbol: "pause.circle").disabled(disabled)
                        .help("Pause all: suspend every live agent turn (resumable) and start nothing until Continue.")
                }
            }
        }
    }

    private func queueWords(_ o: OrchestratorLite?) -> String {
        guard let o else { return "Queue: —" }
        let queue = o.enabled ? "Queue on" : "Queue off"
        if o.paused == true {
            let owed = o.pausedTasks ?? 0
            return "Paused · \(queue.lowercased())" + (owed > 0 ? " · \(owed) suspended" : "")
        }
        return queue
    }

    // MARK: the rebuild job

    @ViewBuilder private func rebuildProgress(_ h: HostStatus) -> some View {
        if let r = h.rebuild, r.inProgress {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(r.step ?? r.state.capitalized).font(.caption).lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if r.state == "draining" {
                    if let w = r.waitingFor, !w.notPauseAware.isEmpty {
                        Text("The pause does not stop these — finish or stop them, or the drain times out: " + w.notPauseAware.joined(separator: ", "))
                            .font(.caption).foregroundStyle(.orange).lineLimit(4)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack {
                        if let d = Format.date(r.drainDeadline) {
                            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                                Text("gives up in " + Format.elapsed(since: ctx.date, now: d))
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        button(.cancelDrain, symbol: "xmark.circle").disabled(disabled)
                            .help("Give up the drain: the job releases the pause it set and does NOT restart.")
                    }
                }
            }
        }
    }

    // MARK: confirm + notes

    private func confirmBox(_ p: PendingControl) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(p.title).font(.subheadline.weight(.semibold))
            if let refusal = p.refusal {
                Text(refusal).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if !p.message.isEmpty {
                Text(p.message).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel") { store.cancelPending() }
                    .keyboardShortcut(.cancelAction)
                Button(p.control.title, role: p.destructive ? .destructive : nil) {
                    Task { await store.confirmPending() }
                }
                .buttonStyle(.borderedProminent)
                .tint(p.destructive ? .red : .accentColor)
                .disabled(disabled)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06)))
    }

    private func noteLine(_ n: ControlNote, dismiss: @escaping () -> Void) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(n.text).font(.caption).foregroundStyle(color(n.tone))
                .lineLimit(6).fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Spacer(minLength: 4)
            if n.tone != .info || store.busy == nil {
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Dismiss")
            }
        }
    }

    private func color(_ tone: ControlNote.Tone) -> Color {
        switch tone {
        case .info: .secondary
        case .warn: .orange
        case .error: .red
        }
    }

    private func button(_ c: Control, symbol: String) -> some View {
        Button {
            Task { await store.press(c) }
        } label: {
            Label(store.busy == c ? progressTitle(c) : c.title, systemImage: symbol)
        }
    }

    private func progressTitle(_ c: Control) -> String { c.title + "…" }
}
