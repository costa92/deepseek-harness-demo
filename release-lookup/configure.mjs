/** Generate a local Cordis patch from this example's actual location. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pluginPath = fileURLToPath(new URL('./release-tool.ts', import.meta.url))
const recordsPath = fileURLToPath(new URL('./releases.json', import.meta.url))
const patch = `- insert:
    - id: article-release-lookup
      name: ${JSON.stringify(pluginPath)}
      config:
        recordsPath: ${JSON.stringify(recordsPath)}
`
await writeFile(new URL('./cordis.generated.yml', import.meta.url), patch, 'utf8')
console.log('Generated cordis.generated.yml beside configure.mjs')
