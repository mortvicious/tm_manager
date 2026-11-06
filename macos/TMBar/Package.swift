// swift-tools-version: 6.0
// TM Bar — a menu-bar status app over the task manager's front door (docs/menubar.md).
// No third-party dependencies; built into TMBar.app by scripts/menubar.mjs.
import PackageDescription

let package = Package(
    name: "TMBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "TMBar",
            path: "Sources/TMBar",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
