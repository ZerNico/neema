import Foundation

// One request per line on stdin, one response per line on stdout, as specified in
// apps/desktop/src/app-use/protocol.ts.
struct DriverError: Error {
  let code: String
  let message: String
}

func param<T>(_ params: [String: Any], _ key: String, as type: T.Type = T.self) throws -> T {
  guard let value = params[key] as? T else {
    throw DriverError(code: "invalid_params", message: "Missing or invalid \(key)")
  }
  return value
}

private let outputLock = NSLock()

func send(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  else { return }
  outputLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  outputLock.unlock()
}
