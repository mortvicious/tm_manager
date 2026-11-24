import AppKit
import SwiftUI
import ImageIO
import UniformTypeIdentifiers

/// The Gor mark (docs/magma.md § 10), drawn in code from the SVG master's
/// geometry so the menu-bar template, the Dock icon and the bundle's `.icns`
/// (exported at build time by `scripts/menubar.mjs` → `TMBar --export-iconset`)
/// are one drawing. Coordinates are the master's 64-unit, y-down space.
enum GorMark {
    enum Style {
        /// the master: dark tile, ember-gradient G, yellow spark
        case tile
        /// the menu bar: black G + spark, no tile, macOS tints it (`isTemplate`)
        case template
    }

    // Colours are the SVG master's literals (§ 10), not UI tokens: an icon is an asset.
    private static let tileFill = CGColor(srgbRed: 0x0a / 255, green: 0x06 / 255, blue: 0x05 / 255, alpha: 1)
    private static let red = CGColor(srgbRed: 1, green: 0x4a / 255, blue: 0x3d / 255, alpha: 1)
    private static let orange = CGColor(srgbRed: 1, green: 0x8a / 255, blue: 0x3d / 255, alpha: 1)
    private static let yellow = CGColor(srgbRed: 1, green: 0xc9 / 255, blue: 0x3d / 255, alpha: 1)

    /// `M44.73 19.27 A18 18 0 1 0 50 32 H34`: a 315° arc of r 18 round (32,32)
    /// from −45° counter-clockwise (on screen) to 0°, then the bar in to (34,32).
    private static func gPath() -> CGPath {
        let p = CGMutablePath()
        let c = CGPoint(x: 32, y: 32), r: CGFloat = 18
        let steps = 315
        for i in 0...steps {
            let deg = -45.0 - Double(i)
            let a = deg * .pi / 180
            let pt = CGPoint(x: c.x + r * CGFloat(cos(a)), y: c.y + r * CGFloat(sin(a)))
            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
        }
        p.addLine(to: CGPoint(x: 34, y: 32))
        return p
    }

    /// Draws the mark into `ctx` over a `pixels`-square canvas. `inset`/`radius`
    /// place the tile (the macOS app grid uses an 824/1024 tile, radius ≈ 185).
    private static func draw(_ ctx: CGContext, pixels: Int, style: Style, grid: Bool) {
        let size = CGFloat(pixels)
        let tile = grid ? size * 824 / 1024 : size
        let offset = (size - tile) / 2
        // y-down, 64 units across the tile
        ctx.translateBy(x: 0, y: size)
        ctx.scaleBy(x: 1, y: -1)
        ctx.translateBy(x: offset, y: offset)
        ctx.scaleBy(x: tile / 64, y: tile / 64)

        // ≤ 18 px: the spark moves out of the stroke's end (§ 10 § Small sizes)
        let small = tile <= 18 || style == .template
        let spark = small ? CGRect(x: 49, y: 5, width: 10, height: 10) : CGRect(x: 44.5, y: 9.5, width: 9, height: 9)

        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        switch style {
        case .template:
            ctx.setStrokeColor(.black)
            ctx.setFillColor(.black)
            ctx.setLineWidth(9)
            ctx.addPath(gPath())
            ctx.strokePath()
            ctx.fillEllipse(in: spark)
        case .tile:
            let rx: CGFloat = grid ? 64 * 185 / 824 : 14
            ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 64, height: 64), cornerWidth: rx, cornerHeight: rx, transform: nil))
            ctx.setFillColor(tileFill)
            ctx.fillPath()
            ctx.saveGState()
            ctx.setLineWidth(8)
            ctx.addPath(gPath())
            ctx.replacePathWithStrokedPath()
            ctx.clip()
            if let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [red, orange, yellow] as CFArray, locations: [0, 0.6, 1]) {
                ctx.drawLinearGradient(g, start: CGPoint(x: 14, y: 50), end: CGPoint(x: 50, y: 14), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
            }
            ctx.restoreGState()
            ctx.setFillColor(yellow)
            ctx.fillEllipse(in: spark)
        }
    }

    static func cgImage(pixels: Int, style: Style, grid: Bool = false) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        ctx.interpolationQuality = .high
        draw(ctx, pixels: pixels, style: style, grid: grid)
        return ctx.makeImage()
    }

    /// The idle menu-bar icon: 18 pt, 1x + 2x, a template image.
    @MainActor static let menuBar: NSImage = {
        let img = NSImage(size: NSSize(width: 18, height: 18))
        for px in [18, 36] {
            if let cg = cgImage(pixels: px, style: .template) {
                let rep = NSBitmapImageRep(cgImage: cg)
                rep.size = NSSize(width: 18, height: 18)
                img.addRepresentation(rep)
            }
        }
        img.isTemplate = true
        img.accessibilityDescription = "Gor"
        return img
    }()

    /// The Dock icon while the window is open (the bundle's `.icns` covers
    /// Finder; this covers `swift run` too).
    @MainActor static let appIcon: NSImage = {
        guard let cg = cgImage(pixels: 1024, style: .tile, grid: true) else { return NSImage() }
        return NSImage(cgImage: cg, size: NSSize(width: 512, height: 512))
    }()

    /// Writes an `.iconset` (16 … 512@2x) for `iconutil -c icns`.
    static func exportIconset(to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for pt in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let name = scale == 1 ? "icon_\(pt)x\(pt).png" : "icon_\(pt)x\(pt)@2x.png"
                guard let cg = cgImage(pixels: pt * scale, style: .tile, grid: true),
                      let dest = CGImageDestinationCreateWithURL(dir.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1, nil)
                else { throw ExportError(name: name) }
                CGImageDestinationAddImage(dest, cg, nil)
                if !CGImageDestinationFinalize(dest) { throw ExportError(name: name) }
            }
        }
    }

    struct ExportError: Error, CustomStringConvertible {
        let name: String
        var description: String { "could not write \(name)" }
    }
}

/// The bar state's icon: the Gor mark (a template image) while idle, else
/// the state's SF Symbol.
struct StateIcon: View {
    let state: BarState

    var body: some View {
        if let name = state.symbol {
            Image(systemName: name)
        } else {
            Image(nsImage: GorMark.menuBar)
        }
    }
}
