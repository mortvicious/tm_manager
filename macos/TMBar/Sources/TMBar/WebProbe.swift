import AppKit
import OSLog
import WebKit

private let log = Logger(subsystem: "com.taskmanager.bar", category: "web")

/// Verification only (docs/menubar.md § Verifying the window), like
/// `TM_BAR_ALWAYS_OPEN`: drives the REAL window through the real AppKit →
/// WebKit paths (NSApp.sendEvent / NSWindow.sendEvent, so a click is a user
/// gesture and a key equivalent reaches the menu) and logs what the page saw.
/// Nothing here runs unless an env variable asks.
///   TM_BAR_WEB_PROBE=<s>     log a page-state JSON line after each load (and every <s> s if > 0)
///   TM_BAR_WEB_STEPS=<file>  once, 3 s after the first load, one step per line:
///       js <file>       run the file as an async JS function body, log its result
///       click <css>     a real left click at the centre of the first match
///       keys <text>     key events ("\n" = Return, "⌘x" = Cmd+x through the menu)
///       paste <text>    put <text> on the pasteboard
///       wait <s>        sleep
///       open <path?q>   WebWindow.open(<front door><path>) — what the menu's rows call
///       close           close the window (Cmd+W)
///       clipboard       log the pasteboard's string
///       state           log the page state + the find bar's state
///   TM_BAR_WEB_UPLOAD=<path> answer the file chooser with <path> instead of the panel
///   TM_BAR_WEB_NO_EXTERNAL=1 log external links instead of opening the browser
///   TM_BAR_WEB_DIALOG=ok|cancel  answer JS dialogs without a sheet
///   TM_BAR_WEB_ALL_SPACES=1  show the window on every Space (measurements)
///   TM_BAR_WEB_FORCE_VISIBLE=1  WebKit occlusion detection off (SPI; measurements)
@MainActor
enum WebProbe {
    static let env = ProcessInfo.processInfo.environment
    static var enabled: Bool { env["TM_BAR_WEB_PROBE"] != nil || env["TM_BAR_WEB_STEPS"] != nil }
    static var upload: URL? { env["TM_BAR_WEB_UPLOAD"].map { URL(fileURLWithPath: $0) } }
    static var noExternal: Bool { env["TM_BAR_WEB_NO_EXTERNAL"] == "1" }
    static var dialog: String? { env["TM_BAR_WEB_DIALOG"] }
    private static var started = false
    private static var timer: Timer?

    static let stateJS = """
    JSON.stringify({href: location.href, title: document.title, visibility: document.visibilityState,
      focus: document.hasFocus(), secure: isSecureContext, calm: document.documentElement.hasAttribute('data-calm'),
      design: document.documentElement.dataset.design ?? null,
      push: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
      rows: document.querySelectorAll('[data-task-id], .task-row, [data-drop-task]').length,
      xterms: document.querySelectorAll('.xterm').length, active: document.activeElement?.className ?? null,
      localStorageKeys: localStorage.length, ua: navigator.userAgent.slice(-40)})
    """

    static func didFinish(_ web: WKWebView, window: WebWindow) {
        if env["TM_BAR_WEB_PROBE"] != nil { logState(web, "load") }
        if let s = env["TM_BAR_WEB_PROBE"], let secs = Double(s), secs > 0, timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: secs, repeats: true) { [weak web] _ in
                MainActor.assumeIsolated { if let web { logState(web, "tick") } }
            }
        }
        guard !started, let file = env["TM_BAR_WEB_STEPS"] else { return }
        started = true
        guard let text = try? String(contentsOfFile: file, encoding: .utf8) else {
            log.error("probe: cannot read steps \(file, privacy: .public)")
            return
        }
        let steps = text.split(separator: "\n").map(String.init).filter { !$0.isEmpty && !$0.hasPrefix("#") }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            for step in steps {
                let (verb, arg) = step.firstIndex(of: " ").map { (String(step[..<$0]), String(step[step.index(after: $0)...])) }
                    ?? (step, "")
                switch verb {
                case "js": await run(web, file: arg, tag: "js \((arg as NSString).lastPathComponent)")
                case "click": await click(arg, in: web)
                case "keys": type(arg.replacingOccurrences(of: "\\n", with: "\n"), into: web)
                case "paste":
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(arg, forType: .string)
                case "wait": try? await Task.sleep(for: .seconds(Double(arg) ?? 1))
                case "open": WebWindow.shared.open(Browser.pageURL(base: Config.baseURL(), path: "/").appendingPathComponentIfQuery(arg), origins: [Config.baseURL(), Store.devPage])
                case "close": web.window?.performClose(nil)
                case "clipboard":
                    log.notice("probe clipboard \(NSPasteboard.general.string(forType: .string) ?? "nil", privacy: .public)")
                case "state":
                    logState(web, "state")
                    log.notice("probe find-bar \(window.findState, privacy: .public)")
                default: log.error("probe: unknown step \(step, privacy: .public)")
                }
            }
            log.notice("probe steps done")
        }
    }

    /// `element.click()` from a fresh `callAsyncJavaScript` call — WebKit runs
    /// it as a user gesture, so popups, downloads and the file chooser behave as
    /// for a real click. (A synthesized NSEvent click needs a key window, which
    /// a locked screen never has.)
    private static func click(_ selector: String, in web: WKWebView) async {
        let js = "const e = document.querySelector(sel); if (!e) return false; e.click(); return true"
        let ok = (try? await web.callAsyncJavaScript(js, arguments: ["sel": selector], contentWorld: .page)) as? Bool ?? false
        log.notice("probe click \(selector, privacy: .public) \(ok ? "clicked" : "no such element", privacy: .public)")
        try? await Task.sleep(for: .milliseconds(300))
    }

    private static func logState(_ web: WKWebView, _ tag: String) {
        let visible = web.window?.occlusionState.contains(.visible) ?? false
        let zoom = web.pageZoom
        web.evaluateJavaScript(stateJS) { value, error in
            let s = (value as? String) ?? "error: \(error?.localizedDescription ?? "nil")"
            log.notice("probe \(tag, privacy: .public) windowVisible=\(visible ? "yes" : "no", privacy: .public) pageZoom=\(zoom, privacy: .public) \(s, privacy: .public)")
        }
    }

    /// `TM_BAR_WEB_ALL_SPACES=1`: the window joins every Space (and full-screen
    /// ones), so a measurement reads a VISIBLE page with nobody at the Mac.
    static func place(_ window: NSWindow) {
        // `TM_BAR_WEB_FORCE_VISIBLE=1`: WebKit's window-occlusion detection off
        // (SPI, measurement only) — the page stays `visible` behind other
        // windows or with the display asleep, the twin of Brave's
        // --disable-backgrounding-occluded-windows (§ Measurements).
        if env["TM_BAR_WEB_FORCE_VISIBLE"] == "1", let web = window.contentView?.subviews.compactMap({ $0 as? WKWebView }).first {
            let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
            let ok = web.responds(to: sel)
            if ok { web.setValue(false, forKey: "_windowOcclusionDetectionEnabled") }
            log.notice("probe occlusion detection off: \(ok ? "yes" : "no", privacy: .public)")
        }
        guard env["TM_BAR_WEB_ALL_SPACES"] == "1" else { return }
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.orderFrontRegardless()
    }

    private static func run(_ web: WKWebView, file: String, tag: String) async {
        guard let body = try? String(contentsOfFile: file, encoding: .utf8) else {
            log.error("probe \(tag, privacy: .public): cannot read \(file, privacy: .public)")
            return
        }
        do {
            let v = try await web.callAsyncJavaScript(body, contentWorld: .page)
            log.notice("probe \(tag, privacy: .public) result=\(String(describing: v ?? "nil"), privacy: .public)")
        } catch {
            log.error("probe \(tag, privacy: .public) threw \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Key events as AppKit delivers them: a Cmd key is the main menu's key
    /// equivalent, its action sent to the window's first responder (what the
    /// responder chain does in a key window — a locked screen has none); every
    /// other key goes to the window's first responder through `sendEvent`.
    private static func type(_ text: String, into web: WKWebView) {
        guard let window = web.window else { return }
        let chars = Array(text)
        var i = 0
        var sent = 0
        while i < chars.count {
            var c = String(chars[i])
            var mods: NSEvent.ModifierFlags = []
            if c == "⌘", i + 1 < chars.count { mods = .command; i += 1; c = String(chars[i]) }
            i += 1
            if mods == .command {
                if let item = menuItem(key: c, in: NSApp.mainMenu), let action = item.action {
                    let ok = NSApp.sendAction(action, to: item.target ?? window.firstResponder, from: item)
                    log.notice("probe ⌘\(c, privacy: .public) → \(item.title, privacy: .public) \(ok ? "handled" : "unhandled", privacy: .public)")
                } else {
                    log.notice("probe ⌘\(c, privacy: .public): no menu item")
                }
                continue
            }
            let code: UInt16 = c == "\n" ? 36 : c == "⎋" ? 53 : 0
            let typed = c == "\n" ? "\r" : c == "⎋" ? "\u{1b}" : c
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                if let e = NSEvent.keyEvent(
                    with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber, context: nil, characters: typed,
                    charactersIgnoringModifiers: typed, isARepeat: false, keyCode: code
                ) { window.sendEvent(e) }
            }
            sent += 1
        }
        log.notice("probe typed \(sent) keys into \(String(describing: window.firstResponder.map { Swift.type(of: $0) }), privacy: .public)")
    }

    private static func menuItem(key: String, in menu: NSMenu?) -> NSMenuItem? {
        for item in menu?.items ?? [] {
            if let sub = item.submenu, let hit = menuItem(key: key, in: sub) { return hit }
            if item.keyEquivalent == key, item.keyEquivalentModifierMask == [.command] { return item }
        }
        return nil
    }
}

extension URL {
    /// `/?task=x` style probe paths onto a base URL (path + query).
    func appendingPathComponentIfQuery(_ pathAndQuery: String) -> URL {
        URL(string: pathAndQuery, relativeTo: self)?.absoluteURL ?? self
    }
}
