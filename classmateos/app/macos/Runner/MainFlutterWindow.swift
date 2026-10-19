import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController

    // 协作客户端默认窗口：1360×860，居中；可拖窄到手机宽度（<720 自动切换手机布局）
    let size = NSSize(width: 1360, height: 860)
    if let screen = NSScreen.main?.visibleFrame {
      let w = min(size.width, screen.width - 40)
      let h = min(size.height, screen.height - 40)
      let origin = NSPoint(x: screen.midX - w / 2, y: screen.midY - h / 2)
      self.setFrame(NSRect(origin: origin, size: NSSize(width: w, height: h)), display: true)
    }
    self.minSize = NSSize(width: 380, height: 600)
    self.title = "ClassmateOS"
    self.titlebarAppearsTransparent = true
    self.backgroundColor = NSColor.white

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
