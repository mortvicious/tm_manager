import Foundation

/// The server controls (docs/menubar.md § Controls). Each is the web page's
/// own request — same route, same body, same loopback Origin — so every guard
/// and refusal is the server's, never restated here.
enum Control: Equatable, Sendable {
    case start
    case stop(force: Bool)
    case restart(force: Bool)
    /// Rebuild & restart, always as a drain (the web button's own default)
    case rebuild
    case cancelDrain
    case pause
    case resume // Continue

    var title: String {
        switch self {
        case .start: "Start"
        case .stop(let f): f ? "Force stop" : "Stop"
        case .restart(let f): f ? "Force restart" : "Restart"
        case .rebuild: "Rebuild & restart"
        case .cancelDrain: "Cancel drain"
        case .pause: "Pause all"
        case .resume: "Continue"
        }
    }
}

struct PendingControl: Equatable {
    let control: Control
    let title: String
    let message: String
    /// a refusal shown verbatim (the restart check's sentence), above `message`
    let refusal: String?
    let destructive: Bool
    let at: Date
}

struct ControlNote: Equatable {
    enum Tone { case info, warn, error }
    let text: String
    let tone: Tone
    let at: Date
}

extension Store {
    /// A press. Controls that stop work (or spend money again) ask first;
    /// Start and Cancel drain go straight through.
    func press(_ control: Control) async {
        guard busy == nil else { return }
        switch control {
        case .start, .cancelDrain:
            await perform(control)
        default:
            pending = await confirmation(for: control)
        }
    }

    func confirmPending() async {
        guard let p = pending else { return }
        pending = nil
        await perform(p.control)
    }

    func cancelPending() { pending = nil }

    func dismissNote() { note = nil }

    // MARK: confirm texts

    private func confirmation(for control: Control) async -> PendingControl {
        let running = orch?.running ?? 0
        switch control {
        case .stop, .restart:
            // What else dies with the API (dev servers, terminals): the same
            // restart check the routes ask, read for the sentence only.
            let check = try? await client.get("/api/server/restart-check", as: RestartCheck.self)
            var parts: [String] = []
            if let n = check?.services, n > 0 { parts.append("\(n) running repo command(s)") }
            if let n = check?.shells, n > 0 { parts.append("\(n) terminal(s)") }
            let extra = parts.isEmpty ? "" : " \(parts.joined(separator: " and ")) will be stopped with it."
            let isStop = { if case .stop = control { return true }; return false }()
            return PendingControl(
                control: control,
                title: isStop ? "Stop the API?" : "Restart the API?",
                message: (isStop
                    ? "The front door stays up; Start brings the API back."
                    : "The API stops and the front door starts it again.") + extra
                    + " If agents are working the server refuses, and you can then force it.",
                refusal: nil, destructive: true, at: Date())
        case .rebuild:
            let paused = orch?.paused == true
            let message = running > 0
                ? "\(running) agent session(s) working: new work is paused, live turns finish on their own (up to 30 min), then the web app is rebuilt, typechecked and the API restarted. Nothing is suspended; Continue is pressed for you."
                : "Builds the web app, typechecks and restarts the API. New work is paused for the duration and resumed after"
                    + (paused ? " — you paused, so Continue stays yours." : ".")
            return PendingControl(control: control, title: running > 0 ? "Drain & rebuild?" : "Rebuild & restart?",
                                  message: message, refusal: nil, destructive: true, at: Date())
        case .pause:
            return PendingControl(
                control: control, title: "Pause all?",
                message: (running > 0 ? "Suspends \(running) live agent turn(s) — each resumes in its own session on Continue — " : "")
                    + "Nothing automatic starts until Continue. Nothing is cancelled.",
                refusal: nil, destructive: true, at: Date())
        case .resume:
            let owed = orch?.pausedTasks ?? 0
            return PendingControl(
                control: control, title: "Continue?",
                message: (owed > 0 ? "Resumes \(owed) suspended task(s) in their own sessions, then " : "")
                    + "the queues pick up where they were (this spends money again).",
                refusal: nil, destructive: false, at: Date())
        case .start, .cancelDrain:
            return PendingControl(control: control, title: control.title, message: "", refusal: nil, destructive: false, at: Date())
        }
    }

    // MARK: requests

    func perform(_ control: Control) async {
        busy = control
        note = ControlNote(text: progressWord(control), tone: .info, at: Date())
        defer { busy = nil }
        do {
            let r: Reply
            switch control {
            case .start: r = try await client.post("/host/start")
            case .stop(let force): r = try await client.post("/host/stop", ["force": force])
            case .restart(let force): r = try await client.post("/host/restart", ["force": force])
            case .rebuild: r = try await client.post("/host/rebuild-restart", ["drain": true])
            case .cancelDrain: r = try await client.post("/host/rebuild-restart/cancel")
            case .pause: r = try await client.post("/api/orchestrator/pause")
            case .resume: r = try await client.post("/api/orchestrator/continue")
            }
            settle(control, r)
        } catch {
            note = ControlNote(text: "\(control.title) failed: \(Self.describe(error))", tone: .error, at: Date())
        }
        await poll()
    }

    /// What the reply means. A refusal is shown verbatim; the restart check's
    /// "agents working" refusal (409 with `blocked`) becomes the Force offer.
    func settle(_ control: Control, _ r: Reply) {
        let now = Date()
        if r.ok {
            note = ControlNote(text: doneWord(control, r), tone: .info, at: now)
            return
        }
        let error = r.error ?? "HTTP \(r.status)"
        if r.status == 409, r.json["blocked"] as? Bool == true {
            switch control {
            case .stop(force: false), .restart(force: false):
                let forced: Control = { if case .stop = control { return .stop(force: true) }; return .restart(force: true) }()
                note = nil
                pending = PendingControl(
                    control: forced,
                    title: "\(control.title) refused",
                    message: "Forcing kills them and fails their tasks. Pause all first suspends them instead, so each resumes in its own session on Continue.",
                    refusal: error, destructive: true, at: now)
                return
            default:
                break
            }
        }
        note = ControlNote(text: "\(control.title) refused: \(error)", tone: r.status >= 500 ? .error : .warn, at: now)
    }

    private func progressWord(_ c: Control) -> String {
        switch c {
        case .start: "Starting the API…"
        case .stop: "Stopping the API…"
        case .restart: "Restarting the API…"
        case .rebuild: "Starting Rebuild & restart…"
        case .cancelDrain: "Cancelling the drain…"
        case .pause: "Pausing…"
        case .resume: "Continuing…"
        }
    }

    private func doneWord(_ c: Control, _ r: Reply) -> String {
        switch c {
        case .start: r.json["already"] as? Bool == true ? "The API was already up." : "API started."
        case .stop: "API stopped."
        case .restart: "API restarted."
        case .rebuild: "Rebuild & restart started — progress below."
        case .cancelDrain: "Cancel asked — the job releases its pause and ends without restarting."
        case .pause:
            if r.json["wasPaused"] as? Bool == true { "Already paused." }
            else if let n = r.json["suspended"] as? Int, n > 0 { "Paused — \(n) turn(s) suspended." }
            else { "Paused — nothing automatic starts until Continue." }
        case .resume:
            if let n = r.json["resumed"] as? Int, n > 0 {
                "Continued — \(n) task(s) resumed" + ((r.json["waiting"] as? Int).map { $0 > 0 ? ", \($0) waiting for a slot." : "." } ?? ".")
            } else { "Continued." }
        }
    }

    // MARK: the rebuild job, as the menu tells it

    /// The last job's ending worth showing: a failure until dismissed (or the
    /// next job), a success for 15 minutes.
    var rebuildOutcome: ControlNote? {
        guard let r = host?.rebuild, !r.inProgress, let finished = r.finishedAt else { return nil }
        if r.state == "failed" {
            guard dismissedRebuild != finished else { return nil }
            // drain_timeout and cancelled are sentences of their own ("Drain
            // timed out: … The API was NOT restarted.") — shown verbatim
            let error = r.error ?? "no reason given"
            let text: String = switch r.reason {
            case "drain_timeout": error.hasPrefix("Drain timed out") ? error : "Drain timed out: \(error)"
            case "cancelled": error
            default: "Rebuild & restart failed" + (r.reason.map { " (\($0))" } ?? "") + ": \(error)"
            }
            let tone: ControlNote.Tone = r.reason == "cancelled" ? .warn : .error
            return ControlNote(text: text, tone: tone, at: Format.date(finished) ?? Date())
        }
        if r.state == "done", let at = Format.date(finished), Date().timeIntervalSince(at) < 15 * 60 {
            var text = "Rebuilt & restarted at \(at.formatted(date: .omitted, time: .shortened))"
            if r.continued == false, orch?.paused == true { text += " — still paused: press Continue" }
            return ControlNote(text: text, tone: .info, at: at)
        }
        return nil
    }

    func dismissRebuildOutcome() { dismissedRebuild = host?.rebuild?.finishedAt }
}

/// `GET /api/server/restart-check` — only what the confirm sentence reads.
struct RestartCheck: Decodable, Sendable {
    let blocked: Bool
    let error: String?
    let services: Int?
    let shells: Int?
}
