// THE READ SIDE OF THE CODEX WIRE GATE: what a schema Frizz parses with would REFUSE of what the
// app-server declares it can send.
//
// `codex app-server generate-json-schema` describes the protocol as JSON Schema; the bridge reads it
// with zod. This walks one of each side by side and reports where they disagree in a way that loses a
// message:
//
//   refuses-key               the binary declares a key, and a `.strict()` object here rejects it
//   requires-undeclared-key   a key required here is one the binary never declares
//   refuses-variant           the binary declares a union variant no option here reads
//   reads-undeclared-variant  an option here reads a variant the binary no longer declares
//   refuses-value             the binary declares an enum value an enum here rejects
//
// It reports and does not judge: some refusals are deliberate (a question kind Frizz does not draw),
// and codex-protocol-conformance.test.ts lists those by name with the reason. It only follows shapes
// it can line up, so an `unknown`, a plain string or a free-form record is left alone, and a schema the
// walk cannot align produces nothing rather than a guess.
import type { z } from "zod"

export type ReadProblemKind = "refuses-key" | "requires-undeclared-key" | "refuses-variant" | "reads-undeclared-variant" | "refuses-value"

export interface ReadProblem {
  /** Where: the wire method, then the keys walked, `[]` for an array's items and `<value>` for a variant. */
  path: string
  kind: ReadProblemKind
  /** The key, variant or value in question. */
  name: string
}

/** One problem as the single line the test's allowlist is keyed by. */
export const readProblemLine = (problem: ReadProblem): string => `${problem.path} ${problem.kind} ${problem.name}`

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value)

interface ZodInternals {
  _def: { typeName?: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; unknownKeys?: string; value?: unknown }
}
const typeName = (schema: z.ZodTypeAny): string => (schema as unknown as ZodInternals)._def.typeName ?? ""

/** The schema under every wrapper that does not change which keys an object has. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  for (let depth = 0; depth < 16; depth++) {
    const def = (schema as unknown as ZodInternals)._def
    const name = typeName(schema)
    if ((name === "ZodOptional" || name === "ZodNullable" || name === "ZodDefault" || name === "ZodReadonly") && def.innerType) schema = def.innerType
    else if (name === "ZodEffects" && def.schema) schema = def.schema
    else return schema
  }
  return schema
}

export function readSideProblems(schema: z.ZodTypeAny, wire: unknown, definitions: Record<string, unknown>, path: string): ReadProblem[] {
  const problems: ReadProblem[] = []

  /** Follow `$ref`, a one-entry `allOf`, and the `anyOf: [X, null]` spelling of "nullable X". */
  function deref(node: unknown): Json | undefined {
    for (let hops = 0; hops < 32; hops++) {
      if (!isObject(node)) return undefined
      if (typeof node.$ref === "string") { node = definitions[node.$ref.split("/").pop() ?? ""]; continue }
      if (Array.isArray(node.allOf) && node.allOf.length === 1) { node = node.allOf[0]; continue }
      if (Array.isArray(node.anyOf)) {
        const real = node.anyOf.filter((branch) => !(isObject(branch) && branch.type === "null"))
        if (real.length === 1) { node = real[0]; continue }
      }
      return node
    }
    return undefined
  }

  const properties = (node: Json): Json | undefined => (isObject(node.properties) ? node.properties : undefined)
  /** The values a wire property is pinned to: `enum: ["read"]` on a tag, or on any string enum. */
  const enumOf = (node: unknown): string[] => {
    const resolved = deref(node)
    return resolved && Array.isArray(resolved.enum) ? resolved.enum.filter((value): value is string => typeof value === "string") : []
  }
  const variantsOf = (node: Json): Json[] => (Array.isArray(node.oneOf) ? node.oneOf.map(deref).filter((variant): variant is Json => variant !== undefined) : [])
  /** A union's variant with the keys the union declares for all of its variants folded in. */
  const withShared = (union: Json, variant: Json): Json => ({ ...variant, oneOf: undefined, properties: { ...properties(union), ...properties(variant) } })

  function walk(zodSchema: z.ZodTypeAny, wireNode: unknown, at: string): void {
    const zod = unwrap(zodSchema)
    const node = deref(wireNode)
    if (!node) return
    const kind = typeName(zod)

    if (kind === "ZodObject") {
      const shape = (zod as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>
      let target = node
      if (Array.isArray(node.oneOf)) {
        // The wire has a union and this side reads ONE of its variants as a plain object (a ThreadItem
        // read as a fileChange): the variant is the one tagged with this schema's own literal.
        const variant = variantsOf(node).find((candidate) => Object.entries(shape).some(([key, field]) => {
          const literal = unwrap(field)
          return typeName(literal) === "ZodLiteral" && enumOf(properties(candidate)?.[key]).includes(String((literal as unknown as ZodInternals)._def.value))
        }))
        if (!variant) return
        target = withShared(node, variant)
      }
      const wireProperties = properties(target)
      if (!wireProperties) return
      if ((zod as unknown as ZodInternals)._def.unknownKeys === "strict") {
        for (const key of Object.keys(wireProperties)) if (!(key in shape)) problems.push({ path: at, kind: "refuses-key", name: key })
      }
      for (const [key, field] of Object.entries(shape)) {
        if (!(key in wireProperties)) {
          if (!field.isOptional()) problems.push({ path: at, kind: "requires-undeclared-key", name: key })
          continue
        }
        walk(field, wireProperties[key], `${at}.${key}`)
      }
      return
    }

    if (kind === "ZodArray") {
      walk((zod as z.ZodArray<z.ZodTypeAny>).element, node.items, `${at}[]`)
      return
    }

    if (kind === "ZodDiscriminatedUnion") {
      const union = zod as z.ZodDiscriminatedUnion<string, z.AnyZodObject[]>
      const tag = union.discriminator
      const variants = variantsOf(node)
      const read = new Set<string>()
      for (const option of union.options) {
        const value = String((unwrap(option.shape[tag] as z.ZodTypeAny) as unknown as ZodInternals)._def.value)
        read.add(value)
        const variant = variants.find((candidate) => enumOf(properties(candidate)?.[tag]).includes(value))
        if (!variant) { problems.push({ path: at, kind: "reads-undeclared-variant", name: value }); continue }
        walk(option, withShared(node, variant), `${at}<${value}>`)
      }
      for (const variant of variants) {
        for (const value of enumOf(properties(variant)?.[tag])) if (!read.has(value)) problems.push({ path: at, kind: "refuses-variant", name: value })
      }
      return
    }

    if (kind === "ZodEnum") {
      const accepted = new Set((zod as z.ZodEnum<[string, ...string[]]>).options)
      // A string enum, or a union of them with structured alternatives beside (codex's approval
      // decisions): each structured one is named by its keys, since an enum here refuses it whole.
      const declared = Array.isArray(node.oneOf)
        ? variantsOf(node).flatMap((variant) => (Array.isArray(variant.enum) ? enumOf(variant) : [`{${Object.keys(properties(variant) ?? {}).join(",")}}`]))
        : enumOf(node)
      for (const value of declared) if (!accepted.has(value)) problems.push({ path: at, kind: "refuses-value", name: value })
    }
  }

  walk(schema, wire, path)
  return problems
}
