import Foundation
import Testing
@testable import TMBar

/// `TM_BAR_LIVE=1 swift test --filter LiveRefusals` — the real Store against
/// the LIVE front door, through presses that are refused by construction and
/// so change nothing: Restart only while the restart check is blocked (agents
/// working → 409 → the Force offer, which is never confirmed), Cancel drain
/// only while no drain runs (409 not_draining). Skipped otherwise.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["TM_BAR_LIVE"] == "1"))
@MainActor
struct LiveRefusals {
    let store = Store(client: Client(base: Config.baseURL()))

    @Test func restartWhileAgentsWorkOffersForce() async throws {
        let check = try await store.client.get("/api/server/restart-check", as: RestartCheck.self)
        try #require(check.blocked, "nobody is working: a restart would really happen — not run live")
        await store.perform(.restart(force: false))
        let offer = try #require(store.pending)
        #expect(offer.control == .restart(force: true))
        #expect(offer.refusal == check.error)
        store.cancelPending()
        print("live refusal shown verbatim: \(offer.refusal ?? "")")
    }

    @Test func cancelWithoutADrainIsRefused() async throws {
        await store.poll()
        try #require(store.host?.rebuild?.state != "draining", "a drain is running — not cancelled from a test")
        await store.perform(.cancelDrain)
        #expect(store.note?.text == "Cancel drain refused: only a draining rebuild can be cancelled")
    }
}
