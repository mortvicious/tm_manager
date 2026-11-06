import Foundation

enum ClientError: Error, Equatable {
    /// nothing answered on the port (front door down)
    case unreachable(String)
    /// the front door answered but the route is not there (an older API)
    case missingRoute
    case http(Int)
    case decode(String)
}

/// A write's answer: the status and the JSON body (empty when it was not JSON).
struct Reply: @unchecked Sendable {
    let status: Int
    let json: [String: Any]
    let data: Data

    var ok: Bool { (200..<300).contains(status) }
    /// the route's `error` sentence, verbatim
    var error: String? { json["error"] as? String }
    var reason: String? { json["reason"] as? String }
}

/// HTTP to the local front door only. GETs carry no Origin (the API's and the
/// front door's guards allow a loopback GET without one); writes send the
/// front door's own loopback Origin, `http://127.0.0.1:<port>`.
struct Client: Sendable {
    let base: URL
    private let session: URLSession
    private let writes: URLSession

    init(base: URL, protocolClasses: [AnyClass]? = nil) {
        self.base = base
        session = URLSession(configuration: Self.config(request: 3, resource: 5, protocolClasses))
        // A write waits for what it asked: /host/restart stops (≤ 8 s) and
        // waits for the new boot (≤ 30 s); a suspending Pause all waits up to
        // 15 s for compaction gates. A short timeout would read as a failure
        // of something that in fact happened.
        writes = URLSession(configuration: Self.config(request: 90, resource: 90, protocolClasses))
    }

    private static func config(request: TimeInterval, resource: TimeInterval, _ protocolClasses: [AnyClass]?) -> URLSessionConfiguration {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = request
        cfg.timeoutIntervalForResource = resource
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.waitsForConnectivity = false
        cfg.connectionProxyDictionary = [:] // never through a system proxy
        if let protocolClasses { cfg.protocolClasses = protocolClasses } // tests: a stubbed front door
        return cfg
    }

    var origin: String {
        var c = URLComponents()
        c.scheme = base.scheme
        c.host = base.host
        c.port = base.port
        return c.string ?? base.absoluteString
    }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let req = URLRequest(url: base.appending(path: path))
        let (data, resp) = try await send(req)
        guard let http = resp as? HTTPURLResponse else { throw ClientError.http(0) }
        if http.statusCode == 404 { throw ClientError.missingRoute }
        guard http.statusCode == 200 else { throw ClientError.http(http.statusCode) }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ClientError.decode(String(describing: error))
        }
    }

    /// POST `body` as JSON with the front door's own loopback Origin — the
    /// one the web page sends, so every guard judges it exactly as a click
    /// (`net.ts`'s allowlist is not widened). Any status is a reply; only a
    /// transport failure throws.
    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> Reply {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await send(req, on: writes)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return Reply(status: status, json: json ?? [:], data: data)
    }

    private func send(_ req: URLRequest, on: URLSession? = nil) async throws -> (Data, URLResponse) {
        do {
            return try await (on ?? session).data(for: req)
        } catch let e as URLError {
            throw ClientError.unreachable(e.localizedDescription)
        }
    }
}
