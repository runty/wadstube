import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { accessSync } from 'node:fs'

// Explicit release files only: never archive the repository or runtime data.
const extensionFiles = ['manifest.json', 'popup.html', 'popup.css', 'popup.mjs',
  'background.mjs', 'detect.mjs', 'library.mjs', 'README.md',
  'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png']
const archiveName = 'downloads/wadstube-chrome-extension.zip'
const extensionArchive = () => {
  const source = new URL('../extension/', import.meta.url)
  for (const file of extensionFiles) accessSync(new URL(file, source))
  return execFileSync('zip', ['-q', '-X', '-', ...extensionFiles], { cwd: fileURLToPath(source) })
}

const extensionDownload = {
  name: 'wadstube-extension-download',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: archiveName, source: extensionArchive() })
  },
  configureServer(server) {
    server.middlewares.use('/' + archiveName, (_req, res, next) => {
      try {
        res.setHeader('Content-Type', 'application/zip')
        res.setHeader('Cache-Control', 'no-store')
        res.end(extensionArchive())
      } catch (error) { next(error) }
    })
  },
}

export default defineConfig({
  plugins: [svelte(), extensionDownload],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
