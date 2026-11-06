import AppKit
import OSLog
import WebKit

private let log = Logger(subsystem: "com.taskmanager.bar", category: "web")

/// The task manager's SPA in a native window — system WebKit instead of a
/// second Chromium (docs/menubar.md § The window). It is just another loopback
/// page: same origin as the front door, the SPA's own `/api/session` token and
/// its own `Origin` on writes, nothing relaxed.
///
/// One window. Closing it tears the web view down (the WebContent process
/// exits), so a closed window costs nothing. While it is open the app is a
/// regular app (Dock, Cmd+Tab, a main menu — the Edit menu is what makes
/// Cmd+C/V reach xterm and inputs); closed, it is a menu-bar app again.
@MainActor
final class WebWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSSearchFieldDelegate {
    static let shared = WebWindow()

    private var window: NSWindow?
    private var webView: WKWebView?
    private var findBar: NSStackView?
    private var findField: NSSearchField?
    private var titleObservation: NSKeyValueObservation?
    private var urlObservation: NSKeyValueObservation?
    /// The front door's origin (and Vite's in dev) — pages that stay in the window.
    private var appOrigins: Set<String> = []
    private var terminating = false
    private var retryTimer: Timer?
    private var failedURL: URL?
    private var downloads: [ObjectIdentifier: URL] = [:]

    private static let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    static let zoomKey = "webZoom"
    static let openKey = "webWindowOpen"
    static let lastURLKey = "webWindowURL"

    var isOpen: Bool { window != nil }
    /// A verification launch (`TM_BAR_WINDOW=1`) leaves the reopen-at-launch state alone.
    private let persists = ProcessInfo.processInfo.environment["TM_BAR_WINDOW"] == nil

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.terminating = true }
        }
    }

    // MARK: open / close

    /// Show `url` in the window (creating it), bring it to the front.
    /// `origins` = every origin that belongs to the app (front door; Vite in dev).
    func open(_ url: URL, origins: [URL]) {
        appOrigins = Set(origins.compactMap(Self.origin))
        if let o = Self.origin(url) { appOrigins.insert(o) }
        if window == nil { makeWindow() }
        guard let window, let webView else { return }
        if NSApp.activationPolicy() != .regular {
            NSApp.setActivationPolicy(.regular)
            NSApp.applicationIconImage = Self.dockIcon
        }
        installMainMenu()
        // A deep link into the page already showing: let the SPA route it
        // (a full load would refetch the whole state), else load. The bare
        // base ("Open task manager") only brings the window forward.
        let bare = (url.path.isEmpty || url.path == "/") && url.query == nil
        if let current = webView.url, Self.origin(current) == Self.origin(url), failedURL == nil {
            if current != url, !bare {
                if webView.isLoading { load(url) } else { navigateInPage(url) }
            }
        } else if webView.url != url || failedURL != nil {
            load(url)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
        WebProbe.place(window)
        if persists { UserDefaults.standard.set(true, forKey: Self.openKey) }
    }

    func bringToFront() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// Reopen at launch when the window was open at quit.
    func restoreIfWasOpen(base: URL, origins: [URL]) {
        guard UserDefaults.standard.bool(forKey: Self.openKey) else { return }
        var url = base
        if let s = UserDefaults.standard.string(forKey: Self.lastURLKey), let last = URL(string: s),
           let o = Self.origin(last), Set(origins.compactMap(Self.origin)).contains(o) {
            url = last
        }
        open(url, origins: origins)
    }

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent: localStorage survives (its own, not Brave's)
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.applicationNameForUserAgent = "TMBar"

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = true
        // Off: a two-finger swipe in the timeline/metro scrollers would leave the page.
        web.allowsBackForwardNavigationGestures = false
        web.isInspectable = true // Safari ▸ Develop ▸ TM Bar
        web.pageZoom = Self.storedZoom
        web.translatesAutoresizingMaskIntoConstraints = false

        let bar = makeFindBar()
        bar.isHidden = true

        let content = NSView()
        content.addSubview(bar)
        content.addSubview(web)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: content.topAnchor),
            bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        let webTop = web.topAnchor.constraint(equalTo: content.topAnchor)
        webTop.isActive = true
        findTop = (webTop, web.topAnchor.constraint(equalTo: bar.bottomAnchor))

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        w.title = "Task manager"
        w.isReleasedWhenClosed = false
        w.contentView = content
        w.contentMinSize = NSSize(width: 360, height: 400)
        w.tabbingMode = .disallowed
        w.collectionBehavior.insert(.fullScreenPrimary)
        w.delegate = self
        if !w.setFrameUsingName("TMBarWebWindow") { w.center() }
        w.setFrameAutosaveName("TMBarWebWindow")

        titleObservation = web.observe(\.title, options: [.new]) { [weak w] web, _ in
            MainActor.assumeIsolated {
                if let t = web.title, !t.isEmpty { w?.title = t }
            }
        }
        let persists = persists
        urlObservation = web.observe(\.url, options: [.new]) { web, _ in
            MainActor.assumeIsolated {
                if persists, let u = web.url, u.scheme == "http" || u.scheme == "https" {
                    UserDefaults.standard.set(u.absoluteString, forKey: WebWindow.lastURLKey)
                }
            }
        }

        window = w
        webView = web
        findBar = bar
        log.notice("window opened")
    }

    private var findTop: (closed: NSLayoutConstraint, open: NSLayoutConstraint)?
    private var lastFindMatched: Bool?

    func windowWillClose(_ notification: Notification) {
        if !terminating, persists { UserDefaults.standard.set(false, forKey: Self.openKey) }
        retryTimer?.invalidate()
        retryTimer = nil
        failedURL = nil
        titleObservation = nil
        urlObservation = nil
        // Tear the page down so its WebContent process exits: a closed window costs nothing.
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        findBar = nil
        findField = nil
        findTop = nil
        window?.delegate = nil
        window = nil
        if !terminating {
            NSApp.setActivationPolicy(.accessory)
        }
        log.notice("window closed")
    }

    // MARK: loading

    private func load(_ url: URL) {
        retryTimer?.invalidate()
        retryTimer = nil
        failedURL = nil
        webView?.load(URLRequest(url: url))
    }

    /// Route a same-origin deep link inside the running SPA (react-router
    /// listens to popstate), without reloading the page.
    private func navigateInPage(_ url: URL) {
        var c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        c?.scheme = nil
        c?.host = nil
        c?.port = nil
        guard let path = c?.string, let json = try? JSONSerialization.data(withJSONObject: [path], options: [.fragmentsAllowed]),
              let arg = String(data: json, encoding: .utf8)
        else { load(url); return }
        webView?.evaluateJavaScript("history.pushState(null, '', \(arg)[0]); dispatchEvent(new PopStateEvent('popstate'))") {
            [weak self] _, error in
            MainActor.assumeIsolated {
                if error != nil { self?.load(url) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain", ns.code == 102 { return } // frame load interrupted (a download)
        let url = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
        log.notice("load failed: \(ns.localizedDescription, privacy: .public)")
        showUnreachable(url, reason: ns.localizedDescription)
    }

    /// The front door is down (or restarting): a plain page that retries every 3 s.
    private func showUnreachable(_ url: URL?, reason: String) {
        guard let url, appOrigins.contains(Self.origin(url) ?? "") else { return }
        failedURL = url
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <style>body{font:13px -apple-system,system-ui;display:grid;place-items:center;height:90vh;margin:0}
        p{opacity:.7}</style><div><h3>The task manager is not answering</h3>
        <p>\(Self.escape(url.absoluteString)) — \(Self.escape(reason))</p><p>Retrying every 3 s…</p></div>
        """
        webView?.loadHTMLString(html, baseURL: nil)
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryIfUp() }
        }
        retryTimer?.tolerance = 1
    }

    private func retryIfUp() {
        guard let url = failedURL else { return }
        var probe = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        probe.httpMethod = "HEAD"
        Self.probeSession.dataTask(with: probe) { [weak self] _, response, _ in
            guard (response as? HTTPURLResponse) != nil else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.failedURL == url else { return }
                    self.load(url)
                }
            }
        }.resume()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if WebProbe.enabled, failedURL == nil { WebProbe.didFinish(webView, window: self) }
    }

    /// No proxy, no cache — like Client's sessions: loopback only.
    private static let probeSession: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.connectionProxyDictionary = [:]
        c.timeoutIntervalForRequest = 2
        return URLSession(configuration: c)
    }()

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.error("web content process terminated — reloading")
        webView.reload()
    }

    // MARK: navigation policy

    /// The app's own pages stay in the window; everything else goes to the default browser.
    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data"].contains(scheme) { decisionHandler(.allow); return }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if isApp(url) || (!mainFrame && (scheme == "http" || scheme == "https")) {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        openExternally(url)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
    ) {
        let http = response.response as? HTTPURLResponse
        let disposition = (http?.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased()
        if !response.canShowMIMEType || disposition.hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    /// `target=_blank` / `window.open`: an app page loads in this window, anything else in the browser.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if action.shouldPerformDownload {
                webView.startDownload(using: action.request) { $0.delegate = self }
            } else if isApp(url) {
                webView.load(action.request)
            } else if url.scheme != "about" {
                openExternally(url)
            }
        }
        return nil
    }

    private func isApp(_ url: URL) -> Bool {
        guard let o = Self.origin(url) else { return false }
        return appOrigins.contains(o)
    }

    private func openExternally(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) else {
            log.notice("refused external scheme \(url.scheme ?? "", privacy: .public)")
            return
        }
        if WebProbe.noExternal {
            log.notice("probe external link → \(url.absoluteString, privacy: .public) (not opened)")
            return
        }
        log.notice("external link → default browser")
        NSWorkspace.shared.open(url)
    }

    static func origin(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : scheme == "http" ? 80 : -1)
        return "\(scheme)://\(host):\(port)"
    }

    // MARK: downloads → ~/Downloads

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
        completionHandler: @escaping @MainActor (URL?) -> Void
    ) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
        // The server sends `filename="<encodeURIComponent(name)>"` (routes/tasks.ts).
        let name = suggestedFilename.contains("%") ? (suggestedFilename.removingPercentEncoding ?? suggestedFilename) : suggestedFilename
        let dest = Self.uniqueFile(in: dir, name: name)
        downloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        log.notice("downloaded \(dest.lastPathComponent, privacy: .public)")
        // What Safari posts: the Dock's Downloads stack bounces.
        DistributedNotificationCenter.default().post(
            name: Notification.Name("com.apple.DownloadFileFinished"), object: dest.resolvingSymlinksInPath().path
        )
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let dest = downloads.removeValue(forKey: ObjectIdentifier(download))
        log.error("download failed: \(error.localizedDescription, privacy: .public)")
        alert("Download failed", "\(dest?.lastPathComponent ?? "file"): \(error.localizedDescription)")
    }

    static func uniqueFile(in dir: URL, name: String) -> URL {
        let clean = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let base = clean.isEmpty ? "download" : clean
        var candidate = dir.appendingPathComponent(base)
        let ext = (base as NSString).pathExtension
        let stem = (base as NSString).deletingPathExtension
        var n = 1
        while FileManager.default.fileExists(atPath: candidate.path) {
            n += 1
            candidate = dir.appendingPathComponent(ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)")
        }
        return candidate
    }

    // MARK: uploads + JS dialogs

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor ([URL]?) -> Void
    ) {
        if let probe = WebProbe.upload {
            log.notice("probe open panel multiple=\(parameters.allowsMultipleSelection) → \(probe.lastPathComponent, privacy: .public)")
            completionHandler([probe])
            return
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window else { completionHandler(nil); return }
        panel.beginSheetModal(for: window) { result in
            MainActor.assumeIsolated { completionHandler(result == .OK ? panel.urls : nil) }
        }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor () -> Void
    ) {
        sheet(message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor (Bool) -> Void
    ) {
        sheet(message, buttons: ["OK", "Cancel"]) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void
    ) {
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        sheet(prompt, buttons: ["OK", "Cancel"], accessory: field) {
            completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    private func sheet(
        _ message: String, buttons: [String], accessory: NSView? = nil,
        done: @escaping @MainActor (NSApplication.ModalResponse) -> Void
    ) {
        if let answer = WebProbe.dialog {
            log.notice("probe dialog \(message, privacy: .public) → \(answer, privacy: .public)")
            done(answer == "ok" ? .alertFirstButtonReturn : .alertSecondButtonReturn)
            return
        }
        let a = NSAlert()
        a.messageText = message
        for b in buttons { a.addButton(withTitle: b) }
        a.accessoryView = accessory
        guard let window else { done(.alertSecondButtonReturn); return }
        a.beginSheetModal(for: window) { r in MainActor.assumeIsolated { done(r) } }
        if let accessory { a.window.initialFirstResponder = accessory }
    }

    private func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        if let window { a.beginSheetModal(for: window) } else { a.runModal() }
    }

    // MARK: menu actions (targets of the main menu below)

    @objc func reloadPage(_ sender: Any?) {
        if let failedURL { load(failedURL) } else { webView?.reload() }
    }

    @objc func goBack(_ sender: Any?) { webView?.goBack() }
    @objc func goForward(_ sender: Any?) { webView?.goForward() }

    @objc func zoomIn(_ sender: Any?) { stepZoom(+1) }
    @objc func zoomOut(_ sender: Any?) { stepZoom(-1) }
    @objc func actualSize(_ sender: Any?) { setZoom(1) }

    @objc func openInBrowser(_ sender: Any?) {
        if let url = webView?.url ?? failedURL, url.scheme == "http" || url.scheme == "https" {
            Browser.open(url)
        }
    }

    private func stepZoom(_ dir: Int) {
        let z = webView?.pageZoom ?? 1
        let steps = Self.zoomSteps
        let next = dir > 0 ? steps.first { $0 > z + 0.001 } : steps.last { $0 < z - 0.001 }
        if let next { setZoom(next) }
    }

    private func setZoom(_ z: CGFloat) {
        webView?.pageZoom = z
        UserDefaults.standard.set(Double(z), forKey: Self.zoomKey)
    }

    static var storedZoom: CGFloat {
        let z = UserDefaults.standard.double(forKey: zoomKey)
        return z >= 0.5 && z <= 3 ? CGFloat(z) : 1
    }

    // MARK: find (Cmd+F)

    private func makeFindBar() -> NSStackView {
        let field = NSSearchField()
        field.placeholderString = "Find in page"
        field.sendsSearchStringImmediately = false
        field.sendsWholeSearchString = true
        field.delegate = self
        field.target = self
        field.action = #selector(findFieldAction(_:))
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        findField = field

        let prev = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Previous")!,
                            target: self, action: #selector(findPrevious(_:)))
        let next = NSButton(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Next")!,
                            target: self, action: #selector(findNext(_:)))
        let done = NSButton(title: "Done", target: self, action: #selector(hideFind(_:)))
        for b in [prev, next, done] { b.bezelStyle = .accessoryBarAction; b.controlSize = .small }
        let status = NSTextField(labelWithString: "")
        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        status.identifier = NSUserInterfaceItemIdentifier("findStatus")

        let bar = NSStackView(views: [field, prev, next, status, NSView(), done])
        bar.orientation = .horizontal
        bar.spacing = 6
        bar.edgeInsets = NSEdgeInsets(top: 4, left: 8, bottom: 4, right: 8)
        bar.translatesAutoresizingMaskIntoConstraints = false
        return bar
    }

    /// For the probe: whether the find bar is open, its text and its status.
    var findState: String {
        let label = findBar?.views.first { $0.identifier?.rawValue == "findStatus" } as? NSTextField
        return "open=\(!(findBar?.isHidden ?? true)) text=\(findField?.stringValue ?? "") status=\(label?.stringValue ?? "") matched=\(lastFindMatched.map { String($0) } ?? "-")"
    }

    @objc func showFind(_ sender: Any?) {
        guard let bar = findBar, let top = findTop else { return }
        if bar.isHidden {
            bar.isHidden = false
            top.closed.isActive = false
            top.open.isActive = true
        }
        window?.makeFirstResponder(findField)
        findField?.selectText(nil)
    }

    @objc func hideFind(_ sender: Any?) {
        guard let bar = findBar, let top = findTop, !bar.isHidden else { return }
        bar.isHidden = true
        top.open.isActive = false
        top.closed.isActive = true
        window?.makeFirstResponder(webView)
    }

    @objc func findNext(_ sender: Any?) { find(backwards: false) }
    @objc func findPrevious(_ sender: Any?) { find(backwards: true) }

    @objc func useSelectionForFind(_ sender: Any?) {
        webView?.evaluateJavaScript("String(getSelection())") { [weak self] value, _ in
            MainActor.assumeIsolated {
                guard let self, let s = value as? String, !s.isEmpty else { return }
                self.showFind(nil)
                self.findField?.stringValue = s
            }
        }
    }

    @objc private func findFieldAction(_ sender: NSSearchField) {
        let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
        find(backwards: shift)
    }

    /// Esc in the search field closes the bar.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) { hideFind(nil); return true }
        return false
    }

    private func find(backwards: Bool) {
        guard let webView, let text = findField?.stringValue, !text.isEmpty else {
            if findBar?.isHidden ?? true { showFind(nil) }
            return
        }
        let cfg = WKFindConfiguration()
        cfg.backwards = backwards
        cfg.caseSensitive = false
        cfg.wraps = true
        webView.find(text, configuration: cfg) { [weak self] result in
            MainActor.assumeIsolated {
                let label = self?.findBar?.views.first { $0.identifier?.rawValue == "findStatus" } as? NSTextField
                label?.stringValue = result.matchFound ? "" : "Not found"
                self?.lastFindMatched = result.matchFound
            }
        }
    }

    // MARK: main menu (only while the window is open)

    private func installMainMenu() {
        let main = NSMenu()

        func menu(_ title: String, _ items: [NSMenuItem]) {
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            holder.submenu = m
            main.addItem(holder)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command],
                  target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }

        menu("TM Bar", [
            item("About TM Bar", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide TM Bar", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit TM Bar", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("File", [
            item("Open in Browser", #selector(openInBrowser(_:)), "o", [.command, .shift], target: self),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item("Find…", #selector(showFind(_:)), "f", target: self),
            item("Find Next", #selector(findNext(_:)), "g", target: self),
            item("Find Previous", #selector(findPrevious(_:)), "g", [.command, .shift], target: self),
            item("Use Selection for Find", #selector(useSelectionForFind(_:)), "e", target: self),
        ])
        menu("View", [
            item("Reload Page", #selector(reloadPage(_:)), "r", target: self),
            .separator(),
            item("Actual Size", #selector(actualSize(_:)), "0", target: self),
            item("Zoom In", #selector(zoomIn(_:)), "=", target: self),
            item("Zoom Out", #selector(zoomOut(_:)), "-", target: self),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        menu("History", [
            item("Back", #selector(goBack(_:)), "[", target: self),
            item("Forward", #selector(goForward(_:)), "]", target: self),
        ])
        let windowMenu = NSMenu(title: "Window")
        [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ].forEach(windowMenu.addItem)
        let windowHolder = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowHolder.submenu = windowMenu
        main.addItem(windowHolder)

        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu
    }

    /// The bundle ships no icon file (scripts/menubar.mjs): while the window
    /// makes TM Bar a Dock app, the menu-bar symbol on the system accent colour
    /// stands in for the generic one. Native chrome, system colours only.
    private static let dockIcon: NSImage = {
        let size = NSSize(width: 512, height: 512)
        return NSImage(size: size, flipped: false) { rect in
            let inset = rect.insetBy(dx: 40, dy: 40)
            NSColor.controlAccentColor.setFill()
            NSBezierPath(roundedRect: inset, xRadius: 96, yRadius: 96).fill()
            let cfg = NSImage.SymbolConfiguration(pointSize: 250, weight: .semibold)
                .applying(.init(paletteColors: [.white]))
            if let sym = NSImage(systemSymbolName: "checklist", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
                let s = sym.size
                sym.draw(in: NSRect(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2, width: s.width, height: s.height))
            }
            return true
        }
    }()

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}
