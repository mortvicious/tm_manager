import Foundation

/// `GET /api/menubar` (shared/src/menubar.ts `MenubarSummary`). Optional where
/// the server may send null.
struct MenubarSummary: Decodable, Equatable, Sendable {
    struct Queue: Decodable, Equatable, Sendable {
        let enabled: Bool
        let paused: Bool
        /// what Continue resumes (absent on an API older than the controls)
        let pausedTasks: Int?
        let running: Int
        let concurrency: Int
        let aux: Int
    }
    struct TaskRow: Decodable, Equatable, Sendable, Identifiable {
        let id: String
        let title: String
        let repoName: String?
        let status: String
        let startedAt: String?
        let needsAttention: Bool
        let asking: Bool
    }
    struct Inbox: Decodable, Equatable, Sendable {
        let total: Int
        let questions: Int
        let needsYou: Int
        let urgent: Bool
    }
    struct Memory: Decodable, Equatable, Sendable {
        let freePct: Double?
        let swapPct: Double?
        let swapUsedMb: Double?
        let swapTotalMb: Double?
        let pressureLevel: Int?
        let armed: Bool
        let tripped: Bool
        let reason: String?
        let hold: String?
    }
    struct Heavy: Decodable, Equatable, Sendable {
        let max: Int
        let held: Int
        let waiting: Int
    }
    let at: String
    let queue: Queue
    let tasks: [TaskRow]
    let inbox: Inbox
    let memory: Memory?
    let heavy: Heavy?
}

/// The few `OrchestratorStatus` fields (GET /api/orchestrator) the closed-menu
/// icon needs — the cheap read polled every 5 s.
struct OrchestratorLite: Decodable, Equatable, Sendable {
    struct Memory: Decodable, Equatable, Sendable {
        struct Sample: Decodable, Equatable, Sendable {
            let freePct: Double?
            let swapPct: Double?
        }
        let sample: Sample?
        let tripped: Bool
        let reason: String?
        let hold: String?
    }
    let enabled: Bool
    let paused: Bool?
    let pausedTasks: Int?
    let running: Int
    let concurrency: Int
    let memory: Memory?
}
