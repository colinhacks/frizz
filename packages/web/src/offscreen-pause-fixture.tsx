import { createRoot } from "react-dom/client"
import { BoxSpinner } from "./components/BoxSpinner.tsx"
import { LiveDot } from "./components/LiveDot.tsx"
import "./styles.css"

// OFFSCREEN-PAUSE FIXTURE — the app's two infinite animations, the live dot and the rail's box spinner,
// each drawn three times: in view, below the fold of the page, and below the fold of a scrolling panel
// (the sidebar's case). offscreenPause.e2e.test.ts reads which of them run; anything out of view must be
// paused, and must run again once scrolled in. `data-where` names each copy.
function Marks({ where }: { where: string }) {
  return (
    <div data-where={where} className="flex items-center gap-3 p-3 text-[13px] text-fg">
      <LiveDot hue="shell" />
      <LiveDot hue="agent" />
      <BoxSpinner />
      <span>{where}</span>
    </div>
  )
}

function Fixture() {
  return (
    <div className="bg-bg">
      <Marks where="in-view" />
      <div data-panel className="h-[160px] overflow-y-auto border border-border">
        <div className="h-[600px]" />
        <Marks where="panel-below" />
      </div>
      <div className="h-[3000px]" />
      <Marks where="page-below" />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
