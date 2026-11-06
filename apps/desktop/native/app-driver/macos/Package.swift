// swift-tools-version: 6.0
import PackageDescription

// The macOS app driver (docs/internals/app-use.md). It implements the protocol in
// apps/desktop/src/app-use/protocol.ts, as the Windows driver does.
let package = Package(
  name: "app-driver",
  // SCScreenshotManager, which captures one window without a stream, arrived in 14.
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "app-driver",
      path: "Sources",
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
