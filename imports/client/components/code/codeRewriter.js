import esprima from 'esprima'
import { each } from 'lodash'

import { formatCodeNumber } from './paramVars';

// Find exact source ranges of the VALUE element (the INIT slot, index 5) of
// every param descriptor array whose first element is the given name.
// A real AST prevents greedy regexes from spanning across neighbouring
// descriptors or rewriting unrelated code.
export let findParamValueRanges = (code, paramName) => {
  let ranges = []
  let ast
  try {
    ast = esprima.parseScript(code, { range: true, tolerant: true })
  } catch (e) {
    try {
      ast = esprima.parseModule(code, { range: true, tolerant: true })
    } catch (e2) {
      return ranges
    }
  }

  let visit = node => {
    if (!node || typeof node.type !== 'string') return

    if (node.type === 'ArrayExpression' && node.elements && node.elements.length >= 6) {
      let first = node.elements[0]
      if (first && (first.type === 'Literal') && first.value === paramName) {
        let valueNode = node.elements[5]
        if (valueNode && valueNode.range) ranges.push(valueNode.range)
      }
    }

    for (let key in node) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue
      if (key === 'range' || key === 'loc' || key === 'parent') continue
      let child = node[key]
      if (Array.isArray(child)) child.forEach(visit)
      else if (child && typeof child.type === 'string') visit(child)
    }
  }

  visit(ast)
  return ranges
}

// Fallback for code the parser rejects: a tight, single-entry regex that never
// spans multiple descriptors. Replaces the LAST (init) value of the named
// descriptor only.
export let fallbackReplace = (code, paramName, newValue) => {
  let escaped = paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re = new RegExp(
    `(\\[\\s*['"]${escaped}['"]\\s*,[\\s\\S]*?,[\\s\\S]*?,[\\s\\S]*?,[\\s\\S]*?,)[^,\\]]*(\\s*[\\],])`,
    'g'
  )
  return code.replace(re, `$1 ${newValue}$2`)
}

// Return `code` with only the target params' INIT slot updated.
// `params` = [{name, value, step}]
export let rewriteParamsInCode = (code, params) => {
  let edits = []

  each(params, p => {
    if (!p || !p.name || typeof p.value !== 'number' || !isFinite(p.value)) return
    let replacement = formatCodeNumber(p.value, p.step)
    let ranges = findParamValueRanges(code, p.name)

    if (ranges.length > 0) {
      ranges.forEach(([start, end]) => edits.push({ start, end, replacement }))
    } else {
      edits.push({ fallbackName: p.name, replacement })
    }
  })

  // apply AST range edits from right to left so earlier offsets stay valid
  let rangeEdits = edits
    .filter(e => typeof e.start === 'number')
    .sort((a, b) => b.start - a.start)

  let next = code
  rangeEdits.forEach(e => {
    next = next.slice(0, e.start) + e.replacement + next.slice(e.end)
  })

  edits.filter(e => e.fallbackName).forEach(e => {
    next = fallbackReplace(next, e.fallbackName, e.replacement)
  })

  return next
}
