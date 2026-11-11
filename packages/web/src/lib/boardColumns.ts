// THE BOARD'S TWO COLUMNS — the sidebar and the workpane beside it — as the classes that size and place
// them. App.tsx lays a board and the Console out with these.

/** The pair, centred, with the scaling gutter between the columns (App.tsx explains each number). */
export const BOARD_PAIR_CLASS =
  "flex justify-center gap-[clamp(28px,3.4vw,52px)] px-5 max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3"

/** The sidebar column's width: it scales with the window, and takes the whole width once the pair stacks. */
export const SIDEBAR_WIDTH_CLASS = "w-[clamp(272px,34vw,680px)] shrink-0 max-[800px]:w-full"

/** The workpane's width: a 720px measure that gives way first when the window runs short. */
export const WORKPANE_WIDTH_CLASS = "w-[720px] max-w-[62vw] min-w-0 max-[800px]:w-full max-[800px]:max-w-none"
