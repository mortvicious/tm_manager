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
}
