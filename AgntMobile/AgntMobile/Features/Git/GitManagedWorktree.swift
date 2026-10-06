import Foundation

struct GitManagedWorktree: Identifiable, Sendable {
    let path: String
    let branch: String?
    let isClean: Bool

    var id: String { path }

    init?(from json: JSONValue) {
        guard let object = json.objectValue,
              let path = object["path"]?.stringValue,
              !path.isEmpty else {
            return nil
        }
        self.path = path
        self.branch = object["branch"]?.stringValue
        self.isClean = object["isClean"]?.boolValue ?? false
    }
}
