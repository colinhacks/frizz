// WHETHER A PROJECT ICON FILLS ITS ROUNDED TILE, or is contained inside it with a little padding.
//
// Filling (object-cover, no padding) is right for a picture that is its own plate: a screenshot, an
// app icon on its own square. The tile's 30% rounding trims its corners, and that trim is what makes
// it read as a tile. It is WRONG for a free-standing mark on a transparent canvas: open-knowledge's
// `favicon.svg` is a 78x80 speech bubble whose white outline reaches the canvas's top and left, and
// filled into a 16px tile that outline was cut flat along both (reported 2026-11-25 on the Console's
// thread rows). Squareness alone cannot tell the two apart, and neither can transparent edges: a white
// app-icon plate with a thin transparent margin (512x512, clear at the top and bottom edge) filled
// well and looked like a hard white stamp once padded.
//
// What separates them is the CORNERS the tile cuts off anyway. A plate or a picture has ink right where
// the tile's rounding ends; a free-standing mark does not. The 30% rounding trims 8.8% in along each
// diagonal, so the sample sits just past it, 3px in on a 32px copy (pixel centre 10.9% in): a plate
// rounded up to ~37% is opaque there, which is any plate the tile's own rounding hides the corners of.
// Measured on the served copies at every size the squares ask for: square and rounded plates (0%, 22%,
// 28%, and open-knowledge's own desktop app icon) read 243–255 at all four corners, its favicon's
// bubble read 0 at all four, and a bubble whose outline reaches only the top corners read 255/255/0/0.
// 2px in was too shallow: it sits inside the tile's trim, where a plate rounded past ~27% is already
// clear, so the 28% plate and the desktop app icon (64–170 there) were padded into a stamp.

/** A near-square picture: a 372x368 screenshot (1.1% off) is; a 300x331 logo (9.4% off) is not. */
const SQUARE_TOLERANCE = 0.05
/** Alpha (0–255) every corner sample must reach for the picture to count as its own plate. */
const PLATE_ALPHA = 200
/** The side of the canvas the picture is sampled on. Small: four pixels are read. */
const SAMPLE_PX = 32
/** How far in from each corner the sample sits, on that canvas: just past what the tile's rounding trims. */
const CORNER_INSET = 3

/**
 * The decision itself. `cornerAlphas` is the alpha just inside each corner, or undefined when the
 * pixels could not be read — then squareness alone decides, which is how every icon was fitted before.
 */
export function iconFillsTile(width: number, height: number, cornerAlphas: readonly number[] | undefined): boolean {
  if (!(width > 0 && height > 0)) return false
  if (Math.abs(width / height - 1) > SQUARE_TOLERANCE) return false
  return cornerAlphas === undefined || cornerAlphas.every((alpha) => alpha >= PLATE_ALPHA)
}

/** The alpha just inside each corner of a loaded image, if the browser lets it be read. */
export function iconCornerAlphas(img: HTMLImageElement): number[] | undefined {
  try {
    const canvas = document.createElement("canvas")
    canvas.width = SAMPLE_PX
    canvas.height = SAMPLE_PX
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) return undefined
    context.drawImage(img, 0, 0, SAMPLE_PX, SAMPLE_PX)
    const { data } = context.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX)
    const near = CORNER_INSET
    const far = SAMPLE_PX - 1 - CORNER_INSET
    const alphaAt = (x: number, y: number) => data[(y * SAMPLE_PX + x) * 4 + 3]!
    return [alphaAt(near, near), alphaAt(far, near), alphaAt(near, far), alphaAt(far, far)]
  } catch {
    // A canvas the browser will not read back (a cross-origin picture taints it): squareness decides.
    return undefined
  }
}
