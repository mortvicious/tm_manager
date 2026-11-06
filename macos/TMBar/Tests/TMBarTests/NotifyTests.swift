import Foundation
import Testing
@testable import TMBar

/// The notification rules (docs/menubar.md § Notifications): once per
/// episode, a baseline first, nothing for a stop somebody asked for.

private func host(
    up: Bool = true, bootedAt: String? = "2026-11-06T10:00:00.000Z", desired: String = "up",
    exit: String = "null", rebuild: String = #"{"state":"idle","startedAt":null,"finishedAt":null}"#
) -> HostStatus {
    let booted = bootedAt.map { "\"\($0)\"" } ?? "null"
    let json = #"{"api":{"up":\#(up),"managed":true,"pid":1,"port":5175,"bootedAt":\#(booted),"restarts":0,"desired":"\#(desired)","lastExit":\#(exit),"lastError":null},"host":{"port":5176,"dev":false,"spaBuilt":true},"rebuild":\#(rebuild)}"#
    return try! JSONDecoder().decode(HostStatus.self, from: Data(json.utf8))
}

private func exit(_ at: String, cause: String? = nil, expected: Bool? = nil, code: Int? = 1, signal: String? = nil) -> String {
    var fields = [#""code":\#(code.map(String.init) ?? "null")"#, #""signal":\#(signal.map { "\"\($0)\"" } ?? "null")"#, #""at":"\#(at)""#]
    if let cause { fields.append(#""cause":"\#(cause)""#) }
    if let expected { fields.append(#""expected":\#(expected)"#) }
    return "{\(fields.joined(separator: ","))}"
}

private func summary(_ items: [(key: String, kind: String, task: String)], swap: Double = 10) -> MenubarSummary {
    let rows = items.map { #"{"key":"\#($0.key)","kind":"\#($0.kind)","taskId":"\#($0.task)","title":"T \#($0.task)","repoName":"nest","ready":false}"# }
    let json = #"{"at":"x","queue":{"enabled":true,"paused":false,"running":0,"concurrency":2,"aux":0},"tasks":[],"inbox":{"total":\#(items.count),"questions":0,"needsYou":0,"urgent":false,"items":[\#(rows.joined(separator: ","))]},"memory":{"freePct":50,"swapPct":\#(swap),"swapUsedMb":1,"swapTotalMb":2,"pressureLevel":1,"armed":false,"tripped":false,"reason":null,"hold":null},"heavy":null}"#
    return try! JSONDecoder().decode(MenubarSummary.self, from: Data(json.utf8))
}

private let t0 = Format.date("2026-11-06T10:00:30.000Z")!
private var all: NotifySettings {
    var s = NotifySettings()
    s.enabled = Set(NotifyKind.allCases)
    return s
}

struct NotifyEngineTests {
    @Test func crashOncePerEpisodeAndNeverForAskedStops() {
        var e = NotifyEngine()
        // baseline: an exit already on record at launch is not news
        #expect(e.step(.init(host: host(exit: exit("2026-11-06T09:00:00Z", cause: "crash", expected: false)), now: t0), settings: all).isEmpty)
        // a restart somebody asked for
        #expect(e.step(.init(host: host(exit: exit("2026-11-06T10:01:00Z", cause: "supervisor", expected: true)), now: t0), settings: all).isEmpty)
        // a crash: one notification …
        let crash = e.step(.init(host: host(up: false, bootedAt: nil, exit: exit("2026-11-06T10:02:00Z", cause: "crash", expected: false)), now: t0), settings: all)
        #expect(crash.map(\.kind) == [.crash])
        #expect(crash.first?.body.contains("It crashed") == true)
        #expect(crash.first?.path == "/dashboard")
        // … and a crash loop inside the episode adds none
        let loop = e.step(.init(host: host(up: true, bootedAt: "2026-11-06T10:02:05Z", exit: exit("2026-11-06T10:02:04Z", cause: "unknown", expected: false)), now: Format.date("2026-11-06T10:02:10Z")!), settings: all)
        #expect(loop.isEmpty)
        // up for a minute: the episode closes; the next crash is news again
        _ = e.step(.init(host: host(bootedAt: "2026-11-06T10:02:05Z", exit: exit("2026-11-06T10:02:04Z", cause: "unknown", expected: false)), now: Format.date("2026-11-06T10:04:00Z")!), settings: all)
        #expect(!e.crashOpen)
        let again = e.step(.init(host: host(up: false, bootedAt: nil, exit: exit("2026-11-06T10:05:00Z", cause: "unknown", expected: false)), now: Format.date("2026-11-06T10:05:01Z")!), settings: all)
        #expect(again.map(\.kind) == [.crash])
    }

    @Test func olderFrontDoorFallsBackOnDesiredAndExitCode() {
        let h = host(exit: exit("a", code: 0))
        #expect(!NotifyEngine.unexpected(h.api.lastExit!, h)) // the restart route exits 0
        let k = host(exit: exit("b", code: nil, signal: "SIGKILL"))
        #expect(NotifyEngine.unexpected(k.api.lastExit!, k))
        let stopped = host(up: false, desired: "down", exit: exit("c", code: 1))
        #expect(!NotifyEngine.unexpected(stopped.api.lastExit!, stopped))
    }

    @Test func rebuildDoneAndFailedOnceCancelledNever() {
        var e = NotifyEngine()
        let idle = host()
        #expect(e.step(.init(host: idle), settings: all).isEmpty)
        let done = host(rebuild: #"{"state":"done","startedAt":"s1","finishedAt":"f1","continued":true}"#)
        #expect(e.step(.init(host: done), settings: all).map(\.title) == ["Rebuild & restart finished"])
        #expect(e.step(.init(host: done), settings: all).isEmpty)
        let failed = host(rebuild: #"{"state":"failed","startedAt":"s2","finishedAt":"f2","error":"vite build failed","reason":"build"}"#)
        let f = e.step(.init(host: failed), settings: all)
        #expect(f.map(\.title) == ["Rebuild & restart failed"])
        #expect(f.first?.body == "vite build failed")
        let cancelled = host(rebuild: #"{"state":"failed","startedAt":"s3","finishedAt":"f3","reason":"cancelled"}"#)
        #expect(e.step(.init(host: cancelled), settings: all).isEmpty)
    }

    @Test func fuseAndSwapEpisodesWithHysteresis() {
        var e = NotifyEngine()
        var s = all
        s.swapLine = 80
        #expect(e.step(.init(fuseTripped: false, swapPct: 50), settings: s).isEmpty) // baseline
        #expect(e.step(.init(fuseTripped: true, fuseReason: "7% free", swapPct: 81), settings: s).map(\.kind) == [.memory, .swap])
        // still above / wobbling inside the hysteresis: same episodes
        #expect(e.step(.init(fuseTripped: true, swapPct: 77), settings: s).isEmpty)
        #expect(e.step(.init(fuseTripped: true, swapPct: 82), settings: s).isEmpty)
        // a missing reading (API down) is not "cleared"
        #expect(e.step(.init(), settings: s).isEmpty)
        #expect(e.step(.init(fuseTripped: true, swapPct: 82), settings: s).isEmpty)
        // cleared below line − 5, then crossing again: news
        #expect(e.step(.init(fuseTripped: false, swapPct: 70), settings: s).isEmpty)
        #expect(e.step(.init(fuseTripped: true, swapPct: 90), settings: s).map(\.kind) == [.memory, .swap])
    }

    @Test func inboxOncePerKeyBaselineAndReset() {
        var e = NotifyEngine()
        let q = (key: "question:a", kind: "question", task: "a")
        let r = (key: "review:b", kind: "review", task: "b")
        let f = (key: "failed:c", kind: "failed", task: "c")
        #expect(e.step(.init(summary: summary([q])), settings: all).isEmpty) // baseline
        let next = e.step(.init(summary: summary([q, r, f])), settings: all)
        #expect(next.map(\.key) == ["review:b"]) // failed is not a TM Bar kind
        #expect(next.first?.path == "/?task=b&tab=review")
        // the API down: no reading, nothing forgotten
        #expect(e.step(.init(summary: nil), settings: all).isEmpty)
        #expect(e.step(.init(summary: summary([q, r])), settings: all).isEmpty)
        // answered, then asked again: a new episode
        _ = e.step(.init(summary: summary([r])), settings: all)
        #expect(e.step(.init(summary: summary([q, r])), settings: all).map(\.path) == ["/?task=a"])
        // the source turned off: it starts over with a baseline
        _ = e.step(.init(summary: nil, inboxWanted: false), settings: all)
        let a = (key: "attention:d", kind: "attention", task: "d")
        #expect(e.step(.init(summary: summary([q, r, a])), settings: all).isEmpty)
    }

    @Test func channelAndTogglesFilterButNeverReplay() {
        var e = NotifyEngine()
        var s = NotifySettings() // defaults: Inbox kinds off
        s.channel = .webPush
        #expect(!s.posts(.memory) && !s.posts(.question) && s.posts(.crash) && s.posts(.swap))
        #expect(s.needsSummary) // the swap line
        let q = (key: "question:a", kind: "question", task: "a")
        _ = e.step(.init(fuseTripped: false, summary: summary([])), settings: s)
        // tracked while not posted …
        #expect(e.step(.init(fuseTripped: true, summary: summary([q])), settings: s).isEmpty)
        // … so turning the kinds on later does not replay what is already true
        s.channel = .tmBar
        s.enabled.insert(.question)
        #expect(e.step(.init(fuseTripped: true, summary: summary([q])), settings: s).isEmpty)
        var off = NotifySettings()
        off.enabled = [.crash]
        #expect(!off.needsSummary)
    }
}

/// Its own stubbed front door: the suites run in parallel, and StubFrontDoor's
/// statics belong to ControlsTests.
final class NotifyFrontDoor: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var replies: [String: String] = [:]
    nonisolated(unsafe) static var paths: [String] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let body: String? = Self.lock.withLock {
            Self.paths.append(path)
            return Self.replies[path]
        }
        let resp = HTTPURLResponse(url: request.url!, statusCode: body == nil ? 404 : 200, httpVersion: "HTTP/1.1",
                                   headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? "{}").utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Suite(.serialized)
@MainActor
struct NotifyStoreTests {
    @Test func closedMenuReadsTheSummaryOnlyWhenAKindNeedsIt() async throws {
        let defaults = UserDefaults(suiteName: "tmbar-tests-\(UUID().uuidString)")!
        defaults.set(false, forKey: "notify.swap")
        let notifier = Notifier(defaults: defaults, post: false)
        var posted: [Alert] = []
        notifier.sink = { posted.append($0) }
        let summaryWith = { (items: String) in
            #"{"at":"x","queue":{"enabled":true,"paused":false,"running":0,"concurrency":2,"aux":0},"tasks":[],"inbox":{"total":0,"questions":0,"needsYou":0,"urgent":false,"items":[\#(items)]},"memory":null,"heavy":null}"#
        }
        NotifyFrontDoor.lock.withLock {
            NotifyFrontDoor.replies = ["/host/status": hostStatus(), "/api/orchestrator": orchestrator, "/api/menubar": summaryWith("")]
            NotifyFrontDoor.paths = []
        }
        let gets = { NotifyFrontDoor.lock.withLock { NotifyFrontDoor.paths } }
        let clear = { NotifyFrontDoor.lock.withLock { NotifyFrontDoor.paths = [] } }
        let store = Store(client: Client(base: URL(string: "http://127.0.0.1:5176")!, protocolClasses: [NotifyFrontDoor.self]), notifier: notifier)
        await store.poll()
        #expect(gets().contains("/api/orchestrator"))
        #expect(!gets().contains("/api/menubar"))

        notifier.setEnabled(.question, true)
        clear()
        await store.poll()
        #expect(gets().contains("/api/menubar"))
        #expect(!gets().contains("/api/orchestrator")) // the summary carries the icon's read
        NotifyFrontDoor.lock.withLock {
            NotifyFrontDoor.replies["/api/menubar"] = summaryWith(#"{"key":"question:t1","kind":"question","taskId":"t1","title":"Pick a DB","repoName":"nest","ready":false}"#)
        }
        await store.poll()
        #expect(posted.map(\.key) == ["question:t1"])
        #expect(posted.first?.path == "/?task=t1")
        await store.poll()
        #expect(posted.count == 1)
    }
}

struct NotifyClickTests {
    @Test func aClickOpensThePathUnderThePageBase() {
        let base = URL(string: "http://127.0.0.1:5176")!
        #expect(Poster.url(base: base, path: "/?task=t1&tab=review")?.absoluteString == "http://127.0.0.1:5176/?task=t1&tab=review")
        #expect(Poster.url(base: base, path: "/dashboard")?.absoluteString == "http://127.0.0.1:5176/dashboard")
        #expect(Poster.url(base: URL(string: "http://localhost:5173")!, path: "/inbox")?.absoluteString == "http://localhost:5173/inbox")
        #expect(Poster.url(base: base, path: "https://evil.example/") == nil) // only in-app paths
    }
}
