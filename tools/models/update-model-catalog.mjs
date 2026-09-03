#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(root, 'packages/settings/src/model-metadata/models-dev.catalog.json')
const source = 'https://models.dev/catalog.json'
const timeoutMs = 30_000
const maxBytes = 50 * 1024 * 1024

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function calendarMonthsAgo(months) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCMonth(date.getUTCMonth() - months)
  return date.toISOString().slice(0, 10)
}

function parseFilter(args) {
  if (args.length === 0) {
    return { since: calendarMonthsAgo(6) }
  }
  if (args.length === 1 && args[0] === '--all') {
    return { since: null }
  }
  if (args.length === 2 && args[0] === '--months') {
    const months = Number(args[1])
    if (!Number.isSafeInteger(months) || months < 1 || months > 120) {
      throw new Error('--months must be an integer from 1 to 120')
    }
    return { since: calendarMonthsAgo(months) }
  }
  if (args.length === 2 && args[0] === '--since') {
    const since = args[1]
    const pattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
    if (!pattern.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
      throw new Error('--since must be a valid YYYY-MM-DD date')
    }
    return { since }
  }
  throw new Error('Usage: models:update [--all | --months N | --since YYYY-MM-DD]')
}

function assertCatalog(value) {
  if (!isRecord(value) || !isRecord(value.providers) || !isRecord(value.models)) {
    throw new Error('models.dev catalog must contain providers and models objects')
  }
  for (const [providerId, provider] of Object.entries(value.providers)) {
    if (!isRecord(provider) || !isRecord(provider.models)) {
      throw new Error(`Invalid provider entry: ${providerId}`)
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isRecord(model) || typeof model.id !== 'string' || model.id.length === 0) {
        throw new Error(`Invalid model entry: ${providerId}/${modelId}`)
      }
    }
  }
  for (const [modelId, model] of Object.entries(value.models)) {
    if (!isRecord(model) || typeof model.id !== 'string' || model.id.length === 0) {
      throw new Error(`Invalid canonical model entry: ${modelId}`)
    }
  }
  return value
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  )
}

function modelDate(model) {
  for (const key of ['last_updated', 'release_date']) {
    const value = model[key]
    if (typeof value === 'string') {
      const date = value.slice(0, 10)
      if (!Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
        return date
      }
    }
  }
  return undefined
}

function filterCatalog(catalog, since) {
  if (since === null) {
    return catalog
  }
  const providers = {}
  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    const models = Object.fromEntries(
      Object.entries(provider.models).filter(([, model]) => modelDate(model) >= since),
    )
    if (Object.keys(models).length > 0) {
      providers[providerId] = { ...provider, models }
    }
  }
  const models = Object.fromEntries(
    Object.entries(catalog.models).filter(([, model]) => modelDate(model) >= since),
  )
  if (Object.keys(providers).length === 0 || Object.keys(models).length === 0) {
    throw new Error('The selected date filter produced an empty catalog')
  }
  return { ...catalog, providers, models }
}

async function fetchCatalog() {
  const response = await fetch(source, {
    headers: { Accept: 'application/json', 'User-Agent': 'poietica-model-catalog' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('models.dev response exceeds the 50 MiB safety limit')
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error('models.dev response exceeds the 50 MiB safety limit')
  }
  try {
    return assertCatalog(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid models.dev response: ${error.message}`, { cause: error })
  }
}

async function current() {
  try {
    return await readFile(output, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

const filter = parseFilter(process.argv.slice(2))
const upstream = await fetchCatalog()
const sourceJson = JSON.stringify(stable(upstream))
const catalog = stable(filterCatalog(upstream, filter.since))
const document = stable({
  catalog,
  filter: filter.since === null ? null : { since: filter.since },
  source,
  sourceSha256: createHash('sha256').update(sourceJson).digest('hex'),
})
const next = `${JSON.stringify(document, null, 2)}\n`
const previous = await current()
if (previous === next) {
  console.log('models.dev catalog is already current')
  process.exit(0)
}

await mkdir(dirname(output), { recursive: true })
const temporary = `${output}.tmp-${process.pid}`
try {
  await writeFile(temporary, next, 'utf8')
  await rename(temporary, output)
} finally {
  await rm(temporary, { force: true })
}

console.log(
  'Updated ' +
    output +
    ' (' +
    Object.keys(catalog.providers).length +
    ' providers, ' +
    Object.keys(catalog.models).length +
    ' canonical models)',
)
