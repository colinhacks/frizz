// Leading YAML frontmatter, split off a document before it is rendered as Markdown. CommonMark has no
// idea what `---` on line one means: the block after it becomes a paragraph and the closing `---`
// turns that paragraph into a setext H2, so a blog post opened in the reader led with its own
// metadata set as a giant heading (`title: … author: … date: …`) before the first real line. Only a
// block that opens on the VERY FIRST line counts; a `---` anywhere later is a thematic break.
export function splitFrontmatter(markdown: string): { front: string | null; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown)
  if (!match) return { front: null, body: markdown }
  return { front: match[1], body: markdown.slice(match[0].length) }
}
