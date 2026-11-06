import AppKit

/// Opens task-manager pages in the installed Brave when there is one (it is
/// the user's browser for the dashboard), else in the default browser.
enum Browser {
    static let braveBundleID = "com.brave.Browser"

    @MainActor
    static func open(_ url: URL) {
        let ws = NSWorkspace.shared
        if let brave = ws.urlForApplication(withBundleIdentifier: braveBundleID) {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            ws.open([url], withApplicationAt: brave, configuration: cfg) { _, error in
                if error != nil { DispatchQueue.main.async { _ = NSWorkspace.shared.open(url) } }
            }
        } else {
            ws.open(url)
        }
    }

    /// `/?task=<id>` — the SPA's deep link (App.tsx useOpenTask).
    static func taskURL(base: URL, id: String) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "task", value: id)]
        return c.url!
    }

    static func pageURL(base: URL, path: String) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = path
        return c.url!
    }
}
