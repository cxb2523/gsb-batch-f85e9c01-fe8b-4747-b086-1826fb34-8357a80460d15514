'use strict'
/*
 * 直接从真实的 src/canvasPlayer.vue 中抽取 <script> 内容并加载，
 * 不经过 webpack/vue-loader，保证测试覆盖的就是交付源码。
 * 通过 Module._load 拦截：
 *   require('vue')            -> 最小 Vue shim
 *   require('*.vue')          -> 编译 SFC 的 script 块
 *   require('../src/index.js') -> 同样使用 shim Vue 走完整入口链路
 */
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { FakeVue } = require('./fake-vue')

const originalLoad = Module._load

function loadSfc(vuePath) {
  const source = fs.readFileSync(vuePath, 'utf8')
  const m = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  if (!m) throw new Error('no <script> block in ' + vuePath)
  let script = m[1].trim()
  script = esmToCjs(script)
  const mod = new Module(vuePath, module)
  mod.filename = vuePath
  mod.paths = Module._nodeModulePaths(path.dirname(vuePath))
  mod._compile(script, vuePath)
  return mod.exports
}

// 仅处理本仓库源码里实际用到的 ESM 语法
function esmToCjs(script) {
  return script
    .replace(/import\s+(\w+)\s+from\s+(['"][^'"]+['"]);?/g, 'const $1 = require($2)')
    .replace(/export\s+default/, 'module.exports =')
}

function installLoader() {
  Module._load = function(request, parent, isMain) {
    if (request === 'vue') {
      return FakeVue
    }
    if (request.endsWith('.vue')) {
      const resolved = Module._resolveFilename(request, parent, isMain)
      return loadSfc(resolved)
    }
    if (request.endsWith('.js') && parent && parent.filename && parent.filename.includes(`${path.sep}src${path.sep}`)) {
      const resolved = Module._resolveFilename(request, parent, isMain)
      const source = esmToCjs(fs.readFileSync(resolved, 'utf8'))
      const mod = new Module(resolved, parent)
      mod.filename = resolved
      mod.paths = Module._nodeModulePaths(path.dirname(resolved))
      mod._compile(source, resolved)
      return mod.exports
    }
    return originalLoad.call(this, request, parent, isMain)
  }
}

function restoreLoader() {
  Module._load = originalLoad
}

// 直接读取并编译 src 下的 js 源码（ESM -> CJS），绕过 Node 原生 ESM 解析
function loadSourceModule(jsPath) {
  const resolved = path.resolve(jsPath)
  const source = esmToCjs(fs.readFileSync(resolved, 'utf8'))
  const mod = new Module(resolved, module)
  mod.filename = resolved
  mod.paths = Module._nodeModulePaths(path.dirname(resolved))
  mod._compile(source, resolved)
  return mod.exports
}

module.exports = { installLoader, restoreLoader, loadSfc, loadSourceModule }
