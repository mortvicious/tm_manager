import AppKit
import Foundation

/// What launchd says about the front door's agent (docs/menubar.md § Service).
/// Read with `launchctl print` — a few milliseconds, no node — every poll while
/// the menu is open. The plist itself is only ever written by scripts/service.mjs.
struct ServiceInfo: Equatable, Sendable {
    let label: String
    let plistPath: String
    /// the plist is on disk (installed)
    let installed: Bool
    /// launchd knows the job (bootstrapped)
    let loaded: Bool
    /// launchd's `state` — "running", "not running", "spawn scheduled", …
    let state: String?
    let pid: Int?

    var running: Bool { state == "running" }
}

/// The scripts/service.mjs commands the menu runs.
enum ServiceCommand: String, Sendable {
    case install, uninstall, restart, start

    var progress: String {
        switch self {
        case .install: "Installing the service…"
        case .uninstall: "Uninstalling the service…"
        case .restart: "Restarting the service…"
        case .start: "Starting the service…"
        }
    }
}

struct ServiceOutcome: Equatable, Sendable {
    let command: ServiceCommand
    let exitCode: Int32
    let output: String

    var ok: Bool { exitCode == 0 }
    /// service.mjs's restart guard said no (agents working, or the guard could
    /// not be read) — the one refusal `--force` overrides.
    var refusedWhileWorking: Bool { exitCode == Service.refusedWhileWorking }

    private var lines: [String] {
        output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// The script's ⚠ lines (an old node, `claude`/`git` missing from the service PATH).
    var warnings: [String] { lines.filter { $0.hasPrefix("⚠") } }

    /// The script's last ✓/✗ line, else its last line.
    var summary: String {
        let lines = self.lines
        let marked = lines.last { $0.hasPrefix("✓") || $0.hasPrefix("✗") }
        return marked ?? lines.last ?? (ok ? "done" : "failed (exit \(exitCode))")
    }
}

enum Service {
    /// scripts/service.mjs `REFUSED_WHILE_WORKING`
    static let refusedWhileWorking: Int32 = 3
    /// install worst case: guard 20 s + stop 40 s + login-shell PATH 10 s + up 60 s
    static let scriptTimeout: TimeInterval = 180

    static func info() async -> ServiceInfo {
        await Task.detached { readInfo() }.value
    }

    private static func readInfo() -> ServiceInfo {
        let label = Config.serviceLabel
        let plist = Config.servicePlistPath
        let installed = FileManager.default.fileExists(atPath: plist)
        let r = runSync("/bin/launchctl", ["print", "gui/\(getuid())/\(label)"], timeout: 5)
        guard r.code == 0 else {
            return ServiceInfo(label: label, plistPath: plist, installed: installed, loaded: false, state: nil, pid: nil)
        }
        // the job's own keys come first; nested blocks repeat some names, so take the first
        func pick(_ key: String) -> String? {
            for line in r.out.split(separator: "\n") {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("\(key) = ") { return String(t.dropFirst(key.count + 3)) }
            }
            return nil
        }
        return ServiceInfo(label: label, plistPath: plist, installed: installed, loaded: true,
                           state: pick("state"), pid: pick("pid").flatMap { Int($0) })
    }

    /// `node --import tsx scripts/service.mjs <command> [--force]` in the repo
    /// root — argv, never a shell. The script holds every rule (port checks,
    /// the fail-closed restart guard, plist generation); the app only runs it.
    static func run(_ command: ServiceCommand, force: Bool) async -> ServiceOutcome {
        await Task.detached { runScript(command, force: force) }.value
    }

    private static func runScript(_ command: ServiceCommand, force: Bool) -> ServiceOutcome {
        guard let root = Config.repoRoot,
              FileManager.default.fileExists(atPath: URL(fileURLWithPath: root).appendingPathComponent("scripts/service.mjs").path)
        else {
            return ServiceOutcome(command: command, exitCode: 1, output: "✗ scripts/service.mjs not found — rebuild TM Bar from the checkout (npm run menubar:build)")
        }
        guard let node = Config.nodePath() else {
            return ServiceOutcome(command: command, exitCode: 1, output: "✗ no node found — rebuild TM Bar with the node the service should use (v24), or `defaults write com.taskmanager.bar nodePath /path/to/node`")
        }
        var env = ProcessInfo.processInfo.environment
        let nodeDir = (node as NSString).deletingLastPathComponent
        let inherited = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        env["PATH"] = ([nodeDir] + inherited.filter { $0 != nodeDir }).joined(separator: ":")
        if env["SHELL"] == nil { env["SHELL"] = "/bin/zsh" }
        // the same label and folder the app reads, whichever source it came from
        env["TM_SERVICE_LABEL"] = Config.serviceLabel
        env["TM_LAUNCH_AGENTS_DIR"] = Config.launchAgentsDir
        env.removeValue(forKey: "TM_BAR_ALWAYS_OPEN")
        var args = ["--import", "tsx", "scripts/service.mjs", command.rawValue]
        if force { args.append("--force") }
        let r = runSync(node, args, cwd: root, env: env, timeout: scriptTimeout)
        return ServiceOutcome(command: command, exitCode: r.code, output: r.out)
    }

    /// Run to completion, stdout+stderr merged; SIGTERM after `timeout`.
    private static func runSync(_ exe: String, _ args: [String], cwd: String? = nil, env: [String: String]? = nil,
                                timeout: TimeInterval) -> (code: Int32, out: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { p.environment = env }
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        do {
            try p.run()
        } catch {
            return (127, "✗ \(exe): \(error.localizedDescription)")
        }
        let timer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        timer.cancel()
        var out = String(decoding: data, as: UTF8.self)
        if p.terminationReason == .uncaughtSignal {
            out += "\n✗ stopped after \(Int(timeout)) s without an answer — launchd may still finish it; see the logs"
        }
        return (p.terminationStatus, out)
    }
}

/// The front door's file logs (docs/host.md § Logs), opened in Console.app.
enum Logs {
    static let files = [("API", "api.log"), ("Front door", "host.log"), ("launchd", "launchd.log")]

    @MainActor
    static func open(_ path: String) {
        let url = URL(fileURLWithPath: path)
        let ws = NSWorkspace.shared
        if let console = ws.urlForApplication(withBundleIdentifier: "com.apple.Console") {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            ws.open([url], withApplicationAt: console, configuration: cfg) { _, error in
                if error != nil { DispatchQueue.main.async { _ = NSWorkspace.shared.open(url) } }
            }
        } else {
            ws.open(url)
        }
    }

    @MainActor
    static func reveal(_ dir: String) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir)
    }
}
