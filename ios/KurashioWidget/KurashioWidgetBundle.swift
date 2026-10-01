import SwiftUI
import WidgetKit

@main
struct KurashioWidgetBundle: WidgetBundle {
    var body: some Widget {
        KurashioWidget()
        KurashioRemoteWidget()
        KurashioAirconWidget()
    }
}
