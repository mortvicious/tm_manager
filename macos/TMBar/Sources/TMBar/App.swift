import SwiftUI

/// Entry point. `TMBar --export-iconset <dir>` writes the Gor app icon's
/// `.iconset` and exits (scripts/menubar.mjs turns it into the bundle's
/// `.icns`); anything else launches the app.
@main
enum Launcher {
    @MainActor static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--export-iconset") {
            guard i + 1 < args.count else { print("usage: TMBar --export-iconset <dir>"); exit(2) }
            do {
                try GorMark.exportIconset(to: URL(fileURLWithPath: args[i + 1]))
                exit(0)
            } catch {
                print("✗ \(error)")
                exit(1)
            }
        }
        TMBarApp.main()
    }
}

struct TMBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store = Store()

    var body: some Scene {
        MenuBarExtra {
            MenuView(store: store)
        } label: {
            BarLabel(store: store)
        }
        .menuBarExtraStyle(.window)

        // Preferences: the notifications (docs/menubar.md § Notifications). A
        // Settings scene, not a Window: it never opens by itself at launch.
        Settings {
            NotificationsView(store: store)
        }
    }
}

/// The menu-bar item: one icon for the most urgent state (the Gor mark when
/// idle, an SF Symbol otherwise) + the running count.
struct BarLabel: View {
    let store: Store

    var body: some View {
        let state = store.state
        HStack(spacing: 3) {
            StateIcon(state: state)
            if let n = count(state), n > 0 { Text("\(n)").monospacedDigit() }
        }
        .help(state.help)
        .accessibilityLabel(state.help)
    }

    /// The running count rides along with every state where the API is up.
    private func count(_ state: BarState) -> Int? {
        switch state {
        case .unreachable, .stopped: nil
        default: store.orch?.running
        }
    }
}

/// Launch: reopen TM Bar's window if it was open at quit (docs/menubar.md §
/// The window). `TM_BAR_WINDOW=1` opens it regardless (verification only).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            let base = Config.baseURL()
            let origins = [base, Store.devPage]
            let env = ProcessInfo.processInfo.environment
            if env["TM_BAR_WINDOW"] == "1" {
                let path = env["TM_BAR_WINDOW_PATH"] ?? "/"
                WebWindow.shared.open(Browser.pageURL(base: base, path: path), origins: origins)
            } else if Store.storedOpenInWindow {
                WebWindow.shared.restoreIfWasOpen(base: base, origins: origins)
            }
        }
    }

    /// Clicking the Dock icon with the window closed brings it back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        MainActor.assumeIsolated {
            if !flag, WebWindow.shared.isOpen { WebWindow.shared.bringToFront() }
        }
        return true
    }
}
