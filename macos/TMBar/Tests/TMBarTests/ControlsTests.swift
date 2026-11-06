import Foundation
import Testing
@testable import TMBar

/// A front door in a URLProtocol: canned replies per "METHOD /path", every
/// request recorded (method, path, Origin, JSON body).
final class StubFrontDoor: URLProtocol, @unchecked Sendable {
    struct Seen: Sendable {
        let method: String
        let path: String
        let origin: String?
        let body: [String: Bool]
    }

    nonisolated(unsafe) static var replies: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var seen: [Seen] = []
    static let lock = NSLock()

    static func reset(_ r: [String: (Int, String)]) {
        lock.withLock {
            replies = r
            seen = []
        }
    }

    static func writes() -> [Seen] { lock.withLock { seen.filter { $0.method == "POST" } } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buf, maxLength: buf.count)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            stream.close()
        }
        let body = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Bool]) ?? [:]
        let reply: (Int, String) = Self.lock.withLock {
            Self.seen.append(Seen(method: method, path: path, origin: request.value(forHTTPHeaderField: "Origin"), body: body))
            return Self.replies["\(method) \(path)"] ?? (404, #"{"error":"not found"}"#)
        }
        let resp = HTTPURLResponse(url: request.url!, statusCode: reply.0, httpVersion: "HTTP/1.1",
                                   headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.1.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func hostStatus(up: Bool = true, rebuild: String = #"{"state":"idle","step":null,"error":null,"reason":null,"startedAt":null,"finishedAt":null}"#) -> String {
    #"{"api":{"up":\#(up),"managed":true,"pid":1,"port":5175,"bootedAt":"2026-11-06T10:00:00.000Z","restarts":0,"desired":"up","lastExit":null,"lastError":null},"host":{"port":5176,"dev":false,"spaBuilt":true,"buildId":"x","stale":false},"rebuild":\#(rebuild)}"#
}

let orchestrator = #"{"enabled":true,"paused":false,"pausedTasks":0,"running":2,"concurrency":3}"#
let quietCheck = #"{"blocked":false,"error":null,"services":1,"shells":0}"#
let busyRefusal = #"{"blocked":true,"error":"2 agent session(s) still working — stop them first, or retry with force.","running":2,"aux":0}"#

@MainActor
func makeStore() -> Store {
    Store(client: Client(base: URL(string: "http://127.0.0.1:5176")!, protocolClasses: [StubFrontDoor.self]))
}

@Suite(.serialized)
@MainActor
struct ControlsTests {
    @Test func stopRefusedThenForced() async throws {
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus()),
            "GET /api/orchestrator": (200, orchestrator),
            "GET /api/server/restart-check": (200, quietCheck),
            "POST /host/stop": (409, busyRefusal),
        ])
        let store = makeStore()
        await store.poll()

        // the press asks first, naming what dies with the API
        await store.press(.stop(force: false))
        let ask = try #require(store.pending)
        #expect(ask.control == .stop(force: false))
        #expect(ask.message.contains("1 running repo command(s)"))
        #expect(StubFrontDoor.writes().isEmpty)

        // confirmed → refused → the refusal verbatim + a Force offer
        await store.confirmPending()
        let offer = try #require(store.pending)
        #expect(offer.control == .stop(force: true))
        #expect(offer.refusal == "2 agent session(s) still working — stop them first, or retry with force.")
        #expect(offer.destructive)

        StubFrontDoor.lock.withLock { StubFrontDoor.replies["POST /host/stop"] = (200, #"{"ok":true}"#) }
        await store.confirmPending()
        #expect(store.pending == nil)
        #expect(store.note?.text == "API stopped.")

        let writes = StubFrontDoor.writes()
        #expect(writes.map(\.path) == ["/host/stop", "/host/stop"])
        #expect(writes.map(\.body) == [["force": false], ["force": true]])
        #expect(writes.allSatisfy { $0.origin == "http://127.0.0.1:5176" })
    }

    @Test func restartRefusalThatIsNotTheGuardIsShownNotForced() async throws {
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus()),
            "GET /api/orchestrator": (200, orchestrator),
            "POST /host/restart": (409, #"{"error":"a rebuild & restart is running — wait for it","reason":"in_progress"}"#),
        ])
        let store = makeStore()
        await store.perform(.restart(force: false))
        #expect(store.pending == nil)
        #expect(store.note?.text == "Restart refused: a rebuild & restart is running — wait for it")
        #expect(store.note?.tone == .warn)
    }

    @Test func rebuildIsADrain() async throws {
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus()),
            "GET /api/orchestrator": (200, orchestrator),
            "POST /host/rebuild-restart": (202, #"{"ok":true}"#),
            "POST /host/rebuild-restart/cancel": (409, #"{"error":"only a draining rebuild can be cancelled","reason":"not_draining"}"#),
        ])
        let store = makeStore()
        await store.poll()
        await store.press(.rebuild)
        #expect(store.pending?.title == "Drain & rebuild?") // 2 running
        await store.confirmPending()
        await store.press(.cancelDrain) // no confirm: it stops nothing
        #expect(store.note?.text == "Cancel drain refused: only a draining rebuild can be cancelled")
        let writes = StubFrontDoor.writes()
        #expect(writes.map(\.path) == ["/host/rebuild-restart", "/host/rebuild-restart/cancel"])
        #expect(writes[0].body == ["drain": true])
    }

    @Test func pauseAndContinueAreTheWebRequests() async throws {
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus()),
            "GET /api/orchestrator": (200, orchestrator),
            "POST /api/orchestrator/pause": (200, #"{"enabled":true,"paused":true,"running":0,"concurrency":3,"suspended":2,"wasPaused":false}"#),
            "POST /api/orchestrator/continue": (200, #"{"enabled":true,"paused":false,"running":2,"concurrency":3,"resumed":2,"waiting":0}"#),
        ])
        let store = makeStore()
        await store.poll()
        await store.press(.pause)
        #expect(store.pending?.message.contains("Suspends 2 live agent turn(s)") == true)
        await store.confirmPending()
        #expect(store.note?.text == "Paused — 2 turn(s) suspended.")
        await store.perform(.resume)
        #expect(store.note?.text == "Continued — 2 task(s) resumed.")
        let writes = StubFrontDoor.writes()
        // no `by`: the API records the human actor, as for the web button
        #expect(writes.map(\.body) == [[:], [:]])
        #expect(writes.allSatisfy { $0.origin == "http://127.0.0.1:5176" })
    }

    @Test func drainTimeoutIsSurfaced() async throws {
        let failed = #"{"state":"failed","step":null,"error":"Drain timed out: 1 agent session(s) still working — stop them first, or retry with force. The API was NOT restarted.","reason":"drain_timeout","startedAt":"2026-11-06T10:00:00.000Z","finishedAt":"2026-11-06T10:30:00.000Z","drain":true}"#
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus(rebuild: failed)),
            "GET /api/orchestrator": (200, orchestrator),
        ])
        let store = makeStore()
        await store.poll()
        let outcome = try #require(store.rebuildOutcome)
        #expect(outcome.text.hasPrefix("Drain timed out: 1 agent"))
        #expect(outcome.text.contains("The API was NOT restarted."))
        #expect(outcome.tone == .error)
        store.dismissRebuildOutcome()
        #expect(store.rebuildOutcome == nil)
    }

    @Test func drainingJobDecodes() async throws {
        let draining = #"{"state":"draining","step":"Draining — waiting for 1 agent turn(s) finishing (gives up in 29 min)…","error":null,"reason":null,"startedAt":"2026-11-06T10:00:00.000Z","finishedAt":null,"drain":true,"drainDeadline":"2026-11-06T10:30:00.000Z","waitingFor":{"running":1,"aux":["chat: x"],"notPauseAware":["chat: x"]},"logTail":"","pausedByJob":true,"continued":null}"#
        StubFrontDoor.reset([
            "GET /host/status": (200, hostStatus(up: false, rebuild: draining)),
        ])
        let store = makeStore()
        await store.poll()
        #expect(store.state == .rebuilding)
        #expect(store.host?.rebuild?.waitingFor?.notPauseAware == ["chat: x"])
        #expect(store.rebuildOutcome == nil)
    }
}
