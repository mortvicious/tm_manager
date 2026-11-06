import SwiftUI

@main
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
    }
}

/// The menu-bar item: one SF Symbol for the most urgent state + the running count.
struct BarLabel: View {
    let store: Store

    var body: some View {
        let state = store.state
        HStack(spacing: 3) {
            Image(systemName: state.symbol)
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
