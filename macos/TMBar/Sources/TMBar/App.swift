import SwiftUI

@main
struct TMBarApp: App {
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
