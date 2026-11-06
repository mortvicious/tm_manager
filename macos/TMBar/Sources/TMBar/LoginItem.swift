import Foundation
import ServiceManagement

/// TM Bar as a login item through `SMAppService.mainApp` (macOS 13+): the
/// system's own Login Items list, no helper and no plist of ours. Verified with
/// the ad-hoc signature scripts/menubar.mjs applies (docs/menubar.md § Open at login).
@MainActor
enum LoginItem {
    /// Only a real .app bundle can be a login item (`swift run` cannot).
    static var available: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    static var status: SMAppService.Status { SMAppService.mainApp.status }

    static func set(_ on: Bool) throws {
        if on {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }

    static func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
