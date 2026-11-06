import AppKit
import Foundation
import Observation
import ServiceManagement
import os

/// What the menu-bar icon says, most urgent first (docs/menubar.md § The icon).
enum BarState: Equatable {
    case unreachable // the front door does not answer
    case rebuilding // a Rebuild & restart job is in flight (its restart is not "stopped")
    case stopped // the front door answers, the API is not up
    case memoryHold // the memory fuse is holding new work
    case paused // Pause all
    case running(Int) // live worker PTYs (0 = idle)

    var symbol: String {
        switch self {
        case .unreachable: "exclamationmark.triangle"
        case .stopped: "stop.circle"
        case .rebuilding: "arrow.triangle.2.circlepath"
        case .memoryHold: "memorychip"
        case .paused: "pause.circle"
        case .running(let n): n > 0 ? "bolt.circle.fill" : "checklist"
        }
    }

    var help: String {
        switch self {
        case .unreachable: "Task manager: front door not answering"
        case .stopped: "Task manager: API stopped"
        case .rebuilding: "Task manager: rebuilding"
        case .memoryHold: "Task manager: memory fuse holding"
        case .paused: "Task manager: paused"
        case .running(let n): n > 0 ? "Task manager: \(n) running" : "Task manager: idle"
        }
    }
}

/// The poller. Closed menu: `/host/status` + `/api/orchestrator` every 5 s.
/// Open menu: `/host/status` + `/api/menubar` every 2 s. Nothing while the Mac
/// sleeps. Published values are only reassigned when they change, so an
/// unchanged poll redraws nothing.
@MainActor
@Observable
final class Store {
    static let closedInterval: Duration = .seconds(5)
    static let openInterval: Duration = .seconds(2)

    private(set) var host: HostStatus?
    private(set) var hostError: String?
    private(set) var orch: OrchestratorLite?
    private(set) var summary: MenubarSummary?
    /// set when /api/menubar is missing (an API older than TM Bar) or failing
    private(set) var summaryError: String?
    private(set) var lastPoll: Date?

    // controls (Controls.swift) — set there, so not private(set)
    /// the outcome of the last control press
    var note: ControlNote?
    /// a press waiting for its confirm (a refusal's Force offer included)
    var pending: PendingControl?
    /// the control whose request is in flight; every control is disabled meanwhile
    var busy: Control?
    /// the rebuild failure the human closed (its finishedAt), so it stays closed
    var dismissedRebuild: String?
    /// launchd's view of the front door's agent; read every poll while the menu is open
    private(set) var service: ServiceInfo?
    /// the service.mjs command in flight (one at a time)
    private(set) var serviceRunning: ServiceCommand?
    /// the last service.mjs command's result, until the menu is next opened
    private(set) var serviceOutcome: ServiceOutcome?
    private(set) var loginStatus: SMAppService.Status?
    private(set) var loginError: String?

    private(set) var menuOpen = false
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var asleep = false
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored let client: Client
    /// `TM_BAR_ALWAYS_OPEN=1`: poll as if the menu were open (verification only — docs/menubar.md § Verifying)
    @ObservationIgnored private let alwaysOpen = ProcessInfo.processInfo.environment["TM_BAR_ALWAYS_OPEN"] == "1"
    @ObservationIgnored private let log = Logger(subsystem: "com.taskmanager.bar", category: "poll")
    @ObservationIgnored private var lastLogged = ""

    init(client: Client = Client(base: Config.baseURL())) {
        self.client = client
        let nc = NSWorkspace.shared.notificationCenter
        observers.append(nc.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sleep() }
        })
        observers.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.wake() }
        })
        refreshLogin()
        restart()
        verificationHooks()
    }

    /// Verification only (docs/menubar.md § Verifying): `TM_BAR_LOGIN=on|off`
    /// and `TM_BAR_SERVICE_ACTION=install|start|restart|uninstall` run the same
    /// calls the menu's controls make, once at launch, results in the unified log.
    private func verificationHooks() {
        let env = ProcessInfo.processInfo.environment
        if let login = env["TM_BAR_LOGIN"], login == "on" || login == "off" {
            setLogin(login == "on")
        }
        if let raw = env["TM_BAR_SERVICE_ACTION"], let cmd = ServiceCommand(rawValue: raw) {
            Task { await runService(cmd) }
        }
    }

    // MARK: lifecycle

    func setMenuOpen(_ open: Bool) {
        guard open != menuOpen else { return }
        menuOpen = open
        if open {
            // an outcome or a Force offer from minutes ago is not news any more
            if let n = note, Date().timeIntervalSince(n.at) > 120, busy == nil { note = nil }
            if let p = pending, Date().timeIntervalSince(p.at) > 120 { pending = nil }
            if serviceRunning == nil { serviceOutcome = nil }
            refreshLogin()
        } else {
            pending = nil // a confirm is asked of someone looking at it
        }
        restart() // poll at once on open; drop back to the slow pace on close
    }

    private func sleep() {
        asleep = true
        loop?.cancel()
        loop = nil
    }

    private func wake() {
        asleep = false
        restart()
    }

    private func restart() {
        loop?.cancel()
        guard !asleep else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.poll()
                let interval = (self.menuOpen || self.alwaysOpen) ? Store.openInterval : Store.closedInterval
                try? await Task.sleep(for: interval, tolerance: .seconds(1))
            }
        }
    }

    // MARK: polling

    func poll() async {
        defer { logChange() }
        let open = menuOpen || alwaysOpen
        if open {
            let info = await Service.info()
            if Task.isCancelled { return }
            set(\.service, info)
        }
        do {
            let h = try await client.get("/host/status", as: HostStatus.self)
            set(\.host, h)
            set(\.hostError, nil)
        } catch {
            if Task.isCancelled { return } // restart() cut it short: not a reading
            set(\.host, nil)
            set(\.hostError, Self.describe(error))
            set(\.orch, nil)
            lastPoll = Date()
            return
        }
        guard host?.api.up == true else {
            set(\.orch, nil)
            lastPoll = Date()
            return
        }
        if open {
            do {
                let s = try await client.get("/api/menubar", as: MenubarSummary.self)
                set(\.summary, s)
                set(\.summaryError, nil)
            } catch _ where Task.isCancelled {
                return
            } catch ClientError.missingRoute {
                set(\.summaryError, "This API predates TM Bar's summary route — Rebuild & restart it for tasks and Inbox.")
            } catch {
                set(\.summaryError, Self.describe(error))
            }
        }
        // the icon's read: the summary carries it when the menu is open
        if open, summaryError == nil, let s = summary {
            set(\.orch, OrchestratorLite(
                enabled: s.queue.enabled, paused: s.queue.paused, pausedTasks: s.queue.pausedTasks, running: s.queue.running,
                concurrency: s.queue.concurrency,
                memory: s.memory.map { m in
                    .init(sample: .init(freePct: m.freePct, swapPct: m.swapPct), tripped: m.tripped, reason: m.reason, hold: m.hold)
                }
            ))
        } else {
            if let o = try? await client.get("/api/orchestrator", as: OrchestratorLite.self) { set(\.orch, o) }
            if Task.isCancelled { return }
        }
        lastPoll = Date()
    }

    /// One unified-log line per CHANGE of what the menu shows
    /// (`log stream --predicate 'subsystem == "com.taskmanager.bar"'`).
    private func logChange() {
        var line = "state=\(state) base=\(client.base.absoluteString)"
        if let svc = service {
            line += " svc=\(svc.label):\(svc.loaded ? (svc.state ?? "?") : svc.installed ? "not-loaded" : "not-installed")"
            if let pid = svc.pid { line += "/pid\(pid)" }
        }
        if let h = host { line += " runs-as=\(runsAs(h))" }
        if let st = loginStatus { line += " login=\(Self.loginWord(st))" }
        if let s = summary, summaryError == nil {
            let tasks = s.tasks.map { "\($0.status):\($0.id.prefix(8))" }.joined(separator: ",")
            line += " tasks=[\(tasks)] inbox=\(s.inbox.total)/q\(s.inbox.questions)/you\(s.inbox.needsYou)"
            if let m = s.memory { line += " mem=\(Format.pct(m.freePct))free/swap\(Format.pct(m.swapPct)) hold=\(m.hold ?? "-")" }
        } else if let e = summaryError ?? hostError {
            line += " note=\(e)"
        }
        guard line != lastLogged else { return }
        lastLogged = line
        log.notice("\(line, privacy: .public)")
    }

    private func set<T: Equatable>(_ key: ReferenceWritableKeyPath<Store, T>, _ value: T) {
        if self[keyPath: key] != value { self[keyPath: key] = value }
    }

    // MARK: derived

    var state: BarState {
        guard let host else { return .unreachable }
        // a Rebuild & restart takes the API down on purpose: say rebuilding, not stopped
        if host.rebuild?.inProgress == true { return .rebuilding }
        if !host.api.up { return .stopped }
        if let m = orch?.memory, m.hold != nil { return .memoryHold }
        if orch?.paused == true { return .paused }
        return .running(orch?.running ?? 0)
    }

    /// Where the front door writes its logs: what it says, else the checkout's
    /// server/data/logs (it is down, or a terminal one that writes no files).
    var logDir: String? { host?.host.logDir ?? Config.defaultLogDir }

    /// How the answering front door was started: `launchd` (the service sets
    /// TM_SERVICE=launchd), `dev` (npm run dev), else a terminal `npm start`.
    func runsAs(_ h: HostStatus) -> String {
        if h.host.service == "launchd" { return "launchd" }
        return h.host.dev ? "dev" : "terminal"
    }

    /// The page to open: Vite in dev (the front door serves no SPA there), else the front door.
    var pageBase: URL {
        if host?.host.dev == true { return URL(string: "http://localhost:5173")! }
        return client.base
    }

    /// Run scripts/service.mjs — install / uninstall / restart / start. The
    /// script's own guards decide; `force` only after its restart guard refused
    /// and the human pressed Force (two presses in the menu).
    func runService(_ command: ServiceCommand, force: Bool = false) async {
        guard serviceRunning == nil else { return }
        serviceRunning = command
        serviceOutcome = nil
        log.notice("service \(command.rawValue, privacy: .public)\(force ? " --force" : "", privacy: .public) …")
        let outcome = await Service.run(command, force: force)
        log.notice("service \(command.rawValue, privacy: .public) exit=\(outcome.exitCode) \(outcome.summary, privacy: .public)")
        serviceRunning = nil
        serviceOutcome = outcome
        set(\.service, await Service.info())
        await poll()
    }

    // MARK: login item

    func refreshLogin() {
        guard LoginItem.available else { return }
        set(\.loginStatus, LoginItem.status)
    }

    func setLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
            loginError = nil
        } catch {
            loginError = error.localizedDescription
        }
        refreshLogin()
        log.notice("login item \(on ? "register" : "unregister", privacy: .public) → \(Self.loginWord(LoginItem.status), privacy: .public)\(self.loginError.map { " error: \($0)" } ?? "", privacy: .public)")
    }

    static func loginWord(_ s: SMAppService.Status) -> String {
        switch s {
        case .enabled: "enabled"
        case .requiresApproval: "requires-approval"
        case .notRegistered: "not-registered"
        case .notFound: "not-found"
        @unknown default: "unknown"
        }
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case ClientError.unreachable(let why): return why
        case ClientError.missingRoute: return "route not found"
        case ClientError.http(let code): return "HTTP \(code)"
        case ClientError.decode(let why): return "unexpected reply: \(why.prefix(120))"
        default: return error.localizedDescription
        }
    }
}
