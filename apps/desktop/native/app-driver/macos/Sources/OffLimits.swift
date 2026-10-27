// Apps app use never touches, whatever the person allows. Checked here rather than only in the
// desktop app so a confused caller cannot reach them either.
let offLimitsBundleIds: Set<String> = [
  // Terminals: the model already has the chat's VM for commands.
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.mitchellh.ghostty",
  "co.zeit.hyper",
  // Credentials.
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.lastpass.LastPass",
  "in.sinew.Enpass-Desktop",
  // The system's own settings and prompts.
  "com.apple.systempreferences",
  "com.apple.SecurityAgent",
  "com.apple.SecurityAgentHelper",
  "com.apple.UserNotificationCenter",
  "com.apple.ScreenContinuity",
  // neema itself, and Electron in development.
  "app.neema.desktop",
  "com.github.Electron",
]

func isOffLimits(_ bundleId: String?) -> Bool {
  guard let bundleId else { return true }
  return offLimitsBundleIds.contains(bundleId)
}
