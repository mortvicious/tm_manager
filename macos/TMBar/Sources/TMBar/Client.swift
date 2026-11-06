import Foundation

enum ClientError: Error, Equatable {
    /// nothing answered on the port (front door down)
    case unreachable(String)
    /// the front door answered but the route is not there (an older API)
    case missingRoute
    case http(Int)
    case decode(String)
}

/// HTTP to the local front door only. GETs carry no Origin (the API's and the
/// front door's guards allow a loopback GET without one); the one write sends
/// the front door's own loopback Origin, `http://127.0.0.1:<port>`.
struct Client: Sendable {
    let base: URL
    private let session: URLSession

    init(base: URL) {
        self.base = base
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 3
        cfg.timeoutIntervalForResource = 5
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.waitsForConnectivity = false
        cfg.connectionProxyDictionary = [:] // never through a system proxy
        session = URLSession(configuration: cfg)
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

    /// POST with the loopback Origin and an empty JSON body. Returns the status code.
    func post(_ path: String) async throws -> Int {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (_, resp) = try await send(req)
        return (resp as? HTTPURLResponse)?.statusCode ?? 0
    }

    private func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: req)
        } catch let e as URLError {
            throw ClientError.unreachable(e.localizedDescription)
        }
    }
}
