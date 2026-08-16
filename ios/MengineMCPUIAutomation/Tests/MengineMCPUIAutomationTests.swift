import Darwin
import Foundation
import XCTest

final class MengineMCPUIAutomationTests: XCTestCase {
    func testServeMengineMCP() throws {
        continueAfterFailure = false

        let environment = ProcessInfo.processInfo.environment
        let host = try require(environment["MENGINE_MCP_UI_HOST"], name: "MENGINE_MCP_UI_HOST")
        let portText = try require(environment["MENGINE_MCP_UI_PORT"], name: "MENGINE_MCP_UI_PORT")
        let token = try require(environment["MENGINE_MCP_UI_TOKEN"], name: "MENGINE_MCP_UI_TOKEN")
        let targetBundleId = try require(environment["MENGINE_MCP_UI_TARGET_BUNDLE_ID"], name: "MENGINE_MCP_UI_TARGET_BUNDLE_ID")
        guard let port = UInt16(portText) else {
            throw BridgeError.invalidConfiguration("MENGINE_MCP_UI_PORT is not a valid port")
        }

        var bridge = try BridgeConnection(host: host, port: port)
        defer { bridge.close() }
        try bridge.send(["type": "hello", "token": token])

        let target = XCUIApplication(bundleIdentifier: targetBundleId)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        while let request = try bridge.readObject() {
            let identifier = request["id"] as? NSNumber
            guard let identifier else {
                try bridge.send(["id": -1, "ok": false, "error": "missing command id"])
                continue
            }
            let command = request["command"] as? String ?? ""
            let params = request["params"] as? [String: Any] ?? [:]

            do {
                let result = try execute(
                    command: command,
                    params: params,
                    target: target,
                    springboard: springboard
                )
                try bridge.send(["id": identifier, "ok": true, "result": result])
                if command == "stop" {
                    break
                }
            } catch {
                try bridge.send(["id": identifier, "ok": false, "error": String(describing: error)])
            }
        }
    }

    private func execute(
        command: String,
        params: [String: Any],
        target: XCUIApplication,
        springboard: XCUIApplication
    ) throws -> Any {
        switch command {
        case "snapshot":
            let systemAlerts = springboard.alerts.allElementsBoundByIndex
            return [
                "source": "TARGET state=\(target.state.rawValue)\n"
                    + target.debugDescription
                    + "\nSYSTEM ALERTS\n"
                    + describe(elements: systemAlerts.flatMap { [$0] + $0.descendants(matching: .any).allElementsBoundByIndex })
            ]

        case "screenshot":
            return ["png": XCUIScreen.main.screenshot().pngRepresentation.base64EncodedString()]

        case "tap":
            let x = try number(params["x"], name: "x")
            let y = try number(params["y"], name: "y")
            let coordinateSpace = params["coordinateSpace"] as? String ?? "normalized"
            let coordinate: XCUICoordinate
            if coordinateSpace == "normalized" {
                coordinate = target.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
            } else if coordinateSpace == "points" {
                coordinate = target.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
            } else {
                throw BridgeError.invalidCommand("unsupported coordinateSpace '\(coordinateSpace)'")
            }
            coordinate.tap()
            return ["x": x, "y": y, "coordinateSpace": coordinateSpace]

        case "tapElement":
            let using = try string(params["using"], name: "using")
            let value = try string(params["value"], name: "value")
            let index = Int(try number(params["index"], name: "index"))
            let application = springboard.alerts.firstMatch.exists ? springboard : target
            let matches = try matchingElements(in: application, using: using, value: value)
            guard index >= 0, index < matches.count else {
                throw BridgeError.elementNotFound("no element at index \(index) for \(using)=\(value); matches=\(matches.count)")
            }
            let element = matches.element(boundBy: index)
            let label = element.label
            element.tap()
            return ["index": index, "matches": matches.count, "label": label]

        case "pressButton":
            let button = try string(params["button"], name: "button")
            let device = XCUIDevice.shared
            switch button {
            case "home":
                device.press(.home)
            case "volume_up":
#if targetEnvironment(simulator)
                throw BridgeError.invalidCommand("volume buttons are unavailable in the iOS Simulator")
#else
                guard device.hasHardwareButton(.volumeUp) else {
                    throw BridgeError.invalidCommand("this device has no Volume Up button")
                }
                device.press(.volumeUp)
#endif
            case "volume_down":
#if targetEnvironment(simulator)
                throw BridgeError.invalidCommand("volume buttons are unavailable in the iOS Simulator")
#else
                guard device.hasHardwareButton(.volumeDown) else {
                    throw BridgeError.invalidCommand("this device has no Volume Down button")
                }
                device.press(.volumeDown)
#endif
            default:
                throw BridgeError.invalidCommand("unsupported device button '\(button)'")
            }
            return ["button": button]

        case "alert":
            let action = try string(params["action"], name: "action")
            let alert = currentAlert(target: target, springboard: springboard)
            guard alert.exists else {
                throw BridgeError.elementNotFound("no native iOS alert is visible")
            }
            let buttons = alert.buttons.allElementsBoundByIndex
            switch action {
            case "text":
                let texts = alert.staticTexts.allElementsBoundByIndex.map(\.label).filter { !$0.isEmpty }
                return ["text": texts.joined(separator: "\n")]
            case "buttons":
                return ["buttons": buttons.map(\.label)]
            case "accept", "dismiss":
                let requestedLabel = params["buttonLabel"] as? String
                let button = try selectAlertButton(buttons: buttons, action: action, requestedLabel: requestedLabel)
                let label = button.label
                button.tap()
                return ["action": action, "button": label]
            default:
                throw BridgeError.invalidCommand("unsupported alert action '\(action)'")
            }

        case "stop":
            return ["stopped": true]

        default:
            throw BridgeError.invalidCommand("unknown command '\(command)'")
        }
    }

    private func matchingElements(in application: XCUIApplication, using: String, value: String) throws -> XCUIElementQuery {
        let descendants = application.descendants(matching: .any)
        switch using {
        case "accessibility_id":
            return descendants.matching(identifier: value)
        case "label":
            return descendants.matching(NSPredicate(format: "label == %@", value))
        case "predicate":
            return descendants.matching(NSPredicate(format: value))
        default:
            throw BridgeError.invalidCommand("unsupported locator strategy '\(using)'")
        }
    }

    private func describe(elements: [XCUIElement]) -> String {
        if elements.isEmpty {
            return "<none>"
        }
        return elements.enumerated().map { index, element in
            let frame = element.frame
            let value = element.value.map { String(describing: $0) } ?? ""
            return "[\(index)] type=\(element.elementType.rawValue) identifier=\(quoted(element.identifier)) label=\(quoted(element.label)) value=\(quoted(value)) frame=(\(frame.origin.x),\(frame.origin.y),\(frame.size.width),\(frame.size.height)) hittable=\(element.isHittable)"
        }.joined(separator: "\n")
    }

    private func quoted(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    private func currentAlert(target: XCUIApplication, springboard: XCUIApplication) -> XCUIElement {
        let systemAlert = springboard.alerts.firstMatch
        if systemAlert.exists {
            return systemAlert
        }
        return target.alerts.firstMatch
    }

    private func selectAlertButton(
        buttons: [XCUIElement],
        action: String,
        requestedLabel: String?
    ) throws -> XCUIElement {
        guard !buttons.isEmpty else {
            throw BridgeError.elementNotFound("the visible alert has no buttons")
        }
        if let requestedLabel {
            guard let button = buttons.first(where: { $0.label == requestedLabel }) else {
                throw BridgeError.elementNotFound("alert button '\(requestedLabel)' was not found")
            }
            return button
        }

        let preferred = action == "accept"
            ? ["Allow", "OK", "Continue", "Consent", "Yes"]
            : ["Don’t Allow", "Don't Allow", "Cancel", "Not Now", "No"]
        if let button = buttons.first(where: { preferred.contains($0.label) }) {
            return button
        }
        return action == "accept" ? buttons[buttons.count - 1] : buttons[0]
    }

    private func require(_ value: String?, name: String) throws -> String {
        guard let value, !value.isEmpty, !value.hasPrefix("$(") else {
            throw BridgeError.invalidConfiguration("missing \(name)")
        }
        return value
    }

    private func string(_ value: Any?, name: String) throws -> String {
        guard let value = value as? String else {
            throw BridgeError.invalidCommand("missing string parameter '\(name)'")
        }
        return value
    }

    private func number(_ value: Any?, name: String) throws -> Double {
        guard let value = value as? NSNumber else {
            throw BridgeError.invalidCommand("missing numeric parameter '\(name)'")
        }
        return value.doubleValue
    }
}

private enum BridgeError: Error, CustomStringConvertible {
    case invalidConfiguration(String)
    case invalidCommand(String)
    case elementNotFound(String)
    case socket(String)

    var description: String {
        switch self {
        case .invalidConfiguration(let message),
             .invalidCommand(let message),
             .elementNotFound(let message),
             .socket(let message):
            return message
        }
    }
}

private struct BridgeConnection {
    private var descriptor: Int32
    private var input = Data()

    init(host: String, port: UInt16) throws {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        hints.ai_protocol = IPPROTO_TCP
        hints.ai_flags = AI_NUMERICSERV

        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(host, String(port), &hints, &result)
        guard status == 0 else {
            throw BridgeError.socket("getaddrinfo failed: \(String(cString: gai_strerror(status)))")
        }
        defer { freeaddrinfo(result) }

        var connected: Int32 = -1
        var cursor = result
        while let info = cursor?.pointee {
            let candidate = socket(info.ai_family, info.ai_socktype, info.ai_protocol)
            if candidate >= 0 && Darwin.connect(candidate, info.ai_addr, info.ai_addrlen) == 0 {
                connected = candidate
                break
            }
            if candidate >= 0 {
                Darwin.close(candidate)
            }
            cursor = info.ai_next
        }
        guard connected >= 0 else {
            throw BridgeError.socket("unable to connect to MCP XCTest bridge at \(host):\(port)")
        }

        var enabled: Int32 = 1
        setsockopt(connected, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout.size(ofValue: enabled)))
        descriptor = connected
    }

    mutating func close() {
        if descriptor >= 0 {
            Darwin.close(descriptor)
            descriptor = -1
        }
    }

    mutating func readObject() throws -> [String: Any]? {
        while true {
            if let newline = input.firstIndex(of: 0x0A) {
                let line = input.subdata(in: input.startIndex..<newline)
                input.removeSubrange(input.startIndex...newline)
                guard !line.isEmpty else { continue }
                guard let object = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                    throw BridgeError.socket("received a non-object JSON command")
                }
                return object
            }

            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.recv(descriptor, &bytes, bytes.count, 0)
            if count == 0 {
                return nil
            }
            if count < 0 {
                throw BridgeError.socket("socket receive failed: \(String(cString: strerror(errno)))")
            }
            input.append(bytes, count: count)
        }
    }

    func send(_ object: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var offset = 0
            while offset < data.count {
                let count = Darwin.send(descriptor, base.advanced(by: offset), data.count - offset, 0)
                if count <= 0 {
                    throw BridgeError.socket("socket send failed: \(String(cString: strerror(errno)))")
                }
                offset += count
            }
        }
    }
}
