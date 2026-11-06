import Foundation

/// The subset of `HostStatus` (shared/src/types.ts) TM Bar reads from
/// `GET /host/status`. Every field the app does not need is left out, and every
/// field a front door may omit (older builds) is optional, so a newer or older
/// server never fails to decode.
struct HostStatus: Decodable, Equatable, Sendable {
    struct API: Decodable, Equatable, Sendable {
        struct Exit: Decodable, Equatable, Sendable {
            let code: Int?
            let signal: String?
            let at: String
        }
        let up: Bool
        let managed: Bool
        let pid: Int?
        let port: Int
        let bootedAt: String?
        let restarts: Int
        let desired: String
        let lastExit: Exit?
        let lastError: String?
    }
    struct Host: Decodable, Equatable, Sendable {
        let port: Int
        let dev: Bool
        let spaBuilt: Bool
        let buildId: String?
        let stale: Bool?
        let service: String?
        /// server/data/logs when the front door writes file logs, else null
        let logDir: String?
    }
    struct Rebuild: Decodable, Equatable, Sendable {
        /// a drain's latest restart-check reading (`RebuildWaitingFor`)
        struct WaitingFor: Decodable, Equatable, Sendable {
            let running: Int
            let aux: [String]
            let notPauseAware: [String]
        }
        let state: String
        let step: String?
        let error: String?
        let reason: String?
        let startedAt: String?
        let finishedAt: String?
        let drain: Bool?
        let drainDeadline: String?
        let waitingFor: WaitingFor?
        let logTail: String?
        let pausedByJob: Bool?
        /// after the restart: true = the job pressed Continue, false = left paused
        let continued: Bool?

        /// idle/done/failed are the resting states; anything else is a job in flight.
        var inProgress: Bool { !["idle", "done", "failed"].contains(state) }
    }
    let api: API
    let host: Host
    let rebuild: Rebuild?
}
