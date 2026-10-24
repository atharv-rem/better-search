// Renders each .mmd in this folder to <name>-light.svg and <name>-dark.svg with Ondine.
// Run from this folder: npm install ondine && node build.mjs
import { render } from 'ondine/compiler'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const themes = {
  light: { bg: '#ffffff', fg: '#1b1f3a', muted: '#5b6285', line: '#8b93b0', surface: '#f4f5fb', 'surface-alt': '#e7e9f7', border: '#c4cae0', accent: '#6d5efc' },
  dark: { bg: '#0d1117', fg: '#e6e9f5', muted: '#a3aacb', line: '#7d86b0', surface: '#171c2e', 'surface-alt': '#232a45', border: '#343c63', accent: '#a595ff' },
}
const shared = { radius: '10px', stroke: '1.5px', font: "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif" }

for (const file of readdirSync('.').filter((f) => f.endsWith('.mmd'))) {
  const { svg } = render(readFileSync(file, 'utf8'), { padding: 16, fontSize: 15 })
  for (const [scheme, colors] of Object.entries(themes)) {
    const vars = Object.entries({ ...colors, ...shared }).map(([k, v]) => `--ondine-${k}:${v}`).join(';')
    const out = svg.replace('style="', `style="${vars};`)
    writeFileSync(file.replace('.mmd', `-${scheme}.svg`), out)
  }
}
