import Foundation

/// Where the front door is. Resolution order (docs/menubar.md § Finding the
/// front door):
///   1. `TM_BAR_URL` in the environment (a rehearsal instance, a test harness)
///   2. `defaults write com.taskmanager.bar hostURL http://127.0.0.1:5176`
///   3. `host.port` in `<TMRepoRoot>/server/data/config.json` (TMRepoRoot is
///      written into Info.plist by scripts/menubar.mjs)
///   4. http://127.0.0.1:5176
/// Always 127.0.0.1, never `localhost`: the front door binds IPv4 loopback and
/// its Host check pins the port.
enum Config {
    static let defaultPort = 5176

    static func baseURL() -> URL {
        if let env = ProcessInfo.processInfo.environment["TM_BAR_URL"], let url = URL(string: env) {
            return url
        }
        if let stored = UserDefaults.standard.string(forKey: "hostURL"), let url = URL(string: stored) {
            return url
        }
        return URL(string: "http://127.0.0.1:\(configPort() ?? defaultPort)")!
    }

    static var repoRoot: String? {
        Bundle.main.object(forInfoDictionaryKey: "TMRepoRoot") as? String
    }

    /// `host.port` from server/data/config.json; nil when absent or unreadable.
    static func configPort() -> Int? {
        guard let root = repoRoot else { return nil }
        let file = URL(fileURLWithPath: root).appendingPathComponent("server/data/config.json")
        guard let data = try? Data(contentsOf: file),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = json["host"] as? [String: Any],
              let port = host["port"] as? Int, (1...65535).contains(port)
        else { return nil }
        return port
    }

    // MARK: the launchd service (docs/menubar.md § Service)

    /// The front door's launchd label — `TM_SERVICE_LABEL` (the same variable
    /// scripts/service.mjs reads, so a rehearsal instance lines up), then
    /// `defaults write com.taskmanager.bar serviceLabel …`, then the default.
    static var serviceLabel: String {
        if let env = ProcessInfo.processInfo.environment["TM_SERVICE_LABEL"], !env.isEmpty { return env }
        if let stored = UserDefaults.standard.string(forKey: "serviceLabel"), !stored.isEmpty { return stored }
        return "com.taskmanager.server"
    }

    /// Where service.mjs writes the plist — `TM_LAUNCH_AGENTS_DIR`, else ~/Library/LaunchAgents.
    static var launchAgentsDir: String {
        if let env = ProcessInfo.processInfo.environment["TM_LAUNCH_AGENTS_DIR"], !env.isEmpty { return env }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents").path
    }

    static var servicePlistPath: String {
        URL(fileURLWithPath: launchAgentsDir).appendingPathComponent("\(serviceLabel).plist").path
    }

    /// The node that runs scripts/service.mjs. A GUI app's PATH has no nvm, so:
    /// `TM_BAR_NODE`, `defaults … nodePath`, Info.plist `TMNodePath` (the node
    /// that ran `npm run menubar:build`), the installed service's own node
    /// (ProgramArguments[0]), then Homebrew's and /usr/local's. First executable wins.
    static func nodePath() -> String? {
        var candidates: [String?] = [
            ProcessInfo.processInfo.environment["TM_BAR_NODE"],
            UserDefaults.standard.string(forKey: "nodePath"),
            Bundle.main.object(forInfoDictionaryKey: "TMNodePath") as? String,
        ]
        if let data = FileManager.default.contents(atPath: servicePlistPath),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let args = plist["ProgramArguments"] as? [String] {
            candidates.append(args.first)
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.compactMap { $0 }.first { !$0.isEmpty && FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// The front door's log folder when it has not said (`host.logDir` is null
    /// in a terminal, and nothing answers when it is down).
    static var defaultLogDir: String? {
        repoRoot.map { URL(fileURLWithPath: $0).appendingPathComponent("server/data/logs").path }
    }
}
