export async function measureTextContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const p = [...ctx.getImageData(0, 0, 1, 1).data]
      return [p[0], p[1], p[2], p[3] / 255]
    }
    const over = (fg, bg) => {
      const alpha = fg[3] + bg[3] * (1 - fg[3])
      return [...fg.slice(0, 3).map((value, i) => alpha ? (value * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / alpha : 0), alpha]
    }
    const luminance = rgb => rgb.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
    const records = []
    const seen = new Set()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim()
      if (!text || node.parentElement.closest("script,style,svg,[aria-hidden=true]")) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1 || rect.top > innerHeight || rect.bottom < 0 || rect.left > innerWidth || rect.right < 0) continue
      const element = node.parentElement
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width / 2, 8))), Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)))
      if (!hit || !(element.contains(hit) || hit.contains(element))) continue
      const style = getComputedStyle(element)
      let bg = [0, 0, 0, 0]
      let fg = rgba(style.color)
      let opacity = 1
      for (let parent = element; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent)
        if (css.visibility === "hidden" || css.display === "none") { opacity = 0; break }
        opacity *= Number(css.opacity)
        // Group opacity applies to the painted background and foreground together.
        const backdrop = rgba(css.backgroundColor)
        bg = over(bg, backdrop)
        fg = over(fg, backdrop)
        bg[3] *= Number(css.opacity)
        fg[3] *= Number(css.opacity)
      }
      if (opacity === 0) continue
      bg = over(bg, [255, 255, 255, 1])
      fg = over(fg, [255, 255, 255, 1])
      const a = luminance(fg), b = luminance(bg)
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      const key = `${style.color}/${bg}/${opacity}/${element.className}`
      if (seen.has(key)) continue
      seen.add(key)
      records.push({ text: text.slice(0, 100), ratio: +ratio.toFixed(2), color: style.color, background: bg.slice(0, 3).map(Math.round), opacity, className: element.className, disabled: !!element.closest("[disabled],[aria-disabled=true]"), size: style.fontSize })
    }
    return records.sort((a, b) => a.ratio - b.ratio)
  })
}

export async function measureControlContrast(page, samples) {
  return page.evaluate(samples => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    const rgba = color => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    const over = (fg, bg) => [...fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])), 1]
    const lum = rgb => rgb.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((s, c, i) => s + c * [.2126, .7152, .0722][i], 0)
    return samples.map(({ selector, property, label }) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`Missing contrast target ${selector}`)
      const ancestors = []; let opacity = 1
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node); ancestors.unshift(style.backgroundColor); opacity *= Number(style.opacity)
      }
      const bg = ancestors.reduce((bg, color) => over(rgba(color), bg), [255, 255, 255, 1])
      const color = getComputedStyle(el)[property], fg = rgba(color); fg[3] *= opacity
      const a = lum(over(fg, bg)), b = lum(bg)
      return { label, color, background: bg, ratio: +((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(2) }
    })
  }, samples)
}

export async function measureAppearanceInk(page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('button[aria-label="Appearance"]')
    if (!trigger) throw new Error("No Appearance control")
    const text = trigger.querySelector("span")
    const glyph = trigger.querySelector("svg")
    const probe = document.createElement("span")
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
    text.append(probe)
    const baseline = probe.getBoundingClientRect().bottom
    probe.remove()
    const style = getComputedStyle(text)
    const ctx = document.createElement("canvas").getContext("2d")
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const cap = ctx.measureText("H").actualBoundingBoxAscent
    const shapes = [...glyph.querySelectorAll("path,polyline,line,circle,rect")].map(el => el.getBoundingClientRect())
    const top = Math.min(...shapes.map(r => r.top)), bottom = Math.max(...shapes.map(r => r.bottom))
    return { font: document.documentElement.dataset.font, size: style.fontSize, capHeight: cap, capCenter: baseline - cap / 2, glyphCenter: (top + bottom) / 2, residual: +(baseline - cap / 2 - (top + bottom) / 2).toFixed(3) }
  })
}
